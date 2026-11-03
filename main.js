import * as THREE from 'three';
import {
  H, CS, M,
  get, getBurn, set as setVoxel, addBurn, isLoaded, cellKey, colKey,
  dirtyUrgent, dirtyLoad, decodeSection, voxelColor, biomeAt,
  MeshBuilder, buildSectionGeometry, loadColumn, unloadColumn, getColumn,
  resetWorld as resetWorldData, spawnPoint,
} from './world.js';
import { buildSmoothSection, buildSmoothBody, rockGeometry, createSmoothMaterials } from './smooth.js';

// non-voxel.html sets <html data-render="smooth">: same world and tools, smooth surfaces
const SMOOTH = document.documentElement.dataset.render === 'smooth';

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

// Non-voxel mode: gradient sky with drifting clouds and a sun glow, following the camera
let skyDome = null;
if (SMOOTH) {
  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(450, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: SUN_OFFSET.clone().normalize() },
        uHorizon: { value: SKY.clone() },
        uZenith: { value: new THREE.Color(0x3f7fd6) },
      },
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uSun, uHorizon, uZenith; varying vec3 vDir;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += n(p) * a; p *= 2.03; a *= 0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          float up = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25);
          if (d.y > 0.0) {
            vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.012, uTime * 0.005);
            float c = smoothstep(0.5, 0.78, fbm(uv));
            float shade = 0.82 + 0.18 * smoothstep(0.5, 0.9, fbm(uv + 0.3));
            col = mix(col, vec3(shade), c * 0.85 * smoothstep(0.0, 0.18, d.y));
          }
          col = mix(col, uHorizon, smoothstep(0.08, -0.05, d.y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  skyDome.renderOrder = -1;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
}

const blastLight = new THREE.PointLight(0xffa040, 0, 0, 2);
scene.add(blastLight);
const laserLight = new THREE.PointLight(0xff3020, 0, 12, 2);
scene.add(laserLight);


// ============================================================================
// Chunk streaming & section meshes
// ============================================================================
const smoothMats = SMOOTH ? createSmoothMaterials() : null;
const chunkMat = SMOOTH ? smoothMats.solid : new THREE.MeshLambertMaterial({ vertexColors: true });
const waterMat = SMOOTH ? smoothMats.water : null;
const sectionMeshes = new Map();
const waterMeshes = new Map();
const activeColumns = new Set();

function setSectionMesh(map, key, geo, mat, shadows) {
  let mesh = map.get(key);
  if (!geo) {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); map.delete(key); }
    return;
  }
  if (mesh) {
    mesh.geometry.dispose();
    mesh.geometry = geo;
  } else {
    mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    map.set(key, mesh);
    scene.add(mesh);
  }
}

function rebuildSection(key) {
  if (SMOOTH) {
    const { solid, water } = buildSmoothSection(key);
    setSectionMesh(sectionMeshes, key, solid, chunkMat, true);
    setSectionMesh(waterMeshes, key, water, waterMat, false);
  } else {
    setSectionMesh(sectionMeshes, key, buildSectionGeometry(key), chunkMat, true);
  }
}

