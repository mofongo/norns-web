-- hello.lua — minimal norns-web Lua script example
-- Demonstrates the screen API and redraw lifecycle.

local x = 64
local y = 32
local t = 0

function init()
  clock.internal.set_tempo(120)
  clock.internal.start()

  -- pulse x position every beat using clock.metro
  clock.metro(1, function()
    x = x + 2
    if x > 120 then x = 8 end
  end)
end

function redraw()
  t = t + 0.02

  screen.clear()
  screen.level(15)

  -- bouncing circle
  local cx = x
  local cy = 32 + math.floor(math.sin(t) * 12)
  screen.circle_fill(cx, cy, 4)

  -- label
  screen.level(10)
  screen.move(2, 2)
  screen.font_size(8)
  screen.text("hello.lua")

  screen.update()
end

function key(n, z)
  if n == 3 and z == 1 then
    x = 64
  end
end

function enc(n, d)
  if n == 1 then
    t = t + d * 0.1
  end
end
