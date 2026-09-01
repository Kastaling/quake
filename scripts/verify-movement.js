'use strict';
/**
 * Headless verification of the overhauled movement + blast physics in server.js.
 * Loads the pre-networking portion of server.js (pure simulation code, no HTTP)
 * and drives updatePlayerPhysics / fireWeapon / updateProjectiles at 60 Hz:
 *   - base walk speed recovers to exactly MAXWALK on ground (friction-first order)
 *   - friction stop time from full speed
 *   - jump apex + airtime window
 *   - classic air strafing (hold strafe + turn mouse, bhop chain) builds
 *     horizontal speed with NO hard cap (old 34 u/s ceiling is gone)
 *   - blast impulses are pure radial relative to player position: angled
 *     up+forward for a moving shooter (proper rocket jump), and purely
 *     horizontal for a side blast (no vertical pencil bias)
 * Exits 0 on PASS, 1 on FAIL.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` (${detail})` : ''}`);
  if (!cond) failures++;
}

/* --- load the sim portion of server.js (everything before NETWORKING) -------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cut = src.indexOf('/* ============================== NETWORKING');
if (cut < 0) { console.error('FAIL could not locate networking section marker in server.js'); process.exit(1); }
let code = src.slice(0, cut);
code += '\nconst __events = [];\nfunction emitEvent(e){ __events.push(e); }\n';
const api = new Function('require', code + `
  return { updatePlayerPhysics, explode, fireWeapon, updateProjectiles, groundHeightAt,
           projectiles, players, zombies, SOLIDS, GRAVITY, JUMP_VEL, MAXWALK, ACCEL_GROUND,
           ACCEL_AIR, FRICTION, STOP_SPEED, SANITY_MAX, WEAPONS, __events };
`)(require);

const DT = 1 / 60;

function makePlayer(x, z) {
  const y = api.groundHeightAt(x, z);
  const p = {
    id: 900, x, y, z, vx: 0, vy: 0, vz: 0, yaw: -Math.PI / 2, pitch: 0,
    hp: 100, dead: false, respawnT: 0, onGround: true,
    weapon: 4, ammo: { rifle: 96, shells: 24, nades: 8, rockets: 8, cells: 200, rail: 8 },
    fireCd: 0, firingHeld: false, kills: 0, deaths: 0, r: 0.45, h: 1.7, name: 'TEST',
    input: { f: 0, s: 0, jump: false, fire: false, yaw: -Math.PI / 2, pitch: 0 },
  };
  // register in the world's player map exactly like createPlayer() does in
  // production — explode()'s radial impulse loop iterates players.values(), so a
  // standalone test player must live there for blasts to reach it.
  api.players.set(p.id, p);
  return p;
}

function step(p, n) { for (let i = 0; i < n; i++) api.updatePlayerPhysics(p, DT); }
const hspeed = (p) => Math.hypot(p.vx, p.vz);

/* --- 1. base walk speed ------------------------------------------------------ */
{
  const p = makePlayer(-16, 8);     // open ground east of the elevated platform
  p.input.yaw = -Math.PI / 2;       // face +x: ~55 u of clear run before any wall
  p.input.f = 1;                    // hold W
  step(p, 60 * 2);                  // run for 2 s (steady state reached in ~0.1 s)
  check('walk: recovers to base speed MAXWALK on ground', Math.abs(hspeed(p) - api.MAXWALK) < 0.25,
    `v=${hspeed(p).toFixed(2)} vs ${api.MAXWALK}`);
}

/* --- 2. friction stop --------------------------------------------------------- */
{
  const p = makePlayer(-16, 8);     // same clear lane: coast ends well short of any wall
  p.input.yaw = -Math.PI / 2;       // face +x
  p.input.f = 1; step(p, 60 * 2);
  const v0 = hspeed(p);
  p.input.f = 0;                    // release all keys
  let t = 0;
  while (hspeed(p) > api.STOP_SPEED && t < 60 * 5) { step(p, 1); t++; }
  check('friction: crisp stop from full speed in ~0.3-0.7 s', v0 > 12 && t / 60 >= 0.25 && t / 60 <= 0.8,
    `t=${(t / 60).toFixed(2)}s from ${v0.toFixed(1)}`);
}

/* --- 3. jump apex + airtime ---------------------------------------------------- */
{
  const p = makePlayer(24, 8);      // flat open ground, no nearby height changes
  p.vy = api.JUMP_VEL;              // take off (same as the jump branch)
  p.onGround = false;
  let apex = 0, air = 0;
  while (!p.onGround && air < 60 * 10) { if (p.y > apex) apex = p.y; step(p, 1); air++; }
  const h = apex - api.groundHeightAt(p.x, p.z);
  const expectH = (api.JUMP_VEL * api.JUMP_VEL) / (2 * api.GRAVITY);
  check('jump: apex ~4 u', Math.abs(h - expectH) < 0.35, `apex=${h.toFixed(2)}u (expect ${expectH.toFixed(2)})`);
  check('jump: airtime ~1 s strafe window', air / 60 >= 0.8 && air / 60 <= 1.2, `${(air / 60).toFixed(2)}s`);
}

