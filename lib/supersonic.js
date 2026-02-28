// norns-web SuperSonic wrapper
// Boots scsynth (the SuperCollider audio server) compiled to WebAssembly,
// running inside a browser AudioWorklet via the supersonic-scsynth package.
// https://github.com/samaaron/supersonic
//
// Only scsynth runs here — not sclang. SynthDefs must be pre-compiled to
// binary .scsyndef files offline and loaded via loadSynthDef().
// The 128 Sonic Pi built-in synthdefs are available by name from the CDN.
//
// Usage:
//   import supersonic from '../lib/supersonic.js';
//   await supersonic.init();
//   await supersonic.loadSynthDef('sonic-pi-prophet');
//   const id = supersonic.nextNodeId();
//   supersonic.send('/s_new', 'sonic-pi-prophet', id, 0, 0, 'note', 60, 'amp', 0.7);

// CDN URLs — all four supersonic-scsynth packages on unpkg
const PKG     = "https://unpkg.com/supersonic-scsynth@latest";
const CORE    = "https://unpkg.com/supersonic-scsynth-core@latest";
const DEFS    = "https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/";
const SAMPLES = "https://unpkg.com/supersonic-scsynth-samples@latest/samples/";

let _sonic       = null;
let _ready       = false;
let _initPromise = null;
let _nodeCounter = 1000;

const supersonic = {
  get ready() { return _ready; },

  // Boot scsynth. Must be called after a user gesture (AudioContext policy).
  // Safe to call multiple times — returns the same promise if already starting.
  async init() {
    if (_ready) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      // Dynamically import SuperSonic from CDN so the lib itself has no
      // hard dependency — the CDN fetch only happens when init() is called.
      const { SuperSonic } = await import(/* @vite-ignore */ PKG);

      _sonic = new SuperSonic({
        baseURL:       `${PKG}/dist/`,
        coreBaseURL:   `${CORE}/`,
        synthdefBaseURL: DEFS,
        sampleBaseURL:   SAMPLES,
      });

      await _sonic.init();
      _ready = true;
    })();

    return _initPromise;
  },

  // Destroy / tear down the engine.
  async destroy() {
    if (_sonic && typeof _sonic.destroy === "function") {
      await _sonic.destroy();
    }
    _sonic       = null;
    _ready       = false;
    _initPromise = null;
  },

  // Allocate a unique node ID.
  nextNodeId() {
    return _nodeCounter++;
  },

  // Load a SynthDef. `source` can be:
  //   string  — name of a Sonic Pi built-in synthdef (e.g. 'sonic-pi-prophet')
  //   URL     — URL to a .scsyndef file
  //   Uint8Array / ArrayBuffer — raw compiled .scsyndef bytes
  async loadSynthDef(source) {
    _assertReady();
    return _sonic.loadSynthDef(source);
  },

  // Load an audio sample into a buffer slot.
  //   bufnum  — integer buffer number
  //   source  — URL string, File, or ArrayBuffer
  async loadSample(bufnum, source) {
    _assertReady();
    return _sonic.loadSample(bufnum, source);
  },

  // Send an OSC message to scsynth.
  // e.g. send('/s_new', 'sonic-pi-prophet', 1001, 0, 0, 'note', 60, 'amp', 0.7)
  send(address, ...args) {
    _assertReady();
    _sonic.send(address, ...args);
  },

  // Await scsynth processing all pending commands (returns a promise).
  async sync() {
    _assertReady();
    return _sonic.sync();
  },

  // Register for incoming OSC messages from scsynth.
  // event: 'in'  callback: (address, ...args) => {}
  on(event, callback) {
    _assertReady();
    _sonic.on(event, callback);
  },

  // Convenience: spawn a new synth node. Returns the node ID.
  // params is a flat {key: value, ...} object.
  newNode(synthName, params = {}) {
    _assertReady();
    const id = this.nextNodeId();
    const args = ["/s_new", synthName, id, 0, 0];
    for (const [k, v] of Object.entries(params)) args.push(k, v);
    _sonic.send(...args);
    return id;
  },

  // Convenience: update params on a running node.
  setNode(nodeId, params) {
    _assertReady();
    const args = ["/n_set", nodeId];
    for (const [k, v] of Object.entries(params)) args.push(k, v);
    _sonic.send(...args);
  },

  // Convenience: free a node immediately.
  freeNode(nodeId) {
    _assertReady();
    _sonic.send("/n_free", nodeId);
  },

  // Convenience: free all nodes in the default group.
  freeAll() {
    _assertReady();
    _sonic.send("/g_freeAll", 0);
  },
};

function _assertReady() {
  if (!_ready) throw new Error("supersonic: call init() first");
}

export default supersonic;
