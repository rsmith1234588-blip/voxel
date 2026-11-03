// Smooth (non-voxel) meshing for the same world data.
// The world is still stored as a material grid, but instead of drawing cube faces we
// treat each cell centre as a sample of a solid/empty field and extract a smooth surface
// with Surface Nets: one vertex per dual cell (placed at the average of its edge
// crossings), one quad per sign-changing edge. Normals and ambient occlusion come from the
// field itself, so chunk borders line up seamlessly.
import * as THREE from 'three';
import { H, CS, M, getColumn, decodeSection, voxelColor, terrainHeight } from './world.js';

const UNLOADED = 255; // unloaded neighbours count as solid so borders stay closed
const WATER_LIN = new THREE.Color(0x2f72b8);

// Surface "kind" weights for the shader: [organic, rock, brick, wood]; whatever is
// left over is a smooth, slightly glossy surface (glass, metal, ice, gold, TNT).
const SURF = [];
for (let i = 0; i < 256; i++) SURF[i] = [0, 1, 0, 0];
for (const m of [M.DIRT, M.GRASS, M.LEAVES, M.SAND, M.SNOW, M.PINE, M.CACTUS, M.CLOTH, M.AUTUMN]) SURF[m] = [1, 0, 0, 0];
for (const m of [M.BEDROCK, M.STONE, M.COBBLE, M.MOSSY, M.SANDSTONE]) SURF[m] = [0, 1, 0, 0];
for (const m of [M.CONCRETE, M.DARKCON, M.ASPHALT]) SURF[m] = [0, 0.45, 0, 0];
for (const m of [M.BRICK, M.ROOF]) SURF[m] = [0, 0, 1, 0];
for (const m of [M.WOOD, M.PLANKS, M.BIRCH]) SURF[m] = [0, 0, 0, 1];
for (const m of [M.GLASS, M.GOLD, M.TNT, M.METAL, M.ICE, M.WATER]) SURF[m] = [0, 0, 0, 0];

const solidOf = (m) => m !== 0 && m !== M.WATER;
const wetOf = (m) => m !== 0;

// The 12 edges of a dual cell, as pairs of corner indices (corner bit 1=x, 2=y, 4=z)
const EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) EDGES.push([a, a | bit]);

class SmoothBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.ind = []; this.surf = []; this.blk = [];
    this._c = { r: 0, g: 0, b: 0 };
  }

  // mats/burns: padded region of size nx*ny*nz with world origin (ox,oy,oz).
  // Edges whose lower cell lies in [lo, hi) (local, per axis) are emitted. Quads up to
  // `ext` cells further out are built too, only to give border vertices the same
  // normals the neighbouring section computes.
  // built (optional): 1 where a stone cell is part of a structure, so it gets cut blocks
  run(mats, burns, nx, ny, nz, ox, oy, oz, lo, hi, water, ext = 0, built = null) {
    this.pos.length = this.nor.length = this.col.length = this.ind.length = this.surf.length = this.blk.length = 0;
    const field = water ? wetOf : solidOf;
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : mats[x + nx * (z + nz * y)]);
    const vIndex = new Int32Array(nx * ny * nz).fill(-1);
    const blur = blurField(mats, nx, ny, nz, field);
    const bAt = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : blur[x + nx * (z + nz * y)]);
    const c = this._c;
    const corner = new Uint8Array(8);
    const cval = new Float32Array(8);
    const self = this;

    function vertex(x, y, z) {
      const key = x + nx * (z + nz * y);
      const existing = vIndex[key];
      if (existing >= 0) return existing;
      // Position: average of the sign-changing edge crossings. Topology comes from the
      // hard field (so thin trunks and walls survive), but each crossing is placed where
      // a blurred copy of the field passes 0.5, which smooths steps into slopes.
      for (let i = 0; i < 8; i++) {
        const cx = x + (i & 1), cy = y + ((i >> 1) & 1), cz = z + ((i >> 2) & 1);
        corner[i] = field(at(cx, cy, cz)) ? 1 : 0;
        cval[i] = bAt(cx, cy, cz);
      }
      let px = 0, py = 0, pz = 0, n = 0;
      for (const [a, b] of EDGES) {
        if (corner[a] === corner[b]) continue;
        const va = cval[a], vb = cval[b];
        let t = Math.abs(va - vb) > 1e-4 ? (va - 0.5) / (va - vb) : 0.5;
        t = t < 0.12 ? 0.12 : t > 0.88 ? 0.88 : t;
        px += (a & 1) + ((b & 1) - (a & 1)) * t;
        py += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
        pz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
        n++;
      }
      if (n) { px /= n; py /= n; pz /= n; } else { px = py = pz = 0.5; }

      // Normal (field gradient) and occlusion over the surrounding 4x4x4 cells
      let gx = 0, gy = 0, gz = 0, filled = 0;
      for (let dy = -1; dy <= 2; dy++)
        for (let dz = -1; dz <= 2; dz++)
          for (let dx = -1; dx <= 2; dx++) {
            if (!field(at(x + dx, y + dy, z + dz))) continue;
            filled++;
            const rx = dx - 0.5, ry = dy - 0.5, rz = dz - 0.5;
            const w = 1 / (rx * rx + ry * ry + rz * rz);
            gx += rx * w; gy += ry * w; gz += rz * w;
          }
      let len = Math.hypot(gx, gy, gz);
      if (len < 1e-5) { gx = 0; gy = -1; gz = 0; len = 1; }
      const nxv = -gx / len, nyv = -gy / len, nzv = -gz / len;

      // Colour: blend the solid cells touching this vertex
      let r = 0, g = 0, bl = 0, cn = 0;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, bk = 0;
      if (water) {
        r = WATER_LIN.r; g = WATER_LIN.g; bl = WATER_LIN.b; cn = 1;
      } else {
        for (let i = 0; i < 8; i++) {
          if (!corner[i]) continue;
          const cx = x + (i & 1), cy = y + ((i >> 1) & 1), cz = z + ((i >> 2) & 1);
          const m = at(cx, cy, cz);
          if (m === UNLOADED) continue;
          const bi = cx + nx * (cz + nz * cy);
          voxelColor(ox + cx, oy + cy, oz + cz, m, burns[bi], c, nyv < 0.6);
          r += c.r; g += c.g; bl += c.b; cn++;
          if (built && built[bi]) { bk++; continue; }
          const k = SURF[m];
          s0 += k[0]; s1 += k[1]; s2 += k[2]; s3 += k[3];
        }
        if (!cn) { voxelColor(0, 0, 0, M.STONE, 0, c); r = c.r; g = c.g; bl = c.b; cn = 1; s1 = 1; }
        // 64 cells, a flat floor fills ~half; concave corners fill more
        const occ = filled / 64;
        const shade = Math.max(0.62, Math.min(1.04, 1.22 - occ * 0.48));
        r *= shade; g *= shade; bl *= shade;
      }
      const idx = self.pos.length / 3;
      // Cell centres sit at +0.5, so dual cell (x,y,z) spans [x+0.5, x+1.5]
      self.pos.push(ox + x + 0.5 + px, oy + y + 0.5 + py, oz + z + 0.5 + pz);
      self.nor.push(nxv, nyv, nzv);
      self.col.push(r / cn, g / cn, bl / cn);
      self.surf.push(s0 / cn, s1 / cn, s2 / cn, s3 / cn);
      self.blk.push(bk / cn);
      vIndex[key] = idx;
      return idx;
    }

    const p = [0, 0, 0];
    const q = [0, 0, 0];
    const quads = [];
    const flat = [];
    const waterTop = (x, y, z) => at(x, y, z) === M.WATER && at(x, y + 1, z) === 0;
    // Lake surfaces are a flat sheet that also reaches a little way under the shore,
    // so the smooth beach slices through it and gives a curved waterline.
    const flatWater = (x, y, z) => {
      if (at(x, y + 1, z) !== 0) return false;
      if (waterTop(x, y, z)) return true;
      if (!solidOf(at(x, y, z))) return false;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (waterTop(x + dx, y, z + dz)) return true;
      return false;
    };
    const pushFlat = (x, y, z) => {
      const base = this.pos.length / 3, wy = oy + y + 1 - 0.08;
      for (const [cx, cz] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
        this.pos.push(ox + x + cx, wy, oz + z + cz);
        this.nor.push(0, 1, 0);
        this.col.push(WATER_LIN.r, WATER_LIN.g, WATER_LIN.b);
        this.surf.push(0, 0, 0, 0);
        this.blk.push(0);
      }
      flat.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let y = lo[1] - ext; y < hi[1] + ext; y++)
      for (let z = lo[2] - ext; z < hi[2] + ext; z++)
        for (let x = lo[0] - ext; x < hi[0] + ext; x++) {
          const owned = x >= lo[0] && x < hi[0] && y >= lo[1] && y < hi[1] && z >= lo[2] && z < hi[2];
          if (water && owned && flatWater(x, y, z)) pushFlat(x, y, z);
          const ma = at(x, y, z);
          const a = field(ma);
          for (let d = 0; d < 3; d++) {
            q[0] = x; q[1] = y; q[2] = z; q[d]++;
            const mb = at(q[0], q[1], q[2]);
            const b = field(mb);
            if (a === b) continue;
            if (water && !((ma === M.WATER && mb === 0) || (ma === 0 && mb === M.WATER))) continue;
            if (water && d === 1 && ma === M.WATER) continue; // covered by the flat sheet
            const u = (d + 1) % 3, v = (d + 2) % 3;
            const vs = [];
            for (const [du, dv] of [[-1, -1], [0, -1], [0, 0], [-1, 0]]) {
              p[0] = x; p[1] = y; p[2] = z;
              p[u] += du; p[v] += dv;
              vs.push(vertex(p[0], p[1], p[2]));
            }
            if (!a) vs.reverse();
            quads.push(vs[0], vs[1], vs[2], vs[3], owned ? 1 : 0);
          }
        }

    // Normals from the actual surface (area-weighted quad normals), softened a little
    // with the field gradient so curved shapes stay smooth.
    const P = this.pos, Nn = this.nor, C = this.col;
    const acc = new Float32Array(P.length);
    for (let i = 0; i < quads.length; i += 5) {
      const a0 = quads[i] * 3, a1 = quads[i + 1] * 3, a2 = quads[i + 2] * 3, a3 = quads[i + 3] * 3;
      const ux = P[a2] - P[a0], uy = P[a2 + 1] - P[a0 + 1], uz = P[a2 + 2] - P[a0 + 2];
      const vx = P[a3] - P[a1], vy = P[a3 + 1] - P[a1 + 1], vz = P[a3 + 2] - P[a1 + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      for (const a of [a0, a1, a2, a3]) { acc[a] += fx; acc[a + 1] += fy; acc[a + 2] += fz; }
    }
    for (let i = 0; i < P.length; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]);
      if (l < 1e-6) continue;
      let x = acc[i] / l * 0.8 + Nn[i] * 0.2, y = acc[i + 1] / l * 0.8 + Nn[i + 1] * 0.2, z = acc[i + 2] / l * 0.8 + Nn[i + 2] * 0.2;
      const l2 = Math.hypot(x, y, z) || 1;
      Nn[i] = x / l2; Nn[i + 1] = y / l2; Nn[i + 2] = z / l2;
    }
    // Split each quad along the diagonal that keeps darker corners together
    const lum = (i) => C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2];
    for (let i = 0; i < quads.length; i += 5) {
      if (!quads[i + 4]) continue;
      const v0 = quads[i], v1 = quads[i + 1], v2 = quads[i + 2], v3 = quads[i + 3];
      if (lum(v0) + lum(v2) >= lum(v1) + lum(v3)) this.ind.push(v0, v1, v2, v0, v2, v3);
      else this.ind.push(v1, v2, v3, v1, v3, v0);
    }
    for (const i of flat) this.ind.push(i);
    return this.toGeometry();
  }

  toGeometry() {
    if (!this.ind.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 4));
    g.setAttribute('blk', new THREE.Float32BufferAttribute(this.blk, 1));
    g.setIndex(this.ind);
    g.computeBoundingSphere();
    return g;
  }
}

