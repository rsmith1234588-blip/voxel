import * as THREE from 'three';
import {
  H, CS, M,
  get, getBurn, set as setVoxel, addBurn, isLoaded, cellKey, colKey,
  dirtyUrgent, dirtyLoad, decodeSection, voxelColor, biomeAt,
  MeshBuilder, buildSectionGeometry, loadColumn, unloadColumn, getColumn,
  resetWorld as resetWorldData, spawnPoint,
} from './world.js';

const GRAVITY = 28;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const clamp = THREE.MathUtils.clamp;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

// ============================================================================
// Renderer, scenes, cameras
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.autoClear = false;
document.getElementById('app').appendChild(renderer.domElement);

const SKY = new THREE.Color(0x9cc4ea);
const scene = new THREE.Scene();
scene.background = SKY.clone();
const VIEW_CHUNKS = 9; // render distance in chunks
scene.fog = new THREE.Fog(SKY.clone(), VIEW_CHUNKS * CS * 0.45, VIEW_CHUNKS * CS * 0.95);

const FOV = 75;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';
scene.add(camera);

// Held-tool view model is drawn in its own pass so it never clips into walls
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(FOV, camera.aspect, 0.01, 10);
vmScene.add(new THREE.HemisphereLight(0xdde8ff, 0x554433, 1.4));
const vmSun = new THREE.DirectionalLight(0xffffff, 1.6);
vmSun.position.set(1, 2, 1);
vmScene.add(vmSun);

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a4a3a, 1.05));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
const SUN_OFFSET = new THREE.Vector3(70, 140, 45);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 10, far: 330 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const blastLight = new THREE.PointLight(0xffa040, 0, 0, 2);
scene.add(blastLight);
const laserLight = new THREE.PointLight(0xff3020, 0, 12, 2);
scene.add(laserLight);


// ============================================================================
// Chunk streaming & section meshes
// ============================================================================
const chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const sectionMeshes = new Map();
const activeColumns = new Set();

function rebuildSection(key) {
  const geo = buildSectionGeometry(key);
  let mesh = sectionMeshes.get(key);
  if (!geo) {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); sectionMeshes.delete(key); }
    return;
  }
  if (mesh) {
    mesh.geometry.dispose();
    mesh.geometry = geo;
  } else {
    mesh = new THREE.Mesh(geo, chunkMat);
    mesh.castShadow = mesh.receiveShadow = true;
    sectionMeshes.set(key, mesh);
    scene.add(mesh);
  }
}

const sectionColumnKey = (key) => { const { cx, cz } = decodeSection(key); return colKey(cx, cz); };

function flushSections(loadBudget) {
  for (const key of dirtyUrgent) if (activeColumns.has(sectionColumnKey(key))) rebuildSection(key);
  dirtyUrgent.clear();
  for (const key of dirtyLoad) {
    if (loadBudget-- <= 0) break;
    dirtyLoad.delete(key);
    if (activeColumns.has(sectionColumnKey(key))) rebuildSection(key);
  }
}

// Load columns around the player (nearest first) and drop the far ones
function streamChunks(genBudget) {
  const pcx = Math.floor(player.pos.x / CS), pcz = Math.floor(player.pos.z / CS);
  const R = VIEW_CHUNKS;
  const wanted = [];
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R) continue;
      const cx = pcx + dx, cz = pcz + dz;
      if (!activeColumns.has(colKey(cx, cz))) wanted.push([d2, cx, cz]);
    }
  wanted.sort((a, b) => a[0] - b[0]);
  for (const [d2, cx, cz] of wanted) {
    if (genBudget-- <= 0 && d2 > 4) break;
    loadColumn(cx, cz);
    activeColumns.add(colKey(cx, cz));
  }
  const drop = (R + 2) * (R + 2);
  for (const key of activeColumns) {
    const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
    const dx = cx - pcx, dz = cz - pcz;
    if (dx * dx + dz * dz <= drop) continue;
    activeColumns.delete(key);
    for (let cy = 0; cy < H / CS; cy++) {
      const sk = key * (H / CS) + cy;
      const mesh = sectionMeshes.get(sk);
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); sectionMeshes.delete(sk); }
    }
    unloadColumn(cx, cz);
  }
  return wanted.length;
}

// ============================================================================
// Audio (synthesised)
// ============================================================================
let actx = null, master = null;
function ac() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createDynamicsCompressor();
    const out = actx.createGain();
    out.gain.value = 0.8;
    master.connect(out).connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function noise(dur, cutoff, vol, delay = 0) {
  const a = ac();
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
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
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const gn = a.createGain();
  gn.gain.setValueAtTime(vol, t0);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(gn).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}
// Distance attenuation relative to the player
const vol = (pos, base) => base * clamp(1.3 - pos.distanceTo(camera.position) / 140, 0.15, 1);
let lastBoom = 0;
const sfx = {
  hammer() { noise(0.09, 3200, 0.7); tone(220, 70, 0.12, 0.35, 'square'); },
  whoosh() { noise(0.4, 1800, 0.35); },
  rocket() { noise(0.5, 1200, 0.6); tone(300, 90, 0.4, 0.2, 'sawtooth'); },
  boom(pos, size = 1) {
    const now = performance.now();
    if (now - lastBoom < 45) return;
    lastBoom = now;
    noise(0.9 + size * 0.5, 700 + 300 * size, vol(pos, 1.2 * size));
    tone(95, 28, 0.8, vol(pos, 0.8 * size));
  },
  thud(pos, size) { noise(0.5, 300, vol(pos, clamp(size, 0.2, 1.2))); },
  whistle(dur) { tone(1500, 260, dur, 0.12, 'sine'); },
  nuke(pos) { const v = vol(pos, 1.8); noise(5, 450, v); noise(1.8, 2600, v * 0.35); tone(70, 16, 4.5, v * 0.7); noise(3, 250, v * 0.7, 0.6); },
  hole() { tone(35, 140, 5, 0.5, 'sawtooth'); tone(70, 20, 5, 0.3); },
  implode() { tone(40, 900, 0.35, 0.4, 'sine'); noise(0.8, 1200, 0.9, 0.3); },
};
let laserOsc = null;
function laserSound(on) {
  if (on && !laserOsc) {
    const a = ac();
    const o = a.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 110;
    const lfo = a.createOscillator();
    lfo.frequency.value = 18;
    const lfoGain = a.createGain();
    lfoGain.gain.value = 25;
    lfo.connect(lfoGain).connect(o.frequency);
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const gn = a.createGain();
    gn.gain.value = 0.12;
    o.connect(f).connect(gn).connect(master);
    o.start(); lfo.start();
    laserOsc = { o, lfo, gn };
  } else if (!on && laserOsc) {
    const { o, lfo, gn } = laserOsc;
    gn.gain.setTargetAtTime(0, actx.currentTime, 0.03);
    o.stop(actx.currentTime + 0.15); lfo.stop(actx.currentTime + 0.15);
    laserOsc = null;
  }
}

// ============================================================================
// Debris (instanced loose cubes)
// ============================================================================
const MAX_DEBRIS = 6000;
const debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.88, 0.88, 0.88), new THREE.MeshLambertMaterial(), MAX_DEBRIS);
debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
debrisMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
debrisMesh.castShadow = true;
debrisMesh.frustumCulled = false;
debrisMesh.count = 0;
scene.add(debrisMesh);
const debris = [];

function spawnDebris(x, y, z, color, vx, vy, vz, life = rand(3, 6), spin = 1) {
  if (debris.length >= MAX_DEBRIS) {
    // Retire a random old piece so new explosions still look full
    debris[(Math.random() * debris.length) | 0].life = 0;
    return;
  }
  debris.push({
    x, y, z, vx, vy, vz,
    rx: rand(6.28), ry: rand(6.28), rz: rand(6.28),
    sx: rand(-8, 8) * spin, sy: rand(-8, 8) * spin, sz: rand(-8, 8) * spin,
    r: color.r, g: color.g, b: color.b,
    life,
  });
}

