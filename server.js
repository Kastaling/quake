'use strict';
/**
 * ============================================================================
 *  QUAKE ARENA // ZOMBIE SIEGE — Authoritative Game Server
 * ============================================================================
 *  - Express + Socket.io, fully proxy-safe behind NGINX Proxy Manager Plus:
 *      * `trust proxy` enabled  -> req.ip / handshake read X-Forwarded-For
 *      * WebSocket `Upgrade` handled by engine.io on the default /socket.io path
 *      * CORS open for same-origin proxied traffic (and LAN testing)
 *  - Centralized world: one fixed-timestep simulation at 60 FPS that runs
 *    seamlessly with 0, 1 or N connected players.
 *  - Overhauled Quake/Source-style movement: significantly raised base speed,
 *    acceleration and jump velocity; ground friction + acceleration vectors,
 *    classic air strafing (A/D strafe + smooth mouse turns build horizontal
 *    momentum with no hard cap), bunny hopping (frictionless air) for long
 *    ~1.1 s strafe windows per hop.
 *  - Full weapon loadout on spawn: Assault Rifle, Shotgun, Super Shotgun,
 *    Grenade Launcher, Rocket Launcher, Lightning Gun, Railgun.
 *  - Blast Jump Engine: grenades/rockets apply pure radial impulse vectors —
 *    direction computed from blast center to each player's position -> strong
 *    angled horizontal + vertical boosts for proper rocket / grenade jumping.
 *  - Arena map: cover blocks, elevated ramps, +25 HP packs, ammo crates.
 *  - Central buttons: NUKE (wipes the horde, 30 s overhead cooldown meter) and
 *    INHIBIT (disables zombie spawns for 30 s).
 *  - Zombie AI engine: continuous horde spawner with INVERSE player scaling
 *    (more players -> lower spawn rate), pathing to nearest active player,
 *    melee contact damage. Railgun penetrates in a straight line; the
 *    Lightning Gun fires continuous hitscan ray ticks.
 * ============================================================================
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

/* ============================== CONFIGURATION ============================== */

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const TICK_RATE = 60;                 // authoritative simulation rate (FPS)
const DT = 1 / TICK_RATE;             // fixed timestep
const SNAPSHOT_EVERY = 2;             // broadcast world state every N ticks (30 Hz)

/* --- Arena geometry -------------------------------------------------------- */
const ARENA_HALF = 80;                // outer walls at +/-80 (arena doubled from +/-40)
const PLAT_HALF = 6;                  // central platform half-extent
const PLAT_TOP = 2.0;                 // central platform height
const RAMP_LEN = 4;                   // ramp run length (one per side)
const RAMP_W = 5;                     // ramp half-width

/* --- Quake/Source-style movement physics (overhauled) ----------------------- */
const GRAVITY = 38;                   // units/s^2 (raised with the jump for a snappier arc)
const JUMP_VEL = 11;                  // halved jump impulse -> ~1.6 u apex, ~0.58 s airtime strafe window
const MAXWALK = 13;                   // base speed: velocity component cap along facing dir (reduced from 20)
const ACCEL_GROUND = 200;             // ground acceleration (overcomes friction -> recovers to MAXWALK fast)
const ACCEL_AIR = 40;                 // air acceleration: cut so turning while strafing still builds
                                       // momentum, but the plateau lands at roughly a third of the old
                                       // build-up (~23 u/s peak vs ~74 before). No hard cap.
const FRICTION = 6;                   // ground friction coefficient (air has none -> bhop)
const STOP_SPEED = 1.0;               // below this, ground speed is zeroed when no input held
const SANITY_MAX = 160;               // numerical safety net ONLY — not a gameplay cap (anti-tunneling:
                                       // keeps per-tick travel < thinnest solid + player radius)
const SPAWN_ABOVE = 2.0;              // spawn this far above local ground level (never clip into the floor mesh)
const OOB_Y = -10;                    // out-of-bounds plane: entities below this are respawned
const PLAYER_R = 0.45;                // player collision radius
const PLAYER_H = 1.7;                 // player collision height
const EYE = 1.6;                      // camera height above feet
const STEP = 0.55;                    // auto step-up height

/* --- Weapons ---------------------------------------------------------------- */
const WEAPONS = [
  { id: 'ar',        name: 'Assault Rifle',    kind: 'hitscan',    auto: true,  rate: 0.12, dmg: 11,  pellets: 1, spread: 0.015, range: 140, ammo: 'rifle',   maxAmmo: 96 },
  { id: 'shotgun',   name: 'Shotgun',          kind: 'hitscan',    auto: false, rate: 0.80, dmg: 7,   pellets: 8, spread: 0.075, range: 42,  ammo: 'shells',  maxAmmo: 24 },
  { id: 'super',     name: 'Super Shotgun',    kind: 'hitscan',    auto: false, rate: 1.10, dmg: 11,  pellets: 8, spread: 0.110, range: 46,  ammo: 'shells',  maxAmmo: 24 },
  { id: 'grenade',   name: 'Grenade Launcher', kind: 'projectile', auto: false, rate: 1.00, projSpeed: 19, gravity: true,  dmg: 55, blastR: 9, impulse: 32, ammo: 'nades',   maxAmmo: 8 },
  { id: 'rocket',    name: 'Rocket Launcher',  kind: 'projectile', auto: false, rate: 1.20, projSpeed: 30, gravity: false, dmg: 85, blastR: 9, impulse: 30, ammo: 'rockets', maxAmmo: 8 },
  { id: 'lightning', name: 'Lightning Gun',    kind: 'hitscan',    auto: true,  rate: 0.06, dmg: 5,   pellets: 1, spread: 0.030, range: 90,  ammo: 'cells',   maxAmmo: 200 },
  { id: 'railgun',   name: 'Railgun',          kind: 'rail',       auto: false, rate: 1.40, dmg: 130, pellets: 1, spread: 0,     range: 220, ammo: 'rail',    maxAmmo: 8 },
  // Quake Nailgun: rapid twin-barrel projectile shooter (auto, ~100 ms interval).
  // Appended LAST so every existing weapon index stays stable (rocket=4, lightning=5,
  // railgun=6) — the client maps projectile kind and the LG beam by those indices.
  { id: 'nail',      name: 'Nailgun',          kind: 'projectile', auto: true,  rate: 0.10, projSpeed: 55, gravity: false, dmg: 9, blastR: 0, impulse: 0, ammo: 'nails', maxAmmo: 64 },
];
const AMMO_MAX = { rifle: 96, shells: 24, nades: 8, rockets: 8, cells: 200, rail: 8, nails: 64 };

/* --- Grenade fuse / bounce tuning ------------------------------------------- */
const GRENADE_FUSE = 2.5;             // seconds before a grenade detonates on its own timer

