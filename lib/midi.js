// norns-web MIDI module
// Software-only virtual MIDI bus matching the norns Lua API surface.

const STATUS = {
  NOTE_OFF: 0x80,
  NOTE_ON: 0x90,
  KEY_PRESSURE: 0xa0,
  CC: 0xb0,
  PROGRAM_CHANGE: 0xc0,
  CHANNEL_PRESSURE: 0xd0,
  PITCHBEND: 0xe0,
  CLOCK: 0xf8,
  START: 0xfa,
  CONTINUE: 0xfb,
  STOP: 0xfc,
};

const MAX_PORTS = 16;

class MidiPort {
  constructor(id) {
    this.id = id;
    this.name = `virtual port ${id}`;
    this.event = null; // user-settable callback: fn(data)
    this.connected = true;
    this._targets = []; // ports that receive our output
  }

  // Wire this port's output to another port's event callback
  wire(target) {
    if (!this._targets.includes(target)) {
      this._targets.push(target);
    }
  }

  unwire(target) {
    this._targets = this._targets.filter((t) => t !== target);
  }

  // Dispatch raw bytes to all wired targets and own event callback
  _dispatch(data) {
    for (const target of this._targets) {
      if (target.event) {
        target.event([...data]);
      }
    }
  }

  // Send raw byte array
  send(data) {
    this._dispatch(data);
  }

  // --- Note messages ---
  note_on(note, vel = 127, ch = 1) {
    this.send([STATUS.NOTE_ON | ((ch - 1) & 0x0f), note & 0x7f, vel & 0x7f]);
  }

  note_off(note, vel = 0, ch = 1) {
    this.send([STATUS.NOTE_OFF | ((ch - 1) & 0x0f), note & 0x7f, vel & 0x7f]);
  }

  // --- CC ---
  cc(cc, val, ch = 1) {
    this.send([STATUS.CC | ((ch - 1) & 0x0f), cc & 0x7f, val & 0x7f]);
  }

  // --- Pitch bend (14-bit, centered at 8192) ---
  pitchbend(val, ch = 1) {
    const v = Math.max(0, Math.min(16383, val + 8192));
    this.send([STATUS.PITCHBEND | ((ch - 1) & 0x0f), v & 0x7f, (v >> 7) & 0x7f]);
  }

  // --- Pressure ---
  channel_pressure(val, ch = 1) {
    this.send([STATUS.CHANNEL_PRESSURE | ((ch - 1) & 0x0f), val & 0x7f]);
  }

  key_pressure(note, val, ch = 1) {
    this.send([
      STATUS.KEY_PRESSURE | ((ch - 1) & 0x0f),
      note & 0x7f,
      val & 0x7f,
    ]);
  }

  // --- Program change ---
  program_change(val, ch = 1) {
    this.send([STATUS.PROGRAM_CHANGE | ((ch - 1) & 0x0f), val & 0x7f]);
  }

  // --- System real-time ---
  clock() {
    this.send([STATUS.CLOCK]);
  }

  start() {
    this.send([STATUS.START]);
  }

  stop() {
    this.send([STATUS.STOP]);
  }

  continue() {
    this.send([STATUS.CONTINUE]);
  }
}

// --- Module-level state ---
const ports = new Array(MAX_PORTS).fill(null);

const midi = {
  // Global callbacks for virtual device simulation
  add: null,
  remove: null,

  // Connect (create/retrieve) a virtual port by index (1-based, norns style)
  connect(n = 1) {
    const idx = n - 1;
    if (idx < 0 || idx >= MAX_PORTS) {
      throw new RangeError(`Port index must be 1–${MAX_PORTS}`);
    }
    if (!ports[idx]) {
      ports[idx] = new MidiPort(n);
      if (midi.add) midi.add({ id: n, name: ports[idx].name });
    }
    return ports[idx];
  },

  // Clear all handlers and ports
  cleanup() {
    for (let i = 0; i < MAX_PORTS; i++) {
      if (ports[i]) {
        if (midi.remove) midi.remove({ id: ports[i].id, name: ports[i].name });
        ports[i].event = null;
        ports[i]._targets = [];
        ports[i] = null;
      }
    }
  },

  // Parse raw MIDI bytes into a message object
  to_msg(data) {
    if (!data || data.length === 0) return null;
    const status = data[0];

    // System real-time (single byte)
    if (status >= 0xf8) {
      const types = {
        [STATUS.CLOCK]: "clock",
        [STATUS.START]: "start",
        [STATUS.STOP]: "stop",
        [STATUS.CONTINUE]: "continue",
      };
      return { type: types[status] || "other" };
    }

    const type_nibble = status & 0xf0;
    const ch = (status & 0x0f) + 1;

    switch (type_nibble) {
      case STATUS.NOTE_ON:
        return {
          type: data[2] > 0 ? "note_on" : "note_off",
          note: data[1],
          vel: data[2],
          ch,
        };
      case STATUS.NOTE_OFF:
        return { type: "note_off", note: data[1], vel: data[2], ch };
      case STATUS.KEY_PRESSURE:
        return { type: "key_pressure", note: data[1], val: data[2], ch };
      case STATUS.CC:
        return { type: "cc", cc: data[1], val: data[2], ch };
      case STATUS.PROGRAM_CHANGE:
        return { type: "program_change", val: data[1], ch };
      case STATUS.CHANNEL_PRESSURE:
        return { type: "channel_pressure", val: data[1], ch };
      case STATUS.PITCHBEND: {
        const raw = data[1] | (data[2] << 7);
        return { type: "pitchbend", val: raw - 8192, ch };
      }
      default:
        return { type: "other", data: [...data] };
    }
  },

  // Serialize a message object back to raw MIDI bytes
  to_data(msg) {
    const ch = ((msg.ch || 1) - 1) & 0x0f;
    switch (msg.type) {
      case "note_on":
        return [STATUS.NOTE_ON | ch, msg.note & 0x7f, (msg.vel ?? 127) & 0x7f];
      case "note_off":
        return [STATUS.NOTE_OFF | ch, msg.note & 0x7f, (msg.vel ?? 0) & 0x7f];
      case "cc":
        return [STATUS.CC | ch, msg.cc & 0x7f, msg.val & 0x7f];
      case "pitchbend": {
        const v = Math.max(0, Math.min(16383, (msg.val || 0) + 8192));
        return [STATUS.PITCHBEND | ch, v & 0x7f, (v >> 7) & 0x7f];
      }
      case "channel_pressure":
        return [STATUS.CHANNEL_PRESSURE | ch, msg.val & 0x7f];
      case "key_pressure":
        return [STATUS.KEY_PRESSURE | ch, msg.note & 0x7f, msg.val & 0x7f];
      case "program_change":
        return [STATUS.PROGRAM_CHANGE | ch, msg.val & 0x7f];
      case "clock":
        return [STATUS.CLOCK];
      case "start":
        return [STATUS.START];
      case "stop":
        return [STATUS.STOP];
      case "continue":
        return [STATUS.CONTINUE];
      default:
        return msg.data || [];
    }
  },
};

export { midi, MidiPort };
export default midi;