function dropSection(key) {
  for (const map of [sectionMeshes, waterMeshes]) {
    const mesh = map.get(key);
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); map.delete(key); }
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
      dropSection(key * (H / CS) + cy);
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
const debrisGeo = SMOOTH ? rockGeometry(0.46) : new THREE.BoxGeometry(0.88, 0.88, 0.88);
const debrisMesh = new THREE.InstancedMesh(debrisGeo, new THREE.MeshLambertMaterial({ flatShading: SMOOTH }), MAX_DEBRIS);
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
    if (!pulled && !(tornadoes.length && tornadoForce(d, dt))) d.vy -= GRAVITY * dt;
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
const MAX_PARTICLES = 1400;
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
  const reach = radius * 1.5; // ice shatters further out
  const x0 = Math.floor(cx - reach), x1 = Math.ceil(cx + reach);
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(H - 1, Math.ceil(cy + reach));
  const z0 = Math.floor(cz - reach), z1 = Math.ceil(cz + reach);
  let removed = 0;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const mat = get(x, y, z);
        if (!mat || mat === M.BEDROCK) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const ice = mat === M.ICE;
        if (dist > radius * (ice ? 1.5 : 1) * (SMOOTH ? 0.93 + Math.random() * 0.12 : 0.82 + Math.random() * 0.3)) continue;
        if (chance !== undefined && !ice && dist > 0.8 && Math.random() > chance) continue;

        if (mat === M.TNT) tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.12, 0.4) });
        const wasBurn = getBurn(x, y, z);
        removeCell(x, y, z);
        removed++;
        if (mat === M.WATER) continue;

        if (ice || Math.random() < debrisChance) {
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
  let geo;
  if (SMOOTH) geo = buildSmoothBody(vox);
  else {
    bodyBuilder.reset();
    for (const v of vox) bodyBuilder.emit(v.x, v.y, v.z, v.m, v.b, occ);
    geo = bodyBuilder.toGeometry();
  }
  const mesh = new THREE.Mesh(geo || new THREE.BufferGeometry(), chunkMat);
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
const TOOLS = {
  hammer:       { name: 'Hammer',        icon: '🔨', cat: 'Hand tools',   cooldown: 0.22, desc: 'Smash blocks up close', use: () => useHammer() },
  tntplacer:    { name: 'TNT Placer',    icon: '🧨', cat: 'Hand tools',   cooldown: 0.15, desc: 'Click to place TNT, right-click a TNT block to light it', use: () => placeTNT() },
  forcepush:    { name: 'Force Push',    icon: '✋', cat: 'Hand tools',   cooldown: 0.8,  desc: 'Blasts everything in front of you away', use: () => forcePush() },
  minigun:      { name: 'Minigun',       icon: '🔫', cat: 'Guns & beams', cooldown: 0.055, desc: 'Hold to shred blocks with bullets', use: () => fireMinigun() },
  shotgun:      { name: 'Shotgun',       icon: '💥', cat: 'Guns & beams', cooldown: 0.75, desc: 'A wide spray of pellets', use: () => fireShotgun() },
  laser:        { name: 'Laser',         icon: '⚡', cat: 'Guns & beams', cooldown: 0, hold: true, desc: 'Hold to burn through anything' },
  freeze:       { name: 'Freeze Ray',    icon: '❄️', cat: 'Guns & beams', cooldown: 0, hold: true, desc: 'Hold to turn blocks into ice, which shatters easily' },
  flamethrower: { name: 'Flamethrower',  icon: '🔥', cat: 'Guns & beams', cooldown: 0, hold: true, desc: 'Hold to set things on fire. Wood and leaves burn and spread' },
  rocket:       { name: 'Rocket',        icon: '🚀', cat: 'Explosives',   cooldown: 0.55, desc: 'Fast straight shot, big boom', use: () => fireRocket() },
  grenade:      { name: 'Grenade',       icon: '🍍', cat: 'Explosives',   cooldown: 0.5,  desc: 'Bounces around, explodes after 2 seconds', use: () => throwProjectile('grenade') },
  bomb:         { name: 'Bomb',          icon: '💣', cat: 'Explosives',   cooldown: 0.45, desc: 'Throw it, explodes on impact', use: () => throwProjectile('bomb') },
  cluster:      { name: 'Cluster Bomb',  icon: '🎆', cat: 'Explosives',   cooldown: 0.8,  desc: 'Splits into a ring of bomblets', use: () => throwProjectile('cluster') },
  c4:           { name: 'C4',            icon: '📦', cat: 'Explosives',   cooldown: 0.25, desc: 'Click to stick charges, right-click to detonate them all', use: () => throwProjectile('c4') },
  drill:        { name: 'Drill Missile', icon: '⛏️', cat: 'Explosives',   cooldown: 1,    desc: 'Bores a long tunnel, then explodes', use: () => launchDrill() },
  nuke:         { name: 'NUKE',          icon: '☢️', cat: 'Strikes',      cooldown: 2.5,  desc: 'Calls in a missile at the crosshair', use: () => callNuke() },
  airstrike:    { name: 'Airstrike',     icon: '✈️', cat: 'Strikes',      cooldown: 3,    desc: 'A bomber carpet-bombs the line you are looking along', use: () => callAirstrike() },
  meteor:       { name: 'Meteor Shower', icon: '☄️', cat: 'Strikes',      cooldown: 3,    desc: 'Rains flaming meteors around the crosshair', use: () => callMeteors() },
  lightning:    { name: 'Lightning',     icon: '🌩️', cat: 'Strikes',      cooldown: 0.5,  desc: 'Strikes the crosshair and starts fires', use: () => callLightning() },
  blackhole:    { name: 'Black Hole',    icon: '🕳️', cat: 'Disasters',    cooldown: 1.5,  desc: 'Swallows everything nearby', use: () => throwProjectile('blackhole') },
  tornado:      { name: 'Tornado',       icon: '🌪️', cat: 'Disasters',    cooldown: 2,    desc: 'A wandering twister that rips up everything it touches', use: () => spawnTornado() },
  earthquake:   { name: 'Earthquake',    icon: '🏚️', cat: 'Disasters',    cooldown: 4,    desc: 'Cracks the ground and crumbles buildings', use: () => startQuake() },
};
const TOOL_IDS = Object.keys(TOOLS);
const DEFAULT_HOTBAR = ['hammer', 'minigun', 'laser', 'rocket', 'bomb', 'flamethrower', 'tornado', 'blackhole', 'nuke'];
let hotbarSlots = DEFAULT_HOTBAR.slice();
try {
  const saved = JSON.parse(localStorage.getItem('voxel.hotbar'));
  if (Array.isArray(saved) && saved.length === 9 && saved.every((t) => TOOLS[t])) hotbarSlots = saved;
} catch { /* storage unavailable */ }
let activeSlot = 0;
let currentTool = hotbarSlots[0];
let cooldown = 0;
let firing = false;
let swing = 1, recoil = 0;

function fire() {
  if (cooldown > 0) return;
  const tool = TOOLS[currentTool];
  if (tool.hold) return;
  cooldown = tool.cooldown;
  tool.use();
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
  const freezing = currentTool === 'freeze';
  const active = firing && (currentTool === 'laser' || freezing);
  laserSound(active && !freezing);
  loopSound('freeze', active && freezing, (a) => toneLoop(a, 1400, 0.05));
  if (!active) { beam.visible = false; laserLight.intensity = 0; return; }
  beamOuter.material.color.setHex(freezing ? 0x40c8ff : 0xff2a1a);
  laserLight.color.setHex(freezing ? 0x60d0ff : 0xff3020);
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
    if (freezing) {
      freezeArea(hit.point, 2.2);
      if (Math.random() < 0.3) sfx.freeze();
      spawnParticle({
        pos: hit.point.clone().addScaledVector(hit.normal, 0.2),
        vel: new THREE.Vector3(rand(-2, 2), rand(0, 2), rand(-2, 2)),
        life: rand(0.4, 0.8), s0: 0.12, s1: 0.02, color: 0xffffff, color2: 0x80d8ff, additive: true, drag: 1,
      });
      continue;
    }
    explode(hit.point.clone().addScaledVector(aimDir, 0.35), 1.3, { force: 3, debrisChance: 0.25, scorch: 1.8, scorchStrength: 0.4 });
    if (Math.random() < 0.15) igniteArea(hit.point, 1.5, 0.5);
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
  } else if (kind === 'grenade') {
    mesh = new THREE.Mesh(projGeo.bomblet, lam(0x3a4a2a));
  } else if (kind === 'c4') {
    mesh = box(0.4, 0.15, 0.28, lam(0xd8cfa8));
    mesh.add(ball(0.05, basic(0xff2020), 0, 0.1, 0));
  } else if (kind === 'drill') {
    mesh = new THREE.Group();
    const bit = new THREE.Group();
    bit.add(new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 8), lam(0x8a9098)));
    bit.position.y = 0.9;
    mesh.add(bit, cyl(0.35, 1.4, lam(0xe0b020), 0, 0, 0, 'y'));
  } else if (kind === 'meteor') {
    mesh = new THREE.Mesh(projGeo.bomb, basic(0xff8a30));
    mesh.scale.setScalar(2.4);
    mesh.add(new THREE.Mesh(projGeo.bomb, new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending })));
    mesh.children[0].scale.setScalar(1.5);
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
  else if (kind === 'c4') vel = aimDir.clone().multiplyScalar(14).addScaledVector(player.vel, 0.5);
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
    if (p.kind === 'grenade' || p.kind === 'c4') {
      if (!p.stuck) { stepBouncy(p, dt); p.mesh.rotation.x += dt * 6; }
      if (p.kind === 'c4') { p.mesh.children[0].visible = (p.life * 2) % 1 < 0.25; continue; }
      if (p.life < 2.2) continue;
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
      detonate(p.mesh.position.clone(), 3.8, 16, 0.9);
      continue;
    }
    if (p.kind === 'drill') {
      if (!updateDrill(p, dt)) continue;
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
      detonate(p.mesh.position.clone(), 4.2, 18, 1);
      continue;
    }
    const grav = p.kind === 'rocket' || p.kind === 'blackhole' || p.kind === 'meteor' ? 0 : GRAVITY;
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

    if (p.kind === 'meteor') {
      p.mesh.rotation.x += dt * 3;
      for (let j = 0; j < 2; j++) spawnParticle({
        pos: pos.clone().add(_v2.set(rand(-0.6, 0.6), rand(-0.6, 0.6), rand(-0.6, 0.6))), vel: p.vel.clone().multiplyScalar(-0.05),
        life: rand(0.5, 1), s0: 1, s1: 2.5, color: 0xffb040, color2: 0x4a4440, alpha: 0.7, drag: 1,
      });
    } else if (p.kind === 'rocket') {
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
      case 'meteor': detonate(at, 4, 20, 1.1); igniteArea(at, 5, 0.35); break;
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
  igniteArea(pos, R * 1.4, 0.12);
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
// More tools: guns, beams, fire, strikes and natural disasters
// ============================================================================
const FLAMMABLE = new Map([
  [M.WOOD, [4, 7]], [M.BIRCH, [4, 7]], [M.PLANKS, [3, 5]], [M.ROOF, [4, 6]],
  [M.LEAVES, [1.2, 2.5]], [M.PINE, [1.2, 2.5]], [M.AUTUMN, [1.2, 2.5]],
  [M.CLOTH, [1, 2]], [M.CACTUS, [2, 4]], [M.GRASS, [0.8, 1.6]], [M.TNT, [0.3, 0.6]],
]);
const TERRAIN_MATS = new Set([M.BEDROCK, M.DIRT, M.GRASS, M.STONE, M.SAND, M.SNOW, M.WATER]);

const loops = {};
function loopSound(name, on, build) {
  if (on && !loops[name]) loops[name] = build(ac());
  else if (!on && loops[name]) {
    const l = loops[name];
    l.gain.gain.setTargetAtTime(0, actx.currentTime, 0.04);
    for (const n of l.nodes) n.stop(actx.currentTime + 0.2);
    delete loops[name];
  }
}
function noiseLoop(a, freq, q, vol) {
  const buf = a.createBuffer(1, a.sampleRate, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf; src.loop = true;
  const f = a.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const gain = a.createGain();
  gain.gain.value = vol;
  src.connect(f).connect(gain).connect(master);
  src.start();
  return { gain, nodes: [src] };
}
function toneLoop(a, freq, vol) {
  const o = a.createOscillator();
  o.type = 'sine'; o.frequency.value = freq;
  const lfo = a.createOscillator();
  lfo.frequency.value = 7;
  const lg = a.createGain();
  lg.gain.value = 60;
  lfo.connect(lg).connect(o.frequency);
  const gain = a.createGain();
  gain.gain.value = vol;
  o.connect(gain).connect(master);
  o.start(); lfo.start();
  return { gain, nodes: [o, lfo] };
}
Object.assign(sfx, {
  gun() { noise(0.07, 4500, 0.35); tone(160, 60, 0.06, 0.15, 'square'); },
  shotgun() { noise(0.4, 2400, 1); tone(130, 40, 0.25, 0.5); },
  clink() { tone(900, 500, 0.08, 0.12, 'triangle'); },
  beep() { tone(1300, 1300, 0.08, 0.15, 'square'); tone(1700, 1700, 0.08, 0.15, 'square', 0.1); },
  place() { tone(300, 180, 0.08, 0.3, 'square'); noise(0.05, 1500, 0.3); },
  thunder(pos) {
    const d = pos.distanceTo(camera.position) / 340;
    noise(0.3, 7000, vol(pos, 0.8), d * 0.3); noise(3, 500, vol(pos, 1.5), d); tone(60, 25, 2.5, vol(pos, 0.6), 'sine', d);
  },
  plane() { tone(95, 70, 4, 0.25, 'sawtooth'); noise(4, 400, 0.4); },
  quake() { noise(6, 110, 1.6); tone(32, 18, 6, 0.7); noise(6, 300, 0.5, 0.5); },
  wind() { noise(10, 600, 0.7); noise(10, 1500, 0.25, 1); },
  grind() { noise(0.25, 2500, 0.25); tone(220, 180, 0.2, 0.1, 'sawtooth'); },
  push() { noise(0.5, 900, 0.9); tone(200, 50, 0.3, 0.5); },
  freeze() { tone(2400, 1800, 0.15, 0.06, 'triangle'); },
});

// ---------- Small visual helpers ----------
function spreadDir(dir, spread) {
  return dir.clone().add(_v2.set(rand(-spread, spread), rand(-spread, spread), rand(-spread, spread))).normalize();
}

function tracer(a, b, color = 0xffe0a0, life = 0.07) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    mat.opacity = 0.9 * (1 - t / life);
    if (t >= life) { scene.remove(line); geo.dispose(); mat.dispose(); return false; }
    return true;
  });
}

