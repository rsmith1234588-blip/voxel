import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================================================
// World constants
// ============================================================================
const W = 32, D = 32, H = 28;          // map size in voxels (small for now)
const N = W * D * H;
const OX = W / 2, OZ = D / 2;          // grid -> world offset (map centred on origin)
const GRAVITY = 30;

const M = { BEDROCK: 1, DIRT: 2, GRASS: 3, STONE: 4, BRICK: 5, WOOD: 6, GLASS: 7, ROOF: 8, LEAVES: 9, SAND: 10 };
const MAT_COLORS = [
  0x000000,
  0x2b2b30, // bedrock (indestructible)
  0x7a5534, // dirt
  0x5fa83a, // grass
  0x8d8f94, // stone
  0xa8442f, // brick
  0x8a6136, // wood
  0x9fd4f0, // glass
  0x6b2a24, // roof
  0x3f8a35, // leaves
  0xd9c38a, // sand
];

const TOOLS = {
  hammer: { radius: 1.2 },
  bomb:   { radius: 3.6 },
  nuke:   { radius: 11 },
};

const idx = (x, y, z) => x + W * (z + D * y);
const inBounds = (x, y, z) => x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < D;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

// ============================================================================
// Renderer / scene / camera
// ============================================================================
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
app.appendChild(renderer.domElement);

const SKY = new THREE.Color(0x8fb8e0);
const scene = new THREE.Scene();
scene.background = SKY.clone();
scene.fog = new THREE.Fog(SKY.clone(), 70, 180);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(30, 26, 34);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 8;
controls.maxDistance = 110;
controls.update();

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a4a3a, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.position.set(30, 55, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const blastLight = new THREE.PointLight(0xffa040, 0, 0, 2);
scene.add(blastLight);

// Ground beyond the map edge
const outerGround = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshLambertMaterial({ color: 0x4d6b3a })
);
outerGround.rotation.x = -Math.PI / 2;
outerGround.position.y = -0.01;
outerGround.receiveShadow = true;
scene.add(outerGround);

// ============================================================================
// Voxel storage + instanced rendering
// ============================================================================
const grid = new Uint8Array(N);        // material id per cell (0 = empty)
const instOf = new Int32Array(N).fill(-1); // cell -> instance index
const instKey = new Int32Array(N);     // instance index -> cell
let voxCount = 0;
let voxDirty = false;

const voxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), N);
voxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
voxMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
voxMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
voxMesh.castShadow = voxMesh.receiveShadow = true;
voxMesh.frustumCulled = false;
voxMesh.count = 0;
scene.add(voxMesh);

const _m4 = new THREE.Matrix4();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

function addVoxel(x, y, z, mat) {
  if (!inBounds(x, y, z)) return;
  const k = idx(x, y, z);
  if (grid[k]) removeVoxel(k);
  grid[k] = mat;
  const i = voxCount++;
  instOf[k] = i;
  instKey[i] = k;
  _m4.makeTranslation(x - OX + 0.5, y + 0.5, z - OZ + 0.5);
  voxMesh.setMatrixAt(i, _m4);
  const shade = mat === M.GLASS ? 1 : 0.88 + Math.random() * 0.18;
  _c.setHex(MAT_COLORS[mat]).multiplyScalar(shade);
  voxMesh.setColorAt(i, _c);
  voxDirty = true;
}

function removeVoxel(k) {
  const i = instOf[k];
  if (i < 0) return;
  const last = voxCount - 1;
  if (i !== last) {
    voxMesh.getMatrixAt(last, _m4);
    voxMesh.setMatrixAt(i, _m4);
    voxMesh.getColorAt(last, _c);
    voxMesh.setColorAt(i, _c);
    const movedKey = instKey[last];
    instKey[i] = movedKey;
    instOf[movedKey] = i;
  }
  instOf[k] = -1;
  grid[k] = 0;
  voxCount--;
  voxDirty = true;
}

function cellCenter(k, out) {
  const x = k % W, z = ((k / W) | 0) % D, y = (k / (W * D)) | 0;
  return out.set(x - OX + 0.5, y + 0.5, z - OZ + 0.5);
}

