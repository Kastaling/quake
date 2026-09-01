'use strict';
/**
 * Verification for the below-floor spawn fix:
 *   1. Spawn placement starts above ground level (y = localGround + SPAWN_ABOVE)
 *      and an immediate ground check resolves state; physics then settles the
 *      drop onto the floor without ever dipping below it.
 *   2. The state loop's out-of-bounds safety net relocates any entity found
 *      below y < -10 (players keep hp/ammo; zombies are re-placed on the floor).
 * Runs server.js in a vm sandbox with stubbed express/socket.io/http so no port
 * is opened and internals can be inspected. Exits 0 on PASS, 1 on FAIL.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/* --- stub modules ----------------------------------------------------------- */
const emitted = [];
const ioStub = {
  on: () => {}, emit: (ev, data) => emitted.push([ev, data]),
  engine: { clientsCount: 0 },
};
class SocketIOServerStub { constructor() { return ioStub; } }
const expressApp = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === 'use' || k === 'set' || k === 'disable' || k === 'get') return () => {};
    return t[k];
  },
  apply: () => expressApp,
});

// calling the module returns the app proxy; .static & friends are no-ops
const expressModule = Object.assign(() => expressApp, { static: () => ({}) });

const sandbox = {
  console,
  setTimeout: () => 0,          // do not start the real frame loop
  clearTimeout: () => {},
  performance,
  __dirname: path.join(__dirname, '..'),
  __filename: path.join(__dirname, '..', 'server.js'),
  process: { env: { PORT: '3997', HOST: '127.0.0.1' }, uptime: () => 0 },
  require: (m) => {
    if (m === 'path') return path;
    if (m === 'http') return { createServer: () => ({ listen: () => {} }) };
    if (m === 'express') return expressModule;
    if (m === 'socket.io') return { Server: SocketIOServerStub };
    throw new Error('unexpected require in sandbox: ' + m);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// expose internals for the test (appended only inside the sandbox copy)
vm.runInContext(src + `
;globalThis.__t = { players, zombies, step, groundHeightAt,
  createPlayer, pickSpawnPoint, checkGround, SPAWNS, OOB_Y, SPAWN_ABOVE, DT };
`, sandbox, { filename: 'server.js' });

const T = sandbox.__t;
const fakeSocket = { emit: () => {} };

/* --- 1. spawn placement ------------------------------------------------------ */
console.log('[spawn] fresh player placement');
const p = T.createPlayer(fakeSocket, 'TESTER');
const ghSpawn = T.groundHeightAt(p.x, p.z);
check('spawn x/z is a perimeter SPAWNS point',
  T.SPAWNS.some((s) => Math.abs(s.x - p.x) < 1e-9 && Math.abs(s.z - p.z) < 1e-9));
check(`spawn starts above ground level (y = gh + ${T.SPAWN_ABOVE})`,
  Math.abs(p.y - (ghSpawn + T.SPAWN_ABOVE)) < 1e-9);
check('spawn velocity zeroed', p.vx === 0 && p.vy === 0 && p.vz === 0);
check('immediate ground check marks entity airborne while above floor', p.onGround === false);

T.players.set(p.id, p); // register so step() simulates the drop

// run physics: the drop must settle onto the local floor, never dipping below it
let minY = Infinity; let landed = false;
for (let i = 0; i < 120 && !landed; i++) {
  T.step(T.DT);
  minY = Math.min(minY, p.y);
  if (p.onGround) landed = true;
}
const ghLand = T.groundHeightAt(p.x, p.z);
check('spawn drop settles onto the floor within ~2 s', landed && Math.abs(p.y - ghLand) < 1e-6);
check(`feet never dipped below local ground during the drop (minY=${minY.toFixed(3)} >= ${ghLand})`,
  minY >= ghLand - 1e-9);

/* --- immediate ground check on a raised solid -------------------------------- */
console.log('[spawn] immediate ground check resolves state');
const raised = { x: 12, z: 0, y: T.groundHeightAt(12, 0) + T.SPAWN_ABOVE, vy: 0 }; // east cover block (top 1.6)
T.checkGround(raised);
check('entity above a raised solid stays lifted (no clipping into the top)',
  Math.abs(raised.y - (1.6 + T.SPAWN_ABOVE)) < 1e-9 && raised.onGround === false);
const sunk = { x: 12, z: 0, y: 1.0, vy: -5 }; // corrupted state below the solid top
T.checkGround(sunk);
check('entity found at/below floor level is snapped onto its surface',
  Math.abs(sunk.y - 1.6) < 1e-9 && sunk.vy === 0 && sunk.onGround === true);

/* --- 2. out-of-bounds safety net --------------------------------------------- */
console.log('[oob] state loop relocates entities below y = -10');
T.players.set(p.id, p); // register the live player so step() simulates it
const hpBefore = p.hp; const ammoBefore = { ...p.ammo };

// corrupt the player: far below the arena, moving upward so physics won't self-heal first
p.x = 5; p.z = 5; p.y = -15; p.vy = 3; p.onGround = false;
T.step(T.DT);
const ghP = T.groundHeightAt(p.x, p.z);
check('player below OOB_Y is relocated to a spawn point',
  T.SPAWNS.some((s) => Math.abs(s.x - p.x) < 1e-9 && Math.abs(s.z - p.z) < 1e-9));
check(`relocated player starts above ground (y=${p.y.toFixed(2)} = gh + ${T.SPAWN_ABOVE})`,
  Math.abs(p.y - (ghP + T.SPAWN_ABOVE)) < 1e-9);
check('player velocity zeroed after relocation', p.vx === 0 && p.vy === 0 && p.vz === 0);
check('relocation is glitch recovery, not death (hp/ammo preserved)',
  p.hp === hpBefore && JSON.stringify(p.ammo) === JSON.stringify(ammoBefore) && p.dead === false);

// corrupt a zombie the same way
const z = { id: 999, type: 'walker', x: -5, y: -15, z: -5, vy: 3, hp: 40, speed: 3.4,
  dmg: 9, rate: 0.9, r: 0.62, atkCd: 1, wx: 0, wz: 0, wanderT: 0 };
T.zombies.set(z.id, z);
T.step(T.DT);
const ghZ = T.groundHeightAt(z.x, z.z);
check('zombie below OOB_Y is relocated to the perimeter band',
  Math.hypot(z.x, z.z) >= (40 - 7) && Math.hypot(z.x, z.z) <= (40 - 3));
check(`relocated zombie sits on the floor (y=${z.y.toFixed(2)} = gh>=0)`,
  Math.abs(z.y - ghZ) < 1e-9 && z.y >= 0);

// healthy entities are left alone by the safety net
const q = T.createPlayer(fakeSocket, 'CALM');
T.players.set(q.id, q);
q.x = 20; q.z = 20; q.y = T.groundHeightAt(20, 20) + 5; // airborne but well above -10
const qx = q.x, qz = q.z;
T.step(T.DT);
check('entity above OOB_Y is not touched by the safety net', Math.abs(q.x - qx) < 0.5 && Math.abs(q.z - qz) < 0.5);

console.log(failures === 0 ? '\n[verify-spawn-fix] ALL CHECKS PASSED' : `\n[verify-spawn-fix] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
