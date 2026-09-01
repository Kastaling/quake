/**
 * ============================================================================
 *  game.js — Three.js client for the Quake arena // zombie siege server
 * ============================================================================
 *  - First-person renderer: retro grid arena, cover blocks, ramps, central
 *    platform with the two interactive buttons (overhead cooldown meters),
 *    pickups, remote players and zombies.
 *  - Interpolation / extrapolation: remote entity positions are sampled from a
 *    ring buffer of server snapshots at a render delay (120 ms) with capped
 *    velocity extrapolation when data runs out. The local player camera is fully
 *    decoupled from the network: snapshot data only writes an internal target
 *    object (targetPlayerPos), and the frame loop smoothly lerps the local feet
 *    position toward it — no snapshot ever touches the camera transform directly.
 *  - Camera matrix sanitization: every snapshot value that feeds the camera is
 *    validated with Number.isFinite; NaN/undefined samples fall back to the last
 *    known-good coordinates (prevents the dark-screen bug from corrupt data).
 *    The frame loop is the ONLY writer of camera.position / camera.rotation, and
 *    camera.updateProjectionMatrix() runs only via handleResize() — on window
 *    resize events or the deferred pointer-lock resync (rAF-guarded against
 *    zero viewport dimensions).
 *  - Input listeners: pointer lock mouse look, WASD + jump, fire hold,
 *    weapon switching (keys 1-7 / wheel). Input is streamed to the server at
 *    display rate; the server stays authoritative.
 *  - Speed feedback: horizontal speed estimated from snapshot deltas drives
 *    viewmodel bob intensity and the HUD SPEED readout (so air strafe / bhop
 *    build-up is visible).
 *  - Audio triggers into sounds.js (positional Web Audio synth).
 *  - Weapon VFX: the Lightning Gun renders a continuous cyan shaft from the
 *    viewmodel muzzle to its hit point (or max range) while firing, with
 *    per-frame vertex jitter and opacity flicker that vanish the instant
 *    firing stops. Railgun hitlines persist as core+halo beam meshes that fade
 *    smoothly over 1.0 s before being removed from the scene.
 * ============================================================================
 */

import * as THREE from 'three';
import SFX from './sounds.js';

/* ============================== DOM / HUD REFS ============================= */

const canvas = document.getElementById('game');
const el = {
  hpNum: document.getElementById('hpNum'),
  hpFill: document.getElementById('hpFill'),
  wpnName: document.getElementById('wpnName'),
  ammoNum: document.getElementById('ammoNum'),
  weaponStrip: document.getElementById('weaponStrip'),
  speedNum: document.getElementById('speedNum'),
  nukeMeter: document.getElementById('nukeMeter'),
  inhibitTimer: document.getElementById('inhibitTimer'),
  killfeed: document.getElementById('killfeed'),
  vignette: document.getElementById('damageVignette'),
  deathOverlay: document.getElementById('deathOverlay'),
  deathCount: document.getElementById('deathCount'),
  lockOverlay: document.getElementById('lockOverlay'),
  netStatus: document.getElementById('netStatus'),
  chatBox: document.getElementById('chat-box'),
  chatLog: document.getElementById('chat-log'),
  chatInput: document.getElementById('chat-input'),
};

const WEAPON_SHORT = ['AR', 'SGT', 'SSG', 'GL', 'RL', 'LG', 'RG'];
const AMMO_POOL_IDX = [0, 1, 1, 2, 3, 4, 5]; // rifle, shells, shells, nades, rockets, cells, rail

/* ============================== GAME STATE ================================= */

let socket = null;
let me = null;                 // my player id (from init)
let myName = `QZ-${Math.floor(100 + Math.random() * 900)}`;
let worldMap = null;           // map data from 'init'
let weaponDefs = [];           // weapon list from 'init'

const players3d = new Map();   // id -> { group, hpFill, nameSprite }
const zombies3d = new Map();   // id -> { group, typeIdx }
const projectiles3d = new Map();// id -> { mesh, trail, kind }
const pickups3d = new Map();   // id -> { group, baseY }
let button3d = {};             // 'nuke' | 'inhibit' -> { group, fill, dome, light, label }

/* --- snapshot interpolation buffer ------------------------------------------ */
const snapBuf = [];            // recent raw snapshots (for HUD / latest state)
const entBuf = new Map();      // entity id -> [{t, v}] ring of samples
const INTERP_DELAY = 0.12;     // render delay for remote entities
const SELF_DELAY = 0.045;      // shorter delay for the local player (shake-distance sampling)
const EYE_HEIGHT = 1.6;        // camera height above feet (mirrors server EYE)
const BASE_FOV = 78;           // resting field of view
// Local-player smoothing: framerate-independent exponential lerp rate toward
// targetPlayerPos (time constant ~33 ms), so the camera glides between the
// 30 Hz snapshots instead of stepping at network rate.
const SELF_SMOOTH_RATE = 30;

let latestState = null;        // most recent snapshot (HUD source)

/* --- local player network target / smoothed position ------------------------ */
// Decoupling contract: socket snapshot data may ONLY write into `targetPlayerPos`
// (validated in pushSnapshot). It never touches camera.position/rotation or any
// matrix. The rAF frame loop is the single writer of the camera transform: each
// frame it lerps `localPos` toward `targetPlayerPos`, then syncs
//   camera.position.set(localPos.x, localPos.y + EYE_HEIGHT, localPos.z)
const targetPlayerPos = { x: 0, y: 0, z: 24 }; // latest server feet position for me
const localPos = new THREE.Vector3(0, 0, 24);   // smoothed feet position (frame-loop owned)

/* --- input ------------------------------------------------------------------ */
const keys = Object.create(null);
let yaw = 0, pitch = 0;
let firing = false;
let weaponIdx = 0;
let locked = false;
let chatOpen = false;          // in-game chat overlay state (session-only, never persisted)
let selfSpeed = 0;             // smoothed horizontal speed estimate (u/s) from snapshots

/* --- effects state ----------------------------------------------------------- */
let vignetteAlpha = 0;
let shakeT = 0, shakeMag = 0;
const tracers = [];            // { line, life, maxLife }
const booms = [];              // { mesh, light, t, dur, r }
const particles = [];          // { mesh, vx, vy, vz, life, maxLife }
const railBeams = [];          // { core, halo, t, dur } — persistent railgun beams fading over 1.0 s
let lgBeam = null;             // { outer, inner } — continuous local Lightning Gun shaft while firing

// Weapon VFX tuning (mirror the server weapon definitions)
const LG_RANGE = 90;           // Lightning Gun max range (server: range 90)
const RAIL_TRAIL_LIFE = 1.0;   // seconds a railgun beam persists before removal

/* ============================== THREE SETUP ================================ */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
scene.fog = new THREE.Fog(0x05070d, 35, 100);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 250);
camera.rotation.order = 'YXZ';
// (the pre-join pose is applied on the first frame — see animate() — so that the
// rAF loop remains the only writer of camera.position)

scene.add(new THREE.HemisphereLight(0x4a5f8a, 0x0c0f14, 0.95));
// Global ambient fill so environmental geometry stays evenly lit on Metal/macOS WebGL drivers.
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xbfd4ff, 0.8);
sun.position.set(24, 42, 18);
scene.add(sun);

// the camera must live in the scene graph for its children (viewmodel) to render
scene.add(camera);

/**
 * Safe canvas resize: re-sync the projection matrix and drawing buffer to the
 * real viewport. Zero dimensions are aborted immediately — a zero-size
 * viewport would build a degenerate (zero) projection matrix and crash WebGL.
 * updateStyle=false so CSS keeps owning the element layout; only the drawing
 * buffer is resized here.
 */
function handleResize() {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  if (w === 0 || h === 0) return; // abort: prevent WebGL zero-matrix crashes

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

window.addEventListener('resize', handleResize);

/* ============================== MATERIALS ================================== */

const MAT = {
  solid: new THREE.MeshLambertMaterial({ color: 0x39424e }),
  platform: new THREE.MeshLambertMaterial({ color: 0x2c3a55, emissive: 0x0a1226 }),
  ramp: new THREE.MeshLambertMaterial({ color: 0x333d49 }),
  wall: new THREE.MeshLambertMaterial({ color: 0x1b222c, emissive: 0x050708 }),
  nukeDome: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
  inhibitDome: new THREE.MeshBasicMaterial({ color: 0x3ba7ff }),
  meterFrame: new THREE.MeshBasicMaterial({ color: 0x11151c, side: THREE.DoubleSide }),
  meterFillNuke: new THREE.MeshBasicMaterial({ color: 0xffb02e, side: THREE.DoubleSide }),
  meterFillInhibit: new THREE.MeshBasicMaterial({ color: 0x39d98a, side: THREE.DoubleSide }),
  health: new THREE.MeshLambertMaterial({ color: 0x2ecc40, emissive: 0x115522 }),
  ammoCrate: new THREE.MeshLambertMaterial({ color: 0xd69e2e, emissive: 0x3a2a08 }),
  rocket: new THREE.MeshBasicMaterial({ color: 0xff7b24 }),
  grenade: new THREE.MeshBasicMaterial({ color: 0xa8e05f }),
  trail: new THREE.LineBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.6 }),
};

