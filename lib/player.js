// norns-web Player base class
// Port of sixolet/nb lib/player.lua to JavaScript.
//
// Extend this class to create a custom voice/instrument player.
// Implement note_on, note_off, and describe() at minimum.
// The play_note, count_up/count_down lifecycle, and active/inactive
// hooks are implemented here and generally should not be overridden.

import clock from "./clock.js";

// Module-level refcount map: player name → count of selectors using it.
// Drives the active() / inactive() lifecycle callbacks.
const _refcounts = new Map();

export class Player {
  constructor() {
    this.name = null;
    this.is_active = false;
    this._activeRoutine = null;
  }

  // Override to add script-specific params (optional)
  add_params() {}

  // Override to handle note-on. vel is 0–1.
  note_on(note, vel, properties) {}

  // Override to handle note-off.
  note_off(note) {}

  // Override for pitch bend. amount is in semitones.
  pitch_bend(note, amount) {}

  // Override for global modulation (e.g. mod wheel). val is 0–1.
  modulate(val) {}

  // Override for voice-level modulation by key. val is 0–1.
  modulate_voice(key, val) {}

  // Override to set portamento/slew time in seconds.
  set_slew(slew) {}

  // Override for per-note modulation. key should be in note_mod_targets.
  // value is 0–1.
  modulate_note(note, key, value) {}

  // Override to describe the voice's capabilities.
  describe() {
    return {
      name: "none",
      supports_bend: false,
      supports_slew: false,
      modulate_description: "unsupported",
      note_mod_targets: [],
      voice_mod_targets: [],
      params: [],
    };
  }

  // Called when this voice is first selected (refcount 0→1).
  // Override to show params, change device modes, etc.
  active() {
    this.is_active = true;
    // Fire delayed_active after 1 second if still active
    this._activeRoutine = clock.run(async () => {
      await clock.sleep(1);
      if (this.is_active) this.delayed_active();
      this._activeRoutine = null;
    });
  }

  // Called 1 second after active(). Override for deferred setup.
  delayed_active() {}

  // Called when this voice is no longer used (refcount N→0).
  // Override to hide params, send all-notes-off, etc.
  inactive() {
    this.is_active = false;
    if (this._activeRoutine != null) {
      clock.cancel(this._activeRoutine);
      this._activeRoutine = null;
    }
  }

  // Stop all sounding notes. Override for voice-specific implementation.
  stop_all() {}

  // Play a note for `length` beats. Fires note_on then note_off after
  // length * clock.get_beat_sec() seconds. Uses clock.run for timing.
  play_note(note, vel, length, properties) {
    this.note_on(note, vel, properties);
    clock.run(async () => {
      await clock.sleep(length * clock.get_beat_sec());
      this.note_off(note);
    });
  }

  // Private. Called by Selector when it starts using this player.
  count_up() {
    if (this.name != null) {
      const count = (_refcounts.get(this.name) || 0) + 1;
      _refcounts.set(this.name, count);
      if (count === 1) this.active();
    }
  }

  // Private. Called by Selector when it stops using this player.
  count_down() {
    if (this.name != null) {
      const count = _refcounts.get(this.name) || 0;
      if (count > 0) {
        const next = count - 1;
        if (next === 0) {
          _refcounts.delete(this.name);
          this.inactive();
        } else {
          _refcounts.set(this.name, next);
        }
      }
    }
  }
}

export default Player;
