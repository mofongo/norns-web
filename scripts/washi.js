// washi — serge-inspired step sequencer (norns-web port)
// based on p3r7/washi by @eigen
//
// Recreates the Hale 8-Stage Complex Sequencing Programmer, itself derived
// from Serge Tcherepnin's modular synthesizer sequencer design.
//
// Two 8-step × 4-row (A/B/C/D) sequencers with a modular signal engine:
//   NornsClock → QuantizedClock → Haleseq → MIDI Out
//
// KEYS:
//   ←  /  →     select step (edit cursor)
//   ↑  /  ↓     adjust step value ±50 (hold shift for ±10)
//   Tab          cycle active edit row  A→B→C→D
//   1–8          jump cursor to step directly
//   m            cycle step mode  run → tie → skip
//   r            randomize step values for active sequencer
//   h            switch active sequencer (hs1 / hs2)
//   Home         reset active sequencer to step 1
//   Space        start / stop clock
//   ↑ / ↓        (clock page) adjust tempo ±5 bpm
//   [  /  ]      previous / next page (seq / clock / patch)

import screen from "../lib/screen.js";
import clock from "../lib/clock.js";
import midi from "../lib/midi.js";

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────

const V_MAX       = 1000;   // maximum signal value (normalized voltage)
const NB_STEPS    = 8;      // horizontal steps per sequencer
const NB_ROWS     = 4;      // vertical rows (A, B, C, D)
const FPS         = 15;     // screen refresh rate
const TRIG_MS     = 30;     // trigger pulse duration in ms

// Master clock: fires 64 ticks per bar via clock.sync(1/16) × 4 beats
const MCLOCK_DIVS = 64;

const ROW_NAMES   = ["A", "B", "C", "D"];
const STEP_MODES  = ["run", "tie", "skip"];
const PAGES       = ["seq", "clock", "patch"];

// Clock division denominators (relative to MCLOCK_DIVS ticks/bar)
// acum % d fires at 64/d events per bar
const CLK_DIVS    = [1, 2, 4, 8, 16, 32, 64];

// Screen layout
const SCREEN_W  = 128;
const SCREEN_H  = 64;
const HDR_H     = 8;    // header height
const ROW_H     = 12;   // height of each sequencer row
const LABEL_W   = 8;    // width of row label column
const STEP_W    = 15;   // width of each step cell  (8 × 15 + 8 = 128 ✓)
const STATUS_Y  = 56;   // footer y position

// ─────────────────────────────────────────────────────────────────
// SIGNAL ROUTING ENGINE
// ─────────────────────────────────────────────────────────────────
// A minimal banana-jack patching system: Outs hold a value and push
// it to all linked Ins. Comparators rise-edge trigger a callback.

function makeOut(id) {
  return { id, v: 0 };
}

function makeIn(id, onUpdate) {
  // onUpdate(v) called whenever the summed input value changes
  return { id, v: 0, incoming: {}, onUpdate: onUpdate || null };
}

function makeComparator(id, threshold, onRise) {
  // Fires onRise() on low→high transition above threshold
  const c = makeIn(id, null);
  c._threshold = threshold != null ? threshold : V_MAX / 2;
  c._status    = 0;
  c._onRise    = onRise || null;
  return c;
}

