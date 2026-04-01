// engine-bridge.js
// Maps the norns engine API to supersonic (scsynth running as WebAssembly).
//
// Norns engine API:
//   engine.name = "PolySub"    — declare engine (fires async init)
//   engine.start(voice, freq)  — start a persistent voice (poly engines)
//   engine.stop(voice)         — release a persistent voice
//   engine.hz(freq)            — trigger a self-releasing note (PolyPerc etc.)
//   engine.someParam(value)    — set a synthesis parameter
//
// Engine approximations use Sonic Pi SynthDefs (128 built-ins, loaded from CDN).
// For full-fidelity playback, compile the engine's .sc file to a .scsyndef binary
// and place it at:  engines/{EngineName}.scsyndef
// It will be loaded instead of the approximation.

import supersonic from "./supersonic.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function hzToMidi(hz) {
  return Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(Math.max(hz, 1) / 440))));
}

// ── engine configs ────────────────────────────────────────────────────────────
//
// voiceModel:
//   "persistent" — voices are started/stopped explicitly (engine.start/stop)
//   "trigger"    — each note auto-releases (engine.hz)
//
// base — default synth params used when spawning each node
// map  — { engineCommandName: (value) => { synthParam: mappedValue } }
//         Return null to silently ignore a command.

const ENGINE_CONFIGS = {
  PolySub: {
    synthName: "sonic-pi-prophet",
    voiceModel: "persistent",
    base: { amp: 0.7, attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.3, cutoff: 80, res: 0.3 },
    map: {
      cut:        v => ({ cutoff: Math.round(Math.max(0, Math.min(1, v)) * 130) }),
      fgain:      v => ({ res: Math.max(0, Math.min(1, v)) }),
      ampAtk:     v => ({ attack: v }),
      ampDec:     v => ({ decay: v }),
      ampSus:     v => ({ sustain: v }),
      ampRel:     v => ({ release: v }),
      cutAtk:     v => ({ cutoff_attack: v }),
      cutDec:     v => ({ cutoff_decay: v }),
      cutSus:     v => ({ cutoff_sustain: v }),
      cutRel:     v => ({ cutoff_release: v }),
      cutEnvAmt:  v => ({ cutoff_attack: Math.abs(v) }),
      timbre:     v => ({ lfo_rate: v * 8 }),
      shape:      v => ({ pulse_width: Math.max(0.05, Math.min(0.95, v)) }),
      hzLag:      _v => null,  // no direct mapping
      noise:      _v => null,
      detune:     _v => null,
    },
  },

  PolyPerc: {
    synthName: "sonic-pi-beep",
    voiceModel: "trigger",
    base: { amp: 0.7, attack: 0.001, release: 1.0, cutoff: 100 },
    map: {
      attack:  v => ({ attack: v }),
      release: v => ({ release: v }),
      gain:    v => ({ amp: v }),
      // PolyPerc cutoff is in Hz; beep's cutoff is a MIDI note (0-130)
      cutoff:  v => ({ cutoff: v > 20 ? hzToMidi(v) : Math.round(v * 130) }),
      pan:     v => ({ pan: v }),
    },
  },

  MollyThePoly: {
    synthName: "sonic-pi-prophet",
    voiceModel: "persistent",
    base: { amp: 0.5, attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.5, cutoff: 90, res: 0.2 },
    map: {
      // MollyThePoly shares a similar parameter set to PolySub
      cut:        v => ({ cutoff: Math.round(Math.max(0, Math.min(1, v)) * 130) }),
      res:        v => ({ res: Math.max(0, Math.min(1, v)) }),
      attack:     v => ({ attack: v }),
      decay:      v => ({ decay: v }),
      sustain:    v => ({ sustain: v }),
      release:    v => ({ release: v }),
      amp_atk:    v => ({ attack: v }),
      amp_rel:    v => ({ release: v }),
      pw:         v => ({ pulse_width: Math.max(0.05, Math.min(0.95, v)) }),
    },
  },
};

// ── state ─────────────────────────────────────────────────────────────────────

