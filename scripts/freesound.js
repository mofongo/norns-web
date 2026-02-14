// freesound — browse, preview, and load sounds from Freesound.org
//
// Searches Freesound, previews results, and loads selected sounds
// into softcut buffers for playback/manipulation.
//
import screen from "../lib/screen.js";
import softcut from "../lib/softcut.js";

// -- Freesound API --
const API_KEY = "QJH8LINQrUwgdW7v32b9OMQtA608ULJzOpP6aArO";
const API_BASE = "https://freesound.org/apiv2";
const FIELDS = "id,name,duration,username,previews,images,tags";

async function fsSearch(query, page = 1, pageSize = 12) {
  const params = new URLSearchParams({
    token: API_KEY,
    query,
    fields: FIELDS + ",description",
    page_size: pageSize,
    page,
  });
  const resp = await fetch(`${API_BASE}/search/text/?${params}`);
  if (!resp.ok) throw new Error(`Freesound search failed: ${resp.status}`);
  return resp.json();
}

async function fsUserSounds(username, page = 1, pageSize = 12) {
  const params = new URLSearchParams({
    token: API_KEY,
    fields: FIELDS,
    page_size: pageSize,
    page,
  });
  const resp = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}/sounds/?${params}`);
  if (!resp.ok) throw new Error(`User lookup failed: ${resp.status}`);
  return resp.json();
}

async function fsPackSounds(packId, page = 1, pageSize = 12) {
  const params = new URLSearchParams({
    token: API_KEY,
    fields: FIELDS,
    page_size: pageSize,
    page,
  });
  const resp = await fetch(`${API_BASE}/packs/${packId}/sounds/?${params}`);
  if (!resp.ok) throw new Error(`Pack lookup failed: ${resp.status}`);
  return resp.json();
}

function parsePackUrl(input) {
  const match = input.match(/packs\/(\d+)/);
  return match ? match[1] : input.trim();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDuration(secs) {
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// -- state --
const BUF = 1;
const VOICE = 1;
let animId = null;
let audioCtx = null;
let previewAudio = null;
let previewingId = null;
let overlay = null;
let loadedSound = null; // { name, duration }
let playPhase = 0;
let playing = false;
let searchMode = "search"; // search | user | pack
let nextPageUrl = null;
let results = [];

// -- screen drawing --
function redraw() {
  screen.clear();

  screen.level(15);
  screen.font_size(7);
  screen.move(2, 1);
  screen.text("freesound");

  if (loadedSound) {
    // Show loaded sound info
    screen.level(10);
    screen.font_size(6);
    screen.move(2, 12);
    const name = loadedSound.name.length > 22
      ? loadedSound.name.slice(0, 21) + "~"
      : loadedSound.name;
    screen.text(name);

    screen.level(6);
    screen.move(2, 20);
    screen.text(`${formatDuration(loadedSound.duration)}  buf:${BUF}`);

    // Waveform placeholder
    const yMid = 38;
    const yRange = 12;
    screen.level(2);
    screen.move(2, yMid);
    screen.line(126, yMid);
    screen.stroke();

    if (loadedSound.waveform) {
      screen.level(8);
      for (let i = 0; i < loadedSound.waveform.length; i++) {
        const x = 2 + i;
        const h = loadedSound.waveform[i] * yRange;
        if (h > 0.5) {
          screen.move(x, yMid - h);
          screen.line(x, yMid + h);
        }
      }
      screen.stroke();

      // Playhead
      if (playing && loadedSound.duration > 0) {
        const px = 2 + Math.floor((playPhase / loadedSound.duration) * 124);
        screen.level(15);
        screen.move(px, yMid - yRange);
        screen.line(px, yMid + yRange);
        screen.stroke();
      }
    }

    // Status
    screen.level(playing ? 15 : 5);
    screen.font_size(6);
    screen.move(2, 54);
    screen.text(playing ? "playing" : "stopped");

    screen.level(4);
    screen.move(50, 54);
    screen.text("open browser to search");
  } else {
    screen.level(5);
    screen.font_size(6);
    screen.move(2, 20);
    screen.text("open the browser panel");
    screen.move(2, 28);
    screen.text("to search & load sounds");
    screen.move(2, 40);
    screen.level(3);
    screen.text("sounds from freesound.org");
  }

  screen.update();
  animId = requestAnimationFrame(redraw);
}

// -- overlay UI --
function createOverlay() {
  overlay = document.createElement("div");
  overlay.id = "fs-overlay";
  overlay.innerHTML = `
    <style>
      #fs-overlay {
        position: fixed; inset: 0; z-index: 1000;
        background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        font-family: monospace;
      }
      #fs-panel {
        background: #1a1a1a; border: 1px solid #444;
        width: 90%; max-width: 640px; max-height: 85vh;
        display: flex; flex-direction: column;
        color: #e0e0e0;
      }
      #fs-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0.75rem 1rem; border-bottom: 1px solid #333;
      }
      #fs-header h2 { font-size: 1rem; margin: 0; color: #fff; }
      #fs-close {
        background: none; border: none; color: #888; font-size: 1.4rem;
        cursor: pointer; padding: 0 0.25rem;
      }
      #fs-close:hover { color: #fff; }
      #fs-tabs {
        display: flex; gap: 0; border-bottom: 1px solid #333;
      }
      .fs-tab {
        font-family: monospace; font-size: 0.8rem;
        padding: 0.5rem 1rem; background: none; border: none;
        color: #888; cursor: pointer; border-bottom: 2px solid transparent;
      }
      .fs-tab:hover { color: #ccc; }
      .fs-tab.active { color: #8cf; border-bottom-color: #8cf; }
      #fs-search-row {
        display: flex; gap: 0.5rem; padding: 0.75rem 1rem;
      }
      #fs-input {
        flex: 1; font-family: monospace; font-size: 0.85rem;
        background: #222; color: #e0e0e0; border: 1px solid #555;
        padding: 0.4rem 0.6rem;
      }
      #fs-search-btn {
        font-family: monospace; font-size: 0.85rem;
        padding: 0.4rem 0.8rem; background: #335; color: #8cf;
        border: 1px solid #557; cursor: pointer;
      }
      #fs-search-btn:hover { background: #446; }
      #fs-results {
        flex: 1; overflow-y: auto; padding: 0.5rem;
      }
      #fs-status {
        padding: 0.5rem 1rem; color: #666; font-size: 0.8rem;
        text-align: center;
      }
      .fs-card {
        display: flex; align-items: center; gap: 0.6rem;
        padding: 0.5rem; border-bottom: 1px solid #2a2a2a;
        cursor: default;
      }
      .fs-card:hover { background: #222; }
      .fs-wave {
        width: 80px; height: 32px; background-size: cover;
        background-position: center; background-color: #111;
        border-radius: 2px; flex-shrink: 0;
      }
      .fs-info { flex: 1; min-width: 0; }
      .fs-name {
        font-size: 0.8rem; color: #ddd;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fs-meta { font-size: 0.7rem; color: #777; }
      .fs-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }
      .fs-btn {
        font-family: monospace; font-size: 0.75rem;
        padding: 0.3rem 0.5rem; background: #333; color: #ccc;
        border: 1px solid #555; cursor: pointer;
      }
      .fs-btn:hover { background: #444; }
      .fs-btn.active { color: #8cf; border-color: #8cf; }
      .fs-btn.loading { opacity: 0.5; pointer-events: none; }
      .fs-btn.loaded { color: #5b5; border-color: #5b5; }
      #fs-load-more {
        display: none; font-family: monospace; font-size: 0.8rem;
        padding: 0.5rem; margin: 0.5rem auto; background: #333;
        color: #aaa; border: 1px solid #555; cursor: pointer;
        width: calc(100% - 1rem);
      }
      #fs-load-more:hover { background: #444; }
      .fs-tags { font-size: 0.65rem; color: #556; margin-top: 1px; }
    </style>
    <div id="fs-panel">
      <div id="fs-header">
        <h2>freesound browser</h2>
        <button id="fs-close">&times;</button>
      </div>
      <div id="fs-tabs">
        <button class="fs-tab active" data-mode="search">search</button>
        <button class="fs-tab" data-mode="user">user</button>
        <button class="fs-tab" data-mode="pack">pack</button>
      </div>
      <div id="fs-search-row">
        <input id="fs-input" type="text" placeholder="search sounds...">
        <button id="fs-search-btn">search</button>
      </div>
      <div id="fs-results"></div>
      <button id="fs-load-more">load more</button>
      <div id="fs-status"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Events
  overlay.querySelector("#fs-close").addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });

  const input = overlay.querySelector("#fs-input");
  const searchBtn = overlay.querySelector("#fs-search-btn");

  searchBtn.addEventListener("click", () => doSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch(input.value);
  });

  // Tabs
  overlay.querySelectorAll(".fs-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      searchMode = tab.dataset.mode;
      overlay.querySelectorAll(".fs-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const placeholders = {
        search: "search sounds...",
        user: "enter username...",
        pack: "enter pack ID or URL...",
      };
      input.placeholder = placeholders[searchMode];
      input.focus();
    });
  });

  // Load more
  overlay.querySelector("#fs-load-more").addEventListener("click", loadMore);

  input.focus();
}

