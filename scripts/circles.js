// circles — animated overlapping circles with varying brightness
import screen from "../lib/screen.js";

let animId = null;
let frame = 0;

const NUM = 7;
const circles = [];

for (let i = 0; i < NUM; i++) {
  circles.push({
    cx: 20 + Math.random() * 88,
    cy: 10 + Math.random() * 44,
    r: 5 + Math.random() * 12,
    dx: (Math.random() - 0.5) * 0.6,
    dy: (Math.random() - 0.5) * 0.4,
    level: 3 + Math.floor(Math.random() * 12),
  });
}

function redraw() {
  screen.clear();

  // Title
  screen.level(4);
  screen.font_size(6);
  screen.move(2, 1);
  screen.text("circles");

  // Update and draw circles
  for (const c of circles) {
    c.cx += c.dx;
    c.cy += c.dy;

    // Bounce off edges
    if (c.cx - c.r < 0 || c.cx + c.r > 128) c.dx = -c.dx;
    if (c.cy - c.r < 0 || c.cy + c.r > 64) c.dy = -c.dy;

    // Pulsing brightness
    const l = Math.round(c.level + Math.sin(frame * 0.03 + c.cx) * 3);
    screen.level(Math.max(1, Math.min(15, l)));
    screen.circle(c.cx, c.cy, c.r);
    screen.stroke();

    // Inner filled circle
    screen.level(Math.max(1, Math.min(15, Math.round(l * 0.4))));
    screen.circle_fill(c.cx, c.cy, c.r * 0.4);
  }

  // Connecting lines between nearby circles
  screen.level(2);
  for (let i = 0; i < NUM; i++) {
    for (let j = i + 1; j < NUM; j++) {
      const a = circles[i], b = circles[j];
      const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (dist < 40) {
        screen.move(a.cx, a.cy);
        screen.line(b.cx, b.cy);
      }
    }
  }
  screen.stroke();

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

export function init(canvas) {
  screen.init(canvas);
  frame = 0;
  redraw();
}

export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
}
