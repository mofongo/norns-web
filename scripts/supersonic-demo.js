// supersonic-demo — scsynth (SuperCollider audio server) running in the browser
//
// Uses supersonic-scsynth (scsynth compiled to WebAssembly) to play
// Sonic Pi's built-in SynthDefs without any native SuperCollider install.
//
// Controls:
//   ↑ / ↓       cycle through synth presets
//   A S D F G H J K  → C D E F G A B C  (white keys)
//   W E T Y U        → C# D# F# G# A#  (black keys)
//   [ / ]       octave down / up

import screen from "../lib/screen.js";
import supersonic from "../lib/supersonic.js";
import { SONIC_PI_SYNTHS } from "../lib/engine.js";

// -- state --
let animId   = null;
let frame    = 0;
let status   = "press any key to load";
let loading  = false;
let loaded   = false;
let octave   = 4;

let synthIdx  = 0;          // currently selected synth
let synthLoaded = new Set(); // names already sent to loadSynthDef
const heldNotes = new Map(); // midi → nodeId

// -- piano key mapping (same as nb-demo) --
const WHITE_KEY_MAP = { KeyA:0, KeyS:2, KeyD:4, KeyF:5, KeyG:7, KeyH:9, KeyJ:11, KeyK:12 };
const BLACK_KEY_MAP = { KeyW:1, KeyE:3, KeyT:6, KeyY:8, KeyU:10 };

function noteForCode(code) {
  const base = 12 * (octave + 1);
  if (WHITE_KEY_MAP[code] !== undefined) return base + WHITE_KEY_MAP[code];
  if (BLACK_KEY_MAP[code] !== undefined) return base + BLACK_KEY_MAP[code];
  return null;
}

function noteToName(midi) {
  return ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"][midi % 12]
       + Math.floor(midi / 12 - 1);
}

function currentSynth() {
  return SONIC_PI_SYNTHS[synthIdx];
}

// -- drawing --
const KEY_TOP = 116;

