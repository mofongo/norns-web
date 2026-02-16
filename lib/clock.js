// norns-web Clock module
// Coroutine-based clock system matching the norns Lua API.
// Provides tempo-synced scheduling via clock.run() / clock.sync() / clock.sleep().
// Local-only implementation (no network Link peers).

// -- internal state --
let _tempo = 120;
let _running = false;
let _source = "internal"; // "internal" | "midi" | "link"
let _quantum = 4;
let _linkStartStopSync = false;

// Beat tracking: beats = (now - _refTime) * (_tempo / 60) + _refBeats
let _refTime = performance.now() / 1000;
let _refBeats = 0;

// Coroutine management
let _nextId = 1;
const _coroutines = new Map(); // id → { abort: AbortController, promise }

// MIDI clock output
let _midiOutPort = null;
let _midiClockCoroId = null;

// Per-coroutine signal tracking for sleep/sync cancellation.
// Set before each user function call and restored after each await.
let _currentSignal = null;

// -- timing helpers --

function _now() {
  return performance.now() / 1000;
}

function _getBeats() {
  if (!_running) return _refBeats;
  return (_now() - _refTime) * (_tempo / 60) + _refBeats;
}

function _setTempo(bpm) {
  bpm = Math.max(1, Math.min(300, bpm));
  if (bpm === _tempo) return;

  // Preserve current beat position across tempo change
  const currentBeats = _getBeats();
  _refBeats = currentBeats;
  _refTime = _now();
  _tempo = bpm;

  if (clock.tempo_change_handler) {
    clock.tempo_change_handler(_tempo);
  }
}

// High-accuracy sleep: setTimeout for the bulk, spin loop for final ~3ms
function _accurateSleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    if (seconds <= 0) {
      resolve();
      return;
    }

    const targetTime = _now() + seconds;

    if (seconds <= 0.004) {
      while (_now() < targetTime) { /* spin */ }
      resolve();
      return;
    }

    const coarseMs = Math.max(0, (seconds - 0.003) * 1000);
    const timer = setTimeout(() => {
      while (_now() < targetTime) { /* spin */ }
      resolve();
    }, coarseMs);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }
  });
}

// -- MIDI clock output --

function _startMidiClock() {
  _stopMidiClock();
  if (!_midiOutPort) return;

  _midiOutPort.start();
  _midiClockCoroId = clock.run(async () => {
    while (true) {
      await clock.sync(1 / 24);
      if (_midiOutPort) _midiOutPort.clock();
    }
  });
}

function _stopMidiClock() {
  if (_midiClockCoroId !== null) {
    clock.cancel(_midiClockCoroId);
    _midiClockCoroId = null;
  }
  if (_midiOutPort) _midiOutPort.stop();
}

// -- public API --

const clock = {
  // Start an async clock function. Returns a numeric ID.
  // Usage: clock.run(async () => { while(true) { await clock.sync(1); ... } })
  run(fn, ...args) {
    const id = _nextId++;
    const abort = new AbortController();

    const promise = (async () => {
      _currentSignal = abort.signal;
      try {
        await fn(...args);
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error(`clock.run[${id}] error:`, err);
        }
      } finally {
        _coroutines.delete(id);
      }
    })();

    _coroutines.set(id, { abort, promise });
    return id;
  },

  // Cancel a running coroutine by ID
  cancel(id) {
    const coro = _coroutines.get(id);
    if (coro) {
      coro.abort.abort();
      _coroutines.delete(id);
    }
  },

  // Sleep for `seconds`. Must be awaited inside clock.run().
  async sleep(seconds) {
    const signal = _currentSignal;
    await _accurateSleep(seconds, signal);
    // Restore signal after await so the next call in this coroutine sees it
    _currentSignal = signal;
  },

  // Sync to the next beat grid position.
  // beat=1 → every beat, beat=1/4 → every sixteenth note, etc.
  async sync(beat, offset = 0) {
    const signal = _currentSignal;

    if (!_running) {
      // If clock not running, just sleep for the beat duration
      const sleepTime = beat * (60 / _tempo);
      await _accurateSleep(sleepTime, signal);
      _currentSignal = signal;
      return;
    }

    const currentBeats = _getBeats();
    let nextBeat = Math.ceil((currentBeats - offset) / beat) * beat + offset;
    if (nextBeat <= currentBeats + 0.0001) {
      nextBeat += beat;
    }

    const beatsToWait = nextBeat - currentBeats;
    const secondsToWait = beatsToWait * (60 / _tempo);

    if (secondsToWait > 0) {
      await _accurateSleep(secondsToWait, signal);
    }
    _currentSignal = signal;
  },

  // Cancel all running coroutines
  cleanup() {
    _stopMidiClock();
    for (const [, coro] of _coroutines) {
      coro.abort.abort();
    }
    _coroutines.clear();
    clock.transport.start = null;
    clock.transport.stop = null;
    clock.tempo_change_handler = null;
  },

  // -- Tempo & beat queries --

  get_tempo() {
    return _tempo;
  },

  get_beats() {
    return _getBeats();
  },

  get_beat_sec() {
    return 60 / _tempo;
  },

  // -- Source --

  set_source(source) {
    _source = source;
  },

  get_source() {
    return _source;
  },

  // -- Transport callbacks (user-settable) --
  transport: {
    start: null,
    stop: null,
  },

  // User-settable tempo change callback
  tempo_change_handler: null,

  // -- MIDI clock output --
  get midi_out_port() {
    return _midiOutPort;
  },

  set midi_out_port(port) {
    const wasRunning = _midiClockCoroId !== null;
    _stopMidiClock();
    _midiOutPort = port;
    if (wasRunning && _running && port) {
      _startMidiClock();
    }
  },

  // -- Internal clock sub-API --
  internal: {
    set_tempo(bpm) {
      _setTempo(bpm);
    },

    start() {
      if (_running) return;
      _refTime = _now();
      _running = true;

      if (clock.transport.start) clock.transport.start();
      if (_midiOutPort) _startMidiClock();
    },

    stop() {
      if (!_running) return;
      _refBeats = _getBeats();
      _running = false;

      _stopMidiClock();
      if (clock.transport.stop) clock.transport.stop();
    },
  },

  // -- Link sub-API (local-only, norns-compatible) --
  link: {
    set_tempo(bpm) {
      _setTempo(bpm);
    },

    set_quantum(q) {
      _quantum = q;
    },

    get_quantum() {
      return _quantum;
    },

    start() {
      clock.internal.start();
    },

    stop() {
      clock.internal.stop();
    },

    get_number_of_peers() {
      return 0;
    },

    set_start_stop_sync(enabled) {
      _linkStartStopSync = !!enabled;
    },

    get_start_stop_sync() {
      return _linkStartStopSync;
    },
  },

  // -- Reset to defaults --
  reset() {
    _stopMidiClock();
    for (const [, coro] of _coroutines) {
      coro.abort.abort();
    }
    _coroutines.clear();

    _tempo = 120;
    _running = false;
    _source = "internal";
    _quantum = 4;
    _refTime = _now();
    _refBeats = 0;
    _midiOutPort = null;

    clock.transport.start = null;
    clock.transport.stop = null;
    clock.tempo_change_handler = null;
  },
};

export { clock };
export default clock;
