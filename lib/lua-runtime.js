// lua-runtime.js — bridges norns-web APIs into a lua-in-js environment.
//
// Loads a .lua script and wires up:
//   screen, midi, clock (basic), math, util
// Lifecycle:
//   init()       — called once on load
//   redraw()     — called each animation frame
//   key(n, z)    — called on keyboard/button events
//   enc(n, d)    — called on encoder events
//
// ⚠ Coroutine limitation: lua-in-js does not support Lua coroutines.
//   clock.run() / clock.sync() / clock.sleep() patterns that rely on
//   coroutine yield are not supported. Use clock.schedule() instead.

import * as luainjs from "../node_modules/lua-in-js/dist/lua-in-js.es.js";
import screen from "./screen.js";
import midi from "./midi.js";
import clock from "./clock.js";

// -- helpers --

function luaFn(fn) {
  return fn;
}

function num(v) {
  return typeof v === "number" ? v : Number(v) || 0;
}

function str(v) {
  return v == null ? "" : String(v);
}

// Wrap a JS object's methods as a luainjs.Table
function bridgeTable(obj, keys) {
  const entries = {};
  for (const key of keys) {
    if (typeof obj[key] === "function") {
      entries[key] = (...args) => obj[key](...args);
    } else {
      entries[key] = obj[key];
    }
  }
  return new luainjs.Table(entries);
}

// -- build the Lua environment --