// ============================================================================
// Map generation
// ============================================================================
function buildMap() {
  for (let k = 0; k < N; k++) if (grid[k]) removeVoxel(k);
  clearDebris();

  const fill = (x0, x1, y0, y1, z0, z1, mat) => {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) addVoxel(x, y, z, mat);
  };

  // Terrain: flat ground at y=3 with a grassy hill in one corner
  const ground = (x, z) => {
    const d = Math.hypot(x - 7, z - 7);
    return 3 + (d < 7 ? Math.round((7 - d) * 0.6) : 0);
  };
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const h = ground(x, z);
      for (let y = 0; y <= h; y++) addVoxel(x, y, z, y === 0 ? M.BEDROCK : y === h ? M.GRASS : M.DIRT);
    }
  }

  const g = 4; // first free layer on flat ground

  // Stone tower with floors, windows, door and crenellations
  for (let y = g; y < g + 14; y++) {
    for (let z = 20; z <= 25; z++) {
      for (let x = 20; x <= 25; x++) {
        const edge = x === 20 || x === 25 || z === 20 || z === 25;
        const floor = (y - g) % 5 === 4;
        if (!edge && !floor) continue;
        const mid = x === 22 || x === 23 || z === 22 || z === 23;
        if (edge && (y - g) % 5 === 2 && mid) continue;                 // windows
        if (edge && y < g + 3 && z === 20 && (x === 22 || x === 23)) continue; // door
        addVoxel(x, y, z, M.STONE);
      }
    }
  }
  for (let z = 20; z <= 25; z++)
    for (let x = 20; x <= 25; x++)
      if ((x === 20 || x === 25 || z === 20 || z === 25) && (x + z) % 2 === 0) addVoxel(x, g + 14, z, M.STONE);

  // Brick house with glass windows and a stepped roof
  for (let y = g; y < g + 5; y++) {
    for (let z = 19; z <= 26; z++) {
      for (let x = 4; x <= 12; x++) {
        const xEdge = x === 4 || x === 12, zEdge = z === 19 || z === 26;
        if (!xEdge && !zEdge) continue;
        if (zEdge && z === 19 && (x === 7 || x === 8) && y < g + 3) continue; // door
        const win = (y === g + 1 || y === g + 2) &&
          ((zEdge && !xEdge && [5, 6, 10, 11].includes(x)) || (xEdge && !zEdge && [21, 22, 24].includes(z)));
        addVoxel(x, y, z, win ? M.GLASS : M.BRICK);
      }
    }
  }
  for (let i = 0; i <= 4; i++) fill(3 + i, 13 - i, g + 5 + i, g + 5 + i, 18 + i, 27 - i, M.ROOF);

  // Sand pyramid
  for (let i = 0; i <= 3; i++) fill(22 + i, 28 - i, g + i, g + i, 4 + i, 10 - i, M.SAND);

  // Crenellated stone wall
  fill(15, 30, g, g + 2, 15, 15, M.STONE);
  for (let x = 15; x <= 30; x += 2) addVoxel(x, g + 3, 15, M.STONE);

  // Trees
  const tree = (x, z, trunk) => {
    const base = ground(x, z) + 1;
    fill(x, x, base, base + trunk - 1, z, z, M.WOOD);
    const cy = base + trunk;
    for (let dy = -2; dy <= 2; dy++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++)
          if (dx * dx + dy * dy + dz * dz <= 5 && !(dx === 0 && dz === 0 && dy < 0))
            addVoxel(x + dx, cy + dy, z + dz, M.LEAVES);
  };
  tree(7, 7, 4);
  tree(14, 4, 4);
  tree(16, 26, 5);
  tree(3, 13, 3);
  tree(28, 29, 4);

  stats.destroyed = 0;
  updateStats();
}

// ============================================================================
// Collapse: anything not connected to bedrock falls
// ============================================================================
const visited = new Uint8Array(N);
const queue = new Int32Array(N);

