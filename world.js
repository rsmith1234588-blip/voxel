// Infinite voxel world: chunked storage, on-demand procedural generation and meshing.
import * as THREE from 'three';

// ============================================================================
// Dimensions & materials
// ============================================================================
// Block size setting: 1 = normal 1 m blocks, 10 = tiny 10 cm blocks (10 per metre).
// Gameplay positions are always in metres; the block grid is VS cells per metre.
export const VS = (() => {
  try { return Number(localStorage.getItem('voxel.scale')) === 10 ? 10 : 1; } catch { return 1; }
})();
export const HM = 64;          // world height in metres
export const H = HM * VS;      // world height in cells
export const CS = 16;          // chunk size (x/z) and section height, in cells
export const SECTIONS = H / CS;
export const WATER_LEVEL = 12; // metres
export const REGION = 48;      // structure placement grid (metres)

export const M = {
  AIR: 0, BEDROCK: 1, DIRT: 2, GRASS: 3, STONE: 4, BRICK: 5, WOOD: 6, GLASS: 7, ROOF: 8,
  LEAVES: 9, SAND: 10, SNOW: 11, WATER: 12, CONCRETE: 13, ASPHALT: 14, PLANKS: 15,
  SANDSTONE: 16, GOLD: 17, TNT: 18, COBBLE: 19, PINE: 20, CACTUS: 21, METAL: 22, DARKCON: 23, CLOTH: 24,
  BIRCH: 25, AUTUMN: 26, MOSSY: 27, ICE: 28,
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
MAT_HEX[M.BIRCH] = 0xe6e2d6;
MAT_HEX[M.AUTUMN] = 0xd9772a;
MAT_HEX[M.MOSSY] = 0x6f7f5e;
MAT_HEX[M.ICE] = 0xbfe8f7;

const MAT_LIN = MAT_HEX.map((h) => new THREE.Color(h)); // linear-space colours for vertex colours
const CHAR = new THREE.Color(0x15110d);
const FLAT_SHADE = new Set([M.GLASS, M.WATER, M.GOLD, M.TNT, M.ICE]);

// ============================================================================
// Chunk column storage
// ============================================================================
const OFF = 32768;
export const colKey = (cx, cz) => (cx + OFF) * 65536 + (cz + OFF);
export const sectionKey = (cx, cy, cz) => colKey(cx, cz) * SECTIONS + cy;
export function decodeSection(key) {
  const cy = key % SECTIONS;
  const ck = (key - cy) / SECTIONS;
  return { cx: Math.floor(ck / 65536) - OFF, cz: (ck % 65536) - OFF, cy };
}
// Unique numeric key for any world cell (used by collapse flood fills)
const KOFF = 1 << 20;
export const cellKey = (x, y, z) => ((x + KOFF) * 2097152 + (z + KOFF)) * H + y;

class Column {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.grid = new Uint8Array(CS * CS * H);
    this.burn = null; // allocated on first scorch

    this.modified = false;
  }
}
const columns = new Map();
let lastKey = -1, lastCol = null;

export function getColumn(cx, cz) {
  const k = colKey(cx, cz);
  if (k === lastKey) return lastCol;
  const c = columns.get(k);
  if (c) { lastKey = k; lastCol = c; }
  return c;
}
const local = (x, y, z) => (x & 15) + CS * ((z & 15) + CS * y);

export function get(x, y, z) {
  if (y < 0 || y >= H) return 0;
  const c = getColumn(x >> 4, z >> 4);
  return c ? c.grid[local(x, y, z)] : 0;
}
export function getBurn(x, y, z) {
  if (y < 0 || y >= H) return 0;
  const c = getColumn(x >> 4, z >> 4);
  return c && c.burn ? c.burn[local(x, y, z)] : 0;
}
export function isLoaded(x, z) { return !!getColumn(x >> 4, z >> 4); }

// Dirty sections: "urgent" ones come from gameplay edits, "load" ones from streaming
export const dirtyUrgent = new Set();
export const dirtyLoad = new Set();

export function markDirty(x, y, z) {
  const cx0 = (x - 1) >> 4, cx1 = (x + 1) >> 4;
  const cy0 = Math.max(0, (y - 1) >> 4), cy1 = Math.min(SECTIONS - 1, (y + 1) >> 4);
  const cz0 = (z - 1) >> 4, cz1 = (z + 1) >> 4;
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) dirtyUrgent.add(sectionKey(cx, cy, cz));
}

// dirty=false skips per-cell remeshing; call markRangeDirty once afterwards (bulk edits)
export function set(x, y, z, mat, b = 0, dirty = true) {
  if (y < 0 || y >= H) return;
  const c = getColumn(x >> 4, z >> 4);
  if (!c) return;
  const i = local(x, y, z);
  c.grid[i] = mat;
  if (mat && b) {
    if (!c.burn) c.burn = new Uint8Array(CS * CS * H);
    c.burn[i] = b;
  } else if (c.burn) c.burn[i] = 0;
  c.modified = true;
  if (dirty) markDirty(x, y, z);
}

export function markRangeDirty(x0, y0, z0, x1, y1, z1) {
  const cy0 = Math.max(0, (y0 - 1) >> 4), cy1 = Math.min(SECTIONS - 1, (y1 + 1) >> 4);
  for (let cz = (z0 - 1) >> 4; cz <= (z1 + 1) >> 4; cz++)
    for (let cx = (x0 - 1) >> 4; cx <= (x1 + 1) >> 4; cx++)
      for (let cy = cy0; cy <= cy1; cy++) dirtyUrgent.add(sectionKey(cx, cy, cz));
}

export function addBurn(x, y, z, amount, dirty = true) {
  const c = getColumn(x >> 4, z >> 4);
  if (!c || y < 0 || y >= H) return;
  const i = local(x, y, z);
  if (!c.burn) c.burn = new Uint8Array(CS * CS * H);
  const v = c.burn[i] + amount;
  c.burn[i] = v > 255 ? 255 : v;
  c.modified = true;
  if (dirty) markDirty(x, y, z);
}