let _name    = null;
let _config  = null;
let _ready   = false;
let _promise = null;
let _queue   = [];              // buffered commands before engine is ready
const _voices = new Map();     // voice number → scsynth node ID
let _gParams  = {};            // current global param accumulator

// ── init ──────────────────────────────────────────────────────────────────────

async function _initEngine(name) {
  const config = ENGINE_CONFIGS[name] ?? null;

  // Boot scsynth (idempotent if already running)
  await supersonic.init();

  // Try a pre-compiled custom .scsyndef first
  let usedCustom = false;
  try {
    const resp = await fetch(`./engines/${name}.scsyndef`);
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      await supersonic.loadSynthDef(new Uint8Array(buf));
      console.log(`[engine] loaded custom SynthDef: ${name}`);
      usedCustom = true;
    }
  } catch { /* no custom file — fall through */ }

  if (!usedCustom) {
    if (config?.synthName) {
      await supersonic.loadSynthDef(config.synthName);
      console.log(`[engine] ${name} → approximated by ${config.synthName}`);
    } else {
      console.warn(`[engine] no SynthDef for engine "${name}" — audio will be silent`);
    }
  }

  _config = config;
  _ready  = true;

  // Replay any commands buffered during init
  const pending = _queue.splice(0);
  for (const [cmd, args] of pending) _dispatch(cmd, args);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

function _dispatch(cmd, args) {
  if (!_config) return;

  const { synthName, voiceModel, base, map } = _config;

  // ── voice commands ──
  if (cmd === "start" && voiceModel === "persistent") {
    const [voice, freq] = args;
    if (_voices.has(voice)) supersonic.freeNode(_voices.get(voice));
    const nodeId = supersonic.newNode(synthName, { ...base, ..._gParams, note: hzToMidi(freq) });
    _voices.set(voice, nodeId);
    return;
  }

  if (cmd === "stop") {
    const [voice] = args;
    const id = _voices.get(voice);
    if (id != null) { supersonic.freeNode(id); _voices.delete(voice); }
    return;
  }

  if (cmd === "hz") {
    // Self-releasing trigger: sustain drives the note length
    const [freq] = args;
    const rel = _gParams.release ?? base.release ?? 1.0;
    supersonic.newNode(synthName, { ...base, ..._gParams, note: hzToMidi(freq), sustain: rel });
    return;
  }

  // ── parameter commands ──
  if (map && Object.prototype.hasOwnProperty.call(map, cmd)) {
    const [value] = args;
    const result = map[cmd](value);
    if (!result) return;  // null = explicitly ignored
    _gParams = { ..._gParams, ...result };
    // Push param update to all active voices
    for (const id of _voices.values()) supersonic.setNode(id, result);
    return;
  }

  // Unknown command — silently ignore (degrade gracefully)
}

// ── public API ────────────────────────────────────────────────────────────────

const engineBridge = {
  get engineName() { return _name; },
  get ready()      { return _ready; },

  // Called when Lua does: engine.name = "X"
  setEngine(name) {
    // No-op if already initialised for this engine
    if (_name === name && _ready) return Promise.resolve();

    // Reset for the new engine
    _name    = name;
    _config  = null;
    _ready   = false;
    _promise = null;
    _queue   = [];
    for (const id of _voices.values()) {
      try { supersonic.freeNode(id); } catch { /* supersonic might not be ready yet */ }
    }
    _voices.clear();
    _gParams = {};

    _promise = _initEngine(name).catch(err => {
      console.error(`[engine] failed to init "${name}":`, err);
    });
    return _promise;
  },

  // Called for any engine.X(...) call from Lua
  command(name, args) {
    if (!_name) return;
    if (_ready) {
      _dispatch(name, args);
    } else {
      _queue.push([name, args]);
    }
  },

  // Called when the script is stopped
  cleanup() {
    if (_ready) {
      try { supersonic.freeAll(); } catch { /* ignore */ }
    }
    _voices.clear();
    _gParams  = {};
    _name     = null;
    _config   = null;
    _ready    = false;
    _promise  = null;
    _queue    = [];
  },
};

export default engineBridge;