const engine = {
  outs:  {},  // id → out object
  ins:   {},  // id → in / comparator object
  links: {},  // outId → [inId, ...]

  registerOut(o) { this.outs[o.id] = o; return o; },
  registerIn(i)  { this.ins[i.id]  = i; return i; },

  link(outId, inId) {
    if (!this.links[outId]) this.links[outId] = [];
    if (!this.links[outId].includes(inId)) this.links[outId].push(inId);
  },

  unlink(outId, inId) {
    if (this.links[outId])
      this.links[outId] = this.links[outId].filter(id => id !== inId);
  },

  toggleLink(outId, inId) {
    if (this.links[outId]?.includes(inId)) this.unlink(outId, inId);
    else this.link(outId, inId);
  },

  areLinked(outId, inId) {
    return !!this.links[outId]?.includes(inId);
  },

  // Propagate a value from an output to all linked inputs
  fire(outId, v) {
    const out = this.outs[outId];
    if (out) out.v = v;
    for (const inId of (this.links[outId] || [])) {
      const inp = this.ins[inId];
      if (!inp) continue;
      inp.incoming[outId] = v;
      this._compute(inp);
    }
  },

  // Fire V_MAX then reset to 0 after TRIG_MS (trigger pulse)
  pulse(outId) {
    this.fire(outId, V_MAX);
    setTimeout(() => this.fire(outId, 0), TRIG_MS);
  },

  _compute(inp) {
    // Sum all incoming values
    let sum = 0;
    for (const val of Object.values(inp.incoming)) sum += val;
    inp.v = sum;

    if ("_onRise" in inp) {
      // Comparator: detect low→high edge
      const prev      = inp._status;
      inp._status     = inp.v >= inp._threshold ? 1 : 0;
      if (inp._status === 1 && prev === 0 && inp._onRise) inp._onRise();
    } else if (inp.onUpdate) {
      inp.onUpdate(inp.v);
    }
  },

  reset() {
    this.outs  = {};
    this.ins   = {};
    this.links = {};
  },
};

// ─────────────────────────────────────────────────────────────────
// NORNS CLOCK
// ─────────────────────────────────────────────────────────────────
// Master clock source. Fires 64 trigger pulses per bar by syncing
// to clock.sync(1/16) which gives 16 ticks/beat × 4 beats = 64/bar.

function makeNornsClock() {
  const nc = {
    out:    engine.registerOut(makeOut("nclk.o")),
    coroId: null,
    ticks:  0,
  };

  nc.start = function () {
    this.stop();
    this.coroId = clock.run(async () => {
      while (true) {
        // Short high pulse, then low, then wait for next beat subdivision
        engine.fire("nclk.o", V_MAX);
        await clock.sleep(0.001);
        engine.fire("nclk.o", 0);
        this.ticks++;
        await clock.sync(1 / 16);  // 1/16 of a beat = 1/64 of a bar
      }
    });
  };

  nc.stop = function () {
    if (this.coroId !== null) {
      clock.cancel(this.coroId);
      this.coroId = null;
    }
  };

  return nc;
}

// ─────────────────────────────────────────────────────────────────
// QUANTIZED CLOCK
// ─────────────────────────────────────────────────────────────────
// Divides the master clock into 1/1, 1/2, 1/4, 1/8, 1/16, 1/32, 1/64.
// Each output fires a pulse whenever `acum % d === 0`.

function makeQuantizedClock() {
  const qc = {
    acum: 0,
    outs: {},
    i:    null,
  };

  qc.i = engine.registerIn(makeComparator("qclk.i", V_MAX / 2, () => qc.tick()));

  for (const d of CLK_DIVS) {
    qc.outs[d] = engine.registerOut(makeOut(`qclk.o${d}`));
  }

  qc.tick = function () {
    this.acum++;
    for (const d of CLK_DIVS) {
      if (this.acum % d === 0) engine.pulse(`qclk.o${d}`);
    }
    // Wrap before overflow (LCM of 1..64 = 720720, keep it simpler)
    if (this.acum >= MCLOCK_DIVS * 256) this.acum = 0;
  };

  qc.reset = function () { this.acum = 0; };

  return qc;
}

// ─────────────────────────────────────────────────────────────────
// HALESEQ — 8-step × 4-row sequencer
// ─────────────────────────────────────────────────────────────────
// Core sequencer module. Horizontal clock advances the step position.
// Vertical clock (vclock) advances the active row (vstep).
// Outputs: 4 CV outs (A/B/C/D), 8 per-step gate outs, 1 AEP (any-event-pulse).

