# QUAKE ARENA // ZOMBIE SIEGE

Real-time, browser-based Quake-style multiplayer zombie arena. Authoritative
Node.js + Socket.io server (60 FPS fixed-step simulation) with a Three.js
client and fully synthesized Web Audio positional sound — no assets required.

Self-hosted behind **NGINX Proxy Manager Plus** on a local server.

## Features

- **Centralized world** — one authoritative 60 FPS state loop that runs
  seamlessly with 0, 1 or N players; 30 Hz compact snapshots + immediate
  event stream over Socket.io (WebSocket-first).
- **Quake movement** — ground friction, acceleration vectors, air strafing,
  bunny hopping (frictionless air), jump mechanics.
- **Full loadout on spawn** — Assault Rifle, Shotgun, Super Shotgun, Grenade
  Launcher, Rocket Launcher, Lightning Gun (continuous hitscan ticks), Railgun
  (penetrates multiple targets in a straight line).
- **Blast Jump Engine** — grenades/rockets apply radial impulse vectors to all
  nearby players and zombies → rocket/grenade jumping.
- **Arena map** — cover blocks, elevated ramps, central platform, +25 HP packs,
  ammo crates (full refill), perimeter walls.
- **Interactive buttons** on the central platform:
  - **NUKE** (red dome) — shooting it wipes all active zombies instantly;
    overhead cooldown meter with a 30 s reset timer before re-triggering.
  - **INHIBIT** (blue dome) — shooting it disables zombie spawns for 30 s.
- **Zombie AI engine** — continuous horde spawner with *inverse player scaling*
  (more players → lower spawn rate), pathfinding to the nearest active player,
  melee contact damage, wall climbing, three types (Walker / Runner / Brute)
  with a slow difficulty ramp.

## Project layout

```
package.json            express + socket.io + three (+ socket.io-client for tests)
server.js               authoritative game server: sim loop, physics, weapons,
                        blast-jump engine, buttons, zombie AI, snapshots/events
public/index.html       retro HUD (health/ammo/weapon strip/cooldown meters),
                        crosshair, killfeed, damage vignette, pointer-lock overlay
public/js/game.js       Three.js renderer, interpolation/extrapolation, input,
                        viewmodel, tracers/explosions/particles, HUD wiring
public/js/sounds.js     Web Audio synth: positional shots, explosions, zaps,
                        button chimes, pickups, hurt/kill feedback, ambient bed
Dockerfile              multi-stage production image (node:22-alpine, non-root)
docker-compose.yml      compose layout binding cleanly to NPM+
scripts/smoke.js        headless 2-client integration test (npm run smoke)
```

## Run locally

```bash
npm install
npm start            # http://localhost:3000
npm run smoke        # optional: boots the server and drives two socket clients
```

Open `http://<host>:3000`, click to enter, and play. Multiple tabs/browsers on
the LAN join the same world.

## Run in Docker behind NGINX Proxy Manager Plus

```bash
docker compose up -d --build
```

The container listens on `0.0.0.0:3000` internally; compose binds it to
`127.0.0.1:3000` by default (proxy-only access). In NPM+:

1. **Proxy Hosts → Add Proxy Host**
   - *Domain Names*: e.g. `quake.yourdomain.lan` (+ optional wildcard)
   - *Forward Hostname / IP*: `localhost`, *Port*: `3000`
     (use the server's LAN IP if NPM+ runs on another machine, or join the
     containers to one Docker network and forward to the container name.)
2. **WebSockets**: enabled — NPM+ passes the HTTP `Upgrade: websocket` header
   through for `/socket.io`; the client requests WebSocket transport first.
3. **Headers**: NPM+ adds `X-Forwarded-For` / `X-Real-IP`; the server runs with
   Express `trust proxy`, so real client IPs are honored (no extra config).
4. No TLS termination changes needed — Socket.io works transparently over
   `wss://` once NPM+ terminates HTTPS.

Health check: `GET /healthz` → `{ ok, players, zombies, uptime }` (also wired
to the Docker `HEALTHCHECK`).

## Controls

| Action | Input |
| --- | --- |
| Move | W A S D |
| Jump / bunny hop | SPACE (hold) |
| Fire | LEFT MOUSE (hold for auto weapons) |
| Switch weapon | 1–7 or mouse wheel |
| Air strafe | turn + strafe while airborne |
| Blast jump | rocket/grenade yourself (35 % self-damage) |
