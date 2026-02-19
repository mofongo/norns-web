// amen — sampler & mangler (port of schollz/amen)
//
// MAKER MODE: record loops from mic via softcut
//   tab = switch to breaker mode
//   space = start/stop recording
//   enter = start/stop playback
//   arrows = adjust loop window
//
// BREAKER MODE: play and mangle loaded samples
//   tab = switch to maker mode
//   space = start/stop playback
//   1-8 = select effect pair
//   q/w = trigger left/right effect
//   arrow up/down = adjust tempo
//   arrow left/right = adjust loop start/end
//   l = load audio file
//
import screen from "../lib/screen.js";
import softcut from "../lib/softcut.js";
import clock from "../lib/clock.js";

// -- constants --
const VOICE = 1;
const REC_VOICES = [2, 3]; // stereo recording voices
const BUF = 1;
const REC_BUF = 2;
const DISPLAY_W = 128;

// -- effect options (matching original) --
const EFFECT_OPTIONS = [
  ["stop", "start"],
  ["reverse", "stutter"],
  ["loop", ""],
  ["half", "strobe"],
  ["scratch", "jump"],
  ["lpf", "hpf"],
  ["slow", "vinyl"],
  ["bitcrush", ""],
];

// -- state --
let audioCtx = null;
let animId = null;
let frame = 0;
let mode = "breaker"; // "maker" | "breaker"

// Audio effect nodes
let lpfNode = null;
let hpfNode = null;
let strobeGain = null;
let strobeLfo = null;
let masterGain = null;
let effectsConnected = false;

// Breaker state
let sampleBpm = 136;
let sampleDuration = 0;
let sampleBeats = 4;
let currentPos = 0; // 0..1 normalized
let loopStart = 0;
let loopEnd = 1;
let beatNum = 4;
let effectSel = 0;
let playing = false;
let sampleLoaded = false;
let sampleName = "";
let currentBeat = 0;

// Effect state
const activeEffects = {};
const effectProbs = {};
for (const pair of EFFECT_OPTIONS) {
  for (const name of pair) {
    if (name) {
      activeEffects[name] = false;
      effectProbs[name] = 0;
    }
  }
}

// Coroutine IDs
let syncCoroId = null;
let scratchCoroId = null;
let tapeStopAnimId = null;

// Current playback rate (before effects)
let baseRate = 1;
let currentRate = 1;
let disableReset = false;

// Maker state
let recording = false;
let recorded = false;
let recPhase = 0;
let makerPlaying = false;
let makerLoopPoints = [0, 0];
let makerWindow = [0, 8];
let makerBeatNum = 4;
let makerCurrentPos = [0, 0];

// Waveform data (mono for simplicity)
const waveform = new Float32Array(DISPLAY_W);
let waveformReady = false;

// Metronome tick for visual
let metroTick = false;

// File input element (hidden)
let fileInput = null;

// Show message overlay
let showMessage = null;
let showMessageTimer = null;

// Key state
const keysOn = { q: false, w: false };

// -- utility --
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

// -- waveform refresh --
function refreshWaveform() {
  if (!softcut.node) return;
  const buf = mode === "maker" ? REC_BUF : BUF;
  const start = mode === "maker" ? makerWindow[0] : 0;
  const dur = mode === "maker" ? makerWindow[1] - makerWindow[0] : sampleDuration;
  if (dur <= 0) return;
  softcut.node.port.postMessage({
    cmd: "buffer_read",
    ch: buf - 1,
    start: Math.floor(start * 48000),
    dur: dur,
  });
}

function handleWorkletMessage(origHandler) {
  return (e) => {
    const msg = e.data;
    if (msg.type === "buffer_data") {
      const data = msg.data;
      const samplesPerPixel = Math.floor(data.length / DISPLAY_W);
      if (samplesPerPixel < 1) return;
      let maxVal = 0;
      for (let i = 0; i < DISPLAY_W; i++) {
        let maxAmp = 0;
        const offset = i * samplesPerPixel;
        for (let j = 0; j < samplesPerPixel; j++) {
          const v = Math.abs(data[offset + j] || 0);
          if (v > maxAmp) maxAmp = v;
        }
        waveform[i] = maxAmp;
        if (maxAmp > maxVal) maxVal = maxAmp;
      }
      // Normalize
      if (maxVal > 0) {
        for (let i = 0; i < DISPLAY_W; i++) {
          waveform[i] /= maxVal;
        }
      }
      waveformReady = true;
    }
    if (origHandler) origHandler(e);
  };
}