const ZOMBIE_STYLE = [
  { body: 0x2d4a1e, eye: 0xd8ff5a, scale: 1.0 },   // walker
  { body: 0x3c2a4a, eye: 0xff7bd5, scale: 0.85 },  // runner
  { body: 0x4a1e1e, eye: 0xffb02e, scale: 1.6 },   // brute
];

/* ============================== WORLD BUILDING ============================= */

function makeGridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0e16';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3500; i++) {
    g.fillStyle = `rgba(140,180,255,${Math.random() * 0.04})`;
    g.fillRect(Math.floor(Math.random() * 512), Math.floor(Math.random() * 512), 1, 1);
  }
  const cells = 40; // 80 world units / 2u cell
  const px = 512 / cells;
  g.strokeStyle = 'rgba(70,160,255,0.22)';
  g.lineWidth = 1;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * px);
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
  }
  g.strokeStyle = 'rgba(70,220,255,0.35)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 510, 510);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; // crisp retro pixels
  return tex;
}

function makeTextSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(2.4, 0.6, 1);
  return spr;
}

/** Replace a sprite's text (disposes the old texture). */
function setSpriteText(sprite, text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.map = tex;
  sprite.material.needsUpdate = true;
}

function buildWorld(map) {
  worldMap = map;
  const H = map.arenaHalf;

  // ground plane with retro grid texture
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2),
    new THREE.MeshLambertMaterial({ map: makeGridTexture() }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // perimeter walls (visual)
  const wallGeoH = new THREE.BoxGeometry(H * 2 + 1, 3.4, 0.8);
  const wallGeoV = new THREE.BoxGeometry(0.8, 3.4, H * 2 + 1);
  [[wallGeoH, 0, -H], [wallGeoH, 0, H]].forEach(([geo, x, z]) => {
    const m = new THREE.Mesh(geo, MAT.wall);
    m.position.set(x, 1.7, z); scene.add(m);
  });
  [[wallGeoV, -H, 0], [wallGeoV, H, 0]].forEach(([geo, x, z]) => {
    const m = new THREE.Mesh(geo, MAT.wall);
    m.position.set(x, 1.7, z); scene.add(m);
  });

  // static solids: first entry is the central platform (distinct material)
  map.solids.forEach((s, i) => {
    const [minX, maxX, minZ, maxZ, top] = s;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(maxX - minX, top, maxZ - minZ),
      i === 0 ? MAT.platform : MAT.solid);
    m.position.set((minX + maxX) / 2, top / 2, (minZ + maxZ) / 2);
    scene.add(m);
  });

  // ramps leading to the central platform (one per side), matching server slopes
  const [PH, PT, RL, RW] = map.plat;
  for (const d of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]]) {
    const pTop = new THREE.Vector3(d[0] * PH, PT, d[2] * PH);
    const pBot = new THREE.Vector3(d[0] * (PH + RL), 0, d[2] * (PH + RL));
    const sV = pBot.clone().sub(pTop).normalize();            // down-slope direction
    const tV = new THREE.Vector3(0, 1, 0).cross(sV).normalize(); // horizontal tangent
    let nV = tV.clone().cross(sV);                             // slope normal
    if (nV.y < 0) nV.negate();
    const mid = pTop.clone().add(pBot).multiplyScalar(0.5).sub(nV.clone().multiplyScalar(0.15));
    const m4 = new THREE.Matrix4().makeBasis(tV, nV, sV);
    m4.setPosition(mid.x, mid.y, mid.z);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(RW * 2, 0.3, pTop.distanceTo(pBot)), MAT.ramp);
    ramp.quaternion.setFromRotationMatrix(m4);
    scene.add(ramp);
  }

  // interactive buttons with overhead cooldown meters
  for (const b of map.buttons) {
    const isNuke = b.id === 'nuke';
    const color = isNuke ? 0xff3b30 : 0x3ba7ff;
    const group = new THREE.Group();

    const platTop = map.plat[1]; // central platform surface height
    const base = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r * 1.2, 0.25, 24), MAT.solid);
    base.position.y = platTop + 0.125 - b.y; // sits on the platform top (group origin is dome center)
    group.add(base);

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(b.r * 0.62, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      isNuke ? MAT.nukeDome : MAT.inhibitDome);
    dome.position.y = platTop + 0.25 - b.y; // hemisphere base rests on the button base
    group.add(dome);

    const light = new THREE.PointLight(color, 1.4, 12);
    light.position.set(0, 0.6, 0);
    group.add(light);

    // overhead meter: frame + left-anchored fill (scale.x = fraction)
    const meter = new THREE.Group();
    meter.position.y = 2.3;
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.4), MAT.meterFrame);
    meter.add(frame);
    const fillGeo = new THREE.PlaneGeometry(2.3, 0.24).translate(1.15, 0, 0.001);
    const fill = new THREE.Mesh(fillGeo, isNuke ? MAT.meterFillNuke : MAT.meterFillInhibit);
    meter.add(fill);
    group.add(meter);

    const label = makeTextSprite(isNuke ? 'NUKE' : 'INHIBIT', isNuke ? '#ff6a5e' : '#6ac2ff');
    label.position.y = 3.0;
    group.add(label);

    group.position.set(b.x, b.y, b.z);
    scene.add(group);
    button3d[b.id] = { group, meter, fill, dome, light };
  }

  // pickups: health crosses + ammo crates (visibility driven by snapshots)
  for (const [id, kind, x, y, z] of map.pickups) {
    const group = new THREE.Group();
    if (kind === 'health') {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.18), MAT.health);
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.18), MAT.health);
      group.add(a, b2);
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), MAT.ammoCrate);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.12, 0.74), MAT.solid);
      group.add(box, band);
    }
    group.position.set(x, y + 0.55, z);
    scene.add(group);
    pickups3d.set(id, { group, baseY: y + 0.55 });
  }

  // build the weapon strip HUD from server definitions
  el.weaponStrip.innerHTML = '';
  weaponDefs.forEach((w, i) => {
    const slot = document.createElement('div');
    slot.className = 'wpn-slot';
    slot.id = `wpnSlot${i}`;
    slot.innerHTML = `<span class="key">${i + 1}</span><span class="abbr">${WEAPON_SHORT[i]}</span><span class="wammo" id="wAmmo${i}">-</span>`;
    slot.addEventListener('click', () => switchWeapon(i));
    el.weaponStrip.appendChild(slot);
  });
}

/* ============================== ENTITY FACTORIES =========================== */

function makePlayerMesh(id) {
  const isSelf = id === me; // local player instance: its world model must never render
  const hue = (id * 0.37 + 0.55) % 1;
  const color = new THREE.Color().setHSL(hue, 0.65, 0.5);
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.75, 4, 12),
    new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.95;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10),
    new THREE.MeshLambertMaterial({ color: color.clone().offsetHSL(0, 0, 0.12) }));
  head.position.y = 1.78;
  group.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xdff3ff }));
  visor.position.set(0, 1.8, -0.26); // faces -Z at yaw 0 (matches server forward)
  group.add(visor);

  // Hide the local player's own body/head character mesh: the camera sits exactly
  // at this position (feet + EYE_HEIGHT), so an active self mesh would put the eye
  // inside a rendered volume and occlude the whole view. The remote-player loop
  // skips `me` entirely; this is a second, belt-and-braces guard for any code path
  // that does build a self instance — it must never render.
  if (isSelf) {
    body.visible = false;
    head.visible = false;
    visor.visible = false;
  }

  const nameSprite = makeTextSprite('?', '#cfe8ff');
  nameSprite.position.y = 2.35;
  group.add(nameSprite);

  // overhead hp bar (left-anchored fill)
  const hpFrame = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.16), MAT.meterFrame);
  hpFrame.position.y = 2.08;
  group.add(hpFrame);
  const hpFillGeo = new THREE.PlaneGeometry(1.3, 0.09).translate(0.65, 0, 0.001);
  const hpFill = new THREE.Mesh(hpFillGeo, new THREE.MeshBasicMaterial({ color: 0x4dff88, side: THREE.DoubleSide }));
  hpFill.position.y = 2.08;
  group.add(hpFill);

  scene.add(group);
  return { group, hpFill, nameSprite, name: '' };
}

