// nb-demo — plug-and-play voice selector with MIDI keyboard
//
// Demonstrates the nb (note-broker) library:
//   - nb.init() auto-discovers Web MIDI outputs as players
//   - nb.add_param() creates a voice selector
//   - selector.select(name) / get_player() drives note output
//
// Controls:
//   ↑ / ↓       navigate player list
//   Enter       select highlighted player
//   A S D F G H J K  → C D E F G A B C  (white keys, octave 4-5)
//   W E T Y U        → C# D# F# G# A#  (black keys)
//   [ / ]       octave down / up

import screen from "../lib/screen.js";
import nb from "../lib/nb.js";

// -- state --
let animId = null;
let voice = null;   // Selector from nb.add_param()
let frame = 0;

// Player list navigation
let playerNames = [];  // ['none', ...sorted names]
let cursorIdx = 0;     // highlighted row in list (not yet selected)
let selectedIdx = 0;   // currently active selection

// Piano keyboard
let octave = 4;
const heldNotes = new Set();

// White-key → semitone offset from C
const WHITE_KEY_MAP = {
  KeyA: 0,   // C
  KeyS: 2,   // D
  KeyD: 4,   // E
  KeyF: 5,   // F
  KeyG: 7,   // G
  KeyH: 9,   // A
  KeyJ: 11,  // B
  KeyK: 12,  // C (next octave)
};
// Black-key → semitone offset from C
const BLACK_KEY_MAP = {
  KeyW: 1,   // C#
  KeyE: 3,   // D#
  KeyT: 6,   // F#
  KeyY: 8,   // G#
  KeyU: 10,  // A#
};

function noteForCode(code) {
  if (WHITE_KEY_MAP[code] !== undefined) {
    return 12 * (octave + 1) + WHITE_KEY_MAP[code]; // MIDI C4 = 60
  }
  if (BLACK_KEY_MAP[code] !== undefined) {
    return 12 * (octave + 1) + BLACK_KEY_MAP[code];
  }
  return null;
}

function noteToName(midi) {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  return names[midi % 12] + Math.floor(midi / 12 - 1);
}

// -- drawing --
const VISIBLE_ROWS = 5;
const ROW_H = 18;
const LIST_TOP = 24;
const KEY_TOP = 118;  // bottom strip y

// Piano key x positions (relative to KEY_TOP strip, white keys 0-7)
const WHITE_KEY_CODES = ["KeyA","KeyS","KeyD","KeyF","KeyG","KeyH","KeyJ","KeyK"];
const BLACK_KEY_CODES = [null,"KeyW","KeyE",null,"KeyT","KeyY","KeyU",null];