function redraw() {
  screen.clear();

  // Header
  screen.level(15);
  screen.font_size(14);
  screen.move(4, 2);
  screen.text("supersonic");

  screen.level(5);
  screen.font_size(12);
  screen.move(256, 2);
  screen.text_right("scsynth wasm");

  // Divider
  screen.level(3);
  screen.move(0, 16);
  screen.line(256, 16);
  screen.stroke();

  // Status / loading indicator
  if (!loaded) {
    screen.level(loading ? 10 : 5);
    screen.font_size(12);
    screen.move(128, 50);
    screen.text_center(status);

    // Loading spinner dots
    if (loading) {
      const t = frame / 30;
      for (let i = 0; i < 4; i++) {
        const a = (t + i * 0.5) % 4;
        const lvl = Math.max(2, Math.round(15 - a * 3));
        screen.level(lvl);
        screen.circle_fill(96 + i * 16, 72, 4);
      }
    }

    screen.update();
    frame++;
    animId = requestAnimationFrame(redraw);
    return;
  }

  // Synth selector
  const synth = currentSynth();
  const visRange = 5;
  const startIdx = Math.max(0, Math.min(
    synthIdx - Math.floor(visRange / 2),
    SONIC_PI_SYNTHS.length - visRange
  ));

  for (let i = startIdx; i < Math.min(startIdx + visRange, SONIC_PI_SYNTHS.length); i++) {
    const y    = 22 + (i - startIdx) * 16;
    const s    = SONIC_PI_SYNTHS[i];
    const isCur = i === synthIdx;

    if (isCur) {
      screen.level(4);
      screen.rect_fill(0, y - 1, 256, 15);
    }

    // Arrow indicator
    screen.level(isCur ? 15 : 4);
    screen.font_size(12);
    screen.move(6, y);
    screen.text(isCur ? "▶" : " ");

    screen.move(16, y);
    screen.text(s.label);

    // Show if this synth is currently loaded
    if (synthLoaded.has(s.name)) {
      screen.level(isCur ? 10 : 3);
      screen.move(250, y);
      screen.text_right("✓");
    }
  }

  // Scroll indicator
  if (SONIC_PI_SYNTHS.length > visRange) {
    const trackH = visRange * 16;
    const thumbH = Math.max(6, Math.round(trackH * visRange / SONIC_PI_SYNTHS.length));
    const thumbY = 22 + Math.round((startIdx / SONIC_PI_SYNTHS.length) * trackH);
    screen.level(3);
    screen.rect_fill(253, 22, 3, trackH);
    screen.level(8);
    screen.rect_fill(253, thumbY, 3, thumbH);
  }

  // Bottom divider
  screen.level(3);
  screen.move(0, 112);
  screen.line(256, 112);
  screen.stroke();

  // Mini piano strip — 8 white keys
  const keyW = 30, keyGap = 1;
  const WHITE_CODES = ["KeyA","KeyS","KeyD","KeyF","KeyG","KeyH","KeyJ","KeyK"];
  const BLACK_CODES = [null,"KeyW","KeyE",null,"KeyT","KeyY","KeyU",null];

  for (let i = 0; i < WHITE_CODES.length; i++) {
    const midi = noteForCode(WHITE_CODES[i]);
    const held = midi != null && heldNotes.has(midi);
    screen.level(held ? 15 : 5);
    screen.rect_fill(4 + i * (keyW + keyGap), KEY_TOP, keyW, 10);
  }
  for (let i = 0; i < BLACK_CODES.length; i++) {
    if (!BLACK_CODES[i]) continue;
    const midi = noteForCode(BLACK_CODES[i]);
    const held = midi != null && heldNotes.has(midi);
    screen.level(held ? 12 : 2);
    screen.rect_fill(4 + i * (keyW + keyGap) + Math.round(keyW * 0.6), KEY_TOP, Math.round(keyW * 0.7), 7);
  }

  // Held note labels
  if (heldNotes.size > 0) {
    screen.level(10);
    screen.font_size(12);
    screen.move(4, 113);
    const names = [...heldNotes.keys()].map(noteToName).join(" ");
    screen.text(names);
  } else {
    screen.level(4);
    screen.font_size(12);
    screen.move(4, 113);
    screen.text(`oct ${octave}  [/] shift  ↑↓ synth`);
  }

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// -- boot supersonic on first keypress --
async function bootAndLoad() {
  if (loading || loaded) return;
  loading = true;
  status  = "loading scsynth wasm…";

  try {
    await supersonic.init();
    // Pre-load the first synth
    const s = currentSynth();
    status = `loading ${s.label}…`;
    await supersonic.loadSynthDef(s.name);
    synthLoaded.add(s.name);

    loaded  = true;
    loading = false;
    status  = "ready";
  } catch (err) {
    loading = false;
    status  = `error: ${err.message}`;
    console.error("supersonic init failed:", err);
  }
}

// Ensure the current synth's SynthDef is loaded before playing
async function ensureLoaded(synthName) {
  if (synthLoaded.has(synthName)) return;
  await supersonic.loadSynthDef(synthName);
  synthLoaded.add(synthName);
}

// -- keyboard --
const HANDLED = new Set([
  "ArrowUp","ArrowDown","BracketLeft","BracketRight",
  ...Object.keys(WHITE_KEY_MAP),
  ...Object.keys(BLACK_KEY_MAP),
]);

function onKeyDown(e) {
  if (e.repeat) return;

  // Boot on first key press (satisfies browser autoplay policy)
  if (!loaded && !loading) {
    bootAndLoad();
    return;
  }

  if (!HANDLED.has(e.code)) return;
  e.preventDefault();

  if (e.code === "ArrowUp") {
    synthIdx = (synthIdx - 1 + SONIC_PI_SYNTHS.length) % SONIC_PI_SYNTHS.length;
    // Pre-load the newly selected synth in the background
    ensureLoaded(currentSynth().name);
    return;
  }
  if (e.code === "ArrowDown") {
    synthIdx = (synthIdx + 1) % SONIC_PI_SYNTHS.length;
    ensureLoaded(currentSynth().name);
    return;
  }
  if (e.code === "BracketLeft")  { octave = Math.max(0, octave - 1); return; }
  if (e.code === "BracketRight") { octave = Math.min(8, octave + 1); return; }

  if (!loaded) return;

  const midi = noteForCode(e.code);
  if (midi == null || heldNotes.has(midi)) return;

  const synth = currentSynth();
  ensureLoaded(synth.name).then(() => {
    const id = supersonic.newNode(synth.name, {
      note:    midi,
      amp:     0.7,
      pan:     0,
      attack:  0.01,
      release: 0.5,
      ...synth.extra,
    });
    heldNotes.set(midi, id);
  });
}

function onKeyUp(e) {
  const midi = noteForCode(e.code);
  if (midi == null) return;
  // Sonic Pi synths are self-releasing — just remove from held state
  heldNotes.delete(midi);
}

// -- init / cleanup --
export async function init(canvas, _audioCtx) {
  screen.init(canvas);
  frame    = 0;
  loading  = false;
  loaded   = false;
  status   = "press any key to load";
  synthIdx = 0;
  synthLoaded.clear();
  heldNotes.clear();
  octave = 4;

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup",   onKeyUp);

  redraw();
}

export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup",   onKeyUp);

  if (loaded) {
    supersonic.freeAll();
  }
}