function muzzleFlash() {
  spawnParticle({ pos: muzzleWorld(new THREE.Vector3()), vel: aimDir.clone().multiplyScalar(2), life: 0.06, s0: 0.12, s1: 0.2, color: 0xffe0a0, additive: true });
}

function hitscan(spread, range, radius, opts) {
  camera.getWorldDirection(aimDir);
  const dir = spreadDir(aimDir, spread);
  const hit = raycast(camera.position, dir, range);
  const start = muzzleWorld(new THREE.Vector3());
  const end = hit ? hit.point : camera.position.clone().addScaledVector(dir, range);
  tracer(start, end);
  if (!hit) return;
  explode(hit.point.clone().addScaledVector(dir, 0.3), radius, opts);
  spawnParticle({ pos: hit.point.clone().addScaledVector(hit.normal, 0.1), vel: hit.normal.clone().multiplyScalar(4), life: 0.25, s0: 0.08, s1: 0.02, color: 0xffd080, additive: true, drag: 1 });
  if (Math.random() < 0.4) spawnParticle({ pos: hit.point.clone(), vel: new THREE.Vector3(0, 1, 0), life: 0.9, s0: 0.15, s1: 0.5, color: 0x8a8580, alpha: 0.5 });
}

function orientedRing(pos, dir, maxRadius, duration, color) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  mesh.position.copy(pos);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  scene.add(mesh);
  let t = 0;
  const vel = dir.clone().multiplyScalar(14);
  effects.push((dt) => {
    t += dt;
    const k = t / duration;
    if (k >= 1) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); return false; }
    mesh.position.addScaledVector(vel, dt);
    mesh.scale.setScalar(0.5 + maxRadius * k);
    mesh.material.opacity = 0.8 * (1 - k);
    return true;
  });
}

function groundY(x, z) {
  for (let y = H - 1; y >= 0; y--) {
    const m = get(x, y, z);
    if (m && m !== M.WATER) return y + 1;
  }
  return 1;
}

// ---------- Minigun & shotgun ----------
function fireMinigun() {
  recoil = Math.max(recoil, 0.25);
  vmSpin = 1;
  sfx.gun();
  muzzleFlash();
  hitscan(0.022, 160, 1.0, { force: 6, debrisChance: 0.6, chance: 0.35 });
  shake = Math.max(shake, 0.03);
}

function fireShotgun() {
  recoil = 1;
  sfx.shotgun();
  muzzleFlash();
  for (let i = 0; i < 12; i++) hitscan(0.075, 70, 1.05, { force: 10, debrisChance: 0.6, chance: 0.5 });
  shake = Math.max(shake, 0.15);
}

// ---------- Fire ----------
const fires = new Map();
const MAX_FIRES = 1500;

function ignite(x, y, z) {
  const m = get(x, y, z);
  const spec = FLAMMABLE.get(m);
  if (!spec) return false;
  if (m === M.TNT) {
    removeCell(x, y, z);
    tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.3, 0.8) });
    return true;
  }
  const k = cellKey(x, y, z);
  if (fires.has(k) || fires.size >= MAX_FIRES) return true;
  fires.set(k, { x, y, z, m, t: rand(spec[0], spec[1]), spread: rand(0, 0.3) });
  addBurn(x, y, z, 90);
  return true;
}

function igniteArea(c, R, chance) {
  const x0 = Math.floor(c.x - R), x1 = Math.ceil(c.x + R);
  const y0 = Math.max(0, Math.floor(c.y - R)), y1 = Math.min(H - 1, Math.ceil(c.y + R));
  const z0 = Math.floor(c.z - R), z1 = Math.ceil(c.z + R);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (!FLAMMABLE.has(get(x, y, z)) || Math.random() > chance) continue;
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z) <= R) ignite(x, y, z);
      }
}

function updateFires(dt) {
  let emitted = 0;
  for (const [k, f] of fires) {
    if (get(f.x, f.y, f.z) !== f.m) { fires.delete(k); continue; }
    f.t -= dt;
    f.spread -= dt;
    if (emitted < 45 && Math.random() < 0.3) {
      emitted++;
      spawnParticle({
        pos: new THREE.Vector3(f.x + rand(0.2, 0.8), f.y + 0.9, f.z + rand(0.2, 0.8)),
        vel: new THREE.Vector3(rand(-0.3, 0.3), rand(1.5, 3), rand(-0.3, 0.3)),
        life: rand(0.4, 0.8), s0: 0.35, s1: 0.08, color: 0xffc040, color2: 0xff3010, additive: true, drag: 0.5,
      });
      if (Math.random() < 0.15) spawnParticle({
        pos: new THREE.Vector3(f.x + 0.5, f.y + 1.4, f.z + 0.5), vel: new THREE.Vector3(rand(-0.3, 0.3), rand(1.5, 2.5), rand(-0.3, 0.3)),
        life: rand(1.5, 2.5), s0: 0.3, s1: 1.2, color: 0x3a3634, color2: 0x7a7570, alpha: 0.45, drag: 0.4,
      });
    }
    if (f.spread <= 0) {
      f.spread = 0.3;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const n = get(f.x + dx, f.y + dy, f.z + dz);
        if (!FLAMMABLE.has(n)) continue;
        const chance = (n === M.GRASS ? 0.045 : 0.3) * (dy > 0 ? 1.6 : 1);
        if (Math.random() < chance) ignite(f.x + dx, f.y + dy, f.z + dz);
      }
    }
    if (f.t <= 0) {
      fires.delete(k);
      if (f.m === M.GRASS) setVoxel(f.x, f.y, f.z, M.DIRT, 200);
      else {
        removeCell(f.x, f.y, f.z);
        collapsePending = true;
        if (Math.random() < 0.25) spawnDebris(f.x + 0.5, f.y + 0.5, f.z + 0.5, _c.setHex(0x2a1d14), rand(-1, 1), rand(0, 2), rand(-1, 1), rand(1, 2));
      }
    }
  }
}

