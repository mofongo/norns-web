// norns-web nb (note-broker) module
// Port of sixolet/nb to JavaScript.
//
// nb is a plug-and-play voice architecture. Players (voices/instruments) register
// themselves into a global registry. Scripts call nb.add_param() to get a voice
// selector, then call selector.get_player() to get the active player.
//
// Built-in players:
//   - Web MIDI hardware outputs (auto-discovered on nb.init())
//
// Custom players:
//   - Call nb.register(name, player) before or after nb.init()
//   - Players must extend Player from lib/player.js
//   - Or pass a plain object; nb.register() will wrap it automatically
//
// Usage:
//   import nb from '../lib/nb.js';
//   await nb.init();
//   const voice = nb.add_param('voice1', 'Voice 1');
//   voice.select('midi: My Synth');       // pick a player
//   voice.get_player().note_on(60, 0.8);  // play middle C

import { Player } from "./player.js";

// ---------------------------------------------------------------------------
// Global player registry
// Stored on window so multiple scripts/modules share the same instance.
// ---------------------------------------------------------------------------
if (typeof window !== "undefined" && !window.note_players) {
  window.note_players = {};
}
const note_players =
  typeof window !== "undefined" ? window.note_players : {};

// ---------------------------------------------------------------------------
// Built-in Web MIDI player
// ---------------------------------------------------------------------------
class MidiPlayer extends Player {
  constructor(output, channel = 1) {
    super();
    this.output = output;
    this.channel = channel;
    this._modCC = 1;       // default modulation CC
    this._bendRange = 12;  // semitones
  }

  note_on(note, vel, _properties) {
    const v = Math.max(0, Math.min(127, Math.round(127 * vel)));
    const ch = (this.channel - 1) & 0x0f;
    this.output.send([0x90 | ch, note & 0x7f, v]);
  }

  note_off(note) {
    const ch = (this.channel - 1) & 0x0f;
    this.output.send([0x80 | ch, note & 0x7f, 0]);
  }

  pitch_bend(_note, amount) {
    const clamped = Math.max(
      -this._bendRange,
      Math.min(this._bendRange, amount)
    );
    const normalized = clamped / this._bendRange; // -1..1
    const raw = Math.round(((normalized + 1) / 2) * 16383);
    const ch = (this.channel - 1) & 0x0f;
    this.output.send([0xe0 | ch, raw & 0x7f, (raw >> 7) & 0x7f]);
  }

  modulate(val) {
    const v = Math.max(0, Math.min(127, Math.round(127 * val)));
    const ch = (this.channel - 1) & 0x0f;
    this.output.send([0xb0 | ch, this._modCC & 0x7f, v]);
  }

  modulate_note(note, key, value) {
    if (key === "pressure") {
      const v = Math.max(0, Math.min(127, Math.round(value * 127)));
      const ch = (this.channel - 1) & 0x0f;
      this.output.send([0xa0 | ch, note & 0x7f, v]);
    }
  }

  stop_all() {
    // All-notes-off CC (CC 123)
    const ch = (this.channel - 1) & 0x0f;
    this.output.send([0xb0 | ch, 123, 0]);
  }

  describe() {
    return {
      name: this.output ? this.output.name : "midi",
      supports_bend: true,
      supports_slew: false,
      note_mod_targets: ["pressure"],
      modulate_description: `cc ${this._modCC}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Selector — returned by nb.add_param()
// ---------------------------------------------------------------------------
class Selector {
  constructor(id, paramName) {
    this.id = id;
    this.paramName = paramName;
    this._selectedName = "none";
    this._player = null;
  }

  // Sorted list of available player names (always starts with 'none')
  getNames() {
    return ["none", ...Object.keys(note_players).sort()];
  }

  // Currently selected player name
  getSelectedName() {
    return this._selectedName;
  }

  // Select a player by name. Pass 'none' to deselect.
  select(name) {
    if (name === this._selectedName) return;
    // Release previous player
    if (this._player) {
      this._player.count_down();
      this._player = null;
    }
    this._selectedName = name;
    if (name !== "none") {
      const p = note_players[name];
      if (p) {
        this._player = p;
        p.count_up();
      }
    }
  }

  // Get the current player. Returns nb.none if nothing is selected.
  get_player() {
    return this._player || nb.none;
  }

  // Release selection. Call when the script that owns this selector is cleaned up.
  cleanup() {
    if (this._player) {
      this._player.count_down();
      this._player = null;
    }
    this._selectedName = "none";
  }
}

// ---------------------------------------------------------------------------
// nb module
// ---------------------------------------------------------------------------

// Track names of auto-discovered Web MIDI players so we can clear them on re-init
const _webMidiPlayerNames = new Set();

const nb = {
  players: note_players,

  // A silent "none" player — the default when nothing is selected
  none: new Player(),

  // Number of voices (channels) to create per Web MIDI output.
  // Set before calling nb.init() to create multi-channel players per device.
  voice_count: 1,

  // Discover Web MIDI outputs and register them as players.
  // Call from your script's init() function.
  async init() {
    // Remove previously auto-discovered Web MIDI players before re-scanning
    for (const name of _webMidiPlayerNames) {
      delete nb.players[name];
    }
    _webMidiPlayerNames.clear();

    if (typeof navigator !== "undefined" && navigator.requestMIDIAccess) {
      try {
        const access = await navigator.requestMIDIAccess();

        const registerOutput = (output) => {
          for (let ch = 1; ch <= nb.voice_count; ch++) {
            const suffix = nb.voice_count > 1 ? ` ch${ch}` : "";
            const name = `midi: ${output.name}${suffix}`;
            const player = new MidiPlayer(output, ch);
            player.name = name;
            nb.players[name] = player;
            _webMidiPlayerNames.add(name);
          }
        };

        access.outputs.forEach(registerOutput);

        // Also handle devices connected after init
        access.onstatechange = (e) => {
          if (e.port.type === "output" && e.port.state === "connected") {
            registerOutput(e.port);
          }
        };
      } catch (err) {
        console.warn("nb: Web MIDI unavailable:", err.message);
      }
    }

    this.stop_all();
  },

  // Register a custom player by name.
  // player can be a Player subclass instance or a plain object with note_on/note_off.
  // Call at any time — before or after init().
  register(name, player) {
    if (!(player instanceof Player)) {
      // Wrap plain objects so they inherit Player defaults
      const wrapper = Object.assign(new Player(), player);
      player = wrapper;
    }
    player.name = name;
    nb.players[name] = player;
  },

  // Create a voice selector. Returns a Selector object with:
  //   .getNames()         — list of available player names
  //   .select(name)       — choose a player by name
  //   .get_player()       — get the current player (or nb.none)
  //   .getSelectedName()  — name of current selection
  //   .cleanup()          — release on script unload
  add_param(id, paramName) {
    return new Selector(id, paramName || id);
  },

  // Return a snapshot of all registered players.
  get_players() {
    return { ...nb.players };
  },

  // Send stop_all to every registered player.
  // Call when loading a new pset or on script cleanup to avoid stuck notes.
  stop_all() {
    for (const player of Object.values(nb.players)) {
      if (typeof player.stop_all === "function") {
        player.stop_all();
      }
    }
  },
};

export { Player, MidiPlayer, Selector };
export default nb;