function makeZombieMesh(typeIdx) {
  const st = ZOMBIE_STYLE[typeIdx] || ZOMBIE_STYLE[0];
  const s = st.scale;
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: st.body });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62 * s, 1.35 * s, 0.45 * s), bodyMat);
  body.position.y = 0.78 * s;
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4 * s, 0.36 * s, 0.4 * s), bodyMat);
  head.position.y = 1.62 * s;
  group.add(head);

  const eyeGeo = new THREE.SphereGeometry(0.055 * Math.max(s, 0.8), 8, 6);
  // depthWrite off + additive blending + high renderOrder so the glowing eyes
  // always draw above the head mesh even when embedded in it (Metal/macOS WebGL).
  const eyeMat = new THREE.MeshBasicMaterial({ color: st.eye, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const e1 = new THREE.Mesh(eyeGeo, eyeMat); e1.position.set(-0.1 * s, 1.66 * s, -0.21 * s); e1.renderOrder = 999;
  const e2 = new THREE.Mesh(eyeGeo, eyeMat); e2.position.set(0.1 * s, 1.66 * s, -0.21 * s); e2.renderOrder = 999;
  group.add(e1, e2);

  // shambling arms reaching forward
  const armGeo = new THREE.BoxGeometry(0.14 * s, 0.5 * s, 0.14 * s);
  const a1 = new THREE.Mesh(armGeo, bodyMat); a1.position.set(-0.42 * s, 1.05 * s, -0.3 * s); a1.rotation.x = -0.9;
  const a2 = new THREE.Mesh(armGeo, bodyMat); a2.position.set(0.42 * s, 1.05 * s, -0.3 * s); a2.rotation.x = -0.9;
  group.add(a1, a2);

  scene.add(group);
  return { group };
}

function makeProjectileMesh(kind) {
  const isRocket = kind === 'rocket';
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(isRocket ? 0.17 : 0.14, 12, 10),
    isRocket ? MAT.rocket : MAT.grenade);
  scene.add(mesh);

  // short fading trail line (history of recent positions)
  const N = 8;
  const pos = new Float32Array(N * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const trail = new THREE.Line(geo, MAT.trail.clone());
  scene.add(trail);

  return { mesh, trail, kind: isRocket ? 'rocket' : 'grenade', hist: [] };
}

/* ============================== INTERPOLATION ============================== */

function pushSnapshot(data) {
  const t = performance.now() / 1000;
  snapBuf.push({ t, data });
  if (snapBuf.length > 45) snapBuf.shift();
  latestState = data;

  for (const key of ['p', 'z', 'pr']) {
    for (const e of data[key]) {
      let b = entBuf.get(e[0]);
      if (!b) { b = []; entBuf.set(e[0], b); }
      b.push({ t, v: e });
      while (b.length && t - b[0].t > 1.2) b.shift(); // keep ~1.2 s of history
    }
  }
  const live = new Set([...data.p, ...data.z, ...data.pr].map((e) => e[0]));
  for (const id of [...entBuf.keys()]) if (!live.has(id)) entBuf.delete(id);

  // Local player network target — the ONLY thing snapshot data may write directly.
  // Validated here so NaN/undefined can never reach the lerp or the camera in the
  // frame loop; feet are clamped at the floor plane (y >= 0). No camera.position,
  // no camera.rotation, no matrix updates happen anywhere in this path.
  if (me != null) {
    const self = data.p.find((e) => e[0] === me);
    if (self && isFiniteNum(self[1]) && isFiniteNum(self[2]) && isFiniteNum(self[3])) {
      targetPlayerPos.x = self[1];
      targetPlayerPos.y = Math.max(self[2], 0);
      targetPlayerPos.z = self[3];
    }
  }
}

/**
 * Sample an entity's state at render time `rt`: interpolate between the two
 * bracketing snapshots; extrapolate with capped velocity when data runs out.
 * posCount = number of leading fields (after id) that are continuous values.
 */
function sampleAt(id, rt, posCount) {
  const b = entBuf.get(id);
  if (!b || !b.length) return null;
  const last = b[b.length - 1];

  if (rt >= last.t - 0.002) {
    if (b.length < 2) return last.v.slice();
    const prev = b[b.length - 2];
    const dt = Math.max(0.001, last.t - prev.t);
    const ext = Math.min(rt - last.t, 0.35) / dt; // cap extrapolation at 350 ms
    const out = last.v.slice();
    for (let i = 1; i <= posCount && i < out.length; i++) {
      out[i] = last.v[i] + (last.v[i] - prev.v[i]) * ext;
    }
    return out;
  }

  for (let i = b.length - 1; i >= 1; i--) {
    if (b[i].t >= rt) {
      const a = b[i - 1], c = b[i];
      // teleport detection (respawn / nuke wipe): snap instead of sliding across the map
      if (Math.abs(c[1] - a[1]) + Math.abs(c[2] - a[2]) + Math.abs(c[3] - a[3]) > 8) {
        return c.v.slice();
      }
      const f = (rt - a.t) / Math.max(0.0001, c.t - a.t);
      const out = c.v.slice();
      for (let j = 1; j <= posCount && j < out.length; j++) {
        out[j] = a.v[j] + (c.v[j] - a.v[j]) * f;
      }
      return out;
    }
  }
  return b[0].v.slice();
}

/**
 * Horizontal speed estimate for the local player, derived from the two most
 * recent snapshot samples of our own position (30 Hz deltas). Used for the
 * speed-based FOV kick, viewmodel bob and the HUD readout — it makes air
 * strafe / bhop speed build-up visible to the player.
 */
function estimateSelfSpeed() {
  if (me == null) return 0;
  const b = entBuf.get(me);
  if (!b || b.length < 2) return 0;
  const a = b[b.length - 2], c = b[b.length - 1];
  // ignore teleport-sized jumps (respawn / OOB relocation) and corrupt samples —
  // a NaN speed would poison the FOV kick and the HUD readout
  const dx = c.v[1] - a.v[1], dz = c.v[3] - a.v[3];
  if (!isFiniteNum(dx) || !isFiniteNum(dz)) return 0;
  if (Math.abs(dx) + Math.abs(dz) > 8) return 0;
  const dt = Math.max(0.004, c.t - a.t);
  const sp = Math.hypot(dx, dz) / dt;
  return isFiniteNum(sp) ? sp : 0;
}

/* ============================== EFFECTS ==================================== */

/* --- Railgun trail: persistent core+halo beam fading over RAIL_TRAIL_LIFE ---- */
const _railDir = new THREE.Vector3();
const _railMid = new THREE.Vector3();
const _railUp = new THREE.Vector3(0, 1, 0);

/**
 * Persistent railgun hitline: a bright core cylinder plus a wider additive halo
 * from muzzle to end point. It stays in the scene for RAIL_TRAIL_LIFE seconds,
 * fading smoothly (cosine ease-out) before removal — see updateEffects().
 */
function spawnRailBeam(e) {
  const a = new THREE.Vector3(e.x, e.y, e.z);
  const b = new THREE.Vector3(e.hx, e.hy, e.hz);
  const len = Math.max(0.5, a.distanceTo(b));
  _railDir.copy(b).sub(a).normalize();
  _railMid.copy(a).add(b).multiplyScalar(0.5);

  const mkCyl = (r, color, opacity) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, len, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.quaternion.setFromUnitVectors(_railUp, _railDir); // cylinder axis (+Y) -> beam direction
    m.position.copy(_railMid);
    scene.add(m);
    return m;
  };

  railBeams.push({ core: mkCyl(0.05, 0xffd9ff, 1), halo: mkCyl(0.14, 0xff4df0, 0.5), t: 0, dur: RAIL_TRAIL_LIFE });
}

