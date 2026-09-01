/**
 * ============================================================================
 *  sounds.js — Web Audio API synthesizer for the Quake arena client
 * ============================================================================
 *  No audio assets: every effect is synthesized at runtime from oscillators,
 *  filtered noise bursts and envelopes. World-space effects are routed through
 *  HRTF PannerNodes so they pan/attenuate positionally relative to the local
 *  player (listener updated every frame by game.js).
 *
 *  Exposed API:
 *    SFX.init()                 create/resume AudioContext (call on user gesture)
 *    SFX.setListener(x,y,z,fx,fy,fz)   update listener position + forward vector
 *    SFX.startAmbient()         start the looping arena drone/wind bed
 *    SFX.playShot(weaponId,pos,local)  per-weapon fire sounds (positional)
 *    SFX.playExplosion(pos)     blast thump + debris noise (positional)
 *    SFX.playButton(which,pos)  nuke / inhibit trigger chimes (positional)
 *    SFX.playZap(pos)           lightning hit crackle (positional)
 *    SFX.playPickup(kind,pos)   health / ammo pickup blips (positional)
 *    SFX.playHurt()             local damage feedback (non-positional)
 *    SFX.playKill()             local kill confirmation arpeggio
 * ============================================================================
 */

const SFX = (() => {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let ambientNodes = null;

  /* ------------------------------ core setup ------------------------------- */

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.55;
    // gentle compressor so overlapping blasts never clip harshly
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);

    // reusable 2 s white-noise buffer for all noise-based effects
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function setListener(x, y, z, fx, fy, fz) {
    if (!ctx) return;
    const l = ctx.listener;
    try {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } catch (e) {
      // older WebAudio fallback
      try { l.setPosition(x, y, z); l.setOrientation(fx, fy, fz, 0, 1, 0); } catch (e2) { /* noop */ }
    }
  }

  function makePanner(x, y, z) {
    const p = ctx.createPanner();
    try { p.panningModel = 'HRTF'; } catch (e) { /* equalpower fallback is fine */ }
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 1.6;
    p.maxDistance = 90;
    try {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } catch (e) {
      try { p.setPosition(x, y, z); } catch (e2) { /* noop */ }
    }
    return p;
  }

  /** Local (non-positional) destination for the player's own feedback sounds. */
  function localDest() { return master; }

  /* ------------------------------ synth helpers ---------------------------- */

  /** Oscillator tone with exponential pitch sweep + attack/decay envelope. */
  function tone(dest, o) {
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f0), t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.vol ?? 0.3, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  /** Filtered white-noise burst with optional frequency sweep. */
  function noiseBurst(dest, o) {
    const t0 = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    let node = src;
    if (o.type) {
      const f = ctx.createBiquadFilter();
      f.type = o.type;
      f.frequency.setValueAtTime(Math.max(20, o.f0), t0);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
      f.Q.value = o.q || 1;
      src.connect(f);
      node = f;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.vol ?? 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    node.connect(g);
    g.connect(dest);
    src.start(t0, Math.random() * 1.5); // random offset keeps repeats from aliasing
    src.stop(t0 + o.dur + 0.02);
  }

  /* ------------------------------ world sounds ----------------------------- */

  function playShot(weaponId, pos, local) {
    if (!ctx) return;
    const dest = local ? localDest() : makePanner(pos[0], pos[1], pos[2]);
    switch (weaponId) {
      case 'ar':
        tone(dest, { wave: 'square', f0: 950, f1: 180, dur: 0.07, vol: local ? 0.3 : 0.22 });
        noiseBurst(dest, { type: 'highpass', f0: 3000, dur: 0.04, vol: 0.16 });
        break;
      case 'shotgun':
        noiseBurst(dest, { type: 'lowpass', f0: 900, f1: 200, dur: 0.22, vol: local ? 0.5 : 0.4 });
        tone(dest, { wave: 'sine', f0: 130, f1: 45, dur: 0.18, vol: 0.4 });
        break;
      case 'super':
        noiseBurst(dest, { type: 'lowpass', f0: 700, f1: 150, dur: 0.3, vol: local ? 0.6 : 0.5 });
        tone(dest, { wave: 'sine', f0: 100, f1: 38, dur: 0.25, vol: 0.45 });
        break;
      case 'grenade':
        noiseBurst(dest, { type: 'bandpass', f0: 500, f1: 1200, q: 2, dur: 0.18, vol: 0.3 });
        tone(dest, { wave: 'triangle', f0: 300, f1: 90, dur: 0.15, vol: 0.18 });
        break;
      case 'rocket':
        tone(dest, { wave: 'sawtooth', f0: 160, f1: 55, dur: 0.3, vol: local ? 0.32 : 0.24 });
        noiseBurst(dest, { type: 'lowpass', f0: 400, f1: 120, dur: 0.3, vol: 0.25 });
        break;
      case 'lightning':
        // electric crackle: a few staggered high-passed noise ticks + zap tone
        for (let i = 0; i < 3; i++) {
          noiseBurst(dest, { type: 'highpass', f0: 2600, dur: 0.025, vol: 0.14, delay: i * 0.02 + Math.random() * 0.01 });
        }
        tone(dest, { wave: 'square', f0: 1400, f1: 700, dur: 0.05, vol: local ? 0.16 : 0.1 });
        break;
      case 'railgun':
        // charged "pew": resonant descending ping + bright click
        tone(dest, { wave: 'sine', f0: 1900, f1: 850, dur: 0.13, vol: local ? 0.34 : 0.26 });
        noiseBurst(dest, { type: 'bandpass', f0: 2500, q: 6, dur: 0.08, vol: 0.2 });
        break;
      default:
        tone(dest, { wave: 'square', f0: 700, f1: 200, dur: 0.06, vol: 0.2 });
    }
  }

  function playExplosion(pos) {
    if (!ctx) return;
    const dest = makePanner(pos[0], pos[1], pos[2]);
    tone(dest, { wave: 'sine', f0: 75, f1: 32, dur: 0.45, vol: 0.8 });
    noiseBurst(dest, { type: 'lowpass', f0: 500, f1: 80, dur: 0.5, vol: 0.7 });
  }

  function playButton(which, pos) {
    if (!ctx) return;
    const dest = makePanner(pos[0], pos[1], pos[2]);
    noiseBurst(dest, { type: 'highpass', f0: 2000, dur: 0.03, vol: 0.2 }); // mechanical click
    if (which === 'nuke') {
      const notes = [220, 330, 440, 660];
      notes.forEach((f, i) => tone(dest, { wave: 'square', f0: f, dur: 0.09, vol: 0.22, delay: i * 0.08 }));
      tone(dest, { wave: 'sawtooth', f0: 120, f1: 40, dur: 0.5, vol: 0.35, delay: 0.3 }); // big zap
    } else {
      tone(dest, { wave: 'sine', f0: 520, f1: 260, dur: 0.3, vol: 0.3 });
      tone(dest, { wave: 'triangle', f0: 780, f1: 390, dur: 0.2, vol: 0.15, delay: 0.12 });
    }
  }

  function playZap(pos) {
    if (!ctx) return;
    const dest = makePanner(pos[0], pos[1], pos[2]);
    noiseBurst(dest, { type: 'highpass', f0: 2500, dur: 0.05, vol: 0.25 });
    tone(dest, { wave: 'square', f0: 900, f1: 300, dur: 0.06, vol: 0.15 });
  }

  function playPickup(kind, pos) {
    if (!ctx) return;
    const dest = makePanner(pos[0], pos[1], pos[2]);
    if (kind === 'health') {
      tone(dest, { wave: 'sine', f0: 660, dur: 0.08, vol: 0.25 });
      tone(dest, { wave: 'sine', f0: 990, dur: 0.1, vol: 0.25, delay: 0.07 });
    } else {
      tone(dest, { wave: 'square', f0: 300, f1: 240, dur: 0.06, vol: 0.2 });
      noiseBurst(dest, { type: 'bandpass', f0: 1800, q: 4, dur: 0.05, vol: 0.15, delay: 0.03 });
    }
  }

  /* --------------------------- local (non-positional) ---------------------- */

  function playHurt() {
    if (!ctx) return;
    tone(localDest(), { wave: 'sine', f0: 90, f1: 50, dur: 0.15, vol: 0.5 });
    noiseBurst(localDest(), { type: 'lowpass', f0: 300, dur: 0.12, vol: 0.3 });
  }

  function playKill() {
    if (!ctx) return;
    [440, 660, 880].forEach((f, i) => tone(localDest(), { wave: 'square', f0: f, dur: 0.07, vol: 0.18, delay: i * 0.06 }));
  }

  /* ------------------------------ ambient bed ------------------------------ */

  function startAmbient() {
    if (!ctx || ambientNodes) return;
    const g = ctx.createGain();
    g.gain.value = 0.05; // very quiet retro drone under everything
    g.connect(master);

    // low detuned sawtooth drone through a slowly-swept lowpass
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 52;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 78.3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160; lp.Q.value = 0.7;
    o1.connect(lp); o2.connect(lp); lp.connect(g);

    // slow LFO breathing on the filter cutoff
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 60;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);

    // faint looping wind (band-passed noise)
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 0.4;
    const ng = ctx.createGain(); ng.gain.value = 0.15;
    src.connect(bp); bp.connect(ng); ng.connect(g);

    o1.start(); o2.start(); lfo.start(); src.start();
    ambientNodes = { g, o1, o2, lfo, src };
  }

  return {
    init,
    setListener,
    startAmbient,
    playShot,
    playExplosion,
    playButton,
    playZap,
    playPickup,
    playHurt,
    playKill,
  };
})();

export default SFX;