// -- effect chain setup --
function setupEffectChain() {
  if (effectsConnected) return;

  // Disconnect softcut from destination
  softcut.node.disconnect();

  // Create effect nodes
  lpfNode = audioCtx.createBiquadFilter();
  lpfNode.type = "lowpass";
  lpfNode.frequency.value = 20000;
  lpfNode.Q.value = 0.7;

  hpfNode = audioCtx.createBiquadFilter();
  hpfNode.type = "highpass";
  hpfNode.frequency.value = 20;
  hpfNode.Q.value = 0.7;

  strobeGain = audioCtx.createGain();
  strobeGain.gain.value = 1;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;

  // Chain: softcut → LPF → HPF → strobe → master → destination
  softcut.node.connect(lpfNode);
  lpfNode.connect(hpfNode);
  hpfNode.connect(strobeGain);
  strobeGain.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  effectsConnected = true;
}

function teardownEffectChain() {
  if (!effectsConnected) return;
  try {
    softcut.node.disconnect();
    if (lpfNode) lpfNode.disconnect();
    if (hpfNode) hpfNode.disconnect();
    if (strobeGain) strobeGain.disconnect();
    if (masterGain) masterGain.disconnect();
    if (strobeLfo) { strobeLfo.stop(); strobeLfo.disconnect(); strobeLfo = null; }
    softcut.node.connect(audioCtx.destination);
  } catch (_) {}
  effectsConnected = false;
}

// -- sample loading --
async function loadSample(urlOrBuf, name) {
  let arrayBuf;
  if (urlOrBuf instanceof ArrayBuffer) {
    arrayBuf = urlOrBuf;
  } else {
    const resp = await fetch(urlOrBuf);
    arrayBuf = await resp.arrayBuffer();
  }

  const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
  const srcData = audioBuf.getChannelData(0);
  const srcRate = audioBuf.sampleRate;

  // Resample to 48kHz if needed
  let data;
  if (srcRate !== 48000) {
    const ratio = srcRate / 48000;
    const outLen = Math.floor(srcData.length / ratio);
    data = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const frac = srcIdx - idx0;
      const idx1 = Math.min(idx0 + 1, srcData.length - 1);
      data[i] = srcData[idx0] * (1 - frac) + srcData[idx1] * frac;
    }
  } else {
    data = new Float32Array(srcData);
  }

  sampleDuration = data.length / 48000;

  // Parse BPM from filename
  const bpmMatch = name.match(/bpm(\d+)/i);
  if (bpmMatch) {
    sampleBpm = parseInt(bpmMatch[1]);
  } else {
    sampleBpm = clock.get_tempo();
  }

  sampleBeats = Math.round(sampleDuration / (60 / sampleBpm));
  if (sampleBeats < 1) sampleBeats = 1;
  beatNum = sampleBeats;

  // Trim duration to exact beat count
  const exactDur = sampleBeats * (60 / sampleBpm);
  if (exactDur < sampleDuration) {
    sampleDuration = exactDur;
    data = data.slice(0, Math.floor(sampleDuration * 48000));
  }

  // Load into softcut buffer
  softcut.buffer_clear_channel(BUF);
  softcut.node.port.postMessage(
    { cmd: "buffer_load", ch: BUF - 1, start_dst: 0, data },
    [data.buffer]
  );

  sampleName = name;
  sampleLoaded = true;
  loopStart = 0;
  loopEnd = 1;
  currentPos = 0;
  currentBeat = 0;

  // Update rate
  baseRate = sampleBpm / clock.get_tempo();
  currentRate = baseRate;

  // Configure playback voice
  softcut.enable(VOICE, 1);
  softcut.buffer(VOICE, BUF);
  softcut.level(VOICE, 1);
  softcut.pan(VOICE, 0);
  softcut.rate(VOICE, currentRate);
  softcut.loop(VOICE, 1);
  softcut.loop_start(VOICE, 0);
  softcut.loop_end(VOICE, sampleDuration);
  softcut.position(VOICE, 0);
  softcut.fade_time(VOICE, 0.002);
  softcut.play(VOICE, 0);

  // Refresh waveform
  setTimeout(refreshWaveform, 100);

  printMessage(name.replace(/\.[^/.]+$/, ""));
}

