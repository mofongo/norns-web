// Softcut AudioWorklet Processor
// Runs in the audio rendering thread. Handles 6 voices reading/writing
// from 2 shared buffers with variable-rate playback, recording, and looping.

const NUM_VOICES = 6;
const NUM_BUFFERS = 2;
const SAMPLE_RATE = 48000;
const BUF_DURATION = 350; // seconds
const BUF_FRAMES = SAMPLE_RATE * BUF_DURATION;

class SoftcutProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Two mono buffers (~350s each)
    this.buffers = [
      new Float32Array(BUF_FRAMES),
      new Float32Array(BUF_FRAMES),
    ];

    // Voice state
    this.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      this.voices.push({
        enabled: 0,
        playing: 0,
        buffer: (i < 3) ? 0 : 1, // voices 1-3 → buf 1, 4-6 → buf 2 (norns default)
        rate: 1.0,
        level: 1.0,
        pan: 0.0, // -1 left, 0 center, 1 right
        position: 0.0, // in seconds
        phase: 0.0, // current read/write head in samples (fractional)
        loop: 0,
        loop_start: 0.0, // seconds
        loop_end: BUF_DURATION, // seconds
        fade_time: 0.01, // crossfade at loop boundaries (seconds)
        level_slew_time: 0.0,
        level_target: 1.0,
        rec: 0,
        rec_level: 1.0,
        pre_level: 0.0,
        // Phase reporting
        phase_quant: 0.0, // quantum in seconds (0 = off)
        phase_accum: 0.0, // accumulator for phase reporting
      });
    }

    this.phasePolling = false;

    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  _handleMessage(msg) {
    switch (msg.cmd) {
      case "enable":
        this.voices[msg.voice].enabled = msg.value;
        break;
      case "play":
        this.voices[msg.voice].playing = msg.value;
        break;
      case "buffer":
        this.voices[msg.voice].buffer = msg.value;
        break;
      case "rate":
        this.voices[msg.voice].rate = msg.value;
        break;
      case "level":
        this.voices[msg.voice].level_target = msg.value;
        if (this.voices[msg.voice].level_slew_time <= 0) {
          this.voices[msg.voice].level = msg.value;
        }
        break;
      case "pan":
        this.voices[msg.voice].pan = msg.value;
        break;
      case "position":
        this.voices[msg.voice].phase = msg.value * sampleRate;
        break;
      case "loop":
        this.voices[msg.voice].loop = msg.value;
        break;
      case "loop_start":
        this.voices[msg.voice].loop_start = msg.value;
        break;
      case "loop_end":
        this.voices[msg.voice].loop_end = msg.value;
        break;
      case "fade_time":
        this.voices[msg.voice].fade_time = msg.value;
        break;
      case "level_slew_time":
        this.voices[msg.voice].level_slew_time = msg.value;
        break;
      case "rec":
        this.voices[msg.voice].rec = msg.value;
        break;
      case "rec_level":
        this.voices[msg.voice].rec_level = msg.value;
        break;
      case "pre_level":
        this.voices[msg.voice].pre_level = msg.value;
        break;
      case "phase_quant":
        this.voices[msg.voice].phase_quant = msg.value;
        break;
      case "poll_start_phase":
        this.phasePolling = true;
        break;
      case "poll_stop_phase":
        this.phasePolling = false;
        break;
      case "buffer_clear":
        this.buffers[0].fill(0);
        this.buffers[1].fill(0);
        break;
      case "buffer_clear_channel":
        this.buffers[msg.ch].fill(0);
        break;
      case "buffer_clear_region": {
        const startSamp = Math.floor(msg.start * sampleRate);
        const endSamp = Math.floor((msg.start + msg.dur) * sampleRate);
        for (let b = 0; b < NUM_BUFFERS; b++) {
          for (let i = startSamp; i < endSamp && i < BUF_FRAMES; i++) {
            this.buffers[b][i] = 0;
          }
        }
        break;
      }
      case "buffer_load": {
        // msg.data: Float32Array, msg.ch: buffer index, msg.start_dst: seconds
        const dst = Math.floor(msg.start_dst * sampleRate);
        const buf = this.buffers[msg.ch];
        const len = Math.min(msg.data.length, BUF_FRAMES - dst);
        for (let i = 0; i < len; i++) {
          buf[dst + i] = msg.data[i];
        }
        break;
      }
      case "buffer_read": {
        // Read buffer data back to main thread
        const readStart = Math.floor(msg.start * sampleRate);
        const readLen = Math.floor(msg.dur * sampleRate);
        const data = this.buffers[msg.ch].slice(readStart, readStart + readLen);
        this.port.postMessage({ type: "buffer_data", ch: msg.ch, data }, [data.buffer]);
        break;
      }
      case "reset":
        this.buffers[0].fill(0);
        this.buffers[1].fill(0);
        for (let i = 0; i < NUM_VOICES; i++) {
          const v = this.voices[i];
          v.enabled = 0;
          v.playing = 0;
          v.buffer = (i < 3) ? 0 : 1;
          v.rate = 1.0;
          v.level = 1.0;
          v.level_target = 1.0;
          v.pan = 0.0;
          v.position = 0.0;
          v.phase = 0.0;
          v.loop = 0;
          v.loop_start = 0.0;
          v.loop_end = BUF_DURATION;
          v.fade_time = 0.01;
          v.level_slew_time = 0.0;
          v.rec = 0;
          v.rec_level = 1.0;
          v.pre_level = 0.0;
          v.phase_quant = 0.0;
          v.phase_accum = 0.0;
        }
        break;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]; // stereo output
    const outL = output[0];
    const outR = output[1];
    const blockSize = outL.length;

    // Get mono input (for recording)
    const input = inputs[0];
    const inMono = input && input[0] ? input[0] : null;

    for (let i = 0; i < blockSize; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    for (let v = 0; v < NUM_VOICES; v++) {
      const voice = this.voices[v];
      if (!voice.enabled) continue;

      const buf = this.buffers[voice.buffer];
      const loopStartSamp = voice.loop_start * sampleRate;
      const loopEndSamp = voice.loop_end * sampleRate;
      const loopLen = loopEndSamp - loopStartSamp;
      const fadeSamples = voice.fade_time * sampleRate;

      // Level slew
      const slewRate = voice.level_slew_time > 0
        ? 1.0 / (voice.level_slew_time * sampleRate)
        : 1.0;

      // Pan gains (equal-power)
      const panNorm = (voice.pan + 1) * 0.5; // 0..1
      const gainL = Math.cos(panNorm * Math.PI * 0.5);
      const gainR = Math.sin(panNorm * Math.PI * 0.5);

      for (let i = 0; i < blockSize; i++) {
        // Level slew
        if (voice.level !== voice.level_target) {
          const diff = voice.level_target - voice.level;
          if (Math.abs(diff) < slewRate) {
            voice.level = voice.level_target;
          } else {
            voice.level += Math.sign(diff) * slewRate;
          }
        }

        if (!voice.playing) continue;

        // Read with linear interpolation
        const phase = voice.phase;
        const idx0 = Math.floor(phase);
        const frac = phase - idx0;
        const idx1 = idx0 + 1;

        let sample = 0;
        if (idx0 >= 0 && idx1 < BUF_FRAMES) {
          sample = buf[idx0] * (1 - frac) + buf[idx1] * frac;
        } else if (idx0 >= 0 && idx0 < BUF_FRAMES) {
          sample = buf[idx0];
        }

        // Crossfade at loop boundaries
        let fadeGain = 1.0;
        if (voice.loop && fadeSamples > 0 && loopLen > 0) {
          const distFromStart = phase - loopStartSamp;
          const distFromEnd = loopEndSamp - phase;
          if (distFromStart >= 0 && distFromStart < fadeSamples) {
            fadeGain = distFromStart / fadeSamples;
          } else if (distFromEnd >= 0 && distFromEnd < fadeSamples) {
            fadeGain = distFromEnd / fadeSamples;
          }
        }

        const out = sample * voice.level * fadeGain;
        outL[i] += out * gainL;
        outR[i] += out * gainR;

        // Recording
        if (voice.rec) {
          const recIdx = Math.floor(phase);
          if (recIdx >= 0 && recIdx < BUF_FRAMES) {
            const inputSample = inMono ? inMono[i] : 0;
            buf[recIdx] = voice.rec_level * inputSample + voice.pre_level * buf[recIdx];
          }
        }

        // Advance phase
        voice.phase += voice.rate;

        // Loop / boundary handling
        if (voice.loop && loopLen > 0) {
          if (voice.rate > 0 && voice.phase >= loopEndSamp) {
            voice.phase = loopStartSamp + (voice.phase - loopEndSamp);
          } else if (voice.rate < 0 && voice.phase < loopStartSamp) {
            voice.phase = loopEndSamp - (loopStartSamp - voice.phase);
          }
        } else {
          // Non-looping: stop at boundaries
          if (voice.phase >= BUF_FRAMES || voice.phase < 0) {
            voice.playing = 0;
          }
        }

        // Phase reporting accumulator
        if (this.phasePolling && voice.phase_quant > 0) {
          voice.phase_accum += Math.abs(voice.rate);
          const quantSamples = voice.phase_quant * sampleRate;
          if (voice.phase_accum >= quantSamples) {
            voice.phase_accum -= quantSamples;
            this.port.postMessage({
              type: "phase",
              voice: v,
              phase: voice.phase / sampleRate,
            });
          }
        }
      }
    }

    return true;
  }
}

registerProcessor("softcut-processor", SoftcutProcessor);
