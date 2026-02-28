// norns-web demo script
// Demonstrates MIDI routing, Softcut playback/recording, and Screen drawing

import midi from "../lib/midi.js";
import softcut from "../lib/softcut.js";

let _screenAnimId = null;

const log = (msg) => {
  const el = document.getElementById("log");
  if (el) {
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }
  console.log(msg);
};

// --- MIDI Demo ---

export function runMidiDemo() {
  log("=== MIDI Demo ===");

  // Create two virtual ports
  const port1 = midi.connect(1);
  const port2 = midi.connect(2);

  // Wire port1 output → port2 input
  port1.wire(port2);

  // Set up a listener on port2
  port2.event = (data) => {
    const msg = midi.to_msg(data);
    log(`port2 received: ${JSON.stringify(msg)}`);

    // Round-trip test: serialize back to bytes
    const bytes = midi.to_data(msg);
    log(`  re-serialized: [${bytes.join(", ")}]`);
  };

  // Send some messages from port1
  log("Sending note_on C4 vel=100 ch=1...");
  port1.note_on(60, 100, 1);

  log("Sending cc 74 val=64 ch=1...");
  port1.cc(74, 64, 1);

  log("Sending pitchbend 1000 ch=1...");
  port1.pitchbend(1000, 1);

  log("Sending program_change 5 ch=2...");
  port1.program_change(5, 2);

  log("Sending clock...");
  port1.clock();

  log("Sending note_off C4 ch=1...");
  port1.note_off(60, 0, 1);

  log("");
}

// --- Softcut Demo ---

export async function runSoftcutDemo(audioCtx) {
  log("=== Softcut Demo ===");

  await softcut.init(audioCtx);
  log("Softcut initialized (sample rate: 48000)");

  // Generate a simple sine tone and write it into buffer 1
  log("Writing 2s sine tone (440Hz) into buffer 1...");
  const sr = 48000;
  const dur = 2.0;
  const numSamples = sr * dur;
  const sineData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    sineData[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
  }

  // Load directly into the worklet buffer
  softcut.node.port.postMessage(
    { cmd: "buffer_load", ch: 0, start_dst: 0, data: sineData },
    [sineData.buffer]
  );

  // Configure voice 1: play the sine loop
  softcut.enable(1, 1);
  softcut.buffer(1, 1);
  softcut.level(1, 0.8);
  softcut.pan(1, 0);
  softcut.rate(1, 1.0);
  softcut.loop(1, 1);
  softcut.loop_start(1, 0);
  softcut.loop_end(1, 2.0);
  softcut.fade_time(1, 0.01);
  softcut.position(1, 0);
  softcut.play(1, 1);
  log("Voice 1: playing 440Hz loop at rate 1.0");

  // Phase polling
  softcut.phase_quant(1, 0.25);
  softcut.event_phase((voice, phase) => {
    const el = document.getElementById("phase");
    if (el) el.textContent = `Voice ${voice} phase: ${phase.toFixed(3)}s`;
  });
  softcut.poll_start_phase();
  log("Phase polling started (quantum: 0.25s)");

  // After 3s, change rate to 0.5
  setTimeout(() => {
    softcut.rate(1, 0.5);
    log("Voice 1: rate changed to 0.5 (half speed)");
  }, 3000);

  // After 6s, start voice 2 at a different rate
  setTimeout(() => {
    // Copy same buffer data for voice 2
    softcut.enable(2, 1);
    softcut.buffer(2, 1);
    softcut.level(2, 0.4);
    softcut.pan(2, 0.5);
    softcut.rate(2, 1.5);
    softcut.loop(2, 1);
    softcut.loop_start(2, 0);
    softcut.loop_end(2, 2.0);
    softcut.position(2, 0);
    softcut.play(2, 1);
    log("Voice 2: playing same buffer at rate 1.5, panned right");
  }, 6000);

  log("Demo running — listen for audio output");
  log("  3s: rate drops to 0.5");
  log("  6s: voice 2 joins at rate 1.5, panned right");
}

// --- Recording Demo ---

export function runRecordingDemo() {
  log("");
  log("=== Recording Demo ===");

  // Set up voice 3 for recording from input
  softcut.enable(3, 1);
  softcut.buffer(3, 2); // use buffer 2
  softcut.level(3, 0.8);
  softcut.rate(3, 1.0);
  softcut.loop(3, 1);
  softcut.loop_start(3, 0);
  softcut.loop_end(3, 4.0);
  softcut.position(3, 0);
  softcut.rec(3, 1);
  softcut.rec_level(3, 1.0);
  softcut.pre_level(3, 0.5); // overdub: keep 50% of previous
  softcut.play(3, 1);
  log("Voice 3: recording to buffer 2 (4s loop, overdub mode)");
  log("Connect a microphone to hear recording + playback");
}

// --- Screen Demo ---

export function runScreenDemo(screen) {
  stopScreenDemo();

  let frame = 0;

  function redraw() {
    const t = frame / 60;
    screen.clear();

    // Title text
    screen.level(15);
    screen.font_size(16);
    screen.move(4, 4);
    screen.text("norns-web screen");

    // Subtitle
    screen.level(6);
    screen.font_size(14);
    screen.move(4, 24);
    screen.text("256x128  16 levels");

    // Brightness gradient bar
    for (let i = 0; i <= 15; i++) {
      screen.level(i);
      screen.rect_fill(4 + i * 14, 44, 12, 8);
    }

    // Animated circle
    const cx = 200;
    const cy = 88;
    const r = 16 + Math.sin(t * 2) * 8;
    screen.level(12);
    screen.circle(cx, cy, r);
    screen.stroke();

    // Filled circle orbiting
    const ox = cx + Math.cos(t * 3) * 28;
    const oy = cy + Math.sin(t * 3) * 28;
    screen.level(15);
    screen.circle_fill(ox, oy, 6);

    // Animated rectangle
    const rw = 40 + Math.sin(t * 1.5) * 16;
    screen.level(8);
    screen.rect(8, 60, rw, 20);
    screen.stroke();

    // Bezier curve
    screen.level(10);
    screen.move(8, 100);
    const wave = Math.sin(t * 2) * 20;
    screen.curve(60, 100 + wave, 120, 100 - wave, 180, 100);
    screen.stroke();

    // Pixel scatter
    screen.level(15);
    for (let i = 0; i < 8; i++) {
      const px = 60 + Math.sin(t * 2 + i * 0.8) * 40;
      const py = 76 + Math.cos(t * 1.7 + i * 1.1) * 16;
      screen.pixel(Math.round(px), Math.round(py));
    }

    // Arc
    screen.level(7);
    screen.move(112, 72);
    screen.arc(112, 72, 16, t % (2 * Math.PI), (t + 2) % (2 * Math.PI));
    screen.stroke();

    // Line pattern
    screen.level(4);
    for (let i = 0; i < 5; i++) {
      const y = 112 + Math.sin(t + i * 0.5) * 6;
      screen.move(8 + i * 32, y);
      screen.line(28 + i * 32, 120 - Math.sin(t + i * 0.3) * 6);
    }
    screen.stroke();

    // Right-aligned text
    screen.level(10);
    screen.font_size(14);
    screen.move(252, 112);
    screen.text_right(`f:${frame}`);

    screen.update();
    frame++;
    _screenAnimId = requestAnimationFrame(redraw);
  }

  redraw();
}

export function stopScreenDemo() {
  if (_screenAnimId !== null) {
    cancelAnimationFrame(_screenAnimId);
    _screenAnimId = null;
  }
}