// ---------- Flamethrower ----------
let flameTick = 0;
function updateFlamethrower(dt) {
  const active = firing && currentTool === 'flamethrower';
  loopSound('flame', active, (a) => noiseLoop(a, 700, 0.8, 0.5));
  if (!active) return;
  camera.getWorldDirection(aimDir);
  const start = muzzleWorld(new THREE.Vector3());
  for (let i = 0; i < 4; i++) {
    spawnParticle({
      pos: start.clone(), vel: spreadDir(aimDir, 0.1).multiplyScalar(rand(11, 17)).addScaledVector(player.vel, 0.8),
      life: rand(0.4, 0.65), s0: 0.12, s1: 1.1, color: 0xffe080, color2: 0xff3010, additive: true, drag: 1.4, buoy: 4,
    });
  }
  recoil = Math.max(recoil, 0.08);
  flameTick -= dt;
  while (flameTick <= 0) {
    flameTick += 0.05;
    for (let r = 0; r < 3; r++) {
      const hit = raycast(camera.position, spreadDir(aimDir, 0.1), 10);
      if (!hit) continue;
      if (!ignite(hit.x, hit.y, hit.z)) {
        const fx = hit.x + hit.normal.x, fy = hit.y + hit.normal.y, fz = hit.z + hit.normal.z;
        if (!ignite(fx, fy, fz)) addBurn(hit.x, hit.y, hit.z, 12);
      }
    }
  }
}

// ---------- Freeze ray (driven by the beam code) ----------
function freezeArea(c, R) {
  const x0 = Math.floor(c.x - R), x1 = Math.ceil(c.x + R);
  const y0 = Math.max(0, Math.floor(c.y - R)), y1 = Math.min(H - 1, Math.ceil(c.y + R));
  const z0 = Math.floor(c.z - R), z1 = Math.ceil(c.z + R);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const m = get(x, y, z);
        if (!m || m === M.BEDROCK || m === M.ICE) continue;
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z) > R * (0.8 + Math.random() * 0.3)) continue;
        if (m === M.TNT) continue; // frozen TNT would be no fun
        fires.delete(cellKey(x, y, z));
        setVoxel(x, y, z, M.ICE);
      }
}

// ---------- Grenades & C4 (bouncing / sticky projectiles) ----------
function stepBouncy(p, dt) {
  const pos = p.mesh.position;
  const steps = Math.max(1, Math.ceil((p.vel.length() * dt) / 0.25));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    p.vel.y -= GRAVITY * h;
    for (const a of ['x', 'y', 'z']) {
      pos[a] += p.vel[a] * h;
      if (!cellSolid(pos)) continue;
      pos[a] -= p.vel[a] * h;
      if (p.kind === 'c4') { p.stuck = true; p.vel.set(0, 0, 0); sfx.place(); return; }
      if (Math.abs(p.vel[a]) > 3) sfx.clink();
      p.vel[a] *= -0.45;
      for (const b of ['x', 'y', 'z']) if (b !== a) p.vel[b] *= 0.75;
    }
  }
}

function detonateC4() {
  const charges = projectiles.filter((p) => p.kind === 'c4');
  if (!charges.length) return;
  sfx.beep();
  charges.forEach((p, i) => {
    projectiles.splice(projectiles.indexOf(p), 1);
    const pos = p.mesh.position.clone();
    let t = 0;
    const delay = 0.2 + i * 0.07;
    effects.push((dt) => {
      t += dt;
      p.mesh.children[0].visible = true;
      if (t < delay) return true;
      scene.remove(p.mesh);
      detonate(pos, 4.3, 18, 1);
      return false;
    });
  });
}

// ---------- Tunnel-boring drill missile ----------
function launchDrill() {
  recoil = 0.7;
  sfx.rocket();
  camera.getWorldDirection(aimDir);
  makeProjectile('drill', muzzleWorld(new THREE.Vector3()), aimDir.clone().multiplyScalar(20));
}

function updateDrill(p, dt) {
  const pos = p.mesh.position;
  const step = p.vel.length() * dt;
  pos.addScaledVector(p.vel, dt);
  p.dist = (p.dist || 0) + step;
  p.carve = (p.carve || 0) - step;
  p.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(p.vel).normalize());
  p.mesh.children[0].rotation.y += dt * 30;
  while (p.carve <= 0) {
    p.carve += 0.7;
    const n = explode(pos, 1.9, { force: 5, debrisChance: 0.2 });
    if (n > 0) {
      if (Math.random() < 0.3) sfx.grind();
      shake = Math.max(shake, 0.06 * clamp(1 - pos.distanceTo(camera.position) / 30, 0, 1));
      spawnParticle({ pos: pos.clone(), vel: new THREE.Vector3(rand(-3, 3), rand(1, 4), rand(-3, 3)), life: 0.3, s0: 0.1, s1: 0.03, color: 0xffd080, additive: true });
    }
  }
  return p.dist > 60 || p.life > 4.5;
}

// ---------- Meteor shower ----------
function callMeteors() {
  const hit = aim(400);
  if (!hit) { cooldown = 0; return; }
  const center = hit.point.clone();
  const from = new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).normalize().multiplyScalar(45);
  from.y = 95;
  targetMarker(center, 16, 0xff7a20, 4);
  for (let i = 0; i < 16; i++) {
    let t = 0;
    const delay = rand(0, 3.5);
    effects.push((dt) => {
      t += dt;
      if (t < delay) return true;
      const a = rand(Math.PI * 2), r = Math.sqrt(Math.random()) * 16;
      const impact = center.clone().add(_v.set(Math.cos(a) * r, 0, Math.sin(a) * r));
      const start = impact.clone().add(from).add(_v.set(rand(-8, 8), rand(-5, 5), rand(-8, 8)));
      const vel = impact.clone().sub(start).normalize().multiplyScalar(rand(60, 80));
      makeProjectile('meteor', start, vel);
      return false;
    });
  }
}

function targetMarker(pos, R, color, life) {
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.5, R, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.copy(pos);
  marker.position.y += 0.3;
  scene.add(marker);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    marker.material.opacity = (0.35 + 0.3 * Math.sin(t * 16)) * (1 - t / life);
    if (t < life) return true;
    scene.remove(marker); marker.geometry.dispose(); marker.material.dispose();
    return false;
  });
}

// ---------- Airstrike ----------
const planes = [];
function callAirstrike() {
  const hit = aim(400);
  if (!hit) { cooldown = 0; return; }
  camera.getWorldDirection(aimDir);
  const dir = new THREE.Vector3(aimDir.x, 0, aimDir.z);
  if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
  dir.normalize();
  const target = hit.point.clone();
  const alt = Math.max(target.y + 32, H + 6);
  const speed = 55, bombSpeed = speed * 0.5;
  const lead = bombSpeed * Math.sqrt((2 * (alt - target.y)) / GRAVITY);
  const g = new THREE.Group();
  const hull = lam(0x6b7480), dark = lam(0x3d434b);
  g.add(box(1.4, 1.3, 9, hull), box(11, 0.25, 2.2, hull, 0, 0, 0.5), box(0.25, 2.2, 1.6, dark, 0, 1.1, 3.8), box(4.2, 0.2, 1.2, dark, 0, 0.3, 3.9));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 12), dark);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -5.4;
  g.add(nose);
  g.traverse((o) => { o.castShadow = true; });
  g.position.copy(target).addScaledVector(dir, -160);
  g.position.y = alt;
  g.rotation.y = Math.atan2(-dir.x, -dir.z);
  scene.add(g);
  sfx.plane();
  targetMarker(target, 6, 0xff3030, 3.5);
  planes.push({ mesh: g, dir, speed, bombSpeed, target, dropFrom: -22 - lead, dropTo: 22 - lead, nextDrop: -22 - lead, traveled: 0 });
}