function checkCollapse() {
  visited.fill(0);
  let head = 0, tail = 0;
  for (let z = 0; z < D; z++)
    for (let x = 0; x < W; x++) {
      const k = idx(x, 0, z);
      if (grid[k]) { visited[k] = 1; queue[tail++] = k; }
    }
  const layer = W * D;
  while (head < tail) {
    const k = queue[head++];
    const x = k % W, z = ((k / W) | 0) % D, y = (k / layer) | 0;
    if (x > 0)     { const n = k - 1;     if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (x < W - 1) { const n = k + 1;     if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (z > 0)     { const n = k - W;     if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (z < D - 1) { const n = k + W;     if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (y > 0)     { const n = k - layer; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (y < H - 1) { const n = k + layer; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
  }
  if (tail === voxCount) return;

  // Walk instances backwards so swap-removal only moves already-checked entries
  const p = new THREE.Vector3();
  let fallen = 0;
  for (let i = voxCount - 1; i >= 0; i--) {
    const k = instKey[i];
    if (visited[k]) continue;
    cellCenter(k, p);
    voxMesh.getColorAt(i, _c);
    removeVoxel(k);
    fallen++;
    spawnDebris(p, _c, rand(-0.6, 0.6), rand(-0.5, 0.5), rand(-0.6, 0.6), rand(5, 8), 0.3);
  }
  stats.destroyed += fallen;
}

// ============================================================================
// Debris (loose cubes with simple physics)
// ============================================================================
const MAX_DEBRIS = 4000;
const debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshLambertMaterial(), MAX_DEBRIS);
debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
debrisMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
debrisMesh.castShadow = true;
debrisMesh.frustumCulled = false;
debrisMesh.count = 0;
scene.add(debrisMesh);
const debris = [];

function spawnDebris(pos, color, vx, vy, vz, life = rand(3, 5), spin = 1) {
  if (debris.length >= MAX_DEBRIS) return;
  debris.push({
    x: pos.x, y: pos.y, z: pos.z, vx, vy, vz,
    rx: rand(6.28), ry: rand(6.28), rz: rand(6.28),
    sx: rand(-8, 8) * spin, sy: rand(-8, 8) * spin, sz: rand(-8, 8) * spin,
    r: color.r, g: color.g, b: color.b,
    life, maxLife: life,
  });
}

function clearDebris() { debris.length = 0; debrisMesh.count = 0; }

const _dummy = new THREE.Object3D();
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    if (d.life <= 0 || d.y < -30) { debris[i] = debris[debris.length - 1]; debris.pop(); continue; }
    d.vy -= GRAVITY * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    d.rx += d.sx * dt; d.ry += d.sy * dt; d.rz += d.sz * dt;

    const gx = Math.floor(d.x + OX), gz = Math.floor(d.z + OZ);
    const inside = gx >= 0 && gx < W && gz >= 0 && gz < D;
    let floor = inside ? -Infinity : 0;
    if (inside) {
      const gy = Math.floor(d.y - 0.45);
      if (gy >= 0 && gy < H && grid[idx(gx, gy, gz)]) floor = gy + 1;
    }
    if (d.y - 0.45 < floor && d.vy < 0) {
      d.y = floor + 0.45;
      d.vy = Math.abs(d.vy) > 2 ? -d.vy * 0.3 : 0;
      d.vx *= 0.6; d.vz *= 0.6;
      d.sx *= 0.6; d.sy *= 0.6; d.sz *= 0.6;
    }
  }
  for (let i = 0; i < debris.length; i++) {
    const d = debris[i];
    const s = Math.min(1, d.life / 0.6);
    _dummy.position.set(d.x, d.y, d.z);
    _dummy.rotation.set(d.rx, d.ry, d.rz);
    _dummy.scale.setScalar(s);
    _dummy.updateMatrix();
    debrisMesh.setMatrixAt(i, _dummy.matrix);
    debrisMesh.setColorAt(i, _c.setRGB(d.r, d.g, d.b));
  }
  debrisMesh.count = debris.length;
  debrisMesh.instanceMatrix.needsUpdate = true;
  debrisMesh.instanceColor.needsUpdate = true;
}

// ============================================================================
// Particles (fire, smoke, dust) + timed effects
// ============================================================================
const MAX_PARTICLES = 800;
const particleGeo = new THREE.IcosahedronGeometry(1, 1);
const particles = [];
const particlePool = [];

function spawnParticle(o) {
  if (particles.length >= MAX_PARTICLES) return;
  let p = particlePool.pop();
  if (!p) {
    p = { mesh: new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })) };
  }
  p.mesh.material.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  p.mesh.position.copy(o.pos);
  p.vel = o.vel.clone();
  p.life = 0; p.maxLife = o.life;
  p.s0 = o.s0; p.s1 = o.s1;
  p.c0 = new THREE.Color(o.color); p.c1 = new THREE.Color(o.color2 ?? o.color);
  p.alpha = o.alpha ?? 0.9;
  p.drag = o.drag ?? 1.5;
  p.buoy = o.buoy ?? 0;
  scene.add(p.mesh);
  particles.push(p);
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    const t = p.life / p.maxLife;
    if (t >= 1) {
      scene.remove(p.mesh);
      particlePool.push(p);
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }
    p.vel.multiplyScalar(Math.exp(-p.drag * dt));
    p.vel.y += p.buoy * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.scale.setScalar(p.s0 + (p.s1 - p.s0) * Math.sqrt(t));
    p.mesh.material.color.copy(p.c0).lerp(p.c1, Math.min(1, t * 1.6));
    p.mesh.material.opacity = p.alpha * Math.min(1, t * 8) * (t > 0.5 ? (1 - t) / 0.5 : 1);
  }
}

