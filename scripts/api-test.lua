-- api-test.lua
-- Exercises screen, softcut, clock, and midi APIs together.
--
-- Screen:   draws a live panel — beat dots, phase arc, MIDI log, rate bar
-- Clock:    two coroutines — beat counter, rate LFO every 2 beats
-- Softcut:  loads amen break, loops it, rate modulated by clock coroutine
-- MIDI:     port 1 receives events (logged on screen); beat coroutine
--           sends note_on / note_off on each beat

local SAMPLE   = "./scripts/samples/amenbreak_bpm136.wav"
local LOOP_DUR = 4.0

-- ── state ────────────────────────────────────────────────────────────────────
local beat      = 0
local phase_pos = 0.0
local sc_rate   = 1.0
local sc_playing = true
local midi_log  = { "---", "---", "---" }  -- last 3 MIDI events
local clock_ids = {}
local m         = nil   -- midi port

-- ── helpers ──────────────────────────────────────────────────────────────────
local function midi_push(str)
  table.remove(midi_log, 1)
  table.insert(midi_log, str)
end

-- ── init ─────────────────────────────────────────────────────────────────────
function init()

  -- ── clock ──────────────────────────────────────────────────────────────────
  clock.internal.set_tempo(136)
  clock.internal.start()

  -- Coroutine 1: beat counter + MIDI note out on every beat
  clock_ids[1] = clock.run(function()
    while true do
      clock.sync(1)
      beat = beat + 1
      -- Send a short MIDI note on beat (middle C, alternating octave)
      local note = (beat % 2 == 0) and 60 or 67
      if m then
        m.note_on(note, 90, 1)
      end
      clock.sleep(0.05)
      if m then
        m.note_off(note, 0, 1)
      end
    end
  end)

  -- Coroutine 2: rate LFO — nudges softcut rate every 2 beats
  clock_ids[2] = clock.run(function()
    local dir = 1
    while true do
      clock.sync(2)
      sc_rate = sc_rate + dir * 0.12
      if sc_rate >= 1.5 then dir = -1 end
      if sc_rate <= 0.75 then dir = 1 end
      softcut.rate(1, sc_rate)
    end
  end)

  -- ── softcut ────────────────────────────────────────────────────────────────
  softcut.buffer_clear()
  softcut.buffer_read_mono(SAMPLE, 0, 0, LOOP_DUR, 1, 1)

  softcut.enable(1, 1)
  softcut.buffer(1, 1)
  softcut.level(1, 1.0)
  softcut.pan(1, 0)
  softcut.rate(1, sc_rate)
  softcut.loop(1, 1)
  softcut.loop_start(1, 0)
  softcut.loop_end(1, LOOP_DUR)
  softcut.fade_time(1, 0.005)
  softcut.position(1, 0)
  softcut.play(1, 1)

  softcut.phase_quant(1, 0.05)
  softcut.event_phase(function(voice, phase)
    if voice == 1 then
      phase_pos = phase
    end
  end)
  softcut.poll_start_phase()

  -- ── midi ───────────────────────────────────────────────────────────────────
  m = midi.connect(1)
  m.event = function(data)
    local msg = midi.to_msg(data)
    if msg == nil then return end
    if msg.type == "note_on" then
      midi_push("in note_on  " .. msg.note .. " v" .. msg.vel)
    elseif msg.type == "note_off" then
      midi_push("in note_off " .. msg.note)
    elseif msg.type == "cc" then
      midi_push("in cc " .. msg.cc .. " = " .. msg.val)
    elseif msg.type == "clock" then
      -- suppress clock floods
    else
      midi_push("in " .. msg.type)
    end
  end

end