/* --- Buttons ---------------------------------------------------------------- */
const NUKE_CD = 30;                   // seconds until the Nuke button re-arms
const INHIBIT_TIME = 30;              // seconds zombie spawns stay disabled
const BUTTONS = [
  { id: 'nuke',    x: -2.5, y: PLAT_TOP + 0.35, z: 0, r: 0.9 },
  { id: 'inhibit', x:  2.5, y: PLAT_TOP + 0.35, z: 0, r: 0.9 },
];

/* --- Zombies ---------------------------------------------------------------- */
const ZTYPES = {
  walker: { idx: 0, name: 'Walker', hp: 40,  speed: 3.4, dmg: 9,  rate: 0.9, r: 0.62, scale: 1.0 },
  runner: { idx: 1, name: 'Runner', hp: 24,  speed: 5.8, dmg: 7,  rate: 0.7, r: 0.55, scale: 0.85 },
  brute:  { idx: 2, name: 'Brute',  hp: 150, speed: 2.3, dmg: 20, rate: 1.3, r: 0.90, scale: 1.6 },
};
const CLIMB_MAX = 2.6;                // zombies can climb any solid up to this height
const RESPAWN_TIME = 3;               // seconds until a dead player respawns

/* --- Pickups ---------------------------------------------------------------- */
const HEALTH_RESPAWN = 10;            // seconds
const AMMO_RESPAWN = 15;              // seconds

/* --- Static map solids (cover blocks + central platform) --------------------- */
// Arena doubled to +/-80: every cover block / crate / side platform is scaled 2x
// in X/Z and redistributed across the expanded layout. The central platform with
// the NUKE/INHIBIT buttons stays at its original size as the map's focal point.
const SOLIDS = [
  { minX: -PLAT_HALF, maxX: PLAT_HALF, minZ: -PLAT_HALF, maxZ: PLAT_HALF, top: PLAT_TOP }, // center platform
  { minX: -28, maxX: -20, minZ: -6, maxZ: 6,   top: 1.6 },   // west cover block
  { minX:  20, maxX:  28, minZ: -6, maxZ: 6,   top: 1.6 },   // east cover block
  { minX: -6,  maxX:  6,  minZ: -40, maxZ: -32, top: 1.2 },  // north cover block
  { minX: -6,  maxX:  6,  minZ: 32,  maxZ: 40,  top: 1.2 },  // south cover block
  { minX: -16, maxX: -12, minZ: 20,  maxZ: 52,  top: 1.5 },  // west wall segment
  { minX:  12, maxX:  16, minZ: -52, maxZ: -20, top: 1.5 },  // east wall segment
  { minX: -60, maxX: -54, minZ: -60, maxZ: -54, top: 1.4 },  // corner crates
  { minX:  54, maxX:  60, minZ: -60, maxZ: -54, top: 1.4 },
  { minX: -60, maxX: -54, minZ: 54,  maxZ: 60,  top: 1.4 },
  { minX:  54, maxX:  60, minZ: 54,  maxZ: 60,  top: 1.4 },
  { minX: -48, maxX: -36, minZ: 12,  maxZ: 24,  top: 1.8 },  // elevated side platforms (jumpable)
  { minX:  36, maxX:  48, minZ: -24, maxZ: -12, top: 1.8 },
];

/* --- Pickups (defined after SOLIDS so groundHeightAt() can resolve tops) ----- */
// Positions scaled 2x to match the doubled arena.
const PICKUPS = [
  { id: 1, kind: 'health', x: -36, z: -28 },
  { id: 2, kind: 'health', x:  36, z:  28 },
  { id: 3, kind: 'health', x: -28, z:  36 },
  { id: 4, kind: 'health', x:  28, z: -36 },
  { id: 5, kind: 'health', x:   0, z: -52 },
  { id: 6, kind: 'health', x:   0, z:  52 },
  { id: 7, kind: 'ammo',   x: -64, z:   0 },
  { id: 8, kind: 'ammo',   x:  64, z:   0 },
  { id: 9, kind: 'ammo',   x:   0, z: -64 },
  { id: 10, kind: 'ammo',  x:   0, z:  64 },
].map((p) => ({ ...p, y: groundHeightAt(p.x, p.z), taken: false, timer: 0 }));

/* --- Spawn points (perimeter ring) ------------------------------------------ */
// Ring radius doubled to 64 and widened from 8 to 12 points so respawns stay
// well distributed around the expanded +/-80 perimeter.
const SPAWNS = [];
for (let i = 0; i < 12; i++) {
  const a = (i * Math.PI) / 6 + Math.PI / 12;
  SPAWNS.push({ x: Math.cos(a) * 64, z: Math.sin(a) * 64 });
}

/* --- Linked portal teleporters ---------------------------------------------- */
// Paired doorway entities: walking into Portal A instantly translates the player
// (position + momentum vector) out of Portal B, and vice versa. `axis` is the
// doorway's normal axis ('x' or 'z'); `dir` points from the doorway INTO the
// arena (the exit side). The 0.5 s per-player cooldown prevents instant
// re-trigger loops if an exit ever overlaps another trigger zone.
const PORTAL_CD = 0.5;                // seconds before a player may teleport again
const PORTALS = [
  { id: 'A', x: -72, z: -34, axis: 'x', dir: 1 },   // west flank doorway, faces +X into the arena
  { id: 'B', x:  72, z:  34, axis: 'x', dir: -1 },  // east flank doorway, faces -X into the arena
];
const PORTAL_PAIR = { A: 'B', B: 'A' };

/* ============================== WORLD STATE ================================= */

const players = new Map();            // id -> player
const zombies = new Map();            // id -> zombie
const projectiles = [];               // active grenades / rockets
const nextId = { player: 1, zombie: 1, proj: 1 };
const btnState = { nuke: { cd: 0 }, inhibit: { timer: 0 } };

let simTime = 0;                      // seconds of simulated time
let spawnTimer = 2;                   // countdown to next horde spawn
let noPlayerT = 0;                    // how long the arena has been empty

/* ============================== SMALL HELPERS =============================== */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Height of the walkable floor at (x, z): base ground, central platform top,
 * the four ramps leading to it, and the tops of any solid we stand on.
 */
function groundHeightAt(x, z) {
  let h = 0;
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax <= PLAT_HALF && az <= PLAT_HALF) {
    h = PLAT_TOP; // central platform
  } else {
    // one ramp per side, sloping from PLAT_TOP down to 0 over RAMP_LEN
    if (ax <= RAMP_W && az > PLAT_HALF && az <= PLAT_HALF + RAMP_LEN) {
      h = PLAT_TOP * ((PLAT_HALF + RAMP_LEN - az) / RAMP_LEN);
    } else if (az <= RAMP_W && ax > PLAT_HALF && ax <= PLAT_HALF + RAMP_LEN) {
      h = PLAT_TOP * ((PLAT_HALF + RAMP_LEN - ax) / RAMP_LEN);
    }
  }
  for (const s of SOLIDS) {
    if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) h = Math.max(h, s.top);
  }
  return h;
}

