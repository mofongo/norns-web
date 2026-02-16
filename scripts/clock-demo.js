// clock-demo — step sequencer using the clock module
//
// Demonstrates clock.run() + clock.sync() for tempo-synced sequencing.
// A 16-step pattern plays at 1/4 note resolution.
// ENC2/ENC3 mapped to tempo and step density.
//
import screen from "../lib/screen.js";
import clock from "../lib/clock.js";

// -- config --
const STEPS = 16;
const SUBDIVISION = 1 / 4; // sixteenth notes

// -- state --
let animId = null;
let seqCoroId = null;
let beatCoroId = null;
let currentStep = -1;
let beatCount = 0;
let frame = 0;

// Step pattern: 1 = active, 0 = off
const pattern = new Uint8Array(STEPS);
// Step levels for visual feedback (decays over time)
const stepLevels = new Float32Array(STEPS);

// Initialize a simple kick-like pattern
function initPattern() {
  // Classic four-on-the-floor + some hats
  const hits = [0, 4, 8, 12, 2, 6, 10, 14]; // kicks on quarters, hats on eighths
  pattern.fill(0);
  for (const h of hits) {
    pattern[h] = 1;
  }
}

// -- audio feedback --
let audioCtx = null;

function playClick(accent) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.frequency.value = accent ? 1000 : 700;
  osc.type = "square";
  gain.gain.setValueAtTime(accent ? 0.15 : 0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

  osc.start(now);
  osc.stop(now + 0.05);
}

// -- sequencer coroutine --
function startSequencer() {
  clock.internal.start();

  seqCoroId = clock.run(async () => {
    while (true) {
      await clock.sync(SUBDIVISION);
      currentStep = (currentStep + 1) % STEPS;

      if (pattern[currentStep]) {
        stepLevels[currentStep] = 1.0;
        const isDownbeat = currentStep % 4 === 0;
        playClick(isDownbeat);
      }
    }
  });

  beatCoroId = clock.run(async () => {
    while (true) {
      await clock.sync(1); // every beat
      beatCount++;
    }
  });
}

// -- drawing --
function redraw() {
  const t = frame / 60;
  screen.clear();

  // Header
  screen.level(15);
  screen.font_size(7);
  screen.move(2, 1);
  screen.text("clock-demo");

  // Tempo and beat info
  screen.level(8);
  screen.font_size(6);
  screen.move(74, 1);
  screen.text(`${clock.get_tempo()} bpm`);

  // Beat counter
  const beats = clock.get_beats();
  screen.level(6);
  screen.move(2, 10);
  screen.text(`beat: ${beats.toFixed(1)}`);

  // Transport indicator
  const blink = Math.sin(t * 4) > 0;
  screen.level(blink ? 12 : 4);
  screen.move(80, 10);
  screen.text("playing");

  // Step grid: 16 steps in 2 rows of 8
  const gridX = 4;
  const gridY = 22;
  const cellW = 14;
  const cellH = 12;
  const gap = 1;

  for (let i = 0; i < STEPS; i++) {
    const row = Math.floor(i / 8);
    const col = i % 8;
    const x = gridX + col * (cellW + gap);
    const y = gridY + row * (cellH + gap);

    // Background
    if (i === currentStep) {
      // Current step highlight
      screen.level(10);
      screen.rect_fill(x, y, cellW, cellH);
    } else if (pattern[i]) {
      // Active step
      const decay = stepLevels[i];
      screen.level(Math.max(3, Math.round(decay * 8)));
      screen.rect_fill(x, y, cellW, cellH);
    } else {
      // Inactive step
      screen.level(1);
      screen.rect_fill(x, y, cellW, cellH);
    }

    // Step number
    if (i === currentStep) {
      screen.level(0);
    } else {
      screen.level(pattern[i] ? 12 : 4);
    }
    screen.font_size(6);
    screen.move(x + 3, y + 3);
    screen.text(`${i + 1}`);
  }

  // Decay step levels
  for (let i = 0; i < STEPS; i++) {
    if (stepLevels[i] > 0) {
      stepLevels[i] = Math.max(0, stepLevels[i] - 0.03);
    }
  }

  // Beat dots at bottom - show quarter note pulse
  const quarterBeat = Math.floor(beats) % 4;
  for (let i = 0; i < 4; i++) {
    const x = 30 + i * 20;
    const y = 56;
    if (i === quarterBeat) {
      screen.level(15);
      screen.circle_fill(x, y, 3);
    } else {
      screen.level(4);
      screen.circle(x, y, 3);
      screen.stroke();
    }
  }

  // Bottom info
  screen.level(4);
  screen.font_size(6);
  screen.move(2, 62);
  screen.text("16th note seq");

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// -- init --
export async function init(canvas, ctx) {
  screen.init(canvas);
  audioCtx = ctx;
  frame = 0;
  currentStep = -1;
  beatCount = 0;
  stepLevels.fill(0);

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.resume();
  }

  initPattern();
  clock.internal.set_tempo(120);

  redraw();
  startSequencer();
}

// -- cleanup --
export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  clock.cleanup();
  currentStep = -1;
  beatCount = 0;
}