export function loadColumn(cx, cz) {
  let c = getColumn(cx, cz);
  if (!c) {
    c = generateColumn(cx, cz);
    columns.set(colKey(cx, cz), c);
  }
  for (let cy = 0; cy < SECTIONS; cy++) dirtyLoad.add(sectionKey(cx, cy, cz));
  // Neighbours can now cull faces against this column
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (getColumn(cx + dx, cz + dz)) for (let cy = 0; cy < SECTIONS; cy++) dirtyLoad.add(sectionKey(cx + dx, cy, cz + dz));
  }
  return c;
}

// Drop an unmodified column's data (it regenerates identically). Edited columns stay in memory.
export function unloadColumn(cx, cz) {
  const k = colKey(cx, cz);
  const c = columns.get(k);
  if (!c || c.modified) return;
  columns.delete(k);
  if (lastKey === k) { lastKey = -1; lastCol = null; }
}

export function resetWorld(seed) {
  columns.clear();
  lastKey = -1; lastCol = null;
  dirtyUrgent.clear();
  dirtyLoad.clear();
  plotCache.clear();
  setSeed(seed);
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
    this.cap = 4096; // vertices
    this.pos = new Float32Array(this.cap * 3);
    this.nor = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.ind = new Uint32Array(this.cap * 1.5);
    this.nv = 0; this.ni = 0;
    this._c = { r: 0, g: 0, b: 0 };
  }
  reset() { this.nv = 0; this.ni = 0; }
  grow() {
    this.cap *= 2;
    const g = (a, n) => { const b = new a.constructor(n); b.set(a); return b; };
    this.pos = g(this.pos, this.cap * 3); this.nor = g(this.nor, this.cap * 3);
    this.col = g(this.col, this.cap * 3); this.ind = g(this.ind, this.cap * 1.5);
  }

  // occ(x,y,z) -> true if that cell hides a face
  emit(x, y, z, mat, b, occ) {
    const p = [x, y, z], q = [0, 0, 0], ao = [0, 0, 0, 0];
    const a = [0, 0, 0], bq = [0, 0, 0], cq = [0, 0, 0];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      q[0] = x + F.n[0]; q[1] = y + F.n[1]; q[2] = z + F.n[2];
      if (occ(q[0], q[1], q[2])) continue;
      voxelColor(x, y, z, mat, b, this._c, F.d !== 1 || F.s < 0);
      if (this.nv + 4 > this.cap) this.grow();
      const base = this.nv;
      const P = this.pos, N = this.nor, C = this.col;
      for (let c = 0; c < 4; c++) {
        const cu = F.corners[c][0], cv = F.corners[c][1];
        const vx0 = p[0] + (F.d === 0 && F.s > 0 ? 1 : 0) + (F.u === 0 ? cu : 0) + (F.v === 0 ? cv : 0);
        const vx1 = p[1] + (F.d === 1 && F.s > 0 ? 1 : 0) + (F.u === 1 ? cu : 0) + (F.v === 1 ? cv : 0);
        const vx2 = p[2] + (F.d === 2 && F.s > 0 ? 1 : 0) + (F.u === 2 ? cu : 0) + (F.v === 2 ? cv : 0);
        const o = (base + c) * 3;
        P[o] = vx0; P[o + 1] = vx1; P[o + 2] = vx2;
        N[o] = F.n[0]; N[o + 1] = F.n[1]; N[o + 2] = F.n[2];
        a[0] = bq[0] = cq[0] = q[0]; a[1] = bq[1] = cq[1] = q[1]; a[2] = bq[2] = cq[2] = q[2];
        a[F.u] += cu ? 1 : -1;
        bq[F.v] += cv ? 1 : -1;
        cq[F.u] += cu ? 1 : -1; cq[F.v] += cv ? 1 : -1;
        const s1 = occ(a[0], a[1], a[2]) ? 1 : 0;
        const s2 = occ(bq[0], bq[1], bq[2]) ? 1 : 0;
        const cn = occ(cq[0], cq[1], cq[2]) ? 1 : 0;
        const lvl = s1 && s2 ? 0 : 3 - (s1 + s2 + cn);
        ao[c] = lvl;
        const k = AO_CURVE[lvl];
        C[o] = this._c.r * k; C[o + 1] = this._c.g * k; C[o + 2] = this._c.b * k;
      }
      this.nv += 4;
      const I = this.ind, j = this.ni;
      if (ao[0] + ao[2] >= ao[1] + ao[3]) { I[j] = base; I[j + 1] = base + 1; I[j + 2] = base + 2; I[j + 3] = base; I[j + 4] = base + 2; I[j + 5] = base + 3; }
      else { I[j] = base + 1; I[j + 1] = base + 2; I[j + 2] = base + 3; I[j + 3] = base + 1; I[j + 4] = base + 3; I[j + 5] = base; }
      this.ni += 6;
    }
  }

  toGeometry() {
    if (!this.ni) return null;
    const g = new THREE.BufferGeometry();
    const n = this.nv * 3;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n), 3));
    g.setIndex(new THREE.BufferAttribute(this.nv > 65535 ? this.ind.slice(0, this.ni) : Uint16Array.from(this.ind.subarray(0, this.ni)), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// Unloaded neighbours count as solid so chunk borders don't render walls
export function worldOcc(x, y, z) {
  if (y < 0) return true;
  if (y >= H) return false;
  const c = getColumn(x >> 4, z >> 4);
  if (!c) return true;
  return c.grid[local(x, y, z)] !== 0;
}

// True if a section holds nothing but air (cheap check before meshing)
export function sectionIsAir(key) {
  const { cx, cy, cz } = decodeSection(key);
  const col = getColumn(cx, cz);
  if (!col) return true;
  const g = col.grid, start = cy * CS * CS * CS, end = start + CS * CS * CS;
  for (let i = start; i < end; i++) if (g[i]) return false;
  return true;
}

const builder = new MeshBuilder();
export function buildSectionGeometry(key) {
  const { cx, cy, cz } = decodeSection(key);
  const col = getColumn(cx, cz);
  if (!col) return null;
  builder.reset();
  const x0 = cx * CS, y0 = cy * CS, z0 = cz * CS;
  const grid = col.grid, LAYER = CS * CS;
  // Neighbour lookups inside this column read the grid directly
  const occ = (x, y, z) => {
    const lx = x - x0, lz = z - z0;
    if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) return worldOcc(x, y, z);
    if (y < 0) return true;
    if (y >= H) return false;
    return grid[lx + CS * (lz + CS * y)] !== 0;
  };
  for (let ly = 0; ly < CS; ly++) {
    const y = y0 + ly;
    for (let lz = 0; lz < CS; lz++)
      for (let lx = 0; lx < CS; lx++) {
        const i = lx + CS * (lz + CS * y);
        const m = grid[i];
        if (!m) continue;
        // Fast path: a cell buried on all six sides inside this column has no faces
        if (lx > 0 && lx < CS - 1 && lz > 0 && lz < CS - 1 && y > 0 && y < H - 1 &&
          grid[i - 1] && grid[i + 1] && grid[i - CS] && grid[i + CS] && grid[i - LAYER] && grid[i + LAYER]) continue;
        builder.emit(x0 + lx, y, z0 + lz, m, col.burn ? col.burn[i] : 0, occ);
      }
  }
  return builder.toGeometry();
}

// ============================================================================
// Noise
// ============================================================================
export function mulberry32(a) {
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
      sum += value(x * freq + i * 17.3, z * freq - i * 9.1) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

let SEED = 1;
let nCont, nHill, nMount, nRidge, nTemp, nMoist, nDetail;
function setSeed(seed) {
  SEED = seed | 0;
  nCont = makeNoise(SEED + 1);
  nHill = makeNoise(SEED + 2);
  nMount = makeNoise(SEED + 3);
  nRidge = makeNoise(SEED + 4);
  nTemp = makeNoise(SEED + 5);
  nMoist = makeNoise(SEED + 6);
  nDetail = makeNoise(SEED + 7);
}
setSeed(1);

// ============================================================================
// Terrain & biomes
// ============================================================================
function baseHeight(x, z) {
  const cont = nCont(x / 300, z / 300, 3);
  const hills = nHill(x / 55, z / 55, 4);
  let h = 17 + cont * 11 + hills * 5;
  const mm = smoothstep(0.12, 0.45, nMount(x / 280, z / 280, 2));
  if (mm > 0) {
    const r = 1 - Math.abs(nRidge(x / 70, z / 70, 3));
    h += mm * (r * r * 36 + hills * 5 + 4);
  }
  return h;
}

export function biomeAt(x, z) {
  const h = baseHeight(x, z);
  if (h >= 34) return 'mountains';
  if (h < WATER_LEVEL) return 'lake';
  const t = nTemp(x / 380, z / 380, 2);
  if (t > 0.22) return 'desert';
  if (t < -0.32) return 'snow';
  const m = nMoist(x / 260, z / 260, 2);
  if (m > 0.18) return 'forest';
  if (m < -0.25) return 'autumn';
  return 'plains';
}

// ---------------- Structure plots ----------------
const plotCache = new Map();
const STRUCTURE_SIZE = { castle: 34, city: 36, village: 38, pyramid: 25, watchtower: 9, ruins: 22, tnt: 14, plaza: 40 };

function choosePlot(rx, rz) {
  const rng = mulberry32((hash3(rx, SEED, rz) * 4294967296) | 0);
  // The spawn area always has a castle with an open plaza in front of it
  let type = null;
  if (rx === 0 && rz === 0) type = 'castle';
  else if (rx === 0 && rz === 1) type = 'plaza';
  const cx = rx * REGION + REGION / 2, cz = rz * REGION + REGION / 2;
  const biome = biomeAt(cx, cz);
  if (!type) {
    const r = rng();
    if (biome === 'lake') return null;
    if (biome === 'desert') type = r < 0.42 ? 'pyramid' : r < 0.52 ? 'tnt' : r < 0.62 ? 'ruins' : null;
    else if (biome === 'mountains') type = r < 0.25 ? 'watchtower' : null;
    else if (biome === 'snow') type = r < 0.15 ? 'watchtower' : r < 0.3 ? 'castle' : r < 0.4 ? 'village' : null;
    else {
      type = r < 0.1 ? 'castle' : r < 0.24 ? 'city' : r < 0.46 ? 'village' : r < 0.56 ? 'ruins'
        : r < 0.63 ? 'watchtower' : r < 0.7 ? 'tnt' : null;
    }
  }
  if (!type) return null;
  const size = STRUCTURE_SIZE[type];
  const slack = REGION - 6 - size;
  const ox = rx * REGION + 3 + Math.floor(rng() * Math.max(1, slack));
  const oz = rz * REGION + 3 + Math.floor(rng() * Math.max(1, slack));
  let base = Math.round(baseHeight(ox + size / 2, oz + size / 2));
  if (rx === 0 && (rz === 0 || rz === 1)) base = Math.max(Math.round(baseHeight(24, 24)), WATER_LEVEL + 3);
  if (base <= WATER_LEVEL + 1) return null;
  if (type === 'city' && base > 26) type = 'village';
  if (base > HM - 22 && type !== 'watchtower') return null;
  const flatten = type !== 'watchtower' && type !== 'ruins';
  return { type, x0: ox, z0: oz, x1: ox + size - 1, z1: oz + size - 1, base, flatten, seed: (rng() * 4294967296) | 0 };
}

function getPlot(rx, rz) {
  const k = colKey(rx, rz);
  let p = plotCache.get(k);
  if (p === undefined) { p = choosePlot(rx, rz); plotCache.set(k, p); }
  return p;
}

function rectDist(x, z, p) {
  const dx = Math.max(p.x0 - x, 0, x - p.x1);
  const dz = Math.max(p.z0 - z, 0, z - p.z1);
  return Math.hypot(dx, dz);
}

function plotsNear(x, z) {
  const rx = Math.floor(x / REGION), rz = Math.floor(z / REGION);
  const out = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const p = getPlot(rx + dx, rz + dz);
      if (p) out.push(p);
    }
  return out;
}

// Unrounded ground height in metres (tiny-block mode uses this for smooth slopes)
export function terrainHeightF(x, z) {
  let h = baseHeight(x, z);
  let best = 0, target = h;
  for (const p of plotsNear(x, z)) {
    if (!p.flatten) continue;
    const w = 1 - smoothstep(0, 9, rectDist(x, z, p));
    if (w > best) { best = w; target = p.base; }
  }
  h += (target - h) * best;
  return Math.max(2, Math.min(HM - 6, h));
}
export function terrainHeight(x, z) {
  return Math.round(terrainHeightF(x, z));
}

function insidePlot(x, z, pad) {
  for (const p of plotsNear(x, z)) if (rectDist(x, z, p) <= pad) return true;
  return false;
}

// ============================================================================
// Column generation
// ============================================================================
function generateColumn(cx, cz) {
  return VS === 1 ? generateColumn1(cx, cz) : generateColumnFine(cx, cz);
}

function generateColumn1(cx, cz) {
  const col = new Column(cx, cz);
  const g = col.grid;
  const X0 = cx * CS, Z0 = cz * CS;

  // Clipped writers used by terrain, structures and trees
  const S = (x, y, z, m) => {
    if (y < 0 || y >= H) return;
    const lx = x - X0, lz = z - Z0;
    if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) return;
    g[lx + CS * (lz + CS * y)] = m;
  };
  const G = (x, y, z) => {
    const lx = x - X0, lz = z - Z0;
    if (y < 0 || y >= H || lx < 0 || lx >= CS || lz < 0 || lz >= CS) return 0;
    return g[lx + CS * (lz + CS * y)];
  };
  const fill = (x0, x1, y0, y1, z0, z1, m) => {
    const ax = Math.max(x0, X0), bx = Math.min(x1, X0 + CS - 1);
    const az = Math.max(z0, Z0), bz = Math.min(z1, Z0 + CS - 1);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++)
      for (let z = az; z <= bz; z++)
        for (let x = ax; x <= bx; x++) g[x - X0 + CS * (z - Z0 + CS * y)] = m;
  };
  const W = { S, G, fill };

  // ---------------- Terrain ----------------
  for (let lz = 0; lz < CS; lz++) {
    for (let lx = 0; lx < CS; lx++) {
      const x = X0 + lx, z = Z0 + lz;
      const h = terrainHeight(x, z);
      const biome = biomeAt(x, z);
      let top = M.GRASS, sub = M.DIRT;
      if (h >= 44) { top = M.SNOW; sub = M.STONE; }
      else if (h >= 36) { top = M.STONE; sub = M.STONE; }
      else if (h <= WATER_LEVEL + 1) { top = M.SAND; sub = M.SAND; }
      else if (biome === 'desert') { top = M.SAND; sub = M.SAND; }
      else if (biome === 'snow') { top = M.SNOW; sub = M.DIRT; }
      for (let y = 0; y <= h; y++) {
        let m;
        if (y === 0) m = M.BEDROCK;
        else if (y === h) m = top;
        else if (y >= h - 3) m = sub;
        else m = M.STONE;
        g[lx + CS * (lz + CS * y)] = m;
      }
      for (let y = h + 1; y <= WATER_LEVEL; y++) g[lx + CS * (lz + CS * y)] = M.WATER;
      // Rare buried TNT pockets for surprise chain reactions
      if (h > WATER_LEVEL + 2 && hash3(x, SEED + 99, z) < 0.0009) {
        for (let y = h - 3; y < h; y++) g[lx + CS * (lz + CS * y)] = M.TNT;
      }
    }
  }

  // ---------------- Structures ----------------
  const rx0 = Math.floor((X0 - REGION) / REGION), rx1 = Math.floor((X0 + CS + REGION) / REGION);
  const rz0 = Math.floor((Z0 - REGION) / REGION), rz1 = Math.floor((Z0 + CS + REGION) / REGION);
  for (let rz = rz0; rz <= rz1; rz++)
    for (let rx = rx0; rx <= rx1; rx++) {
      const p = getPlot(rx, rz);
      if (!p) continue;
      if (p.x1 + 3 < X0 || p.x0 - 3 >= X0 + CS || p.z1 + 3 < Z0 || p.z0 - 3 >= Z0 + CS) continue;
      BUILDERS[p.type](W, p, mulberry32(p.seed));
    }

  // ---------------- Trees ----------------
  for (let z = Z0 - 3; z < Z0 + CS + 3; z++) {
    for (let x = X0 - 3; x < X0 + CS + 3; x++) {
      const r = hash3(x, SEED + 31, z);
      if (r > 0.04) continue;
      const biome = biomeAt(x, z);
      const density = { forest: 0.035, autumn: 0.025, plains: 0.007, snow: 0.012, mountains: 0.006, desert: 0.003, lake: 0 }[biome];
      if (r > density) continue;
      const h = terrainHeight(x, z);
      if (h <= WATER_LEVEL || h >= 42) continue;
      if (insidePlot(x, z, 3)) continue;
      const r2 = hash3(x, SEED + 57, z);
      let kind;
      if (biome === 'desert') kind = 'cactus';
      else if (biome === 'snow' || biome === 'mountains') kind = 'pine';
      else if (biome === 'autumn') kind = r2 < 0.5 ? 'autumn' : r2 < 0.8 ? 'birch' : 'oak';
      else if (biome === 'forest') kind = r2 < 0.35 ? 'pine' : r2 < 0.55 ? 'birch' : 'oak';
      else kind = r2 < 0.75 ? 'oak' : 'birch';
      plantTree(W, x, h + 1, z, kind, r2);
    }
  }
  return col;
}