function makeHaleseq(suffix) {
  const id = `hs${suffix}`;
  const hs = {
    id,
    step:    1,  // 1..NB_STEPS  current playhead step
    vstep:   1,  // 1..NB_ROWS   current vertical position
    reverse: false,
    hold:    false,

    // 8 steps, each with 4 row values (0..V_MAX) and a playback mode
    steps: Array.from({ length: NB_STEPS }, () => ({
      vals: [500, 500, 500, 500],  // A, B, C, D
      mode: "run",                  // "run" | "tie" | "skip"
    })),

    i_clock:  null,
    i_vclock: null,
    i_reset:  null,
    i_vreset: null,
    i_hold:   null,

    o_cv:    [],  // [SignalOut × 4] — row A, B, C, D
    o_aep:   null,
    o_gates: [],  // [SignalOut × 8] — per-step gate
  };

  hs.i_clock  = engine.registerIn(makeComparator(`${id}.i_clk`,  V_MAX / 2, () => hs.onClock()));
  hs.i_vclock = engine.registerIn(makeComparator(`${id}.i_vclk`, V_MAX / 2, () => hs.onVClock()));
  hs.i_reset  = engine.registerIn(makeComparator(`${id}.i_rst`,  V_MAX / 2, () => hs.onReset()));
  hs.i_vreset = engine.registerIn(makeComparator(`${id}.i_vrst`, V_MAX / 2, () => hs.onVReset()));
  hs.i_hold   = engine.registerIn(makeComparator(`${id}.i_hld`,  V_MAX / 2, () => { hs.hold = true; }));

  for (let r = 0; r < NB_ROWS; r++) {
    hs.o_cv[r] = engine.registerOut(makeOut(`${id}.o_${ROW_NAMES[r]}`));
  }
  hs.o_aep = engine.registerOut(makeOut(`${id}.o_aep`));
  for (let s = 0; s < NB_STEPS; s++) {
    hs.o_gates[s] = engine.registerOut(makeOut(`${id}.o_g${s + 1}`));
  }

  // Advance to next non-skip step
  hs._nextStep = function () {
    let tries = 0;
    do {
      this.step = this.reverse
        ? (this.step <= 1 ? NB_STEPS : this.step - 1)
        : (this.step >= NB_STEPS ? 1 : this.step + 1);
      tries++;
    } while (this.steps[this.step - 1].mode === "skip" && tries < NB_STEPS);
  };

  // Fire current step values on all CV outputs
  hs._fireCV = function () {
    const s = this.steps[this.step - 1];
    for (let r = 0; r < NB_ROWS; r++) {
      engine.fire(`${id}.o_${ROW_NAMES[r]}`, s.vals[r]);
    }
  };

  // Turn off previous gate, turn on current step gate
  hs._fireGate = function (prevStep) {
    if (prevStep && prevStep !== this.step) {
      engine.fire(`${id}.o_g${prevStep}`, 0);
    }
    engine.fire(`${id}.o_g${this.step}`, V_MAX);
  };

  hs._fireAEP = function () { engine.pulse(`${id}.o_aep`); };

  hs.onClock = function () {
    if (this.hold) { this.hold = false; return; }
    const prev = this.step;
    this._nextStep();
    this._fireCV();
    this._fireGate(prev);
    this._fireAEP();
  };

  hs.onVClock = function () {
    this.vstep = this.vstep >= NB_ROWS ? 1 : this.vstep + 1;
    this._fireCV();
    this._fireAEP();
  };

  hs.onReset = function () {
    const prev = this.step;
    this.step  = 1;
    this._fireCV();
    this._fireGate(prev);
    this._fireAEP();
  };

  hs.onVReset = function () {
    this.vstep = 1;
    this._fireCV();
    this._fireAEP();
  };

  hs.randomize = function () {
    for (const s of this.steps) {
      for (let r = 0; r < NB_ROWS; r++) {
        s.vals[r] = Math.round(Math.random() * V_MAX);
      }
    }
    this._fireCV();
  };

  hs.cycleMode = function (stepIdx) {
    const s = this.steps[stepIdx - 1];
    const i = STEP_MODES.indexOf(s.mode);
    s.mode   = STEP_MODES[(i + 1) % STEP_MODES.length];
  };

  // Fire initial values
  hs._fireCV();
  return hs;
}