/**
 * Resolve horizontal penetration against all solids on one axis.
 * Solids whose top is within STEP of our feet are walkable (not walls).
 * Returns true if the entity was pushed out.
 */
function resolveAxis(ent, axis) {
  let moved = false;
  for (const s of SOLIDS) {
    if (ent.y >= s.top - STEP) continue; // can step over / stand on top
    const ox = Math.min(ent.x + ent.r - s.minX, s.maxX - (ent.x - ent.r));
    const oz = Math.min(ent.z + ent.r - s.minZ, s.maxZ - (ent.z - ent.r));
    if (ox <= 0 || oz <= 0) continue;
    if (axis === 'x') {
      ent.x = ent.x < (s.minX + s.maxX) / 2 ? s.minX - ent.r : s.maxX + ent.r;
      ent.vx = 0;
    } else {
      ent.z = ent.z < (s.minZ + s.maxZ) / 2 ? s.minZ - ent.r : s.maxZ + ent.r;
      ent.vz = 0;
    }
    moved = true;
  }
  return moved;
}

function clampToArena(ent) {
  const B = ARENA_HALF - ent.r;
  if (ent.x > B) { ent.x = B; if (ent.vx > 0) ent.vx = 0; }
  else if (ent.x < -B) { ent.x = -B; if (ent.vx < 0) ent.vx = 0; }
  if (ent.z > B) { ent.z = B; if (ent.vz > 0) ent.vz = 0; }
  else if (ent.z < -B) { ent.z = -B; if (ent.vz < 0) ent.vz = 0; }
}

/* ============================== PLAYER PHYSICS ============================== */

/**
 * Quake 1/3 arena movement (overhauled):
 *  - Base speed: the velocity component ALONG THE FACING direction is capped at
 *    MAXWALK. Ground friction is applied BEFORE acceleration, so held input
 *    always recovers to exactly MAXWALK — no friction tax on top speed.
 *  - Air strafing: air has no friction and the cap applies only to the facing
 *    component, never to total speed. Holding A/D while turning the mouse keeps
 *    that component below MAXWALK, so every tick adds more velocity -> classic
 *    horizontal speed build-up with NO hard cap (bunny hop chains).
 *  - Jump: impulse preserves all horizontal momentum; the halved JUMP_VEL
 *    (11) gives a ~1.6 u apex and a ~0.58 s airtime window for strafing each hop.
 */
function updatePlayerPhysics(p, dt) {
  const inp = p.input;
  // orientation comes from the latest client input (authoritative aim/turning)
  const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);

  // wish direction from forward/strafe input (matches client camera convention)
  let wx = -sy * inp.f + cy * inp.s;
  let wz = -cy * inp.f - sy * inp.s;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }   // normalize diagonal input to unit length

  // ground friction first: exponential decay + hard stop near zero when idle.
  // Applied before acceleration so held input fully recovers MAXWALK.
  if (p.onGround) {
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0.01) {
      const newSp = sp - FRICTION * dt * sp;
      if (newSp <= STOP_SPEED && wl < 0.5) { p.vx = 0; p.vz = 0; }
      else { const k = Math.max(newSp, 0) / sp; p.vx *= k; p.vz *= k; }
    }
  }

  // Quake-style acceleration: add toward the wish direction, but only up to the
  // point where the velocity component along the facing reaches MAXWALK. Total
  // speed is never capped in the air — turning while strafing keeps that
  // component low so each tick adds more -> classic air strafe / bhop build-up.
  if (wl > 0.01) {
    const curDot = p.vx * wx + p.vz * wz;
    if (curDot < MAXWALK) {
      const accel = (p.onGround ? ACCEL_GROUND : ACCEL_AIR);
      const add = Math.min(accel * dt, MAXWALK - curDot);
      p.vx += wx * add;
      p.vz += wz * add;
    }
  }

  // jump (bunny hop: momentum is preserved because air has no friction)
  if (inp.jump && p.onGround) { p.vy = JUMP_VEL; p.onGround = false; }

  // gravity + terminal velocity
  p.vy -= GRAVITY * dt;
  if (p.vy < -60) p.vy = -60;

  // numerical safety net only — NOT a gameplay speed cap. Far above any
  // reachable strafe/bhop speed; keeps per-tick travel below solid thickness so
  // extreme speeds can never tunnel through cover blocks.
  const hsp = Math.hypot(p.vx, p.vz);
  if (hsp > SANITY_MAX) { const k = SANITY_MAX / hsp; p.vx *= k; p.vz *= k; }

  // integrate + collide: X axis, Z axis, then vertical
  p.x += p.vx * dt; resolveAxis(p, 'x');
  p.z += p.vz * dt; resolveAxis(p, 'z');
  clampToArena(p);

  p.y += p.vy * dt;
  const gh = groundHeightAt(p.x, p.z);
  if (p.y <= gh + 0.05 && p.vy <= 0) {
    p.y = gh; p.vy = 0; p.onGround = true;   // landed / resting on floor or ramp
  } else {
    p.onGround = false;
  }
}

/* ============================== PORTAL TELEPORTERS ========================== */

/**
 * Linked Quake-style portal doors: if the player's feet are inside a doorway
 * trigger zone (and their per-player cooldown has elapsed), instantly translate
 * them out of the paired portal. The translation is pure — position offset and
 * the full momentum vector (vx, vy, vz) carry through unchanged, so bhop /
 * blast-jump velocity survives the hop. A 0.5 s cooldown then blocks any
 * re-trigger while the player settles on the far side.
 */
function checkPortals(p) {
  if (p.portalCd > 0) return;
  for (const pt of PORTALS) {
    const along = pt.axis === 'x' ? p.x - pt.x : p.z - pt.z;   // depth into the doorway plane
    const across = pt.axis === 'x' ? p.z - pt.z : p.x - pt.x;  // offset across the doorway width
    if (Math.abs(along) < 1.3 && Math.abs(across) < 1.7) {
      const exit = PORTALS.find((q) => q.id === PORTAL_PAIR[pt.id]);
      const ex = exit.axis === 'x' ? exit.x + exit.dir * 1.5 : exit.x; // just inside the far doorway
      const ez = exit.axis === 'z' ? exit.z + exit.dir * 1.5 : exit.z;
      // preserve height above local ground so mid-air entries land at matching altitude
      const hAbove = Math.max(0, p.y - groundHeightAt(p.x, p.z));
      p.x = ex; p.z = ez;
      p.y = groundHeightAt(ex, ez) + hAbove;
      // momentum vector (vx, vy, vz) is intentionally left untouched: pure translation
      checkGround(p);
      p.portalCd = PORTAL_CD;
      emitEvent({ t: 'portal', p: pt.id });   // client flashes both doorways + whoosh
      return;
    }
  }
}

/* ============================== COMBAT / WEAPONS ============================ */