// Tiny-block generation. Terrain is sampled per cell from the continuous height
// field (smooth slopes), while structures and trees are still designed in metre
// blocks and stamped as VS x VS x VS groups of cells.
function generateColumnFine(cx, cz) {
  const col = new Column(cx, cz);
  const g = col.grid;
  const X0 = cx * CS, Z0 = cz * CS;         // cells
  const X1 = X0 + CS, Z1 = Z0 + CS;
  const idx = (lx, y, lz) => lx + CS * (lz + CS * y);

  // Writers in metre-block coordinates, clipped to this column
  const S = (x, y, z, m) => {
    if (y < 0 || y >= HM) return;
    const ax = Math.max(x * VS, X0), bx = Math.min(x * VS + VS, X1);
    if (ax >= bx) return;
    const az = Math.max(z * VS, Z0), bz = Math.min(z * VS + VS, Z1);
    if (az >= bz) return;
    for (let yy = y * VS; yy < y * VS + VS; yy++)
      for (let zz = az; zz < bz; zz++)
        for (let xx = ax; xx < bx; xx++) g[idx(xx - X0, yy, zz - Z0)] = m;
  };
  const G = (x, y, z) => {
    if (y < 0 || y >= HM) return 0;
    const ax = Math.max(x * VS, X0), az = Math.max(z * VS, Z0);
    if (ax >= Math.min(x * VS + VS, X1) || az >= Math.min(z * VS + VS, Z1)) return 0;
    return g[idx(ax - X0, y * VS + (VS >> 1), az - Z0)];
  };
  const fill = (x0, x1, y0, y1, z0, z1, m) => {
    const ax = Math.max(x0 * VS, X0), bx = Math.min((x1 + 1) * VS, X1);
    const az = Math.max(z0 * VS, Z0), bz = Math.min((z1 + 1) * VS, Z1);
    if (ax >= bx || az >= bz) return;
    const ay = Math.max(0, y0 * VS), by = Math.min(H, (y1 + 1) * VS);
    for (let y = ay; y < by; y++)
      for (let z = az; z < bz; z++)
        for (let x = ax; x < bx; x++) g[idx(x - X0, y, z - Z0)] = m;
  };
  const W = { S, G, fill };

  // ---------------- Terrain ----------------
  const biomes = new Map();
  const biomeOf = (bx, bz) => {
    const k = bx * 65536 + bz;
    let b = biomes.get(k);
    if (!b) { b = biomeAt(bx, bz); biomes.set(k, b); }
    return b;
  };
  const topThick = Math.max(1, Math.round(VS * 0.2));
  const waterTop = (WATER_LEVEL + 1) * VS; // first cell above the water
  for (let lz = 0; lz < CS; lz++) {
    for (let lx = 0; lx < CS; lx++) {
      const xm = (X0 + lx + 0.5) / VS, zm = (Z0 + lz + 0.5) / VS;
      const hf = terrainHeightF(xm, zm);
      const yt = Math.max(VS, Math.min(H - 1, Math.round((hf + 1) * VS) - 1)); // top solid cell
      const biome = biomeOf(Math.floor(xm), Math.floor(zm));
      let top = M.GRASS, sub = M.DIRT;
      if (hf >= 44) { top = M.SNOW; sub = M.STONE; }
      else if (hf >= 36) { top = M.STONE; sub = M.STONE; }
      else if (hf <= WATER_LEVEL + 1) { top = M.SAND; sub = M.SAND; }
      else if (biome === 'desert') { top = M.SAND; sub = M.SAND; }
      else if (biome === 'snow') { top = M.SNOW; sub = M.DIRT; }
      for (let y = 0; y <= yt; y++) {
        let m;
        if (y < VS) m = M.BEDROCK;
        else if (y > yt - topThick) m = top;
        else if (y > yt - 4 * VS) m = sub;
        else m = M.STONE;
        g[idx(lx, y, lz)] = m;
      }
      for (let y = yt + 1; y < waterTop; y++) g[idx(lx, y, lz)] = M.WATER;
      const bx = Math.floor(xm), bz = Math.floor(zm);
      if (hf > WATER_LEVEL + 2 && hash3(bx, SEED + 99, bz) < 0.0009) {
        for (let y = Math.max(VS, yt - 4 * VS); y < yt - VS; y++) g[idx(lx, y, lz)] = M.TNT;
      }
    }
  }

  // ---------------- Structures ----------------
  const mx0 = Math.floor(X0 / VS), mx1 = Math.floor((X1 - 1) / VS);
  const mz0 = Math.floor(Z0 / VS), mz1 = Math.floor((Z1 - 1) / VS);
  const rx0 = Math.floor((mx0 - REGION) / REGION), rx1 = Math.floor((mx1 + REGION) / REGION);
  const rz0 = Math.floor((mz0 - REGION) / REGION), rz1 = Math.floor((mz1 + REGION) / REGION);
  for (let rz = rz0; rz <= rz1; rz++)
    for (let rx = rx0; rx <= rx1; rx++) {
      const p = getPlot(rx, rz);
      if (!p) continue;
      if (p.x1 + 3 < mx0 || p.x0 - 3 > mx1 || p.z1 + 3 < mz0 || p.z0 - 3 > mz1) continue;
      BUILDERS[p.type](W, p, mulberry32(p.seed));
    }

  // ---------------- Trees ----------------
  for (let z = mz0 - 3; z <= mz1 + 3; z++) {
    for (let x = mx0 - 3; x <= mx1 + 3; x++) {
      const r = hash3(x, SEED + 31, z);
      if (r > 0.04) continue;
      const biome = biomeAt(x, z);
      const density = { forest: 0.035, autumn: 0.025, plains: 0.007, snow: 0.012, mountains: 0.006, desert: 0.003, lake: 0 }[biome];
      if (r > density) continue;
      const h = terrainHeight(x, z);
      if (h <= WATER_LEVEL || h >= 42) continue;
      if (insidePlot(x, z, 3)) continue;
      const r2 = hash3(x, SEED + 57, z);
      let kind;
      if (biome === 'desert') kind = 'cactus';
      else if (biome === 'snow' || biome === 'mountains') kind = 'pine';
      else if (biome === 'autumn') kind = r2 < 0.5 ? 'autumn' : r2 < 0.8 ? 'birch' : 'oak';
      else if (biome === 'forest') kind = r2 < 0.35 ? 'pine' : r2 < 0.55 ? 'birch' : 'oak';
      else kind = r2 < 0.75 ? 'oak' : 'birch';
      plantTree(W, x, h + 1, z, kind, r2);
    }
  }
  return col;
}