const effects = [];
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) if (!effects[i](dt)) effects.splice(i, 1);
}

function fireball(pos, size, duration) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, depthWrite: false })
  );
  mesh.position.copy(pos);
  scene.add(mesh);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    const k = t / duration;
    if (k >= 1) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); return false; }
    mesh.scale.setScalar(size * (1 - Math.pow(1 - Math.min(1, k * 3), 3)));
    mesh.material.color.setHex(0xffe08a).lerp(_c2.setHex(0xd23a12), Math.min(1, k * 1.5));
    mesh.material.opacity = 1 - k * k;
    return true;
  });
}

function shockwave(pos, maxRadius, duration) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 96),
    new THREE.MeshBasicMaterial({ color: 0xfff6e0, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(pos.x, Math.max(pos.y, 0.5), pos.z);
  scene.add(mesh);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    const k = t / duration;
    if (k >= 1) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); return false; }
    mesh.scale.setScalar(1 + maxRadius * Math.sqrt(k));
    mesh.material.opacity = 0.9 * (1 - k);
    return true;
  });
}

function flashLight(pos, intensity, duration) {
  blastLight.position.copy(pos).add(new THREE.Vector3(0, 1.5, 0));
  let t = 0;
  effects.push((dt) => {
    t += dt;
    blastLight.intensity = intensity * Math.max(0, 1 - t / duration) ** 2;
    return t < duration;
  });
}

function burst(pos, count, opts) {
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
    spawnParticle({
      pos: pos.clone().addScaledVector(dir, rand(opts.spread ?? 0.5)),
      vel: dir.multiplyScalar(rand(opts.speed * 0.4, opts.speed)),
      ...opts,
      life: rand(opts.life * 0.6, opts.life),
    });
  }
}

const flashEl = document.getElementById('flash');
function screenFlash(strength, duration) {
  let t = 0;
  effects.push((dt) => {
    t += dt;
    flashEl.style.opacity = String(strength * Math.max(0, 1 - t / duration) ** 1.5);
    return t < duration;
  });
}

let shake = 0;
const shakeOffset = new THREE.Vector3();

// ============================================================================
// Audio (synthesised, no assets)
// ============================================================================
let actx = null, master = null;
function ac() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createDynamicsCompressor();
    master.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function noise(dur, cutoff, vol, delay = 0) {
  const a = ac();
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const gn = a.createGain();
  gn.gain.value = vol;
  src.connect(f).connect(gn).connect(master);
  src.start(a.currentTime + delay);
}
function tone(f0, f1, dur, vol, type = 'sine', delay = 0) {
  const a = ac();
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const gn = a.createGain();
  gn.gain.setValueAtTime(vol, t0);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(gn).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}
const sfx = {
  hammer() { noise(0.09, 3200, 0.7); tone(220, 70, 0.12, 0.35, 'square'); },
  throw()  { tone(500, 250, 0.18, 0.12, 'triangle'); },
  bomb()   { noise(1.3, 900, 1.4); tone(95, 30, 0.9, 0.9); },
  whistle(dur) { tone(1500, 260, dur, 0.12, 'sine'); },
  nuke()   { noise(5, 450, 1.8); noise(1.8, 2600, 0.6); tone(70, 16, 4.5, 1.3); noise(3, 250, 1.2, 0.6); },
};