const _dummy = new THREE.Object3D();
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    if (d.life <= 0 || d.y < -20) { debris[i] = debris[debris.length - 1]; debris.pop(); continue; }

    let pulled = false;
    for (const hole of holes) {
      const dx = hole.pos.x - d.x, dy = hole.pos.y - d.y, dz = hole.pos.z - d.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      if (dist > hole.r * 2.4) continue;
      if (dist < 1.1) { d.life = 0; break; }
      pulled = true;
      const a = (90 / Math.max(dist, 1.5)) * dt;
      d.vx += (dx / dist) * a * 6 + (-dz / dist) * a * 2;
      d.vy += (dy / dist) * a * 6;
      d.vz += (dz / dist) * a * 6 + (dx / dist) * a * 2;
      const drag = Math.exp(-2.5 * dt);
      d.vx *= drag; d.vy *= drag; d.vz *= drag;
      d.life = Math.max(d.life, 1);
    }
    if (d.life <= 0) continue;
    if (!pulled) d.vy -= GRAVITY * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    d.rx += d.sx * dt; d.ry += d.sy * dt; d.rz += d.sz * dt;
    if (pulled) continue;

    let floor = -Infinity;
    const gy = Math.floor(d.y - 0.44);
    const m = get(Math.floor(d.x), gy, Math.floor(d.z));
    if (m && m !== M.WATER) floor = gy + 1;
    if (d.y - 0.44 < floor && d.vy < 0) {
      d.y = floor + 0.44;
      d.vy = Math.abs(d.vy) > 2 ? -d.vy * 0.3 : 0;
      d.vx *= 0.6; d.vz *= 0.6;
      d.sx *= 0.6; d.sy *= 0.6; d.sz *= 0.6;
    }
  }
  for (let i = 0; i < debris.length; i++) {
    const d = debris[i];
    _dummy.position.set(d.x, d.y, d.z);
    _dummy.rotation.set(d.rx, d.ry, d.rz);
    _dummy.scale.setScalar(Math.max(0.001, Math.min(1, d.life / 0.6)));
    _dummy.updateMatrix();
    debrisMesh.setMatrixAt(i, _dummy.matrix);
    debrisMesh.setColorAt(i, _c.setRGB(d.r, d.g, d.b));
  }
  debrisMesh.count = debris.length;
  debrisMesh.instanceMatrix.needsUpdate = true;
  debrisMesh.instanceColor.needsUpdate = true;
}

// ============================================================================
// Particles + timed effects
// ============================================================================
const MAX_PARTICLES = 900;
const particleGeo = new THREE.IcosahedronGeometry(1, 1);
const particles = [];
const particlePool = [];

function spawnParticle(o) {
  if (particles.length >= MAX_PARTICLES) return;
  let p = particlePool.pop();
  if (!p) p = { mesh: new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })), vel: new THREE.Vector3(), c0: new THREE.Color(), c1: new THREE.Color() };
  p.mesh.material.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  p.mesh.position.copy(o.pos);
  p.vel.copy(o.vel);
  p.life = 0; p.maxLife = o.life;
  p.s0 = o.s0; p.s1 = o.s1;
  p.c0.set(o.color); p.c1.set(o.color2 ?? o.color);
  p.alpha = o.alpha ?? 0.9;
  p.drag = o.drag ?? 1.5;
  p.buoy = o.buoy ?? 0;
  p.mesh.scale.setScalar(o.s0);
  p.mesh.material.opacity = 0;
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

function burst(pos, count, opts) {
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
    spawnParticle({
      ...opts,
      pos: pos.clone().addScaledVector(dir, rand(opts.spread ?? 0.5)),
      vel: dir.multiplyScalar(rand(opts.speed * 0.4, opts.speed)),
      life: rand(opts.life * 0.6, opts.life),
    });
  }
}

const effects = [];
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) if (!effects[i](dt)) effects.splice(i, 1);
}

const sphereGeo = new THREE.SphereGeometry(1, 32, 16);
function fireball(pos, size, duration) {
  const mesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, depthWrite: false }));
  mesh.position.copy(pos);
  mesh.scale.setScalar(0.01);
  scene.add(mesh);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    const k = t / duration;
    if (k >= 1) { scene.remove(mesh); mesh.material.dispose(); return false; }
    mesh.scale.setScalar(size * (1 - Math.pow(1 - Math.min(1, k * 3), 3)) + 0.01);
    mesh.material.color.setHex(0xffe08a).lerp(_c2.setHex(0xd23a12), Math.min(1, k * 1.5));
    mesh.material.opacity = 1 - k * k;
    return true;
  });
}

function shockwave(pos, maxRadius, duration, color = 0xfff6e0) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 96),
    new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(pos);
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

let blastLightLevel = 0;
function flashLight(pos, intensity, duration) {
  blastLight.position.copy(pos).y += 1.5;
  let t = 0;
  effects.push((dt) => {
    t += dt;
    blastLightLevel = Math.max(blastLightLevel, intensity * Math.max(0, 1 - t / duration) ** 2);
    return t < duration;
  });
}

const flashEl = document.getElementById('flash');
let flashLevel = 0;
function screenFlash(strength, duration) {
  let t = 0;
  effects.push((dt) => {
    t += dt;
    flashLevel = Math.max(flashLevel, strength * Math.max(0, 1 - t / duration) ** 1.5);
    return t < duration;
  });
}

let shake = 0;
function addShake(pos, amount, range) {
  const d = pos.distanceTo(camera.position);
  shake = Math.max(shake, amount * clamp(1 - d / range, 0, 1));
}

// ============================================================================
// Destruction core
// ============================================================================
const stats = { destroyed: 0 };
const destroyedEl = document.getElementById('destroyed');
const biomeEl = document.getElementById('biome');
const coordsEl = document.getElementById('coords');
let statsDirty = true;
function updateStats() {
  destroyedEl.textContent = stats.destroyed.toLocaleString();

}

// Removed cells are remembered so the collapse check only looks near the damage
let touched = [];
function removeCell(x, y, z) {
  if (!get(x, y, z)) return;
  setVoxel(x, y, z, 0);
  touched.push(x, y, z);
  stats.destroyed++;
  statsDirty = true;
}

const tntQueue = [];
let collapsePending = false;

/**
 * Carve a ragged sphere out of the world.
 * opts: force, debrisChance, chance, scorch (radius multiplier), scorchStrength, char
 */
function explode(center, radius, opts = {}) {
  const { force = 10, debrisChance = 0.5, chance, scorch, scorchStrength = 0.6, char = false } = opts;
  const cx = center.x, cy = center.y, cz = center.z;
  const x0 = Math.floor(cx - radius), x1 = Math.ceil(cx + radius);
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(H - 1, Math.ceil(cy + radius));
  const z0 = Math.floor(cz - radius), z1 = Math.ceil(cz + radius);
  let removed = 0;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const mat = get(x, y, z);
        if (!mat || mat === M.BEDROCK) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius * (0.82 + Math.random() * 0.3)) continue;
        if (chance !== undefined && dist > 0.8 && Math.random() > chance) continue;

        if (mat === M.TNT) tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.12, 0.4) });
        const wasBurn = getBurn(x, y, z);
        removeCell(x, y, z);
        removed++;
        if (mat === M.WATER) continue;

        if (Math.random() < debrisChance) {
          _v.set(dx, dy + 0.6, dz);
          if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
          _v.normalize();
          const speed = force * (1.1 - (dist / radius) * 0.6) * rand(0.5, 1.2);
          voxelColor(x, y, z, mat, wasBurn, _c);
          if (char) _c.lerp(_c2.setHex(0x1b1510), Math.random() * 0.5);
          spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, _v.x * speed, _v.y * speed + rand(2, 5), _v.z * speed);
        }
      }
    }
  }

  if (scorch) scorchArea(cx, cy, cz, radius * scorch, scorchStrength);
  if (removed) collapsePending = true;
  return removed;
}