/** Unit aim vector from the player's latest input yaw/pitch (client YXZ camera convention). */
function aimDir(p) {
  const sy = Math.sin(p.input.yaw), cy = Math.cos(p.input.yaw);
  const cp = Math.cos(p.input.pitch), sp = Math.sin(p.input.pitch);
  return [-sy * cp, sp, -cy * cp];
}

/** Random cone spread around a unit direction. */
function spreadDir(d, spread) {
  const rx = (Math.random() * 2 - 1) * spread;
  const ry = (Math.random() * 2 - 1) * spread;
  const rz = (Math.random() * 2 - 1) * spread;
  let x = d[0] + rx, y = d[1] + ry, z = d[2] + rz;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Ray vs sphere. Returns entry distance t (0 if origin inside), -1 on miss. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;      // d is unit length
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return -1;
  const thc = Math.sqrt(r * r - d2);
  const t0 = tca - thc, t1 = tca + thc;
  if (t0 > 0) return t0;
  return t1 > 0 ? 0 : -1;                       // origin inside sphere
}

/** Ray vs axis-aligned box (slab test). Returns entry t (0 if inside), -1 on miss. */
function rayAABB(ox, oy, oz, dx, dy, dz, minX, maxX, minY, maxY, minZ, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  t1 = (minY - oy) / dy; t2 = (maxY - oy) / dy;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmin > tmax) return -1;
  t1 = (minZ - oz) / dz; t2 = (maxZ - oz) / dz;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmin > tmax) return -1;
  if (tmin > 0) return tmin;
  return tmax > 0 ? 0 : -1;                     // origin inside box
}

/**
 * Raycast against zombies, players, buttons and solid walls.
 * Returns hits sorted by distance: { t, type: 'zombie'|'player'|'button'|'wall', ref }.
 */
function raycastAll(ox, oy, oz, dx, dy, dz, range, excludeId) {
  const hits = [];
  for (const z of zombies.values()) {
    const t = raySphere(ox, oy, oz, dx, dy, dz, z.x, z.y + 0.85, z.z, z.r);
    if (t >= 0 && t < range) hits.push({ t, type: 'zombie', ref: z });
  }
  for (const p of players.values()) {
    if (p.id === excludeId || p.dead) continue;
    const t = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + 0.9, p.z, 0.62);
    if (t >= 0 && t < range) hits.push({ t, type: 'player', ref: p });
  }
  for (const b of BUTTONS) {
    const t = raySphere(ox, oy, oz, dx, dy, dz, b.x, b.y, b.z, b.r);
    if (t >= 0 && t < range) hits.push({ t, type: 'button', ref: b });
  }
  for (const s of SOLIDS) {
    const t = rayAABB(ox, oy, oz, dx, dy, dz, s.minX, s.maxX, 0, s.top, s.minZ, s.maxZ);
    if (t >= 0 && t < range) hits.push({ t, type: 'wall', ref: s });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

function applyHit(p, hit, dmg) {
  if (hit.type === 'zombie') damageZombie(hit.ref, dmg, p.id);
  else if (hit.type === 'player') damagePlayer(hit.ref, dmg, p.id);
  else if (hit.type === 'button') triggerButton(hit.ref.id, p.id);
}

function fireWeapon(p, w) {
  p.ammo[w.ammo]--;
  p.fireCd = w.rate;
  const ox = p.x, oy = p.y + EYE, oz = p.z;
  const dir = aimDir(p);
  let endT = w.range || 60;

  if (w.kind === 'projectile') {
    projectiles.push({
      id: nextId.proj++, wi: WEAPONS.indexOf(w), owner: p.id, age: 0,
      // muzzle offset along the aim vector; y uses a shorter reach so a rocket
      // fired straight down still takes ~3 ticks to hit the floor — long enough
      // for a moving shooter to pull ahead of it (the lag that makes rjumps work)
      x: ox + dir[0] * 0.8, y: oy + dir[1] * 0.4, z: oz + dir[2] * 0.8,
      vx: dir[0] * w.projSpeed + p.vx * 0.35, vy: dir[1] * w.projSpeed + p.vy * 0.35, vz: dir[2] * w.projSpeed + p.vz * 0.35,
      gravity: !!w.gravity, dmg: w.dmg, blastR: w.blastR, impulse: w.impulse,
    });
  } else if (w.kind === 'rail') {
    // Railgun: penetrates every zombie/player in a straight line (walls stop it).
    const hits = raycastAll(ox, oy, oz, dir[0], dir[1], dir[2], w.range, p.id);
    let i = 0;
    for (const hit of hits) {
      if (hit.type === 'wall') { endT = hit.t; break; }
      applyHit(p, hit, w.dmg * Math.pow(0.8, i));   // slight falloff per target passed
      i++;
      endT = Math.max(endT, hit.t);
    }
  } else if (w.pellets > 1) {
    // Shotgun / Super Shotgun: independent pellet rays.
    for (let i = 0; i < w.pellets; i++) {
      const d = spreadDir(dir, w.spread);
      const hits = raycastAll(ox, oy, oz, d[0], d[1], d[2], w.range, p.id);
      if (hits.length) { applyHit(p, hits[0], w.dmg); endT = Math.min(endT, hits[0].t); }
    }
  } else {
    // Single hitscan ray (Assault Rifle / Lightning Gun tick).
    const hits = raycastAll(ox, oy, oz, dir[0], dir[1], dir[2], w.range, p.id);
    if (hits.length) { applyHit(p, hits[0], w.dmg); endT = hits[0].t; }
  }

  emitEvent({
    t: 'shot', s: p.id, w: w.id,
    x: r2(ox), y: r2(oy), z: r2(oz),
    dx: r3(dir[0]), dy: r3(dir[1]), dz: r3(dir[2]),
    hx: r2(ox + dir[0] * endT), hy: r2(oy + dir[1] * endT), hz: r2(oz + dir[2] * endT),
  });
}

function updateWeapon(p, dt) {
  p.fireCd -= dt;
  const w = WEAPONS[p.weapon];
  if (p.input.fire && !p.dead) {
    // auto weapons fire continuously; semi-auto weapons fire on the press edge
    if (w.auto || !p.firingHeld) {
      if (p.fireCd <= 0 && p.ammo[w.ammo] > 0) fireWeapon(p, w);
    }
  }
  p.firingHeld = !!p.input.fire;
}

/* ============================== DAMAGE / DEATHS ============================= */

function damagePlayer(p, dmg, killerId) {
  if (p.dead || !(dmg > 0)) return;
  p.hp -= dmg;
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    p.respawnT = RESPAWN_TIME;
    p.deaths++;
    let kname = 'the arena';
    if (killerId && killerId !== p.id && players.has(killerId)) {
      const k = players.get(killerId);
      k.kills++;
      kname = k.name;
    }
    emitEvent({ t: 'kill', k: kname, v: p.name, s: killerId || 0 });
  }
}