function spawnTracer(e) {
  const isRail = e.w === 'railgun';
  const isLightning = e.w === 'lightning';
  let pts;
  if (isLightning) {
    // jagged bolt: subdivide with random perpendicular jitter
    pts = [];
    const segs = 6;
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const jx = (i === 0 || i === segs) ? 0 : (Math.random() - 0.5) * 0.7;
      const jy = (i === 0 || i === segs) ? 0 : (Math.random() - 0.5) * 0.7;
      pts.push(new THREE.Vector3(
        e.x + (e.hx - e.x) * f + jx,
        e.y + (e.hy - e.y) * f + jy,
        e.z + (e.hz - e.z) * f + (i === 0 || i === segs ? 0 : (Math.random() - 0.5) * 0.7)));
    }
  } else if (!isRail) {
    pts = [new THREE.Vector3(e.x, e.y, e.z), new THREE.Vector3(e.hx, e.hy, e.hz)];
  }

  const color = isRail ? 0xff4df0 : isLightning ? 0x7be8ff : (e.w === 'shotgun' || e.w === 'super') ? 0xffd27b : 0xfff6c8;

  if (isRail) {
    // persistent beam mesh that fades over RAIL_TRAIL_LIFE — see updateEffects()
    spawnRailBeam(e);
  } else {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 }));
    scene.add(line);
    tracers.push({ line, life: 0.07, maxLife: 0.07 });
  }

  // impact spark at the end point
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  spark.position.set(e.hx, e.hy, e.hz);
  scene.add(spark);
  booms.push({ mesh: spark, light: null, t: 0, dur: 0.12, r: 0.5, grow: true });
}

/* --- Lightning Gun continuous beam (local player only) ------------------------ */
// While holding fire with the LG, a persistent cyan shaft runs from the viewmodel
// muzzle to the first thing in its path — solids, arena walls, zombies or remote
// players (mirroring the server's raycastAll), otherwise max range. Intermediate
// vertices are re-jittered every frame and the opacity flickers; the beam is
// removed on the very next frame firing stops (mouse up, weapon switch, pointer
// unlock, death or empty cells).
const LG_BEAM_SEGS = 27;       // jitter subdivisions between muzzle and end point
const _lgMuzzle = new THREE.Vector3();
const _lgDir = new THREE.Vector3();
const _lgEnd = new THREE.Vector3();
const _lgU = new THREE.Vector3();
const _lgV = new THREE.Vector3();
const _lgUp = new THREE.Vector3(0, 1, 0);

/** World-space position of the LG viewmodel muzzle (prong tips), bob/recoil included. */
function lgMuzzlePoint(out) {
  if (vmGun) {
    camera.updateMatrixWorld(true); // fresh camera + viewmodel chain for this frame
    out.set(0, 0.04, -0.6).applyMatrix4(vmGun.matrixWorld);
    return out;
  }
  return camera.localToWorld(out.set(0, -0.3, -1));
}

/** Aim direction from the local mouse-look angles (matches server aimDir). */
function lgAimDir(out) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return out.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp).normalize();
}

/** Ray vs axis-aligned box (slab test). Returns entry t > 0, or null on miss / origin inside. */
function lgRayBox(ox, oy, oz, dx, dy, dz, minX, maxX, minY, maxY, minZ, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  let t1, t2;
  if (Math.abs(dx) < 1e-9) { if (ox < minX || ox > maxX) return null; }
  else { t1 = (minX - ox) / dx; t2 = (maxX - ox) / dx; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dy) < 1e-9) { if (oy < minY || oy > maxY) return null; }
  else { t1 = (minY - oy) / dy; t2 = (maxY - oy) / dy; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dz) < 1e-9) { if (oz < minZ || oz > maxZ) return null; }
  else { t1 = (minZ - oz) / dz; t2 = (maxZ - oz) / dz; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (tmin > tmax) return null;
  if (tmin <= 0) return null;   // origin inside the box: no surface in front to stop on
  return tmin;
}

/** Ray vs sphere. Returns entry t >= 0, or null on miss. */
function lgRaySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;      // dir is unit length
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return null;
  const thc = Math.sqrt(r * r - d2);
  const t = tca - thc;
  return t > 0 ? t : 0.3;                       // origin inside: stop just in front of the muzzle
}

/** First hit along the LG shaft (solids, arena walls, zombies, remote players) or max range. */
function lgRayEnd(origin, dir, out) {
  let tBest = LG_RANGE;
  const H = worldMap ? worldMap.arenaHalf : 40;

  if (worldMap) {
    for (const s of worldMap.solids) {          // [minX, maxX, minZ, maxZ, top]
      const t = lgRayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, s[0], s[1], 0, s[4], s[2], s[3]);
      if (t != null && t < tBest) tBest = t;
    }
    // perimeter walls (visual boxes from buildWorld: 0.8 thick, 3.4 tall at ±H)
    const e = 0.4;
    for (const w of [
      [-(H + e), H + e, H - e, H + e],          // north
      [-(H + e), H + e, -(H + e), -(H - e)],    // south
      [H - e, H + e, -(H + e), H + e],          // east
      [-(H + e), -(H - e), -(H + e), H + e],    // west
    ]) {
      const t = lgRayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, w[0], w[1], 0, 3.4, w[2], w[3]);
      if (t != null && t < tBest) tBest = t;
    }
  }

  // zombies (approximate hit spheres matching the server's radii/scales)
  for (const z of zombies3d.values()) {
    const s = ZOMBIE_STYLE[z.typeIdx] ? ZOMBIE_STYLE[z.typeIdx].scale : 1;
    const t = lgRaySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      z.group.position.x, z.group.position.y + 0.85 * s, z.group.position.z, 0.62 * s);
    if (t != null && t < tBest) tBest = t;
  }

  // remote players (the same spheres the server raycasts against)
  for (const p of players3d.values()) {
    const t = lgRaySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      p.group.position.x, p.group.position.y + 0.9, p.group.position.z, 0.62);
    if (t != null && t < tBest) tBest = t;
  }

  return out.copy(origin).addScaledVector(dir, tBest);
}

function createLgBeam() {
  const mkLine = (color, opacity) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LG_BEAM_SEGS + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    scene.add(line);
    return line;
  };
  lgBeam = { outer: mkLine(0x7be8ff, 0.9), inner: mkLine(0xeaffff, 1) }; // cyan shaft + white-hot core
}

function removeLgBeam() {
  if (!lgBeam) return;
  scene.remove(lgBeam.outer);
  scene.remove(lgBeam.inner);
  lgBeam.outer.geometry.dispose();
  lgBeam.outer.material.dispose();
  lgBeam.inner.geometry.dispose();
  lgBeam.inner.material.dispose();
  lgBeam = null;
}

/** Per-frame update of the continuous LG shaft: re-aim, re-jitter vertices, flicker opacity. */
function updateLgBeam() {
  const self = (me != null && latestState) ? latestState.p.find((p) => p[0] === me) : null;
  // weaponIdx 5 = Lightning Gun; self[14] = cells ammo (server snapshot layout)
  const wantBeam = !!(firing && locked && weaponIdx === 5 && self && self[8] !== 1 && self[14] > 0);

  if (!wantBeam) { removeLgBeam(); return; }   // removed immediately when firing stops
  if (!lgBeam) createLgBeam();

  lgMuzzlePoint(_lgMuzzle);
  lgAimDir(_lgDir);
  lgRayEnd(_lgMuzzle, _lgDir, _lgEnd);

  // two orthonormal vectors perpendicular to the shaft for the jitter offsets
  if (Math.abs(_lgDir.y) < 0.95) _lgU.crossVectors(_lgDir, _lgUp).normalize();
  else _lgU.set(1, 0, 0);
  _lgV.crossVectors(_lgDir, _lgU).normalize();

  const writePts = (line, amp) => {
    const attr = line.geometry.attributes.position;
    for (let i = 0; i <= LG_BEAM_SEGS; i++) {
      const f = i / LG_BEAM_SEGS;
      let x = _lgMuzzle.x + (_lgEnd.x - _lgMuzzle.x) * f;
      let y = _lgMuzzle.y + (_lgEnd.y - _lgMuzzle.y) * f;
      let z = _lgMuzzle.z + (_lgEnd.z - _lgMuzzle.z) * f;
      if (i > 0 && i < LG_BEAM_SEGS) {
        // sine envelope pins both endpoints so the shaft stays anchored to muzzle and target
        const env = Math.sin(Math.PI * f);
        x += ((Math.random() - 0.5) * _lgU.x + (Math.random() - 0.5) * _lgV.x) * amp * env;
        y += ((Math.random() - 0.5) * _lgU.y + (Math.random() - 0.5) * _lgV.y) * amp * env;
        z += ((Math.random() - 0.5) * _lgU.z + (Math.random() - 0.5) * _lgV.z) * amp * env;
      }
      attr.setXYZ(i, x, y, z);
    }
    attr.needsUpdate = true;
  };

  writePts(lgBeam.outer, 0.42);   // wide cyan arc with full jitter
  writePts(lgBeam.inner, 0.16);   // tight white-hot core

  // subtle opacity flicker while active (gone with the beam when firing stops)
  lgBeam.outer.material.opacity = 0.7 + Math.random() * 0.3;
  lgBeam.inner.material.opacity = 0.85 + Math.random() * 0.15;
}