// Separable 3x3x3 box blur of the 0/1 field
let blurA = new Float32Array(0), blurB = new Float32Array(0);
function blurField(mats, nx, ny, nz, field) {
  const N = nx * ny * nz;
  if (blurA.length < N) { blurA = new Float32Array(N); blurB = new Float32Array(N); }
  const a = blurA, b = blurB;
  for (let i = 0; i < N; i++) a[i] = field(mats[i]) ? 1 : 0;
  const pass = (src, dst, stride, size, coord) => {
    for (let i = 0; i < N; i++) {
      const c = coord(i);
      let v = src[i] * 2, w = 2;
      if (c > 0) { v += src[i - stride]; w++; }
      if (c < size - 1) { v += src[i + stride]; w++; }
      dst[i] = v / w;
    }
  };
  pass(a, b, 1, nx, (i) => i % nx);
  pass(b, a, nx, nz, (i) => ((i / nx) | 0) % nz);
  pass(a, b, nx * nz, ny, (i) => (i / (nx * nz)) | 0);
  return b;
}

const builder = new SmoothBuilder();
const PAD = 3;
const PS = CS + PAD * 2;
const secMats = new Uint8Array(PS * PS * PS);
const secBurns = new Uint8Array(PS * PS * PS);
const secBuilt = new Uint8Array(PS * PS * PS);