function damageZombie(z, dmg, killerId) {
  if (z.hp <= 0 || !(dmg > 0)) return;
  z.hp -= dmg;
  emitEvent({ t: 'hit', id: z.id });
  if (z.hp <= 0) {
    zombies.delete(z.id);
    let kname = 'the arena';
    if (killerId && players.has(killerId)) {
      const k = players.get(killerId);
      k.kills++;
      kname = k.name;
    }
    emitEvent({ t: 'zdie', id: z.id, x: r2(z.x), y: r2(z.y + 0.8), z: r2(z.z) });
  }
}

/* ============================== BLAST JUMP ENGINE =========================== */

const SELF_DMG = 0.35; // fraction of blast damage taken by the shooter (rjump-friendly)

/**
 * Radial explosion: damages every player and zombie inside the blast radius
 * and applies a PURE RADIAL impulse vector computed from the blast center to
 * each entity's position. There is no vertical bias — the jump angle comes
 * entirely from where the blast lands relative to you: a rocket that lags
 * behind your motion explodes below-behind your feet, so the radial vector is
 * strongly angled up+forward -> proper rocket jumps instead of straight
 * vertical pencil pops. (Projectiles inherit 35 % of shooter velocity, which
 * is what makes downward shots land behind a moving player.)
 */
function explode(x, y, z, radius, dmg, impulse, ownerId) {
  // defensive: a corrupt projectile state must never poison player velocities
  // (NaN velocity -> NaN snapshot -> dark screens on every client)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

  emitEvent({ t: 'explosion', x: r2(x), y: r2(y), z: r2(z), r: radius });

  const blast = (cx, cy, cz, ent, isPlayer) => {
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;
    let dx = cx - x, dy = cy - y, dz = cz - z;   // blast center -> entity position
    const d = Math.hypot(dx, dy, dz);
    if (d > radius + 0.6) return;
    const fall = Math.max(0, 1 - d / (radius + 0.6));
    let nx, ny, nz;
    if (d < 0.001) { nx = 0; ny = 1; nz = 0; } else { nx = dx / d; ny = dy / d; nz = dz / d; }
    // pure radial impulse: full strength on all three axes, direction relative
    // to the entity's position -> strong angled horizontal + vertical boosts
    ent.vx += nx * impulse * fall;
    ent.vy += ny * impulse * fall;
    ent.vz += nz * impulse * fall;
    if (isPlayer) {
      if (ownerId === ent.id) damagePlayer(ent, dmg * fall * SELF_DMG, null);
      else damagePlayer(ent, dmg * fall, ownerId);
    } else {
      damageZombie(ent, dmg * fall, ownerId);
    }
  };

  for (const p of players.values()) if (!p.dead) blast(p.x, p.y + 0.9, p.z, p, true);
  for (const z of zombies.values()) blast(z.x, z.y + 0.85, z.z, z, false);
}

/* ============================== PROJECTILES ================================= */

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.age += dt;
    const w = WEAPONS[pr.wi];

    // --- Nailgun nails: fast straight darts, direct-hit damage, no radial blast ---
    if (w.id === 'nail') { stepNail(pr, i, dt); continue; }

    if (pr.gravity) pr.vy -= GRAVITY * 0.55 * dt;   // grenades arc, rockets fly straight
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.z += pr.vz * dt;

    const isGrenade = w.id === 'grenade';
    let boom = false;

    // ground / ramp impact: grenades bounce + roll (restitution) instead of detonating,
    // rockets still explode on contact.
    const gh = groundHeightAt(pr.x, pr.z);
    if (pr.y <= gh + 0.12) {
      if (isGrenade && pr.age < GRENADE_FUSE) {
        pr.y = gh + 0.15;
        if (pr.vy < -0.5) {                 // falling onto the surface: bounce
          pr.vy = -pr.vy * 0.45;            //   restitution on the vertical axis
          pr.vx *= 0.75;                    //   dampen horizontal velocity
          pr.vz *= 0.75;
        } else if (Math.abs(pr.vy) < 1.0) {
          pr.vy = 0;                        //   settled: roll along the surface
        }
        const fr = Math.max(0, 1 - 2.5 * dt); // rolling friction while in ground contact
        pr.vx *= fr; pr.vz *= fr;
      } else { boom = true; }
    }

    // solid wall impact: grenades reflect off the nearest face and keep rolling,
    // rockets detonate on contact.
    for (const s of SOLIDS) {
      if (pr.x > s.minX - 0.1 && pr.x < s.maxX + 0.1 &&
          pr.z > s.minZ - 0.1 && pr.z < s.maxZ + 0.1 &&
          pr.y < s.top + 0.1) {
        if (isGrenade && pr.age < GRENADE_FUSE) {
          const dxMin = pr.x - (s.minX - 0.1), dxMax = (s.maxX + 0.1) - pr.x;
          const dzMin = pr.z - (s.minZ - 0.1), dzMax = (s.maxZ + 0.1) - pr.z;
          const m = Math.min(dxMin, dxMax, dzMin, dzMax); // nearest penetrated face
          if (m === dxMin)      { pr.x = s.minX - 0.15; pr.vx = -pr.vx * 0.45; }
          else if (m === dxMax) { pr.x = s.maxX + 0.15; pr.vx = -pr.vx * 0.45; }
          else if (m === dzMin) { pr.z = s.minZ - 0.15; pr.vz = -pr.vz * 0.45; }
          else                  { pr.z = s.maxZ + 0.15; pr.vz = -pr.vz * 0.45; }
          pr.vx *= 0.75; pr.vz *= 0.75;      // lose energy on the bounce
        } else boom = true;
        break;
      }
    }

    // direct-impact detonation: a grenade that strikes a zombie directly explodes now
    if (!boom && isGrenade) {
      for (const z of zombies.values()) {
        const d = Math.hypot(z.x - pr.x, (z.y + 0.85) - pr.y, z.z - pr.z);
        if (d < z.r + 0.35) { boom = true; break; }
      }
    }

    // arena bounds / sky
    if (Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF || pr.y > 70) boom = true;

    // interactive buttons
    for (const b of BUTTONS) {
      const d = Math.hypot(pr.x - b.x, pr.y - b.y, pr.z - b.z);
      if (d < b.r + 0.35) { triggerButton(b.id, pr.owner); boom = true; }
    }

    // owner collision after a short fuse (enables self rocket-jumps / grenade jumps)
    const op = players.get(pr.owner);
    if (op && !op.dead && pr.age > 0.22) {
      const d = Math.hypot(op.x - pr.x, (op.y + 0.9) - pr.y, op.z - pr.z);
      if (d < 0.75) boom = true;
    }

    // timed fuse detonation (grenades) / max lifetime safety (rockets)
    if ((isGrenade && pr.age >= GRENADE_FUSE) || (!isGrenade && pr.age > 6)) boom = true;

    if (boom) {
      projectiles.splice(i, 1);
      explode(pr.x, pr.y, pr.z, pr.blastR, pr.dmg, pr.impulse, pr.owner);
    }
  }
}