function loadFile() {
  if (!fileInput) {
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".wav,.mp3,.ogg,.flac,.aiff,.aif";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      stopPlayback();
      await loadSample(buf, file.name);
      if (mode === "breaker") startPlayback();
      fileInput.value = "";
    });
  }
  fileInput.click();
}

// -- playback control --
function startPlayback() {
  if (!sampleLoaded) return;
  playing = true;

  // Reset effects
  resetAllEffects();

  // Update rate for current tempo
  baseRate = sampleBpm / clock.get_tempo();
  currentRate = baseRate;

  softcut.rate(VOICE, currentRate);
  softcut.loop_start(VOICE, loopStart * sampleDuration);
  softcut.loop_end(VOICE, loopEnd * sampleDuration);
  softcut.position(VOICE, loopStart * sampleDuration);
  softcut.play(VOICE, 1);

  // Start clock
  clock.internal.set_tempo(clock.get_tempo());
  clock.internal.start();

  // Sync coroutine
  syncCoroId = clock.run(async () => {
    while (true) {
      await clock.sync(1 / 8);

      // Update rate for tempo changes
      if (!disableReset) {
        baseRate = sampleBpm / clock.get_tempo();
        if (!activeEffects.half && !activeEffects.reverse && !activeEffects.slow) {
          currentRate = baseRate;
          softcut.rate(VOICE, currentRate);
        }
      }

      // Beat tracking
      if (sampleDuration > 0) {
        currentBeat = ((currentPos - loopStart) / (loopEnd - loopStart)) * beatNum;
      }

      // Metronome visual
      metroTick = !metroTick;

      // Probability-based effect triggering
      for (const [name, prob] of Object.entries(effectProbs)) {
        if (prob > 0 && prob / 100 / 8 > Math.random()) {
          triggerTimedEffect(name);
        }
      }
    }
  });
}

function stopPlayback() {
  playing = false;
  resetAllEffects();
  softcut.play(VOICE, 0);
  softcut.position(VOICE, loopStart * sampleDuration);
  if (syncCoroId !== null) {
    clock.cancel(syncCoroId);
    syncCoroId = null;
  }
  currentPos = loopStart;
}

// -- effects --
function resetAllEffects() {
  for (const name of Object.keys(activeEffects)) {
    if (activeEffects[name]) {
      deactivateEffect(name);
    }
  }
  disableReset = false;

  // Reset filters
  if (lpfNode) lpfNode.frequency.value = 20000;
  if (hpfNode) hpfNode.frequency.value = 20;
  if (strobeGain) strobeGain.gain.value = 1;
  if (masterGain) masterGain.gain.value = 1;
  if (strobeLfo) {
    strobeLfo.stop();
    strobeLfo.disconnect();
    strobeLfo = null;
  }

  // Reset rate
  currentRate = baseRate;
  if (playing) softcut.rate(VOICE, currentRate);

  // Reset loop
  if (sampleLoaded) {
    softcut.loop_start(VOICE, loopStart * sampleDuration);
    softcut.loop_end(VOICE, loopEnd * sampleDuration);
  }
}

