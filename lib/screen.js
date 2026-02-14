// norns-web Screen module
// Ports the norns 128x64 display API to HTML Canvas 2D.
// Double-buffered: all drawing goes to an offscreen canvas,
// screen.update() copies it to the visible canvas.

const WIDTH = 128;
const HEIGHT = 64;

// Font table: norns font indices → CSS font strings
// Norns has 69 fonts; we map the most common to web equivalents.
const FONT_TABLE = {
  1: { family: "monospace", weight: "normal" },           // norns default
  2: { family: "monospace", weight: "bold" },              // ALEPH
  3: { family: "'Roboto', sans-serif", weight: "100" },    // Roboto Thin
  4: { family: "'Roboto', sans-serif", weight: "300" },    // Roboto Light
  5: { family: "'Roboto', sans-serif", weight: "400" },    // Roboto Regular
  6: { family: "'Roboto', sans-serif", weight: "500" },    // Roboto Medium
  7: { family: "'Roboto', sans-serif", weight: "700" },    // Roboto Bold
  8: { family: "'Roboto', sans-serif", weight: "900" },    // Roboto Black
  9: { family: "'Roboto', sans-serif", weight: "100", style: "italic" },
  10: { family: "'Roboto', sans-serif", weight: "300", style: "italic" },
  11: { family: "'Roboto', sans-serif", weight: "400", style: "italic" },
  12: { family: "'Roboto', sans-serif", weight: "500", style: "italic" },
  13: { family: "'Roboto', sans-serif", weight: "700", style: "italic" },
  14: { family: "'Roboto', sans-serif", weight: "900", style: "italic" },
  15: { family: "'Bitstream Vera Sans', sans-serif", weight: "bold" },
  16: { family: "'Bitstream Vera Sans', sans-serif", weight: "bold", style: "italic" },
  17: { family: "'Bitstream Vera Sans', sans-serif", weight: "normal", style: "italic" },
  18: { family: "'Bitstream Vera Sans Mono', monospace", weight: "bold" },
  19: { family: "'Bitstream Vera Sans Mono', monospace", weight: "bold", style: "italic" },
  20: { family: "'Bitstream Vera Sans Mono', monospace", weight: "normal", style: "italic" },
  21: { family: "'Bitstream Vera Sans Mono', monospace", weight: "normal" },
  22: { family: "'Bitstream Vera Serif', serif", weight: "bold" },
  23: { family: "'Bitstream Vera Serif', serif", weight: "normal" },
  24: { family: "'Bitstream Vera Sans', sans-serif", weight: "normal" },
};

// Default fallback for unmapped indices
const FONT_DEFAULT = { family: "monospace", weight: "normal" };

let visibleCanvas = null;
let visibleCtx = null;
let offCanvas = null;
let ctx = null; // offscreen context — all drawing targets this

// Current drawing state
let _curX = 0;
let _curY = 0;
let _fontSize = 8;
let _fontFace = 1;
let _fontEntry = FONT_TABLE[1] || FONT_DEFAULT;

function _levelToColor(l) {
  const v = Math.round(Math.max(0, Math.min(15, l)) * 255 / 15);
  return `rgb(${v},${v},${v})`;
}

function _applyFont() {
  const style = _fontEntry.style === "italic" ? "italic " : "";
  ctx.font = `${style}${_fontEntry.weight} ${_fontSize}px ${_fontEntry.family}`;
}