function closeOverlay() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewingId = null;
  }
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

function setStatus(msg) {
  if (overlay) overlay.querySelector("#fs-status").textContent = msg;
}

async function doSearch(query) {
  if (!query.trim()) return;
  results = [];
  nextPageUrl = null;
  renderResults();
  setStatus("searching...");

  try {
    let data;
    switch (searchMode) {
      case "user":
        data = await fsUserSounds(query.trim());
        break;
      case "pack":
        data = await fsPackSounds(parsePackUrl(query));
        break;
      default:
        data = await fsSearch(query.trim());
    }

    results = data.results || [];
    nextPageUrl = data.next || null;
    renderResults();
    setStatus(results.length ? `${data.count} results` : "no sounds found");
  } catch (err) {
    setStatus("error: " + err.message);
    console.error(err);
  }
}

async function loadMore() {
  if (!nextPageUrl) return;
  setStatus("loading...");

  try {
    const url = new URL(nextPageUrl);
    url.searchParams.set("token", API_KEY);
    const resp = await fetch(url.toString());
    const data = await resp.json();

    results = results.concat(data.results || []);
    nextPageUrl = data.next || null;
    renderResults();
    setStatus(`${data.count} results`);
  } catch (err) {
    setStatus("error: " + err.message);
  }
}