function spawnExplosionVisual(e) {
  const p = new THREE.Vector3(e.x, e.y, e.z);

  // expanding fireball shell
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xffa63c, transparent: true, opacity: 0.75 }));
  mesh.position.copy(p);
  scene.add(mesh);

  // flash light (pooled by reuse of a few point lights)
  const light = new THREE.PointLight(0xffb060, 4, e.r * 4 + 6);
  light.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
  scene.add(light);

  booms.push({ mesh, light, t: 0, dur: 0.32, r: e.r });

  // debris particles
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: Math.random() > 0.5 ? 0xffc36b : 0x8a4a2a, transparent: true }));
    m.position.copy(p);
    scene.add(m);
    const a = Math.random() * Math.PI * 2;
    const sp = 3 + Math.random() * 7;
    particles.push({
      mesh: m,
      vx: Math.cos(a) * sp, vy: 4 + Math.random() * 8, vz: Math.sin(a) * sp,
      life: 0.7, maxLife: 0.7,
    });
  }

  // screen shake scaled by proximity to the local player
  if (me != null && latestState) {
    const self = sampleAt(me, performance.now() / 1000 - SELF_DELAY, 5);
    if (self) {
      const d = Math.hypot(self[1] - e.x, self[2] - e.y, self[3] - e.z);
      if (d < e.r * 2.5 + 4) {
        shakeT = 0.3;
        shakeMag = Math.max(shakeMag, Math.min(0.5, 1.6 / (1 + d * 0.25)));
      }
    }
  }
}

function spawnPoof(x, y, z, color) {
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14),
      new THREE.MeshBasicMaterial({ color, transparent: true }));
    m.position.set(x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.8, z + (Math.random() - 0.5) * 0.6);
    scene.add(m);
    particles.push({
      mesh: m,
      vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, vz: (Math.random() - 0.5) * 4,
      life: 0.5, maxLife: 0.5,
    });
  }
}

function updateEffects(dt) {
  // railgun beams: smooth cosine ease-out fade over their full lifetime, then removal
  for (let i = railBeams.length - 1; i >= 0; i--) {
    const rb = railBeams[i];
    rb.t += dt;
    const f = Math.min(1, rb.t / rb.dur);
    if (f >= 1) {
      scene.remove(rb.core);
      scene.remove(rb.halo);
      rb.core.geometry.dispose();
      rb.core.material.dispose();
      rb.halo.geometry.dispose();
      rb.halo.material.dispose();
      railBeams.splice(i, 1);
      continue;
    }
    const k = 0.5 * (1 + Math.cos(Math.PI * f)); // 1 -> 0 with zero slope at both ends
    rb.core.material.opacity = k;
    rb.halo.material.opacity = 0.5 * k;
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      tracers.splice(i, 1);
    } else {
      t.line.material.opacity = Math.max(0, t.life / t.maxLife);
    }
  }

  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i];
    b.t += dt;
    const f = b.t / b.dur;
    if (f >= 1) {
      scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      if (b.light) scene.remove(b.light);
      booms.splice(i, 1);
      continue;
    }
    if (b.grow) {
      const s = 0.2 + f * b.r;
      b.mesh.scale.setScalar(s);
      b.mesh.material.opacity = 0.9 * (1 - f);
    } else {
      const s = 0.4 + f * b.r * 1.6;
      b.mesh.scale.setScalar(s);
      b.mesh.material.opacity = 0.75 * (1 - f);
      if (b.light) b.light.intensity = 4 * (1 - f);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.vy -= 22 * dt; // gravity on debris
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.rotation.x += dt * 7;
    p.mesh.rotation.y += dt * 5;
    p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
  }

  if (shakeT > 0) {
    shakeT -= dt;
    if (shakeT <= 0) shakeMag = 0;
  }
}

/* ============================== VIEWMODEL ================================== */

// First-person weapon model: a child of the CAMERA (not the scene), so it stays
// rigidly aligned with the local player's view and never appears in world space.
// This is the ONLY self-rendering path — the character body/head mesh exists for
// remote players only (see makePlayerMesh / the remote-player loop above).
const viewmodel = new THREE.Group();
camera.add(viewmodel); // first-person weapon model rides the camera
viewmodel.position.set(0.42, -0.38, -0.62);
let vmGun = null;
let recoil = 0;
let bobPhase = 0;

function buildViewmodel(idx) {
  if (vmGun) viewmodel.remove(vmGun);
  const g = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x23282f });
  const mid = new THREE.MeshLambertMaterial({ color: 0x3a414c });

  const addBox = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || dark);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  switch (idx) {
    case 0: // assault rifle
      addBox(0.09, 0.12, 0.75, 0, 0, -0.3);
      addBox(0.07, 0.2, 0.1, 0, -0.14, -0.05);
      addBox(0.06, 0.08, 0.3, 0, 0.02, -0.75, mid);
      break;
    case 1: // shotgun
      addBox(0.11, 0.14, 0.7, 0, 0, -0.28);
      addBox(0.13, 0.1, 0.25, 0, -0.06, 0.05, mid);
      break;
    case 2: { // super shotgun (double barrel)
      const bGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.7, 10);
      for (const dx of [-0.05, 0.05]) {
        const b = new THREE.Mesh(bGeo, mid);
        b.rotation.x = Math.PI / 2;
        b.position.set(dx, 0.03, -0.3);
        g.add(b);
      }
      addBox(0.14, 0.12, 0.35, 0, -0.08, 0.05);
      break;
    }
    case 3: { // grenade launcher (fat tube)
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.62, 14), dark);
      t.rotation.x = Math.PI / 2;
      t.position.set(0, 0, -0.3);
      g.add(t);
      addBox(0.1, 0.1, 0.3, 0, -0.1, 0.1, mid);
      break;
    }
    case 4: { // rocket launcher (big tube + fins)
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.75, 16), dark);
      t.rotation.x = Math.PI / 2;
      t.position.set(0, 0, -0.32);
      g.add(t);
      addBox(0.12, 0.12, 0.3, 0, -0.12, 0.12, mid);
      break;
    }
    case 5: { // lightning gun (coil + prongs)
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 12), dark);
      c.rotation.x = Math.PI / 2;
      c.position.set(0, 0, -0.28);
      g.add(c);
      const prongMat = new THREE.MeshBasicMaterial({ color: 0x7be8ff });
      for (const dx of [-0.05, 0.05]) {
        const p = addBox(0.03, 0.16, 0.03, dx, 0.02, -0.58, prongMat);
        p.rotation.x = dx < 0 ? 0.25 : -0.25;
      }
      break;
    }
    case 6: { // railgun (long rails + glowing core)
      addBox(0.14, 0.1, 0.9, 0, 0, -0.35);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.85, 8),
        new THREE.MeshBasicMaterial({ color: 0xff4df0 }));
      core.rotation.x = Math.PI / 2;
      core.position.set(0, 0.06, -0.35);
      g.add(core);
      break;
    }
  }

  // muzzle flash sprite (hidden until firing)
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const gg = c.getContext('2d');
  const grad = gg.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,240,180,1)');
  grad.addColorStop(0.4, 'rgba(255,170,60,0.8)');
  grad.addColorStop(1, 'rgba(255,120,30,0)');
  gg.fillStyle = grad;
  gg.fillRect(0, 0, 64, 64);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  flash.scale.setScalar(0.5);
  flash.position.set(0, 0.02, -0.85);
  flash.visible = false;
  g.add(flash);
  g.userData.flash = flash;

  viewmodel.add(g);
  vmGun = g;
}

function muzzleFlash() {
  if (!vmGun) return;
  const f = vmGun.userData.flash;
  f.visible = true;
  f.material.opacity = 1;
  recoil = Math.min(recoil + 0.5, 1);
}