/**
 * Nailgun nail: a fast straight-line dart. It deals direct impact damage to the first
 * zombie (or other player) it touches and is stopped by walls/ground — no radial blast.
 * The shooter's own nails never self-damage (standard Quake behavior).
 */
function stepNail(pr, idx, dt) {
  pr.x += pr.vx * dt;
  pr.y += pr.vy * dt;
  pr.z += pr.vz * dt;

  let hit = false;

  // zombies are the primary target (direct impact damage per nail)
  for (const z of zombies.values()) {
    const d = Math.hypot(z.x - pr.x, (z.y + 0.85) - pr.y, z.z - pr.z);
    if (d < z.r + 0.2) { damageZombie(z, pr.dmg, pr.owner); hit = true; break; }
  }

  // other players (skip the owner so your own nails never hurt you)
  if (!hit) for (const p of players.values()) {
    if (p.id === pr.owner || p.dead) continue;
    const d = Math.hypot(p.x - pr.x, (p.y + 0.9) - pr.y, p.z - pr.z);
    if (d < 0.82) { damagePlayer(p, pr.dmg, pr.owner); hit = true; break; }
  }

  // solid walls stop the nail
  if (!hit) for (const s of SOLIDS) {
    if (pr.x > s.minX && pr.x < s.maxX && pr.z > s.minZ && pr.z < s.maxZ && pr.y < s.top) { hit = true; break; }
  }

  // ground / arena bounds / max lifetime safety
  const gh = groundHeightAt(pr.x, pr.z);
  if (pr.y <= gh + 0.1) hit = true;
  if (Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF || pr.y > 70) hit = true;
  if (pr.age > 2) hit = true;

  if (hit) {
    projectiles.splice(idx, 1);
    emitEvent({ t: 'nailhit', x: r2(pr.x), y: r2(pr.y), z: r2(pr.z) }); // small impact spark on the client
  }
}

/* ============================== INTERACTIVE BUTTONS ========================= */

function triggerButton(id, shooterId) {
  if (id === 'nuke') {
    if (btnState.nuke.cd > 0) return;              // on cooldown -> ignore
    btnState.nuke.cd = NUKE_CD;                     // start the 30 s overhead meter
    for (const z of zombies.values()) {
      emitEvent({ t: 'zdie', id: z.id, x: r2(z.x), y: r2(z.y + 0.8), z: r2(z.z) });
    }
    zombies.clear();                                // immediate wipe of all active zombies
    emitEvent({ t: 'button', which: 'nuke', on: true });
  } else if (id === 'inhibit') {
    btnState.inhibit.timer = INHIBIT_TIME;          // disable spawns for 30 s
    emitEvent({ t: 'button', which: 'inhibit', on: true });
  }
}

/* ============================== ZOMBIE AI ENGINE ============================ */

/** Inverse player scaling: more players -> longer interval (lower spawn rate). */
function spawnInterval(playerCount) {
  return Math.min(4.5, 1.3 + 0.7 * (playerCount - 1));
}

function maxZombies(playerCount) {
  return Math.min(64, 20 + 12 * playerCount);
}

function spawnZombie() {
  const t = simTime;
  let type = 'walker';
  const roll = Math.random();
  if (t > 90 && roll < Math.min(0.15, (t - 90) / 600)) type = 'brute';
  else if (t > 45 && roll < Math.min(0.45, 0.12 + (t - 45) / 300)) type = 'runner';
  const spec = ZTYPES[type];

  // pick a perimeter spawn point that is far from every active player
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const rad = ARENA_HALF - 3 - Math.random() * 4;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    let minD = Infinity;
    for (const p of players.values()) if (!p.dead) minD = Math.min(minD, Math.hypot(p.x - x, p.z - z));
    const score = (minD === Infinity ? 0 : minD) + Math.random() * 6;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }

  const id = nextId.zombie++;
  zombies.set(id, {
    id, type,
    x: best.x, y: groundHeightAt(best.x, best.z), z: best.z, vy: 0,
    hp: Math.round(spec.hp * (1 + t / 600)),       // slow difficulty ramp
    speed: spec.speed, dmg: spec.dmg, rate: spec.rate, r: spec.r,
    atkCd: 1.0, wx: 0, wz: 0, wanderT: 0,
  });
  emitEvent({ t: 'zspawn', id, x: r2(best.x), y: r2(groundHeightAt(best.x, best.z)), z: r2(best.z) });
}