/* --- 4. classic air strafing (turn + strafe bhop chain) ------------------------ */
{
  // Treadmill: snap the player back to the start line when near a perimeter wall
  // so the strafe loop can run indefinitely without walls interfering. Interior
  // cover blocks may cause brief dips, so growth is judged on averages/peaks.
  const OMEGA = 3.5;                // mouse turn rate while strafing (rad/s)

  function strafeRun(strafeKey, flipEveryTicks) {
    const p = makePlayer(-30, 8);   // open ground west of center, facing +x
    p.input.f = 1;                  // run-up to base speed first
    step(p, 60 * 2);

    p.input.f = 0; p.input.s = strafeKey;   // hold A or D (strafe), keep turning
    p.input.jump = true;                    // auto bunny hop on every landing
    let dirn = 1, peak = hspeed(p);
    const N = 60 * 12;                     // 12 s of strafe bhop
    for (let i = 0; i < N; i++) {
      if (flipEveryTicks && i % flipEveryTicks === 0) dirn *= -1;
      p.input.yaw += dirn * OMEGA * DT;    // mouse turning, streamed like the client does
      step(p, 1);
      peak = Math.max(peak, hspeed(p));
      if (Math.abs(p.x) > 34 || Math.abs(p.z) > 34) { p.x = -30; p.z = 8; } // treadmill reset
    }
    return { peak, end: hspeed(p), seconds: N / 60 };
  }

  const spin = strafeRun(1, 0);          // hold D, turn one direction continuously
  check('air strafe (spin): exceeds the old hard cap of 34 u/s (no cap now)', spin.peak > 34, `peak=${spin.peak.toFixed(1)} u/s`);
  check('air strafe (spin): sustained speed build-up over 12 s', spin.end > api.MAXWALK + 8, `end=${spin.end.toFixed(1)} vs base ${api.MAXWALK}`);

  const pump = strafeRun(-1, 40);        // hold A, flip turn direction every ~0.67 s
  check('air strafe (pump): also builds speed', pump.peak > api.MAXWALK + 5 && pump.end > api.MAXWALK + 4,
    `peak=${pump.peak.toFixed(1)}, end=${pump.end.toFixed(1)} u/s`);
}

/* --- 5. rocket jump: angled radial impulse while moving ------------------------ */
{
  const p = makePlayer(0, 24);      // open ground south of the platform
  p.vx = 20;                        // moving forward (+x) at bhop speed
  p.input.yaw = -Math.PI / 2;       // facing +x
  p.input.pitch = -1.56;            // aim straight down
  api.__events.length = 0;
  api.fireWeapon(p, api.WEAPONS[4]);   // rocket (inherits 35 % of player velocity)

  const vBefore = { vx: p.vx, vy: p.vy };
  let exploded = false;
  for (let i = 0; i < 60 * 3 && !exploded; i++) {
    step(p, 1);                    // production tick order: player physics first...
    api.updateProjectiles(DT);     // ...then projectiles (matches server.js step())
    exploded = api.__events.some((e) => e.t === 'explosion');
  }
  const dvx = p.vx - vBefore.vx, dvy = p.vy - vBefore.vy;
  check('rjump: explosion happened', exploded);
  check('rjump: strong forward (horizontal) boost in direction of motion', dvx > 3, `dvx=${dvx.toFixed(1)}`);
  check('rjump: strong vertical lift', dvy > 10, `dvy=${dvy.toFixed(1)}`);
  const angle = Math.atan2(dvy, Math.abs(dvx)) * 180 / Math.PI;
  check('rjump: impulse is angled (not a vertical pencil pop)', angle < 75 && angle > 30, `${angle.toFixed(0)} deg above horizontal`);
}

/* --- 6. side blast: purely radial, no upward bias ------------------------------ */
{
  const p = makePlayer(24, 8);      // standing still on open ground
  api.explode(p.x + 3, p.y + 0.9, p.z, 9, 85, 26, p.id);   // blast beside the torso
  check('side blast: pushes horizontally away from the blast', Math.abs(p.vx) > 10 && p.vx < 0, `dvx=${p.vx.toFixed(1)}`);
  check('side blast: no vertical pencil bias (dy=0 -> dvy~0)', Math.abs(p.vy) < 2.5, `dvy=${p.vy.toFixed(2)}`);
}

/* --- 7. grenade jump: lob behind while moving ---------------------------------- */
{
  const p = makePlayer(0, -24);     // open ground north of the platform
  p.vx = 20;                        // moving +x
  p.input.yaw = Math.PI / 2;        // facing -x (aiming behind the motion)
  p.input.pitch = -0.5;             // lob down-behind
  api.__events.length = 0;
  api.fireWeapon(p, api.WEAPONS[3]);   // grenade
  const vBefore = { vx: p.vx, vy: p.vy };
  let exploded = false;
  for (let i = 0; i < 60 * 4 && !exploded; i++) {
    step(p, 1);                    // production tick order: player physics first...
    api.updateProjectiles(DT);     // ...then projectiles (matches server.js step())
    exploded = api.__events.some((e) => e.t === 'explosion');
  }
  const dvx = p.vx - vBefore.vx, dvy = p.vy - vBefore.vy;
  check('nade jump: explosion happened', exploded);
  check('nade jump: forward boost from a blast landing behind the player', dvx > 6, `dvx=${dvx.toFixed(1)}`);
  check('nade jump: vertical lift component present', dvy > 3, `dvy=${dvy.toFixed(1)}`);
}

/* --- 8. sanity net (numerical only, not a gameplay cap) ------------------------ */
{
  const p = makePlayer(24, 8);
  p.vx = api.SANITY_MAX * 1.5;      // pathological input
  step(p, 1);
  check('sanity: extreme speeds clamped to the numerical net', hspeed(p) <= api.SANITY_MAX + 0.01, `v=${hspeed(p).toFixed(1)} (net ${api.SANITY_MAX})`);
}

console.log(failures === 0 ? '\n[verify-movement] ALL PASS' : `\n[verify-movement] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
