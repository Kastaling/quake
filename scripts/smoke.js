'use strict';
/**
 * Headless integration smoke test: boots the real server on a scratch port,
 * connects two socket.io clients, joins them, streams inputs (movement + every
 * weapon), and verifies that snapshots, events, zombie spawning and button
 * state all flow. Exits 0 on PASS, 1 on FAIL.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io: ioc } = require('socket.io-client');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${pathname}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function makeClient(name) {
  return new Promise((resolve) => {
    const socket = ioc(BASE, { transports: ['websocket'], forceNew: true });
    const client = { socket, name, init: null, states: 0, events: [], lastState: null };
    socket.on('connect', () => socket.emit('join', { name }));
    socket.on('init', (d) => (client.init = d));
    socket.on('state', (s) => { client.states++; client.lastState = s; });
    socket.on('event', (e) => client.events.push(e));
    setTimeout(() => resolve(client), 400); // give the join round-trip time
  });
}

function sendInput(c, over) {
  c.socket.emit('input', Object.assign(
    { f: 1, s: 0.5, jump: false, fire: true, yaw: 0, pitch: 0, w: 0 }, over));
}

async function main() {
  console.log(`[smoke] starting server on port ${PORT} ...`);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => (srvLog += d));

  try {
    // wait for the HTTP endpoint
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { const r = await get('/healthz'); up = r.status === 200; } catch (e) { /* not yet */ }
    }
    check('server boots and /healthz responds', up);

    // static assets reachable
    const idx = await get('/');
    check('index.html served', idx.status === 200 && idx.body.includes('QUAKE ARENA'));
    const three = await get('/vendor/three/build/three.module.js');
    check('three.js module served from node_modules', three.status === 200);
    const siojs = await get('/socket.io/socket.io.js');
    check('socket.io client script served', siojs.status === 200);

    // two clients join the world
    const a = await makeClient('ALPHA');
    const b = await makeClient('BRAVO');
    check('client A received init (map + weapons)', !!a.init && a.init.weapons.length === 7);
    check('init map has solids/buttons/pickups',
      !!a.init && a.init.map.solids.length > 5 && a.init.map.buttons.length === 2 && a.init.map.pickups.length >= 8);

    // stream inputs: A holds position at its exact spawn point and fires every
    // weapon (deterministic for the button-aiming test below); B runs, strafes
    // and bunny-hops to exercise movement physics.
    const SPAWN_A = { x: 32 * Math.cos(Math.PI / 8), z: 32 * Math.sin(Math.PI / 8) }; // SPAWNS[0]
    for (let i = 0; i < 40; i++) {
      // A toggles fire on/off so semi-auto weapons get a press edge each selection
      sendInput(a, { f: 0, s: 0, jump: false, fire: i % 2 === 0, w: i % 7 });
      sendInput(b, { f: -1, s: 1, jump: i % 3 === 0, fire: true, w: i % 7 });
      await new Promise((r) => setTimeout(r, 50));
    }

    check('client A receives state snapshots', a.states > 20);
    check('snapshot contains both players',
      !!a.lastState && a.lastState.p.length === 2);
    const selfA = a.lastState && a.lastState.p.find((p) => p[0] === a.init.you);
    const selfB = a.lastState && a.lastState.p.find((p) => p[0] === b.init.you);
    check('player entry layout (17 fields incl. ammo + name)',
      !!selfA && selfA.length === 17 && typeof selfA[16] === 'string');

    // A is authoritative-placed at its spawn point; B actually moved
    const aPlaced = Math.hypot(selfA[1] - SPAWN_A.x, selfA[3] - SPAWN_A.z) < 0.5;
    check('authoritative spawn placement', aPlaced);
    const bMoved = Math.hypot(selfB[1] + 29.6, selfB[3] + 12.3) > 5; // B spawned opposite the ring
    check('authoritative movement applied (run/strafe/bhop)', bMoved);

    // firing consumed ammo somewhere in the loadout. Note: A cycles all 7 weapons
    // every ~50 ms with fire toggling, and the server uses ONE shared fire cooldown
    // across weapons — so this window yields only a handful of shots (a rocket's
    // 1.2 s cd alone blocks most selections). The assertion verifies that ammo is
    // decremented server-authoritatively at all, not a specific volume.
    const totalAmmo = selfA ? selfA.slice(10, 16).reduce((x, y) => x + y, 0) : 999;
    check('firing consumed ammo (server-authoritative)', totalAmmo < 344);

    // events flowed: shots at minimum
    const shotEvents = a.events.filter((e) => e.t === 'shot').length;
    check('shot events broadcast', shotEvents > 10);

    // zombies spawn over time (inverse-scaled horde engine) and appear in snapshots
    await new Promise((r) => setTimeout(r, 4500));
    const zSeen = a.lastState ? a.lastState.z.length : 0;
    check('zombies spawned into the world', zSeen > 0);
    check('zombie spawn events emitted', a.events.some((e) => e.t === 'zspawn'));

    // button state present in snapshots (nuke ready = 1, inhibit idle = 0)
    check('button state in snapshot', !!a.lastState.b && typeof a.lastState.b.n === 'number');

    /* --- interactive buttons: rocket-shot both domes from the perimeter ------ */
    // A stands at SPAWN_A (eye height 1.6). Rockets fly straight; aim slightly
    // above each dome center to clear the platform wall and land inside the
    // button's trigger sphere (r + 0.35).
    const aimAt = (tx, ty, tz) => {
      const dx = tx - SPAWN_A.x, dy = ty - 1.6, dz = tz - SPAWN_A.z;
      return { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / Math.hypot(dx, dy, dz)) };
    };
    const fireRocketAt = async (tx, ty, tz) => {
      const aim = aimAt(tx, ty, tz);
      sendInput(a, { f: 0, s: 0, jump: false, fire: true, w: 4, yaw: aim.yaw, pitch: aim.pitch });
      await new Promise((r) => setTimeout(r, 150));
      sendInput(a, { f: 0, s: 0, jump: false, fire: false, w: 4, yaw: aim.yaw, pitch: aim.pitch });
    };

    const zBeforeNuke = a.lastState.z.length;
    check('zombies present before nuke test', zBeforeNuke > 0);

    // INHIBIT dome at (2.5, PLAT_TOP+0.35, 0) -> disables spawns for 30 s
    await fireRocketAt(2.5, 2.95, 0);
    await new Promise((r) => setTimeout(r, 2500)); // rocket flight ~1 s + propagation
    check('inhibit button triggered by projectile',
      a.events.some((e) => e.t === 'button' && e.which === 'inhibit'));
    check('inhibit timer active in snapshot (~30 s)', a.lastState.b.i > 26);

    // NUKE dome at (-2.5, PLAT_TOP+0.35, 0) -> immediate horde wipe + 30 s cooldown
    await fireRocketAt(-2.5, 2.95, 0);
    await new Promise((r) => setTimeout(r, 2500));
    check('nuke button triggered by projectile',
      a.events.some((e) => e.t === 'button' && e.which === 'nuke'));
    check('nuke wiped all active zombies', a.lastState.z.length === 0);
    check('nuke overhead cooldown meter running (b.n < 1)', a.lastState.b.n < 1);

    // disconnect one client -> world keeps running for the other
    b.socket.disconnect();
    await new Promise((r) => setTimeout(r, 1200));
    const still = a.states;
    await new Promise((r) => setTimeout(r, 800));
    check('server keeps simulating after disconnect', a.states > still);

    console.log(failures === 0 ? '\n[smoke] ALL CHECKS PASSED' : `\n[smoke] ${failures} CHECK(S) FAILED`);
  } catch (err) {
    failures++;
    console.error('[smoke] unexpected error:', err && err.stack || err);
    if (srvLog) console.error('--- server log ---\n' + srvLog.slice(-2000));
  } finally {
    srv.kill('SIGTERM');
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
