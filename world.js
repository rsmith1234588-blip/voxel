// World storage, chunk meshing and map generation.
import * as THREE from 'three';

// ============================================================================
// Dimensions & materials
// ============================================================================
export const W = 128, D = 128, H = 64;
export const N = W * D * H;
export const CS = 16;
export const CX = W / CS, CY = H / CS, CZ = D / CS;
export const WATER_LEVEL = 7;

export const M = {
  AIR: 0, BEDROCK: 1, DIRT: 2, GRASS: 3, STONE: 4, BRICK: 5, WOOD: 6, GLASS: 7, ROOF: 8,
  LEAVES: 9, SAND: 10, SNOW: 11, WATER: 12, CONCRETE: 13, ASPHALT: 14, PLANKS: 15,
  SANDSTONE: 16, GOLD: 17, TNT: 18, COBBLE: 19, PINE: 20, CACTUS: 21, METAL: 22, DARKCON: 23, CLOTH: 24,
};

export const MAT_HEX = [];
MAT_HEX[M.AIR] = 0x000000;
MAT_HEX[M.BEDROCK] = 0x2a2a2f;
MAT_HEX[M.DIRT] = 0x7a5534;
MAT_HEX[M.GRASS] = 0x62a83c;
MAT_HEX[M.STONE] = 0x8c8e93;
MAT_HEX[M.BRICK] = 0x9c4a32;
MAT_HEX[M.WOOD] = 0x7a5530;
MAT_HEX[M.GLASS] = 0xa8d8f0;
MAT_HEX[M.ROOF] = 0x5e2620;
MAT_HEX[M.LEAVES] = 0x3d8a33;
MAT_HEX[M.SAND] = 0xdcc68e;
MAT_HEX[M.SNOW] = 0xf2f5f8;
MAT_HEX[M.WATER] = 0x2f72b8;
MAT_HEX[M.CONCRETE] = 0xb9b9b4;
MAT_HEX[M.ASPHALT] = 0x3a3b3f;
MAT_HEX[M.PLANKS] = 0xb08550;
MAT_HEX[M.SANDSTONE] = 0xd2b072;
MAT_HEX[M.GOLD] = 0xf3c52c;
MAT_HEX[M.TNT] = 0xe8241c;
MAT_HEX[M.COBBLE] = 0x6f7176;
MAT_HEX[M.PINE] = 0x24603a;
MAT_HEX[M.CACTUS] = 0x4f9a3a;
MAT_HEX[M.METAL] = 0x9aa4ae;
MAT_HEX[M.DARKCON] = 0x6d6f74;
MAT_HEX[M.CLOTH] = 0xc8202a;

const MAT_LIN = MAT_HEX.map((h) => new THREE.Color(h)); // linear-space colours for vertex colours
const CHAR = new THREE.Color(0x15110d);
const FLAT_SHADE = new Set([M.GLASS, M.WATER, M.GOLD, M.TNT]);

// ============================================================================
// Grid
// ============================================================================
export const grid = new Uint8Array(N);   // material per cell
export const burn = new Uint8Array(N);   // scorch level per cell (0..255)

export const idx = (x, y, z) => x + W * (z + D * y);
export const inBounds = (x, y, z) => x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < D;
export const get = (x, y, z) => (inBounds(x, y, z) ? grid[idx(x, y, z)] : 0);
export const cellX = (k) => k % W;
export const cellZ = (k) => ((k / W) | 0) % D;
export const cellY = (k) => (k / (W * D)) | 0;

export const chunkIndex = (cx, cy, cz) => cx + CX * (cz + CZ * cy);
export const dirtyChunks = new Set();

export function markDirty(x, y, z) {
  // A cell change can affect faces/AO in any chunk within 1 cell of it
  const cx0 = Math.max(0, (x - 1) >> 4), cx1 = Math.min(CX - 1, (x + 1) >> 4);
  const cy0 = Math.max(0, (y - 1) >> 4), cy1 = Math.min(CY - 1, (y + 1) >> 4);
  const cz0 = Math.max(0, (z - 1) >> 4), cz1 = Math.min(CZ - 1, (z + 1) >> 4);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) dirtyChunks.add(chunkIndex(cx, cy, cz));
}

export function markAllDirty() {
  for (let i = 0; i < CX * CY * CZ; i++) dirtyChunks.add(i);
}

export function setVoxel(x, y, z, mat, b = 0) {
  if (!inBounds(x, y, z)) return;
  const k = idx(x, y, z);
  grid[k] = mat;
  burn[k] = mat ? b : 0;
  markDirty(x, y, z);
}