function updatePlanes(dt) {
  for (let i = planes.length - 1; i >= 0; i--) {
    const pl = planes[i];
    pl.mesh.position.addScaledVector(pl.dir, pl.speed * dt);
    pl.traveled += pl.speed * dt;
    const along = _v.copy(pl.mesh.position).sub(pl.target).dot(pl.dir);
    while (along >= pl.nextDrop && pl.nextDrop <= pl.dropTo) {
      pl.nextDrop += 3.5;
      makeProjectile('bomb', pl.mesh.position.clone().add(_v2.set(0, -1, 0)), pl.dir.clone().multiplyScalar(pl.bombSpeed));
    }
    if (pl.traveled > 340) { scene.remove(pl.mesh); planes.splice(i, 1); }
  }
}

// ---------- Lightning ----------
function callLightning() {
  const hit = aim(300);
  if (!hit) { cooldown = 0; return; }
  const pos = hit.point.clone();
  const pts = [];
  let p = pos.clone().add(_v.set(rand(-6, 6), 70, rand(-6, 6)));
  const segs = 18;
  for (let i = 0; i <= segs; i++) {
    const k = i / segs;
    const q = p.clone().lerp(pos, k);
    if (i > 0 && i < segs) q.add(_v.set(rand(-2.2, 2.2), rand(-1, 1), rand(-2.2, 2.2)));
    pts.push(q);
  }
  const group = new THREE.Group();
  const core = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.MeshBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const addSeg = (a, b, r) => {
    const len = a.distanceTo(b);
    for (const [mat, rr] of [[core, r], [glow, r * 4]]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, len, 6, 1, true), mat);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(b).sub(a).normalize());
      group.add(m);
    }
  };
  for (let i = 0; i < pts.length - 1; i++) addSeg(pts[i], pts[i + 1], 0.12);
  // A couple of side branches
  for (let b = 0; b < 3; b++) {
    let a = pts[3 + Math.floor(rand(10))].clone();
    for (let j = 0; j < 4; j++) {
      const nb = a.clone().add(_v.set(rand(-3, 3), rand(-4, -1.5), rand(-3, 3)));
      addSeg(a, nb, 0.06);
      a = nb;
    }
  }
  scene.add(group);
  let t = 0;
  effects.push((dt) => {
    t += dt;
    const on = t < 0.08 || (t > 0.14 && t < 0.24) || (t > 0.3 && t < 0.36);
    group.visible = on;
    if (t < 0.4) return true;
    scene.remove(group);
    group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    core.dispose(); glow.dispose();
    return false;
  });
  explode(pos, 2.7, { force: 14, debrisChance: 0.8, scorch: 1.8, scorchStrength: 0.7, char: true });
  igniteArea(pos, 3.5, 0.7);
  blastImpulse(pos, 8, 10);
  flashLight(pos, 3000, 0.4);
  screenFlash(0.35 * clamp(1 - pos.distanceTo(camera.position) / 150, 0.2, 1), 0.35);
  burst(pos, 25, { speed: 10, life: 0.4, s0: 0.15, s1: 0.03, color: 0xdde8ff, additive: true, drag: 1 });
  addShake(pos, 0.5, 60);
  sfx.thunder(pos);
}

// ---------- Force push ----------
function forcePush() {
  recoil = 1;
  sfx.push();
  camera.getWorldDirection(aimDir);
  const o = camera.position;
  const R = 12;
  let budget = 600;
  const x0 = Math.floor(o.x - R), x1 = Math.ceil(o.x + R);
  const y0 = Math.max(0, Math.floor(o.y - R)), y1 = Math.min(H - 1, Math.ceil(o.y + R));
  const z0 = Math.floor(o.z - R), z1 = Math.ceil(o.z + R);
  for (let y = y0; y <= y1 && budget > 0; y++)
    for (let z = z0; z <= z1 && budget > 0; z++)
      for (let x = x0; x <= x1 && budget > 0; x++) {
        const m = get(x, y, z);
        if (!m || m === M.BEDROCK || m === M.WATER) continue;
        _v.set(x + 0.5 - o.x, y + 0.5 - o.y, z + 0.5 - o.z);
        const dist = _v.length();
        if (dist > R || dist < 1) continue;
        const cos = _v.dot(aimDir) / dist;
        if (cos < 0.8) continue;
        if (Math.random() > 1.1 - dist / R) continue;
        const b = getBurn(x, y, z);
        if (m === M.TNT) tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.4, 0.8) });
        removeCell(x, y, z);
        budget--;
        voxelColor(x, y, z, m, b, _c);
        const sp = rand(18, 32) * (1.2 - dist / R);
        spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, aimDir.x * sp, aimDir.y * sp + rand(2, 5), aimDir.z * sp, rand(3, 6));
      }
  for (const d of debris) {
    _v.set(d.x - o.x, d.y - o.y, d.z - o.z);
    const dist = _v.length();
    if (dist < R * 1.6 && _v.dot(aimDir) / dist > 0.7) { d.vx += aimDir.x * 25; d.vy += aimDir.y * 25 + 4; d.vz += aimDir.z * 25; }
  }
  player.vel.addScaledVector(aimDir, -4);
  orientedRing(muzzleWorld(new THREE.Vector3()), aimDir.clone(), 6, 0.45, 0x7fd0ff);
  for (let i = 0; i < 20; i++) {
    spawnParticle({ pos: camera.position.clone().addScaledVector(aimDir, 1.5), vel: spreadDir(aimDir, 0.35).multiplyScalar(rand(15, 25)), life: 0.4, s0: 0.1, s1: 0.4, color: 0xbfe8ff, additive: true, drag: 2 });
  }
  shake = Math.max(shake, 0.2);
  collapsePending = true;
}

// ---------- Tornado ----------
const tornadoes = [];
function spawnTornado() {
  const hit = aim(250);
  if (!hit) { cooldown = 0; return; }
  sfx.wind();
  tornadoes.push({ pos: hit.point.clone(), t: 0, dur: 13, heading: rand(Math.PI * 2), tick: 0 });
}

