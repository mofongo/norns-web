// Script loader — loads norns-web scripts from the manifest or drag-and-drop
//
// Scripts are ES modules exporting:
//   init(canvas, audioCtx?)  — called when the script is launched
//   cleanup()                — called before switching to another script

let _currentScript = null;
let _blobUrls = []; // track blob URLs for cleanup

const loader = {
  // Load the script manifest
  async loadManifest(url = "./scripts/index.json") {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`);
    return resp.json();
  },

  // Load and run a script from a URL path
  async run(scriptUrl, canvas, audioCtx) {
    await loader.stop();

    // Resolve relative to page origin (not this module's location)
    const resolved = new URL(scriptUrl, window.location.href).href;
    // Cache-bust to allow reloading modified scripts
    const url = resolved + (resolved.includes("?") ? "&" : "?") + `_t=${Date.now()}`;
    const mod = await import(url);
    _currentScript = mod;

    if (typeof mod.init === "function") {
      await mod.init(canvas, audioCtx);
    }

    return mod;
  },

  // Load and run a script from a dropped/selected File
  async runFile(file, canvas, audioCtx) {
    await loader.stop();

    const text = await file.text();
    // Rewrite bare relative imports (../lib/) to absolute paths so the blob can resolve them
    const origin = window.location.origin;
    const libBase = new URL("./lib/", window.location.href).href;
    const rewritten = text.replace(
      /from\s+["']\.\.\/lib\//g,
      `from "${libBase}`
    );

    const blob = new Blob([rewritten], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    _blobUrls.push(blobUrl);

    const mod = await import(blobUrl);
    _currentScript = mod;

    if (typeof mod.init === "function") {
      await mod.init(canvas, audioCtx);
    }

    return mod;
  },

  // Stop the current script
  async stop() {
    if (_currentScript && typeof _currentScript.cleanup === "function") {
      await _currentScript.cleanup();
    }
    _currentScript = null;

    // Clean up blob URLs
    for (const url of _blobUrls) {
      URL.revokeObjectURL(url);
    }
    _blobUrls = [];
  },

  get current() {
    return _currentScript;
  },
};

export { loader };
export default loader;
