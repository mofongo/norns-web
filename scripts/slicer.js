// slicer — record into buffer, display waveform, play random slices
//
// Flow:
//   1. Requests mic input and records for REC_DUR seconds
//   2. Shows the recorded waveform
//   3. Plays random slices using 3 voices, retriggering on a timer
//
import screen from "../lib/screen.js";
import softcut from "../lib/softcut.js";

// -- config --
const BUF = 1;
const REC_VOICE = 1;
const PLAY_VOICES = [2, 3, 4]; // 3 voices for random slices
const REC_DUR = 6; // seconds to record
const MIN_SLICE = 0.15; // minimum slice length
const MAX_SLICE = 1.2; // maximum slice length
const RETRIGGER_MS = 300; // ms between new random slices
const DISPLAY_WIDTH = 124;

// -- state --
let animId = null;
let waveformRefreshId = null;
let retrigId = null;
let recTimeoutId = null;
let inputSource = null;
let inputStream = null;
let state = "waiting"; // waiting | recording | playing | error
let statusMsg = "";
let recPhase = 0;
let frame = 0;

const waveform = new Float32Array(DISPLAY_WIDTH);
let waveformReady = false;

// Per-voice playback state
const slices = PLAY_VOICES.map(() => ({
  start: 0,
  end: 0,
  phase: 0,
  active: false,
  level: 0.7,
}));

// -- waveform refresh --
function refreshWaveform() {
  if (!softcut.node) return;
  softcut.node.port.postMessage({
    cmd: "buffer_read",
    ch: BUF - 1,
    start: 0,
    dur: REC_DUR,
  });
}

function handleWorkletMessage(origHandler) {
  return (e) => {
    const msg = e.data;
    if (msg.type === "buffer_data") {
      const data = msg.data;
      const samplesPerPixel = Math.floor(data.length / DISPLAY_WIDTH);
      for (let i = 0; i < DISPLAY_WIDTH; i++) {
        let maxAmp = 0;
        const offset = i * samplesPerPixel;
        for (let j = 0; j < samplesPerPixel; j++) {
          const v = Math.abs(data[offset + j] || 0);
          if (v > maxAmp) maxAmp = v;
        }
        waveform[i] = maxAmp;
      }
      waveformReady = true;
    }
    if (origHandler) origHandler(e);
  };
}

// -- random slice triggering --
function triggerRandomSlice() {
  // Pick a random voice
  const idx = Math.floor(Math.random() * PLAY_VOICES.length);
  const voice = PLAY_VOICES[idx];
  const s = slices[idx];

  const sliceLen = MIN_SLICE + Math.random() * (MAX_SLICE - MIN_SLICE);
  const maxStart = Math.max(0, REC_DUR - sliceLen);
  const start = Math.random() * maxStart;
  const end = start + sliceLen;

  // Random rate variation: 0.5x to 2x
  const rate = 0.5 + Math.random() * 1.5;
  // Random pan
  const pan = (Math.random() - 0.5) * 1.6;
  // Random level
  const level = 0.4 + Math.random() * 0.5;

  s.start = start;
  s.end = end;
  s.active = true;
  s.level = level;

  softcut.loop_start(voice, start);
  softcut.loop_end(voice, end);
  softcut.position(voice, start);
  softcut.rate(voice, rate);
  softcut.level(voice, level);
  softcut.pan(voice, pan);
  softcut.play(voice, 1);
}

function startSlicing() {
  // Set up playback voices
  for (let i = 0; i < PLAY_VOICES.length; i++) {
    const v = PLAY_VOICES[i];
    softcut.enable(v, 1);
    softcut.buffer(v, BUF);
    softcut.loop(v, 1);
    softcut.fade_time(v, 0.01);
    softcut.level(v, 0);
    softcut.play(v, 0);
  }

  // Phase polling for all play voices
  for (const v of PLAY_VOICES) {
    softcut.phase_quant(v, 0.04);
  }

  // Retrigger loop
  triggerRandomSlice();
  retrigId = setInterval(() => {
    triggerRandomSlice();
  }, RETRIGGER_MS);
}

