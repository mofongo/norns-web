// waveform — softcut recording with live waveform visualization
import screen from "../lib/screen.js";
import softcut from "../lib/softcut.js";

let animId = null;
let frame = 0;
let phase = 0;
let recording = false;

const VOICE = 1;
const BUF = 1;
const DUR = 4; // seconds
const SR = 48000;

// Waveform display buffer (downsampled for screen width)
const DISPLAY_WIDTH = 124;
const waveform = new Float32Array(DISPLAY_WIDTH);
let waveformReady = false;

function redraw() {
  screen.clear();

  // Header
  screen.level(15);
  screen.font_size(7);
  screen.move(2, 1);
  screen.text("waveform");

  screen.level(6);
  screen.font_size(6);
  screen.move(56, 1);
  screen.text(recording ? "rec" : "play");

  // Phase position
  screen.level(4);
  screen.move(86, 1);
  screen.text(`${phase.toFixed(1)}s`);

  // Waveform display area: y 12..56 (height 44), x 2..126
  const yMid = 34;
  const yRange = 20;

  // Center line
  screen.level(2);
  screen.move(2, yMid);
  screen.line(126, yMid);
  screen.stroke();

  // Draw waveform
  if (waveformReady) {
    screen.level(10);
    for (let i = 0; i < DISPLAY_WIDTH; i++) {
      const x = 2 + i;
      const amp = waveform[i];
      const h = Math.abs(amp) * yRange;
      if (h > 0.5) {
        screen.move(x, yMid - h);
        screen.line(x, yMid + h);
      }
    }
    screen.stroke();
  }

  // Playhead position indicator
  if (phase >= 0) {
    const px = 2 + Math.floor((phase / DUR) * DISPLAY_WIDTH);
    screen.level(15);
    screen.move(px, 12);
    screen.line(px, 56);
    screen.stroke();
  }

  // Bottom bar
  screen.level(5);
  screen.move(2, 58);
  screen.font_size(6);
  screen.text(`${DUR}s loop  buf:${BUF}`);

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// Request waveform data from the worklet for display
function refreshWaveform() {
  if (!softcut.node) return;

  softcut.node.port.postMessage({
    cmd: "buffer_read",
    ch: BUF - 1,
    start: 0,
    dur: DUR,
  });
}

export async function init(canvas, audioCtx) {
  screen.init(canvas);

  if (audioCtx) {
    await softcut.init(audioCtx);

    // Listen for buffer data from the worklet
    const origHandler = softcut.node.port.onmessage;
    softcut.node.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "buffer_data") {
        // Downsample to display width
        const data = msg.data;
        const samplesPerPixel = Math.floor(data.length / DISPLAY_WIDTH);
        for (let i = 0; i < DISPLAY_WIDTH; i++) {
          let maxAmp = 0;
          const start = i * samplesPerPixel;
          for (let j = 0; j < samplesPerPixel; j++) {
            const v = Math.abs(data[start + j] || 0);
            if (v > maxAmp) maxAmp = v;
          }
          waveform[i] = maxAmp;
        }
        waveformReady = true;
      }
      // Forward to original handler (for phase events etc)
      if (origHandler) origHandler(e);
    };

    // Generate a test tone: 2s of 220Hz sine + 2s of 330Hz sine
    const numSamples = SR * DUR;
    const testData = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / SR;
      const freq = t < 2 ? 220 : 330;
      const env = Math.min(1, Math.min(t, DUR - t) * 10); // fade edges
      testData[i] = Math.sin(2 * Math.PI * freq * t) * 0.6 * env;
    }

    softcut.node.port.postMessage(
      { cmd: "buffer_load", ch: BUF - 1, start_dst: 0, data: testData },
      [testData.buffer]
    );

    // Set up voice for playback
    softcut.enable(VOICE, 1);
    softcut.buffer(VOICE, BUF);
    softcut.level(VOICE, 0.7);
    softcut.pan(VOICE, 0);
    softcut.rate(VOICE, 1.0);
    softcut.loop(VOICE, 1);
    softcut.loop_start(VOICE, 0);
    softcut.loop_end(VOICE, DUR);
    softcut.fade_time(VOICE, 0.01);
    softcut.position(VOICE, 0);
    softcut.play(VOICE, 1);

    // Phase polling for playhead
    softcut.phase_quant(VOICE, 0.05);
    softcut.event_phase((v, p) => {
      if (v === VOICE) phase = p;
    });
    softcut.poll_start_phase();

    // Refresh waveform display periodically
    refreshWaveform();
    setInterval(refreshWaveform, 500);
  }

  redraw();
}

export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  for (let v = 1; v <= 6; v++) {
    softcut.rec(v, 0);
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
  softcut.poll_stop_phase();
}