function activateEffect(name) {
  if (activeEffects[name]) return;
  activeEffects[name] = true;

  switch (name) {
    case "reverse":
      currentRate = -Math.abs(currentRate);
      softcut.rate(VOICE, currentRate);
      break;

    case "half":
      currentRate = currentRate / 2;
      softcut.rate(VOICE, currentRate);
      break;

    case "stutter": {
      const pos = currentPos * sampleDuration;
      const sliceLen = (30 + Math.random() * 70) / 1000; // 30-100ms
      softcut.loop_start(VOICE, pos);
      softcut.loop_end(VOICE, pos + sliceLen);
      disableReset = true;
      break;
    }

    case "loop": {
      const loopBeats = 1;
      const loopDur = loopBeats * (60 / clock.get_tempo());
      const pos = currentPos * sampleDuration;
      const s = Math.max(0, pos - loopDur);
      softcut.loop_start(VOICE, s);
      softcut.loop_end(VOICE, pos + 0.001);
      disableReset = true;
      break;
    }

    case "jump": {
      const jumpPos = loopStart + Math.random() * (loopEnd - loopStart);
      softcut.position(VOICE, jumpPos * sampleDuration);
      activeEffects.jump = false; // instant effect
      break;
    }

    case "scratch":
      disableReset = true;
      scratchCoroId = clock.run(async () => {
        const bpm = clock.get_tempo();
        const period = 60 / bpm / 2;
        let phase = 0;
        while (true) {
          await clock.sleep(0.02);
          phase += 0.02 / period * Math.PI * 2;
          const scratchRate = Math.sin(phase) * Math.abs(baseRate) * 2;
          softcut.rate(VOICE, scratchRate);
        }
      });
      break;

    case "slow": // tape stop
      disableReset = true;
      if (tapeStopAnimId) cancelAnimationFrame(tapeStopAnimId);
      {
        const startRate = currentRate;
        const startTime = performance.now();
        const dur = 500; // ms
        const animate = () => {
          const elapsed = performance.now() - startTime;
          const t = clamp(elapsed / dur, 0, 1);
          const r = startRate * (1 - t);
          softcut.rate(VOICE, r);
          currentRate = r;
          if (t < 1) tapeStopAnimId = requestAnimationFrame(animate);
        };
        tapeStopAnimId = requestAnimationFrame(animate);
      }
      break;

    case "lpf":
      if (lpfNode) {
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.setValueAtTime(lpfNode.frequency.value, audioCtx.currentTime);
        lpfNode.frequency.linearRampToValueAtTime(200, audioCtx.currentTime + 0.3);
      }
      break;

    case "hpf":
      if (hpfNode) {
        hpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        hpfNode.frequency.setValueAtTime(hpfNode.frequency.value, audioCtx.currentTime);
        hpfNode.frequency.linearRampToValueAtTime(6000, audioCtx.currentTime + 0.3);
      }
      break;

    case "strobe":
      if (strobeGain && audioCtx) {
        strobeLfo = audioCtx.createOscillator();
        const strobeRate = clock.get_tempo() / 60 * 4; // 16th note rate
        strobeLfo.frequency.value = strobeRate;
        strobeLfo.type = "square";
        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = 0.5;
        strobeLfo.connect(lfoGain);
        lfoGain.connect(strobeGain.gain);
        strobeGain.gain.value = 0.5;
        strobeLfo.start();
      }
      break;

    case "vinyl":
      if (lpfNode && hpfNode && masterGain) {
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        hpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.setValueAtTime(6000, audioCtx.currentTime);
        hpfNode.frequency.setValueAtTime(600, audioCtx.currentTime);
        masterGain.gain.value = 0.6;
      }
      break;

    case "bitcrush":
      // Simulate bitcrush by adding distortion via waveshaper
      if (lpfNode) {
        // Reduce effective bandwidth as a simple approximation
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.setValueAtTime(4000, audioCtx.currentTime);
      }
      break;

    case "start":
      if (!playing) startPlayback();
      activeEffects.start = false;
      break;

    case "stop":
      if (playing) stopPlayback();
      activeEffects.stop = false;
      break;
  }
}

function deactivateEffect(name) {
  if (!activeEffects[name]) return;
  activeEffects[name] = false;

  switch (name) {
    case "reverse":
      currentRate = Math.abs(currentRate);
      softcut.rate(VOICE, currentRate);
      break;

    case "half":
      currentRate = currentRate * 2;
      softcut.rate(VOICE, currentRate);
      break;

    case "stutter":
    case "loop":
      disableReset = false;
      softcut.loop_start(VOICE, loopStart * sampleDuration);
      softcut.loop_end(VOICE, loopEnd * sampleDuration);
      break;

    case "scratch":
      disableReset = false;
      if (scratchCoroId !== null) {
        clock.cancel(scratchCoroId);
        scratchCoroId = null;
      }
      currentRate = baseRate;
      softcut.rate(VOICE, currentRate);
      break;

    case "slow":
      disableReset = false;
      if (tapeStopAnimId) {
        cancelAnimationFrame(tapeStopAnimId);
        tapeStopAnimId = null;
      }
      currentRate = baseRate;
      softcut.rate(VOICE, currentRate);
      break;

    case "lpf":
      if (lpfNode) {
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.setValueAtTime(lpfNode.frequency.value, audioCtx.currentTime);
        lpfNode.frequency.linearRampToValueAtTime(20000, audioCtx.currentTime + 0.3);
      }
      break;

    case "hpf":
      if (hpfNode) {
        hpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        hpfNode.frequency.setValueAtTime(hpfNode.frequency.value, audioCtx.currentTime);
        hpfNode.frequency.linearRampToValueAtTime(20, audioCtx.currentTime + 0.3);
      }
      break;

    case "strobe":
      if (strobeLfo) {
        strobeLfo.stop();
        strobeLfo.disconnect();
        strobeLfo = null;
      }
      if (strobeGain) strobeGain.gain.value = 1;
      break;

    case "vinyl":
      if (lpfNode && hpfNode && masterGain) {
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        hpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.linearRampToValueAtTime(20000, audioCtx.currentTime + 0.5);
        hpfNode.frequency.linearRampToValueAtTime(20, audioCtx.currentTime + 0.5);
        masterGain.gain.value = 1;
      }
      break;

    case "bitcrush":
      if (lpfNode) {
        lpfNode.frequency.cancelScheduledValues(audioCtx.currentTime);
        lpfNode.frequency.linearRampToValueAtTime(20000, audioCtx.currentTime + 0.3);
      }
      break;
  }
}