function nearestPlayer(z) {
  let best = null, bd = Infinity;
  for (const p of players.values()) {
    if (p.dead) continue;
    const d = Math.hypot(p.x - z.x, p.z - z.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function updateZombies(dt) {
  for (const z of zombies.values()) {
    z.atkCd -= dt;
    const target = nearestPlayer(z);
    let dx, dz;
    if (target) {
      dx = target.x - z.x;
      dz = target.z - z.z;
    } else {
      // no players: wander the arena
      z.wanderT -= dt;
      if (z.wanderT <= 0 || (!z.wx && !z.wz)) {
        const a = Math.random() * Math.PI * 2;
        z.wx = Math.cos(a); z.wz = Math.sin(a);
        z.wanderT = 2 + Math.random() * 3;
      }
      dx = z.wx; dz = z.wz;
    }
    const d = Math.hypot(dx, dz) || 1;

    // path toward the nearest active player (direct steering + wall collision)
    const bx = z.x, bz = z.z;
    z.x += (dx / d) * z.speed * dt; resolveAxis(z, 'x');
    z.z += (dz / d) * z.speed * dt; resolveAxis(z, 'z');
    clampToArena(z);

    // blocked by a wall? climb onto any solid low enough (relentless horde)
    if ((Math.abs(z.x - bx) + Math.abs(z.z - bz)) < z.speed * dt * 0.35 && target) {
      for (const s of SOLIDS) {
        if (s.top > z.y + STEP && s.top <= CLIMB_MAX) {
          const ox = Math.min(z.x + z.r + 0.15 - s.minX, s.maxX - (z.x - z.r - 0.15));
          const oz = Math.min(z.z + z.r + 0.15 - s.minZ, s.maxZ - (z.z - z.r - 0.15));
          if (ox > 0 && oz > 0) { z.y = s.top; break; }
        }
      }
    }

    // vertical: zombies are glued to the floor with simple gravity for falls
    z.vy -= GRAVITY * dt;
    z.y += z.vy * dt;
    const gh = groundHeightAt(z.x, z.z);
    if (z.y <= gh && z.vy <= 0) { z.y = gh; z.vy = 0; }

    // melee contact damage
    if (target) {
      const hd = Math.hypot(target.x - z.x, target.z - z.z);
      if (hd < 1.5 && Math.abs(target.y - z.y) < 1.6 && z.atkCd <= 0) {
        damagePlayer(target, z.dmg, null);
        z.atkCd = z.rate;
        target.socket.emit('event', { t: 'hurt' });   // victim-only feedback (flash + sound)
      }
    }
  }

  // cheap pairwise separation so the horde does not stack into one blob
  const arr = [...zombies.values()];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const minD = a.r + b.r + 0.15;
      if (d > 0.001 && d < minD) {
        const push = ((minD - d) * 0.5) / d;
        a.x -= dx * push; a.z -= dz * push;
        b.x += dx * push; b.z += dz * push;
      }
    }
  }
}

/* ============================== PICKUPS / RESPAWN =========================== */

function checkPickups(p) {
  for (const pk of PICKUPS) {
    if (pk.taken) continue;
    const d = Math.hypot(p.x - pk.x, p.z - pk.z);
    if (d < 1.3 && Math.abs(p.y + 0.9 - (pk.y + 0.6)) < 2.5) {
      if (pk.kind === 'health') {
        if (p.hp >= 100) continue;                  // no over-healing
        p.hp = Math.min(100, p.hp + 25);            // +25 HP pack
      } else {
        for (const k in AMMO_MAX) p.ammo[k] = AMMO_MAX[k];   // full ammo crate
      }
      pk.taken = true;
      pk.timer = pk.kind === 'health' ? HEALTH_RESPAWN : AMMO_RESPAWN;
      emitEvent({ t: 'pickup', id: pk.id, kind: pk.kind });
    }
  }
}

/**
 * Immediate ground check: resolve an entity against its local floor exactly like
 * physics does — snap onto the surface when at/below floor level while falling,
 * or mark it airborne otherwise. Spawn placement calls this right after lifting
 * the entity above ground level so state is consistent before the first snapshot.
 */
function checkGround(ent) {
  const gh = groundHeightAt(ent.x, ent.z);
  if (ent.y <= gh + 0.05 && ent.vy <= 0) {     // at/below floor while falling -> snap on top
    ent.y = gh;
    ent.vy = 0;
    ent.onGround = true;
  } else {
    ent.onGround = false;                      // airborne: physics settles the drop next tick
  }
}

function pickSpawnPoint(self) {
  let best = null, bestScore = -Infinity;
  for (const s of SPAWNS) {
    let minZ = Infinity, minP = Infinity;
    for (const z of zombies.values()) minZ = Math.min(minZ, Math.hypot(z.x - s.x, z.z - s.z));
    for (const q of players.values()) if (q !== self && !q.dead) minP = Math.min(minP, Math.hypot(q.x - s.x, q.z - s.z));
    const score = Math.min(minZ === Infinity ? 99 : minZ, 99) + Math.min(minP === Infinity ? 99 : minP, 99) * 0.5;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best || SPAWNS[0];
}

function respawn(p) {
  const s = pickSpawnPoint(p);
  p.x = s.x; p.z = s.z;
  p.y = groundHeightAt(s.x, s.z) + SPAWN_ABOVE; // start above the floor mesh (never clip in)
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.portalCd = 0;    // fresh portal cooldown on respawn
  checkGround(p);    // immediate ground check: consistent state before the first snapshot
  p.hp = 100;
  p.dead = false;
  for (const k in AMMO_MAX) p.ammo[k] = AMMO_MAX[k]; // full weapon loadout granted on spawn
}

/* ============================== NETWORKING ================================== */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);   // NPM+ reverse proxy: honor X-Forwarded-For / real IPs
// No-cache for all client assets: browsers/proxies must always pull fresh scripts
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  },
}));
// three.js is served straight from node_modules (no build step) for the import map
app.use('/vendor', express.static(path.join(__dirname, 'node_modules'), { maxAge: '7d' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, players: players.size, zombies: zombies.size, uptime: process.uptime() });
});

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }, // same-origin behind NPM+; open for LAN testing
  serveClient: true,                               // /socket.io/socket.io.js
  path: '/socket.io',                              // default WS upgrade path (NPM+ passes Upgrade through)
});

function sanitizeName(name) {
  if (typeof name !== 'string') return 'PLAYER';
  const clean = name.replace(/[^\w \-!]/g, '').trim().slice(0, 16);
  return clean || 'PLAYER';
}

function createPlayer(socket, name) {
  const s = pickSpawnPoint(null);
  const yaw = Math.atan2(s.x, s.z); // face the arena center
  const p = {
    id: nextId.player++, socket, name,
    x: s.x, y: groundHeightAt(s.x, s.z) + SPAWN_ABOVE, z: s.z, vx: 0, vy: 0, vz: 0,
    yaw, pitch: 0,
    hp: 100, dead: false, respawnT: 0, onGround: false, // airborne until the spawn drop settles
    portalCd: 0,                                        // linked-portal teleport cooldown (s)
    weapon: 0, ammo: { ...AMMO_MAX }, fireCd: 0, firingHeld: false,
    input: { f: 0, s: 0, jump: false, fire: false, yaw, pitch: 0 },
    kills: 0, deaths: 0, r: PLAYER_R, h: PLAYER_H,
  };
  checkGround(p); // immediate ground check after spawn placement
  return p;
}

function buildInit(p) {
  return {
    you: p.id,
    name: p.name,
    map: {
      arenaHalf: ARENA_HALF,
      solids: SOLIDS.map((s) => [s.minX, s.maxX, s.minZ, s.maxZ, s.top]),
      plat: [PLAT_HALF, PLAT_TOP, RAMP_LEN, RAMP_W],
      buttons: BUTTONS.map((b) => ({ id: b.id, x: b.x, y: b.y, z: b.z, r: b.r })),
      portals: PORTALS.map((pt) => ({ id: pt.id, x: pt.x, z: pt.z, axis: pt.axis, dir: pt.dir })),
      pickups: PICKUPS.map((k) => [k.id, k.kind, k.x, k.y, k.z]),
    },
    weapons: WEAPONS.map((w) => ({ id: w.id, name: w.name, auto: w.auto, rate: w.rate, dmg: w.dmg, ammo: w.ammo, maxAmmo: w.maxAmmo })),
    ztypes: Object.values(ZTYPES).map((z) => ({ idx: z.idx, name: z.name, scale: z.scale })),
  };
}

function applyInput(p, inp) {
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
  p.input.f = clamp(n(inp.f, 0), -1, 1);
  p.input.s = clamp(n(inp.s, 0), -1, 1);
  p.input.jump = !!inp.jump;
  p.input.fire = !!inp.fire;
  p.input.yaw = n(inp.yaw, p.input.yaw);
  p.input.pitch = clamp(n(inp.pitch, p.input.pitch), -1.57, 1.57);
  const w = Math.floor(n(inp.w, p.weapon));
  if (w >= 0 && w < WEAPONS.length) p.weapon = w;
}