function updateViewmodel(dt, speed) {
  if (recoil > 0) recoil = Math.max(0, recoil - dt * 6);
  const flash = vmGun && vmGun.userData.flash;
  if (flash && flash.visible) {
    flash.material.opacity -= dt * 14;
    if (flash.material.opacity <= 0) flash.visible = false;
  }

  // bob scales with actual movement speed (0 at rest -> full at 70+ u/s), so
  // bhop/strafe chains feel faster than a plain walk in the overhauled range
  const sf = Math.min(1, speed / 70);
  bobPhase += dt * (2.5 + 7 * sf);
  const bobY = Math.sin(bobPhase) * (0.006 + 0.014 * sf);
  const bobX = Math.cos(bobPhase * 0.5) * (0.004 + 0.010 * sf);
  viewmodel.position.set(0.42 + bobX, -0.38 + bobY, -0.62 + recoil * 0.09);
  viewmodel.rotation.x = recoil * 0.12;
}

/* ============================== HUD ======================================== */

function addFeedLine(text, cls) {
  const div = document.createElement('div');
  div.className = `feed-line ${cls || ''}`;
  div.textContent = text;
  el.killfeed.appendChild(div);
  while (el.killfeed.children.length > 6) el.killfeed.removeChild(el.killfeed.firstChild);
  setTimeout(() => { if (div.parentNode) div.remove(); }, 4500);
}

function updateHUD() {
  if (!latestState || me == null) return;
  const self = latestState.p.find((e) => e[0] === me);
  if (!self) return;

  // health
  el.hpNum.textContent = String(self[6]);
  el.hpFill.style.width = `${Math.max(0, Math.min(100, self[6]))}%`;
  el.hpFill.style.background = self[6] > 55 ? '#4dff88' : self[6] > 25 ? '#ffb02e' : '#ff3b30';

  // horizontal speed (air strafe / bhop build-up readout)
  if (el.speedNum) el.speedNum.textContent = String(Math.round(selfSpeed));

  // ammo for the current weapon (server-authoritative counts)
  const poolIdx = AMMO_POOL_IDX[weaponIdx];
  const ammoVal = [self[10], self[11], self[12], self[13], self[14], self[15]][poolIdx];
  el.ammoNum.textContent = String(ammoVal);
  el.wpnName.textContent = weaponDefs[weaponIdx] ? weaponDefs[weaponIdx].name.toUpperCase() : '';

  // weapon strip ammo + selection highlight
  for (let i = 0; i < WEAPON_SHORT.length; i++) {
    const slot = document.getElementById(`wpnSlot${i}`);
    if (!slot) continue;
    slot.classList.toggle('selected', i === weaponIdx);
    const a = [self[10], self[11], self[12], self[13], self[14], self[15]][AMMO_POOL_IDX[i]];
    document.getElementById(`wAmmo${i}`).textContent = String(a);
  }

  // button status meters (mirror of the in-world overhead meters)
  const b = latestState.b;
  el.nukeMeter.style.width = `${Math.round(b.n * 100)}%`;
  el.nukeMeter.parentElement.classList.toggle('ready', b.n >= 1);
  if (b.i > 0) {
    el.inhibitTimer.textContent = `SPAWNS OFF ${Math.ceil(b.i)}s`;
    el.inhibitTimer.style.visibility = 'visible';
  } else {
    el.inhibitTimer.style.visibility = 'hidden';
  }

  // death overlay + respawn countdown
  if (self[8] === 1) {
    el.deathOverlay.style.display = 'flex';
    el.deathCount.textContent = Math.max(0, Math.ceil(self[9]));
  } else {
    el.deathOverlay.style.display = 'none';
  }
}

/* ============================== INPUT ====================================== */

function switchWeapon(i) {
  if (i < 0 || i >= WEAPON_SHORT.length) return;
  weaponIdx = i;
  buildViewmodel(weaponIdx);
}

/* --- in-game chat overlay (session-only, no persistence) ---------------------- */
// T / Enter release pointer control and slide the input up. Enter inside the
// input emits 'chatMessage' to the server (which relays it to every client) and
// re-engages pointer lock. Received messages are appended to #chat-log in this
// client's DOM only — nothing is stored anywhere, so history dies with the tab.

function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  for (const k in keys) keys[k] = false; // no stuck movement while typing
  firing = false;
  el.chatBox.classList.add('open');      // slides #chat-input up
  document.exitPointerLock();            // release pointer control
  el.chatInput.value = '';
  el.chatInput.focus();
}

function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  el.chatBox.classList.remove('open');   // slides #chat-input back down
  el.chatInput.value = '';
  el.chatInput.blur();
  // Re-engage pointer lock. Some browsers throttle re-lock right after a
  // programmatic exit — if the request is denied, the click-to-enter menu
  // overlay takes over (see pointerlockerror / pointerlockchange below).
  let req;
  try { req = canvas.requestPointerLock(); } catch (_) { /* fall back to menu */ }
  if (req && typeof req.then === 'function') req.catch(() => {});
}

/** Append one chat line to the session-only log (textContent — no HTML injection). */
function appendChatLine(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const who = document.createElement('b');
  who.textContent = name;
  line.appendChild(who);
  line.appendChild(document.createTextNode(`: ${text}`));
  el.chatLog.appendChild(line);
  while (el.chatLog.children.length > 30) el.chatLog.removeChild(el.chatLog.firstChild); // cap the log
  el.chatLog.scrollTop = el.chatLog.scrollHeight; // keep the newest line visible
}

document.addEventListener('keydown', (e) => {
  // Chat overlay open: every key goes to the input, never to the game.
  if (chatOpen) {
    if (e.code === 'Escape') closeChat(); // works even if focus slipped off the input
    return;
  }
  // T / Enter while in-game: release pointer control and slide up the chat input
  if ((e.code === 'KeyT' || e.code === 'Enter') && locked) {
    // Swallow the keypress before focusing #chat-input so the typed 't' never
    // leaks into the field (Metal/macOS browsers deliver the character to the
    // element that gains focus during this same event).
    e.preventDefault();
    el.chatInput.value = '';
    openChat();
    return;
  }

  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  const digit = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7']
    .indexOf(e.code);
  if (digit >= 0) switchWeapon(digit);
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

el.chatInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (text && socket && socket.connected) socket.emit('chatMessage', text);
    closeChat(); // re-engages pointer lock
  } else if (e.code === 'Escape') {
    e.preventDefault();
    closeChat();
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button === 0) firing = true;
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });

window.addEventListener('wheel', (e) => {
  if (!locked || me == null) return;
  const dirn = e.deltaY > 0 ? 1 : -1;
  switchWeapon((weaponIdx + dirn + WEAPON_SHORT.length) % WEAPON_SHORT.length);
}, { passive: true });

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  // sanitize raw mouse deltas at the source: a non-finite movementX/Y would poison
  // yaw/pitch and every subsequent camera update (dark screen) — skip bad samples
  const mx = Number.isFinite(e.movementX) ? e.movementX : 0;
  const my = Number.isFinite(e.movementY) ? e.movementY : 0;
  yaw -= mx * 0.0022;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - my * 0.0022));
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  // The menu overlay stays hidden while the chat overlay is open: we exit pointer
  // lock to type, but that must not flash the "click to enter" screen.
  el.lockOverlay.style.display = (locked || chatOpen) ? 'none' : 'flex';
  if (locked) {
    // Chromium/Vivaldi viewport bug: the window can report a stale size right
    // after pointer lock is acquired — defer the resize resync to the next
    // animation frame instead of dispatching a synthetic resize event.
    requestAnimationFrame(() => handleResize());
  } else {
    firing = false;
  }
  // No manual matrix reset on the menu -> play transition: camera.position /
  // camera.rotation are written exclusively by the frame loop, and with
  // matrixAutoUpdate enabled three.js recomposes both matrices from
  // position/quaternion/scale every render — there is no stray offset to clear.
});

document.addEventListener('pointerlockerror', () => {
  // Re-lock was denied (e.g. browser throttle right after a programmatic exit):
  // fall back to the click-to-enter menu so the player can re-engage manually.
  if (!locked && !chatOpen) el.lockOverlay.style.display = 'flex';
});

el.lockOverlay.addEventListener('click', () => {
  SFX.init();
  SFX.startAmbient();
  canvas.requestPointerLock();
  if (socket && socket.connected && me == null) {
    socket.emit('join', { name: myName });
  }
});

function currentInput() {
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  // never stream NaN/undefined to the server: fall back to the last valid values
  return {
    f, s, jump: !!keys.Space, fire: firing && locked, w: weaponIdx,
    yaw: isFiniteNum(yaw) ? yaw : camLast.yaw,
    pitch: isFiniteNum(pitch) ? pitch : camLast.pitch,
  };
}