function updateTornadoes(dt) {
  for (let i = tornadoes.length - 1; i >= 0; i--) {
    const tw = tornadoes[i];
    tw.t += dt;
    const power = Math.min(1, tw.t / 1.5) * Math.min(1, (tw.dur - tw.t) / 1.5);
    tw.heading += rand(-1.2, 1.2) * dt;
    tw.pos.x += Math.cos(tw.heading) * 5 * dt;
    tw.pos.z += Math.sin(tw.heading) * 5 * dt;
    tw.pos.y += (groundY(Math.floor(tw.pos.x), Math.floor(tw.pos.z)) - tw.pos.y) * Math.min(1, 2 * dt);

    tw.tick -= dt;
    while (tw.tick <= 0) {
      tw.tick += 0.04;
      for (let s = 0; s < 30; s++) {
        const h = rand(-1.5, 24);
        const r = Math.sqrt(Math.random()) * (2.5 + Math.max(0, h) * 0.18);
        const a = rand(Math.PI * 2);
        const x = Math.floor(tw.pos.x + Math.cos(a) * r), y = Math.floor(tw.pos.y + h), z = Math.floor(tw.pos.z + Math.sin(a) * r);
        const m = get(x, y, z);
        if (!m || m === M.BEDROCK || Math.random() > 0.55 * power) continue;
        // The ground itself is left alone (grass gets stripped); everything on it is ripped apart
        if (TERRAIN_MATS.has(m)) {
          if (m === M.GRASS && !get(x, y + 1, z) && Math.random() < 0.3) {
            setVoxel(x, y, z, M.DIRT);
            spawnDebris(x + 0.5, y + 1, z + 0.5, voxelColor(x, y, z, M.LEAVES, 0, _c), -Math.sin(a) * 8, rand(4, 9), Math.cos(a) * 8, rand(4, 7));
          }
          continue;
        }
        const b = getBurn(x, y, z);
        removeCell(x, y, z);
        if (m === M.WATER) continue;
        if (m === M.TNT) tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.5, 2) });
        voxelColor(x, y, z, m, b, _c);
        spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, -Math.sin(a) * 8, rand(4, 9), Math.cos(a) * 8, rand(6, 10));
      }
      collapsePending = true;
    }
    for (let s = 0; s < 9; s++) {
      const h = rand(0, 36), r = 0.8 + h * 0.32, a = rand(Math.PI * 2);
      spawnParticle({
        pos: new THREE.Vector3(tw.pos.x + Math.cos(a) * r, tw.pos.y + h, tw.pos.z + Math.sin(a) * r),
        vel: new THREE.Vector3(-Math.sin(a) * r * 2.5, rand(2, 5), Math.cos(a) * r * 2.5),
        life: rand(0.9, 1.4), s0: 0.9 + h * 0.05, s1: 2.2 + h * 0.1, color: 0x8a847a, color2: 0x5d5650, alpha: 0.6 * power, drag: 0.3,
      });
    }
    // Suck the player in
    const dx = tw.pos.x - player.pos.x, dz = tw.pos.z - player.pos.z;
    const dh = Math.hypot(dx, dz) + 0.01;
    if (dh < 14 && player.pos.y < tw.pos.y + 36) {
      const k = (1 - dh / 14) * power;
      player.vel.x += ((dx / dh) * 12 + (-dz / dh) * 16) * k * dt;
      player.vel.z += ((dz / dh) * 12 + (dx / dh) * 16) * k * dt;
      if (dh < 4) player.vel.y += 34 * k * dt;
    }
    addShake(tw.pos, 0.25 * power, 40);
    if (tw.t >= tw.dur) tornadoes.splice(i, 1);
  }
}

// Debris caught in a tornado orbits and climbs; returns true if gravity was handled
function tornadoForce(d, dt) {
  for (const tw of tornadoes) {
    const dx = d.x - tw.pos.x, dz = d.z - tw.pos.z;
    const dh = Math.hypot(dx, dz) + 0.01;
    const above = d.y - tw.pos.y;
    if (dh > 15 || above > 42 || above < -3) continue;
    const k = 1 - dh / 15;
    const tx = -dz / dh, tz = dx / dh;
    const want = 2 + Math.max(0, above) * 0.3;
    const inward = dh > want ? -14 : 6;
    d.vx += (tx * 26 * k + (dx / dh) * inward * k - d.vx * 0.8) * dt * 3;
    d.vz += (tz * 26 * k + (dz / dh) * inward * k - d.vz * 0.8) * dt * 3;
    d.vy += ((dh < want + 3 ? 36 : 18) * k - GRAVITY) * dt;
    if (above > 34) { d.vx += (dx / dh) * 25; d.vz += (dz / dh) * 25; }
    d.life = Math.max(d.life, 1.5);
    return true;
  }
  return false;
}

// ---------- Earthquake ----------
const quakes = [];
function startQuake() {
  const hit = aim(300);
  const c = hit ? hit.point.clone() : player.pos.clone();
  sfx.quake();
  quakes.push({ c, t: 0, dur: 6, tick: 0, cracks: Array.from({ length: 7 }, () => ({ a: rand(Math.PI * 2), len: 0 })) });
}

function updateQuakes(dt) {
  for (let i = quakes.length - 1; i >= 0; i--) {
    const q = quakes[i];
    q.t += dt;
    const power = Math.sin((Math.PI * Math.min(q.t, q.dur)) / q.dur);
    addShake(q.c, 1.1 * power, 100);
    q.tick -= dt;
    while (q.tick <= 0) {
      q.tick += 0.05;
      // Spreading fissures
      for (const cr of q.cracks) {
        if (cr.len > 36) continue;
        cr.len += 0.7;
        cr.a += rand(-0.12, 0.12);
        const px = q.c.x + Math.cos(cr.a) * cr.len, pz = q.c.z + Math.sin(cr.a) * cr.len;
        for (let w = -1; w <= 1; w++) {
          const x = Math.floor(px - Math.sin(cr.a) * w), z = Math.floor(pz + Math.cos(cr.a) * w);
          const top = groundY(x, z);
          const depth = 2 + Math.floor(rand(4)) - Math.abs(w);
          for (let y = top - 1; y >= Math.max(1, top - depth); y--) {
            const m = get(x, y, z);
            if (!m || m === M.BEDROCK) continue;
            const b = getBurn(x, y, z);
            removeCell(x, y, z);
            if (m === M.WATER || Math.random() > 0.35) continue;
            voxelColor(x, y, z, m, b, _c);
            spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, rand(-2, 2), rand(3, 8), rand(-2, 2), rand(2, 4));
          }
        }
      }
      // Buildings crumble
      for (let s = 0; s < 40; s++) {
        const a = rand(Math.PI * 2), r = Math.sqrt(Math.random()) * 32;
        const x = Math.floor(q.c.x + Math.cos(a) * r), z = Math.floor(q.c.z + Math.sin(a) * r);
        for (let y = 1; y < H; y++) {
          const m = get(x, y, z);
          if (!m || TERRAIN_MATS.has(m) || Math.random() > 0.06 * power) continue;
          const b = getBurn(x, y, z);
          if (m === M.TNT) tntQueue.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, t: rand(0.1, 1) });
          removeCell(x, y, z);
          voxelColor(x, y, z, m, b, _c);
          spawnDebris(x + 0.5, y + 0.5, z + 0.5, _c, rand(-2, 2), rand(0, 2), rand(-2, 2));
        }
      }
      collapsePending = true;
      // Shake loose debris and dust
      for (const d of debris) if (d.vy === 0 && Math.hypot(d.x - q.c.x, d.z - q.c.z) < 40 && Math.random() < 0.3) d.vy = rand(2, 6) * power;
      if (Math.random() < 0.5) {
        const a = rand(Math.PI * 2), r = rand(30);
        const x = q.c.x + Math.cos(a) * r, z = q.c.z + Math.sin(a) * r;
        spawnParticle({ pos: new THREE.Vector3(x, groundY(Math.floor(x), Math.floor(z)) + 0.5, z), vel: new THREE.Vector3(rand(-1, 1), rand(0.5, 2), rand(-1, 1)), life: rand(1.5, 2.5), s0: 0.8, s1: 2.5, color: 0xa08a6a, alpha: 0.4, drag: 1 });
      }
    }
    if (player.onGround && Math.hypot(player.pos.x - q.c.x, player.pos.z - q.c.z) < 45 && Math.random() < 0.08 * power) player.vel.y += rand(2, 4);
    if (q.t >= q.dur) quakes.splice(i, 1);
  }
}

// ---------- TNT placer ----------
function placeTNT() {
  swing = 0;
  const hit = aim(8);
  if (!hit) return;
  const x = hit.x + hit.normal.x, y = hit.y + hit.normal.y, z = hit.z + hit.normal.z;
  const m = get(x, y, z);
  if (y < 0 || y >= H || (m && m !== M.WATER)) return;
  const p = player.pos;
  if (x + 1 > p.x - PW && x < p.x + PW && z + 1 > p.z - PW && z < p.z + PW && y + 1 > p.y && y < p.y + PH) return;
  setVoxel(x, y, z, M.TNT);
  sfx.place();
}