// ============================================================================
// Destruction core
// ============================================================================
const stats = { destroyed: 0 };
const destroyedEl = document.getElementById('destroyed');
const remainingEl = document.getElementById('remaining');
function updateStats() {
  destroyedEl.textContent = stats.destroyed.toLocaleString();
  remainingEl.textContent = voxCount.toLocaleString();
}

/**
 * Carve a ragged sphere out of the world at `center` (world coords).
 * opts: force (debris speed), debrisChance, scorch (radius multiplier), scorchStrength, chance (per-voxel removal probability)
 */
function explode(center, radius, opts) {
  const cx = center.x + OX, cy = center.y, cz = center.z + OZ;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(H - 1, Math.ceil(cy + radius));
  const z0 = Math.max(0, Math.floor(cz - radius)), z1 = Math.min(D - 1, Math.ceil(cz + radius));
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let removed = 0;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const k = idx(x, y, z);
        const mat = grid[k];
        if (!mat || mat === M.BEDROCK) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const r = radius * (0.82 + Math.random() * 0.3);
        if (dist > r) continue;
        if (opts.chance !== undefined && dist > 0.8 && Math.random() > opts.chance) continue;

        voxMesh.getColorAt(instOf[k], _c);
        cellCenter(k, p);
        removeVoxel(k);
        removed++;

        if (Math.random() < opts.debrisChance) {
          dir.set(dx, dy + 0.6, dz);
          if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
          dir.normalize();
          const speed = opts.force * (1.1 - (dist / radius) * 0.6) * rand(0.5, 1.2);
          if (opts.char) _c.lerp(_c2.setHex(0x1b1510), Math.random() * 0.6);
          spawnDebris(p, _c, dir.x * speed, dir.y * speed + rand(2, 5), dir.z * speed, rand(3, 6));
        }
      }
    }
  }

  if (opts.scorch) scorch(cx, cy, cz, radius * opts.scorch, opts.scorchStrength ?? 0.6);
  stats.destroyed += removed;
  checkCollapse();
  updateStats();
  return removed;
}

function scorch(cx, cy, cz, R, strength) {
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const z0 = Math.max(0, Math.floor(cz - R)), z1 = Math.min(D - 1, Math.ceil(cz + R));
  _c2.setHex(0x17120e);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const k = idx(x, y, z);
        if (!grid[k]) continue;
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
        if (dist > R) continue;
        const i = instOf[k];
        voxMesh.getColorAt(i, _c);
        _c.lerp(_c2, strength * (1 - dist / R) * rand(0.6, 1));
        voxMesh.setColorAt(i, _c);
      }
  voxDirty = true;
}

// Push existing loose debris away from a blast
function blastDebris(center, radius, force) {
  for (const d of debris) {
    const dx = d.x - center.x, dy = d.y - center.y, dz = d.z - center.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    if (dist > radius) continue;
    const f = force * (1 - dist / radius) / dist;
    d.vx += dx * f; d.vy += dy * f + force * 0.3; d.vz += dz * f;
  }
}

// ============================================================================
// Tools
// ============================================================================
let currentTool = 'hammer';

// --- Hammer (held in view) ---
const hammer = new THREE.Group();
{
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6, 0.07), new THREE.MeshLambertMaterial({ color: 0x8a5a2b }));
  handle.position.y = 0.3;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.14), new THREE.MeshLambertMaterial({ color: 0x9aa0a8 }));
  head.position.y = 0.62;
  const pivot = new THREE.Group();
  pivot.add(handle, head);
  pivot.rotation.z = 0.35;
  hammer.add(pivot);
  hammer.position.set(0.62, -0.58, -1.25);
  hammer.scale.setScalar(0.75);
  camera.add(hammer);
}
let swingT = 1;

