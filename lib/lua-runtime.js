// lua-runtime.js — fengari-based Lua 5.3 runtime for norns-web
//
// Requires fengari-web loaded via <script> before this module:
//   <script src="./node_modules/fengari-web/dist/fengari-web.js"></script>
//
// Supports full norns lifecycle:
//   init()       — called once on load
//   redraw()     — called each animation frame
//   key(n, z)    — button/keyboard events
//   enc(n, d)    — encoder events
//
// Coroutines fully supported — idiomatic clock.run / clock.sync / clock.sleep works.

import screen from "./screen.js";
import midi from "./midi.js";
import clock from "./clock.js";
import softcut from "./softcut.js";

// ---------------------------------------------------------------------------
// helpers

function getFengari() {
  if (typeof window === "undefined" || !window.fengari) {
    throw new Error(
      "fengari not loaded — add " +
      "<script src='./node_modules/fengari-web/dist/fengari-web.js'></script> " +
      "to index.html before the module script"
    );
  }
  return window.fengari;
}

// ---------------------------------------------------------------------------

export async function runLuaScript(luaSrc, canvas, audioCtx) {
  screen.init(canvas);

  // Initialize softcut if an AudioContext is available
  if (audioCtx) {
    await softcut.init(audioCtx);
  }

  const { lua: luaApi, lauxlib, lualib, to_luastring } = getFengari();

  const {
    LUA_OK, LUA_YIELD, LUA_MULTRET,
    LUA_TFUNCTION, LUA_TNUMBER, LUA_TSTRING, LUA_TBOOLEAN, LUA_TNIL,
    LUA_REGISTRYINDEX,
    lua_newthread, lua_resume, lua_yield,
    lua_pushnumber, lua_pushinteger, lua_pushstring, lua_pushboolean, lua_pushnil,
    lua_pushjsfunction, lua_setglobal, lua_getglobal,
    lua_newtable, lua_setfield, lua_setmetatable, lua_createtable,
    lua_rawset, lua_rawgeti, lua_rawseti,
    lua_tonumber, lua_tojsstring, lua_toboolean,
    lua_gettop, lua_settop, lua_pop, lua_pushvalue,
    lua_isfunction, lua_type, lua_xmove, lua_pcall,
  } = luaApi;

  const { luaL_newstate, luaL_loadstring, luaL_ref, luaL_unref, LUA_NOREF } = lauxlib;
  const { luaL_openlibs } = lualib;
  const ls = to_luastring;

  // Shorthand stack readers
  const N = (L, idx, def = 0) => { const v = lua_tonumber(L, idx); return v == null ? def : v; };
  const S = (L, idx, def = "") => { const v = lua_tojsstring(L, idx); return v == null ? def : String(def); };

  // ---------------------------------------------------------------------------
  // Create Lua state
  const L = luaL_newstate();
  luaL_openlibs(L); // opens coroutine, math, string, table, os, io, package, …

  // ---------------------------------------------------------------------------
  // ── screen ──────────────────────────────────────────────────────────────────

  lua_newtable(L);

  const screenMethods = {
    clear:              (L) => { screen.clear(); return 0; },
    update:             (L) => { screen.update(); return 0; },
    level:              (L) => { screen.level(N(L, 1)); return 0; },
    aa:                 (L) => { screen.aa(lua_toboolean(L, 1)); return 0; },
    line_width:         (L) => { screen.line_width(N(L, 1)); return 0; },
    line_cap:           (L) => { screen.line_cap(S(L, 1, "butt")); return 0; },
    line_join:          (L) => { screen.line_join(S(L, 1, "miter")); return 0; },
    move:               (L) => { screen.move(N(L, 1), N(L, 2)); return 0; },
    move_rel:           (L) => { screen.move_rel(N(L, 1), N(L, 2)); return 0; },
    line:               (L) => { screen.line(N(L, 1), N(L, 2)); return 0; },
    line_rel:           (L) => { screen.line_rel(N(L, 1), N(L, 2)); return 0; },
    close:              (L) => { screen.close(); return 0; },
    stroke:             (L) => { screen.stroke(); return 0; },
    fill:               (L) => { screen.fill(); return 0; },
    rect:               (L) => { screen.rect(N(L,1), N(L,2), N(L,3), N(L,4)); return 0; },
    rect_fill:          (L) => { screen.rect_fill(N(L,1), N(L,2), N(L,3), N(L,4)); return 0; },
    circle:             (L) => { screen.circle(N(L,1), N(L,2), N(L,3)); return 0; },
    circle_fill:        (L) => { screen.circle_fill(N(L,1), N(L,2), N(L,3)); return 0; },
    arc:                (L) => { screen.arc(N(L,1), N(L,2), N(L,3), N(L,4), N(L,5)); return 0; },
    curve:              (L) => { screen.curve(N(L,1), N(L,2), N(L,3), N(L,4), N(L,5), N(L,6)); return 0; },
    curve_rel:          (L) => { screen.curve_rel(N(L,1), N(L,2), N(L,3), N(L,4), N(L,5), N(L,6)); return 0; },
    pixel:              (L) => { screen.pixel(N(L,1), N(L,2)); return 0; },
    font_face:          (L) => { screen.font_face(N(L,1)); return 0; },
    font_size:          (L) => { screen.font_size(N(L,1)); return 0; },
    text:               (L) => { screen.text(S(L, 1)); return 0; },
    text_right:         (L) => { screen.text_right(S(L, 1)); return 0; },
    text_center:        (L) => { screen.text_center(S(L, 1)); return 0; },
    text_extents:       (L) => {
      const e = screen.text_extents(S(L, 1));
      lua_pushnumber(L, e.w);
      lua_pushnumber(L, e.h);
      return 2;
    },
    text_rotate:        (L) => { screen.text_rotate(N(L,1), N(L,2), S(L,3), N(L,4)); return 0; },
    text_center_rotate: (L) => { screen.text_center_rotate(N(L,1), N(L,2), S(L,3), N(L,4)); return 0; },
    save:               (L) => { screen.save(); return 0; },
    restore:            (L) => { screen.restore(); return 0; },
    translate:          (L) => { screen.translate(N(L,1), N(L,2)); return 0; },
    rotate:             (L) => { screen.rotate(N(L,1)); return 0; },
  };

  for (const [name, fn] of Object.entries(screenMethods)) {
    lua_pushjsfunction(L, fn);
    lua_setfield(L, -2, ls(name));
  }
  lua_setglobal(L, ls("screen"));

  // ---------------------------------------------------------------------------
  // ── clock ───────────────────────────────────────────────────────────────────
  //
  // clock.run(fn)      — start a coroutine; returns a numeric id
  // clock.sync(beats)  — yield until the next beat grid position (must be inside clock.run)
  // clock.sleep(secs)  — yield for a fixed duration              (must be inside clock.run)
  // clock.cancel(id)   — cancel a running coroutine
  // clock.get_tempo()  — returns current BPM
  // clock.get_beats()  — returns current beat position
  // clock.get_beat_sec() — seconds per beat
  // clock.internal.set_tempo(bpm) / .start() / .stop()

  lua_newtable(L);

  // clock.run(fn [, ...args]) — creates a Lua coroutine and drives it from JS
  lua_pushjsfunction(L, (L) => {
    if (lua_type(L, 1) !== LUA_TFUNCTION) {
      console.error("[lua] clock.run: expected function");
      return 0;
    }
    const nargs = lua_gettop(L) - 1;

    // Create a new Lua thread from fn
    const co = lua_newthread(L);  // pushes thread on L's stack, returns it as JS ref
    lua_pushvalue(L, 1);           // copy fn to top of L
    lua_xmove(L, co, 1);          // move fn from L → co
    // Move any extra args to co as well
    for (let i = 2; i <= nargs + 1; i++) lua_pushvalue(L, i);
    if (nargs > 0) lua_xmove(L, co, nargs);

    // Anchor the thread in the Lua registry so the GC won't collect it
    // (lua_newthread pushed it; luaL_ref pops the top of L which is the thread)
    const coRef = luaL_ref(L, LUA_REGISTRYINDEX);

    // JS async driver loop
    const id = clock.run(async () => {
      let resumeArgs = nargs;
      try {
        while (true) {
          const status = lua_resume(co, L, resumeArgs);
          resumeArgs = 0;

          if (status === LUA_YIELD) {
            // Coroutine yielded — read type+value pushed by clock.sync / clock.sleep
            const yieldType = lua_tojsstring(co, 1) || "sleep";
            const yieldVal  = lua_tonumber(co, 2) || 0;
            lua_settop(co, 0); // clear yield args from co's stack

            if (yieldType === "sync") {
              await clock.sync(yieldVal);
            } else {
              await clock.sleep(yieldVal);
            }

          } else if (status === LUA_OK) {
            break; // coroutine returned normally

          } else {
            // Runtime error inside the coroutine
            const err = lua_tojsstring(co, -1) || "unknown error";
            console.error("[lua] clock.run coroutine error:", err);
            break;
          }
        }
      } finally {
        // Release the registry reference so the GC can collect the thread
        luaL_unref(L, LUA_REGISTRYINDEX, coRef);
      }
    });

    lua_pushnumber(L, id);
    return 1;
  });
  lua_setfield(L, -2, ls("run"));

  // clock.sync(beats) — yield until the next beat grid position
  lua_pushjsfunction(L, (L) => {
    const beats = N(L, 1, 1);
    lua_settop(L, 0);
    lua_pushstring(L, ls("sync"));
    lua_pushnumber(L, beats);
    return lua_yield(L, 2);
  });
  lua_setfield(L, -2, ls("sync"));

  // clock.sleep(secs) — yield for a fixed number of seconds
  lua_pushjsfunction(L, (L) => {
    const secs = N(L, 1, 0);
    lua_settop(L, 0);
    lua_pushstring(L, ls("sleep"));
    lua_pushnumber(L, secs);
    return lua_yield(L, 2);
  });
  lua_setfield(L, -2, ls("sleep"));

  // clock.cancel(id)
  lua_pushjsfunction(L, (L) => { clock.cancel(N(L, 1)); return 0; });
  lua_setfield(L, -2, ls("cancel"));

  // clock.get_tempo / get_beats / get_beat_sec
  lua_pushjsfunction(L, (L) => { lua_pushnumber(L, clock.get_tempo()); return 1; });
  lua_setfield(L, -2, ls("get_tempo"));
  lua_pushjsfunction(L, (L) => { lua_pushnumber(L, clock.get_beats()); return 1; });
  lua_setfield(L, -2, ls("get_beats"));
  lua_pushjsfunction(L, (L) => { lua_pushnumber(L, clock.get_beat_sec()); return 1; });
  lua_setfield(L, -2, ls("get_beat_sec"));

  // clock.internal sub-table
  lua_newtable(L);
  lua_pushjsfunction(L, (L) => { clock.internal.set_tempo(N(L, 1, 120)); return 0; });
  lua_setfield(L, -2, ls("set_tempo"));
  lua_pushjsfunction(L, (L) => { clock.internal.start(); return 0; });
  lua_setfield(L, -2, ls("start"));
  lua_pushjsfunction(L, (L) => { clock.internal.stop(); return 0; });
  lua_setfield(L, -2, ls("stop"));
  lua_setfield(L, -2, ls("internal"));

  lua_setglobal(L, ls("clock"));

  // ---------------------------------------------------------------------------
  // ── midi ────────────────────────────────────────────────────────────────────
  //
  // m = midi.connect(n)   — returns a port table
  // m.note_on / note_off / cc / etc.
  // m.event = function(data) … end   — set via __newindex metatable
  // midi.to_msg(data)     — parse raw bytes → message table

  lua_newtable(L); // midi global table

  // midi.connect(n)
  lua_pushjsfunction(L, (L) => {
    const n = N(L, 1, 1);
    const port = midi.connect(n);
    let eventRef = LUA_NOREF;

    // Port table
    lua_newtable(L);

    const portMethods = {
      note_on:          (L) => { port.note_on(N(L,1), N(L,2,127), N(L,3,1)); return 0; },
      note_off:         (L) => { port.note_off(N(L,1), N(L,2,0), N(L,3,1)); return 0; },
      cc:               (L) => { port.cc(N(L,1), N(L,2), N(L,3,1)); return 0; },
      pitchbend:        (L) => { port.pitchbend(N(L,1), N(L,2,1)); return 0; },
      channel_pressure: (L) => { port.channel_pressure(N(L,1), N(L,2,1)); return 0; },
      key_pressure:     (L) => { port.key_pressure(N(L,1), N(L,2), N(L,3,1)); return 0; },
      program_change:   (L) => { port.program_change(N(L,1), N(L,2,1)); return 0; },
      clock_msg:        (L) => { port.clock(); return 0; },
      start:            (L) => { port.start(); return 0; },
      stop:             (L) => { port.stop(); return 0; },
      continue:         (L) => { port.continue(); return 0; },
    };

    for (const [name, fn] of Object.entries(portMethods)) {
      lua_pushjsfunction(L, fn);
      lua_setfield(L, -2, ls(name));
    }

    // Metatable: __newindex intercepts `m.event = fn`
    lua_newtable(L);
    lua_pushjsfunction(L, (L) => {
      // __newindex(table, key, value)
      const key = lua_tojsstring(L, 2);
      if (key === "event" && lua_type(L, 3) === LUA_TFUNCTION) {
        // Release previous ref
        if (eventRef !== LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, eventRef);
        lua_pushvalue(L, 3);
        eventRef = luaL_ref(L, LUA_REGISTRYINDEX);

        // Wire the JS port event to call back into Lua
        port.event = (data) => {
          if (eventRef === LUA_NOREF) return;
          lua_rawgeti(L, LUA_REGISTRYINDEX, eventRef);
          if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return; }
          // Push data as a Lua array table
          lua_createtable(L, data.length, 0);
          for (let i = 0; i < data.length; i++) {
            lua_pushinteger(L, data[i]);
            lua_rawseti(L, -2, i + 1);
          }
          const status = lua_pcall(L, 1, 0, 0);
          if (status !== LUA_OK) {
            console.error("[lua] midi.event callback error:", lua_tojsstring(L, -1));
            lua_pop(L, 1);
          }
        };
      } else {
        // Any other field: store directly in the table
        lua_rawset(L, 1);
      }
      return 0;
    });
    lua_setfield(L, -2, ls("__newindex"));
    lua_setmetatable(L, -2); // set metatable on port table (port table is at -2, metatable at -1)

    return 1;
  });
  lua_setfield(L, -2, ls("connect"));

  // midi.to_msg(data) — parse raw array → message table
  lua_pushjsfunction(L, (L) => {
    // data is a Lua table; convert to JS array
    const data = [];
    let i = 1;
    while (true) {
      lua_rawgeti(L, 1, i);
      if (lua_type(L, -1) === LUA_TNIL) { lua_pop(L, 1); break; }
      data.push(lua_tonumber(L, -1));
      lua_pop(L, 1);
      i++;
    }
    const msg = midi.to_msg(data);
    if (!msg) { lua_pushnil(L); return 1; }
    lua_newtable(L);
    for (const [k, v] of Object.entries(msg)) {
      if (typeof v === "number") {
        lua_pushnumber(L, v);
      } else if (typeof v === "string") {
        lua_pushstring(L, ls(v));
      } else {
        continue;
      }
      lua_setfield(L, -2, ls(k));
    }
    return 1;
  });
  lua_setfield(L, -2, ls("to_msg"));

  lua_setglobal(L, ls("midi"));

  // ---------------------------------------------------------------------------
  // ── util ────────────────────────────────────────────────────────────────────

  lua_newtable(L);

  const utilMethods = {
    time:   (L) => { lua_pushnumber(L, performance.now() / 1000); return 1; },
    wrap:   (L) => {
      const n = N(L,1), lo = N(L,2), hi = N(L,3);
      const r = hi - lo;
      lua_pushnumber(L, lo + ((n - lo) % r + r) % r);
      return 1;
    },
    clamp:  (L) => {
      lua_pushnumber(L, Math.max(N(L,2), Math.min(N(L,3), N(L,1))));
      return 1;
    },
    linlin: (L) => {
      const n = N(L,1), l1 = N(L,2), h1 = N(L,3), l2 = N(L,4), h2 = N(L,5);
      const t = (n - l1) / (h1 - l1);
      lua_pushnumber(L, l2 + t * (h2 - l2));
      return 1;
    },
    round:  (L) => {
      const q = N(L, 2, 1) || 1;
      lua_pushnumber(L, Math.round(N(L,1) / q) * q);
      return 1;
    },
  };

  for (const [name, fn] of Object.entries(utilMethods)) {
    lua_pushjsfunction(L, fn);
    lua_setfield(L, -2, ls(name));
  }
  lua_setglobal(L, ls("util"));

  // ---------------------------------------------------------------------------
  // ── softcut ─────────────────────────────────────────────────────────────────
  //
  // softcut.enable(v, state)          softcut.play(v, state)
  // softcut.rate(v, rate)             softcut.level(v, amp)
  // softcut.pan(v, pos)               softcut.position(v, pos)
  // softcut.loop(v, state)            softcut.loop_start(v, pos)
  // softcut.loop_end(v, pos)          softcut.fade_time(v, t)
  // softcut.level_slew_time(v, t)     softcut.buffer(v, buf)
  // softcut.rec(v, state)             softcut.rec_level(v, amp)
  // softcut.pre_level(v, amp)
  // softcut.buffer_clear()            softcut.buffer_clear_channel(ch)
  // softcut.buffer_clear_region(s,d)
  // softcut.buffer_read_mono(url, start_src, start_dst, dur, ch_src, ch_dst)
  //   — async fire-and-forget; Lua continues immediately
  // softcut.phase_quant(v, q)
  // softcut.poll_start_phase()        softcut.poll_stop_phase()
  // softcut.event_phase(fn)           — fn(voice, phase) called on each phase event

  let phaseRef = LUA_NOREF;

  lua_newtable(L);

  // Voice control — all (voice, value) pairs
  const voiceMethods = [
    ["enable",           (v, s) => softcut.enable(v, s)],
    ["play",             (v, s) => softcut.play(v, s)],
    ["rate",             (v, r) => softcut.rate(v, r)],
    ["level",            (v, a) => softcut.level(v, a)],
    ["pan",              (v, p) => softcut.pan(v, p)],
    ["position",         (v, p) => softcut.position(v, p)],
    ["loop",             (v, s) => softcut.loop(v, s)],
    ["loop_start",       (v, p) => softcut.loop_start(v, p)],
    ["loop_end",         (v, p) => softcut.loop_end(v, p)],
    ["fade_time",        (v, t) => softcut.fade_time(v, t)],
    ["level_slew_time",  (v, t) => softcut.level_slew_time(v, t)],
    ["buffer",           (v, b) => softcut.buffer(v, b)],
    ["rec",              (v, s) => softcut.rec(v, s)],
    ["rec_level",        (v, a) => softcut.rec_level(v, a)],
    ["pre_level",        (v, a) => softcut.pre_level(v, a)],
    ["phase_quant",      (v, q) => softcut.phase_quant(v, q)],
  ];

  for (const [name, jsfn] of voiceMethods) {
    lua_pushjsfunction(L, (L) => { jsfn(N(L, 1), N(L, 2)); return 0; });
    lua_setfield(L, -2, ls(name));
  }

  // Buffer operations
  lua_pushjsfunction(L, (L) => { softcut.buffer_clear(); return 0; });
  lua_setfield(L, -2, ls("buffer_clear"));

  lua_pushjsfunction(L, (L) => { softcut.buffer_clear_channel(N(L, 1, 1)); return 0; });
  lua_setfield(L, -2, ls("buffer_clear_channel"));

  lua_pushjsfunction(L, (L) => { softcut.buffer_clear_region(N(L, 1), N(L, 2)); return 0; });
  lua_setfield(L, -2, ls("buffer_clear_region"));

  // buffer_read_mono(url, start_src, start_dst, dur, ch_src, ch_dst)
  // Fire-and-forget: starts the async load, returns to Lua immediately.
  lua_pushjsfunction(L, (L) => {
    const url      = S(L, 1);
    const startSrc = N(L, 2, 0);
    const startDst = N(L, 3, 0);
    const dur      = N(L, 4, -1);
    const chSrc    = N(L, 5, 1);
    const chDst    = N(L, 6, 1);
    if (!audioCtx) {
      console.warn("[lua] softcut.buffer_read_mono: no AudioContext — start audio first");
      return 0;
    }
    softcut.buffer_read_mono(url, startSrc, startDst, dur, chSrc, chDst)
      .catch((e) => console.error("[lua] softcut.buffer_read_mono error:", e));
    return 0;
  });
  lua_setfield(L, -2, ls("buffer_read_mono"));

  // Phase polling
  lua_pushjsfunction(L, (L) => { softcut.poll_start_phase(); return 0; });
  lua_setfield(L, -2, ls("poll_start_phase"));

  lua_pushjsfunction(L, (L) => { softcut.poll_stop_phase(); return 0; });
  lua_setfield(L, -2, ls("poll_stop_phase"));

  // event_phase(fn) — fn(voice, phase)
  lua_pushjsfunction(L, (L) => {
    if (lua_type(L, 1) !== LUA_TFUNCTION) return 0;
    if (phaseRef !== LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, phaseRef);
    lua_pushvalue(L, 1);
    phaseRef = luaL_ref(L, LUA_REGISTRYINDEX);

    softcut.event_phase((voice, phase) => {
      if (phaseRef === LUA_NOREF) return;
      lua_rawgeti(L, LUA_REGISTRYINDEX, phaseRef);
      if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return; }
      lua_pushnumber(L, voice);
      lua_pushnumber(L, phase);
      const status = lua_pcall(L, 2, 0, 0);
      if (status !== LUA_OK) {
        console.error("[lua] softcut.event_phase callback error:", lua_tojsstring(L, -1));
        lua_pop(L, 1);
      }
    });
    return 0;
  });
  lua_setfield(L, -2, ls("event_phase"));

  lua_setglobal(L, ls("softcut"));

  // ---------------------------------------------------------------------------
  // Parse and execute the script (defines init, redraw, key, enc globals)

  const src = ls(luaSrc);
  const loadStatus = luaL_loadstring(L, src);
  if (loadStatus !== LUA_OK) {
    const err = lua_tojsstring(L, -1);
    throw new Error(`Lua parse error: ${err}`);
  }

  const execStatus = lua_pcall(L, 0, LUA_MULTRET, 0);
  if (execStatus !== LUA_OK) {
    const err = lua_tojsstring(L, -1);
    throw new Error(`Lua runtime error: ${err}`);
  }

  // Helper: call a named Lua global with numeric args
  function callGlobal(name, ...args) {
    lua_getglobal(L, ls(name));
    if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return; }
    for (const a of args) lua_pushnumber(L, a);
    const status = lua_pcall(L, args.length, 0, 0);
    if (status !== LUA_OK) {
      console.warn(`[lua] ${name}() error:`, lua_tojsstring(L, -1));
      lua_pop(L, 1);
    }
  }

  // Call init()
  callGlobal("init");

  // redraw loop
  let _running = true;
  let _rafId = null;

  function loop() {
    if (!_running) return;
    callGlobal("redraw");
    _rafId = requestAnimationFrame(loop);
  }
  _rafId = requestAnimationFrame(loop);

  // ---------------------------------------------------------------------------
  return {
    key(n, z)  { callGlobal("key", n, z); },
    enc(n, d)  { callGlobal("enc", n, d); },
    cleanup() {
      _running = false;
      if (_rafId) cancelAnimationFrame(_rafId);
      clock.cleanup();
      midi.cleanup();
      softcut.reset();
      if (phaseRef !== LUA_NOREF) {
        luaL_unref(L, LUA_REGISTRYINDEX, phaseRef);
        phaseRef = LUA_NOREF;
      }
    },
  };
}