io.on('connection', (socket) => {
  let player = null;

  socket.on('join', (data) => {
    if (player) return;
    player = createPlayer(socket, data && data.name);
    players.set(player.id, player);
    socket.emit('init', buildInit(player));
    emitEvent({ t: 'msg', text: `${player.name} entered the arena` });
  });

  socket.on('input', (inp) => { if (player) applyInput(player, inp || {}); });

  socket.on('switchWeapon', (i) => {
    if (!player) return;
    const w = Math.floor(Number(i));
    if (w >= 0 && w < WEAPONS.length) player.weapon = w;
  });

  // Session-only chat relay: sanitize the incoming text and broadcast it to every
  // connected client. Nothing is persisted or stored on the server — message
  // history lives only in each client's DOM for the duration of its session.
  socket.on('chatMessage', (data) => {
    const raw = typeof data === 'string' ? data : (data && typeof data.text === 'string') ? data.text : '';
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    if (!text) return;
    io.emit('chatMessage', { name: player ? player.name : 'GUEST', text });
  });

  socket.on('disconnect', () => {
    if (!player) return;
    players.delete(player.id);
    emitEvent({ t: 'msg', text: `${player.name} left the arena` });
  });
});

function emitEvent(e) { io.emit('event', e); }

/* ============================== SNAPSHOT ==================================== */

/** Compact world snapshot, broadcast at 30 Hz. Arrays keep payloads small. */
function buildSnapshot() {
  // player entry layout: [id, x, y, z, yaw, pitch, hp, weapon, dead, respawnT,
  //                       rifle, shells, nades, rockets, cells, rail, name, nails]
  // (nails is appended LAST so every existing index — incl. name at 16 — stays stable)
  const p = [];
  for (const pl of players.values()) {
    p.push([pl.id, r2(pl.x), r2(pl.y), r2(pl.z), r3(pl.input.yaw), r3(pl.input.pitch),
      Math.max(0, Math.round(pl.hp)), pl.weapon, pl.dead ? 1 : 0, r1(Math.max(0, pl.respawnT)),
      pl.ammo.rifle, pl.ammo.shells, pl.ammo.nades, pl.ammo.rockets, pl.ammo.cells, pl.ammo.rail, pl.name, pl.ammo.nails]);
  }
  const z = [];
  for (const zz of zombies.values()) {
    z.push([zz.id, r2(zz.x), r2(zz.y), r2(zz.z), ZTYPES[zz.type].idx, Math.max(0, Math.round(zz.hp))]);
  }
  const pr = [];
  for (const q of projectiles) pr.push([q.id, r2(q.x), r2(q.y), r2(q.z), q.wi]);
  return {
    p, z, pr,
    b: { n: btnState.nuke.cd > 0 ? r3(1 - btnState.nuke.cd / NUKE_CD) : 1, i: Math.max(0, r1(btnState.inhibit.timer)) },
    pk: PICKUPS.filter((k) => !k.taken).map((k) => k.id),
  };
}

/* ============================== MAIN LOOP =================================== */

function step(dt) {
  simTime += dt;

  // button timers (30 s nuke cooldown / 30 s inhibit window)
  if (btnState.nuke.cd > 0) btnState.nuke.cd = Math.max(0, btnState.nuke.cd - dt);
  if (btnState.inhibit.timer > 0) btnState.inhibit.timer -= dt;

  // pickup respawn timers
  for (const pk of PICKUPS) {
    if (pk.taken) {
      pk.timer -= dt;
      if (pk.timer <= 0) pk.taken = false;
    }
  }

  const alivePlayers = [...players.values()].filter((p) => !p.dead).length;

  // players: physics, weapons, pickups, respawn
  for (const p of players.values()) {
    if (p.dead) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) respawn(p);
      continue;
    }
    if (p.portalCd > 0) p.portalCd = Math.max(0, p.portalCd - dt); // linked-portal cooldown
    updatePlayerPhysics(p, dt);
    checkPortals(p);   // doorway trigger -> instant translation to the paired portal
    updateWeapon(p, dt);
    checkPickups(p);
  }

  // projectiles + explosions (blast jump engine lives in explode())
  updateProjectiles(dt);

  // zombie horde AI
  updateZombies(dt);

  // out-of-bounds safety net: any entity that fell below the arena (y < -10) is
  // relocated to a valid spawn. Players keep hp/ammo — glitch recovery, not death.
  for (const p of players.values()) {
    if (!p.dead && p.y < OOB_Y) {
      const s = pickSpawnPoint(p);
      p.x = s.x; p.z = s.z;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.y = groundHeightAt(s.x, s.z) + SPAWN_ABOVE; // spawn above ground level
      checkGround(p);                               // immediate ground check
    }
  }
  for (const z of zombies.values()) {
    if (z.y < OOB_Y) {
      const a = Math.random() * Math.PI * 2;
      const rad = ARENA_HALF - 3 - Math.random() * 4; // same perimeter band as spawnZombie()
      z.x = Math.cos(a) * rad; z.z = Math.sin(a) * rad;
      z.y = groundHeightAt(z.x, z.z); // zombies are glued to the floor
      z.vy = 0;
    }
  }

  // continuous horde spawner with inverse player scaling; paused while inhibited
  if (alivePlayers > 0 && btnState.inhibit.timer <= 0) {
    spawnTimer -= dt;
    if (spawnTimer <= 0 && zombies.size < maxZombies(alivePlayers)) {
      spawnZombie();
      spawnTimer = spawnInterval(alivePlayers);
    }
  } else {
    spawnTimer = Math.min(spawnTimer, 0.5); // stay ready to resume instantly
  }

  // empty arena: let the horde burn out after a while (server keeps running)
  if (players.size === 0) {
    noPlayerT += dt;
    if (noPlayerT > 30 && zombies.size > 0) {
      for (const z of zombies.values()) emitEvent({ t: 'zdie', id: z.id, x: r2(z.x), y: r2(z.y + 0.8), z: r2(z.z) });
      zombies.clear();
    }
  } else {
    noPlayerT = 0;
  }
}

let last = performance.now();
let acc = 0;
let tickCount = 0;

function frame() {
  const now = performance.now();
  let elapsed = (now - last) / 1000;
  last = now;
  if (elapsed > 0.25) elapsed = 0.25;   // clamp after GC pauses / stalls
  acc += elapsed;
  while (acc >= DT) { step(DT); tickCount++; acc -= DT; }
  if (tickCount % SNAPSHOT_EVERY === 0 && io.engine.clientsCount > 0) {
    io.emit('state', buildSnapshot());
  }
  setTimeout(frame, 8);                  // ~120 Hz scheduler around the 60 FPS sim
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[quakeclone] authoritative server listening on http://${HOST}:${PORT}`);
  console.log(`[quakeclone] simulation: ${TICK_RATE} FPS fixed-step | snapshots every ${SNAPSHOT_EVERY} ticks`);
  console.log('[quakeclone] proxy-safe for NPM+: trust proxy enabled, /socket.io WS upgrade path');
});

setTimeout(frame, 16);