function useHammer(hit) {
  if (!hit.cell) return;
  swingT = 0;
  sfx.hammer();
  const k = hit.cell;
  const p = cellCenter(k, new THREE.Vector3());
  const n = hit.normal;
  if (grid[k] === M.BEDROCK) {
    burst(p.clone().addScaledVector(n, 0.5), 6, { speed: 4, life: 0.4, s0: 0.05, s1: 0.1, color: 0xfff2a0, additive: true });
    return;
  }
  explode(p, TOOLS.hammer.radius, { force: 5, debrisChance: 1, chance: 0.35 });
  burst(p.clone().addScaledVector(n, 0.5), 8, { speed: 3, life: 0.9, s0: 0.15, s1: 0.5, color: 0xb9a68c, alpha: 0.6, spread: 0.3 });
  shake = Math.max(shake, 0.04);
}

// --- Bomb (thrown in an arc, explodes on impact) ---
const bombGeo = new THREE.SphereGeometry(0.4, 20, 14);
const bombMat = new THREE.MeshLambertMaterial({ color: 0x1c1c22 });
const fuseMat = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
const bombs = [];

function throwBomb(hit) {
  sfx.throw();
  const mesh = new THREE.Group();
  const body = new THREE.Mesh(bombGeo, bombMat);
  body.castShadow = true;
  const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), fuseMat);
  fuse.position.y = 0.45;
  mesh.add(body, fuse);

  const start = camera.position.clone()
    .add(new THREE.Vector3(0, -1.2, 0))
    .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 1.5);
  const target = hit.point.clone().addScaledVector(hit.normal, 0.3);
  const flight = THREE.MathUtils.clamp(start.distanceTo(target) / 24, 0.45, 2.2);
  const vel = target.clone().sub(start).divideScalar(flight);
  vel.y += 0.5 * GRAVITY * flight;
  mesh.position.copy(start);
  scene.add(mesh);
  bombs.push({ mesh, fuse, vel, t: 0, flight });
}

function updateBombs(dt) {
  const steps = 4, h = dt / steps;
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    b.t += dt;
    b.fuse.scale.setScalar(0.7 + Math.random() * 0.8);
    b.mesh.rotation.x += dt * 6;
    let boom = false;
    for (let s = 0; s < steps && !boom; s++) {
      b.vel.y -= GRAVITY * h;
      b.mesh.position.addScaledVector(b.vel, h);
      const p = b.mesh.position;
      const gx = Math.floor(p.x + OX), gy = Math.floor(p.y), gz = Math.floor(p.z + OZ);
      if (p.y < 0.2 || (inBounds(gx, gy, gz) && grid[idx(gx, gy, gz)]) || b.t > b.flight + 1.5) boom = true;
    }
    if (boom) {
      detonateBomb(b.mesh.position.clone());
      scene.remove(b.mesh);
      bombs.splice(i, 1);
    }
  }
}

function detonateBomb(pos) {
  const R = TOOLS.bomb.radius;
  sfx.bomb();
  explode(pos, R, { force: 16, debrisChance: 0.9, scorch: 1.5, scorchStrength: 0.55, char: true });
  blastDebris(pos, R * 2.5, 12);
  fireball(pos, R * 1.1, 0.9);
  flashLight(pos, 900, 0.6);
  burst(pos, 26, { speed: 9, life: 0.7, s0: 0.5, s1: 1.4, color: 0xffd060, color2: 0xff4010, additive: true, drag: 3 });
  burst(pos, 22, { speed: 5, life: 2.6, s0: 0.8, s1: 2.6, color: 0x4a4440, color2: 0x8a8580, alpha: 0.75, drag: 2, buoy: 2.5, spread: 1.5 });
  shake = Math.max(shake, 0.35);
}

// --- Nuke (missile drops from the sky) ---
const missiles = [];
function launchNuke(hit) {
  const target = hit.point.clone();
  const m = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xdfe3e8 });
  const finMat = new THREE.MeshLambertMaterial({ color: 0x3b3f2c });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3, 16), bodyMat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 16), finMat);
  nose.rotation.x = Math.PI;
  nose.position.y = -2.1;
  m.add(body, nose);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.7), finMat);
    fin.position.set(Math.cos(i * Math.PI / 2) * 0.6, 1.2, Math.sin(i * Math.PI / 2) * 0.6);
    fin.rotation.y = -i * Math.PI / 2;
    m.add(fin);
  }
  m.traverse((o) => { o.castShadow = true; });
  m.position.set(target.x, 80, target.z);
  scene.add(m);
  const speed = 70;
  sfx.whistle((80 - target.y) / speed);
  missiles.push({ mesh: m, target, speed });
}