function renderResults() {
  if (!overlay) return;
  const container = overlay.querySelector("#fs-results");
  const loadMoreBtn = overlay.querySelector("#fs-load-more");
  container.innerHTML = "";

  for (const sound of results) {
    const card = document.createElement("div");
    card.className = "fs-card";

    const previewUrl = sound.previews?.["preview-hq-mp3"] ||
                       sound.previews?.["preview-lq-mp3"] || "";
    const waveformUrl = sound.images?.waveform_m || "";
    const tags = (sound.tags || []).slice(0, 4).join(", ");

    card.innerHTML = `
      <div class="fs-wave" style="background-image: url('${escapeHtml(waveformUrl)}')"></div>
      <div class="fs-info">
        <div class="fs-name" title="${escapeHtml(sound.name)}">${escapeHtml(sound.name)}</div>
        <div class="fs-meta">${escapeHtml(sound.username)} &middot; ${formatDuration(sound.duration)}</div>
        ${tags ? `<div class="fs-tags">${escapeHtml(tags)}</div>` : ""}
      </div>
      <div class="fs-actions">
        <button class="fs-btn btn-preview" title="Preview">&#9654;</button>
        <button class="fs-btn btn-load" title="Load into buffer">+ buf</button>
      </div>
    `;

    // Preview
    card.querySelector(".btn-preview").addEventListener("click", () => {
      togglePreview(sound.id, previewUrl, card.querySelector(".btn-preview"));
    });

    // Load into buffer
    card.querySelector(".btn-load").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.classList.add("loading");
      btn.textContent = "...";
      try {
        await loadIntoBuffer(previewUrl, sound.name, sound.duration);
        btn.classList.remove("loading");
        btn.classList.add("loaded");
        btn.textContent = "ok";
      } catch (err) {
        btn.classList.remove("loading");
        btn.textContent = "err";
        console.error(err);
      }
    });

    container.appendChild(card);
  }

  loadMoreBtn.style.display = nextPageUrl ? "block" : "none";
}

function togglePreview(soundId, url, btn) {
  if (!previewAudio) previewAudio = new Audio();

  if (previewingId === soundId) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewingId = null;
    if (overlay) overlay.querySelectorAll(".btn-preview").forEach((b) => b.classList.remove("active"));
  } else {
    if (previewingId !== null && overlay) {
      overlay.querySelectorAll(".btn-preview").forEach((b) => b.classList.remove("active"));
    }
    previewAudio.src = url;
    previewAudio.play().catch((err) => console.error("Preview error:", err));
    previewingId = soundId;
    if (btn) btn.classList.add("active");
  }
}