/* ============================== SOCKET ===================================== */

function resetWorldEntities() {
  for (const id of [...players3d.keys()]) removePlayerMesh(id);
  for (const id of [...zombies3d.keys()]) removeZombieMesh(id);
  for (const id of [...projectiles3d.keys()]) removeProjectileMesh(id);
  entBuf.clear();
  snapBuf.length = 0;
  latestState = null;
}

function removePlayerMesh(id) {
  const p = players3d.get(id);
  if (!p) return;
  scene.remove(p.group);
  p.nameSprite.material.map.dispose();
  p.nameSprite.material.dispose();
  players3d.delete(id);
}

function removeZombieMesh(id) {
  const z = zombies3d.get(id);
  if (!z) return;
  scene.remove(z.group);
  zombies3d.delete(id);
}

function removeProjectileMesh(id) {
  const pr = projectiles3d.get(id);
  if (!pr) return;
  scene.remove(pr.mesh);
  scene.remove(pr.trail);
  pr.trail.geometry.dispose();
  pr.trail.material.dispose();
  projectiles3d.delete(id);
}

function connect() {
  socket = io({ transports: ['websocket', 'polling'] }); // WS first (NPM+ passes Upgrade through)

  socket.on('connect', () => {
    el.netStatus.textContent = 'LINKED';
    el.netStatus.classList.add('ok');
    if (me != null) {
      // reconnected: rejoin the world with the same callsign
      resetWorldEntities();
      me = null;
      socket.emit('join', { name: myName });
    }
  });

  socket.on('disconnect', () => {
    el.netStatus.textContent = 'RECONNECTING…';
    el.netStatus.classList.remove('ok');
  });

  socket.on('init', (data) => {
    me = data.you;
    myName = data.name;
    if (!worldMap) buildWorld(data.map);
    weaponDefs = data.weapons;
    buildViewmodel(weaponIdx);
    // face the arena center like the server spawn does
  });

  // Snapshot data NEVER writes the camera transform here — no position/rotation,
  // no matrix updates: it only feeds the interpolation buffers and the local
  // player's network target (targetPlayerPos). The rAF frame loop owns the
  // camera exclusively.
  socket.on('state', (data) => pushSnapshot(data));

  socket.on('event', onEvent);

  // Session-only chat relay: append to this client's log only — no persistence,
  // the history lives in #chat-log for the duration of this session and nothing
  // more.
  socket.on('chatMessage', (data) => {
    const name = data && typeof data.name === 'string' ? data.name : '?';
    const text = data && typeof data.text === 'string' ? data.text.trim() : '';
    if (text) appendChatLine(name, text);
  });
}

function onEvent(e) {
  switch (e.t) {
    case 'shot': {
      const mine = e.s === me;
      SFX.playShot(e.w, [e.x, e.y, e.z], mine);
      if (mine) muzzleFlash();
      // Local Lightning Gun shots are rendered as the continuous flickering beam
      // (updateLgBeam), so their per-tick events skip the short jagged tracer.
      // Railgun shots — local or remote — get the persistent 1 s fading beam.
      if (!mine || e.w === 'railgun') spawnTracer(e);
      break;
    }
    case 'explosion':
      SFX.playExplosion([e.x, e.y, e.z]);
      spawnExplosionVisual(e);
      break;
    case 'button': {
      const b = button3d[e.which];
      if (b) {
        SFX.playButton(e.which, [b.group.position.x, b.group.position.y, b.group.position.z]);
        b.light.intensity = 5; // trigger flash
      }
      addFeedLine(e.which === 'nuke' ? 'NUKE DETONATED — HORDE WIPED' : 'INHIBIT ACTIVE — SPAWNS OFF 30s', 'feed-btn');
      break;
    }
    case 'hit': {
      // small spark where a zombie took damage (position from its mesh)
      const z = zombies3d.get(e.id);
      if (z) spawnPoof(z.group.position.x, z.group.position.y + 1.0, z.group.position.z, 0xd8ff5a);
      break;
    }
    case 'zdie':
      SFX.playZap([e.x, e.y, e.z]);
      spawnPoof(e.x, e.y, e.z, 0x7da35c);
      break;
    case 'zspawn':
      spawnPoof(e.x, e.y + 0.4, e.z, 0x39d98a);
      break;
    case 'hurt':
      SFX.playHurt();
      vignetteAlpha = Math.max(vignetteAlpha, 0.55);
      break;
    case 'kill':
      if (e.s === me) SFX.playKill();
      addFeedLine(`${e.k}  ▸  ${e.v}`, e.s === me ? 'feed-kill' : 'feed-death');
      break;
    case 'pickup': {
      const pk = worldMap && worldMap.pickups.find((p) => p[0] === e.id);
      if (pk) SFX.playPickup(e.kind, [pk[2], pk[3] + 0.5, pk[4]]);
      break;
    }
    case 'msg':
      addFeedLine(e.text, 'feed-msg');
      break;
  }
}

/* ============================== CAMERA SANITIZATION ======================== */
// Dark-screen guard. If a snapshot sample ever contains NaN/undefined (corrupt
// or partial data), writing it into the camera transform puts NaN in the view
// matrix and every subsequent frame renders as a dark screen. Every incoming
// position value is validated with Number.isFinite before it reaches
// targetPlayerPos; on bad input we hold the previous valid coordinates instead
// of applying the corrupt sample. The projection matrix is only ever refreshed
// by the window resize handler — never from snapshot or event callbacks.

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// last known-good camera transform (seeded with the initial pre-join pose)
const camLast = { x: 0, y: EYE_HEIGHT, z: 24, pitch: 0, yaw: 0 };

// scratch buffer for the explicit orientation copy in updateEntities — YXZ order
// to match camera.rotation.order (Euler.copy also copies `order`, so a default-
// order temp would silently flip the mouse-look axes)
const playerRotation = new THREE.Euler(0, 0, 0, 'YXZ');

/* ============================== FRAME LOOP ================================= */

let lastFrame = performance.now() / 1000;
let cameraSeeded = false; // pre-join pose is applied on the first frame (the rAF loop owns all camera writes)

