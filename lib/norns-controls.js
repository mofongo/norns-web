// norns-controls.js
// Visual E1/E2/E3 encoder knobs and K1/K2/K3 key buttons for norns-web.
// Mirrors the physical norns control layout below the screen.
//
// Provides MIDI learn: click "learn" next to any encoder or key,
// then move a knob or press a note on your MIDI controller to map it.
// Mapping is saved to localStorage and restored on reload.
//
// Usage (ES module):
//   import { buildNornsControls } from './lib/norns-controls.js';
//   const controls = buildNornsControls({ loader, onLog });
//   // later, after MIDI access is obtained:
//   controls.setupMidi(midiAccess);

// ── constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'norns-web:midi-map';
const KNOB_SIZE   = 64;   // logical px
const DRAG_PX     = 3;    // px per encoder step when dragging
const ANG_STEP    = Math.PI / 16; // radians per step

// ── storage ───────────────────────────────────────────────────────────────────

function loadMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      encs: [null, null, null],
      keys: [null, null, null],
      mode: 'relative-signed',
      ...saved,
    };
  } catch {
    return { encs: [null, null, null], keys: [null, null, null], mode: 'relative-signed' };
  }
}

function saveMap(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

// ── CC decode ─────────────────────────────────────────────────────────────────

function ccToDelta(value, mode) {
  if (mode === 'relative-signed') {
    // Signed-bit: 1–63 = +1 to +63, 65–127 = −1 to −63, 64 = 0
    if (value === 64) return 0;
    return value < 64 ? value : value - 128;
  }
  if (mode === 'relative-twos') {
    // 2's complement: 0–63 = positive, 64–127 = negative
    return value < 64 ? value : value - 128;
  }
  // Absolute: treat center (64) as zero, scale to ±1
  return value >= 65 ? 1 : value <= 63 ? -1 : 0;
}

// ── knob drawing ──────────────────────────────────────────────────────────────

function drawKnob(canvas, angle, active) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  const W = KNOB_SIZE, H = KNOB_SIZE;
  const cx = W / 2, cy = H / 2;
  const outerR = cx - 3;
  const innerR = outerR - 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  // Dead-zone arc (bottom gap, like a real potentiometer / encoder ring)
  const gapStart = Math.PI * 0.65;
  const gapEnd   = Math.PI * 2.35;

  // Track arc
  ctx.beginPath();
  ctx.arc(cx, cy, outerR - 4, gapEnd, gapStart, false);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.strokeStyle = active ? '#999' : '#555';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Body fill
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fillStyle = active ? '#2a2a2a' : '#1e1e1e';
  ctx.fill();

  // Indicator line — starts from top (−π/2), rotates with angle
  const normAngle = angle - Math.PI / 2;
  const lineR = innerR - 5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(
    cx + lineR * Math.cos(normAngle),
    cy + lineR * Math.sin(normAngle)
  );
  ctx.strokeStyle = active ? '#fff' : '#ddd';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = active ? '#fff' : '#666';
  ctx.fill();

  ctx.restore();
}

// ── main export ───────────────────────────────────────────────────────────────