export function addBurn(k, amount) {
  const v = burn[k] + amount;
  burn[k] = v > 255 ? 255 : v;
}

// ============================================================================
// Colour
// ============================================================================
export function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function voxelColor(x, y, z, mat, b, out, side = false) {
  let base = MAT_LIN[mat];
  if (side && mat === M.GRASS) base = MAT_LIN[M.DIRT];
  const s = FLAT_SHADE.has(mat) ? 1 : 0.86 + hash3(x, y, z) * 0.2;
  let r = base.r * s, g = base.g * s, bl = base.b * s;
  if (b) {
    const t = b / 255;
    r += (CHAR.r - r) * t; g += (CHAR.g - g) * t; bl += (CHAR.b - bl) * t;
  }
  out.r = r; out.g = g; out.b = bl;
  return out;
}

// ============================================================================
// Meshing (face culling + per-vertex ambient occlusion)
// ============================================================================
const FACES = [];
for (let d = 0; d < 3; d++) {
  for (const s of [1, -1]) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const n = [0, 0, 0];
    n[d] = s;
    const corners = s > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    FACES.push({ d, s, u, v, n, corners });
  }
}
const AO_CURVE = [0.42, 0.62, 0.8, 1];

export class MeshBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.ind = [];
    this._c = { r: 0, g: 0, b: 0 };
  }
  reset() { this.pos.length = this.nor.length = this.col.length = this.ind.length = 0; }

  // occ(x,y,z) -> true if that cell hides a face
  emit(x, y, z, mat, b, occ) {
    const p = [x, y, z], q = [0, 0, 0], ao = [0, 0, 0, 0];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      q[0] = x + F.n[0]; q[1] = y + F.n[1]; q[2] = z + F.n[2];
      if (occ(q[0], q[1], q[2])) continue;
      voxelColor(x, y, z, mat, b, this._c, F.d !== 1 || F.s < 0);
      const base = this.pos.length / 3;
      for (let c = 0; c < 4; c++) {
        const [cu, cv] = F.corners[c];
        const vx = [p[0], p[1], p[2]];
        if (F.s > 0) vx[F.d] += 1;
        vx[F.u] += cu; vx[F.v] += cv;
        this.pos.push(vx[0], vx[1], vx[2]);
        this.nor.push(F.n[0], F.n[1], F.n[2]);
        // AO
        const a = [q[0], q[1], q[2]], bq = [q[0], q[1], q[2]], cq = [q[0], q[1], q[2]];
        a[F.u] += cu ? 1 : -1;
        bq[F.v] += cv ? 1 : -1;
        cq[F.u] += cu ? 1 : -1; cq[F.v] += cv ? 1 : -1;
        const s1 = occ(a[0], a[1], a[2]) ? 1 : 0;
        const s2 = occ(bq[0], bq[1], bq[2]) ? 1 : 0;
        const cn = occ(cq[0], cq[1], cq[2]) ? 1 : 0;
        const lvl = s1 && s2 ? 0 : 3 - (s1 + s2 + cn);
        ao[c] = lvl;
        const k = AO_CURVE[lvl];
        this.col.push(this._c.r * k, this._c.g * k, this._c.b * k);
      }
      if (ao[0] + ao[2] >= ao[1] + ao[3]) this.ind.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.ind.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    }
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

export function gridOcc(x, y, z) {
  if (y < 0) return true;
  if (x < 0 || z < 0 || x >= W || z >= D || y >= H) return false;
  return grid[idx(x, y, z)] !== 0;
}

const builder = new MeshBuilder();
export function buildChunkGeometry(ci) {
  const cx = ci % CX, cz = ((ci / CX) | 0) % CZ, cy = (ci / (CX * CZ)) | 0;
  builder.reset();
  const x0 = cx * CS, y0 = cy * CS, z0 = cz * CS;
  for (let y = y0; y < y0 + CS; y++)
    for (let z = z0; z < z0 + CS; z++)
      for (let x = x0; x < x0 + CS; x++) {
        const k = idx(x, y, z);
        const m = grid[k];
        if (m) builder.emit(x, y, z, m, burn[k], gridOcc);
      }
  return builder.toGeometry();
}

// ============================================================================
// Map generation
// ============================================================================
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const lattice = (ix, iz) => hash3(ix, seed, iz) * 2 - 1;
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smooth(x - ix), fz = smooth(z - iz);
    const a = lattice(ix, iz), b = lattice(ix + 1, iz), c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
  return (x, z, oct = 4) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += value(x * freq, z * freq) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// Regions (x0, z0, x1, z1)