// Natural ground height per column, cached on the column (it's regenerated on reset)
function groundTop(col, wx, wz) {
  if (!col.nvTop) {
    col.nvTop = new Int16Array(CS * CS);
    for (let z = 0; z < CS; z++)
      for (let x = 0; x < CS; x++) col.nvTop[x + CS * z] = terrainHeight(col.cx * CS + x, col.cz * CS + z);
  }
  return col.nvTop[(wx & 15) + CS * (wz & 15)];
}
const LO = [PAD, PAD, PAD], HI = [PAD + CS, PAD + CS, PAD + CS];

// Returns { solid, water } geometries (either may be null)
export function buildSmoothSection(key) {
  const { cx, cy, cz } = decodeSection(key);
  if (!getColumn(cx, cz)) return { solid: null, water: null };
  const ox = cx * CS - PAD, oy = cy * CS - PAD, oz = cz * CS - PAD;
  let any = false;
  for (let lz = 0; lz < PS; lz++)
    for (let lx = 0; lx < PS; lx++) {
      const wx = ox + lx, wz = oz + lz;
      const col = getColumn(wx >> 4, wz >> 4);
      const base = (wx & 15) + CS * (wz & 15);
      const top = col ? groundTop(col, wx, wz) : 0;
      for (let ly = 0; ly < PS; ly++) {
        const wy = oy + ly;
        const i = lx + PS * (lz + PS * ly);
        let m = 0, b = 0;
        if (wy < 0) m = M.BEDROCK;
        else if (wy >= H) m = 0;
        else if (!col) m = UNLOADED;
        else { const j = base + CS * CS * wy; m = col.grid[j]; b = col.burn[j]; }
        secMats[i] = m; secBurns[i] = b;
        secBuilt[i] = (m === M.STONE || m === M.COBBLE || m === M.MOSSY) && wy > top ? 1 : 0;
        if (m && m !== UNLOADED) any = true;
      }
    }
  if (!any) return { solid: null, water: null };
  const solid = builder.run(secMats, secBurns, PS, PS, PS, ox, oy, oz, LO, HI, false, 1, secBuilt);
  const water = builder.run(secMats, secBurns, PS, PS, PS, ox, oy, oz, LO, HI, true, 1);
  return { solid, water };
}

// Smooth mesh for a falling piece: vox = [{x,y,z,m,b}]
export function buildSmoothBody(vox) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const v of vox) {
    if (v.x < x0) x0 = v.x; if (v.y < y0) y0 = v.y; if (v.z < z0) z0 = v.z;
    if (v.x > x1) x1 = v.x; if (v.y > y1) y1 = v.y; if (v.z > z1) z1 = v.z;
  }
  const nx = x1 - x0 + 1 + PAD * 2, ny = y1 - y0 + 1 + PAD * 2, nz = z1 - z0 + 1 + PAD * 2;
  const mats = new Uint8Array(nx * ny * nz), burns = new Uint8Array(nx * ny * nz), built = new Uint8Array(nx * ny * nz);
  for (const v of vox) {
    const i = (v.x - x0 + PAD) + nx * ((v.z - z0 + PAD) + nz * (v.y - y0 + PAD));
    mats[i] = v.m; burns[i] = v.b;
    built[i] = v.m === M.STONE || v.m === M.COBBLE || v.m === M.MOSSY ? 1 : 0;
  }
  return builder.run(mats, burns, nx, ny, nz, x0 - PAD, y0 - PAD, z0 - PAD, [1, 1, 1], [nx - 2, ny - 2, nz - 2], false, 0, built);
}