function updateEntities(now, dt) {
  if (!latestState) return;
  const rtOthers = now - INTERP_DELAY; // remote entities only — the self camera uses the targetPlayerPos lerp

  // --- self speed estimate (snapshot deltas) -> viewmodel bob + HUD readout ----
  const targetSpeed = selfDead() ? 0 : estimateSelfSpeed();
  selfSpeed += (targetSpeed - selfSpeed) * Math.min(1, dt * 6);

  // --- local player camera ---------------------------------------------------
  // The frame loop is the ONLY writer of camera.position / camera.rotation.
  // Network snapshots never touch the camera directly: pushSnapshot() stores the
  // latest server state for me in `targetPlayerPos`, and here we smoothly lerp
  // our own feet position (`localPos`) toward that target, then sync the camera
  // from it (world space — the camera is a direct child of the root scene, so no
  // parent transform can inject stray offsets):
  //   camera.position.set(localPos.x, localPos.y + EYE_HEIGHT, localPos.z)
  // The self body/head mesh is excluded from rendering entirely (see
  // makePlayerMesh / remote loop). targetPlayerPos only ever holds finite values
  // (validated in pushSnapshot), and the lerp below can therefore never produce
  // NaN; the final guard is belt-and-braces for the dark-screen invariant.
  if (me != null) {
    const selfEntry = latestState.p.find((p) => p[0] === me);
    if (!selfEntry || selfEntry[8] !== 1) {
      // screen shake offset
      let sx = 0, sy = 0;
      if (shakeMag > 0) {
        sx = (Math.random() - 0.5) * shakeMag;
        sy = (Math.random() - 0.5) * shakeMag;
      }

      // smooth lerp toward the network target: framerate-independent exponential
      // smoothing (k -> 1 as dt grows, so a dropped frame never overshoots).
      const k = 1 - Math.exp(-SELF_SMOOTH_RATE * dt);
      if (Math.abs(targetPlayerPos.x - localPos.x) +
          Math.abs(targetPlayerPos.y - localPos.y) +
          Math.abs(targetPlayerPos.z - localPos.z) > 8) {
        // teleport detection (respawn / nuke wipe): snap instead of sliding across the map
        localPos.set(targetPlayerPos.x, targetPlayerPos.y, targetPlayerPos.z);
      } else {
        localPos.x += (targetPlayerPos.x - localPos.x) * k;
        localPos.y += (targetPlayerPos.y - localPos.y) * k;
        localPos.z += (targetPlayerPos.z - localPos.z) * k;
      }

      // sync the camera from the smoothed feet position (feet are clamped at the
      // floor plane in pushSnapshot, so y + EYE_HEIGHT can never dip below ground)
      if (isFiniteNum(localPos.x) && isFiniteNum(localPos.y) && isFiniteNum(localPos.z)) {
        camera.position.set(localPos.x, localPos.y + EYE_HEIGHT, localPos.z);
        camLast.x = localPos.x; camLast.y = localPos.y + EYE_HEIGHT; camLast.z = localPos.z;
      }

      // explicit orientation copy in world space (YXZ mouse-look order: pitch=x, yaw=y)
      const rp = isFiniteNum(pitch + sy) ? pitch + sy : camLast.pitch;
      const ry = isFiniteNum(yaw + sx * 0.6) ? yaw + sx * 0.6 : camLast.yaw;
      playerRotation.set(rp, ry, 0);
      camera.rotation.copy(playerRotation);
      if (isFiniteNum(pitch)) camLast.pitch = pitch;
      if (isFiniteNum(yaw)) camLast.yaw = yaw;
    }
  }

  // --- remote players ----------------------------------------------------------
  // World-model meshes render for REMOTE players only: `me` is excluded here so
  // the local player never gets a body/head mesh in the scene (the camera must
  // never sit inside an active body mesh). makePlayerMesh() additionally hides
  // the character parts if it ever receives our own id.
  const seenP = new Set();
  for (const e of latestState.p) {
    if (e[0] === me) continue; // local player: no world model — the camera is the avatar
    seenP.add(e[0]);
    let p = players3d.get(e[0]);
    if (!p) p = players3d.set(e[0], makePlayerMesh(e[0])).get(e[0]);
    const s = sampleAt(e[0], rtOthers, 5);
    // skip corrupt samples (NaN/undefined): hold the last valid transform so a bad
    // snapshot can never write NaN into an entity's matrix
    if (s && isFiniteNum(s[1]) && isFiniteNum(s[2]) && isFiniteNum(s[3])) {
      p.group.position.set(s[1], s[2], s[3]);
      if (isFiniteNum(s[4])) p.group.rotation.y = s[4];
      p.hpFill.scale.x = Math.max(0.001, Math.min(1, isFiniteNum(s[6]) ? s[6] / 100 : 1));
    }
    if (p.name !== e[16]) { // refresh the name tag once we know it
      p.name = e[16];
      setSpriteText(p.nameSprite, p.name, '#cfe8ff');
    }
  }
  for (const id of [...players3d.keys()]) if (!seenP.has(id)) removePlayerMesh(id);

  // --- zombies -----------------------------------------------------------------
  const seenZ = new Set();
  for (const e of latestState.z) {
    seenZ.add(e[0]);
    let z = zombies3d.get(e[0]);
    if (!z || z.typeIdx !== e[4]) {
      if (z) removeZombieMesh(e[0]);
      z = zombies3d.set(e[0], makeZombieMesh(e[4])).get(e[0]);
      z.typeIdx = e[4];
    }
    const s = sampleAt(e[0], rtOthers, 3);
    if (s && isFiniteNum(s[1]) && isFiniteNum(s[2]) && isFiniteNum(s[3])) {
      z.group.position.set(s[1], s[2], s[3]);
      // face movement direction (from extrapolated velocity)
      const b = entBuf.get(e[0]);
      if (b && b.length >= 2) {
        const dx = s[1] - b[b.length - 2].v[1];
        const dz = s[3] - b[b.length - 2].v[3];
        if (Math.hypot(dx, dz) > 0.001) z.group.rotation.y = Math.atan2(-dx, -dz);
      }
      // shamble bob
      z.group.position.y += Math.abs(Math.sin(now * 6 + e[0])) * 0.08;
    }
  }
  for (const id of [...zombies3d.keys()]) if (!seenZ.has(id)) removeZombieMesh(id);

  // --- projectiles ---------------------------------------------------------------
  const seenPr = new Set();
  for (const e of latestState.pr) {
    seenPr.add(e[0]);
    const kind = e[4] === 4 ? 'rocket' : 'grenade'; // weapon index: 3=grenade, 4=rocket
    let pr = projectiles3d.get(e[0]);
    if (!pr || pr.kind !== kind) {
      if (pr) removeProjectileMesh(e[0]);
      pr = projectiles3d.set(e[0], makeProjectileMesh(kind)).get(e[0]);
    }
    const s = sampleAt(e[0], rtOthers, 3);
    if (s && isFiniteNum(s[1]) && isFiniteNum(s[2]) && isFiniteNum(s[3])) {
      pr.mesh.position.set(s[1], s[2], s[3]);
      // trail history
      pr.hist.push(new THREE.Vector3(s[1], s[2], s[3]));
      if (pr.hist.length > 8) pr.hist.shift();
      const attr = pr.trail.geometry.attributes.position;
      for (let i = 0; i < 8; i++) {
        const v = pr.hist[Math.max(0, pr.hist.length - 1 - i)] || pr.mesh.position;
        attr.setXYZ(i, v.x, v.y, v.z);
      }
      attr.needsUpdate = true;
    }
  }
  for (const id of [...projectiles3d.keys()]) if (!seenPr.has(id)) removeProjectileMesh(id);

  // --- pickups ---------------------------------------------------------------------
  const avail = new Set(latestState.pk || []);
  for (const [id, pk] of pickups3d) {
    const on = avail.has(id);
    pk.group.visible = on;
    if (on) {
      pk.group.rotation.y += 0.03;
      pk.group.position.y = pk.baseY + Math.sin(now * 2 + id) * 0.12;
    }
  }

  // --- buttons: overhead meters + billboard ------------------------------------------
  const b = latestState.b;
  for (const which of ['nuke', 'inhibit']) {
    const bt = button3d[which];
    if (!bt) continue;
    bt.meter.lookAt(camera.position);
    if (which === 'nuke') {
      // fill grows from 0 -> 1 as the 30 s cooldown elapses (full = ready)
      bt.fill.scale.x = Math.max(0.001, b.n);
      const ready = b.n >= 1;
      bt.dome.material.color.setHex(ready ? 0xff5a4e : 0x7a2a26);
      bt.light.intensity += ((ready ? 1.8 + Math.sin(now * 5) * 0.6 : 0.9) - bt.light.intensity) * 0.1;
    } else {
      // fill shrinks while the inhibit window is active (30 s -> 0)
      const frac = b.i > 0 ? Math.max(0, b.i / 30) : 0;
      bt.fill.scale.x = Math.max(0.001, frac);
      bt.dome.material.color.setHex(b.i > 0 ? 0x5ec8ff : 0x2a4a6a);
      bt.light.intensity += ((b.i > 0 ? 2.2 : 0.7) - bt.light.intensity) * 0.1;
    }
  }

  // --- viewmodel (bob driven by the snapshot-derived speed estimate) ---------------
  updateViewmodel(dt, selfSpeed);
}

function selfDead() {
  if (!latestState || me == null) return false;
  const s = latestState.p.find((p) => p[0] === me);
  return !!s && s[8] === 1;
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now() / 1000;
  const dt = Math.min(0.05, now - lastFrame);
  lastFrame = now;

  // one-time pre-join pose (applied here so the frame loop remains the ONLY
  // writer of camera.position): eye height above open floor so early frames
  // never render inside a mesh before any snapshot has arrived.
  if (!cameraSeeded) {
    cameraSeeded = true;
    camera.position.set(localPos.x, localPos.y + EYE_HEIGHT, localPos.z);
  }

  // stream input to the authoritative server at display rate (~60 Hz)
  if (socket && socket.connected && me != null) {
    socket.emit('input', currentInput());
  }

  updateEntities(now, dt);
  updateLgBeam(); // continuous local LG shaft (re-aims + re-jitters every frame)
  updateEffects(dt);
  updateHUD();

  // positional audio listener follows the camera
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  SFX.setListener(
    camera.position.x, camera.position.y, camera.position.z,
    -Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);

  // damage vignette decay
  if (vignetteAlpha > 0) {
    vignetteAlpha = Math.max(0, vignetteAlpha - dt * 1.4);
    el.vignette.style.opacity = String(vignetteAlpha);
  }

  renderer.render(scene, camera);
}

/* ============================== BOOT ======================================= */

connect();
animate();