async function loadIntoBuffer(url, name, duration) {
  // Stop any current playback
  softcut.play(VOICE, 0);
  playing = false;

  // Fetch and decode
  const resp = await fetch(url);
  const arrayBuf = await resp.arrayBuffer();
  const audioBuf = await audioCtx.decodeAudioData(arrayBuf);

  // Get mono channel data
  const srcData = audioBuf.getChannelData(0);

  // Resample to 48kHz if needed
  let data;
  if (audioBuf.sampleRate !== 48000) {
    const ratio = audioBuf.sampleRate / 48000;
    const outLen = Math.floor(srcData.length / ratio);
    data = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const frac = srcIdx - idx0;
      const idx1 = Math.min(idx0 + 1, srcData.length - 1);
      data[i] = srcData[idx0] * (1 - frac) + srcData[idx1] * frac;
    }
  } else {
    data = new Float32Array(srcData);
  }

  // Load into softcut buffer
  softcut.buffer_clear_channel(BUF);
  softcut.node.port.postMessage(
    { cmd: "buffer_load", ch: BUF - 1, start_dst: 0, data },
    [data.buffer]
  );

  const actualDur = data.length / 48000;

  // Build waveform display data
  const displayWidth = 124;
  const wfData = new Float32Array(displayWidth);
  const samplesPerPixel = Math.floor(data.length / displayWidth);

  // We need to re-read from our local copy since we transferred the buffer
  // Actually, we transferred `data.buffer`, so we need to request from worklet
  // For now, compute from srcData before transfer — but data was transferred.
  // Let's request it from the worklet instead.
  setTimeout(() => {
    softcut.node.port.postMessage({
      cmd: "buffer_read",
      ch: BUF - 1,
      start: 0,
      dur: actualDur,
    });
  }, 100);

  // Set up voice for playback
  softcut.enable(VOICE, 1);
  softcut.buffer(VOICE, BUF);
  softcut.level(VOICE, 0.8);
  softcut.pan(VOICE, 0);
  softcut.rate(VOICE, 1.0);
  softcut.loop(VOICE, 1);
  softcut.loop_start(VOICE, 0);
  softcut.loop_end(VOICE, actualDur);
  softcut.fade_time(VOICE, 0.01);
  softcut.position(VOICE, 0);
  softcut.play(VOICE, 1);
  playing = true;

  loadedSound = { name, duration: actualDur, waveform: null };

  // Phase polling
  softcut.phase_quant(VOICE, 0.04);
  softcut.poll_start_phase();
}

// -- button element (injected next to the canvas) --
let browserBtn = null;
let playBtn = null;

function createButtons() {
  const container = document.createElement("div");
  container.id = "fs-buttons";
  container.style.cssText = "display:flex;gap:0.5rem;margin-bottom:0.5rem;";

  browserBtn = document.createElement("button");
  browserBtn.textContent = "open freesound browser";
  browserBtn.style.cssText = "font-family:monospace;font-size:0.85rem;padding:0.4rem 0.8rem;background:#333;color:#e0e0e0;border:1px solid #555;cursor:pointer;";
  browserBtn.addEventListener("click", () => {
    if (!overlay) createOverlay();
  });

  playBtn = document.createElement("button");
  playBtn.textContent = "play / stop";
  playBtn.style.cssText = "font-family:monospace;font-size:0.85rem;padding:0.4rem 0.8rem;background:#333;color:#e0e0e0;border:1px solid #555;cursor:pointer;";
  playBtn.addEventListener("click", () => {
    if (!loadedSound) return;
    if (playing) {
      softcut.play(VOICE, 0);
      playing = false;
    } else {
      softcut.position(VOICE, 0);
      softcut.play(VOICE, 1);
      playing = true;
    }
  });

  container.appendChild(browserBtn);
  container.appendChild(playBtn);

  // Insert before the canvas
  const canvas = document.getElementById("norns-screen");
  canvas.parentNode.insertBefore(container, canvas);
}

// -- init --
export async function init(canvas, ctx) {
  screen.init(canvas);

  // Create AudioContext if needed
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
  }
  audioCtx = ctx;
  await softcut.init(audioCtx);

  // Hook worklet messages for waveform + phase
  const origHandler = softcut.node.port.onmessage;
  softcut.node.port.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "buffer_data" && loadedSound) {
      const raw = msg.data;
      const displayWidth = 124;
      const wf = new Float32Array(displayWidth);
      const spp = Math.floor(raw.length / displayWidth);
      for (let i = 0; i < displayWidth; i++) {
        let mx = 0;
        const off = i * spp;
        for (let j = 0; j < spp; j++) {
          const v = Math.abs(raw[off + j] || 0);
          if (v > mx) mx = v;
        }
        wf[i] = mx;
      }
      loadedSound.waveform = wf;
    }
    if (origHandler) origHandler(e);
  };

  softcut.event_phase((voice, ph) => {
    if (voice === VOICE) playPhase = ph;
  });

  createButtons();
  redraw();
}

// -- cleanup --
export function cleanup() {
  if (animId !== null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  closeOverlay();
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  // Remove buttons
  const btns = document.getElementById("fs-buttons");
  if (btns) btns.remove();

  for (let v = 1; v <= 6; v++) {
    softcut.rec(v, 0);
    softcut.play(v, 0);
    softcut.enable(v, 0);
  }
  softcut.poll_stop_phase();

  loadedSound = null;
  playing = false;
  results = [];
  nextPageUrl = null;
}
