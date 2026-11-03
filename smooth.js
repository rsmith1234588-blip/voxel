// Smooth (non-voxel) meshing for the same world data.
// The world is still stored as a material grid, but instead of drawing cube faces we
// treat each cell centre as a sample of a solid/empty field and extract a smooth surface
// with Surface Nets: one vertex per dual cell (placed at the average of its edge
// crossings), one quad per sign-changing edge. Normals and ambient occlusion come from the
// field itself, so chunk borders line up seamlessly.
import * as THREE from 'three';
import { H, CS, M, getColumn, decodeSection, voxelColor } from './world.js';

const UNLOADED = 255; // unloaded neighbours count as solid so borders stay closed
const WATER_LIN = new THREE.Color(0x2f72b8);

const solidOf = (m) => m !== 0 && m !== M.WATER;
const wetOf = (m) => m !== 0;

// The 12 edges of a dual cell, as pairs of corner indices (corner bit 1=x, 2=y, 4=z)
const EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) EDGES.push([a, a | bit]);

class SmoothBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.ind = [];
    this._c = { r: 0, g: 0, b: 0 };
  }

  // mats/burns: padded region of size nx*ny*nz with world origin (ox,oy,oz).
  // Edges whose lower cell lies in [lo, hi) (local, per axis) are emitted.
  run(mats, burns, nx, ny, nz, ox, oy, oz, lo, hi, water) {
    this.pos.length = this.nor.length = this.col.length = this.ind.length = 0;
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
        }
        if (!cn) { voxelColor(0, 0, 0, M.STONE, 0, c); r = c.r; g = c.g; bl = c.b; cn = 1; }
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
      vIndex[key] = idx;
      return idx;
    }

    const p = [0, 0, 0];
    const q = [0, 0, 0];
    for (let y = lo[1]; y < hi[1]; y++)
      for (let z = lo[2]; z < hi[2]; z++)
        for (let x = lo[0]; x < hi[0]; x++) {
          const ma = at(x, y, z);
          const a = field(ma);
          for (let d = 0; d < 3; d++) {
            q[0] = x; q[1] = y; q[2] = z; q[d]++;
            const mb = at(q[0], q[1], q[2]);
            const b = field(mb);
            if (a === b) continue;
            if (water && !((ma === M.WATER && mb === 0) || (ma === 0 && mb === M.WATER))) continue;
            const u = (d + 1) % 3, v = (d + 2) % 3;
            const vs = [];
            for (const [du, dv] of [[-1, -1], [0, -1], [0, 0], [-1, 0]]) {
              p[0] = x; p[1] = y; p[2] = z;
              p[u] += du; p[v] += dv;
              vs.push(vertex(p[0], p[1], p[2]));
            }
            if (!a) vs.reverse();
            // Split along the diagonal that keeps darker corners together
            const C = this.col;
            const lum = (i) => C[i * 3] + C[i * 3 + 1] + C[i * 3 + 2];
            if (lum(vs[0]) + lum(vs[2]) >= lum(vs[1]) + lum(vs[3])) this.ind.push(vs[0], vs[1], vs[2], vs[0], vs[2], vs[3]);
            else this.ind.push(vs[1], vs[2], vs[3], vs[1], vs[3], vs[0]);
          }
        }
    return this.toGeometry();
  }

  toGeometry() {
    if (!this.ind.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
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
const PAD = 2;
const PS = CS + PAD * 2;
const secMats = new Uint8Array(PS * PS * PS);
const secBurns = new Uint8Array(PS * PS * PS);
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
      for (let ly = 0; ly < PS; ly++) {
        const wy = oy + ly;
        const i = lx + PS * (lz + PS * ly);
        let m = 0, b = 0;
        if (wy < 0) m = M.BEDROCK;
        else if (wy >= H) m = 0;
        else if (!col) m = UNLOADED;
        else { const j = base + CS * CS * wy; m = col.grid[j]; b = col.burn[j]; }
        secMats[i] = m; secBurns[i] = b;
        if (m && m !== UNLOADED) any = true;
      }
    }
  if (!any) return { solid: null, water: null };
  const solid = builder.run(secMats, secBurns, PS, PS, PS, ox, oy, oz, LO, HI, false);
  const water = builder.run(secMats, secBurns, PS, PS, PS, ox, oy, oz, LO, HI, true);
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
  const mats = new Uint8Array(nx * ny * nz), burns = new Uint8Array(nx * ny * nz);
  for (const v of vox) {
    const i = (v.x - x0 + PAD) + nx * ((v.z - z0 + PAD) + nz * (v.y - y0 + PAD));
    mats[i] = v.m; burns[i] = v.b;
  }
  return builder.run(mats, burns, nx, ny, nz, x0 - PAD, y0 - PAD, z0 - PAD, [1, 1, 1], [nx - 2, ny - 2, nz - 2], false);
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