function redraw() {
  screen.clear();

  // -- Header --
  screen.level(15);
  screen.font_size(14);
  screen.move(4, 2);
  screen.text("nb demo");

  const selName = voice ? voice.getSelectedName() : "none";
  screen.level(8);
  screen.font_size(12);
  screen.move(256, 2);
  screen.text_right(selName);

  // Divider
  screen.level(3);
  screen.move(0, 16);
  screen.line(256, 16);
  screen.stroke();

  // -- Player list --
  const scrollTop = Math.max(0, cursorIdx - Math.floor(VISIBLE_ROWS / 2));
  const scrollEnd = Math.min(playerNames.length, scrollTop + VISIBLE_ROWS);

  for (let i = scrollTop; i < scrollEnd; i++) {
    const y = LIST_TOP + (i - scrollTop) * ROW_H;
    const name = playerNames[i];
    const isCursor = i === cursorIdx;
    const isSelected = i === selectedIdx;

    if (isCursor) {
      screen.level(4);
      screen.rect_fill(0, y - 1, 256, ROW_H - 2);
    }

    // Bullet: filled circle if this is the active selection
    if (isSelected) {
      screen.level(15);
      screen.circle_fill(6, y + 6, 3);
    } else {
      screen.level(isCursor ? 10 : 4);
      screen.circle(6, y + 6, 3);
      screen.stroke();
    }

    screen.level(isCursor ? 15 : (isSelected ? 12 : 6));
    screen.font_size(12);
    screen.move(14, y);
    screen.text(name);
  }

  // Scroll indicator
  if (playerNames.length > VISIBLE_ROWS) {
    const trackH = VISIBLE_ROWS * ROW_H;
    const thumbH = Math.max(8, Math.round(trackH * VISIBLE_ROWS / playerNames.length));
    const thumbY = LIST_TOP + Math.round((scrollTop / playerNames.length) * trackH);
    screen.level(3);
    screen.rect_fill(253, LIST_TOP, 3, trackH);
    screen.level(8);
    screen.rect_fill(253, thumbY, 3, thumbH);
  }

  // Divider before keyboard strip
  screen.level(3);
  screen.move(0, 114);
  screen.line(256, 114);
  screen.stroke();

  // -- Piano strip --
  // 8 white keys across ~240px, black keys overlaid
  const keyW = 30;
  const keyGap = 1;

  for (let i = 0; i < WHITE_KEY_CODES.length; i++) {
    const code = WHITE_KEY_CODES[i];
    const midi = noteForCode(code);
    const held = midi !== null && heldNotes.has(midi);
    const x = 4 + i * (keyW + keyGap);

    screen.level(held ? 15 : 5);
    screen.rect_fill(x, KEY_TOP, keyW, 9);
  }

  for (let i = 0; i < BLACK_KEY_CODES.length; i++) {
    const code = BLACK_KEY_CODES[i];
    if (!code) continue;
    const midi = noteForCode(code);
    const held = midi !== null && heldNotes.has(midi);
    const x = 4 + i * (keyW + keyGap) + Math.round(keyW * 0.6);

    screen.level(held ? 12 : 2);
    screen.rect_fill(x, KEY_TOP, Math.round(keyW * 0.7), 6);
  }

  // Hint: octave label
  screen.level(4);
  screen.font_size(12);
  screen.move(4, 113);
  screen.text(`oct ${octave}  [/] shift`);

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// -- keyboard input --
const HANDLED_CODES = new Set([
  "ArrowUp", "ArrowDown", "Enter",
  "BracketLeft", "BracketRight",
  ...Object.keys(WHITE_KEY_MAP),
  ...Object.keys(BLACK_KEY_MAP),
]);

function onKeyDown(e) {
  if (!HANDLED_CODES.has(e.code) && !HANDLED_CODES.has(e.key)) return;
  if (e.repeat) return;
  e.preventDefault();

  // Navigation
  if (e.key === "ArrowUp") {
    cursorIdx = Math.max(0, cursorIdx - 1);
    return;
  }
  if (e.key === "ArrowDown") {
    cursorIdx = Math.min(playerNames.length - 1, cursorIdx + 1);
    return;
  }
  if (e.key === "Enter") {
    selectedIdx = cursorIdx;
    if (voice) voice.select(playerNames[selectedIdx]);
    return;
  }

  // Octave shift
  if (e.code === "BracketLeft") {
    octave = Math.max(0, octave - 1);
    return;
  }
  if (e.code === "BracketRight") {
    octave = Math.min(8, octave + 1);
    return;
  }

  // Piano keys
  const midi = noteForCode(e.code);
  if (midi !== null && !heldNotes.has(midi)) {
    heldNotes.add(midi);
    if (voice) {
      const player = voice.get_player();
      player.note_on(midi, 0.75);
    }
  }
}

function onKeyUp(e) {
  const midi = noteForCode(e.code);
  if (midi !== null && heldNotes.has(midi)) {
    heldNotes.delete(midi);
    if (voice) {
      const player = voice.get_player();
      player.note_off(midi);
    }
  }
}

// -- init / cleanup --
export async function init(canvas, _audioCtx) {
  screen.init(canvas);
  frame = 0;
  cursorIdx = 0;
  selectedIdx = 0;
  heldNotes.clear();
  octave = 4;

  // Initialize nb: discovers Web MIDI outputs
  await nb.init();

  // Create a voice selector
  voice = nb.add_param("nb_demo_voice", "voice");

  // Refresh player list (nb.init() may have added new hardware players)
  playerNames = voice.getNames();

  // Auto-select the first real player if one exists
  if (playerNames.length > 1) {
    cursorIdx = 1;
    selectedIdx = 1;
    voice.select(playerNames[1]);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  redraw();
}

export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);

  // Release all held notes
  if (voice) {
    const player = voice.get_player();
    for (const midi of heldNotes) {
      player.note_off(midi);
    }
    heldNotes.clear();
    voice.cleanup();
    voice = null;
  }

  nb.stop_all();
}