// -- drawing --
function redraw() {
  const t = frame / 60;
  screen.clear();

  // Header
  screen.level(15);
  screen.font_size(7);
  screen.move(2, 1);
  screen.text("slicer");

  // State indicator
  if (state === "recording") {
    const blink = Math.sin(t * 6) > 0;
    screen.level(blink ? 15 : 4);
    screen.font_size(6);
    screen.move(46, 2);
    screen.text(`rec ${recPhase.toFixed(1)}s / ${REC_DUR}s`);

    // Recording progress bar
    screen.level(4);
    screen.rect(2, 10, DISPLAY_WIDTH, 3);
    screen.stroke();
    screen.level(12);
    const prog = Math.min(1, recPhase / REC_DUR);
    screen.rect_fill(2, 10, Math.floor(prog * DISPLAY_WIDTH), 3);
  } else if (state === "playing") {
    screen.level(8);
    screen.font_size(6);
    screen.move(46, 2);
    screen.text("playing");
  } else if (state === "error") {
    screen.level(12);
    screen.font_size(6);
    screen.move(2, 2);
    screen.text(statusMsg);
  } else {
    screen.level(5);
    screen.font_size(6);
    screen.move(46, 2);
    screen.text(statusMsg || "starting...");
  }

  // Waveform area: y 16..54
  const yMid = 35;
  const yRange = 17;

  // Center line
  screen.level(2);
  screen.move(2, yMid);
  screen.line(126, yMid);
  screen.stroke();

  // Draw waveform
  if (waveformReady) {
    screen.level(6);
    for (let i = 0; i < DISPLAY_WIDTH; i++) {
      const x = 2 + i;
      const amp = waveform[i];
      const h = amp * yRange;
      if (h > 0.5) {
        screen.move(x, yMid - h);
        screen.line(x, yMid + h);
      }
    }
    screen.stroke();

    // Draw active slice regions
    if (state === "playing") {
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        if (!s.active) continue;
        const x1 = 2 + Math.floor((s.start / REC_DUR) * DISPLAY_WIDTH);
        const x2 = 2 + Math.floor((s.end / REC_DUR) * DISPLAY_WIDTH);

        // Slice highlight
        screen.level(3);
        screen.rect_fill(x1, yMid - yRange, x2 - x1, yRange * 2);

        // Brighter waveform in slice region
        screen.level(13);
        for (let j = x1; j < x2 && j < 126; j++) {
          const wi = j - 2;
          if (wi >= 0 && wi < DISPLAY_WIDTH) {
            const amp = waveform[wi];
            const h = amp * yRange;
            if (h > 0.5) {
              screen.move(j, yMid - h);
              screen.line(j, yMid + h);
            }
          }
        }
        screen.stroke();

        // Playhead
        const px = 2 + Math.floor((s.phase / REC_DUR) * DISPLAY_WIDTH);
        screen.level(15);
        screen.move(px, yMid - yRange);
        screen.line(px, yMid + yRange);
        screen.stroke();
      }
    }
  }

  // Recording playhead
  if (state === "recording") {
    const px = 2 + Math.floor((recPhase / REC_DUR) * DISPLAY_WIDTH);
    screen.level(15);
    screen.move(px, yMid - yRange);
    screen.line(px, yMid + yRange);
    screen.stroke();
  }

  // Bottom info
  screen.level(4);
  screen.font_size(6);
  screen.move(2, 58);
  if (state === "playing") {
    screen.text(`${PLAY_VOICES.length} voices  ${MIN_SLICE}-${MAX_SLICE}s slices`);
  } else {
    screen.text(`buf:${BUF}  ${REC_DUR}s`);
  }

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// -- init --
export async function init(canvas, audioCtx) {
  screen.init(canvas);
  state = "waiting";
  statusMsg = "starting...";
  frame = 0;
  recPhase = 0;
  waveformReady = false;
  waveform.fill(0);
  for (const s of slices) { s.active = false; s.phase = 0; }

  redraw();

  // Create AudioContext if not provided
  if (!audioCtx) {
    statusMsg = "creating audio...";
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.resume();
  }

  statusMsg = "loading engine...";
  await softcut.init(audioCtx);

  // Hook worklet messages for waveform data
  const origHandler = softcut.node.port.onmessage;
  softcut.node.port.onmessage = handleWorkletMessage(origHandler);

  // Phase callback
  softcut.event_phase((voice, ph) => {
    if (voice === REC_VOICE) {
      recPhase = ph;
    }
    for (let i = 0; i < PLAY_VOICES.length; i++) {
      if (voice === PLAY_VOICES[i]) {
        slices[i].phase = ph;
      }
    }
  });

  // Request mic
  statusMsg = "requesting mic...";
  try {
    inputStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    inputSource = audioCtx.createMediaStreamSource(inputStream);
    inputSource.connect(softcut.node);
  } catch (err) {
    state = "error";
    statusMsg = "mic denied - allow mic access and retry";
    console.error("Mic access denied:", err);
    return;
  }

  // Clear buffer and start recording
  softcut.buffer_clear_channel(BUF);

  softcut.enable(REC_VOICE, 1);
  softcut.buffer(REC_VOICE, BUF);
  softcut.level(REC_VOICE, 0); // mute playback while recording
  softcut.rate(REC_VOICE, 1.0);
  softcut.loop(REC_VOICE, 0); // no loop — record once
  softcut.position(REC_VOICE, 0);
  softcut.fade_time(REC_VOICE, 0.005);
  softcut.rec_level(REC_VOICE, 1.0);
  softcut.pre_level(REC_VOICE, 0);
  softcut.rec(REC_VOICE, 1);
  softcut.play(REC_VOICE, 1);
  softcut.phase_quant(REC_VOICE, 0.05);
  softcut.poll_start_phase();
  state = "recording";

  // Refresh waveform while recording
  waveformRefreshId = setInterval(refreshWaveform, 250);

  // After REC_DUR, stop recording and start slicing
  recTimeoutId = setTimeout(() => {
    // Stop recording
    softcut.rec(REC_VOICE, 0);
    softcut.play(REC_VOICE, 0);
    softcut.enable(REC_VOICE, 0);

    state = "playing";
    refreshWaveform();

    // Start random slice playback
    startSlicing();
    softcut.poll_start_phase();
  }, REC_DUR * 1000 + 200); // small buffer for safety
}

// -- cleanup --
export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  if (retrigId !== null) {
    clearInterval(retrigId);
    retrigId = null;
  }
  if (recTimeoutId !== null) {
    clearTimeout(recTimeoutId);
    recTimeoutId = null;
  }
  if (waveformRefreshId !== null) {
    clearInterval(waveformRefreshId);
    waveformRefreshId = null;
  }
  if (inputSource) {
    inputSource.disconnect();
    inputSource = null;
  }
  if (inputStream) {
    inputStream.getTracks().forEach((t) => t.stop());
    inputStream = null;
  }
  for (let v = 1; v <= 6; v++) {
    softcut.rec(v, 0);
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
  softcut.poll_stop_phase();
  state = "waiting";
}