// ─────────────────────────────────────────────────────────────────
// MIDI OUTPUT
// ─────────────────────────────────────────────────────────────────
// Listens on i_cv (pitch) and i_trig (gate). On trigger rise sends
// note_on; automatically sends note_off after noteDuration seconds.

function makeMidiOutput(suffix, port, channel) {
  const id = `out${suffix}`;
  const mo = {
    id,
    port,
    channel:      channel || 1,
    octave:       0,
    noteDuration: 0.12,  // seconds
    activeNote:   null,
    noteOffTimer: null,
    i_cv:         null,
    i_trig:       null,
  };

  mo.i_cv   = engine.registerIn(makeIn(`${id}.i_cv`));
  mo.i_trig = engine.registerIn(makeComparator(`${id}.i_trig`, V_MAX / 2, () => mo.onTrig()));

  mo._cvToNote = function () {
    // Map 0..V_MAX → MIDI 36..84 (C2..C6, 4 octaves), with octave shift
    const note = Math.round(36 + (this.i_cv.v / V_MAX) * 48) + this.octave * 12;
    return Math.max(0, Math.min(127, note));
  };

  mo.onTrig = function () {
    if (!this.port) return;
    // Cancel any pending note_off
    if (this.noteOffTimer) {
      clearTimeout(this.noteOffTimer);
      this.noteOffTimer = null;
    }
    // End previous note
    if (this.activeNote !== null) {
      this.port.note_off(this.activeNote, 0, this.channel);
      this.activeNote = null;
    }
    const note       = this._cvToNote();
    this.activeNote  = note;
    this.port.note_on(note, 100, this.channel);

    // Schedule note_off
    this.noteOffTimer = setTimeout(() => {
      this.port.note_off(note, 0, this.channel);
      if (this.activeNote === note) this.activeNote = null;
      this.noteOffTimer = null;
    }, this.noteDuration * 1000);
  };

  mo.cleanup = function () {
    if (this.noteOffTimer) { clearTimeout(this.noteOffTimer); this.noteOffTimer = null; }
    if (this.activeNote !== null && this.port) {
      this.port.note_off(this.activeNote, 0, this.channel);
      this.activeNote = null;
    }
  };

  return mo;
}

// ─────────────────────────────────────────────────────────────────
// MODULE INSTANCES & STATE
// ─────────────────────────────────────────────────────────────────

let nclk = null;
let qclk = null;
let hs1  = null;
let hs2  = null;
let outs = [];

let clockRunning = false;
let tempo        = 120;

// UI state
let page       = 0;  // 0=seq, 1=clock, 2=patch
let cursorStep = 1;  // 1..8
let cursorRow  = 0;  // 0..3
let activeHs   = 0;  // 0 → hs1, 1 → hs2

// Animation
let animId      = null;
let frame       = 0;
let _keyHandler = null;

// ─────────────────────────────────────────────────────────────────
// DEFAULT PATCH
// ─────────────────────────────────────────────────────────────────

function setupPatch() {
  // Master clock → quantized clock
  engine.link("nclk.o", "qclk.i");

  // Quarter notes (qclk/16 = 4 events/bar) → haleseq 1 horizontal clock
  engine.link("qclk.o16", "hs1.i_clk");
  // Once per bar → haleseq 1 vertical clock (advance row A→B→C→D)
  engine.link("qclk.o64", "hs1.i_vclk");

  // Haleseq 1 row A CV → output 1 pitch
  engine.link("hs1.o_A", "out1.i_cv");
  // Haleseq 1 any-event pulse → output 1 trigger
  engine.link("hs1.o_aep", "out1.i_trig");

  // Haleseq 2: same clock, eighth notes for variety
  engine.link("qclk.o8", "hs2.i_clk");
  engine.link("qclk.o64", "hs2.i_vclk");

  // Haleseq 2 row A CV → output 2 pitch
  engine.link("hs2.o_A", "out2.i_cv");
  engine.link("hs2.o_aep", "out2.i_trig");
}

