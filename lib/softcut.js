// norns-web Softcut module
// Main-thread API that manages AudioContext and communicates with the
// SoftcutProcessor AudioWorklet.

const NUM_VOICES = 6;

let audioCtx = null;
let workletNode = null;
let ready = false;

// Phase event callback: fn(voice, phase)
let _phaseCallback = null;

// Pending buffer read resolve
let _bufferReadResolve = null;

function _send(msg, transfer) {
  if (workletNode) {
    if (transfer) {
      workletNode.port.postMessage(msg, transfer);
    } else {
      workletNode.port.postMessage(msg);
    }
  }
}

function _sendVoice(cmd, voice, value) {
  _send({ cmd, voice: voice - 1, value });
}

const softcut = {
  // Initialize the audio engine. Must be called from a user gesture.
  // Returns a promise that resolves when the worklet is ready.
  async init(ctx) {
    if (ready) return;
    audioCtx = ctx || new AudioContext({ sampleRate: 48000 });

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    // Load the worklet processor
    const processorUrl = new URL("./softcut-processor.js", import.meta.url).href;
    await audioCtx.audioWorklet.addModule(processorUrl);

    workletNode = new AudioWorkletNode(audioCtx, "softcut-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    workletNode.connect(audioCtx.destination);

    // Listen for messages from the processor
    workletNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "phase" && _phaseCallback) {
        _phaseCallback(msg.voice + 1, msg.phase);
      } else if (msg.type === "buffer_data" && _bufferReadResolve) {
        _bufferReadResolve(msg);
        _bufferReadResolve = null;
      }
    };

    ready = true;
  },

  // Get the AudioContext (useful for demos)
  get context() {
    return audioCtx;
  },

  get node() {
    return workletNode;
  },

  // --- Voice control ---

  enable(voice, state) {
    _sendVoice("enable", voice, state ? 1 : 0);
  },

  buffer(voice, buf) {
    _sendVoice("buffer", voice, buf - 1); // norns buffers are 1-based
  },

  play(voice, state) {
    _sendVoice("play", voice, state ? 1 : 0);
  },

  rate(voice, rate) {
    _sendVoice("rate", voice, rate);
  },

  level(voice, amp) {
    _sendVoice("level", voice, amp);
  },

  pan(voice, pos) {
    _sendVoice("pan", voice, pos);
  },

  position(voice, pos) {
    _sendVoice("position", voice, pos);
  },

  loop(voice, state) {
    _sendVoice("loop", voice, state ? 1 : 0);
  },

  loop_start(voice, pos) {
    _sendVoice("loop_start", voice, pos);
  },

  loop_end(voice, pos) {
    _sendVoice("loop_end", voice, pos);
  },

  fade_time(voice, time) {
    _sendVoice("fade_time", voice, time);
  },

  level_slew_time(voice, time) {
    _sendVoice("level_slew_time", voice, time);
  },

  // --- Recording ---

  rec(voice, state) {
    _sendVoice("rec", voice, state ? 1 : 0);
  },

  rec_level(voice, amp) {
    _sendVoice("rec_level", voice, amp);
  },

  pre_level(voice, amp) {
    _sendVoice("pre_level", voice, amp);
  },

  // --- Buffer operations ---

  buffer_clear() {
    _send({ cmd: "buffer_clear" });
  },

  buffer_clear_channel(ch) {
    _send({ cmd: "buffer_clear_channel", ch: ch - 1 });
  },

  buffer_clear_region(start, dur) {
    _send({ cmd: "buffer_clear_region", start, dur });
  },

  // Load an audio file into a buffer.
  // file: URL string or File/Blob
  // ch_src: source channel (1-based), ch_dst: destination buffer (1-based)
  async buffer_read_mono(file, start_src = 0, start_dst = 0, dur = -1, ch_src = 1, ch_dst = 1) {
    if (!audioCtx) throw new Error("softcut not initialized");

    let arrayBuf;
    if (typeof file === "string") {
      const resp = await fetch(file);
      arrayBuf = await resp.arrayBuffer();
    } else if (file instanceof Blob) {
      arrayBuf = await file.arrayBuffer();
    } else {
      arrayBuf = file; // assume ArrayBuffer
    }

    const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
    const srcChannel = audioBuf.getChannelData(Math.min(ch_src - 1, audioBuf.numberOfChannels - 1));

    const srcStart = Math.floor(start_src * audioBuf.sampleRate);
    const srcLen = dur < 0 ? srcChannel.length - srcStart : Math.floor(dur * audioBuf.sampleRate);
    const srcSlice = srcChannel.slice(srcStart, srcStart + srcLen);

    // Resample if needed (simple linear interpolation)
    let data;
    if (audioBuf.sampleRate !== 48000) {
      const ratio = audioBuf.sampleRate / 48000;
      const outLen = Math.floor(srcSlice.length / ratio);
      data = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const idx0 = Math.floor(srcIdx);
        const frac = srcIdx - idx0;
        const idx1 = Math.min(idx0 + 1, srcSlice.length - 1);
        data[i] = srcSlice[idx0] * (1 - frac) + srcSlice[idx1] * frac;
      }
    } else {
      data = srcSlice;
    }

    _send(
      { cmd: "buffer_load", ch: ch_dst - 1, start_dst, data },
      [data.buffer]
    );
  },

  // Export buffer region as a WAV Blob download.
  async buffer_write_mono(filename, start = 0, dur = -1, ch = 1) {
    const readDur = dur < 0 ? 350 : dur;
    _send({ cmd: "buffer_read", ch: ch - 1, start, dur: readDur });

    const msg = await new Promise((resolve) => {
      _bufferReadResolve = resolve;
    });

    const samples = msg.data;
    const wavBlob = _encodeWav(samples, 48000);

    // Trigger download
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "softcut-export.wav";
    a.click();
    URL.revokeObjectURL(url);
  },

  // --- Phase polling ---

  phase_quant(voice, quantum) {
    _sendVoice("phase_quant", voice, quantum);
  },

  poll_start_phase() {
    _send({ cmd: "poll_start_phase" });
  },

  poll_stop_phase() {
    _send({ cmd: "poll_stop_phase" });
  },

  event_phase(fn) {
    _phaseCallback = fn;
  },

  // --- Reset ---

  reset() {
    _send({ cmd: "reset" });
    _phaseCallback = null;
  },
};

// Encode Float32Array samples as a 16-bit PCM WAV Blob
function _encodeWav(samples, sr) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  _writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  _writeString(view, 8, "WAVE");

  // fmt chunk
  _writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true); // sample rate
  view.setUint32(28, sr * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  _writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function _writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export { softcut };
export default softcut;