function lightTNT() {
  const hit = aim(8);
  if (hit && get(hit.x, hit.y, hit.z) === M.TNT) {
    ignite(hit.x, hit.y, hit.z);
    spawnParticle({ pos: hit.point.clone(), vel: new THREE.Vector3(0, 2, 0), life: 0.4, s0: 0.2, s1: 0.05, color: 0xffc040, additive: true });
    return true;
  }
  return false;
}

// ---------- Extra view models ----------
let vmSpin = 0;
function addViewModel(name, build, pos = [0.3, -0.26, -0.55]) {
  const g = new THREE.Group();
  build(g);
  g.position.set(pos[0], pos[1], pos[2]);
  g.userData.base = g.position.clone();
  g.visible = false;
  viewModels[name] = g;
  vmScene.add(g);
}
addViewModel('minigun', (g) => {
  const spin = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    spin.add(cyl(0.017, 0.5, lam(0x444a52), Math.cos(a) * 0.045, Math.sin(a) * 0.045, -0.27));
  }
  spin.add(cyl(0.075, 0.04, lam(0x2a2d33), 0, 0, -0.45), cyl(0.075, 0.04, lam(0x2a2d33), 0, 0, -0.15));
  g.add(spin, box(0.15, 0.15, 0.22, lam(0x3a3f47), 0, 0, 0.06), box(0.05, 0.13, 0.05, lam(0x2a2d33), 0, -0.12, 0.12), box(0.08, 0.1, 0.12, lam(0x5a4a20), -0.11, -0.03, 0.05));
  g.userData.spin = spin;
}, [0.3, -0.27, -0.5]);
addViewModel('shotgun', (g) => {
  g.add(cyl(0.024, 0.6, lam(0x3a3d42), -0.026, 0, -0.25), cyl(0.024, 0.6, lam(0x3a3d42), 0.026, 0, -0.25));
  g.add(box(0.07, 0.09, 0.32, lam(0x7a4a24), 0, -0.03, 0.2), box(0.085, 0.06, 0.16, lam(0x5a3a1a), 0, -0.05, -0.12));
});
addViewModel('grenade', (g) => {
  g.add(cyl(0.065, 0.45, lam(0x4a5a3a), 0, 0, -0.2), cyl(0.1, 0.12, lam(0x333333), 0, -0.02, 0.06), box(0.05, 0.13, 0.06, lam(0x2a2d33), 0, -0.12, 0.12));
  g.add(ball(0.05, lam(0x3a4a2a), 0, 0, -0.44));
});
addViewModel('c4', (g) => {
  g.add(box(0.17, 0.06, 0.11, lam(0xd8cfa8)), box(0.17, 0.065, 0.015, lam(0x333333), 0, 0, 0.02));
  g.add(box(0.06, 0.03, 0.05, lam(0x222222), 0.03, 0.045, 0), ball(0.012, basic(0xff2020), 0.05, 0.065, 0));
  g.rotation.set(0.4, -0.4, 0);
}, [0.27, -0.25, -0.48]);
addViewModel('flamethrower', (g) => {
  g.add(cyl(0.065, 0.3, lam(0xb03020), 0, -0.04, 0.12, 'y'), cyl(0.026, 0.5, lam(0x666666), 0, 0.03, -0.22));
  g.add(box(0.05, 0.12, 0.05, lam(0x2a2d33), 0, -0.1, -0.02), ball(0.022, basic(0x4aa0ff), 0, 0.03, -0.48));
});
addViewModel('lightning', (g) => {
  const staff = cyl(0.016, 0.75, lam(0x5a3a1a), 0, 0, 0, 'y');
  staff.rotation.x = -0.5;
  g.add(staff, ball(0.06, basic(0xbfe0ff), 0, 0.33, -0.18), ball(0.09, new THREE.MeshBasicMaterial({ color: 0x6aa8ff, transparent: true, opacity: 0.35 }), 0, 0.33, -0.18));
}, [0.3, -0.38, -0.62]);
addViewModel('meteor', (g) => {
  g.add(ball(0.09, basic(0xff7a20)));
  for (let i = 0; i < 6; i++) g.add(box(0.06, 0.06, 0.06, lam(0x3a2a20), rand(-0.07, 0.07), rand(-0.07, 0.07), rand(-0.07, 0.07)));
}, [0.28, -0.24, -0.5]);
addViewModel('airstrike', (g) => {
  g.add(box(0.11, 0.19, 0.06, lam(0x3b4a2c)), cyl(0.006, 0.2, lam(0x222222), 0.035, 0.19, 0, 'y'), box(0.07, 0.05, 0.005, basic(0x60ff80), 0, 0.04, 0.032));
  g.rotation.set(0.4, -0.3, 0);
}, [0.25, -0.24, -0.45]);
addViewModel('drill', (g) => {
  g.add(cyl(0.08, 0.28, lam(0xe0b020), 0, 0, 0.02), box(0.05, 0.13, 0.06, lam(0x2a2d33), 0, -0.12, 0.08));
  const bit = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 8), lam(0x8a9098));
  cone.rotation.x = -Math.PI / 2;
  bit.add(cone);
  bit.position.z = -0.25;
  g.add(bit);
  g.userData.spin = bit;
});
addViewModel('forcepush', (g) => {
  g.add(box(0.12, 0.1, 0.2, lam(0x30343c)));
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.008, 6, 24), basic(0x7fd0ff));
    r.position.z = -0.12 - i * 0.06;
    g.add(r);
  }
});
addViewModel('freeze', (g) => {
  g.add(box(0.1, 0.12, 0.4, lam(0xdde8f0)), cyl(0.04, 0.26, lam(0x88a4b8), 0, 0.01, -0.3), box(0.05, 0.14, 0.06, lam(0x5a6a78), 0, -0.1, 0.1));
  g.add(ball(0.045, basic(0x80e0ff), 0, 0.01, -0.45));
});
addViewModel('tornado', (g) => {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0x9a948a, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  cone.rotation.x = Math.PI;
  g.add(cone);
  g.userData.spin = cone;
  g.userData.spinAxis = 'y';
}, [0.28, -0.22, -0.5]);
addViewModel('earthquake', (g) => {
  g.add(box(0.15, 0.1, 0.15, lam(0x8a6a2a)), cyl(0.012, 0.16, lam(0x777777), 0, 0.12, 0, 'y'), box(0.12, 0.02, 0.03, lam(0x333333), 0, 0.2, 0));
  g.rotation.set(0.3, -0.4, 0);
}, [0.27, -0.27, -0.5]);
addViewModel('tntplacer', (g) => {
  g.add(box(0.15, 0.15, 0.15, lam(0xe8241c)), box(0.155, 0.045, 0.155, lam(0xeeeeee)));
  g.rotation.set(0.3, 0.5, 0);
}, [0.28, -0.25, -0.5]);

// ============================================================================
// HUD & input
// ============================================================================
const hotbar = document.getElementById('hotbar');
const toolNameEl = document.getElementById('tool-name');
const toolDescEl = document.getElementById('tool-desc');
const overlay = document.getElementById('overlay');
const waterEl = document.getElementById('water');
const flyEl = document.getElementById('fly');
const invEl = document.getElementById('inventory');
const invGrid = document.getElementById('inv-grid');
const invName = document.getElementById('inv-name');
const invDesc = document.getElementById('inv-desc');
const canvas = renderer.domElement;
let locked = false;
let invOpen = false;
let hoveredTool = null;

function saveHotbar() {
  try { localStorage.setItem('voxel.hotbar', JSON.stringify(hotbarSlots)); } catch { /* ignore */ }
}