function plantTree({ S, G, fill }, x, base, z, kind, r) {
  const rnd = mulberry32((r * 4294967296) | 0);
  // With tiny blocks the ground is smooth, so sink trunks in to avoid floating trees
  const root = VS > 1 ? base - 2 : base;
  if (kind === 'cactus') {
    const hgt = 2 + Math.floor(rnd() * 3);
    fill(x, x, root, base + hgt, z, z, M.CACTUS);
    if (hgt > 2) { S(x + 1, base + 2, z, M.CACTUS); S(x + 1, base + 3, z, M.CACTUS); }
    return;
  }
  if (kind === 'pine') {
    const trunk = 6 + Math.floor(rnd() * 4);
    fill(x, x, root, base + trunk - 1, z, z, M.WOOD);
    for (let i = 0; i < trunk + 1; i++) {
      const yy = base + 2 + i;
      const rad = Math.max(0, Math.round((trunk - i) * 0.4));
      for (let dz = -rad; dz <= rad; dz++)
        for (let dx = -rad; dx <= rad; dx++)
          if (dx * dx + dz * dz <= rad * rad + 1 && !(dx === 0 && dz === 0 && i < trunk - 1) && !G(x + dx, yy, z + dz))
            S(x + dx, yy, z + dz, M.PINE);
    }
    S(x, base + trunk + 2, z, M.PINE);
    return;
  }
  const trunk = 4 + Math.floor(rnd() * 3);
  fill(x, x, root, base + trunk - 1, z, z, kind === 'birch' ? M.BIRCH : M.WOOD);
  const leaf = kind === 'autumn' ? M.AUTUMN : M.LEAVES;
  const cy = base + trunk;
  for (let dy = -2; dy <= 2; dy++)
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        const dd = dx * dx + dy * dy * 1.6 + dz * dz;
        if (dd <= 7.5 + hash3(x + dx, cy + dy, z + dz) * 2 && !G(x + dx, cy + dy, z + dz)) S(x + dx, cy + dy, z + dz, leaf);
      }
}