function scorchArea(cx, cy, cz, R, strength) {
  const x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R);
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const m = get(x, y, z);
        if (!m || m === M.WATER) continue;
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
        if (dist > R) continue;
        addBurn(x, y, z, Math.round(255 * strength * (1 - dist / R) * rand(0.85, 1)));
      }
}

function blastImpulse(center, radius, force) {
  for (const d of debris) {
    const dx = d.x - center.x, dy = d.y - center.y, dz = d.z - center.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    if (dist > radius) continue;
    const f = (force * (1 - dist / radius)) / dist;
    d.vx += dx * f; d.vy += dy * f + force * 0.3; d.vz += dz * f;
  }
  // Knock the player around too
  _v.copy(player.pos);
  _v.y += 0.9;
  _v.sub(center);
  const pd = _v.length() + 0.01;
  if (pd < radius) {
    const f = force * (1 - pd / radius);
    player.vel.addScaledVector(_v.divideScalar(pd), f);
    player.vel.y += f * 0.4;
  }
}

function processTNT(dt) {
  let fired = 0;
  for (let i = tntQueue.length - 1; i >= 0 && fired < 10; i--) {
    const t = tntQueue[i];
    t.t -= dt;
    if (t.t > 0) continue;
    tntQueue.splice(i, 1);
    fired++;
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    explode(pos, 3.4, { force: 15, debrisChance: 0.6, scorch: 1.5, scorchStrength: 0.5, char: true });
    blastFX(pos, 3.4, 0.7);
  }
}

// ============================================================================
// Structural collapse: unsupported pieces fall as rigid bodies
// ============================================================================
const bodies = [];
const bodyBuilder = new MeshBuilder();
let collapseTimer = 0;
const FLOOD_LIMIT = 40000;
const NEIGHBORS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// Starting next to recently removed cells, flood-fill each solid piece. Pieces that
// reach bedrock, unloaded terrain or grow huge are supported; the rest fall.
function runCollapse() {
  const seeds = touched;
  touched = [];
  const supported = new Set();
  const checked = new Set();
  for (let i = 0; i < seeds.length; i += 3) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const x = seeds[i] + dx, y = seeds[i + 1] + dy, z = seeds[i + 2] + dz;
      if (y <= 0 || !get(x, y, z)) continue;
      const k = cellKey(x, y, z);
      if (checked.has(k) || supported.has(k)) continue;
      const piece = flood(x, y, z, supported);
      for (const c of piece.keys) checked.add(c);
      if (piece.supported) for (const c of piece.keys) supported.add(c);
      else detachComponent(piece.cells);
    }
  }
}

function flood(sx, sy, sz, supported) {
  // Depth-first with "down" explored first, so grounded pieces finish fast
  const stack = [sx, sy, sz];
  const seen = new Set([cellKey(sx, sy, sz)]);
  const cells = [];
  let ok = false;
  while (stack.length) {
    const z = stack.pop(), y = stack.pop(), x = stack.pop();
    cells.push(x, y, z);
    if (y <= 0 || seen.size > FLOOD_LIMIT) { ok = true; break; }
    for (let n = NEIGHBORS.length - 1; n >= 0; n--) {
      const [dx, dy, dz] = NEIGHBORS[n];
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ny < 0 || ny >= H) continue;
      if (!isLoaded(nx, nz)) { ok = true; break; }
      if (!get(nx, ny, nz)) continue;
      const k = cellKey(nx, ny, nz);
      if (seen.has(k)) continue;
      if (supported.has(k)) { ok = true; break; }
      seen.add(k);
      stack.push(nx, ny, nz);
    }
    if (ok) break;
  }
  return { supported: ok, keys: seen, cells };
}

function detachComponent(cells) {
  const vox = [];
  for (let i = 0; i < cells.length; i += 3) {
    const x = cells[i], y = cells[i + 1], z = cells[i + 2];
    const m = get(x, y, z);
    if (!m) continue;
    if (m !== M.WATER) vox.push({ x, y, z, m, b: getBurn(x, y, z) });
    setVoxel(x, y, z, 0);
  }
  statsDirty = true;
  // Tiny bits (and stray water) just become debris
  if (vox.length <= 3) {
    for (const v of vox) {
      voxelColor(v.x, v.y, v.z, v.m, v.b, _c);
      spawnDebris(v.x + 0.5, v.y + 0.5, v.z + 0.5, _c, rand(-1, 1), 0, rand(-1, 1));
    }
    stats.destroyed += vox.length;
    return;
  }

  const setK = new Set();
  for (const v of vox) setK.add(cellKey(v.x, v.y, v.z));
  const occ = (x, y, z) => y >= 0 && y < H && setK.has(cellKey(x, y, z));
  bodyBuilder.reset();
  for (const v of vox) bodyBuilder.emit(v.x, v.y, v.z, v.m, v.b, occ);
  const mesh = new THREE.Mesh(bodyBuilder.toGeometry(), chunkMat);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  const bottoms = vox.filter((v) => !occ(v.x, v.y - 1, v.z));
  bodies.push({ vox, bottoms, mesh, drop: 0, vy: 0, k: 0 });
}

function blocksBody(x, y, z) {
  if (y < 0) return true;
  if (!isLoaded(x, z)) return true;
  const m = get(x, y, z);
  return m !== 0 && m !== M.WATER;
}

function updateBodies(dt) {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    b.vy = Math.min(b.vy + GRAVITY * dt, 45);
    b.drop += b.vy * dt;
    const target = Math.floor(b.drop);
    let landAt = -1;
    for (let k = b.k + 1; k <= target && landAt < 0; k++) {
      for (const v of b.bottoms) {
        if (blocksBody(v.x, v.y - k, v.z)) { landAt = k - 1; break; }
      }
    }
    if (landAt < 0) {
      b.k = target;
      b.mesh.position.y = -b.drop;
      continue;
    }
    landBody(b, landAt);
    bodies.splice(i, 1);
  }
}

function landBody(b, k) {
  scene.remove(b.mesh);
  b.mesh.geometry.dispose();
  const speed = b.vy;
  const shatter = clamp((speed - 9) / 28, 0, 0.65);
  let placed = 0;
  const center = new THREE.Vector3();
  for (const v of b.vox) {
    const y = v.y - k;
    center.x += v.x; center.y += y; center.z += v.z;
    if (Math.random() < shatter || y >= H || blocksBody(v.x, y, v.z)) {
      voxelColor(v.x, v.y, v.z, v.m, v.b, _c);
      spawnDebris(v.x + 0.5, y + 0.5, v.z + 0.5, _c, rand(-4, 4) * shatter, rand(1, 7) * shatter, rand(-4, 4) * shatter);
      stats.destroyed++;
      continue;
    }
    if (v.m === M.TNT && speed > 18 && Math.random() < 0.3) tntQueue.push({ x: v.x + 0.5, y: y + 0.5, z: v.z + 0.5, t: rand(0.05, 0.3) });
    setVoxel(v.x, y, v.z, v.m, v.b);
    placed++;
  }
  statsDirty = true;
  center.divideScalar(b.vox.length);
  const size = Math.sqrt(b.vox.length) / 10;
  if (speed > 6) {
    sfx.thud(center, size * (speed / 25));
    addShake(center, Math.min(0.6, size * 0.2 * (speed / 20)), 60);
    let n = 0;
    for (const v of b.bottoms) {
      if (n++ > 30) break;
      if (Math.random() > 0.5) continue;
      spawnParticle({
        pos: new THREE.Vector3(v.x + 0.5, v.y - k, v.z + 0.5),
        vel: new THREE.Vector3(rand(-3, 3), rand(0.5, 2.5), rand(-3, 3)),
        life: rand(1.2, 2.2), s0: 0.5, s1: 2, color: 0xa89a86, color2: 0x8a847c, alpha: 0.55, drag: 2,
      });
    }
  }
  if (shatter > 0) { for (const v of b.vox) touched.push(v.x, v.y - k, v.z); collapsePending = true; }
}

