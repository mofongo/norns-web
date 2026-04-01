// lib/mods.js — mod manager for norns-web
//
// Tracks which mods are active and fetches their Lua source so the runtime
// can load them into the Lua state before the user script runs.

const _active = new Set();
const _cache  = new Map();

const mods = {
  // Enable a mod by name. Fetches and caches its source immediately.
  async enable(name) {
    await mods.fetch(name);
    _active.add(name);
  },

  // Disable a mod. Takes effect the next time a script is loaded.
  disable(name) {
    _active.delete(name);
  },

  isEnabled(name) {
    return _active.has(name);
  },

  // Fetch (and cache) a mod's Lua source from ./mods/<name>.lua
  async fetch(name) {
    if (_cache.has(name)) return _cache.get(name);
    const resp = await fetch(`./mods/${name}.lua`);
    if (!resp.ok) throw new Error(`Mod "${name}" not found (${resp.status})`);
    const src = await resp.text();
    _cache.set(name, src);
    return src;
  },

  // Returns [{ name, src }, ...] for all active mods, in insertion order.
  async getSources() {
    const out = [];
    for (const name of _active) {
      const src = await mods.fetch(name);
      out.push({ name, src });
    }
    return out;
  },
};

export { mods };
export default mods;