function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.mesh.position.y -= m.speed * dt;
    m.mesh.rotation.y += dt * 4;
    if (m.mesh.position.y - 2.4 <= m.target.y) {
      scene.remove(m.mesh);
      missiles.splice(i, 1);
      detonateNuke(m.target);
    }
  }
}

function detonateNuke(pos) {
  const R = TOOLS.nuke.radius;
  sfx.nuke();
  screenFlash(1, 1.8);
  flashLight(pos, 15000, 1.8);
  shake = Math.max(shake, 1.6);
  explode(pos, R, { force: 38, debrisChance: 0.45, scorch: 1.7, scorchStrength: 0.9, char: true });
  blastDebris(pos, R * 3, 30);
  fireball(pos, R * 0.95, 2.6);
  shockwave(pos, R * 5, 2.2);
  burst(pos, 60, { speed: 20, life: 1.2, s0: 1, s1: 3, color: 0xfff0a0, color2: 0xff5010, additive: true, drag: 2.5, spread: 2 });
  mushroomCloud(pos);
}

function mushroomCloud(origin) {
  let t = 0;
  const acc = { stem: 0, cap: 0, dust: 0 };
  const DURATION = 3.6;
  effects.push((dt) => {
    t += dt;
    const stemTop = Math.min(t * 11, 24);
    const capR = Math.min(3 + t * 3, 11);

    acc.stem += dt * 45;
    while (acc.stem >= 1) {
      acc.stem--;
      spawnParticle({
        pos: new THREE.Vector3(origin.x + rand(-1.5, 1.5), origin.y + rand(stemTop), origin.z + rand(-1.5, 1.5)),
        vel: new THREE.Vector3(rand(-0.5, 0.5), rand(2, 5), rand(-0.5, 0.5)),
        life: rand(4, 6), s0: 1.6, s1: 3.2, color: 0xff9a40, color2: 0x5a524c, alpha: 0.8, drag: 0.6,
      });
    }
    acc.cap += dt * 85;
    while (acc.cap >= 1) {
      acc.cap--;
      const a = rand(Math.PI * 2), r = rand(capR * 0.3, capR);
      spawnParticle({
        pos: new THREE.Vector3(origin.x + Math.cos(a) * r, origin.y + stemTop + rand(-1.5, 3), origin.z + Math.sin(a) * r),
        vel: new THREE.Vector3(Math.cos(a) * 1.8, rand(0.5, 2.5), Math.sin(a) * 1.8),
        life: rand(5, 7.5), s0: 2.4, s1: 5.5, color: 0xffb050, color2: 0x4a4440, alpha: 0.85, drag: 0.5,
      });
    }
    if (t < 1.6) {
      acc.dust += dt * 70;
      while (acc.dust >= 1) {
        acc.dust--;
        const a = rand(Math.PI * 2), r = t * 22;
        spawnParticle({
          pos: new THREE.Vector3(origin.x + Math.cos(a) * r, rand(0.5, 2), origin.z + Math.sin(a) * r),
          vel: new THREE.Vector3(Math.cos(a) * 6, rand(1, 3), Math.sin(a) * 6),
          life: rand(2.5, 4), s0: 1.2, s1: 3.5, color: 0xa08a6a, color2: 0x7a736c, alpha: 0.6, drag: 1.2,
        });
      }
    }
    return t < DURATION;
  });
}

// ============================================================================
// Targeting (grid DDA raycast)
// ============================================================================
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerInside = false;