// ============================================================================
// Player (first person)
// ============================================================================
const player = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false, fly: false, inWater: false, headInWater: false,
};
const PW = 0.3, PH = 1.8, EYE = 1.62;
let stepSmooth = 0;

function solidForPlayer(x, y, z) {
  if (y < 0) return true;
  if (y >= H) return false;
  if (!isLoaded(x, z)) return true; // don't fall into terrain that hasn't streamed in yet
  const m = get(x, y, z);
  return m !== 0 && m !== M.WATER;
}

function collides(px, py, pz) {
  const x0 = Math.floor(px - PW), x1 = Math.floor(px + PW);
  const y0 = Math.floor(py), y1 = Math.floor(py + PH);
  const z0 = Math.floor(pz - PW), z1 = Math.floor(pz + PW);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) if (solidForPlayer(x, y, z)) return true;
  return false;
}

function moveAxis(axis, delta) {
  const p = player.pos;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.4));
  const sd = delta / steps;
  for (let s = 0; s < steps; s++) {
    p[axis] += sd;
    if (!collides(p.x, p.y, p.z)) continue;
    if (axis === 'y') {
      if (sd < 0) { p.y = Math.floor(p.y) + 1; player.onGround = true; }
      else p.y = Math.floor(p.y + PH) - PH - 1e-3;
      player.vel.y = 0;
    } else if (sd > 0) {
      p[axis] = Math.floor(p[axis] + PW) - PW - 1e-3;
    } else {
      p[axis] = Math.floor(p[axis] - PW) + 1 + PW + 1e-3;
    }
    return false;
  }
  return true;
}

function moveHorizontal(axis, delta) {
  if (delta === 0) return;
  const p = player.pos;
  const saved = p.clone();
  if (moveAxis(axis, delta)) return;
  // Auto step up one block
  if ((player.onGround || player.inWater) && !player.fly) {
    const blocked = p.clone();
    p.copy(saved);
    p.y += 1.01;
    if (!collides(p.x, p.y, p.z) && moveAxis(axis, delta)) { stepSmooth -= 1.01; return; }
    p.copy(blocked);
  }
  player.vel[axis] = 0;
}

const keys = new Set();
const cellAt = (x, y, z) => get(Math.floor(x), Math.floor(y), Math.floor(z));

function updatePlayer(dt) {
  const p = player.pos;
  // Unstick if something landed on us
  let guard = 0;
  while (collides(p.x, p.y, p.z) && guard++ < H) p.y = Math.floor(p.y) + 1;

  player.inWater = cellAt(p.x, p.y + 0.5, p.z) === M.WATER;
  player.headInWater = cellAt(p.x, p.y + EYE, p.z) === M.WATER;

  const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  let wx = -sin * fwd + cos * strafe, wz = -cos * fwd - sin * strafe;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx /= len; wz /= len; }

  let speed = player.fly ? (sprint ? 45 : 20) : sprint ? 10 : 6;
  if (player.inWater && !player.fly) speed *= 0.55;
  const grip = player.fly || player.onGround ? 12 : player.inWater ? 4 : 2.2;
  const blend = 1 - Math.exp(-grip * dt);
  player.vel.x += (wx * speed - player.vel.x) * blend;
  player.vel.z += (wz * speed - player.vel.z) * blend;

  const jump = keys.has('Space');
  if (player.fly) {
    const up = (jump ? 1 : 0) - (keys.has('KeyC') || keys.has('ControlLeft') ? 1 : 0);
    player.vel.y += (up * speed - player.vel.y) * blend;
  } else if (player.inWater) {
    player.vel.y -= 9 * dt;
    if (jump) player.vel.y = Math.min(player.vel.y + 30 * dt, 4.5);
    player.vel.y = Math.max(player.vel.y, -3.5);
  } else {
    player.vel.y -= GRAVITY * dt;
    if (jump && player.onGround) player.vel.y = 9;
    player.vel.y = Math.max(player.vel.y, -55);
  }

  moveHorizontal('x', player.vel.x * dt);
  moveHorizontal('z', player.vel.z * dt);
  player.onGround = false;
  moveAxis('y', player.vel.y * dt);
  if (!player.onGround && !player.fly && player.vel.y <= 0 && collides(p.x, p.y - 0.02, p.z)) player.onGround = true;

  stepSmooth *= Math.exp(-14 * dt);
}

// ============================================================================
// Aiming (grid DDA raycast)
// ============================================================================
function raycast(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = dir.x > 0 ? 1 : -1, sy = dir.y > 0 ? 1 : -1, sz = dir.z > 0 ? 1 : -1;
  const tdx = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tdy = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tdz = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tmx = dir.x !== 0 ? (dir.x > 0 ? x + 1 - origin.x : origin.x - x) * tdx : Infinity;
  let tmy = dir.y !== 0 ? (dir.y > 0 ? y + 1 - origin.y : origin.y - y) * tdy : Infinity;
  let tmz = dir.z !== 0 ? (dir.z > 0 ? z + 1 - origin.z : origin.z - z) * tdz : Infinity;
  let t = 0;
  const normal = new THREE.Vector3();
  while (t <= maxDist) {
    if (get(x, y, z)) {
      return { x, y, z, cell: 1, t, normal, point: origin.clone().addScaledVector(dir, t) };
    }
    if ((y < 0 && sy < 0) || (y >= H && sy > 0)) break;
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; normal.set(-sx, 0, 0); }
    else if (tmy < tmz)         { y += sy; t = tmy; tmy += tdy; normal.set(0, -sy, 0); }
    else                        { z += sz; t = tmz; tmz += tdz; normal.set(0, 0, -sz); }
  }
  return null;
}

const aimDir = new THREE.Vector3();
function aim(maxDist) {
  camera.getWorldDirection(aimDir);
  return raycast(camera.position, aimDir, maxDist);
}

function muzzleWorld(out) {
  return camera.localToWorld(out.set(0.32, -0.22, -0.9));
}

// ============================================================================
// View models (held tools)
// ============================================================================
const lam = (color) => new THREE.MeshLambertMaterial({ color });
const basic = (color) => new THREE.MeshBasicMaterial({ color });
function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function cyl(r, h, mat, x = 0, y = 0, z = 0, axis = 'z') {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}
function ball(r, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat); m.position.set(x, y, z); return m; }