// ============================================================================
// Structure builders. Each one is deterministic for its plot and writes
// through the clipped S/fill helpers, so it can be stamped chunk by chunk.
// ============================================================================
const BUILDERS = {
  plaza({ S, fill }, p) {
    // Open square in front of the spawn castle, with a TNT pyramid to play with
    const g = p.base + 1;
    for (let i = 0; i < 4; i++) fill(p.x0 + 26 + i, p.x0 + 32 - i, g + i, g + i, p.z0 + 10 + i, p.z0 + 16 - i, M.TNT);
    fill(p.x0 + 8, p.x0 + 9, g, g, p.z0 + 12, p.z0 + 13, M.TNT);
    S(p.x0 + 8, g + 1, p.z0 + 12, M.TNT);
  },

  castle({ S, fill }, p) {
    const g = p.base + 1;
    const X0 = p.x0 + 2, Z0 = p.z0 + 2, X1 = p.x1 - 2, Z1 = p.z1 - 2;
    const gx = (X0 + X1) >> 1;
    for (let y = g; y < g + 9; y++)
      for (let z = Z0; z <= Z1; z++)
        for (let x = X0; x <= X1; x++) {
          const edge = x <= X0 + 1 || x >= X1 - 1 || z <= Z0 + 1 || z >= Z1 - 1;
          if (!edge) continue;
          if (z >= Z1 - 1 && Math.abs(x - gx) <= 2 && y < g + 6) continue; // gate
          S(x, y, z, M.COBBLE);
        }
    for (let z = Z0; z <= Z1; z++)
      for (let x = X0; x <= X1; x++)
        if ((x === X0 || x === X1 || z === Z0 || z === Z1) && (x + z) % 2 === 0) S(x, g + 9, z, M.COBBLE);
    fill(gx - 2, gx + 2, g + 6, g + 6, Z1 - 1, Z1, M.WOOD);

    const tower = (tx, tz, size, height) => {
      for (let y = g; y < g + height; y++)
        for (let z = tz; z < tz + size; z++)
          for (let x = tx; x < tx + size; x++) {
            const edge = x === tx || x === tx + size - 1 || z === tz || z === tz + size - 1;
            const floor = (y - g) % 5 === 4;
            if (!edge && !floor) continue;
            const mid = x === tx + (size >> 1) || z === tz + (size >> 1);
            if (edge && mid && (y - g) % 5 === 2) continue;
            S(x, y, z, M.STONE);
          }
      for (let z = tz; z < tz + size; z++)
        for (let x = tx; x < tx + size; x++)
          if ((x === tx || x === tx + size - 1 || z === tz || z === tz + size - 1) && (x + z) % 2 === 0) S(x, g + height, z, M.STONE);
    };
    tower(X0 - 2, Z0 - 2, 7, 15);
    tower(X1 - 4, Z0 - 2, 7, 15);
    tower(X0 - 2, Z1 - 4, 7, 15);
    tower(X1 - 4, Z1 - 4, 7, 15);

    const KS = 11, KH = 23;
    const KX = gx - 5, KZ = ((Z0 + Z1) >> 1) - 6;
    for (let y = g; y < g + KH; y++)
      for (let z = KZ; z < KZ + KS; z++)
        for (let x = KX; x < KX + KS; x++) {
          const edge = x === KX || x === KX + KS - 1 || z === KZ || z === KZ + KS - 1;
          const floor = (y - g) % 6 === 5;
          if (!edge && !floor) continue;
          const off = (x - KX) + (z - KZ);
          if (edge && (y - g) % 6 >= 2 && (y - g) % 6 <= 3 && off % 3 === 1) { S(x, y, z, M.GLASS); continue; }
          if (edge && z === KZ + KS - 1 && x >= KX + 4 && x <= KX + 6 && y < g + 4) continue;
          S(x, y, z, M.STONE);
        }
    for (let z = KZ; z < KZ + KS; z++)
      for (let x = KX; x < KX + KS; x++)
        if ((x === KX || x === KX + KS - 1 || z === KZ || z === KZ + KS - 1) && (x + z) % 2 === 0) S(x, g + KH, z, M.STONE);
    fill(KX + 5, KX + 5, g + KH, g + KH + 6, KZ + 5, KZ + 5, M.WOOD);
    fill(KX + 6, KX + 9, g + KH + 4, g + KH + 6, KZ + 5, KZ + 5, M.CLOTH);
    fill(KX + 3, KX + 7, g, g + 1, KZ + 3, KZ + 6, M.TNT);
  },

  city({ S, fill }, p, rng) {
    const g = p.base + 1;
    fill(p.x0, p.x1, p.base, p.base, p.z0, p.z1, M.ASPHALT);
    for (let bx = 0; bx < 3; bx++) {
      for (let bz = 0; bz < 3; bz++) {
        const x0 = p.x0 + 2 + bx * 12, z0 = p.z0 + 2 + bz * 12;
        const w = 9, d = 9;
        if (rng() < 0.12) {
          fill(x0, x0 + w - 1, p.base, p.base, z0, z0 + d - 1, M.GRASS);
          continue;
        }
        const tall = 12 + Math.floor(rng() * 32);
        const top = Math.min(HM - 4, g + tall);
        const wall = [M.CONCRETE, M.DARKCON, M.BRICK, M.CONCRETE][Math.floor(rng() * 4)];
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
              if (y < g + 3 && z === z0 + d - 1 && x === x0 + 4) continue;
              S(x, y, z, !corner && !floor && along % 2 === 1 ? M.GLASS : wall);
            }
        }
        fill(x0, x0 + w - 1, top, top, z0, z0 + d - 1, wall);
        if (rng() < 0.5) fill(x0 + 4, x0 + 4, top + 1, Math.min(HM - 1, top + 2 + Math.floor(rng() * 4)), z0 + 4, z0 + 4, M.METAL);
        if (rng() < 0.15) fill(x0 + 3, x0 + 5, g, g + 1, z0 + 3, z0 + 5, M.TNT); // basement explosives
      }
    }
  },

  village({ S, fill }, p, rng) {
    const g = p.base + 1;
    const house = (x0, z0, w, d, wallMat, roofMat, wallH) => {
      fill(x0, x0 + w - 1, p.base, p.base, z0, z0 + d - 1, M.PLANKS);
      for (let y = g; y < g + wallH; y++)
        for (let z = z0; z < z0 + d; z++)
          for (let x = x0; x < x0 + w; x++) {
            const edgeX = x === x0 || x === x0 + w - 1, edgeZ = z === z0 || z === z0 + d - 1;
            if (!edgeX && !edgeZ) continue;
            const corner = edgeX && edgeZ;
            const midX = x0 + (w >> 1);
            if (edgeZ && z === z0 + d - 1 && x === midX && y < g + 2) continue;
            const win = !corner && (y === g + 1 || y === g + 2) && ((edgeZ && (x - x0) % 3 === 1 && x !== midX) || (edgeX && (z - z0) % 3 === 1));
            S(x, y, z, win ? M.GLASS : corner ? M.WOOD : wallMat);
          }
      for (let i = 0; ; i++) {
        const za = z0 - 1 + i, zb = z0 + d - i;
        if (za > zb) break;
        fill(x0 - 1, x0 + w, g + wallH + i, g + wallH + i, za, zb, roofMat);
        if (i > 0) for (let z = za; z <= zb; z++) { S(x0, g + wallH + i - 1, z, wallMat); S(x0 + w - 1, g + wallH + i - 1, z, wallMat); }
      }
    };
    // Dirt crossroads
    const mx = p.x0 + 18, mz = p.z0 + 18;
    fill(p.x0, p.x1, p.base, p.base, mz, mz + 1, M.DIRT);
    fill(mx, mx + 1, p.base, p.base, p.z0, p.z1, M.DIRT);
    const quads = [[p.x0 + 2, p.z0 + 2], [p.x0 + 21, p.z0 + 2], [p.x0 + 2, p.z0 + 21], [p.x0 + 21, p.z0 + 21]];
    const churchAt = Math.floor(rng() * 5); // 4 = no church
    quads.forEach(([x, z], n) => {
      if (n === churchAt) {
        house(x + 1, z + 4, 12, 9, M.STONE, M.DARKCON, 7);
        const tx = x + 5, tz = z;
        for (let y = g; y < g + 18; y++)
          for (let zz = tz; zz < tz + 5; zz++)
            for (let xx = tx; xx < tx + 5; xx++) {
              const edge = xx === tx || xx === tx + 4 || zz === tz || zz === tz + 4;
              if (!edge && (y - g) % 6 !== 5) continue;
              if (edge && y - g > 12 && (xx === tx + 2 || zz === tz + 2)) continue;
              S(xx, y, zz, M.STONE);
            }
        for (let i = 0; i < 3; i++) fill(tx + i, tx + 4 - i, g + 18 + i * 2, g + 19 + i * 2, tz + i, tz + 4 - i, M.DARKCON);
        fill(tx + 2, tx + 2, g + 24, g + 26, tz + 2, tz + 2, M.GOLD);
        return;
      }
      const mats = [[M.BRICK, M.ROOF], [M.PLANKS, M.ROOF], [M.COBBLE, M.WOOD], [M.BRICK, M.DARKCON], [M.PLANKS, M.DARKCON]][Math.floor(rng() * 5)];
      const w = 8 + Math.floor(rng() * 4), d = 7 + Math.floor(rng() * 3);
      house(x + Math.floor(rng() * 3), z + Math.floor(rng() * 3), w, d, mats[0], mats[1], 4 + Math.floor(rng() * 2));
    });
    // Well at the crossroads
    const wx = mx - 1, wz = mz - 1;
    for (let z = wz; z < wz + 4; z++) for (let x = wx; x < wx + 4; x++) {
      const edge = x === wx || x === wx + 3 || z === wz || z === wz + 3;
      S(x, g, z, edge ? M.COBBLE : M.WATER);
    }
    fill(wx, wx, g + 1, g + 3, wz, wz, M.WOOD);
    fill(wx + 3, wx + 3, g + 1, g + 3, wz + 3, wz + 3, M.WOOD);
    fill(wx, wx + 3, g + 4, g + 4, wz, wz + 3, M.ROOF);
  },

  pyramid({ fill }, p, rng) {
    const g = p.base + 1;
    const base = rng() < 0.4 ? 17 : 25;
    const ox = p.x0 + ((25 - base) >> 1), oz = p.z0 + ((25 - base) >> 1);
    for (let i = 0; i * 2 < base; i++) {
      const last = (i + 1) * 2 >= base;
      fill(ox + i, ox + base - 1 - i, g + i, g + i, oz + i, oz + base - 1 - i, last ? M.GOLD : M.SANDSTONE);
    }
    // Hidden treasure room... full of TNT
    const c = (base >> 1);
    fill(ox + c - 1, ox + c + 1, g + 1, g + 2, oz + c - 1, oz + c + 1, M.TNT);
  },

  watchtower({ S, fill }, p, rng) {
    const g = p.base + 1;
    const hgt = 16 + Math.floor(rng() * 8);
    const ox = p.x0 + 1, oz = p.z0 + 1;
    // Foundation reaching down to the (unflattened) ground
    fill(ox, ox + 6, g - 8, g - 1, oz, oz + 6, M.COBBLE);
    for (let y = g; y < g + hgt; y++)
      for (let z = oz; z < oz + 7; z++)
        for (let x = ox; x < ox + 7; x++) {
          const edge = x === ox || x === ox + 6 || z === oz || z === oz + 6;
          const floor = (y - g) % 6 === 5;
          if (!edge && !floor) continue;
          if (edge && (y - g) % 6 === 2 && (x === ox + 3 || z === oz + 3)) continue;
          S(x, y, z, rng() < 0.15 ? M.MOSSY : M.STONE);
        }
    fill(ox - 1, ox + 7, g + hgt, g + hgt, oz - 1, oz + 7, M.PLANKS);
    for (let z = oz - 1; z <= oz + 7; z++)
      for (let x = ox - 1; x <= ox + 7; x++)
        if ((x === ox - 1 || x === ox + 7 || z === oz - 1 || z === oz + 7) && (x + z) % 2 === 0) S(x, g + hgt + 1, z, M.STONE);
    fill(ox + 3, ox + 3, g + hgt + 1, g + hgt + 5, oz + 3, oz + 3, M.WOOD);
    fill(ox + 4, ox + 6, g + hgt + 3, g + hgt + 5, oz + 3, oz + 3, M.CLOTH);
  },

  ruins({ S }, p, rng) {
    const walls = 4 + Math.floor(rng() * 4);
    for (let n = 0; n < walls; n++) {
      const horiz = rng() < 0.5;
      const len = 5 + Math.floor(rng() * 10);
      const sx = p.x0 + Math.floor(rng() * 14), sz = p.z0 + Math.floor(rng() * 14);
      const hgt = 3 + Math.floor(rng() * 6);
      for (let i = 0; i < len; i++) {
        const x = horiz ? sx + i : sx, z = horiz ? sz : sz + i;
        const ground = terrainHeight(x, z);
        const colH = Math.max(1, Math.round(hgt * (0.4 + 0.6 * hash3(x, n, z))));
        for (let y = ground + (VS > 1 ? 0 : 1); y <= ground + colH; y++) S(x, y, z, hash3(x, y, z) < 0.3 ? M.MOSSY : M.COBBLE);
      }
    }
    // Pillars
    for (let n = 0; n < 4; n++) {
      const x = p.x0 + 2 + Math.floor(rng() * 18), z = p.z0 + 2 + Math.floor(rng() * 18);
      const ground = terrainHeight(x, z);
      const hgt = 4 + Math.floor(rng() * 8);
      for (let y = ground + (VS > 1 ? 0 : 1); y <= ground + hgt; y++) S(x, y, z, M.STONE);
    }
  },

  tnt({ S, fill }, p, rng) {
    const g = p.base + 1;
    for (let i = 0; i < 4; i++) fill(p.x0 + 3 + i, p.x0 + 9 - i, g + i, g + i, p.z0 + 3 + i, p.z0 + 9 - i, M.TNT);
    for (let n = 0; n < 6; n++) {
      const x = p.x0 + Math.floor(rng() * 14), z = p.z0 + Math.floor(rng() * 14);
      const stack = 1 + Math.floor(rng() * 3);
      for (let y = g; y < g + stack; y++) S(x, y, z, M.TNT);
    }
  },
};

export function spawnPoint() {
  // Tiny mode can only see ~19 m, so start right in front of the castle gate
  const x = 24, z = VS > 1 ? 46 : 58;
  const y = VS === 1 ? terrainHeight(x, z) + 1 : Math.round((terrainHeightF(x + 0.5, z + 0.5) + 1) * VS) / VS;
  return { x: x + 0.5, y, z: z + 0.5, yaw: 0 };
}