// An irregular rock to replace cube debris
export function rockGeometry(radius = 0.5) {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let s = seen.get(k);
    if (s === undefined) { s = 0.75 + Math.random() * 0.45; seen.set(k, s); }
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.8, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

// ============================================================================
// Materials: procedural surface detail, computed per pixel in world space
// ============================================================================
const NOISE_GLSL = /* glsl */ `
varying vec3 vNvPos;
varying vec3 vNvNrm;
float nvHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float nvNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(nvHash(i), nvHash(i + vec3(1, 0, 0)), f.x),
                 mix(nvHash(i + vec3(0, 1, 0)), nvHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(nvHash(i + vec3(0, 0, 1)), nvHash(i + vec3(1, 0, 1)), f.x),
                 mix(nvHash(i + vec3(0, 1, 1)), nvHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float nvFbm(vec3 p) { return nvNoise(p) * 0.5 + nvNoise(p * 2.07 + 3.1) * 0.3 + nvNoise(p * 4.13 + 7.7) * 0.2; }
vec3 nvPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos)), sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

const VERT_PARS = /* glsl */ `
varying vec3 vNvPos;
varying vec3 vNvNrm;
`;
const VERT_MAIN = /* glsl */ `
vNvPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vNvNrm = normalize(mat3(modelMatrix) * objectNormal);
`;

const SOLID_FRAG_PARS = /* glsl */ `
varying vec4 vNvSurf;
varying float vNvBlk;
float nvHeight;
float nvGloss;
// Running bond bricks on one plane; returns 1 on a brick, 0 in the mortar
float nvBrick(vec2 uv, vec2 scale, float mortar, out float tint) {
  uv *= scale;
  float row = floor(uv.y);
  uv.x += mod(row, 2.0) * 0.5 + nvHash(vec3(row, 1.3, 7.1)) * 0.3 * step(2.5, scale.y);
  vec2 id = floor(uv), f = fract(uv);
  tint = nvHash(vec3(id, row * 3.7));
  vec2 d = min(f, 1.0 - f) / scale;
  return smoothstep(mortar * 0.2, mortar, min(d.x, d.y));
}
// Triplanar blend of nvBrick
float nvBrick3(vec3 p, vec3 tw, vec2 scale, float mortar, out float tint) {
  float t1, t2, t3;
  float b = nvBrick(p.zy, scale, mortar, t1) * tw.x + nvBrick(p.xz, scale, mortar, t2) * tw.y + nvBrick(p.xy, scale, mortar, t3) * tw.z;
  tint = t1 * tw.x + t2 * tw.y + t3 * tw.z;
  return b;
}
`;

// Sets diffuseColor and nvHeight from the blended surface kinds
const SOLID_FRAG_COLOR = /* glsl */ `
{
  vec3 p = vNvPos;
  vec3 n = normalize(vNvNrm);
  float dist = length(vViewPosition);
  float fade = 1.0 - smoothstep(30.0, 85.0, dist);
  vec4 w = vNvSurf;
  float wBlk = vNvBlk;
  float wSmooth = clamp(1.0 - (w.x + w.y + w.z + w.w + wBlk), 0.0, 1.0);

  // Organic: soil, grass, sand, snow, leaves
  float blot = nvFbm(p * 0.35);
  float fine = nvNoise(p * 11.0);
  float hOrg = nvFbm(p * 3.0) * 0.6 + fine * 0.4;
  float aOrg = mix(0.82, 1.14, blot) * mix(0.9, 1.07, fine);

  // Rock: lumpy with faint strata
  float rk = nvFbm(p * 1.4);
  float strata = sin(p.y * 4.5 + nvFbm(p * 0.6) * 7.0);
  float hRock = rk + nvNoise(p * 7.0) * 0.35 + strata * 0.12;
  float aRock = mix(0.76, 1.14, rk) * (0.95 + strata * 0.05);

  // Brick: triplanar running bond
  vec3 tw = pow(abs(n), vec3(4.0));
  tw /= (tw.x + tw.y + tw.z);
  float tint;
  float brick = nvBrick3(p, tw, vec2(2.0, 4.0), 0.022, tint);
  float hBrick = brick * 0.9 + nvNoise(p * 9.0) * 0.25;
  float aBrick = mix(0.6, 1.0, brick) * mix(0.84, 1.12, tint);

  // Cut stone blocks for castles, towers and ruins
  float stint;
  float blk = nvBrick3(p + 0.13, tw, vec2(1.25, 2.0), 0.045, stint);
  float hBlk = blk * 0.8 + rk * 0.5;
  float aBlk = mix(0.55, 1.0, blk) * mix(0.82, 1.14, stint) * mix(0.9, 1.08, rk);

  // Wood: grain running along the long axis
  float grain = nvNoise(p * vec3(7.0, 0.35, 7.0) + nvNoise(p * 2.0) * 1.5);
  float rings = sin((grain + p.y * 0.05) * 20.0) * 0.5 + 0.5;
  float hWood = rings * 0.6 + grain * 0.4;
  float aWood = mix(0.8, 1.1, rings * 0.6 + grain * 0.4);

  float albedo = w.x * aOrg + w.y * aRock + w.z * aBrick + w.w * aWood + wBlk * aBlk + wSmooth;
  float sum = max(w.x + w.y + w.z + w.w + wBlk + wSmooth, 1e-3);
  albedo /= sum;
  diffuseColor.rgb *= mix(1.0, albedo, fade);
  nvHeight = (w.x * hOrg * 0.05 + w.y * hRock * 0.09 + w.z * hBrick * 0.045 + w.w * hWood * 0.025 + wBlk * hBlk * 0.06) / sum * fade;
  nvGloss = wSmooth / sum;
}
`;

const SOLID_FRAG_NORMAL = /* glsl */ `
normal = nvPerturb(-vViewPosition, normal, vec2(dFdx(nvHeight), dFdy(nvHeight)), faceDirection);
`;

function patch(shader, { vertPars = '', vertMain = '', fragPars = '', fragColor = '', fragNormal = '', fragRough = '' }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}${vertPars}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}${vertMain}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${NOISE_GLSL}${fragPars}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${fragColor}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragNormal}`);
  if (fragRough) shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${fragRough}`);
}

export function createSmoothMaterials() {
  const time = { value: 0 };

  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  solid.onBeforeCompile = (shader) => {
    patch(shader, {
      vertPars: 'attribute vec4 surf;\nattribute float blk;\nvarying vec4 vNvSurf;\nvarying float vNvBlk;\n',
      vertMain: 'vNvSurf = surf;\nvNvBlk = blk;\n',
      fragPars: SOLID_FRAG_PARS,
      fragColor: SOLID_FRAG_COLOR,
      fragNormal: SOLID_FRAG_NORMAL,
      fragRough: 'roughnessFactor = mix(0.93, 0.22, nvGloss);\n',
    });
  };
  solid.customProgramCacheKey = () => 'nv-solid';

  const water = new THREE.MeshStandardMaterial({
    color: 0x2f7fc8, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.7, depthWrite: false,
  });
  water.onBeforeCompile = (shader) => {
    shader.uniforms.nvTime = time;
    patch(shader, {
      fragPars: 'uniform float nvTime;\nfloat nvWave;\n',
      fragColor: `
        {
          vec3 p = vNvPos;
          float t = nvTime;
          nvWave = nvNoise(vec3(p.x * 0.9 + t * 0.6, t * 0.3, p.z * 0.9)) * 0.6
                 + nvNoise(vec3(p.x * 2.3 - t * 0.9, t * 0.5, p.z * 2.1 + t * 0.4)) * 0.4;
          float depthTint = nvNoise(p * 0.2);
          diffuseColor.rgb *= mix(0.85, 1.12, depthTint);
          diffuseColor.a = mix(0.62, 0.8, nvWave);
        }
      `,
      fragNormal: 'normal = nvPerturb(-vViewPosition, normal, vec2(dFdx(nvWave), dFdy(nvWave)) * 0.12, faceDirection);\n',
    });
  };
  water.customProgramCacheKey = () => 'nv-water';

  return { solid, water, tick(t) { time.value = t; } };
}