const viewModels = {};
{
  const g = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.add(box(0.05, 0.45, 0.05, lam(0x8a5a2b), 0, 0.22, 0), box(0.24, 0.11, 0.11, lam(0x9aa0a8), 0, 0.46, 0));
  pivot.rotation.z = 0.3;
  g.add(pivot);
  g.position.set(0.32, -0.42, -0.62);
  viewModels.hammer = g;
}
{
  const g = new THREE.Group();
  g.add(box(0.1, 0.12, 0.42, lam(0x3a3f47)), cyl(0.035, 0.28, lam(0x9aa4ae), 0, 0.01, -0.3), box(0.05, 0.14, 0.06, lam(0x2a2d33), 0, -0.1, 0.1));
  g.add(ball(0.04, basic(0xff3322), 0, 0.01, -0.45), box(0.11, 0.02, 0.3, basic(0xff3322), 0, 0.07, 0));
  g.position.set(0.3, -0.26, -0.55);
  viewModels.laser = g;
}
{
  const g = new THREE.Group();
  g.add(cyl(0.08, 0.85, lam(0x556b2f), 0, 0, -0.1), cyl(0.09, 0.08, lam(0x333333), 0, 0, -0.52), box(0.05, 0.15, 0.07, lam(0x333333), 0, -0.12, 0.05));
  const war = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 12), lam(0xcc3322));
  war.rotation.x = -Math.PI / 2;
  war.position.z = -0.6;
  g.add(war);
  g.position.set(0.3, -0.25, -0.5);
  viewModels.rocket = g;
}
{
  const g = new THREE.Group();
  g.add(ball(0.13, lam(0x1c1c22)), cyl(0.02, 0.06, lam(0x777777), 0, 0.14, 0, 'y'), ball(0.025, basic(0xffaa33), 0, 0.18, 0));
  g.position.set(0.28, -0.25, -0.5);
  viewModels.bomb = g;
}
{
  const g = new THREE.Group();
  g.add(ball(0.12, lam(0x8a6d1c)));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add(ball(0.045, lam(0x2b2b2b), Math.cos(a) * 0.12, ((i % 2) - 0.5) * 0.1, Math.sin(a) * 0.12));
  }
  g.add(ball(0.025, basic(0xffaa33), 0, 0.14, 0));
  g.position.set(0.28, -0.25, -0.5);
  viewModels.cluster = g;
}
{
  const g = new THREE.Group();
  g.add(ball(0.09, basic(0x080010)));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.015, 8, 40), basic(0xb070ff));
  ring.rotation.x = 1.2;
  g.add(ring);
  g.userData.ring = ring;
  g.scale.setScalar(0.7);
  g.position.set(0.28, -0.24, -0.5);
  viewModels.blackhole = g;
}
{
  const g = new THREE.Group();
  g.add(box(0.12, 0.2, 0.05, lam(0x2f3338)), cyl(0.008, 0.18, lam(0x999999), 0.04, 0.18, 0, 'y'), ball(0.015, basic(0xff2222), 0.04, 0.27, 0));
  const btn = cyl(0.035, 0.02, basic(0xff1a1a), 0, 0.02, 0.03);
  g.add(btn, box(0.08, 0.03, 0.01, basic(0xc6ff3d), 0, -0.06, 0.026));
  g.userData.btn = btn;
  g.rotation.set(0.5, -0.3, 0);
  g.position.set(0.25, -0.24, -0.45);
  viewModels.nuke = g;
}
for (const k in viewModels) { viewModels[k].userData.base = viewModels[k].position.clone(); vmScene.add(viewModels[k]); }

// ============================================================================
// Tools
// ============================================================================
const TOOL_ORDER = ['hammer', 'laser', 'rocket', 'bomb', 'cluster', 'blackhole', 'nuke'];
const TOOL_ICONS = ['🔨', '⚡', '🚀', '💣', '🎆', '🕳️', '☢️'];
const TOOLS = {
  hammer:    { name: 'Hammer',       desc: 'Smash blocks up close',               cooldown: 0.22 },
  laser:     { name: 'Laser',        desc: 'Hold to burn through anything',       cooldown: 0 },
  rocket:    { name: 'Rocket',       desc: 'Fast straight shot, big boom',        cooldown: 0.55 },
  bomb:      { name: 'Bomb',         desc: 'Throw it, explodes on impact',        cooldown: 0.45 },
  cluster:   { name: 'Cluster Bomb', desc: 'Splits into a ring of bomblets',      cooldown: 0.8 },
  blackhole: { name: 'Black Hole',   desc: 'Swallows everything nearby',          cooldown: 1.5 },
  nuke:      { name: 'NUKE',         desc: 'Calls in a missile at the crosshair', cooldown: 2.5 },
};
let currentTool = 'hammer';
let cooldown = 0;
let firing = false;
let swing = 1, recoil = 0;

function fire() {
  if (cooldown > 0) return;
  cooldown = TOOLS[currentTool].cooldown;
  switch (currentTool) {
    case 'hammer': useHammer(); break;
    case 'rocket': fireRocket(); break;
    case 'bomb': throwProjectile('bomb'); break;
    case 'cluster': throwProjectile('cluster'); break;
    case 'blackhole': throwProjectile('blackhole'); break;
    case 'nuke': callNuke(); break;
  }
}

// ---------- Hammer ----------
function useHammer() {
  swing = 0;
  const hit = aim(5.5);
  if (!hit || hit.cell < 0) return;
  sfx.hammer();
  const center = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  const face = hit.point.clone().addScaledVector(hit.normal, 0.05);
  if (get(hit.x, hit.y, hit.z) === M.BEDROCK) {
    burst(face, 6, { speed: 4, life: 0.4, s0: 0.04, s1: 0.08, color: 0xfff2a0, additive: true });
    return;
  }
  explode(center, 1.25, { force: 5, debrisChance: 1, chance: 0.35 });
  burst(face, 7, { speed: 3, life: 0.9, s0: 0.12, s1: 0.45, color: 0xb9a68c, alpha: 0.6, spread: 0.3 });
  shake = Math.max(shake, 0.05);
}

// ---------- Laser ----------
const beamOuter = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 10, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
);
const beamInner = new THREE.Mesh(
  beamOuter.geometry,
  new THREE.MeshBasicMaterial({ color: 0xfff0e0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
);
const beam = new THREE.Group();
beam.add(beamOuter, beamInner);
beam.visible = false;
scene.add(beam);
let laserTick = 0;

function updateLaser(dt) {
  const active = firing && currentTool === 'laser';
  laserSound(active);
  if (!active) { beam.visible = false; laserLight.intensity = 0; return; }
  const hit = aim(180);
  const start = muzzleWorld(new THREE.Vector3());
  const end = hit ? hit.point : camera.position.clone().addScaledVector(aimDir, 180);
  const len = start.distanceTo(end);
  beam.visible = true;
  beam.position.copy(start).lerp(end, 0.5);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(end).sub(start).normalize());
  const flicker = 0.8 + Math.random() * 0.4;
  beamOuter.scale.set(0.07 * flicker, len, 0.07 * flicker);
  beamInner.scale.set(0.025, len, 0.025);
  recoil = Math.max(recoil, 0.15 * Math.random());

  if (!hit) { laserLight.intensity = 0; return; }
  laserLight.position.copy(hit.point).addScaledVector(hit.normal, 0.5);
  laserLight.intensity = 25 * flicker;
  laserTick -= dt;
  while (laserTick <= 0) {
    laserTick += 0.035;
    if (hit.cell >= 0) {
      const p = hit.point.clone().addScaledVector(aimDir, 0.35);
      explode(p, 1.3, { force: 3, debrisChance: 0.25, scorch: 1.8, scorchStrength: 0.4 });
    }
    spawnParticle({
      pos: hit.point.clone().addScaledVector(hit.normal, 0.1),
      vel: hit.normal.clone().multiplyScalar(rand(3, 7)).add(new THREE.Vector3(rand(-3, 3), rand(0, 4), rand(-3, 3))),
      life: rand(0.2, 0.45), s0: 0.06, s1: 0.02, color: 0xffd080, color2: 0xff4010, additive: true, drag: 1,
    });
    if (Math.random() < 0.3) spawnParticle({
      pos: hit.point.clone(), vel: new THREE.Vector3(rand(-0.5, 0.5), rand(1.5, 3), rand(-0.5, 0.5)),
      life: rand(1, 1.8), s0: 0.2, s1: 0.8, color: 0x555050, color2: 0x8a8580, alpha: 0.5, drag: 1,
    });
  }
}

// ---------- Projectiles: rocket, bomb, cluster, bomblet, black hole ----------
const projectiles = [];
const projGeo = {
  bomb: new THREE.SphereGeometry(0.35, 16, 12),
  bomblet: new THREE.SphereGeometry(0.2, 10, 8),
  rocket: new THREE.CylinderGeometry(0.12, 0.12, 0.9, 10),
  hole: new THREE.SphereGeometry(0.35, 16, 12),
};
const projMat = {
  bomb: lam(0x1c1c22), cluster: lam(0x8a6d1c), bomblet: lam(0x2b2b2b), rocket: lam(0x556b2f), hole: basic(0x080010),
};

function makeProjectile(kind, pos, vel) {
  let mesh;
  if (kind === 'rocket') {
    mesh = new THREE.Mesh(projGeo.rocket, projMat.rocket);
    mesh.add(ball(0.16, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, blending: THREE.AdditiveBlending }), 0, -0.55, 0));
  } else if (kind === 'blackhole') {
    mesh = new THREE.Mesh(projGeo.hole, projMat.hole);
    mesh.add(new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 32), basic(0xb070ff)));
  } else {
    mesh = new THREE.Mesh(kind === 'bomblet' ? projGeo.bomblet : projGeo.bomb, projMat[kind] || projMat.bomb);
  }
  mesh.castShadow = true;
  mesh.position.copy(pos);
  scene.add(mesh);
  projectiles.push({ kind, mesh, vel, life: 0, trail: 0 });
}

