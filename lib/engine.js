// norns-web engine abstraction
// Mirrors the norns Lua engine API using SuperSonic (scsynth WASM).
//
// In norns, `engine.name = "PolyPerc"` loads a SuperCollider engine class
// and `engine.hz(440)` sends `/engine/hz 440` to sclang which forwards it
// to scsynth. Since sclang doesn't run in the browser, this layer replaces
// it: you subclass Engine, implement the engine commands as methods, and
// the methods talk directly to scsynth via supersonic.send().
//
// Usage:
//   import { Engine } from '../lib/engine.js';
//
//   class PolyPercEngine extends Engine {
//     async load() {
//       await this.loadSynthDef('poly-perc'); // pre-compiled .scsyndef
//       this.amp = 0.5;
//     }
//     hz(freq) {
//       this.newNote('PolyPerc', { freq, amp: this.amp });
//     }
//     amp(v) { this.amp = v; }
//   }
//
//   const engine = new PolyPercEngine();
//   await engine.load();
//   engine.hz(440);

import supersonic from "./supersonic.js";

export class Engine {
  constructor() {
    this.amp   = 0.5;
    this.pan   = 0.0;
    this._name = "(none)";
    this._voices = new Map(); // note → nodeId, for polyphonic engines
  }

  get name() { return this._name; }

  // --- SynthDef loading ---

  // Load a SynthDef by name (Sonic Pi built-in) or URL/bytes (custom).
  async loadSynthDef(source) {
    return supersonic.loadSynthDef(source);
  }

  // Load a .scsyndef file from a local URL (e.g. bundled in the project).
  async loadSynthDefUrl(url) {
    const resp  = await fetch(url);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return supersonic.loadSynthDef(bytes);
  }

  // --- Node management ---

  // Spawn a new one-shot synth node (fire-and-forget, envelope handles its own release).
  // Returns the node ID.
  newNote(synthName, params = {}) {
    return supersonic.newNode(synthName, {
      amp: this.amp,
      pan: this.pan,
      ...params,
    });
  }

  // Spawn a sustained synth node (caller must call freeNote or releaseNote).
  noteOn(synthName, note, params = {}) {
    const id = supersonic.newNode(synthName, {
      note,
      amp:  this.amp,
      pan:  this.pan,
      gate: 1,
      ...params,
    });
    this._voices.set(note, id);
    return id;
  }

  // Trigger release on a sustained note (sets gate=0).
  noteOff(note) {
    const id = this._voices.get(note);
    if (id != null) {
      supersonic.setNode(id, { gate: 0 });
      this._voices.delete(note);
    }
  }

  // Immediately free a sustained note.
  freeNote(note) {
    const id = this._voices.get(note);
    if (id != null) {
      supersonic.freeNode(id);
      this._voices.delete(note);
    }
  }

  // Update params on a running voice.
  setVoice(note, params) {
    const id = this._voices.get(note);
    if (id != null) supersonic.setNode(id, params);
  }

  // Free all running voices.
  freeAll() {
    supersonic.freeAll();
    this._voices.clear();
  }

  // --- OSC passthrough ---

  // Send a raw OSC message to scsynth.
  send(address, ...args) {
    supersonic.send(address, ...args);
  }

  // Override in subclass. Called by the script loader.
  async load() {}

  // Override in subclass. Called on script cleanup.
  cleanup() {
    this.freeAll();
  }
}

// ---------------------------------------------------------------------------
// Built-in Sonic Pi engines
// These use the 128 SynthDefs that ship with supersonic-scsynth-synthdefs.
// Each can be instantiated directly without writing a subclass.
// ---------------------------------------------------------------------------

// All Sonic Pi synths accept: note, amp, pan, attack, decay, sustain, release
// Plus synth-specific params listed below.
const SONIC_PI_SYNTHS = [
  { name: "sonic-pi-prophet",   label: "prophet",  extra: { cutoff: 100, res: 0.3 } },
  { name: "sonic-pi-tb303",     label: "tb303",    extra: { cutoff: 80, res: 0.2, wave: 0 } },
  { name: "sonic-pi-saw",       label: "saw",      extra: {} },
  { name: "sonic-pi-pulse",     label: "pulse",    extra: { pulse_width: 0.5 } },
  { name: "sonic-pi-square",    label: "square",   extra: {} },
  { name: "sonic-pi-tri",       label: "tri",      extra: {} },
  { name: "sonic-pi-fm",        label: "fm",       extra: { divisor: 2, depth: 1 } },
  { name: "sonic-pi-piano",     label: "piano",    extra: {} },
  { name: "sonic-pi-pluck",     label: "pluck",    extra: { decay: 1 } },
  { name: "sonic-pi-chiplead",  label: "chiplead", extra: {} },
  { name: "sonic-pi-chipbass",  label: "chipbass", extra: {} },
  { name: "sonic-pi-hollow",    label: "hollow",   extra: { cutoff: 90 } },
  { name: "sonic-pi-growl",     label: "growl",    extra: { cutoff: 100, res: 0 } },
  { name: "sonic-pi-beep",      label: "beep",     extra: {} },
  { name: "sonic-pi-mod_fm",    label: "mod_fm",   extra: {} },
];

// Generic Sonic Pi synth engine — picks a synth by name, plays notes.
export class SonicPiEngine extends Engine {
  constructor(synthName) {
    super();
    this._synthName = synthName;
    this._name      = synthName;
    this._release   = 0.4;
    this._attack    = 0.01;
    this._extra     = {};
  }

  async load() {
    await supersonic.loadSynthDef(this._synthName);
  }

  // Play a one-shot note. vel is 0–1.
  noteOn(note, vel = 0.7) {
    return supersonic.newNode(this._synthName, {
      note,
      amp:     Math.max(0, Math.min(1, vel)) * this.amp,
      pan:     this.pan,
      attack:  this._attack,
      release: this._release,
      ...this._extra,
    });
  }

  // Sonic Pi synths are self-releasing — noteOff is a no-op for fire-and-forget
  noteOff() {}
}

export { SONIC_PI_SYNTHS };
export default Engine;