// ─────────────────────────────────────────────────────────────────
// SCREEN DRAWING
// ─────────────────────────────────────────────────────────────────

function drawSeqPage() {
  const hs = activeHs === 0 ? hs1 : hs2;

  // ── Header ──────────────────────────────────────────────────────
  screen.level(15);
  screen.font_size(7);
  screen.move(2, 1);
  screen.text("washi");

  screen.level(6);
  screen.move(38, 1);
  screen.text(`hs${activeHs + 1}`);

  screen.level(8);
  screen.move(55, 1);
  screen.text(`${Math.round(clock.get_tempo())}bpm`);

  // Running indicator (blinking dot)
  if (clockRunning) {
    const blink = Math.floor(frame / 3) % 2 === 0;
    screen.level(blink ? 15 : 5);
    screen.circle_fill(SCREEN_W - 4, 3, 2);
  }

  // ── Sequencer rows ──────────────────────────────────────────────
  for (let r = 0; r < NB_ROWS; r++) {
    const y          = HDR_H + r * ROW_H;
    const isEditRow  = (r === cursorRow);

    // Row label
    screen.level(isEditRow ? 15 : 4);
    screen.font_size(6);
    screen.move(1, y + 3);
    screen.text(ROW_NAMES[r]);

    for (let s = 1; s <= NB_STEPS; s++) {
      const x        = LABEL_W + (s - 1) * STEP_W;
      const stepData = hs.steps[s - 1];
      const val      = stepData.vals[r];
      const mode     = stepData.mode;
      const isSeq    = (s === hs.step);
      const isCursor = (s === cursorStep && r === cursorRow);

      // Inner area: 1px inset all sides
      const ix = x + 1;
      const iy = y + 1;
      const iw = STEP_W - 2;
      const ih = ROW_H - 2;

      // Value bar height (bottom-anchored, 1..ih-1 px)
      const barH = Math.max(1, Math.round((val / V_MAX) * (ih - 1)));
      const barY = iy + (ih - barH);

      if (mode === "skip") {
        screen.level(1);
        screen.rect_fill(ix, iy, iw, ih);
        // Small X
        screen.level(3);
        screen.move(ix + 2, iy + 2);
        screen.line(ix + iw - 3, iy + ih - 3);
        screen.stroke();
      } else if (mode === "tie") {
        screen.level(isSeq ? 10 : 3);
        screen.rect_fill(ix, barY, iw, barH);
        // Tie line
        screen.level(8);
        screen.move(ix, iy + ih - 1);
        screen.line(ix + iw, iy + ih - 1);
        screen.stroke();
      } else {
        screen.level(isSeq ? 15 : (isEditRow ? 5 : 3));
        screen.rect_fill(ix, barY, iw, barH);
      }

      // Active sequencer step: bright outline
      if (isSeq) {
        screen.level(15);
        screen.rect(ix, iy, iw, ih);
        screen.stroke();
      }

      // Edit cursor: dimmer outline
      if (isCursor) {
        screen.level(isEditRow ? 10 : 6);
        screen.rect(x, y, STEP_W, ROW_H);
        screen.stroke();
      }
    }
  }

  // ── Footer ───────────────────────────────────────────────────────
  const sel  = hs.steps[cursorStep - 1];
  const sval = sel.vals[cursorRow];
  screen.level(5);
  screen.font_size(6);
  screen.move(1, STATUS_Y + 1);
  screen.text(`s${cursorStep}${ROW_NAMES[cursorRow]} v:${Math.round(sval / 10)} ${sel.mode}`);

  // Page indicator dots
  for (let p = 0; p < PAGES.length; p++) {
    const dx = SCREEN_W - 14 + p * 5;
    screen.level(p === page ? 12 : 3);
    screen.circle_fill(dx, STATUS_Y + 4, 1);
  }
}