function toggleEffect(name) {
  if (!name || name === "") return;
  if (name === "start" || name === "stop" || name === "jump") {
    activateEffect(name);
  } else if (activeEffects[name]) {
    deactivateEffect(name);
  } else {
    activateEffect(name);
  }
}

function triggerTimedEffect(name) {
  if (activeEffects[name]) return;
  const durations = {
    loop: [500, 4000],
    stutter: [100, 500],
    jump: [0, 0],
    lpf: [1000, 2000],
    hpf: [1000, 2000],
    slow: [0, 700],
    scratch: [0, 3000],
    reverse: [0, 3000],
    strobe: [0, 3000],
    half: [0, 700],
    vinyl: [1000, 5000],
    bitcrush: [100, 3000],
  };
  const range = durations[name] || [500, 2000];
  const dur = range[0] + Math.random() * (range[1] - range[0]);

  activateEffect(name);
  if (dur > 0) {
    clock.run(async () => {
      await clock.sleep(dur / 1000);
      deactivateEffect(name);
    });
  }
}

// -- message overlay --
function printMessage(msg) {
  if (showMessageTimer) clearTimeout(showMessageTimer);
  showMessage = msg;
  showMessageTimer = setTimeout(() => {
    showMessage = null;
    showMessageTimer = null;
  }, 2000);
}

// -- maker mode functions --
let inputSource = null;
let inputStream = null;

async function makerRecordStart() {
  if (recording) return;

  // Request mic if needed
  if (!inputStream) {
    try {
      inputStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputSource = audioCtx.createMediaStreamSource(inputStream);
      inputSource.connect(softcut.node);
    } catch (err) {
      printMessage("mic denied");
      return;
    }
  }

  recording = true;
  const s = makerWindow[0];
  const e = makerWindow[1];

  softcut.buffer_clear_channel(REC_BUF);

  for (const v of REC_VOICES) {
    softcut.enable(v, 1);
    softcut.buffer(v, REC_BUF);
    softcut.level(v, 0);
    softcut.rate(v, 1);
    softcut.loop(v, 1);
    softcut.loop_start(v, s);
    softcut.loop_end(v, e);
    softcut.position(v, s);
    softcut.fade_time(v, 0);
    softcut.rec_level(v, 1);
    softcut.pre_level(v, 0);
    softcut.rec(v, 1);
    softcut.play(v, 1);
    softcut.phase_quant(v, 0.05);
  }
  softcut.poll_start_phase();
}