-- ── redraw ───────────────────────────────────────────────────────────────────
function redraw()
  screen.clear()

  -- ── header ─────────────────────────────────────────────────────────────────
  screen.level(15)
  screen.font_size(8)
  screen.move(2, 7)
  screen.text("api-test.lua")

  screen.level(4)
  screen.move(0, 9)
  screen.line(128, 9)
  screen.stroke()

  -- ── clock: beat dots (top-right) ───────────────────────────────────────────
  for i = 1, 4 do
    local cx = 72 + (i - 1) * 14
    local cy = 5
    if (beat % 4) == (i - 1) then
      screen.level(15)
      screen.circle_fill(cx, cy, 3)
    else
      screen.level(5)
      screen.circle(cx, cy, 3)
      screen.stroke()
    end
  end

  -- beat + bpm label
  screen.level(8)
  screen.font_size(6)
  screen.move(72, 15)
  screen.text("b" .. beat .. " " .. math.floor(clock.get_tempo()) .. "bpm")

  -- ── softcut section ────────────────────────────────────────────────────────
  screen.level(12)
  screen.font_size(7)
  screen.move(2, 20)
  screen.text("SOFTCUT")

  -- rate bar (background)
  screen.level(3)
  screen.rect_fill(2, 22, 60, 5)
  -- rate bar (fill, normalized 0.1–2.0 → 0–60px)
  local rate_w = math.floor(((sc_rate - 0.1) / 1.9) * 60)
  screen.level(sc_playing and 12 or 5)
  if rate_w > 0 then
    screen.rect_fill(2, 22, rate_w, 5)
  end
  screen.level(8)
  screen.font_size(6)
  screen.move(64, 27)
  screen.text(string.format("rate %.2f", sc_rate))

  -- phase arc (right side)
  local arc_cx, arc_cy, arc_r = 110, 36, 12
  screen.level(4)
  screen.arc(arc_cx, arc_cy, arc_r, 0, math.pi * 2)
  screen.stroke()
  local arc_end = math.pi * 2 * (phase_pos / LOOP_DUR)
  screen.level(12)
  screen.arc(arc_cx, arc_cy, arc_r, -math.pi * 0.5, -math.pi * 0.5 + arc_end)
  screen.stroke()
  screen.level(6)
  screen.font_size(6)
  screen.move(arc_cx - 8, arc_cy + 4)
  screen.text(string.format("%.1fs", phase_pos))

  -- ── midi section ───────────────────────────────────────────────────────────
  screen.level(4)
  screen.move(0, 35)
  screen.line(128, 35)
  screen.stroke()

  screen.level(12)
  screen.font_size(7)
  screen.move(2, 43)
  screen.text("MIDI")

  screen.font_size(6)
  for i, entry in ipairs(midi_log) do
    screen.level(14 - (3 - i) * 4)
    screen.move(2, 43 + i * 7)
    screen.text(entry)
  end

  -- ── key hints ──────────────────────────────────────────────────────────────
  screen.level(4)
  screen.move(0, 62)
  screen.line(128, 62)
  screen.stroke()

  screen.level(6)
  screen.font_size(6)
  screen.move(2, 63)
  screen.text("k1:stop  k2:play  k3:reset  e1:bpm  e2:rate")

  screen.update()
end

-- ── key ───────────────────────────────────────────────────────────────────────
function key(n, z)
  if z ~= 1 then return end
  if n == 1 then
    sc_playing = false
    softcut.play(1, 0)
  elseif n == 2 then
    sc_playing = true
    softcut.position(1, 0)
    softcut.play(1, 1)
  elseif n == 3 then
    sc_rate = 1.0
    softcut.rate(1, sc_rate)
    beat = 0
  end
end

-- ── enc ───────────────────────────────────────────────────────────────────────
function enc(n, d)
  if n == 1 then
    local bpm = math.max(40, math.min(240, clock.get_tempo() + d))
    clock.internal.set_tempo(bpm)
  elseif n == 2 then
    sc_rate = math.max(0.1, math.min(3.0, sc_rate + d * 0.05))
    softcut.rate(1, sc_rate)
  end
end