function fireRocket() {
  recoil = 1;
  sfx.rocket();
  const start = muzzleWorld(new THREE.Vector3());
  // Fly from the muzzle towards whatever the crosshair points at
  const hit = aim(250);
  const target = hit ? hit.point : camera.position.clone().addScaledVector(aimDir, 250);
  const dir = target.sub(start).normalize();
  makeProjectile('rocket', start, dir.multiplyScalar(65));
}

function throwProjectile(kind) {
  recoil = 0.6;
  sfx.whoosh();
  camera.getWorldDirection(aimDir);
  const start = camera.position.clone().addScaledVector(aimDir, 0.6);
  start.y -= 0.15;
  let vel;
  if (kind === 'blackhole') vel = aimDir.clone().multiplyScalar(16);
  else vel = aimDir.clone().multiplyScalar(kind === 'cluster' ? 19 : 22).add(_v.set(0, 4, 0)).addScaledVector(player.vel, 0.5);
  makeProjectile(kind, start, vel);
}

function cellSolid(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  if (y < 0) return true;
  const m = get(x, y, z);
  return m !== 0 && m !== M.WATER;
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life += dt;
    const grav = p.kind === 'rocket' || p.kind === 'blackhole' ? 0 : GRAVITY;
    const travel = p.vel.length() * dt;
    const steps = Math.max(1, Math.ceil(travel / 0.3));
    const h = dt / steps;
    let hit = false;
    const prev = p.mesh.position.clone();
    for (let s = 0; s < steps && !hit; s++) {
      p.vel.y -= grav * h;
      prev.copy(p.mesh.position);
      p.mesh.position.addScaledVector(p.vel, h);
      if (cellSolid(p.mesh.position)) hit = true;
    }
    const pos = p.mesh.position;

    if (p.kind === 'rocket') {
      p.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(p.vel).normalize());
      p.mesh.children[0].scale.setScalar(0.7 + Math.random() * 0.6);
      p.trail -= dt;
      while (p.trail <= 0) {
        p.trail += 0.012;
        spawnParticle({
          pos: pos.clone().addScaledVector(_v.copy(p.vel).normalize(), -0.6),
          vel: new THREE.Vector3(rand(-0.4, 0.4), rand(0.2, 0.8), rand(-0.4, 0.4)),
          life: rand(0.8, 1.6), s0: 0.18, s1: 0.9, color: 0xffc070, color2: 0x9a9590, alpha: 0.55, drag: 1,
        });
      }
    } else if (p.kind === 'blackhole') {
      p.mesh.children[0].rotation.x += dt * 4;
      p.mesh.children[0].rotation.y += dt * 3;
    } else {
      p.mesh.rotation.x += dt * 5;
      p.mesh.rotation.z += dt * 3;
    }

    const expired = p.life > (p.kind === 'blackhole' ? 1.1 : 6) || pos.y < -5 || pos.distanceTo(camera.position) > 400;
    if (!hit && !expired) continue;

    scene.remove(p.mesh);
    projectiles.splice(i, 1);
    const at = hit ? prev : pos.clone();
    switch (p.kind) {
      case 'rocket': detonate(at, 4.2, 18, 1); break;
      case 'bomb': detonate(at, 4.6, 18, 1.1); break;
      case 'bomblet': detonate(at, 2.8, 12, 0.6); break;
      case 'cluster': {
        detonate(at, 2.2, 10, 0.5);
        for (let j = 0; j < 10; j++) {
          const a = (j / 10) * Math.PI * 2 + rand(-0.2, 0.2), r = rand(4, 9);
          makeProjectile('bomblet', at.clone().add(_v.set(0, 1.2, 0)), new THREE.Vector3(Math.cos(a) * r, rand(8, 13), Math.sin(a) * r));
        }
        break;
      }
      case 'blackhole': spawnBlackHole(at); break;
    }
  }
}

function blastFX(pos, R, size) {
  fireball(pos, R * 1.1, 0.5 + size * 0.4);
  flashLight(pos, 700 * size * size + 200, 0.6);
  burst(pos, Math.round(14 + 14 * size), { speed: 9 * size, life: 0.7, s0: 0.4 * size, s1: 1.4 * size, color: 0xffd060, color2: 0xff4010, additive: true, drag: 3 });
  burst(pos, Math.round(10 + 14 * size), { speed: 5, life: 2.6, s0: 0.8 * size, s1: 2.6 * size, color: 0x4a4440, color2: 0x8a8580, alpha: 0.7, drag: 2, buoy: 2.5, spread: 1.5 });
  sfx.boom(pos, size);
  addShake(pos, 0.45 * size, 45);
  blastImpulse(pos, R * 2.5, 12 * size);
}

function detonate(pos, R, force, size) {
  explode(pos, R, { force, debrisChance: 0.85, scorch: 1.5, scorchStrength: 0.55, char: true });
  blastFX(pos, R, size);
}