function renderHotbar() {
  hotbar.innerHTML = '';
  hotbarSlots.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'slot' + (i === activeSlot ? ' active' : '');
    b.dataset.tool = t;
    b.innerHTML = `<span class="key">${i + 1}</span><span class="icon">${TOOLS[t].icon}</span><span class="label">${TOOLS[t].name}</span>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); selectSlot(i); });
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      const tool = e.dataTransfer.getData('text/plain');
      if (TOOLS[tool]) assignSlot(i, tool);
    });
    hotbar.appendChild(b);
  });
}

function selectSlot(i) {
  activeSlot = i;
  selectTool(hotbarSlots[i]);
}

function assignSlot(i, tool) {
  const j = hotbarSlots.indexOf(tool);
  if (j >= 0 && j !== i) hotbarSlots[j] = hotbarSlots[i]; // swap instead of duplicating
  hotbarSlots[i] = tool;
  saveHotbar();
  selectSlot(i);
  renderInventory();
}

function selectTool(name) {
  if (!TOOLS[name]) return;
  const slot = hotbarSlots.indexOf(name);
  if (slot >= 0 && hotbarSlots[activeSlot] !== name) activeSlot = slot;
  currentTool = name;
  for (const k in viewModels) viewModels[k].visible = k === name;
  toolNameEl.textContent = `${TOOLS[name].icon} ${TOOLS[name].name}`;
  toolDescEl.textContent = TOOLS[name].desc;
  cooldown = Math.min(cooldown, 0.15);
  renderHotbar();
}

function renderInventory() {
  invGrid.innerHTML = '';
  const cats = [];
  for (const id of TOOL_IDS) if (!cats.includes(TOOLS[id].cat)) cats.push(TOOLS[id].cat);
  for (const cat of cats) {
    const h = document.createElement('div');
    h.className = 'inv-cat';
    h.textContent = cat;
    invGrid.appendChild(h);
    const row = document.createElement('div');
    row.className = 'inv-row';
    for (const id of TOOL_IDS.filter((t) => TOOLS[t].cat === cat)) {
      const t = TOOLS[id];
      const card = document.createElement('button');
      card.className = 'inv-tool' + (hotbarSlots.includes(id) ? ' equipped' : '') + (id === currentTool ? ' current' : '');
      card.draggable = true;
      card.innerHTML = `<span class="icon">${t.icon}</span><span class="label">${t.name}</span>`;
      card.addEventListener('click', () => assignSlot(activeSlot, id));
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', id));
      card.addEventListener('mouseenter', () => { hoveredTool = id; showInfo(id); });
      card.addEventListener('mouseleave', () => { hoveredTool = null; showInfo(currentTool); });
      row.appendChild(card);
    }
    invGrid.appendChild(row);
  }
  showInfo(hoveredTool || currentTool);
}

function showInfo(id) {
  invName.textContent = `${TOOLS[id].icon} ${TOOLS[id].name}`;
  invDesc.textContent = TOOLS[id].desc;
}

function openInventory() {
  invOpen = true;
  firing = false;
  keys.clear();
  renderInventory();
  invEl.classList.remove('hidden');
  overlay.classList.add('hidden');
  document.body.classList.add('inv-open');
  if (locked) document.exitPointerLock();
}

function closeInventory() {
  invOpen = false;
  hoveredTool = null;
  invEl.classList.add('hidden');
  document.body.classList.remove('inv-open');
  overlay.classList.toggle('hidden', locked);
  requestLock();
}

function requestLock() {
  ac();
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => overlay.classList.remove('hidden'));
  } catch { overlay.classList.remove('hidden'); }
}
document.getElementById('play').addEventListener('click', requestLock);
document.getElementById('inv-close').addEventListener('click', closeInventory);
canvas.addEventListener('click', () => { if (!locked && !invOpen) requestLock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  overlay.classList.toggle('hidden', locked || invOpen);
  if (!locked) { firing = false; keys.clear(); }
});

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  // Chrome sometimes reports one huge jump right after the pointer locks; ignore it
  if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = clamp(player.pitch - e.movementY * 0.0022, -1.55, 1.55);
});
document.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button === 2) {
    if (!(currentTool === 'tntplacer' && lightTNT())) detonateC4();
    return;
  }
  if (e.button !== 0) return;
  firing = true;
  fire();
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (!locked) return;
  selectSlot((activeSlot + (e.deltaY > 0 ? 1 : -1) + 9) % 9);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (invOpen) {
    if (e.code === 'KeyE' || e.code === 'Escape') { e.preventDefault(); closeInventory(); }
    else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5)) - 1;
      if (n >= 0 && n < 9) { if (hoveredTool) assignSlot(n, hoveredTool); else selectSlot(n); }
    }
    return;
  }
  if (!locked) return;
  keys.add(e.code);
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5)) - 1;
    if (n >= 0 && n < 9) selectSlot(n);
  }
  if (e.code === 'KeyE') openInventory();
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
  fires.clear();
  tornadoes.length = 0;
  quakes.length = 0;
  for (const pl of planes) scene.remove(pl.mesh);
  planes.length = 0;
  touched = [];
  collapsePending = false;
}

let worldSeed = 0;
function resetWorld(seed = (Math.random() * 1e9) | 0) {
  clearDynamic();
  for (const key of [...sectionMeshes.keys(), ...waterMeshes.keys()]) dropSection(key);
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
selectSlot(0);
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
  if (firing && !TOOLS[currentTool].hold && cooldown <= 0) fire();

  // Camera
  camera.position.copy(player.pos);
  camera.position.y += EYE + stepSmooth;
  shake = Math.max(0, shake - dt * 1.1);
  const s = shake * shake * 0.6;
  camera.position.x += rand(-s, s); camera.position.y += rand(-s, s); camera.position.z += rand(-s, s);
  camera.rotation.set(player.pitch + rand(-s, s) * 0.05, player.yaw, 0);
  camera.updateMatrixWorld();

  updateLaser(dt);
  updateFlamethrower(dt);
  updateFires(dt);
  updateTornadoes(dt);
  updateQuakes(dt);
  updatePlanes(dt);
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
  if (vm.userData.spin) {
    const spinning = currentTool === 'tornado' || (firing && currentTool !== 'drill') || vmSpin > 0;
    vm.userData.spin.rotation[vm.userData.spinAxis || 'z'] += dt * (spinning ? 25 : 2);
  }
  vmSpin = Math.max(0, vmSpin - dt * 4);

}

function render() {
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
}

function frame() {
  update(Math.min(clock.getDelta(), 1 / 20));
  if (smoothMats) smoothMats.tick(clock.elapsedTime);
  if (skyDome) { skyDome.position.copy(camera.position); skyDome.material.uniforms.uTime.value = clock.elapsedTime; }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Hooks for automated tests / console fun
window.voxelGame = {
  player, stats, keys, selectTool, resetWorld,
  setActive: (v) => { testHooks.active = v; },
  fire: (tool) => { if (tool) selectTool(tool); cooldown = 0; fire(); },
  detonateC4, openInventory, closeInventory, assignSlot,
  get fires() { return fires.size; },
  getBlock: get, M, aim: (d) => aim(d), camera,
  get hotbar() { return hotbarSlots.slice(); },
  setFiring: (v) => { firing = v; },
  setLook: (yaw, pitch) => { player.yaw = yaw; player.pitch = pitch; },
  advance: (sec) => { for (let t = 0; t < sec; t += 1 / 30) update(1 / 30); render(); },
  blast: (x, y, z, r) => explode(new THREE.Vector3(x, y, z), r, { force: 5, debrisChance: 0.3 }),
  get seed() { return worldSeed; },
  get sections() { return sectionMeshes.size; },
  get bodies() { return bodies.length; },
};