function drawClockPage() {
  screen.level(15);
  screen.font_size(8);
  screen.move(2, 2);
  screen.text("clock");

  screen.level(8);
  screen.font_size(7);
  screen.move(2, 14);
  screen.text(`tempo: ${Math.round(clock.get_tempo())} bpm`);

  screen.level(6);
  screen.move(2, 24);
  screen.text(`status: ${clockRunning ? "running" : "stopped"}`);

  const beats = clock.get_beats();
  screen.move(2, 34);
  screen.text(`beat: ${beats.toFixed(1)}`);

  // Bar-level beat visualizer
  const quarterBeat = Math.floor(beats) % 4;
  for (let i = 0; i < 4; i++) {
    const bx = 8 + i * 18;
    const by = 48;
    if (i === quarterBeat && clockRunning) {
      screen.level(15);
      screen.rect_fill(bx, by, 14, 8);
    } else {
      screen.level(3);
      screen.rect(bx, by, 14, 8);
      screen.stroke();
    }
  }

  screen.level(4);
  screen.font_size(6);
  screen.move(2, 62);
  screen.text("spc:play/stop  \u2191\u2193:tempo");
}

function drawPatchPage() {
  screen.level(15);
  screen.font_size(8);
  screen.move(2, 2);
  screen.text("patch");

  screen.level(6);
  screen.font_size(6);

  const lines = [];
  for (const [outId, inIds] of Object.entries(engine.links)) {
    for (const inId of inIds) {
      // Shorten IDs: strip module prefix, keep signal name
      const fromMod = outId.split(".")[0];
      const toMod   = inId.split(".")[0];
      const fromSig = outId.split(".").slice(1).join(".").replace(/^o_?/, "");
      const toSig   = inId.split(".").slice(1).join(".").replace(/^i_?/, "");
      lines.push(`${fromMod}.${fromSig} \u2192 ${toMod}.${toSig}`);
    }
  }

  let y = 14;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    screen.move(2, y);
    screen.text(lines[i]);
    y += 8;
  }

  if (lines.length === 0) {
    screen.level(4);
    screen.move(2, 24);
    screen.text("no links");
  }

  screen.level(4);
  screen.font_size(6);
  screen.move(2, 62);
  screen.text(`${lines.length} link(s)`);
}