// ---------- Black hole ----------
const holes = [];
function spawnBlackHole(pos) {
  sfx.hole();
  const core = new THREE.Mesh(sphereGeo, basic(0x000000));
  const disk = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.18, 12, 64),
    new THREE.MeshBasicMaterial({ color: 0xc080ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  const halo = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x6a20c0, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  const group = new THREE.Group();
  group.add(core, disk, halo);
  group.position.copy(pos);
  scene.add(group);
  holes.push({ pos: pos.clone(), t: 0, r: 2, tick: 0, group, core, disk, halo });
}

function updateHoles(dt) {
  for (let i = holes.length - 1; i >= 0; i--) {
    const h = holes[i];
    h.t += dt;
    const DUR = 5.5;
    const grow = Math.min(1, h.t / 0.6);
    h.r = Math.min(10, 2 + h.t * 2.6);
    h.core.scale.setScalar((0.6 + h.t * 0.25) * grow + 0.01);
    h.disk.scale.setScalar(1.6 + h.t * 0.6);
    h.disk.rotation.x = 1.3 + Math.sin(h.t) * 0.1;
    h.disk.rotation.z += dt * 6;
    h.halo.scale.setScalar(h.r * 0.5);

    // Swallow voxels
    h.tick -= dt;
    while (h.tick <= 0) {
      h.tick += 0.05;
      const R = h.r;
      const { x: cx, y: cy, z: cz } = h.pos;
      const x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R);
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
      const z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
      let budget = 260;
      for (let y = y0; y <= y1 && budget > 0; y++)
        for (let z = z0; z <= z1 && budget > 0; z++)
          for (let x = x0; x <= x1 && budget > 0; x++) {
            const m = get(x, y, z);
            if (!m || m === M.BEDROCK) continue;
            const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
            if (dist > R || Math.random() > 0.05 + 0.25 * (1 - dist / R)) continue;
            const b = getBurn(x, y, z);
            removeCell(x, y, z);
            budget--;
            if (m === M.WATER) continue;
            voxelColor(x, y, z, m, b, _c);
            spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, rand(-1, 1), rand(0, 2), rand(-1, 1), 8);
          }
      collapsePending = true;
    }
    // Swirling sparks
    for (let s = 0; s < 3; s++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.4, 0.4), rand(-1, 1)).normalize();
      spawnParticle({
        pos: h.pos.clone().addScaledVector(dir, h.r),
        vel: dir.clone().multiplyScalar(-h.r * 1.8).add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(6)),
        life: 0.5, s0: 0.15, s1: 0.05, color: 0xd0a0ff, color2: 0x6020c0, additive: true, drag: 0,
      });
    }
    // Pull the player in
    _v.copy(h.pos).sub(player.pos).sub(_v2.set(0, 0.9, 0));
    const pd = _v.length();
    if (pd < h.r * 2.2 && pd > 0.5) player.vel.addScaledVector(_v.normalize(), 30 * (1 - pd / (h.r * 2.2)) * dt);

    if (h.t >= DUR) {
      scene.remove(h.group);
      h.disk.geometry.dispose();
      holes.splice(i, 1);
      sfx.implode();
      screenFlash(0.35 * clamp(1 - h.pos.distanceTo(camera.position) / 80, 0, 1), 0.5);
      shockwave(h.pos, 22, 0.9, 0xd0a0ff);
      burst(h.pos, 40, { speed: 18, life: 0.8, s0: 0.3, s1: 0.05, color: 0xe0c0ff, color2: 0x8040ff, additive: true, drag: 1.5 });
      addShake(h.pos, 0.4, 50);
    }
  }
}

// ---------- Nuke ----------
const missiles = [];
const NUKE_R = 18;

function callNuke() {
  const hit = aim(450);
  if (!hit) { cooldown = 0; return; }
  recoil = 0.4;
  const btn = viewModels.nuke.userData.btn;
  btn.position.z = 0.015;
  setTimeout(() => { btn.position.z = 0.03; }, 150);
  const target = hit.point.clone();
  const m = new THREE.Group();
  const body = cyl(0.8, 5, lam(0xdfe3e8), 0, 0, 0, 'y');
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2, 16), lam(0x3b3f2c));
  nose.rotation.x = Math.PI;
  nose.position.y = -3.5;
  m.add(body, nose);
  for (let i = 0; i < 4; i++) {
    const fin = box(0.12, 1.5, 1.1, lam(0x3b3f2c), Math.cos((i * Math.PI) / 2) * 0.95, 2, Math.sin((i * Math.PI) / 2) * 0.95);
    fin.rotation.y = (-i * Math.PI) / 2;
    m.add(fin);
  }
  const startY = 160;
  m.position.set(target.x, startY, target.z);
  m.traverse((o) => { o.castShadow = true; });
  scene.add(m);
  const speed = 90;
  sfx.whistle((startY - target.y) / speed);
  // Pulsing target ring on the ground
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(NUKE_R - 0.6, NUKE_R, 64),
    new THREE.MeshBasicMaterial({ color: 0xc6ff3d, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.copy(target);
  marker.position.y += 0.3;
  scene.add(marker);
  missiles.push({ mesh: m, marker, target, speed });
}

function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const ms = missiles[i];
    ms.mesh.position.y -= ms.speed * dt;
    ms.mesh.rotation.y += dt * 3;
    ms.marker.material.opacity = 0.35 + 0.35 * Math.sin(performance.now() / 60);
    if (ms.mesh.position.y - 4.5 <= ms.target.y) {
      scene.remove(ms.mesh, ms.marker);
      missiles.splice(i, 1);
      detonateNuke(ms.target);
    }
  }
}

function detonateNuke(pos) {
  const R = NUKE_R;
  sfx.nuke(pos);
  screenFlash(clamp(1 - pos.distanceTo(camera.position) / 250, 0.25, 1), 2);
  flashLight(pos, 60000, 2);
  addShake(pos, 1.8, 250);
  explode(pos, R, { force: 42, debrisChance: 0.16, scorch: 1.7, scorchStrength: 0.9, char: true });
  blastImpulse(pos, R * 3.2, 45);
  fireball(pos, R * 0.95, 2.8);
  shockwave(pos.clone().setY(Math.max(pos.y, 2)), R * 6, 2.4);
  burst(pos, 70, { speed: 28, life: 1.3, s0: 1.4, s1: 4, color: 0xfff0a0, color2: 0xff5010, additive: true, drag: 2.5, spread: 3 });
  mushroomCloud(pos);
}

function mushroomCloud(origin) {
  let t = 0;
  const acc = { stem: 0, cap: 0, dust: 0 };
  effects.push((dt) => {
    t += dt;
    const stemTop = Math.min(t * 15, 38);
    const capR = Math.min(4 + t * 4, 16);
    acc.stem += dt * 45;
    while (acc.stem >= 1) {
      acc.stem--;
      spawnParticle({
        pos: new THREE.Vector3(origin.x + rand(-2.5, 2.5), origin.y + rand(stemTop), origin.z + rand(-2.5, 2.5)),
        vel: new THREE.Vector3(rand(-0.5, 0.5), rand(2, 6), rand(-0.5, 0.5)),
        life: rand(4, 6), s0: 2.4, s1: 4.6, color: 0xff9a40, color2: 0x5a524c, alpha: 0.8, drag: 0.6,
      });
    }
    acc.cap += dt * 85;
    while (acc.cap >= 1) {
      acc.cap--;
      const a = rand(Math.PI * 2), r = rand(capR * 0.3, capR);
      spawnParticle({
        pos: new THREE.Vector3(origin.x + Math.cos(a) * r, origin.y + stemTop + rand(-2, 4), origin.z + Math.sin(a) * r),
        vel: new THREE.Vector3(Math.cos(a) * 2.2, rand(0.5, 3), Math.sin(a) * 2.2),
        life: rand(5, 7.5), s0: 3.5, s1: 8, color: 0xffb050, color2: 0x4a4440, alpha: 0.85, drag: 0.5,
      });
    }
    if (t < 1.8) {
      acc.dust += dt * 70;
      while (acc.dust >= 1) {
        acc.dust--;
        const a = rand(Math.PI * 2), r = t * 32;
        spawnParticle({
          pos: new THREE.Vector3(origin.x + Math.cos(a) * r, rand(8, 12), origin.z + Math.sin(a) * r),
          vel: new THREE.Vector3(Math.cos(a) * 8, rand(1, 3), Math.sin(a) * 8),
          life: rand(2.5, 4), s0: 1.8, s1: 5, color: 0xa08a6a, color2: 0x7a736c, alpha: 0.6, drag: 1.2,
        });
      }
    }
    return t < 4;
  });
}