function raycastVoxels(origin, dir, maxDist = 400) {
  const o = { x: origin.x + OX, y: origin.y, z: origin.z + OZ };
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = dir.x > 0 ? 1 : -1, sy = dir.y > 0 ? 1 : -1, sz = dir.z > 0 ? 1 : -1;
  const tdx = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tdy = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tdz = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tmx = dir.x !== 0 ? (dir.x > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
  let tmy = dir.y !== 0 ? (dir.y > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
  let tmz = dir.z !== 0 ? (dir.z > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
  let t = 0, nx = 0, ny = 0, nz = 0;
  while (t < maxDist) {
    if (inBounds(x, y, z) && grid[idx(x, y, z)]) {
      return { cell: idx(x, y, z), t, normal: new THREE.Vector3(nx, ny, nz) };
    }
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz)         { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else                        { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    if (y < -1 && sy < 0) break;
  }
  return null;
}

function getTarget() {
  raycaster.setFromCamera(pointer, camera);
  const { origin, direction } = raycaster.ray;
  const hit = raycastVoxels(origin, direction);
  if (hit) {
    hit.point = origin.clone().addScaledVector(direction, hit.t);
    return hit;
  }
  if (direction.y < 0) {
    const t = -origin.y / direction.y;
    return { cell: null, t, normal: new THREE.Vector3(0, 1, 0), point: origin.clone().addScaledVector(direction, t) };
  }
  return null;
}

// Hover previews
const radiusPreview = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 16),
  new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.14, depthWrite: false })
);
const radiusWire = new THREE.Mesh(
  radiusPreview.geometry,
  new THREE.MeshBasicMaterial({ color: 0xff5a1f, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false })
);
radiusPreview.add(radiusWire);
radiusPreview.visible = false;
scene.add(radiusPreview);

const cellPreview = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
  new THREE.LineBasicMaterial({ color: 0xffffff })
);
cellPreview.visible = false;
scene.add(cellPreview);

function updatePreview() {
  radiusPreview.visible = cellPreview.visible = false;
  if (!pointerInside) return;
  const hit = getTarget();
  if (!hit) return;
  if (currentTool === 'hammer') {
    if (hit.cell === null) return;
    cellCenter(hit.cell, cellPreview.position);
    cellPreview.visible = true;
  } else {
    const color = currentTool === 'nuke' ? 0xc6ff3d : 0xff5a1f;
    radiusPreview.material.color.setHex(color);
    radiusWire.material.color.setHex(color);
    radiusPreview.position.copy(hit.point);
    radiusPreview.scale.setScalar(TOOLS[currentTool].radius);
    radiusPreview.visible = true;
  }
}

// ============================================================================
// Input
// ============================================================================
const canvas = renderer.domElement;
let down = null;

function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

canvas.addEventListener('pointermove', (e) => { setPointer(e); pointerInside = true; });
canvas.addEventListener('pointerleave', () => { pointerInside = false; });
canvas.addEventListener('pointerdown', (e) => {
  setPointer(e);
  down = { x: e.clientX, y: e.clientY, button: e.button, time: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const wasClick = down.button === 0 && moved < 6 && performance.now() - down.time < 600;
  down = null;
  if (!wasClick) return;
  setPointer(e);
  useTool();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function useTool() {
  const hit = getTarget();
  if (!hit) return;
  if (currentTool === 'hammer') useHammer(hit);
  else if (currentTool === 'bomb') throwBomb(hit);
  else if (currentTool === 'nuke') launchNuke(hit);
}

const toolButtons = document.querySelectorAll('.tool[data-tool]');
function selectTool(name) {
  currentTool = name;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  hammer.visible = name === 'hammer';
}
toolButtons.forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));
document.getElementById('reset').addEventListener('click', buildMap);

window.addEventListener('keydown', (e) => {
  if (e.key === '1') selectTool('hammer');
  else if (e.key === '2') selectTool('bomb');
  else if (e.key === '3') selectTool('nuke');
  else if (e.key === 'r' || e.key === 'R') buildMap();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// Main loop
// ============================================================================
buildMap();
selectTool('hammer');

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);

  camera.position.sub(shakeOffset);
  controls.update();
  shake = Math.max(0, shake - dt * 1.2);
  shakeOffset.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shake * shake);
  camera.position.add(shakeOffset);

  if (swingT < 1) {
    swingT = Math.min(1, swingT + dt / 0.22);
    hammer.rotation.x = -Math.sin(swingT * Math.PI) * 1.3;
  }

  updateBombs(dt);
  updateMissiles(dt);
  updateDebris(dt);
  updateParticles(dt);
  updateEffects(dt);
  updatePreview();

  if (voxDirty) {
    voxMesh.count = voxCount;
    voxMesh.instanceMatrix.needsUpdate = true;
    voxMesh.instanceColor.needsUpdate = true;
    voxDirty = false;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Small hook for automated testing / console fun
window.voxelGame = { selectTool, buildMap, getTarget, useTool, pointer, stats, get voxels() { return voxCount; } };
