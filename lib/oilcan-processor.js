// oilcan-processor — AudioWorkletProcessor
// Port of zjb-s/oilcan lib/oilcan.sc to Web Audio.
//
// Signal path (per voice):
//   pitch = freq + sweep_env * sweep_ix * 5000   (clamped 5–10000 Hz)
//   mod   = SinOscFB(pitch * mod_ratio, fb)       (feedback sine → tuned noise)
//   mod   = Fold(mod * (fold+1), -1, 1) * mod_env * mod_ix
//   car   = SinOsc(pitch + mod * 10000 * (1-routing))
//   car   = Fold(car * (fold+1), -1, 1) * car_env
//   sig   = car + mod * routing
//   sig   = Clip(sig, -headroom, headroom)
//   sig   = tanh(sig * gain) * level

// Fold x into [-1, 1]
function fold11(x) {
  let y = ((x + 1) % 4 + 4) % 4; // map to [0, 4)
  return y <= 2 ? y - 1 : 3 - y;
}

// Percussive envelope: linear attack then exponential decay.
// Returns amplitude at time t given attack length and decay length.
function percEnv(t, atk, dec) {
  if (t < 0) return 0;
  if (atk > 0.0001 && t < atk) return t / atk;
  const rt = t - atk;
  if (rt >= dec) return 0;
  return Math.exp(-5 * rt / dec); // approximates SC Env.perc curve=-4
}

class OilcanProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 4 voice slots (one per oilcan player instance)
    this.voxs = Array.from({ length: 4 }, () => ({
      active: false,
      t: 0,        // time since trigger in seconds
      phaMod: 0,   // modulator oscillator phase
      phaCar: 0,   // carrier oscillator phase
      fbSmp: 0,    // feedback sample for SinOscFB approximation
      p: null,     // synthesized params object
    }));

    this.port.onmessage = ({ data }) => {
      if (data.cmd === "trig") {
        const v = this.voxs[data.idx & 3];
        v.active = true;
        v.t = 0;
        v.phaMod = 0;
        v.phaCar = 0;
        v.fbSmp = 0;
        v.p = data.params;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const dt = 1 / sampleRate;
    const twoPi = 2 * Math.PI;

    for (let i = 0; i < L.length; i++) {
      let sum = 0;

      for (const v of this.voxs) {
        if (!v.active) continue;
        const p = v.p;
        const t = v.t;

        // Voice done when carrier envelope finishes
        if (t >= p.atk + p.car_rel) {
          v.active = false;
          continue;
        }

        // --- Envelopes ---
        const carEnv = percEnv(t, p.atk, p.car_rel);

        const modDec = p.car_rel * (p.mod_rel / 100);
        const modEnv = percEnv(t, p.atk, modDec);

        const sweepDec = p.car_rel * (p.sweep_time / 100);
        const sweepEnv = percEnv(t, p.atk, sweepDec);

        // --- Pitch with sweep ---
        const pitch = Math.max(5, Math.min(10000,
          p.freq + sweepEnv * p.sweep_ix * 5000));

        // --- Modulator: SinOscFB approximation ---
        // feedback * prevSample shifts the phase, creating tuned noise at high fb
        v.phaMod += twoPi * pitch * p.mod_ratio * dt;
        let modSig = Math.sin(v.phaMod + p.fb * v.fbSmp);
        v.fbSmp = modSig;

        // Wavefold + envelope + level
        const foldAmt = p.fold + 1;
        modSig = fold11(modSig * foldAmt) * modEnv * p.mod_ix;

        // --- Carrier: frequency-modulated by modSig ---
        v.phaCar += twoPi * (pitch + modSig * 10000 * (1 - p.routing)) * dt;
        let carSig = fold11(Math.sin(v.phaCar) * foldAmt) * carEnv;

        // --- Mix: direct carrier + mod parallel output ---
        let sig = carSig + modSig * p.routing;

        // --- Clip then soft saturate ---
        sig = Math.max(-p.headroom, Math.min(p.headroom, sig));
        sig = Math.tanh(sig * p.gain);

        sum += sig * p.level;
        v.t += dt;
      }

      L[i] = sum;
      R[i] = sum;
    }

    return true; // keep processor alive even when silent
  }
}

registerProcessor("oilcan-processor", OilcanProcessor);