function makerRecordStop() {
  if (!recording) return;
  recording = false;
  recorded = true;
  for (const v of REC_VOICES) {
    softcut.rec(v, 0);
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
  setTimeout(refreshWaveform, 100);
}

function makerPlayStart() {
  if (recording) return;
  makerPlaying = true;
  for (const v of REC_VOICES) {
    softcut.enable(v, 1);
    softcut.buffer(v, REC_BUF);
    softcut.level(v, 1);
    softcut.rate(v, 1);
    softcut.loop(v, 1);
    softcut.loop_start(v, makerLoopPoints[0]);
    softcut.loop_end(v, makerLoopPoints[1]);
    softcut.position(v, makerLoopPoints[0]);
    softcut.fade_time(v, 0.005);
    softcut.rec(v, 0);
    softcut.play(v, 1);
    softcut.phase_quant(v, 0.05);
  }
  softcut.poll_start_phase();
}

function makerPlayStop() {
  if (!makerPlaying) return;
  makerPlaying = false;
  for (const v of REC_VOICES) {
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
}

function makerTransferToBreaker() {
  if (!recorded && !sampleLoaded) return;
  if (recording) makerRecordStop();
  if (makerPlaying) makerPlayStop();

  if (recorded) {
    // Copy recorded buffer data to playback buffer
    // We need to read the buffer data and reload it
    // For simplicity, just point playback at the recording buffer
    sampleDuration = makerLoopPoints[1] - makerLoopPoints[0];
    sampleBpm = clock.get_tempo();
    sampleBeats = makerBeatNum;
    beatNum = makerBeatNum;

    // Configure voice to play from rec buffer
    softcut.enable(VOICE, 1);
    softcut.buffer(VOICE, REC_BUF);
    softcut.level(VOICE, 1);
    softcut.pan(VOICE, 0);
    softcut.rate(VOICE, 1);
    softcut.loop(VOICE, 1);
    softcut.loop_start(VOICE, makerLoopPoints[0]);
    softcut.loop_end(VOICE, makerLoopPoints[1]);
    softcut.position(VOICE, makerLoopPoints[0]);
    softcut.fade_time(VOICE, 0.002);

    loopStart = 0;
    loopEnd = 1;
    baseRate = 1;
    currentRate = 1;
    sampleLoaded = true;
    sampleName = "recorded loop";
    recorded = false;
  }

  mode = "breaker";
  refreshWaveform();
}

// -- keyboard handler --
function onKeyDown(e) {
  if (e.repeat) return;
  const key = e.key.toLowerCase();

  if (key === "tab") {
    e.preventDefault();
    if (mode === "breaker") {
      if (playing) stopPlayback();
      mode = "maker";
      makerLoopPoints = [0, clock.get_beat_sec() * makerBeatNum];
      makerWindow = [0, clock.get_beat_sec() * makerBeatNum * 2];
      refreshWaveform();
    } else {
      makerTransferToBreaker();
    }
    return;
  }

  if (mode === "breaker") {
    if (key === " ") {
      e.preventDefault();
      if (playing) stopPlayback(); else startPlayback();
    } else if (key >= "1" && key <= "8") {
      effectSel = parseInt(key) - 1;
    } else if (key === "q") {
      keysOn.q = true;
      const name = EFFECT_OPTIONS[effectSel][0];
      toggleEffect(name);
    } else if (key === "w") {
      keysOn.w = true;
      const name = EFFECT_OPTIONS[effectSel][1];
      toggleEffect(name);
    } else if (key === "arrowup") {
      e.preventDefault();
      clock.internal.set_tempo(clamp(clock.get_tempo() + 1, 40, 300));
    } else if (key === "arrowdown") {
      e.preventDefault();
      clock.internal.set_tempo(clamp(clock.get_tempo() - 1, 40, 300));
    } else if (key === "arrowleft") {
      e.preventDefault();
      if (effectSel === 0) {
        // Adjust loop start
        loopStart = clamp(loopStart - 1 / 32, 0, loopEnd - 1 / 32);
        if (playing) softcut.loop_start(VOICE, loopStart * sampleDuration);
      }
    } else if (key === "arrowright") {
      e.preventDefault();
      if (effectSel === 0) {
        // Adjust loop end
        loopEnd = clamp(loopEnd + 1 / 32, loopStart + 1 / 32, 1);
        if (playing) softcut.loop_end(VOICE, loopEnd * sampleDuration);
      }
    } else if (key === "l") {
      loadFile();
    }
  } else {
    // Maker mode
    if (key === " ") {
      e.preventDefault();
      if (!recording) makerRecordStart(); else makerRecordStop();
    } else if (key === "enter") {
      e.preventDefault();
      if (recording) makerRecordStop();
      if (!makerPlaying) makerPlayStart(); else makerPlayStop();
    } else if (key === "arrowup") {
      e.preventDefault();
      makerBeatNum = clamp(makerBeatNum + 1, 1, 64);
      makerLoopPoints[1] = makerLoopPoints[0] + clock.get_beat_sec() * makerBeatNum;
    } else if (key === "arrowdown") {
      e.preventDefault();
      makerBeatNum = clamp(makerBeatNum - 1, 1, 64);
      makerLoopPoints[1] = makerLoopPoints[0] + clock.get_beat_sec() * makerBeatNum;
    }
  }
}

function onKeyUp(e) {
  const key = e.key.toLowerCase();
  if (key === "q") {
    keysOn.q = false;
    // Release hold effects
    const name = EFFECT_OPTIONS[effectSel][0];
    if (name === "reverse" || name === "scratch" || name === "slow" ||
        name === "lpf" || name === "hpf" || name === "stutter") {
      deactivateEffect(name);
    }
  } else if (key === "w") {
    keysOn.w = false;
    const name = EFFECT_OPTIONS[effectSel][1];
    if (name === "reverse" || name === "scratch" || name === "slow" ||
        name === "lpf" || name === "hpf" || name === "stutter") {
      deactivateEffect(name);
    }
  }
}

// -- drawing --
function boxText(x, y, s, invert) {
  const ext = screen.text_extents(s);
  const w = ext.w + 7;

  if (invert) {
    screen.level(15);
  } else {
    screen.level(0);
  }
  screen.rect_fill(x - w / 2, y, w, 10);

  if (invert) {
    screen.level(0);
  } else {
    screen.level(5);
  }
  screen.rect(x - w / 2, y, w, 10);
  screen.stroke();
  screen.move(x, y + 6);
  screen.text_center(s);

  if (invert) screen.level(15);
  return { x: x - w / 2, y, w };
}

function metroIcon(x, y) {
  screen.move(x + 2, y + 5);
  screen.line(x + 7, y);
  screen.line(x + 12, y + 5);
  screen.line(x + 3, y + 5);
  screen.stroke();
  screen.move(x + 7, y + 3);
  screen.line(metroTick ? (x + 4) : (x + 10), y);
  screen.stroke();
}

function redraw() {
  screen.clear();
  screen.level(15);
  screen.font_size(6);

  // Metronome icon
  metroIcon(-2, 3);

  // Mode-specific header
  if (mode === "breaker") {
    // Beat counter
    screen.move(12, 8);
    screen.text(`${Math.floor(currentBeat + 1)}/${beatNum}`);

    // Effect buttons
    for (let i = 0; i < 2; i++) {
      const name = EFFECT_OPTIONS[effectSel][i];
      if (name && name !== "") {
        const isActive = activeEffects[name];
        const bx = 55 + 45 * i;
        const { x: bxx, w: bw } = boxText(bx, 1, name, isActive);

        // Probability bar
        const prob = effectProbs[name] || 0;
        if (prob > 0) {
          screen.level(5);
          screen.move(bxx, 12);
          screen.line(bxx + bw * prob / 100, 12);
          screen.stroke();
        }
      }
    }
  } else {
    // Maker mode header
    screen.move(12, 8);
    screen.text(`${Math.floor(clock.get_tempo())}/${makerBeatNum} beats`);

    boxText(80, 1, "rec", recording);
    boxText(105, 1, "play", makerPlaying);
  }

  // Waveform area
  const waveH = 40;
  const waveMid = 38;

  if (waveformReady) {
    // Compute loop pixel boundaries
    let lp1, lp2;
    if (mode === "breaker") {
      lp1 = Math.round(loopStart * DISPLAY_W);
      lp2 = Math.round(loopEnd * DISPLAY_W);
    } else {
      lp1 = Math.round(((makerLoopPoints[0] - makerWindow[0]) / (makerWindow[1] - makerWindow[0])) * DISPLAY_W);
      lp2 = Math.round(((makerLoopPoints[1] - makerWindow[0]) / (makerWindow[1] - makerWindow[0])) * DISPLAY_W);
    }

    // Playhead position in pixels
    let posPixel;
    if (mode === "breaker") {
      posPixel = Math.round(currentPos * DISPLAY_W);
    } else {
      const mp = recording ? recPhase : makerCurrentPos[0];
      posPixel = Math.round(((mp - makerWindow[0]) / (makerWindow[1] - makerWindow[0])) * DISPLAY_W);
    }

    // Draw waveform
    for (let i = 0; i < DISPLAY_W; i++) {
      const amp = waveform[i];
      const h = amp * waveH / 2;

      // Dim outside loop region
      if (i < lp1 || i > lp2) {
        screen.level(4);
      } else {
        screen.level(13);
      }

      // Playhead highlight
      if (Math.abs(posPixel - i) < 2) {
        if (i === posPixel || Math.abs(posPixel - i) < 1) {
          screen.level(5);
          screen.move(i, 14);
          screen.line(i, 59);
          screen.stroke();
        }
        screen.level(15);
      }

      if (h > 0.5) {
        screen.move(i, waveMid - h);
        screen.line(i, waveMid + h);
        screen.stroke();
      }
    }

    // Loop boundary markers (maker mode)
    if (mode === "maker") {
      screen.level(15);
      screen.move(lp1, 12);
      screen.line(lp1, 60);
      screen.stroke();
      screen.move(lp2, 12);
      screen.line(lp2, 60);
      screen.stroke();
    }
  } else {
    // No waveform - show instructions
    screen.level(5);
    screen.move(64, 35);
    screen.text_center(sampleLoaded ? "loading..." : "press L to load sample");
  }

  // Bottom help text
  screen.level(3);
  screen.font_size(6);
  screen.move(1, 62);
  if (mode === "breaker") {
    screen.text("1-8:fx q/w:trig spc:play l:load tab:rec");
  } else {
    screen.text("spc:rec enter:play arrows:adj tab:break");
  }

  // Message overlay
  if (showMessage) {
    const w = showMessage.length * 5 + 10;
    screen.level(0);
    screen.rect_fill(64 - w / 2, 26, w, 12);
    screen.level(15);
    screen.rect(64 - w / 2, 26, w, 12);
    screen.stroke();
    screen.move(64, 34);
    screen.text_center(showMessage);
  }

  screen.update();
  frame++;
  animId = requestAnimationFrame(redraw);
}

// -- init --
export async function init(canvas, ctx) {
  screen.init(canvas);
  frame = 0;
  mode = "breaker";
  playing = false;
  recording = false;
  recorded = false;
  sampleLoaded = false;
  waveformReady = false;
  waveform.fill(0);
  currentPos = 0;
  effectSel = 0;

  // Reset effect state
  for (const name of Object.keys(activeEffects)) {
    activeEffects[name] = false;
    effectProbs[name] = 0;
  }

  // Create AudioContext if not provided
  audioCtx = ctx;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.resume();
  }

  // Init softcut
  await softcut.init(audioCtx);

  // Hook worklet messages for waveform data
  const origHandler = softcut.node.port.onmessage;
  softcut.node.port.onmessage = handleWorkletMessage(origHandler);

  // Phase callback
  softcut.event_phase((voice, ph) => {
    if (voice === VOICE && sampleDuration > 0) {
      currentPos = ph / sampleDuration;
    }
    for (let i = 0; i < REC_VOICES.length; i++) {
      if (voice === REC_VOICES[i]) {
        makerCurrentPos[i] = ph;
        if (i === 0) recPhase = ph;
      }
    }
  });
  softcut.phase_quant(VOICE, 0.025);
  softcut.poll_start_phase();

  // Setup effect chain
  setupEffectChain();

  // Keyboard listeners
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);

  // Start render loop
  redraw();

  // Load default amen break
  try {
    const sampleUrl = new URL("./samples/amenbreak_bpm136.wav", import.meta.url).href;
    await loadSample(sampleUrl, "amenbreak_bpm136.wav");
    startPlayback();
  } catch (err) {
    console.error("Could not load default sample:", err);
    printMessage("no default sample - press L");
  }
}

// -- cleanup --
export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  if (tapeStopAnimId) {
    cancelAnimationFrame(tapeStopAnimId);
    tapeStopAnimId = null;
  }
  if (showMessageTimer) {
    clearTimeout(showMessageTimer);
    showMessageTimer = null;
    showMessage = null;
  }

  // Stop playback
  playing = false;
  clock.cleanup();

  // Stop all softcut voices
  for (let v = 1; v <= 6; v++) {
    softcut.rec(v, 0);
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
  softcut.poll_stop_phase();

  // Teardown effect chain (reconnects softcut to destination)
  teardownEffectChain();

  // Remove keyboard listeners
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("keyup", onKeyUp);

  // Cleanup file input
  if (fileInput) {
    fileInput.remove();
    fileInput = null;
  }

  // Cleanup mic
  if (inputSource) {
    inputSource.disconnect();
    inputSource = null;
  }
  if (inputStream) {
    inputStream.getTracks().forEach((t) => t.stop());
    inputStream = null;
  }
}