const screen = {
  WIDTH,
  HEIGHT,

  // Initialize with a visible canvas element.
  init(canvas) {
    visibleCanvas = canvas;
    visibleCanvas.width = WIDTH;
    visibleCanvas.height = HEIGHT;
    visibleCtx = visibleCanvas.getContext("2d");

    // Offscreen drawing buffer
    offCanvas = document.createElement("canvas");
    offCanvas.width = WIDTH;
    offCanvas.height = HEIGHT;
    ctx = offCanvas.getContext("2d");

    // Defaults
    ctx.imageSmoothingEnabled = false;
    visibleCtx.imageSmoothingEnabled = false;
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.textBaseline = "top";

    _curX = 0;
    _curY = 0;
    _fontSize = 8;
    _fontFace = 1;
    _fontEntry = FONT_TABLE[1] || FONT_DEFAULT;
    _applyFont();

    screen.clear();
    screen.update();
  },

  // Clear the offscreen buffer to black.
  clear() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
    ctx.beginPath();
    _curX = 0;
    _curY = 0;
  },

  // Copy offscreen buffer to visible canvas.
  update() {
    visibleCtx.drawImage(offCanvas, 0, 0);
  },

  // --- Drawing state ---

  level(l) {
    const c = _levelToColor(l);
    ctx.fillStyle = c;
    ctx.strokeStyle = c;
  },

  aa(state) {
    ctx.imageSmoothingEnabled = !!state;
  },

  line_width(w) {
    ctx.lineWidth = w;
  },

  line_cap(style) {
    ctx.lineCap = style;
  },

  line_join(style) {
    ctx.lineJoin = style;
  },

  // --- Path operations ---

  move(x, y) {
    _curX = x;
    _curY = y;
    ctx.moveTo(x, y);
  },

  move_rel(x, y) {
    _curX += x;
    _curY += y;
    ctx.moveTo(_curX, _curY);
  },

  line(x, y) {
    ctx.lineTo(x, y);
    _curX = x;
    _curY = y;
  },

  line_rel(x, y) {
    _curX += x;
    _curY += y;
    ctx.lineTo(_curX, _curY);
  },

  close() {
    ctx.closePath();
  },

  stroke() {
    ctx.stroke();
    ctx.beginPath();
  },

  fill() {
    ctx.fill();
    ctx.beginPath();
  },

  // --- Shape helpers ---

  rect(x, y, w, h) {
    ctx.rect(x, y, w, h);
  },

  rect_fill(x, y, w, h) {
    ctx.fillRect(x, y, w, h);
  },

  circle(x, y, r) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  },

  circle_fill(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
  },

  arc(x, y, r, a1, a2) {
    ctx.arc(x, y, r, a1, a2);
  },

  // Cairo-style curve_to: current point is P0, then (x1,y1)=CP1, (x2,y2)=CP2, (x3,y3)=end
  curve(x1, y1, x2, y2, x3, y3) {
    ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    _curX = x3;
    _curY = y3;
  },

  curve_rel(dx1, dy1, dx2, dy2, dx3, dy3) {
    const cx1 = _curX + dx1, cy1 = _curY + dy1;
    const cx2 = _curX + dx2, cy2 = _curY + dy2;
    const ex = _curX + dx3, ey = _curY + dy3;
    ctx.bezierCurveTo(cx1, cy1, cx2, cy2, ex, ey);
    _curX = ex;
    _curY = ey;
  },

  pixel(x, y) {
    ctx.fillRect(x, y, 1, 1);
  },

  // --- Text ---

  font_face(index) {
    _fontFace = index;
    _fontEntry = FONT_TABLE[index] || FONT_DEFAULT;
    _applyFont();
  },

  font_size(size) {
    _fontSize = size;
    _applyFont();
  },

  text(str) {
    ctx.textAlign = "left";
    ctx.fillText(str, _curX, _curY);
    // Advance cursor past the text (norns behavior)
    _curX += ctx.measureText(str).width;
  },

  text_right(str) {
    ctx.textAlign = "right";
    ctx.fillText(str, _curX, _curY);
  },

  text_center(str) {
    ctx.textAlign = "center";
    ctx.fillText(str, _curX, _curY);
  },

  text_extents(str) {
    const m = ctx.measureText(str);
    return {
      w: m.width,
      h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || _fontSize,
    };
  },

  text_rotate(x, y, str, degrees) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.textAlign = "left";
    ctx.fillText(str, 0, 0);
    ctx.restore();
  },

  text_center_rotate(x, y, str, degrees) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.textAlign = "center";
    ctx.fillText(str, 0, 0);
    ctx.restore();
  },

  // --- Transforms & state ---

  save() {
    ctx.save();
  },

  restore() {
    ctx.restore();
  },

  translate(x, y) {
    ctx.translate(x, y);
  },

  rotate(r) {
    ctx.rotate(r);
  },

  // --- Pixel access ---

  peek(x, y, w, h) {
    return ctx.getImageData(x, y, w, h);
  },

  poke(x, y, w, h, imageData) {
    ctx.putImageData(imageData, x, y);
  },
};

export { screen };
export default screen;