export function buildNornsControls({ loader, onLog = () => {} }) {
  const map        = loadMap();
  const angles     = [0, 0, 0];    // visual angle accumulator per encoder
  let learning     = null;          // { type: 'enc'|'key', idx: 0|1|2 }
  let midiReady    = false;
  let _dragIdx     = null;
  let _dragLastY   = 0;

  // ── document-level drag handlers (shared across all knobs) ────────────────

  document.addEventListener('mousemove', (e) => {
    if (_dragIdx === null) return;
    const dy = _dragLastY - e.clientY;
    if (Math.abs(dy) >= DRAG_PX) {
      const delta = dy > 0 ? 1 : -1;
      _step(_dragIdx, delta, true);
      _dragLastY = e.clientY;
    }
  });

  document.addEventListener('mouseup', () => {
    if (_dragIdx !== null) {
      _redraw(_dragIdx, false);
      _dragIdx = null;
    }
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function _redraw(idx, active = false) {
    const canvas = document.getElementById(`nc-knob-${idx + 1}`);
    if (canvas) drawKnob(canvas, angles[idx], active);
  }

  function _step(idx, delta, active = false) {
    angles[idx] += delta * ANG_STEP;
    _redraw(idx, active);
    loader.current?.enc(idx + 1, delta);
  }

  // ── encoders ──────────────────────────────────────────────────────────────

  function buildEncoders(container) {
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      const wrap = document.createElement('div');
      wrap.className = 'nc-enc';

      // Canvas
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.id = `nc-knob-${n}`;
      canvas.className = 'nc-knob';
      canvas.width  = KNOB_SIZE * dpr;
      canvas.height = KNOB_SIZE * dpr;
      canvas.style.width  = KNOB_SIZE + 'px';
      canvas.style.height = KNOB_SIZE + 'px';
      canvas.title = `E${n} — drag vertically or scroll`;

      // Mouse drag start
      canvas.addEventListener('mousedown', (e) => {
        _dragIdx   = i;
        _dragLastY = e.clientY;
        e.preventDefault();
      });

      // Scroll wheel
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        _step(i, e.deltaY < 0 ? 1 : -1);
      }, { passive: false });

      // Touch
      let tLastY = 0;
      let tAccum = 0;
      canvas.addEventListener('touchstart', (e) => {
        tLastY = e.touches[0].clientY;
        tAccum = 0;
        e.preventDefault();
      }, { passive: false });
      canvas.addEventListener('touchmove', (e) => {
        tAccum += tLastY - e.touches[0].clientY;
        tLastY = e.touches[0].clientY;
        while (tAccum >= DRAG_PX)  { _step(i,  1, true); tAccum -= DRAG_PX; }
        while (tAccum <= -DRAG_PX) { _step(i, -1, true); tAccum += DRAG_PX; }
        e.preventDefault();
      }, { passive: false });
      canvas.addEventListener('touchend', () => _redraw(i, false));

      // Label
      const label = document.createElement('div');
      label.className = 'nc-label';
      label.textContent = `E${n}`;

      // MIDI CC row
      const midiRow = document.createElement('div');
      midiRow.className = 'nc-midi-row';

      const ccInput = document.createElement('input');
      ccInput.type = 'number';
      ccInput.id   = `nc-enc-cc-${n}`;
      ccInput.min  = '0';
      ccInput.max  = '127';
      ccInput.placeholder = 'CC';
      ccInput.title = 'MIDI CC number (0–127)';
      if (map.encs[i] !== null) ccInput.value = map.encs[i];
      ccInput.addEventListener('change', () => {
        const v = parseInt(ccInput.value);
        map.encs[i] = isNaN(v) ? null : Math.max(0, Math.min(127, v));
        if (isNaN(v)) ccInput.value = '';
        saveMap(map);
      });

      const learnBtn = document.createElement('button');
      learnBtn.id = `nc-enc-learn-${n}`;
      learnBtn.className = 'nc-learn-btn';
      learnBtn.textContent = 'learn';
      learnBtn.addEventListener('click', () => _toggleLearn('enc', i));

      midiRow.appendChild(ccInput);
      midiRow.appendChild(learnBtn);
      wrap.appendChild(canvas);
      wrap.appendChild(label);
      wrap.appendChild(midiRow);
      container.appendChild(wrap);

      drawKnob(canvas, 0, false);
    }
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  function buildKeys(container) {
    const pressedByMouse = new Set();

    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      const wrap = document.createElement('div');
      wrap.className = 'nc-key-wrap';

      const btn = document.createElement('button');
      btn.id = `nc-key-${n}`;
      btn.className = 'nc-key-btn';
      btn.textContent = `K${n}`;
      if (n === 1) btn.title = 'K1 (long-press = norns menu on hardware)';

      const press = () => {
        btn.classList.add('pressed');
        loader.current?.key(n, 1);
      };
      const release = () => {
        btn.classList.remove('pressed');
        loader.current?.key(n, 0);
      };

      btn.addEventListener('mousedown', () => { pressedByMouse.add(n); press(); });
      document.addEventListener('mouseup', () => {
        if (pressedByMouse.has(n)) { pressedByMouse.delete(n); release(); }
      });
      btn.addEventListener('touchstart', (e) => { press(); e.preventDefault(); }, { passive: false });
      btn.addEventListener('touchend',   (e) => { release(); e.preventDefault(); }, { passive: false });

      // MIDI note row
      const midiRow = document.createElement('div');
      midiRow.className = 'nc-midi-row';

      const noteInput = document.createElement('input');
      noteInput.type = 'number';
      noteInput.id   = `nc-key-note-${n}`;
      noteInput.min  = '0';
      noteInput.max  = '127';
      noteInput.placeholder = 'note';
      noteInput.title = 'MIDI note number (0–127)';
      if (map.keys[i] !== null) noteInput.value = map.keys[i];
      noteInput.addEventListener('change', () => {
        const v = parseInt(noteInput.value);
        map.keys[i] = isNaN(v) ? null : Math.max(0, Math.min(127, v));
        if (isNaN(v)) noteInput.value = '';
        saveMap(map);
      });

      const learnBtn = document.createElement('button');
      learnBtn.id = `nc-key-learn-${n}`;
      learnBtn.className = 'nc-learn-btn';
      learnBtn.textContent = 'learn';
      learnBtn.addEventListener('click', () => _toggleLearn('key', i));

      midiRow.appendChild(noteInput);
      midiRow.appendChild(learnBtn);
      wrap.appendChild(btn);
      wrap.appendChild(midiRow);
      container.appendChild(wrap);
    }
  }

  // ── MIDI learn ────────────────────────────────────────────────────────────

  function _toggleLearn(type, idx) {
    if (learning?.type === type && learning?.idx === idx) {
      _stopLearn();
    } else {
      _startLearn(type, idx);
    }
  }

  function _startLearn(type, idx) {
    _stopLearn();
    learning = { type, idx };
    const btn = document.getElementById(
      type === 'enc' ? `nc-enc-learn-${idx + 1}` : `nc-key-learn-${idx + 1}`
    );
    if (btn) { btn.textContent = 'cancel'; btn.classList.add('listening'); }
    onLog(`MIDI learn: ${type === 'enc' ? 'turn an encoder' : 'press a note'} to map → ${type === 'enc' ? 'E' : 'K'}${idx + 1}`);
  }

  function _stopLearn() {
    if (!learning) return;
    const btn = document.getElementById(
      learning.type === 'enc'
        ? `nc-enc-learn-${learning.idx + 1}`
        : `nc-key-learn-${learning.idx + 1}`
    );
    if (btn) { btn.textContent = 'learn'; btn.classList.remove('listening'); }
    learning = null;
  }

  // ── MIDI input handler ────────────────────────────────────────────────────

  function _onMidiMessage(e) {
    if (!e.data || e.data.length < 2) return;
    const [status, data1, data2 = 0] = e.data;
    const type = status & 0xF0;

    // ── learn mode: capture first matching message ──
    if (learning) {
      if (learning.type === 'enc' && type === 0xB0) {
        const cc = data1;
        map.encs[learning.idx] = cc;
        const inp = document.getElementById(`nc-enc-cc-${learning.idx + 1}`);
        if (inp) inp.value = cc;
        saveMap(map);
        onLog(`E${learning.idx + 1} → CC ${cc}`);
        _stopLearn();
        return;
      }
      if (learning.type === 'key' && (type === 0x90 || type === 0x80)) {
        const note = data1;
        map.keys[learning.idx] = note;
        const inp = document.getElementById(`nc-key-note-${learning.idx + 1}`);
        if (inp) inp.value = note;
        saveMap(map);
        onLog(`K${learning.idx + 1} → note ${note}`);
        _stopLearn();
        return;
      }
    }

    // ── CC → encoder ──
    if (type === 0xB0) {
      const idx = map.encs.indexOf(data1);
      if (idx >= 0) {
        const delta = ccToDelta(data2, map.mode);
        if (delta !== 0) _step(idx, delta);
      }
    }

    // ── note on → key press ──
    if (type === 0x90 && data2 > 0) {
      const idx = map.keys.indexOf(data1);
      if (idx >= 0) {
        document.getElementById(`nc-key-${idx + 1}`)?.classList.add('pressed');
        loader.current?.key(idx + 1, 1);
      }
    }

    // ── note off → key release ──
    if (type === 0x80 || (type === 0x90 && data2 === 0)) {
      const idx = map.keys.indexOf(data1);
      if (idx >= 0) {
        document.getElementById(`nc-key-${idx + 1}`)?.classList.remove('pressed');
        loader.current?.key(idx + 1, 0);
      }
    }
  }

  // ── init ──────────────────────────────────────────────────────────────────

  buildEncoders(document.getElementById('nc-encoders'));
  buildKeys(document.getElementById('nc-keys'));

  // Wire CC mode selector
  const modeSelect = document.getElementById('nc-cc-mode');
  if (modeSelect) {
    modeSelect.value = map.mode;
    modeSelect.addEventListener('change', () => {
      map.mode = modeSelect.value;
      saveMap(map);
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  return {
    // Call once Web MIDI access is available (after user gesture)
    setupMidi(midiAccess) {
      if (!midiAccess || midiReady) return;
      midiReady = true;

      const attach = (input) => input.addEventListener('midimessage', _onMidiMessage);
      midiAccess.inputs.forEach(attach);

      // Hot-plug: attach listener to any device connected later
      midiAccess.onstatechange = (e) => {
        if (e.port.type === 'input' && e.port.state === 'connected') attach(e.port);
      };

      // Populate device list in the status span
      const status = document.getElementById('nc-midi-status');
      if (status) {
        const names = [];
        midiAccess.inputs.forEach(inp => names.push(inp.name));
        status.textContent = names.length
          ? names.join(', ')
          : 'no MIDI devices';
      }
    },

    // Reset knob angles (call when a new script starts)
    resetKnobs() {
      angles.fill(0);
      for (let i = 0; i < 3; i++) _redraw(i, false);
    },
  };
}
