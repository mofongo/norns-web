-- softcut-demo.lua — norns-web Lua softcut example
-- Loads a sample, loops it, and modulates rate with enc 1.
-- Requires: start audio before running this script.

local VOICE = 1
local SAMPLE = "./scripts/samples/amenbreak_bpm136.wav"
local LOOP_DUR = 4.0  -- seconds
local rate = 1.0
local phase_pos = 0.0

function init()
  clock.internal.set_tempo(136)
  clock.internal.start()

  -- Load the sample into buffer 1
  softcut.buffer_clear()
  softcut.buffer_read_mono(SAMPLE, 0, 0, LOOP_DUR, 1, 1)

  -- Configure voice 1
  softcut.enable(VOICE, 1)
  softcut.buffer(VOICE, 1)
  softcut.level(VOICE, 1.0)
  softcut.pan(VOICE, 0)
  softcut.rate(VOICE, rate)
  softcut.loop(VOICE, 1)
  softcut.loop_start(VOICE, 0)
  softcut.loop_end(VOICE, LOOP_DUR)
  softcut.fade_time(VOICE, 0.005)
  softcut.position(VOICE, 0)
  softcut.play(VOICE, 1)

  -- Phase tracking for the waveform position indicator
  softcut.phase_quant(VOICE, 0.05)
  softcut.event_phase(function(voice, phase)
    if voice == VOICE then
      phase_pos = phase
    end
  end)
  softcut.poll_start_phase()
end

function redraw()
  screen.clear()
  screen.level(15)

  -- Title
  screen.move(2, 8)
  screen.font_size(8)
  screen.text("softcut-demo.lua")

  -- Rate display
  screen.level(10)
  screen.move(2, 22)
  screen.text("rate: " .. string.format("%.2f", rate))

  -- Phase bar
  screen.level(6)
  screen.rect(2, 40, 124, 8)
  screen.stroke()
  local bar_w = math.floor((phase_pos / LOOP_DUR) * 124)
  screen.level(15)
  screen.rect_fill(2, 40, bar_w, 8)

  screen.level(8)
  screen.move(2, 58)
  screen.text("enc1: rate  key3: reset")

  screen.update()
end

function enc(n, d)
  if n == 1 then
    rate = math.max(0.1, math.min(4.0, rate + d * 0.05))
    softcut.rate(VOICE, rate)
  end
end

function key(n, z)
  if n == 3 and z == 1 then
    rate = 1.0
    softcut.rate(VOICE, rate)
    softcut.position(VOICE, 0)
  end
end