function redraw() {
  screen.clear();
  if (page === 0)      drawSeqPage();
  else if (page === 1) drawClockPage();
  else                 drawPatchPage();
  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// ─────────────────────────────────────────────────────────────────
// CLOCK CONTROL
// ─────────────────────────────────────────────────────────────────

function startClock() {
  clock.internal.set_tempo(tempo);
  clock.internal.start();
  nclk.start();
  clockRunning = true;
}

function stopClock() {
  nclk.stop();
  clock.internal.stop();
  clockRunning = false;
}

function toggleClock() {
  if (clockRunning) stopClock();
  else startClock();
}

// ─────────────────────────────────────────────────────────────────
// KEYBOARD INPUT
// ─────────────────────────────────────────────────────────────────

function onKey(e) {
  if (e.type !== "keydown") return;
  const k  = e.key;
  const hs = activeHs === 0 ? hs1 : hs2;

  // Global controls
  if (k === "[") { page = Math.max(0, page - 1); return; }
  if (k === "]") { page = Math.min(PAGES.length - 1, page + 1); return; }
  if (k === " ") { e.preventDefault(); toggleClock(); return; }

  if (page === 0) {
    // Sequencer page
    if (k === "ArrowLeft") {
      cursorStep = cursorStep <= 1 ? NB_STEPS : cursorStep - 1;
    } else if (k === "ArrowRight") {
      cursorStep = cursorStep >= NB_STEPS ? 1 : cursorStep + 1;
    } else if (k === "Tab") {
      e.preventDefault();
      cursorRow = (cursorRow + 1) % NB_ROWS;
    } else if (k === "ArrowUp") {
      e.preventDefault();
      const s   = hs.steps[cursorStep - 1];
      const inc = e.shiftKey ? 10 : 50;
      s.vals[cursorRow] = Math.min(V_MAX, s.vals[cursorRow] + inc);
      if (cursorStep === hs.step) hs._fireCV();
    } else if (k === "ArrowDown") {
      e.preventDefault();
      const s   = hs.steps[cursorStep - 1];
      const dec = e.shiftKey ? 10 : 50;
      s.vals[cursorRow] = Math.max(0, s.vals[cursorRow] - dec);
      if (cursorStep === hs.step) hs._fireCV();
    } else if (k === "m") {
      hs.cycleMode(cursorStep);
    } else if (k === "r") {
      hs.randomize();
    } else if (k === "h") {
      activeHs = activeHs === 0 ? 1 : 0;
    } else if (k === "Home") {
      hs.onReset();
    } else if (k >= "1" && k <= "8") {
      cursorStep = parseInt(k);
    }
  } else if (page === 1) {
    // Clock page
    if (k === "ArrowUp") {
      e.preventDefault();
      tempo = Math.min(300, tempo + 5);
      clock.internal.set_tempo(tempo);
    } else if (k === "ArrowDown") {
      e.preventDefault();
      tempo = Math.max(10, tempo - 5);
      clock.internal.set_tempo(tempo);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// WEB MIDI (optional hardware MIDI out)
// ─────────────────────────────────────────────────────────────────

async function getWebMidiPort() {
  if (!navigator.requestMIDIAccess) return null;
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    for (const output of access.outputs.values()) {
      console.log("[washi] Web MIDI output:", output.name);
      // Wrap in a norns-compatible API
      return {
        note_on(note, vel, ch) {
          output.send([0x90 | ((ch - 1) & 0x0f), note & 0x7f, vel & 0x7f]);
        },
        note_off(note, vel, ch) {
          output.send([0x80 | ((ch - 1) & 0x0f), note & 0x7f, (vel || 0) & 0x7f]);
        },
      };
    }
  } catch (err) {
    console.warn("[washi] Web MIDI unavailable:", err.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// INIT / CLEANUP
// ─────────────────────────────────────────────────────────────────

export async function init(canvas, audioCtx) {
  screen.init(canvas);
  engine.reset();

  // Use Web MIDI if available, otherwise fall back to virtual MIDI port
  const hwPort  = await getWebMidiPort();
  const port1   = hwPort  || midi.connect(1);
  const port2   = hwPort  || midi.connect(2);

  // Create modules
  nclk = makeNornsClock();
  qclk = makeQuantizedClock();
  hs1  = makeHaleseq(1);
  hs2  = makeHaleseq(2);

  const out1 = makeMidiOutput(1, port1, 1);
  const out2 = makeMidiOutput(2, port2, 2);
  outs = [out1, out2];

  // Default patch wiring
  setupPatch();

  // Keyboard
  _keyHandler = onKey;
  window.addEventListener("keydown", _keyHandler);

  // Reset UI state
  page       = 0;
  cursorStep = 1;
  cursorRow  = 0;
  activeHs   = 0;
  frame      = 0;

  // Start render loop
  animId = requestAnimationFrame(redraw);

  // Auto-start clock
  tempo = 120;
  startClock();
}

export async function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }

  if (_keyHandler) {
    window.removeEventListener("keydown", _keyHandler);
    _keyHandler = null;
  }

  if (nclk) nclk.stop();
  clock.cleanup();

  for (const o of outs) o.cleanup();

  engine.reset();
  nclk = null;
  qclk = null;
  hs1  = null;
  hs2  = null;
  outs = [];
}