export function createLuaRuntime() {
  const luaEnv = luainjs.createEnv({
    stdout: (text) => console.log("[lua]", text),
    stderr: (text) => console.error("[lua stderr]", text),
  });

  // ── screen ──────────────────────────────────────────────────────────────
  const screenTable = new luainjs.Table({
    clear:               ()              => screen.clear(),
    update:              ()              => screen.update(),
    level:               (l)             => screen.level(num(l)),
    aa:                  (s)             => screen.aa(s),
    line_width:          (w)             => screen.line_width(num(w)),
    line_cap:            (s)             => screen.line_cap(str(s)),
    line_join:           (s)             => screen.line_join(str(s)),
    move:                (x, y)          => screen.move(num(x), num(y)),
    move_rel:            (x, y)          => screen.move_rel(num(x), num(y)),
    line:                (x, y)          => screen.line(num(x), num(y)),
    line_rel:            (x, y)          => screen.line_rel(num(x), num(y)),
    close:               ()              => screen.close(),
    stroke:              ()              => screen.stroke(),
    fill:                ()              => screen.fill(),
    rect:                (x, y, w, h)    => screen.rect(num(x), num(y), num(w), num(h)),
    rect_fill:           (x, y, w, h)    => screen.rect_fill(num(x), num(y), num(w), num(h)),
    circle:              (x, y, r)       => screen.circle(num(x), num(y), num(r)),
    circle_fill:         (x, y, r)       => screen.circle_fill(num(x), num(y), num(r)),
    arc:                 (x, y, r, a1, a2) => screen.arc(num(x), num(y), num(r), num(a1), num(a2)),
    curve:               (x1, y1, x2, y2, x3, y3) => screen.curve(num(x1), num(y1), num(x2), num(y2), num(x3), num(y3)),
    curve_rel:           (dx1, dy1, dx2, dy2, dx3, dy3) => screen.curve_rel(num(dx1), num(dy1), num(dx2), num(dy2), num(dx3), num(dy3)),
    pixel:               (x, y)          => screen.pixel(num(x), num(y)),
    font_face:           (i)             => screen.font_face(num(i)),
    font_size:           (s)             => screen.font_size(num(s)),
    text:                (s)             => screen.text(str(s)),
    text_right:          (s)             => screen.text_right(str(s)),
    text_center:         (s)             => screen.text_center(str(s)),
    text_extents:        (s)             => { const e = screen.text_extents(str(s)); return new luainjs.Table({ w: e.w, h: e.h }); },
    text_rotate:         (x, y, s, d)    => screen.text_rotate(num(x), num(y), str(s), num(d)),
    text_center_rotate:  (x, y, s, d)    => screen.text_center_rotate(num(x), num(y), str(s), num(d)),
    save:                ()              => screen.save(),
    restore:             ()              => screen.restore(),
    translate:           (x, y)          => screen.translate(num(x), num(y)),
    rotate:              (r)             => screen.rotate(num(r)),
  });
  luaEnv.loadLib("screen", screenTable);

  // ── midi ─────────────────────────────────────────────────────────────────
  const midiTable = new luainjs.Table({
    connect: (n) => {
      const port = midi.connect(num(n) || 1);
      return new luainjs.Table({
        note_on:          (note, vel, ch)  => port.note_on(num(note), num(vel), num(ch)),
        note_off:         (note, vel, ch)  => port.note_off(num(note), num(vel), num(ch)),
        cc:               (cc, val, ch)    => port.cc(num(cc), num(val), num(ch)),
        pitchbend:        (val, ch)        => port.pitchbend(num(val), num(ch)),
        channel_pressure: (val, ch)        => port.channel_pressure(num(val), num(ch)),
        key_pressure:     (note, val, ch)  => port.key_pressure(num(note), num(val), num(ch)),
        program_change:   (val, ch)        => port.program_change(num(val), num(ch)),
        send:             (data)           => port.send(data),
        // event handler: set via port.event = fn in Lua
        set_event: (fn) => { port.event = (data) => fn(new luainjs.Table(data)); },
      });
    },
    to_msg: (data) => {
      const msg = midi.to_msg(data);
      return msg ? new luainjs.Table(msg) : null;
    },
  });
  luaEnv.loadLib("midi", midiTable);

  // ── clock ─────────────────────────────────────────────────────────────────
  // clock.run / sync / sleep require Lua coroutines, which lua-in-js lacks.
  // Instead, clock.schedule(beats, fn) fires a one-shot JS callback after
  // `beats` beats. For repeating patterns, reschedule inside the callback.
  const clockTable = new luainjs.Table({
    get_tempo:    ()       => clock.get_tempo(),
    get_beats:    ()       => clock.get_beats(),
    get_beat_sec: ()       => clock.get_beat_sec(),
    set_source:   (s)      => clock.set_source(str(s)),

    // One-shot callback scheduled after `beats` beats from now
    schedule: (beats, fn) => {
      clock.run(async () => {
        await clock.sync(num(beats));
        fn();
      });
    },

    // Repeat `fn` every `beats` beats, returns a cancel id
    metro: (beats, fn) => {
      return clock.run(async () => {
        while (true) {
          await clock.sync(num(beats));
          fn();
        }
      });
    },

    cancel: (id) => clock.cancel(num(id)),

    internal: new luainjs.Table({
      set_tempo: (bpm) => clock.internal.set_tempo(num(bpm)),
      start:     ()    => clock.internal.start(),
      stop:      ()    => clock.internal.stop(),
    }),
  });
  luaEnv.loadLib("clock", clockTable);

  // ── util ──────────────────────────────────────────────────────────────────
  const utilTable = new luainjs.Table({
    time:    ()          => performance.now() / 1000,
    wrap:    (n, lo, hi) => { const r = hi - lo; return lo + ((num(n) - lo) % r + r) % r; },
    clamp:   (n, lo, hi) => Math.max(num(lo), Math.min(num(hi), num(n))),
    linlin:  (n, l1, h1, l2, h2) => { n = num(n); const t = (n - num(l1)) / (num(h1) - num(l1)); return num(l2) + t * (num(h2) - num(l2)); },
    round:   (n, q)      => { q = num(q) || 1; return Math.round(num(n) / q) * q; },
  });
  luaEnv.loadLib("util", utilTable);

  return luaEnv;
}

// -- run a Lua script source string inside an initialized environment --

export async function runLuaScript(luaSrc, canvas, audioCtx) {
  screen.init(canvas);

  const luaEnv = createLuaRuntime();

  // Parse and execute the script (defines init, redraw, key, enc, etc.)
  luaEnv.parse(luaSrc).exec();

  // Helper: call a named Lua global if it exists
  function callGlobal(name, ...args) {
    try {
      const fn = luaEnv.get(name);
      if (typeof fn === "function") fn(...args);
    } catch (e) {
      console.warn(`[lua] ${name}() error:`, e.message ?? e);
    }
  }

  // Call init()
  callGlobal("init");

  // redraw loop
  let _rafId = null;
  let _running = true;

  function loop() {
    if (!_running) return;
    callGlobal("redraw");
    _rafId = requestAnimationFrame(loop);
  }
  _rafId = requestAnimationFrame(loop);

  // Expose event hooks for the host page to call
  return {
    key: (n, z)  => callGlobal("key", n, z),
    enc: (n, d)  => callGlobal("enc", n, d),
    cleanup() {
      _running = false;
      if (_rafId) cancelAnimationFrame(_rafId);
      clock.cleanup();
      midi.cleanup();
    },
  };
}
