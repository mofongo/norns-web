// norns-web oilcan nb player
// Port of zjb-s/oilcan as a browser-native nb voice using Web Audio.
//
// Usage:
//   import { initOilcan } from '../lib/oilcan.js';
//   await initOilcan(audioCtx);         // registers 'Oilcan 1'–'Oilcan 4' in nb
//
// Each Oilcan player is a 7-timbre percussion voice.
// note_on maps incoming MIDI note → timbre: timbre = (note - 1) % 7
// Velocity scales the gain parameter.
// modulate(v) offsets mod_ix on the next trigger (performance macro).

import { Player } from "./player.js";
import nb from "./nb.js";

// ---------------------------------------------------------------------------
// Default kit presets — ported from zjb-s/oilcan lib/default-*.oilkit
// 7 timbres per kit, 14 params each:
//   freq, sweep_time, sweep_ix, atk, car_rel, mod_rel,
//   mod_ix, mod_ratio, fb, fold, headroom, gain, routing, level
// ---------------------------------------------------------------------------
const KITS = {
  "default-1": [
    //  freq      swpT    swpI   atk    carRel  modRel  modIx   modR    fb      fold    room    gain    rout    lvl
    [  48.267,  1.126,  0.040, 0.000, 0.2363, 20.812, 0.0363,  1.000, 10.000,  0.000, 1.000, 2.251, 0.100, 0.896 ],
    [ 216.730, 14.179,  0.500, 0.000, 0.0760, 77.888, 0.4211,  0.001, 10.000,  0.023, 1.000, 1.000, 0.510, 1.000 ],
    [6465.920,  0.100,  0.000, 0.001, 0.1122,110.899, 0.3955, 30.102,  4.300, 16.827, 0.575, 0.286, 0.190, 1.000 ],
    [6181.970,  0.100,  0.000, 0.028, 0.1396,113.212, 0.3343, 30.102,  4.300, 16.827, 0.498, 0.286, 0.190, 1.000 ],
    [ 243.474, 43.528,  0.010, 0.000, 0.0835, 31.563, 0.2276,  4.703,  3.343,  0.000, 0.413, 1.000, 0.315, 1.000 ],
    [ 778.565,  0.100,  0.040, 0.000, 0.0666,170.678, 0.7512,  3.572,  0.000,  1.210, 1.000, 1.000, 0.100, 0.531 ],
    [ 127.100,100.000,  0.010, 0.000, 0.0760,185.196, 0.1061,  3.919, 10.000,  0.000, 1.000, 1.000, 0.100, 1.000 ],
  ],
  "default-2": [
    [  56.451, 10.021,  0.030, 0.000, 0.2598, 56.488, 0.0028,  1.000, 10.000,  0.000, 1.000, 1.099, 0.100, 1.353 ],
    [ 184.281,100.000,  0.020, 0.000, 0.0601,106.408, 0.7064,  1.509, 10.000,  0.000, 1.000, 1.497, 0.705, 0.544 ],
    [9898.693,  0.100,  0.000, 0.001, 0.0666,200.000, 1.0000,  6.677,  6.780,  1.007, 1.000, 0.286, 0.095, 1.000 ],
    [10000.00,  0.100,  0.000, 0.001, 0.2787,200.000, 1.0000,  9.420,  6.780,  0.970, 1.000, 0.250, 0.000, 0.654 ],
    [ 110.586,  1.066,  0.220, 0.000, 0.1359,200.000, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
    [ 263.033,  1.066,  0.220, 0.000, 0.1359,200.000, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
    [1377.802,  1.066,  0.220, 0.000, 0.0159,188.142, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
  ],
  "default-3": [
    [  56.451, 10.021,  0.030, 0.000, 0.2598, 56.488, 0.0028,  1.000, 10.000,  0.000, 1.000, 1.099, 0.100, 1.353 ],
    [ 184.281,100.000,  0.020, 0.000, 0.0601,106.408, 0.7064,  1.509, 10.000,  0.000, 1.000, 1.497, 0.705, 0.544 ],
    [9898.693,  0.100,  0.000, 0.001, 0.0666,200.000, 1.0000,  6.677,  6.780,  1.007, 1.000, 0.286, 0.095, 1.000 ],
    [10000.00,  0.100,  0.000, 0.001, 0.2787,200.000, 1.0000,  9.420,  6.780,  0.970, 1.000, 0.250, 0.000, 0.654 ],
    [ 110.586,  1.066,  0.220, 0.000, 0.1359,200.000, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
    [ 263.033,  1.066,  0.220, 0.000, 0.1359,200.000, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
    [1377.802,  1.066,  0.220, 0.000, 0.0159,188.142, 0.0109,  0.001, 10.000,  0.000, 1.000, 0.658, 0.000, 0.978 ],
  ],
};

const PARAM_KEYS = [
  "freq","sweep_time","sweep_ix","atk","car_rel","mod_rel",
  "mod_ix","mod_ratio","fb","fold","headroom","gain","routing","level",
];

function rowToParams(row) {
  const p = {};
  PARAM_KEYS.forEach((k, i) => { p[k] = row[i]; });
  return p;
}

// Parse a kit name into an array of 7 param objects
function loadKit(kitName) {
  const rows = KITS[kitName] || KITS["default-1"];
  return rows.map(rowToParams);
}

// ---------------------------------------------------------------------------
// Shared AudioWorkletNode (one per AudioContext, managed internally)
// ---------------------------------------------------------------------------
let _node = null;
let _audioCtx = null;

function getNode() { return _node; }

// ---------------------------------------------------------------------------
// OilcanPlayer — nb Player for one voice slot
// ---------------------------------------------------------------------------
class OilcanPlayer extends Player {
  constructor(slotIdx, kitName = "default-1") {
    super();
    this.slotIdx = slotIdx;        // 0–3, maps to processor voice slot
    this.timbres = loadKit(kitName);
    this.currentKit = kitName;
    this._modOffset = 0;           // from modulate()
  }

  // Switch to a different built-in kit ('default-1', 'default-2', 'default-3')
  loadKit(kitName) {
    if (!KITS[kitName]) return;
    this.timbres = loadKit(kitName);
    this.currentKit = kitName;
  }

  note_on(note, vel) {
    const node = getNode();
    if (!node) return;

    // Map MIDI note → timbre index 0–6 (matching original Lua: (note-1)%7)
    const timbreIdx = ((note - 1) % 7 + 7) % 7;
    const base = this.timbres[timbreIdx];

    // Copy params; apply velocity to gain, modulate() offset to mod_ix
    const params = { ...base };
    params.gain = Math.max(0, params.gain * vel);
    params.mod_ix = Math.max(0, Math.min(1, params.mod_ix + this._modOffset));

    node.port.postMessage({ cmd: "trig", idx: this.slotIdx, params });
  }

  // Percussive synth — no sustained note to release
  note_off(_note) {}

  // Offset mod_ix for all subsequent triggers (performance macro, 0–1)
  modulate(v) {
    this._modOffset = v - 0.5; // center at 0: negative reduces, positive increases
  }

  stop_all() {
    // Nothing to do — oilcan voices are self-releasing
  }

  describe() {
    return {
      name: `Oilcan ${this.slotIdx + 1}`,
      supports_bend: false,
      supports_slew: false,
      modulate_description: "mod index offset",
      style: "kit",
      note_mod_targets: [],
    };
  }
}

// ---------------------------------------------------------------------------
// initOilcan — load worklet + register nb players
// ---------------------------------------------------------------------------
// Call from your script's init(canvas, audioCtx):
//   import { initOilcan } from '../lib/oilcan.js';
//   await initOilcan(audioCtx);
//
// This registers 'Oilcan 1'–'Oilcan 4' in nb.players.
// Re-calling with the same AudioContext is a no-op.

export async function initOilcan(audioCtx, numPlayers = 4) {
  if (!audioCtx) throw new Error("initOilcan: audioCtx required");

  // Only initialize once per AudioContext
  if (_audioCtx === audioCtx && _node) {
    return;
  }

  _audioCtx = audioCtx;

  // Load the processor module
  const processorUrl = new URL("./oilcan-processor.js", import.meta.url).href;
  await audioCtx.audioWorklet.addModule(processorUrl);

  // Create the shared node (2-channel output, 0 inputs)
  _node = new AudioWorkletNode(audioCtx, "oilcan-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  _node.connect(audioCtx.destination);

  // Remove any previously registered oilcan players
  for (let i = 1; i <= 4; i++) {
    delete nb.players[`Oilcan ${i}`];
  }

  // Register N players
  const kits = Object.keys(KITS);
  for (let i = 0; i < numPlayers; i++) {
    const kitName = kits[i % kits.length];
    const player = new OilcanPlayer(i, kitName);
    nb.register(`Oilcan ${i + 1}`, player);
  }
}

export { OilcanPlayer, KITS, PARAM_KEYS };
export default initOilcan;