export const REGIONS = {
  castle:  [44, 8, 80, 44],
  city:    [70, 54, 118, 98],
  village: [6, 60, 58, 114],
  desert:  [84, 100, 127, 127],
  tntPark: [58, 58, 68, 68],
  plaza:   [52, 44, 74, 60],
};
const FLAT = 9; // ground surface height inside regions

function rectWeight(x, z, r, margin) {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dz = Math.max(r[1] - z, 0, z - r[3]);
  const d = Math.hypot(dx, dz);
  return 1 - smoothstep(0, margin, d);
}
const inRect = (x, z, r, pad = 0) => x >= r[0] - pad && x <= r[2] + pad && z >= r[1] - pad && z <= r[3] + pad;

export function generateWorld(seed = (Math.random() * 1e9) | 0) {
  grid.fill(0);
  burn.fill(0);
  const rng = mulberry32(seed);
  const noise = makeNoise(seed);
  const ridge = makeNoise(seed + 17);
  const r = (a, b) => a + rng() * (b - a);
  const ri = (a, b) => Math.floor(r(a, b + 1));

  const S = (x, y, z, m) => { if (inBounds(x, y, z)) { const k = idx(x, y, z); grid[k] = m; burn[k] = 0; } };
  const fill = (x0, x1, y0, y1, z0, z1, m) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) S(x, y, z, m);
  };

  // ---------------- Terrain ----------------
  const height = new Int16Array(W * D);
  const surfaceMat = new Uint8Array(W * D);
  const LAKE = { x: 28, z: 28, r: 17 };

  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      let h = 9 + noise(x / 38, z / 38) * 6;
      // Mountains in the north-east
      const mm = smoothstep(78, 100, x) * smoothstep(50, 30, z);
      if (mm > 0) {
        const rd = 1 - Math.abs(ridge(x / 22, z / 22));
        h += mm * (6 + rd * rd * 34 + noise(x / 9, z / 9) * 4);
      }
      // Flatten building regions
      let wFlat = 0;
      for (const key in REGIONS) wFlat = Math.max(wFlat, rectWeight(x, z, REGIONS[key], 7));
      h = h + (FLAT - h) * wFlat;
      // Lake basin
      const ld = Math.hypot(x - LAKE.x, z - LAKE.z) + noise(x / 8, z / 8) * 3;
      if (ld < LAKE.r + 6) h = h + (2.5 - h) * smoothstep(LAKE.r + 6, LAKE.r - 6, ld);

      h = Math.max(1, Math.min(H - 8, Math.round(h)));
      height[x + z * W] = h;

      let top = M.GRASS;
      const desert = inRect(x, z, REGIONS.desert) || (x > 82 && z > 96 && noise(x / 6, z / 6) > -0.1 && x + z > 182);
      if (desert) top = M.SAND;
      else if (h <= WATER_LEVEL + 1 && ld < LAKE.r + 4) top = M.SAND;
      else if (h >= 30) top = M.SNOW;
      else if (h >= 22) top = M.STONE;
      surfaceMat[x + z * W] = top;

      for (let y = 0; y <= h; y++) {
        let m;
        if (y === 0) m = M.BEDROCK;
        else if (y === h) m = top;
        else if (y >= h - 3) m = top === M.SAND ? M.SAND : top === M.SNOW || top === M.STONE ? M.STONE : M.DIRT;
        else m = M.STONE;
        S(x, y, z, m);
      }
      for (let y = h + 1; y <= WATER_LEVEL; y++) S(x, y, z, M.WATER);
    }
  }
  const groundAt = (x, z) => height[x + z * W];
  const g = FLAT + 1;

  // ---------------- Castle ----------------
  {
    const [X0, Z0, X1, Z1] = [48, 12, 76, 40];
    // Curtain wall (2 thick, 9 tall)
    for (let y = g; y < g + 9; y++)
      for (let z = Z0; z <= Z1; z++)
        for (let x = X0; x <= X1; x++) {
          const edge = x <= X0 + 1 || x >= X1 - 1 || z <= Z0 + 1 || z >= Z1 - 1;
          if (!edge) continue;
          if (z >= Z1 - 1 && x >= 60 && x <= 64 && y < g + 6) continue; // gate
          S(x, y, z, M.COBBLE);
        }
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++)
        if ((x === X0 || x === X1 || z === Z0 || z === Z1) && (x + z) % 2 === 0) S(x, g + 9, z, M.COBBLE);
    // Wooden gate beam
    fill(60, 64, g + 6, g + 6, Z1 - 1, Z1, M.WOOD);

    // Corner towers
    const tower = (tx, tz, size, height) => {
      for (let y = g; y < g + height; y++)
        for (let z = tz; z < tz + size; z++)
          for (let x = tx; x < tx + size; x++) {
            const edge = x === tx || x === tx + size - 1 || z === tz || z === tz + size - 1;
            const floor = (y - g) % 5 === 4;
            if (!edge && !floor) continue;
            const mid = x === tx + (size >> 1) || z === tz + (size >> 1);
            if (edge && mid && (y - g) % 5 === 2) continue; // arrow slits
            S(x, y, z, M.STONE);
          }
      for (let z = tz; z < tz + size; z++)
        for (let x = tx; x < tx + size; x++)
          if ((x === tx || x === tx + size - 1 || z === tz || z === tz + size - 1) && (x + z) % 2 === 0)
            S(x, g + height, z, M.STONE);
    };
    tower(X0 - 2, Z0 - 2, 7, 15);
    tower(X1 - 4, Z0 - 2, 7, 15);
    tower(X0 - 2, Z1 - 4, 7, 15);
    tower(X1 - 4, Z1 - 4, 7, 15);

    // Keep
    const [KX, KZ, KS, KH] = [57, 20, 11, 23];
    for (let y = g; y < g + KH; y++)
      for (let z = KZ; z < KZ + KS; z++)
        for (let x = KX; x < KX + KS; x++) {
          const edge = x === KX || x === KX + KS - 1 || z === KZ || z === KZ + KS - 1;
          const floor = (y - g) % 6 === 5;
          if (!edge && !floor) continue;
          const off = (x - KX) + (z - KZ);
          if (edge && (y - g) % 6 >= 2 && (y - g) % 6 <= 3 && off % 3 === 1) { S(x, y, z, M.GLASS); continue; }
          if (edge && z === KZ + KS - 1 && x >= KX + 4 && x <= KX + 6 && y < g + 4) continue; // door
          S(x, y, z, M.STONE);
        }
    for (let z = KZ; z < KZ + KS; z++)
      for (let x = KX; x < KX + KS; x++)
        if ((x === KX || x === KX + KS - 1 || z === KZ || z === KZ + KS - 1) && (x + z) % 2 === 0) S(x, g + KH, z, M.STONE);
    // Flag
    fill(KX + 5, KX + 5, g + KH, g + KH + 6, KZ + 5, KZ + 5, M.WOOD);
    fill(KX + 6, KX + 9, g + KH + 4, g + KH + 6, KZ + 5, KZ + 5, M.CLOTH);
    // TNT stash in the keep
    fill(KX + 3, KX + 7, g, g + 1, KZ + 3, KZ + 6, M.TNT);
  }

  // ---------------- City ----------------
  {
    const [X0, Z0, X1, Z1] = REGIONS.city;
    for (let z = Z0; z <= Z1; z++) for (let x = X0; x <= X1; x++) S(x, FLAT, z, M.ASPHALT);
    for (let bx = 0; bx < 4; bx++) {
      for (let bz = 0; bz < 4; bz++) {
        const x0 = X0 + 3 + bx * 12, z0 = Z0 + 3 + bz * 11;
        const w = 9, d = 8;
        if (bx === 1 && bz === 2) {
          // Park
          for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) S(x, FLAT, z, M.GRASS);
          plantTree(x0 + 2, z0 + 2, 'oak');
          plantTree(x0 + 6, z0 + 5, 'oak');
          continue;
        }
        const tall = ri(14, 46);
        const top = Math.min(H - 4, g + tall);
        const wall = [M.CONCRETE, M.DARKCON, M.BRICK, M.CONCRETE][ri(0, 3)];
        for (let y = g; y < top; y++) {
          const floor = (y - g) % 3 === 0;
          for (let z = z0; z < z0 + d; z++)
            for (let x = x0; x < x0 + w; x++) {
              const edgeX = x === x0 || x === x0 + w - 1, edgeZ = z === z0 || z === z0 + d - 1;
              const edge = edgeX || edgeZ;
              if (!edge && !floor) continue;
              if (!edge) { S(x, y, z, M.CONCRETE); continue; }
              const corner = edgeX && edgeZ;
              const along = edgeZ ? x - x0 : z - z0;
              if (y < g + 3 && edgeZ && z === z0 + d - 1 && (x === x0 + 4)) continue; // door
              const win = !corner && !floor && along % 2 === 1;
              S(x, y, z, win ? M.GLASS : wall);
            }
        }
        fill(x0, x0 + w - 1, top, top, z0, z0 + d - 1, wall);
        if (rng() < 0.5) fill(x0 + 4, x0 + 4, top + 1, Math.min(H - 1, top + ri(2, 5)), z0 + 3, z0 + 3, M.METAL);
      }
    }
    // A fuel depot of TNT in one alley
    fill(X1 - 3, X1 - 1, g, g + 2, Z1 - 4, Z1 - 1, M.TNT);
  }

  // ---------------- Village ----------------
  {
    const house = (x0, z0, w, d, wallMat, roofMat, wallH = 4) => {
      fill(x0, x0 + w - 1, FLAT, FLAT, z0, z0 + d - 1, M.PLANKS);
      for (let y = g; y < g + wallH; y++)
        for (let z = z0; z < z0 + d; z++)
          for (let x = x0; x < x0 + w; x++) {
            const edgeX = x === x0 || x === x0 + w - 1, edgeZ = z === z0 || z === z0 + d - 1;
            if (!edgeX && !edgeZ) continue;
            const corner = edgeX && edgeZ;
            const midX = x0 + (w >> 1);
            if (edgeZ && z === z0 + d - 1 && x === midX && y < g + 2) continue; // door
            const win = !corner && (y === g + 1 || y === g + 2) && ((edgeZ && (x - x0) % 3 === 1 && x !== midX) || (edgeX && (z - z0) % 3 === 1));
            S(x, y, z, win ? M.GLASS : corner ? M.WOOD : wallMat);
          }
      for (let i = 0; ; i++) {
        const za = z0 - 1 + i, zb = z0 + d - i;
        if (za > zb) break;
        fill(x0 - 1, x0 + w, g + wallH + i, g + wallH + i, za, zb, roofMat);
        // gable ends
        if (i > 0) for (let z = za; z <= zb; z++) { S(x0, g + wallH + i - 1, z, wallMat); S(x0 + w - 1, g + wallH + i - 1, z, wallMat); }
      }
    };
    const spots = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) spots.push([10 + i * 16, 64 + j * 16]);
    spots.forEach(([x, z], n) => {
      if (n === 4) return; // church goes here
      const mats = [[M.BRICK, M.ROOF], [M.PLANKS, M.ROOF], [M.COBBLE, M.WOOD], [M.BRICK, M.DARKCON]][ri(0, 3)];
      house(x + ri(0, 2), z + ri(0, 2), ri(8, 11), ri(7, 9), mats[0], mats[1], ri(4, 5));
    });
    // Church
    const [cx, cz] = spots[4];
    house(cx, cz + 3, 12, 9, M.STONE, M.DARKCON, 7);
    const tx = cx + 4, tz = cz - 2;
    for (let y = g; y < g + 18; y++)
      for (let z = tz; z < tz + 5; z++)
        for (let x = tx; x < tx + 5; x++) {
          const edge = x === tx || x === tx + 4 || z === tz || z === tz + 4;
          if (!edge && (y - g) % 6 !== 5) continue;
          if (edge && (y - g) > 12 && (x === tx + 2 || z === tz + 2)) continue; // belfry openings
          S(x, y, z, M.STONE);
        }
    for (let i = 0; i < 3; i++) fill(tx + i, tx + 4 - i, g + 18 + i * 2, g + 19 + i * 2, tz + i, tz + 4 - i, M.DARKCON);
    fill(tx + 2, tx + 2, g + 24, g + 26, tz + 2, tz + 2, M.GOLD);
    // Well
    const wx = 34, wz = 108;
    for (let z = wz; z < wz + 4; z++) for (let x = wx; x < wx + 4; x++) {
      const edge = x === wx || x === wx + 3 || z === wz || z === wz + 3;
      S(x, g, z, edge ? M.COBBLE : M.WATER);
    }
    fill(wx, wx, g + 1, g + 3, wz, wz, M.WOOD);
    fill(wx + 3, wx + 3, g + 1, g + 3, wz + 3, wz + 3, M.WOOD);
    fill(wx, wx + 3, g + 4, g + 4, wz, wz + 3, M.ROOF);
    // Dirt paths
    for (let x = REGIONS.village[0]; x <= REGIONS.village[2]; x++) for (let dz = 0; dz < 2; dz++) S(x, FLAT, 77 + dz, M.DIRT);
    for (let z = REGIONS.village[1]; z <= REGIONS.village[3]; z++) for (let dx = 0; dx < 2; dx++) S(23 + dx, FLAT, z, M.DIRT);
  }

  // ---------------- Desert pyramids ----------------
  {
    const pyramid = (x0, z0, base) => {
      for (let i = 0; i * 2 < base; i++) {
        const last = (i + 1) * 2 >= base;
        fill(x0 + i, x0 + base - 1 - i, g + i, g + i, z0 + i, z0 + base - 1 - i, last ? M.GOLD : M.SANDSTONE);
      }
    };
    pyramid(97, 102, 23);
    pyramid(86, 108, 9);
    for (let n = 0; n < 9; n++) {
      const x = ri(86, 125), z = ri(101, 125);
      if (grid[idx(x, g, z)]) continue;
      const hgt = ri(2, 4);
      fill(x, x, g, g + hgt, z, z, M.CACTUS);
      if (hgt > 2) { S(x + 1, g + 2, z, M.CACTUS); S(x + 1, g + 3, z, M.CACTUS); }
    }
  }

  // ---------------- TNT pyramid near spawn ----------------
  {
    const [x0, z0] = [60, 60];
    for (let i = 0; i < 4; i++) fill(x0 + i, x0 + 6 - i, g + i, g + i, z0 + i, z0 + 6 - i, M.TNT);
  }

  // ---------------- Lake dock ----------------
  {
    fill(27, 29, WATER_LEVEL + 1, WATER_LEVEL + 1, 34, 47, M.PLANKS);
    for (let z = 34; z <= 46; z += 4) {
      for (const x of [27, 29]) for (let y = groundAt(x, z) + 1; y <= WATER_LEVEL; y++) S(x, y, z, M.WOOD);
    }
  }

  // ---------------- Trees ----------------
  function plantTree(x, z, kind) {
    let base = 0;
    for (let y = H - 1; y > 0; y--) if (grid[idx(x, y, z)]) { base = y + 1; break; }
    if (kind === 'pine') {
      const trunk = ri(6, 9);
      fill(x, x, base, base + trunk - 1, z, z, M.WOOD);
      for (let i = 0; i < trunk + 1; i++) {
        const yy = base + 2 + i;
        const rad = Math.max(0, Math.round((trunk - i) * 0.4));
        for (let dz = -rad; dz <= rad; dz++)
          for (let dx = -rad; dx <= rad; dx++)
            if (dx * dx + dz * dz <= rad * rad + 1 && !(dx === 0 && dz === 0 && i < trunk - 1) && !get(x + dx, yy, z + dz))
              S(x + dx, yy, z + dz, M.PINE);
      }
      S(x, base + trunk + 2, z, M.PINE);
    } else {
      const trunk = ri(4, 6);
      fill(x, x, base, base + trunk - 1, z, z, M.WOOD);
      const cy = base + trunk;
      for (let dy = -2; dy <= 2; dy++)
        for (let dz = -3; dz <= 3; dz++)
          for (let dx = -3; dx <= 3; dx++) {
            const dd = dx * dx + dy * dy * 1.6 + dz * dz;
            if (dd <= 7.5 + rng() * 2 && !get(x + dx, cy + dy, z + dz)) S(x + dx, cy + dy, z + dz, M.LEAVES);
          }
    }
  }
  for (let n = 0; n < 420; n++) {
    const x = ri(3, W - 4), z = ri(3, D - 4);
    let blocked = false;
    for (const key in REGIONS) if (inRect(x, z, REGIONS[key], 3)) blocked = true;
    if (blocked) continue;
    const h = groundAt(x, z);
    const top = surfaceMat[x + z * W];
    if (top !== M.GRASS && !(top === M.STONE && h < 26)) continue;
    if (h <= WATER_LEVEL + 1) continue;
    if (Math.hypot(x - 62, z - 52) < 8) continue; // keep spawn clear
    const pineZone = h > 14 || x > 76;
    if (rng() < 0.55) plantTree(x, z, pineZone || rng() < 0.25 ? 'pine' : 'oak');
  }

  markAllDirty();

  // Spawn: open field between castle, city and village, facing the castle gate
  const sx = 63, sz = 54;
  return { x: sx + 0.5, y: groundAt(sx, sz) + 1, z: sz + 0.5, yaw: 0 };
}