// ============================================================================
// HUD & input
// ============================================================================
const hotbar = document.getElementById('hotbar');
const toolNameEl = document.getElementById('tool-name');
const toolDescEl = document.getElementById('tool-desc');
const overlay = document.getElementById('overlay');
const waterEl = document.getElementById('water');
const flyEl = document.getElementById('fly');
const canvas = renderer.domElement;
let locked = false;

TOOL_ORDER.forEach((t, i) => {
  const b = document.createElement('button');
  b.className = 'slot';
  b.dataset.tool = t;
  b.innerHTML = `<span class="key">${i + 1}</span><span class="icon">${TOOL_ICONS[i]}</span><span class="label">${TOOLS[t].name}</span>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); selectTool(t); });
  hotbar.appendChild(b);
});

function selectTool(name) {
  currentTool = name;
  hotbar.querySelectorAll('.slot').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  for (const k in viewModels) viewModels[k].visible = k === name;
  toolNameEl.textContent = TOOLS[name].name;
  toolDescEl.textContent = TOOLS[name].desc;
  cooldown = Math.min(cooldown, 0.15);
}

function requestLock() {
  ac();
  const r = canvas.requestPointerLock();
  if (r && r.catch) r.catch(() => {});
}
document.getElementById('play').addEventListener('click', requestLock);
canvas.addEventListener('click', () => { if (!locked) requestLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  overlay.classList.toggle('hidden', locked);
  if (!locked) { firing = false; keys.clear(); }
});

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = clamp(player.pitch - e.movementY * 0.0022, -1.55, 1.55);
});
document.addEventListener('mousedown', (e) => {
  if (!locked || e.button !== 0) return;
  firing = true;
  fire();
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
document.addEventListener('wheel', (e) => {
  if (!locked) return;
  const i = TOOL_ORDER.indexOf(currentTool);
  selectTool(TOOL_ORDER[(i + (e.deltaY > 0 ? 1 : -1) + TOOL_ORDER.length) % TOOL_ORDER.length]);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (!locked) return;
  keys.add(e.code);
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5)) - 1;
    if (TOOL_ORDER[n]) selectTool(TOOL_ORDER[n]);
  }
  if (e.code === 'KeyF') { player.fly = !player.fly; player.vel.y = 0; flyEl.classList.toggle('hidden', !player.fly); }
  if (e.code === 'KeyR' && !e.repeat) resetWorld();
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

window.addEventListener('resize', () => {
  camera.aspect = vmCamera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// World reset
// ============================================================================
function clearDynamic() {
  debris.length = 0;
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles.length = 0;
  for (const b of bodies) { scene.remove(b.mesh); b.mesh.geometry.dispose(); }
  bodies.length = 0;
  for (const h of holes) scene.remove(h.group);
  holes.length = 0;
  for (const m of missiles) scene.remove(m.mesh, m.marker);
  missiles.length = 0;
  tntQueue.length = 0;
  touched = [];
  collapsePending = false;
}

let worldSeed = 0;
function resetWorld(seed = (Math.random() * 1e9) | 0) {
  clearDynamic();
  for (const mesh of sectionMeshes.values()) { scene.remove(mesh); mesh.geometry.dispose(); }
  sectionMeshes.clear();
  activeColumns.clear();
  worldSeed = seed;
  resetWorldData(seed);
  const spawn = spawnPoint();
  player.pos.set(spawn.x, spawn.y, spawn.z);
  // Build the area around the player up front so there's ground to stand on
  streamChunks(0);
  flushSections(Infinity);
  stats.destroyed = 0;
  statsDirty = true;
  player.pos.set(spawn.x, spawn.y, spawn.z);
  player.vel.set(0, 0, 0);
  player.yaw = spawn.yaw;
  player.pitch = -0.08;
}

// ============================================================================
// Main loop
// ============================================================================
const testHooks = { active: false };
resetWorld();
selectTool('hammer');
document.getElementById('loading').classList.add('hidden');

const clock = new THREE.Clock();
let walkPhase = 0;
let hudTimer = 0;
const BIOME_NAMES = { plains: 'Plains', forest: 'Forest', autumn: 'Autumn woods', desert: 'Desert', snow: 'Tundra', mountains: 'Mountains', lake: 'Lake' };

function update(dt) {
  blastLightLevel = 0;
  flashLevel = 0;

  if (locked || testHooks.active) updatePlayer(dt);

  cooldown = Math.max(0, cooldown - dt);
  if (firing && currentTool !== 'laser' && cooldown <= 0) fire();

  // Camera
  camera.position.copy(player.pos);
  camera.position.y += EYE + stepSmooth;
  shake = Math.max(0, shake - dt * 1.1);
  const s = shake * shake * 0.6;
  camera.position.x += rand(-s, s); camera.position.y += rand(-s, s); camera.position.z += rand(-s, s);
  camera.rotation.set(player.pitch + rand(-s, s) * 0.05, player.yaw, 0);
  camera.updateMatrixWorld();

  updateLaser(dt);
  updateProjectiles(dt);
  updateMissiles(dt);
  updateHoles(dt);
  processTNT(dt);
  updateBodies(dt);

  collapseTimer -= dt;
  if (collapsePending && collapseTimer <= 0) {
    collapsePending = false;
    collapseTimer = 0.2;
    runCollapse();
  }

  updateDebris(dt);
  updateParticles(dt);
  updateEffects(dt);
  streamChunks(3);
  flushSections(14);

  // Keep the shadow camera centred on the player
  sun.target.position.set(Math.round(player.pos.x), 0, Math.round(player.pos.z));
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.25;
    const px = Math.floor(player.pos.x), pz = Math.floor(player.pos.z);
    biomeEl.textContent = BIOME_NAMES[biomeAt(px, pz)];
    coordsEl.textContent = `${px}, ${Math.floor(player.pos.y)}, ${pz}`;
  }

  blastLight.intensity = blastLightLevel;
  flashEl.style.opacity = String(flashLevel);
  waterEl.classList.toggle('hidden', !player.headInWater);
  if (statsDirty) { updateStats(); statsDirty = false; }

  // View model animation
  const moving = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && moving > 0.5) walkPhase += dt * moving * 1.6;
  swing = Math.min(1, swing + dt / 0.2);
  recoil *= Math.exp(-10 * dt);
  const vm = viewModels[currentTool];
  const base = vm.userData.base;
  const bob = Math.min(moving / 6, 1);
  vm.position.set(
    base.x + Math.sin(walkPhase) * 0.012 * bob,
    base.y + Math.abs(Math.cos(walkPhase)) * 0.014 * bob,
    base.z + recoil * 0.12
  );
  if (currentTool === 'hammer') vm.rotation.x = -Math.sin(swing * Math.PI) * 1.4;
  else if (currentTool !== 'nuke') vm.rotation.x = recoil * 0.4;
  if (currentTool === 'blackhole') vm.userData.ring.rotation.z += dt * 3;

}

function render() {
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
}

function frame() {
  update(Math.min(clock.getDelta(), 1 / 20));
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Hooks for automated tests / console fun
window.voxelGame = {
  player, stats, keys, selectTool, resetWorld,
  setActive: (v) => { testHooks.active = v; },
  fire: (tool) => { if (tool) selectTool(tool); cooldown = 0; fire(); },
  setFiring: (v) => { firing = v; },
  setLook: (yaw, pitch) => { player.yaw = yaw; player.pitch = pitch; },
  advance: (sec) => { for (let t = 0; t < sec; t += 1 / 30) update(1 / 30); render(); },
  blast: (x, y, z, r) => explode(new THREE.Vector3(x, y, z), r, { force: 5, debrisChance: 0.3 }),
  get seed() { return worldSeed; },
  get sections() { return sectionMeshes.size; },
  get bodies() { return bodies.length; },
};
