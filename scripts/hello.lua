-- hello.lua — minimal norns-web Lua script
-- Demonstrates idiomatic clock.run / clock.sync coroutine pattern.

local beat = 0
local x = 8

function init()
  clock.internal.set_tempo(120)
  clock.internal.start()

  -- Idiomatic norns pattern: coroutine with while/sync loop
  clock.run(function()
    while true do
      clock.sync(1)          -- suspend here until the next beat
      beat = beat + 1
      x = 8 + (beat % 10) * 12
    end
  end)
end

function redraw()
  screen.clear()
  screen.level(15)

  -- moving circle tracks the beat
  screen.circle_fill(x, 32, 5)

  -- beat counter
  screen.level(10)
  screen.move(2, 2)
  screen.font_size(8)
  screen.text("beat: " .. beat)

  screen.update()
end

function key(n, z)
  if n == 3 and z == 1 then
    beat = 0
    x = 8
  end
end

function enc(n, d)
  if n == 1 then
    local bpm = math.max(20, math.min(300, clock.get_tempo() + d))
    clock.internal.set_tempo(bpm)
  end
end
