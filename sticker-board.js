/*!
 * <sticker-board> — a desk of peelable digital stickers.
 *
 *   <script type="module" src="sticker-board.js"></script>
 *   <sticker-board height="560"></sticker-board>
 *
 * Peel a sticker from its edge, carry it (it floats with a shadow), drop it to stick.
 * Upload a photo and the main object in the centre is cut out into a new sticker.
 * Finishes: vinyl, matte, gloss, laminated, holographic, glitter.
 *
 * Attributes
 *   height       desk height in px (default 560)
 *   surface      "dots" (default) | "mat" | "plain"
 *   theme        "light" | "dark" (default follows the OS)
 *   storage-key  localStorage key, so several boards can live on one site
 *   no-starters  start with an empty desk
 *   desktop      the Sticker Desk Mac app's see-through desktop layer
 *   maker        just the sticker maker, filling the Mac app's window
 */

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';

const FINISHES = [
  { id: 'vinyl', label: 'Vinyl' },
  { id: 'matte', label: 'Matte' },
  { id: 'gloss', label: 'Gloss' },
  { id: 'laminate', label: 'Laminated' },
  { id: 'holo', label: 'Holo' },
  { id: 'glitter', label: 'Glitter' },
];
// Sticker sizes in the maker: the longest side on the desk, in px at full scale.
const SIZES = [
  { id: 's', label: 'Small', size: 130 },
  { id: 'm', label: 'Medium', size: 190 },
  { id: 'l', label: 'Large', size: 270 },
  { id: 'xl', label: 'Huge', size: 380 },
];
const DYNAMIC = new Set(['vinyl', 'gloss', 'laminate', 'holo', 'glitter']);
const PRESS_LIFT = 10; // px the edge lifts as soon as it's pressed
const EXPORT_LIGHT = { x: -0.35, y: -0.45 }; // fixed light for downloaded images

const REASONS = {
  small: 'The object looks too small. Move closer so it fills more of the frame.',
  fills: "The object fills the whole photo, so there's no background to cut it out from.",
  edges: 'The subject runs off the edges of the photo, so it can’t be cut out cleanly. Leave some space around it.',
  fragmented: 'We found lots of separate bits instead of one object. A plain, contrasting background helps.',
  unclear: "The object's outline is too blurry to cut out cleanly. Try a sharper photo with more contrast.",
  offcenter: 'The object is too far from the centre of the photo.',
  notimage: "That file isn't an image we can read. Try a JPG, PNG or WebP.",
  model: "The object finder couldn't load. Check your connection and try again.",
};

const STEPS = {
  read: 'Reading your photo…',
  model: 'Loading the object finder (first time only)…',
  find: 'Looking for the main object…',
  cut: 'Cutting it out…',
};

/* ---------------------------------------------------------------- utilities */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const rand = (a, b) => a + Math.random() * (b - a);
const uid = () => Math.random().toString(36).slice(2, 10);
// Lets the UI paint between heavy steps (a timer, so it still resolves in a background tab).
const nextFrame = () => new Promise((r) => setTimeout(r, 20));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function rotate(x, y, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

class StickerError extends Error {
  constructor(code) {
    super(REASONS[code] || code);
    this.code = code;
  }
}

/* ------------------------------------------------------- canvas primitives */

function silhouette(src, color) {
  const c = makeCanvas(src.width, src.height), x = c.getContext('2d');
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

// Grow a shape outward by r px (used for the die-cut white border and the laminate margin).
function dilate(src, r, color = '#fff') {
  const sil = silhouette(src, color);
  const c = makeCanvas(src.width, src.height), x = c.getContext('2d');
  for (const k of [1, 0.66, 0.33]) {
    const rr = r * k, steps = Math.max(12, Math.ceil((2 * Math.PI * rr) / 3));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      x.drawImage(sil, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  x.drawImage(sil, 0, 0);
  return c;
}

function alphaBBox(c, threshold = 12) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Turn a transparent cut-out into a die-cut sticker: tight crop, scaled, white border.
function stickerFromCutout(cut, { out = 480, border = 0.045 } = {}) {
  const bb = alphaBBox(cut);
  if (!bb) return null;
  const b = Math.round(out * border), pad = b + 6;
  const s = (out - 2 * pad) / Math.max(bb.w, bb.h);
  const w = bb.w * s + 2 * pad, h = bb.h * s + 2 * pad;
  const obj = makeCanvas(w, h), ox = obj.getContext('2d');
  ox.imageSmoothingQuality = 'high';
  ox.drawImage(cut, bb.x, bb.y, bb.w, bb.h, pad, pad, bb.w * s, bb.h * s);
  const res = makeCanvas(w, h), r = res.getContext('2d');
  r.drawImage(dilate(obj, b, '#fff'), 0, 0);
  r.drawImage(obj, 0, 0);
  return res;
}

/* ---------------------------------------------------------- shared textures */

let _tex = null;
function textures() {
  if (_tex) return _tex;
  // Glitter: neutral grey with bright flecks (neutral grey disappears under "overlay").
  const g = makeCanvas(96, 96), gx = g.getContext('2d'), gd = gx.createImageData(96, 96);
  for (let i = 0; i < gd.data.length; i += 4) {
    const v = Math.random() < 0.16 ? 150 + Math.random() * 105 : 128 + (Math.random() - 0.5) * 50;
    gd.data[i] = gd.data[i + 1] = gd.data[i + 2] = v;
    gd.data[i + 3] = 255;
  }
  gx.putImageData(gd, 0, 0);

  // Holographic foil: fine diagonal lines.
  const h = makeCanvas(48, 48), hx = h.getContext('2d');
  hx.lineWidth = 1.2;
  for (let i = -48; i < 96; i += 4) {
    hx.strokeStyle = i % 8 === 0 ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.35)';
    hx.beginPath();
    hx.moveTo(i, 0);
    hx.lineTo(i + 48, 48);
    hx.stroke();
  }

  // Sparkle sprite: soft dot with a four-point twinkle.
  const s = makeCanvas(64, 64), sx = s.getContext('2d');
  const rg = sx.createRadialGradient(32, 32, 0, 32, 32, 12);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  sx.fillStyle = rg;
  sx.fillRect(0, 0, 64, 64);
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const lg = sx.createLinearGradient(32 - dx * 32, 32 - dy * 32, 32 + dx * 32, 32 + dy * 32);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,.95)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    sx.fillStyle = lg;
    if (dx) sx.fillRect(0, 30.5, 64, 3);
    else sx.fillRect(30.5, 0, 3, 64);
  }
  return (_tex = { glitter: g, holo: h, sparkle: s });
}

/* ------------------------------------------------------------------ finishes */

function matteOf(src) {
  const c = makeCanvas(src.width, src.height), x = c.getContext('2d');
  x.drawImage(src, 0, 0);
  const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const n = (Math.random() - 0.5) * 14;
    for (let k = 0; k < 3; k++) {
      const v = l + (d[i + k] - l) * 0.8; // a little less saturated
      d[i + k] = clamp((v - 128) * 0.86 + 136 + n, 0, 255); // flatter, lifted blacks, paper grain
    }
  }
  x.putImageData(id, 0, 0);
  return c;
}

// Clear plastic margin around a slightly smaller sticker.
function laminateOf(src) {
  const w = src.width, h = src.height, s = 0.9;
  const inner = makeCanvas(w, h), ix = inner.getContext('2d');
  ix.drawImage(src, (w * (1 - s)) / 2, (h * (1 - s)) / 2, w * s, h * s);
  const m = Math.max(4, Math.round(Math.max(w, h) * 0.034));
  const outer = dilate(inner, m);
  const rim = dilate(inner, m), rx = rim.getContext('2d');
  rx.globalCompositeOperation = 'destination-out';
  rx.drawImage(dilate(inner, m - 2.5), 0, 0);
  const c = makeCanvas(w, h), x = c.getContext('2d');
  x.globalAlpha = 0.5;
  x.drawImage(silhouette(outer, 'rgb(226,234,242)'), 0, 0);
  x.globalAlpha = 0.95;
  x.drawImage(rim, 0, 0);
  x.globalAlpha = 1;
  x.drawImage(inner, 0, 0);
  return c;
}

// Renders one sticker with a finish, lit from L ({x,y} in -1..1).
class Finisher {
  constructor(src) {
    this.src = src;
    this.layers = {};
    this.out = makeCanvas(src.width, src.height);
    this.o = this.out.getContext('2d');
    this.key = '';
  }
  layer(f) {
    if (!this.layers[f]) {
      const base = f === 'matte' ? matteOf(this.src) : f === 'laminate' ? laminateOf(this.src) : this.src;
      this.layers[f] = { base };
    }
    return this.layers[f];
  }
  back(f) {
    const l = this.layer(f);
    return (l.back ||= silhouette(l.base, '#e7e3dc'));
  }
  alphaAt(f, u, v) {
    const l = this.layer(f), b = l.base;
    l.alpha ||= b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    const x = Math.floor(u * b.width), y = Math.floor(v * b.height);
    if (x < 0 || y < 0 || x >= b.width || y >= b.height) return 0;
    return l.alpha[(y * b.width + x) * 4 + 3];
  }
  sparkles(f) {
    const l = this.layer(f);
    if (!l.sparkles) {
      l.sparkles = [];
      const k = this.src.width / 480;
      for (let tries = 0; tries < 3000 && l.sparkles.length < 200; tries++) {
        const u = Math.random(), v = Math.random();
        if (this.alphaAt(f, u, v) > 220)
          l.sparkles.push({ x: u * this.src.width, y: v * this.src.height, r: rand(5, 13) * k, ph: rand(0, Math.PI * 2) });
      }
    }
    return l.sparkles;
  }
  compose(f, L) {
    const key = DYNAMIC.has(f) ? `${f}|${L.x.toFixed(3)}|${L.y.toFixed(3)}` : f;
    if (key !== this.key) {
      this.key = key;
      drawFinish(this, f, L);
    }
    return this.out;
  }
}

function drawFinish(fin, f, L) {
  const { o, out } = fin, base = fin.layer(f).base, T = textures();
  const w = out.width, h = out.height, R = Math.max(w, h);
  o.globalCompositeOperation = 'source-over';
  o.globalAlpha = 1;
  o.clearRect(0, 0, w, h);
  o.drawImage(base, 0, 0);
  if (f === 'matte') return;

  const lx = w * (0.5 + L.x * 0.6), ly = h * (0.5 + L.y * 0.6);
  const fill = (style, mode, alpha = 1) => {
    o.globalCompositeOperation = mode;
    o.globalAlpha = alpha;
    o.fillStyle = style;
    o.fillRect(0, 0, w, h);
  };
  const sheen = (a, radius) => {
    const g = o.createRadialGradient(lx, ly, 0, lx, ly, R * radius);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  };
  // A diagonal highlight band that slides across as the light moves.
  const streak = (a, width, offset = 0) => {
    const t = 0.5 + L.x * 0.45 + L.y * 0.25 + offset;
    const g = o.createLinearGradient(0, 0, w, h);
    g.addColorStop(clamp(t - width, 0, 1), 'rgba(255,255,255,0)');
    g.addColorStop(clamp(t, 0, 1), `rgba(255,255,255,${a})`);
    g.addColorStop(clamp(t + width, 0, 1), 'rgba(255,255,255,0)');
    return g;
  };

  switch (f) {
    case 'vinyl':
      fill(sheen(0.35, 0.9), 'soft-light');
      fill(streak(0.12, 0.2), 'screen');
      break;
    case 'gloss':
      fill(sheen(0.6, 0.9), 'soft-light');
      fill(sheen(0.3, 0.28), 'screen');
      fill(streak(0.5, 0.07), 'screen');
      fill(streak(0.22, 0.03, 0.14), 'screen');
      break;
    case 'laminate':
      fill('rgba(255,255,255,0.05)', 'screen');
      fill(sheen(0.5, 0.9), 'soft-light');
      fill(streak(0.6, 0.05), 'screen');
      fill(streak(0.25, 0.1, -0.2), 'screen');
      fill(sheen(0.22, 0.2), 'screen');
      break;
    case 'holo': {
      const ang = 0.7 + L.x * 0.9 - L.y * 0.4;
      const dx = Math.cos(ang) * R * 0.8, dy = Math.sin(ang) * R * 0.8;
      const g = o.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
      const shift = (L.x * 0.9 + L.y * 0.6) * 360;
      for (let i = 0; i <= 8; i++) {
        const hue = (((i / 8) * 720 + shift) % 360 + 360) % 360;
        g.addColorStop(i / 8, `hsl(${hue},100%,62%)`);
      }
      // Rainbow shows strongest on light areas (the white border), stays subtle over the image.
      fill(g, 'multiply', 0.22);
      fill(g, 'overlay', 0.4);
      fill(o.createPattern(T.holo, 'repeat'), 'overlay', 0.22);
      fill(streak(0.55, 0.06), 'screen');
      fill(sheen(0.25, 0.4), 'screen');
      break;
    }
    case 'glitter': {
      fill(o.createPattern(T.glitter, 'repeat'), 'overlay', 0.6);
      o.globalCompositeOperation = 'lighter';
      for (const s of fin.sparkles(f)) {
        const b = Math.pow(Math.max(0, Math.sin(s.ph + L.x * 4.2 + L.y * 3.1)), 10);
        if (b < 0.03) continue;
        const sz = s.r * (0.6 + b * 0.8);
        o.globalAlpha = b;
        o.drawImage(T.sparkle, s.x - sz, s.y - sz, sz * 2, sz * 2);
      }
      fill(sheen(0.2, 0.5), 'screen');
      break;
    }
  }
  o.globalAlpha = 1;
  o.globalCompositeOperation = 'destination-in';
  o.drawImage(base, 0, 0);
  o.globalCompositeOperation = 'source-over';
}

/* --------------------------------------------------------- starter stickers */

const STARTER_ART = {
  hello(x) {
    x.canvas.width = 900;
    x.canvas.height = 360;
    x.font = 'italic 800 190px ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    const g = x.createLinearGradient(100, 0, 800, 0);
    g.addColorStop(0, '#6e56ff');
    g.addColorStop(1, '#ff4f8b');
    x.fillStyle = x.strokeStyle = g;
    x.lineWidth = 14;
    x.lineJoin = 'round';
    x.strokeText('hello!', 450, 190);
    x.fillText('hello!', 450, 190);
  },
  smiley(x) {
    const g = x.createRadialGradient(240, 220, 20, 300, 300, 250);
    g.addColorStop(0, '#ffe46b');
    g.addColorStop(1, '#ffb703');
    x.fillStyle = g;
    x.beginPath();
    x.arc(300, 300, 240, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#3b2600';
    for (const ex of [222, 378]) {
      x.beginPath();
      x.ellipse(ex, 250, 26, 40, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = 'rgba(255,90,120,.35)';
    for (const ex of [170, 430]) {
      x.beginPath();
      x.ellipse(ex, 345, 38, 24, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.strokeStyle = '#3b2600';
    x.lineWidth = 30;
    x.lineCap = 'round';
    x.beginPath();
    x.arc(300, 310, 135, 0.2 * Math.PI, 0.8 * Math.PI);
    x.stroke();
  },
  star(x) {
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 115 : 255, a = -Math.PI / 2 + (i * Math.PI) / 5;
      x.lineTo(300 + Math.cos(a) * r, 315 + Math.sin(a) * r);
    }
    x.closePath();
    const g = x.createLinearGradient(100, 80, 500, 540);
    g.addColorStop(0, '#ffe66d');
    g.addColorStop(1, '#ff8f1f');
    x.fillStyle = x.strokeStyle = g;
    x.lineWidth = 46;
    x.lineJoin = 'round';
    x.stroke();
    x.fill();
    x.save();
    x.translate(300, 330);
    x.rotate(-0.12);
    x.font = '900 92px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = '#7a3500';
    x.fillText('wow', 0, 0);
    x.restore();
  },
  heart(x) {
    const p = new Path2D(
      'M300 530 C 90 380, 40 210, 160 130 C 230 85, 290 125, 300 175 C 310 125, 370 85, 440 130 C 560 210, 510 380, 300 530 Z'
    );
    const g = x.createLinearGradient(120, 100, 480, 520);
    g.addColorStop(0, '#ff7a93');
    g.addColorStop(1, '#e8173f');
    x.fillStyle = x.strokeStyle = g;
    x.lineWidth = 20;
    x.lineJoin = 'round';
    x.stroke(p);
    x.fill(p);
    x.fillStyle = 'rgba(255,255,255,.45)';
    x.beginPath();
    x.ellipse(195, 200, 42, 24, -0.7, 0, Math.PI * 2);
    x.fill();
  },
  rainbow(x) {
    const colors = ['#ff5a5f', '#ff9f1c', '#ffd23f', '#3ec97a', '#3aa0ff', '#8a5cff'];
    x.lineWidth = 40;
    colors.forEach((c, i) => {
      x.strokeStyle = c;
      x.beginPath();
      x.arc(300, 430, 240 - i * 38, Math.PI, Math.PI * 2);
      x.stroke();
    });
    for (const cx of [100, 500]) {
      x.fillStyle = '#ffffff';
      x.strokeStyle = '#d7e1ec';
      x.lineWidth = 8;
      const puffs = [[-50, 10, 46], [0, -12, 58], [52, 10, 44], [0, 30, 46]];
      for (const [dx, dy, r] of puffs) {
        x.beginPath();
        x.arc(cx + dx, 440 + dy, r, 0, Math.PI * 2);
        x.stroke();
      }
      for (const [dx, dy, r] of puffs) {
        x.beginPath();
        x.arc(cx + dx, 440 + dy, r, 0, Math.PI * 2);
        x.fill();
      }
    }
  },
};

const _starterCache = {};
function starterCanvas(name) {
  if (!_starterCache[name]) {
    const c = makeCanvas(600, 600);
    STARTER_ART[name](c.getContext('2d'));
    _starterCache[name] = stickerFromCutout(c, { border: 0.05 });
  }
  return _starterCache[name];
}

const STARTERS = [
  { starter: 'hello', size: 210, nx: 0.24, ny: 0.34, rot: -7, finish: 'holo' },
  { starter: 'smiley', size: 132, nx: 0.52, ny: 0.6, rot: 6, finish: 'gloss' },
  { starter: 'rainbow', size: 175, nx: 0.77, ny: 0.32, rot: 8, finish: 'laminate' },
  { starter: 'heart', size: 118, nx: 0.3, ny: 0.72, rot: -12, finish: 'glitter' },
  { starter: 'star', size: 140, nx: 0.74, ny: 0.72, rot: -5, finish: 'matte' },
];

/* --------------------------------------------------- photo → sticker pipeline */

let segmenterPromise = null;
function loadSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, InteractiveSegmenter } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      // CPU is plenty fast for this small model, and the GPU path can stall on some WebGL setups.
      return InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    })().catch((err) => {
      segmenterPromise = null;
      throw err;
    });
  }
  return segmenterPromise;
}

async function loadImage(file) {
  if (file.type && !file.type.startsWith('image/')) throw new StickerError('notimage');
  const url = URL.createObjectURL(file);
  try {
    return await imageFrom(url);
  } catch {
    throw new StickerError('notimage');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawScaled(img, max) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, max / Math.max(iw, ih));
  const c = makeCanvas(iw * s, ih * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function segmentAt(seg, canvas, x, y) {
  return new Promise((resolve, reject) => {
    try {
      seg.segment(canvas, { keypoint: { x, y } }, (res) => {
        const masks = res.confidenceMasks;
        const m = masks[masks.length - 1];
        resolve({ conf: m.getAsFloat32Array().slice(), W: m.width, H: m.height });
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Decides whether a mask describes one well-defined object.
function analyzeMask({ conf, W, H }) {
  const N = W * H, labels = new Int32Array(N), stack = new Int32Array(N);
  let area = 0, uncertain = 0;
  for (let i = 0; i < N; i++) {
    const c = conf[i];
    if (c > 0.5) area++;
    if (c > 0.2 && c < 0.8) uncertain++;
  }
  if (area < N * 0.01) return { fail: 'small', quality: -1 };

  let next = 0, main = 0, mainSize = 0;
  for (let i = 0; i < N; i++) {
    if (conf[i] <= 0.5 || labels[i]) continue;
    next++;
    let size = 0, sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    while (sp) {
      const p = stack[--sp], x = p % W;
      size++;
      if (x > 0 && !labels[p - 1] && conf[p - 1] > 0.5) (labels[p - 1] = next), (stack[sp++] = p - 1);
      if (x < W - 1 && !labels[p + 1] && conf[p + 1] > 0.5) (labels[p + 1] = next), (stack[sp++] = p + 1);
      if (p >= W && !labels[p - W] && conf[p - W] > 0.5) (labels[p - W] = next), (stack[sp++] = p - W);
      if (p < N - W && !labels[p + W] && conf[p + W] > 0.5) (labels[p + W] = next), (stack[sp++] = p + W);
    }
    if (size > mainSize) (mainSize = size), (main = next);
  }

  let sx = 0, sy = 0, border = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (labels[y * W + x] !== main) continue;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border++;
    }
  }
  const areaRatio = mainSize / N;
  const share = mainSize / area;
  const borderRatio = border / (2 * (W + H) - 4);
  const unc = uncertain / mainSize;
  const off = Math.hypot(sx / mainSize / W - 0.5, sy / mainSize / H - 0.5);

  let fail = null;
  if (areaRatio < 0.03) fail = 'small';
  else if (areaRatio > 0.9) fail = 'fills';
  else if (borderRatio > 0.3) fail = 'edges';
  else if (share < 0.7) fail = 'fragmented';
  else if (unc > 0.45) fail = 'unclear';
  else if (off > 0.3) fail = 'offcenter';

  return {
    fail, conf, W, H, labels, main,
    bbox: { x0, y0, x1, y1 },
    quality: share * (1 - unc) - off - borderRatio,
    metrics: { areaRatio, share, borderRatio, unc, off },
  };
}

// Intersection over union of two analysed masks' main objects.
function overlap(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.labels.length; i++) {
    const p = a.labels[i] === a.main, q = b.labels[i] === b.main;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union ? inter / union : 0;
}

function cutoutFromMask(src, a) {
  const { conf, W, H, labels, main, bbox } = a;
  const m = makeCanvas(W, H), mx = m.getContext('2d'), id = mx.createImageData(W, H), d = id.data;
  for (let y = Math.max(0, bbox.y0 - 4); y <= Math.min(H - 1, bbox.y1 + 4); y++) {
    for (let x = Math.max(0, bbox.x0 - 4); x <= Math.min(W - 1, bbox.x1 + 4); x++) {
      const i = y * W + x, lab = labels[i];
      if (lab && lab !== main) continue;
      const t = clamp((conf[i] - 0.35) / 0.3, 0, 1);
      d[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
    }
  }
  mx.putImageData(id, 0, 0);
  const out = makeCanvas(src.width, src.height), o = out.getContext('2d');
  o.drawImage(src, 0, 0);
  o.globalCompositeOperation = 'destination-in';
  o.drawImage(m, 0, 0, out.width, out.height);
  return out;
}

async function photoToSticker(file, onStep = () => {}) {
  onStep('read');
  const img = await loadImage(file);
  const src = drawScaled(img, 640);
  onStep('model');
  let seg;
  try {
    seg = await loadSegmenter();
  } catch (err) {
    console.warn('[sticker-board] segmenter failed to load', err);
    throw new StickerError('model');
  }
  onStep('find');
  await nextFrame();
  // Probe the centre and a few points around it, keep the cleanest object.
  const probes = [[0.5, 0.5], [0.5, 0.42], [0.5, 0.58], [0.42, 0.5], [0.58, 0.5]];
  const results = [];
  for (const [x, y] of probes) results.push(analyzeMask(await segmentAt(seg, src, x, y)));
  const best = results.filter((a) => !a.fail).sort((a, b) => b.quality - a.quality)[0];
  if (!best) throw new StickerError(results[0].fail);
  // A real main object is found no matter which point near the centre we probe;
  // patterns and busy scenes give a different blob for every probe.
  const agree = results.filter((a) => a.labels && overlap(best, a) > 0.6).length;
  if (agree < 3) throw new StickerError('fragmented');
  onStep('cut');
  await nextFrame();
  const sticker = stickerFromCutout(cutoutFromMask(src, best));
  if (!sticker) throw new StickerError('small');
  return sticker;
}

/* ------------------------------------------------------------------ Sticker */

class Sticker {
  constructor(board, data, src) {
    Object.assign(this, data);
    this.board = board;
    this.srcCanvas = src;
    this.fin = new Finisher(src);
    this.w = src.width;
    this.h = src.height;
    this.el = document.createElement('div');
    this.el.className = 'st';
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');
    this.flapCv = document.createElement('canvas');
    this.flapCtx = this.flapCv.getContext('2d');
    this.mode = 'rest';
    this.lift = this.squish = this.sway = this.tiltX = this.tiltY = this.wig = 0;
    this.opacity = 1;
    this.peel = null;
    this.L = { x: -0.3, y: -0.4 };
    this.drawnL = { x: 9, y: 9 };
    this.layout();
  }

  layout() {
    const b = this.board, longest = this.size * b.scale, s = longest / Math.max(this.w, this.h);
    this.dw = this.w * s;
    this.dh = this.h * s;
    this.pad = Math.round(Math.max(this.dw, this.dh) * 0.4);
    this.cw = this.dw + 2 * this.pad;
    this.ch = this.dh + 2 * this.pad;
    const dpr = (this.dpr = Math.min(2, window.devicePixelRatio || 1));
    this.cv.width = Math.round(this.cw * dpr);
    this.cv.height = Math.round(this.ch * dpr);
    this.cv.style.width = this.el.style.width = `${this.cw}px`;
    this.cv.style.height = this.el.style.height = `${this.ch}px`;
    this.flapCv.width = Math.ceil(this.dw * dpr);
    this.flapCv.height = Math.ceil(this.dh * dpr);
    if (this.mode === 'rest') {
      this.x = this.nx * b.W;
      this.y = this.ny * b.H;
    }
    this.dirty = this.moved = true;
  }

  get scaleNow() {
    return 1 + 0.07 * this.lift + this.squish;
  }
  get angle() {
    return this.rot + this.sway + this.wig;
  }

  toLocal(px, py) {
    const v = rotate(px - this.x, py - this.y, -this.angle), s = this.scaleNow;
    return { x: v.x / s + this.dw / 2, y: v.y / s + this.dh / 2 };
  }

  alphaLocal(l) {
    return this.fin.alphaAt(this.finish, l.x / this.dw, l.y / this.dh);
  }

  hit(p, tol) {
    const l = this.toLocal(p.x, p.y);
    if (this.alphaLocal(l) > 60) return l;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.alphaLocal({ x: l.x + Math.cos(a) * tol, y: l.y + Math.sin(a) * tol }) > 60) return l;
    }
    return null;
  }

  // Is this local point close enough to the outline to get a fingernail under it?
  edgeAt(l) {
    const band = clamp(Math.min(this.dw, this.dh) * 0.2, 14, 30);
    let ox = 0, oy = 0, n = 0;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
      for (const r of [band * 0.5, band]) {
        if (this.alphaLocal({ x: l.x + cx * r, y: l.y + cy * r }) < 100) {
          const wgt = band / r;
          ox += cx * wgt;
          oy += cy * wgt;
          n++;
        }
      }
    }
    if (!n) return null;
    let len = Math.hypot(ox, oy);
    if (len < 1e-3) {
      // Thin sliver: fall back to pointing away from the centre.
      ox = l.x - this.dw / 2;
      oy = l.y - this.dh / 2;
      len = Math.hypot(ox, oy) || 1;
    }
    return { inward: { x: -ox / len, y: -oy / len } };
  }

  detachDistance() {
    return clamp(Math.min(this.dw, this.dh) * 0.45, 40, 100);
  }

  update(dt, now) {
    let draw = this.dirty, move = this.moved;
    this.dirty = this.moved = false;
    const k = (base) => 1 - Math.pow(1 - base, dt / 16.67);

    const Lt = this.board.lightFor(this);
    this.L.x = lerp(this.L.x, Lt.x, k(0.2));
    this.L.y = lerp(this.L.y, Lt.y, k(0.2));
    if (DYNAMIC.has(this.finish) &&
        (Math.abs(this.L.x - this.drawnL.x) > 0.004 || Math.abs(this.L.y - this.drawnL.y) > 0.004)) draw = true;

    const p = this.peel;
    if (p) {
      const kk = k(p.active ? 0.5 : 0.25);
      const px = lerp(p.P.x, p.T.x, kk), py = lerp(p.P.y, p.T.y, kk);
      if (Math.abs(px - p.P.x) + Math.abs(py - p.P.y) > 0.02) {
        p.P.x = px;
        p.P.y = py;
        draw = true;
      }
      if (!p.active && Math.hypot(p.P.x - p.C.x, p.P.y - p.C.y) < 0.5) {
        this.peel = null;
        draw = true;
      }
    }

    if (this.mode === 'float') {
      this.lift = lerp(this.lift, 1, k(0.18));
      const g = this.grab, t = easeOutCubic(clamp((now - g.t0) / 240, 0, 1));
      const gl = { x: lerp(g.from.x, g.to.x, t), y: lerp(g.from.y, g.to.y, t) };
      const s = this.scaleNow, v = rotate((gl.x - this.dw / 2) * s, (gl.y - this.dh / 2) * s, this.angle);
      const P = this.board.pointer;
      const nx = lerp(this.x, P.x - v.x, k(0.45)), ny = lerp(this.y, P.y - v.y, k(0.45));
      const vx = ((nx - this.x) / dt) * 16, vy = ((ny - this.y) / dt) * 16;
      this.x = nx;
      this.y = ny;
      this.sway = lerp(this.sway, clamp(vx * 0.9, -14, 14), k(0.12));
      this.tiltY = lerp(this.tiltY, clamp(vx * 1.3, -20, 20), k(0.15));
      this.tiltX = lerp(this.tiltX, clamp(-vy * 1.3, -20, 20), k(0.15));
      move = true;
    } else if (this.mode === 'drop') {
      const t = clamp((now - this.dropT0) / 300, 0, 1);
      this.lift = this.dropFrom * (1 - easeOutCubic(t));
      this.squish = t > 0 && t < 1 ? -Math.sin(Math.PI * t) * 0.03 : 0;
      this.tiltX = lerp(this.tiltX, 0, k(0.3));
      this.tiltY = lerp(this.tiltY, 0, k(0.3));
      if (t >= 1) {
        this.mode = 'rest';
        this.lift = this.squish = this.tiltX = this.tiltY = 0;
      }
      move = true;
    } else if (this.mode === 'remove') {
      const t = clamp((now - this.dropT0) / 320, 0, 1);
      this.squish = -easeOutCubic(t) * 0.9;
      this.opacity = 1 - t;
      this.rot += dt * 0.25;
      if (t >= 1) this.board.forget(this);
      move = true;
    }

    if (this.wiggleT) {
      const t = (now - this.wiggleT) / 520;
      if (t >= 1) (this.wiggleT = 0), (this.wig = 0);
      else this.wig = Math.sin(t * Math.PI * 6) * (1 - t) * 4;
      move = true;
    }

    if (move) this.applyStyle();
    if (draw) this.render();
  }

  applyStyle() {
    const f = clamp(this.lift, 0, 1.6), s = this.el.style;
    s.transform = `translate3d(${this.x - this.cw / 2}px, ${this.y - this.ch / 2}px, 0) scale(${this.scaleNow})`;
    s.filter =
      `drop-shadow(0 ${0.6 + 14 * f}px ${0.8 + 16 * f}px rgba(0,0,0,${0.26 - 0.08 * Math.min(f, 1)})) ` +
      `drop-shadow(0 ${0.4 + 3 * f}px ${0.6 + 3 * f}px rgba(0,0,0,${0.1 + 0.05 * Math.min(f, 1)}))`;
    s.opacity = this.opacity;
    s.zIndex = this.mode === 'float' ? 5000 : this.z;
    this.cv.style.transform =
      `perspective(900px) rotateX(${this.tiltX}deg) rotateY(${this.tiltY}deg) rotate(${this.angle}deg)`;
  }

  render() {
    const x = this.ctx, dpr = this.dpr, dw = this.dw, dh = this.dh;
    this.drawnL = { ...this.L };
    const img = this.fin.compose(this.finish, this.L);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, this.cv.width, this.cv.height);
    x.setTransform(dpr, 0, 0, dpr, this.pad * dpr, this.pad * dpr);

    const p = this.peel;
    const len = p ? Math.hypot(p.P.x - p.C.x, p.P.y - p.C.y) : 0;
    if (len < 0.5) {
      x.drawImage(img, 0, 0, dw, dh);
      return;
    }

    // Fold line = perpendicular bisector of grab point C and where it's been pulled to, P.
    const { C, P } = p;
    const nx = (P.x - C.x) / len, ny = (P.y - C.y) / len;
    const mx = (C.x + P.x) / 2, my = (C.y + P.y) / 2;
    const tx = -ny, ty = nx, G = 5000;
    const half = (c, sgn) => {
      c.beginPath();
      c.moveTo(mx + tx * G, my + ty * G);
      c.lineTo(mx - tx * G, my - ty * G);
      c.lineTo(mx - tx * G + sgn * nx * G, my - ty * G + sgn * ny * G);
      c.lineTo(mx + tx * G + sgn * nx * G, my + ty * G + sgn * ny * G);
      c.closePath();
    };

    // Still-stuck part.
    x.save();
    half(x, 1);
    x.clip();
    x.drawImage(img, 0, 0, dw, dh);
    x.restore();

    // Peeled flap: the back of the sticker, shaded like it curls at the fold.
    const f = this.flapCtx;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, this.flapCv.width, this.flapCv.height);
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    f.save();
    half(f, -1);
    f.clip();
    f.drawImage(this.fin.back(this.finish), 0, 0, dw, dh);
    f.globalCompositeOperation = 'source-atop';
    const g = f.createLinearGradient(mx, my, mx - nx * len * 0.5, my - ny * len * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,.22)');
    g.addColorStop(0.07, 'rgba(255,255,255,.65)');
    g.addColorStop(0.3, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,.1)');
    f.fillStyle = g;
    f.fillRect(-dw, -dh, dw * 3, dh * 3);
    f.restore();

    // Mirror the flap across the fold line.
    const m = mx * nx + my * ny;
    x.save();
    x.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * m * nx, 2 * m * ny);
    x.shadowColor = 'rgba(0,0,0,.3)';
    x.shadowBlur = (3 + len * 0.1) * dpr;
    x.shadowOffsetY = (1 + len * 0.05) * dpr;
    x.drawImage(this.flapCv, 0, 0, dw, dh);
    x.restore();
  }

  toJSON() {
    const { id, kind, starter, name, src, size, nx, ny, rot, finish, z } = this;
    return { id, kind, starter, name, src: kind === 'user' ? src : undefined, size, nx, ny, rot, finish, z };
  }
}

/* ------------------------------------------------------------------- markup */

const ICON = {
  plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  reset: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  photo: '<svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="9" width="36" height="30" rx="6"/><circle cx="18" cy="20" r="4"/><path d="M42 31l-9-9-17 17"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  wallpaper: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 21h6M12 17v4"/><circle cx="15.5" cy="9" r="2"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
};

const CSS = `
:host {
  display: block;
  --sb-height: 560px;
  --sb-radius: 22px;
  --sb-desk: #f3f0ea;
  --sb-dot: rgba(40, 30, 10, .11);
  --sb-ink: #1c1b1f;
  --sb-muted: #6d6a72;
  --sb-panel: #ffffff;
  --sb-line: rgba(0, 0, 0, .1);
  --sb-chip: #f2f0ec;
  --sb-accent: #1c1b1f;
  --sb-accent-ink: #ffffff;
  --sb-danger: #e5484d;
  --sb-mat: #2e6a57;
  color: var(--sb-ink);
  font-family: inherit;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --sb-desk: #1c1c1f; --sb-dot: rgba(255,255,255,.08); --sb-ink: #f2f1f4; --sb-muted: #a09ca6;
    --sb-panel: #2a2a2e; --sb-line: rgba(255,255,255,.12); --sb-chip: #36363b;
    --sb-accent: #f2f1f4; --sb-accent-ink: #1c1b1f; --sb-mat: #1f4c3e;
  }
}
:host([theme="dark"]) {
  --sb-desk: #1c1c1f; --sb-dot: rgba(255,255,255,.08); --sb-ink: #f2f1f4; --sb-muted: #a09ca6;
  --sb-panel: #2a2a2e; --sb-line: rgba(255,255,255,.12); --sb-chip: #36363b;
  --sb-accent: #f2f1f4; --sb-accent-ink: #1c1b1f; --sb-mat: #1f4c3e;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
[hidden] { display: none !important; }

.desk {
  position: relative; height: var(--sb-height); border-radius: var(--sb-radius); overflow: hidden;
  background-color: var(--sb-desk);
  background-image: radial-gradient(var(--sb-dot) 1.1px, transparent 1.6px);
  background-size: 22px 22px; background-position: 11px 11px;
  touch-action: pan-y; user-select: none; -webkit-user-select: none; isolation: isolate;
  box-shadow: inset 0 0 0 1px var(--sb-line);
}
:host([surface="plain"]) .desk { background-image: none; }
:host([surface="mat"]) .desk {
  --sb-muted: rgba(255,255,255,.7);
  background-color: var(--sb-mat);
  background-image:
    linear-gradient(rgba(255,255,255,.22) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.22) 1px, transparent 1px),
    linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px);
  background-size: 100px 100px, 100px 100px, 20px 20px, 20px 20px;
  background-position: -1px -1px;
}
.desk.grab { cursor: grab; }
.desk.grabbing, .desk.grabbing * { cursor: grabbing !important; }

.st { position: absolute; left: 0; top: 0; pointer-events: none; transform-origin: 50% 50%; will-change: transform, filter; }
.st canvas { display: block; transform-origin: 50% 50%; }

.ui { position: absolute; z-index: 100000; }
.controls { top: 14px; right: 14px; display: flex; gap: 8px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 16px;
  border-radius: 999px; border: 0; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap;
  background: var(--sb-panel); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 0 0 1px var(--sb-line);
  transition: transform .15s ease, background-color .15s ease;
}
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: translateY(0) scale(.98); }
.btn:focus-visible, .chip:focus-visible, .drop:focus-within { outline: 2px solid #4c8dff; outline-offset: 2px; }
.btn.primary { background: var(--sb-accent); color: var(--sb-accent-ink); box-shadow: none; }
.btn.icon { width: 40px; padding: 0; }
.btn.armed { background: var(--sb-danger); color: #fff; width: auto; padding: 0 14px; }

.caption {
  left: 16px; bottom: 14px; font-size: 12.5px; color: var(--sb-muted); pointer-events: none;
  display: flex; gap: 6px; align-items: center;
}
.caption b { font-weight: 600; }

.bin {
  right: 16px; bottom: 16px; width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center;
  background: var(--sb-panel); box-shadow: 0 6px 18px rgba(0,0,0,.14), 0 0 0 1px var(--sb-line);
  opacity: 0; transform: scale(.6); transition: transform .2s cubic-bezier(.3,1.6,.6,1), opacity .2s, background-color .2s, color .2s;
  pointer-events: none; z-index: 4000;
}
.bin.show { opacity: 1; transform: scale(1); }
.bin.hot { background: var(--sb-danger); color: #fff; transform: scale(1.18); }

.toolbar {
  left: 0; top: 0; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 2px;
  max-width: calc(100% - 16px); padding: 5px; border-radius: 16px;
  background: var(--sb-panel); box-shadow: 0 10px 30px rgba(0,0,0,.16), 0 0 0 1px var(--sb-line);
  animation: pop .18s cubic-bezier(.3,1.5,.6,1);
}
.toolbar .sep { width: 1px; align-self: stretch; margin: 4px 3px; background: var(--sb-line); }
.chip {
  display: inline-flex; flex-direction: column; align-items: center; gap: 4px; min-width: 52px; padding: 6px 6px 5px;
  border: 0; border-radius: 11px; background: transparent; cursor: pointer; font-size: 11px; font-weight: 600; color: var(--sb-muted);
}
.chip:hover { background: var(--sb-chip); }
.chip[aria-checked="true"] { background: var(--sb-chip); color: var(--sb-ink); }
.chip[aria-checked="true"] .sw { box-shadow: 0 0 0 2px var(--sb-panel), 0 0 0 4px var(--sb-ink); }
.chip.danger:hover { color: var(--sb-danger); }
.sw { width: 22px; height: 22px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.sw[data-f="vinyl"] { background: linear-gradient(135deg, #fff 30%, #e4e2ea); }
.sw[data-f="matte"] { background: #d7d3cb; }
.sw[data-f="gloss"] { background: radial-gradient(circle at 32% 30%, #fff 0 18%, #c9d2e3 55%, #9eabc4); }
.sw[data-f="laminate"] { background: radial-gradient(circle at 32% 30%, #fff 0 16%, #dce7f2 52%, #b9cadb); box-shadow: inset 0 0 0 3px rgba(255,255,255,.75), inset 0 0 0 4px rgba(0,0,0,.12); }
.sw[data-f="holo"] { background: conic-gradient(from 120deg, #ff9ad5, #ffe08a, #9effc4, #8ad8ff, #c39bff, #ff9ad5); }
.sw[data-f="glitter"] { background: radial-gradient(#fff 1px, transparent 1.6px) 0 0 / 5px 5px, linear-gradient(135deg, #f6d365, #fda085); }
.chip .ico { width: 22px; height: 22px; display: grid; place-items: center; }

.toast {
  left: 0; top: 0; padding: 8px 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
  background: var(--sb-accent); color: var(--sb-accent-ink); pointer-events: none; white-space: nowrap;
  opacity: 0; transition: opacity .2s; z-index: 100002;
}
.toast.show { opacity: 1; }

.dropzone-hint {
  inset: 10px; border-radius: calc(var(--sb-radius) - 6px); border: 2px dashed currentColor; display: grid; place-items: center;
  font-weight: 700; font-size: 18px; background: color-mix(in srgb, var(--sb-desk) 80%, transparent); pointer-events: none;
}

.studio {
  inset: 0; z-index: 100003; display: grid; place-items: center; padding: 16px;
  background: rgba(18, 16, 22, .32); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: fade .2s ease;
}
.panel {
  position: relative; width: min(440px, 100%); max-height: 100%; overflow: auto; padding: 20px;
  background: var(--sb-panel); border-radius: 24px; box-shadow: 0 24px 60px rgba(0,0,0,.25);
  animation: pop .25s cubic-bezier(.3,1.4,.6,1);
}
.panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.panel h3 { margin: 0; font-size: 18px; letter-spacing: -.01em; }
.panel h4 { margin: 14px 0 4px; font-size: 17px; text-align: center; letter-spacing: -.01em; }
.panel p { margin: 0; color: var(--sb-muted); font-size: 14px; line-height: 1.45; text-align: center; }
.panel .lead { color: var(--sb-ink); font-weight: 600; }
.panel .why { margin-top: 6px; }
.close { width: 34px; height: 34px; }

.drop {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 30px 16px; cursor: pointer;
  border: 2px dashed var(--sb-line); border-radius: 18px; text-align: center; color: var(--sb-muted);
  transition: border-color .15s, background-color .15s;
}
.drop:hover, .drop.over { border-color: var(--sb-ink); background: var(--sb-chip); }
.drop strong { color: var(--sb-ink); font-size: 15px; }
.drop u { color: var(--sb-ink); }
.drop input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.tips { list-style: none; padding: 0; margin: 14px 0 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.tips li { padding: 10px 8px; border-radius: 12px; background: var(--sb-chip); font-size: 12px; text-align: center; color: var(--sb-muted); line-height: 1.3; }
.tips li b { display: block; color: var(--sb-ink); font-size: 12.5px; margin-bottom: 2px; }

.thumb {
  position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: 16px; overflow: hidden; background: var(--sb-chip);
}
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.scan {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, transparent 0 40%, rgba(120,170,255,.38) 50%, transparent 60% 100%);
  background-size: 100% 220%; animation: scan 1.4s ease-in-out infinite;
}
.thumb::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 46%; aspect-ratio: 1; transform: translate(-50%,-50%);
  border: 2px dashed rgba(255,255,255,.9); border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,.15);
  animation: spin 6s linear infinite;
}
.thumb.bad img { filter: grayscale(.6) brightness(.85); }
.thumb.bad::after { border-color: var(--sb-danger); animation: none; box-shadow: 0 0 0 999px rgba(0,0,0,.18); }
.badge {
  position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; transform: translate(-50%,-50%); border-radius: 50%;
  display: grid; place-items: center; background: var(--sb-danger); color: #fff; z-index: 1; box-shadow: 0 4px 12px rgba(0,0,0,.25);
}
.step { margin-top: 12px !important; font-weight: 600; color: var(--sb-ink) !important; }
.step::after { content: ""; display: inline-block; width: 12px; }

.preview {
  height: 250px; display: grid; place-items: center; border-radius: 18px; background-color: var(--sb-desk);
  background-image: radial-gradient(var(--sb-dot) 1.1px, transparent 1.6px); background-size: 18px 18px;
  perspective: 700px;
}
.preview canvas {
  width: var(--pv-size, 170px); height: var(--pv-size, 170px); filter: drop-shadow(0 10px 14px rgba(0,0,0,.22));
  transition: transform .08s linear, width .2s ease, height .2s ease;
}
.finishes { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; margin: 14px 0 4px; }
.sizes { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin: 6px 0 2px; }
.sizes .label { align-self: center; margin-right: 6px; font-size: 12px; font-weight: 600; color: var(--sb-muted); }
.sz {
  height: 30px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; cursor: pointer;
  font-size: 12.5px; font-weight: 600; color: var(--sb-muted);
}
.sz:hover { background: var(--sb-chip); }
.sz[aria-checked="true"] { background: var(--sb-accent); color: var(--sb-accent-ink); }
.sz:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
.row { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.row .btn { flex: 1; }
.row .btn.icon { flex: none; }
.btn[aria-pressed="true"] { background: var(--sb-accent); color: var(--sb-accent-ink); }

:host([desktop]) .desk { height: 100vh; border-radius: 0; background: transparent !important; box-shadow: none; }
:host([desktop]) .controls, :host([desktop]) .caption, :host([desktop]) .wallbar { display: none !important; }

/* The Mac app's window: the sticker maker is the whole page. */
:host([maker]) { height: 100%; }
:host([maker]) .desk { height: 100%; border-radius: 0; box-shadow: none; background: var(--sb-panel) !important; }
:host([maker]) .layer, :host([maker]) .controls, :host([maker]) .caption, :host([maker]) .wallbar,
:host([maker]) .bin, :host([maker]) .toolbar, :host([maker]) .close { display: none !important; }
:host([maker]) .studio { padding: 0; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; animation: none; }
:host([maker]) .panel {
  width: 100%; height: 100%; max-height: none; padding: 8px 28px 24px; border-radius: 0; box-shadow: none;
  background: transparent; animation: none;
}
:host([maker]) .panel { display: flex; flex-direction: column; }
:host([maker]) .panel header { display: none; }
:host([maker]) section:not([hidden]) { flex: 1; min-height: 0; display: flex; flex-direction: column; }
:host([maker]) .drop { flex: 1; justify-content: center; }
:host([maker]) .thumb { aspect-ratio: auto; flex: 1; min-height: 220px; }
:host([maker]) .preview { height: auto; flex: 1; min-height: 240px; }
:host([maker]) .toast { z-index: 100004; }

.desk.wall { height: auto; aspect-ratio: var(--sb-aspect, 16 / 10); }
.desk.wall .caption { display: none; }
.wallbar {
  left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 6px;
  width: max-content; max-width: calc(100% - 24px); padding: 6px; border-radius: 26px;
  background: var(--sb-panel); box-shadow: 0 10px 30px rgba(0,0,0,.16), 0 0 0 1px var(--sb-line);
}
.wallbar .btn { height: 36px; box-shadow: none; background: var(--sb-chip); }
.wallbar .btn.primary { background: var(--sb-accent); }
.wallbar .btn.icon { width: 36px; }
.wallbar label input { position: absolute; width: 1px; height: 1px; opacity: 0; }

@keyframes pop { from { transform: scale(.92); opacity: 0; } }
@keyframes fade { from { opacity: 0; } }
@keyframes scan { 0% { background-position: 0 100%; } 100% { background-position: 0 0%; } }
@keyframes spin { to { transform: translate(-50%,-50%) rotate(360deg); } }
@media (max-width: 520px) {
  .controls .label { display: none; }
  .controls .btn:not(.reset) { width: 40px; padding: 0; }
  .wallbar .label { display: none; }
  .wallbar label.btn { width: 36px; padding: 0; }
  .caption .long { display: none; }
  .chip { min-width: 46px; }
  .row { flex-wrap: wrap; }
  .row .btn.primary { flex-basis: 100%; order: -1; }
  .sizes .label { display: none; }
}
@media (prefers-reduced-motion: reduce) { .scan, .thumb::after { animation: none; } }
`;

const finishChips = (cls) =>
  FINISHES.map(
    (f) =>
      `<button class="chip ${cls}" role="radio" aria-checked="false" data-f="${f.id}" title="${f.label}"><span class="sw" data-f="${f.id}"></span>${f.label}</button>`
  ).join('');

const HTML = `
<div class="desk" part="desk">
  <div class="layer"></div>
  <div class="ui controls">
    <button class="btn primary make" title="Make a sticker from a photo">${ICON.plus}<span class="label">Make a sticker</span></button>
    <button class="btn wall" aria-pressed="false" title="Arrange stickers on your wallpaper and download it">${ICON.wallpaper}<span class="label">Wallpaper</span></button>
    <button class="btn icon reset" title="Reset the desk" aria-label="Reset the desk">${ICON.reset}</button>
  </div>
  <div class="ui caption"><b>Peel from an edge</b><span>· drag · let go to stick</span><span class="long">· scroll to rotate</span></div>
  <div class="ui wallbar" hidden>
    <label class="btn" title="Use your own wallpaper as the background">${ICON.image}<span class="label">Background</span><input type="file" accept="image/*"></label>
    <button class="btn icon wall-clear" title="Back to the plain desk" aria-label="Remove background image" hidden>${ICON.close}</button>
    <button class="btn primary wall-dl">${ICON.download}<span>Download wallpaper</span></button>
    <button class="btn wall-done">Done</button>
  </div>
  <div class="ui bin" aria-hidden="true">${ICON.trash}</div>
  <div class="ui toolbar" role="toolbar" aria-label="Sticker finish" hidden>
    ${finishChips('tb')}
    <span class="sep"></span>
    <button class="chip dl" title="Save this sticker as a PNG image"><span class="ico">${ICON.download}</span>Download</button>
    <button class="chip danger del" title="Peel off for good"><span class="ico">${ICON.trash}</span>Remove</button>
  </div>
  <div class="ui toast"></div>
  <div class="ui dropzone-hint" hidden>Drop a photo to make a sticker</div>
  <div class="ui studio" hidden>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="sb-title">
      <header>
        <h3 id="sb-title">Make a sticker</h3>
        <button class="btn icon close" aria-label="Close">${ICON.close}</button>
      </header>
      <section data-state="pick">
        <label class="drop">
          <input type="file" accept="image/*">
          ${ICON.photo}
          <strong>Drop a photo here</strong>
          <span>or <u>browse your files</u></span>
        </label>
        <ul class="tips">
          <li><b>One object</b>a single clear subject</li>
          <li><b>Centred</b>in the middle of the frame</li>
          <li><b>Contrast</b>on a plain background</li>
        </ul>
      </section>
      <section data-state="work" hidden>
        <div class="thumb"><img alt=""><div class="scan"></div></div>
        <p class="step" aria-live="polite"></p>
      </section>
      <section data-state="error" hidden>
        <div class="thumb bad"><img alt=""><div class="badge">${ICON.alert}</div></div>
        <h4>No clear object found</h4>
        <p class="lead">Upload an image with a clear object in the centre.</p>
        <p class="why"></p>
        <div class="row"><button class="btn primary retry">Try another photo</button></div>
      </section>
      <section data-state="done" hidden>
        <div class="preview"><canvas width="420" height="420"></canvas></div>
        <div class="finishes" role="radiogroup" aria-label="Finish">${finishChips('pv')}</div>
        <div class="sizes" role="radiogroup" aria-label="Size"><span class="label">Size</span>${SIZES.map(
          (z) => `<button class="sz" role="radio" aria-checked="false" data-s="${z.id}">${z.label}</button>`
        ).join('')}</div>
        <div class="row">
          <button class="btn again">Start over</button>
          <button class="btn pv-dl" title="Save this sticker as a PNG image">${ICON.download}Download</button>
          <button class="btn primary place">Stick it on the desk</button>
        </div>
      </section>
    </div>
  </div>
</div>`;

/* --------------------------------------------------------------- the board */

class StickerBoard extends HTMLElement {
  static get observedAttributes() {
    return ['height'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.stickers = [];
    this.W = 0;
    this.H = 0;
    this.scale = 1;
    this.zTop = 1;
    this.pointer = { x: 0, y: 0 };
    this.pointerClient = null;
    this.drag = null;
    this.job = 0;
  }

  attributeChangedCallback() {
    this.style.setProperty('--sb-height', `${parseInt(this.getAttribute('height'), 10) || 560}px`);
  }

  connectedCallback() {
    if (this.desk) return;
    this.attributeChangedCallback();
    const root = this.shadowRoot;
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (s) => root.querySelector(s);
    Object.assign(this, {
      desk: $('.desk'), layer: $('.layer'), toolbar: $('.toolbar'), bin: $('.bin'), toastEl: $('.toast'),
      studio: $('.studio'), fileInput: $('.drop input'), dropHint: $('.dropzone-hint'),
      resetBtn: $('.reset'), previewCv: $('.preview canvas'),
    });
    this.previewCtx = this.previewCv.getContext('2d');
    this.bind();
    this.measure();
    this.restore();
    this.last = performance.now();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.io?.disconnect();
    for (const [t, ev, fn, o] of this.globals || []) t.removeEventListener(ev, fn, o);
    this.desk = null;
  }

  /* ---- events */

  bind() {
    const d = this.desk, on = (t, ev, fn, o) => (t.addEventListener(ev, fn, o), [t, ev, fn, o]);
    on(d, 'pointerdown', (e) => this.onDown(e));
    on(d, 'pointermove', (e) => this.onMove(e));
    on(d, 'pointerup', (e) => this.onUp(e, false));
    on(d, 'pointercancel', (e) => this.onUp(e, true));
    on(d, 'pointerleave', () => !this.drag && this.hover(null));
    on(d, 'touchstart', (e) => {
      // Stop the page from scrolling when a finger lands on a sticker.
      if (this.isUI(e)) return;
      const t = e.touches[0], r = d.getBoundingClientRect();
      if (this.pick({ x: t.clientX - r.left, y: t.clientY - r.top }, 10)) e.preventDefault();
    }, { passive: false });
    on(d, 'wheel', (e) => {
      if (this.drag?.mode !== 'float') return;
      e.preventDefault();
      this.drag.st.rot += clamp(e.deltaY, -60, 60) * 0.25;
    }, { passive: false });

    // Files dragged onto the desk.
    let depth = 0;
    on(d, 'dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      depth++;
      this.dropHint.hidden = !this.studio.hidden;
    });
    on(d, 'dragover', (e) => e.dataTransfer?.types?.includes?.('Files') && e.preventDefault());
    on(d, 'dragleave', () => {
      if (--depth <= 0) (depth = 0), (this.dropHint.hidden = true);
    });
    on(d, 'drop', (e) => {
      depth = 0;
      this.dropHint.hidden = true;
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      this.openStudio(file);
    });

    const root = this.shadowRoot;
    root.querySelector('.make').addEventListener('click', () => this.openStudio());
    this.resetBtn.addEventListener('click', () => this.onReset());
    root.querySelector('.close').addEventListener('click', () => this.closeStudio());
    root.querySelector('.retry').addEventListener('click', () => this.setStudio('pick'));
    root.querySelector('.again').addEventListener('click', () => this.setStudio('pick'));
    root.querySelector('.place').addEventListener('click', () => this.placePending());
    this.studio.addEventListener('pointerdown', (e) => e.target === this.studio && this.closeStudio());
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files[0];
      this.fileInput.value = '';
      if (f) this.processFile(f);
    });
    const drop = root.querySelector('.drop');
    drop.addEventListener('dragover', () => drop.classList.add('over'));
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', () => drop.classList.remove('over'));

    for (const chip of root.querySelectorAll('.chip.tb')) {
      chip.addEventListener('click', () => {
        const st = this.selected;
        if (!st) return;
        st.finish = chip.dataset.f;
        st.fin.key = '';
        st.dirty = true;
        this.syncChips('.chip.tb', st.finish);
        this.save();
      });
    }
    root.querySelector('.del').addEventListener('click', () => this.selected && this.remove(this.selected));
    root.querySelector('.chip.dl').addEventListener('click', () => {
      const st = this.selected;
      if (!st) return;
      downloadCanvas(finished(st.fin, st.finish), stickerFileName(st.name || st.starter, st.finish), root);
    });
    root.querySelector('.pv-dl').addEventListener('click', () => {
      if (!this.pending) return;
      downloadCanvas(finished(this.pendingFin, this.pendingFinish), stickerFileName(this.pendingName, this.pendingFinish), root);
    });

    // Bridge for the Sticker Desk Mac app (see /desktop).
    if (this.hasAttribute('desktop')) {
      window.__sd = {
        wants: (x, y) => {
          this.pointerClient = { x, y, t: performance.now() };
          return this.wantsPointer(x, y);
        },
        place: async (src, finish, size, name) => this.addCanvas(await canvasFromURL(src), finish, { size, name }),
        deselect: () => !this.drag && this.select(null),
        clear: () => this.reset(),
        samples: () => this.addStarters(),
        count: () => this.stickers.length,
      };
      notifyHost({ type: 'ready' });
    }
    if (this.hasAttribute('maker')) {
      window.__maker = {
        import: async (url, name) => this.importImage(await (await fetch(url)).blob(), name),
        reset: () => this.setStudio('pick'),
      };
      root.querySelector('.place').textContent = 'Stick it on my desktop';
      this.openStudio();
      notifyHost({ type: 'ready' });
    }

    // Wallpaper mode
    this.wallBtn = root.querySelector('.btn.wall');
    this.wallBar = root.querySelector('.wallbar');
    this.wallBtn.addEventListener('click', () => this.setWallpaperMode(!this.wallMode));
    root.querySelector('.wall-done').addEventListener('click', () => this.setWallpaperMode(false));
    root.querySelector('.wall-dl').addEventListener('click', () => this.downloadWallpaper());
    root.querySelector('.wall-clear').addEventListener('click', () => this.setWallpaperImage(null));
    const wallInput = this.wallBar.querySelector('input');
    wallInput.addEventListener('change', () => {
      const f = wallInput.files[0];
      wallInput.value = '';
      if (f) this.setWallpaperImage(f);
    });
    for (const b of root.querySelectorAll('.sz')) b.addEventListener('click', () => this.setPendingSize(b.dataset.s));
    for (const chip of root.querySelectorAll('.chip.pv')) {
      chip.addEventListener('click', () => {
        this.pendingFinish = chip.dataset.f;
        this.syncChips('.chip.pv', this.pendingFinish);
      });
    }

    this.globals = [
      on(window, 'pointermove', (e) => {
        this.pointerClient = { x: e.clientX, y: e.clientY, t: performance.now() };
      }, { passive: true }),
      on(window, 'deviceorientation', (e) => {
        if (e.gamma == null) return;
        this.motion = { x: clamp(e.gamma / 35, -1, 1), y: clamp((e.beta - 40) / 35, -1, 1), t: performance.now() };
      }),
      on(window, 'keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!this.studio.hidden) this.closeStudio();
        else this.select(null);
      }),
      on(window, 'paste', (e) => {
        if (this.studio.hidden) return;
        const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
        if (file) this.processFile(file);
      }),
    ];

    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this.desk);
    this.io = new IntersectionObserver(([en]) => (this.visible = en.isIntersecting));
    this.io.observe(this.desk);
  }

  isUI(e) {
    return e.composedPath().some((n) => n.classList?.contains('ui'));
  }

  pt(e) {
    const r = this.desk.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pick(p, tol = 3) {
    for (let i = this.stickers.length - 1; i >= 0; i--) {
      const st = this.stickers[i];
      if (st.mode === 'remove') continue;
      const l = st.hit(p, tol);
      if (l) return { st, l };
    }
    return null;
  }

  askMotion(e) {
    // iOS only grants tilt (for the shine) after a tap, so ask on the first touch.
    if (this.askedMotion || e.pointerType !== 'touch') return;
    this.askedMotion = true;
    const DOE = window.DeviceOrientationEvent;
    if (DOE?.requestPermission) DOE.requestPermission().catch(() => {});
  }

  onDown(e) {
    if (e.button > 0 || this.drag || this.isUI(e)) return;
    const p = this.pt(e);
    this.pointer = p;
    this.askMotion(e);
    const hit = this.pick(p, e.pointerType === 'touch' ? 10 : 3);
    if (!hit) return this.select(null);
    e.preventDefault();
    const { st, l } = hit;
    try {
      this.desk.setPointerCapture(e.pointerId);
    } catch {}
    this.select(null);
    this.toFront(st);
    const edge = st.edgeAt(l);
    this.drag = { st, id: e.pointerId, start: p, moved: false, mode: edge ? 'peel' : 'press' };
    if (edge) {
      // Pressing lifts the edge a little, like getting a fingernail under it.
      const T = { x: l.x + edge.inward.x * PRESS_LIFT, y: l.y + edge.inward.y * PRESS_LIFT };
      st.peel = { C: { ...l }, P: { ...l }, T, inward: edge.inward, active: true };
      this.desk.classList.add('grabbing');
    }
  }

  onMove(e) {
    const p = this.pt(e);
    this.pointer = p;
    const d = this.drag;
    if (!d) return e.pointerType === 'mouse' && this.hover(p);
    if (e.pointerId !== d.id) return;
    const st = d.st;
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 5) d.moved = true;

    if (d.mode === 'peel') {
      const l = st.toLocal(p.x, p.y), { C, inward } = st.peel;
      const Dx = l.x - C.x, Dy = l.y - C.y, a = Dx * inward.x + Dy * inward.y;
      // The flap always folds back over the sticker; sideways pull steers it.
      const tx = Dx - inward.x * a, ty = Dy - inward.y * a, A = Math.max(PRESS_LIFT, Math.abs(a));
      st.peel.T = { x: C.x + inward.x * A + tx * 0.8, y: C.y + inward.y * A + ty * 0.8 };
      if (Math.hypot(Dx, Dy) > st.detachDistance()) this.detach(st, l);
    } else if (d.mode === 'press') {
      if (d.moved && !d.hinted) {
        d.hinted = true;
        st.wiggleT = performance.now();
        this.toast('Peel it from the edge', p);
      }
    } else if (d.mode === 'float') {
      this.bin.classList.toggle('hot', this.overBin(p));
    }
  }

  onUp(e, cancelled) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.desk.classList.remove('grabbing');
    const st = d.st;
    if (d.mode === 'peel') {
      st.peel.active = false;
      st.peel.T = { ...st.peel.C };
      if (!d.moved && !cancelled) this.select(st);
    } else if (d.mode === 'press') {
      if (!d.moved && !cancelled) this.select(st);
    } else if (d.mode === 'float') {
      this.bin.classList.remove('show');
      if (!cancelled && this.overBin(this.pointer)) {
        this.bin.classList.remove('hot');
        this.remove(st);
      } else this.drop(st);
    }
  }

  // Hovering only changes the cursor; the sticker itself doesn't move until it's pressed.
  hover(p) {
    const hit = p && this.pick(p, 2);
    this.desk.classList.toggle('grab', !!(hit && hit.st.edgeAt(hit.l)));
  }

  detach(st, l) {
    this.drag.mode = 'float';
    st.peel.active = false;
    st.peel.T = { ...st.peel.C };
    st.mode = 'float';
    st.grab = { from: l, to: { ...st.peel.C }, t0: performance.now() };
    this.bin.classList.add('show');
  }

  overBin(p) {
    const r = this.bin.getBoundingClientRect(), d = this.desk.getBoundingClientRect();
    const cx = r.left - d.left + r.width / 2, cy = r.top - d.top + r.height / 2;
    return Math.hypot(p.x - cx, p.y - cy) < 56;
  }

  drop(st) {
    st.rot += st.sway;
    st.sway = 0;
    st.x = clamp(st.x, 16, this.W - 16);
    st.y = clamp(st.y, 16, this.H - 16);
    st.nx = st.x / this.W;
    st.ny = st.y / this.H;
    st.mode = 'drop';
    st.dropFrom = st.lift;
    st.dropT0 = performance.now();
    this.save();
  }

  remove(st) {
    if (this.selected === st) this.select(null);
    st.mode = 'remove';
    st.dropT0 = performance.now();
  }

  forget(st) {
    st.el.remove();
    this.stickers = this.stickers.filter((s) => s !== st);
    this.save();
  }

  toFront(st) {
    st.z = ++this.zTop;
    this.stickers = this.stickers.filter((s) => s !== st).concat(st);
    st.moved = true;
  }

  select(st) {
    this.selected = st;
    this.toolbar.hidden = !st;
    if (st) {
      this.syncChips('.chip.tb', st.finish);
      this.placeToolbar();
    }
  }

  syncChips(sel, f) {
    for (const c of this.shadowRoot.querySelectorAll(sel)) c.setAttribute('aria-checked', String(c.dataset.f === f));
  }

  placeToolbar() {
    const st = this.selected;
    if (!st) return;
    const tb = this.toolbar, tw = tb.offsetWidth, th = tb.offsetHeight;
    const a = (st.rot * Math.PI) / 180;
    const hy = (Math.abs(st.dw * Math.sin(a)) + Math.abs(st.dh * Math.cos(a))) / 2;
    let y = st.y - hy - th - 10;
    if (y < 8) y = st.y + hy + 10;
    const x = clamp(st.x - tw / 2, 8, Math.max(8, this.W - tw - 8));
    tb.style.transform = `translate(${x}px, ${clamp(y, 8, Math.max(8, this.H - th - 8))}px)`;
  }

  toast(text, p) {
    const t = this.toastEl;
    t.textContent = text;
    const w = t.offsetWidth;
    t.style.transform = `translate(${clamp(p.x - w / 2, 8, this.W - w - 8)}px, ${clamp(p.y - 56, 8, this.H - 40)}px)`;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 1400 + text.length * 30);
  }

  lightFor(st) {
    const now = performance.now();
    if (this.motion && now - this.motion.t < 2000) {
      return {
        x: clamp(this.motion.x + (st.x / this.W - 0.5) * 0.4, -1, 1),
        y: clamp(this.motion.y + (st.y / this.H - 0.5) * 0.4, -1, 1),
      };
    }
    if (!this.pointerClient || !this.rect) return { x: -0.3, y: -0.4 };
    const cx = this.rect.left + st.x, cy = this.rect.top + st.y;
    return {
      x: clamp((this.pointerClient.x - cx) / 380, -1, 1) + st.tiltY / 45,
      y: clamp((this.pointerClient.y - cy) / 380, -1, 1) - st.tiltX / 45,
    };
  }

  measure() {
    const W = this.desk.clientWidth, H = this.desk.clientHeight;
    if (!W || !H) return;
    this.W = W;
    this.H = H;
    this.scale = clamp(W / 760, 0.62, 1);
    for (const st of this.stickers) st.layout();
    this.placeToolbar();
  }

  tick(now) {
    const dt = clamp(now - this.last, 1, 50);
    this.last = now;
    if (this.visible === false || !this.W) return;
    this.rect = this.desk.getBoundingClientRect();
    for (const st of this.stickers.slice()) st.update(dt, now);
    if (this.pendingFin && !this.studio.hidden) this.drawPreview(now);
  }

  /* ---- persistence */

  get storageKey() {
    return this.getAttribute('storage-key') || 'sticker-board';
  }

  save() {
    try {
      const stickers = this.stickers.filter((s) => s.mode !== 'remove').map((s) => s.toJSON());
      store().set(this.storageKey, JSON.stringify({ v: 1, stickers }));
    } catch (err) {
      if (err?.name === 'QuotaExceededError')
        this.toast('Desk storage is full: remove a sticker to save new ones', { x: this.W / 2, y: this.H - 20 });
    }
  }

  async restore() {
    let saved = null;
    try {
      saved = JSON.parse(store().get(this.storageKey) || 'null');
    } catch {}
    const list = saved?.stickers || (this.hasAttribute('no-starters') ? [] : STARTERS.map((s, i) => ({ ...s, id: s.starter, kind: 'starter', z: i + 1 })));
    const items = await Promise.all(
      list.map(async (d) => {
        try {
          const src = d.kind === 'user' ? await canvasFromURL(d.src) : starterCanvas(d.starter);
          return src && { d, src };
        } catch {
          return null;
        }
      })
    );
    for (const it of items.filter(Boolean).sort((a, b) => a.d.z - b.d.z)) this.add(it.d, it.src);
    notifyHost({ type: 'restored' }); // the Mac app can now count the stickers
  }

  add(data, src) {
    const st = new Sticker(this, data, src);
    this.zTop = Math.max(this.zTop, st.z || 0);
    this.stickers.push(st);
    this.layer.appendChild(st.el);
    st.applyStyle();
    return st;
  }

  onReset() {
    if (!this.resetBtn.classList.contains('armed')) {
      this.resetBtn.classList.add('armed');
      this.resetBtn.textContent = 'Clear desk?';
      this.resetTimer = setTimeout(() => this.disarmReset(), 2500);
      return;
    }
    this.disarmReset();
    this.reset();
  }

  disarmReset() {
    clearTimeout(this.resetTimer);
    this.resetBtn.classList.remove('armed');
    this.resetBtn.innerHTML = ICON.reset;
  }

  /** Removes every sticker and brings back the starter set (unless `no-starters`). */
  reset() {
    this.select(null);
    for (const st of this.stickers) st.el.remove();
    this.stickers = [];
    this.zTop = 1;
    try {
      store().remove(this.storageKey);
    } catch {}
    this.restore();
  }

  /** Drops a fresh copy of the starter stickers onto the desk. */
  addStarters() {
    for (const s of STARTERS) {
      const st = this.addCanvas(starterCanvas(s.starter), s.finish, { kind: 'starter', starter: s.starter, size: s.size });
      st.dropT0 += Math.random() * 400;
    }
  }

  /**
   * Opens an image file in the sticker maker:
   *  - "name.finish.sticker.png" (downloaded from a sticker board) is ready as-is,
   *  - other transparent images get a die-cut border,
   *  - photos have their main object cut out.
   */
  async importImage(blob, name = '') {
    const m = /(?:\.(vinyl|matte|gloss|laminate|holo|glitter))?\.sticker[^./]*\.png$/i.exec(name);
    let img;
    try {
      img = await loadImage(blob);
    } catch {
      this.toast(REASONS.notimage, { x: this.W / 2, y: this.H / 2 });
      return;
    }
    const c = drawScaled(img, 1024);
    this.pendingName = stickerName(name);
    if (m) return this.showPending(c, 'vinyl'); // its finish is already baked into the image
    if (hasTransparency(c)) {
      const s = stickerFromCutout(dropFaintPixels(c));
      if (s) return this.showPending(s, 'vinyl');
    }
    this.openStudio(new File([blob], name || 'photo', { type: blob.type || 'image/jpeg' }));
  }

  /** Slaps a sticker canvas onto the desk with a landing animation. */
  addCanvas(c, finish, extra = {}) {
    let src;
    if (extra.kind !== 'starter') {
      try {
        src = c.toDataURL('image/webp', 0.92);
      } catch {
        src = c.toDataURL();
      }
    }
    const st = this.add(
      { id: uid(), kind: 'user', src, size: 190, nx: rand(0.3, 0.7), ny: rand(0.3, 0.7), rot: rand(-8, 8), finish, z: ++this.zTop, ...extra },
      c
    );
    st.mode = 'drop';
    st.lift = st.dropFrom = 1.6;
    st.dropT0 = performance.now() + 220;
    st.applyStyle();
    this.save();
    this.dispatchEvent(new CustomEvent('sticker-created', { detail: { id: st.id } }));
    return st;
  }

  // Desktop app: is the pointer over something the overlay should catch?
  wantsPointer(x, y) {
    if (this.drag || !this.studio.hidden) return true;
    if (!this.toolbar.hidden) {
      const r = this.toolbar.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    const d = this.desk.getBoundingClientRect();
    return !!this.pick({ x: x - d.left, y: y - d.top }, 3);
  }

  /* ---- wallpaper (stickers on your desktop) */

  /** Shapes the desk like the visitor's screen so they can lay stickers out as a wallpaper. */
  setWallpaperMode(on) {
    this.wallMode = on;
    this.select(null);
    this.style.setProperty('--sb-aspect', `${screen.width} / ${screen.height}`);
    this.desk.classList.toggle('wall', on);
    this.wallBar.hidden = !on;
    this.wallBtn.setAttribute('aria-pressed', String(on));
    this.applyWallpaperBg();
    if (on) this.toast('Arrange your stickers, then download', { x: this.W / 2, y: 90 });
  }

  async setWallpaperImage(file) {
    if (this.wallURL) URL.revokeObjectURL(this.wallURL);
    this.wallImg = this.wallURL = null;
    if (file) {
      try {
        this.wallImg = await loadImage(file);
        this.wallURL = URL.createObjectURL(file);
      } catch {
        this.toast("Can't read that image", { x: this.W / 2, y: this.H - 80 });
      }
    }
    this.shadowRoot.querySelector('.wall-clear').hidden = !this.wallImg;
    this.applyWallpaperBg();
  }

  applyWallpaperBg() {
    const s = this.desk.style, img = this.wallMode && this.wallURL;
    s.backgroundImage = img ? `url("${this.wallURL}")` : '';
    s.backgroundSize = img ? 'cover' : '';
    s.backgroundPosition = img ? 'center' : '';
  }

  // Desk surface (or the visitor's own image) at export resolution; k = export px per desk px.
  paintSurface(x, w, h, k) {
    if (this.wallImg) {
      const iw = this.wallImg.naturalWidth, ih = this.wallImg.naturalHeight, s = Math.max(w / iw, h / ih);
      x.drawImage(this.wallImg, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
      return;
    }
    const cs = getComputedStyle(this.desk), surface = this.getAttribute('surface');
    x.fillStyle = cs.backgroundColor;
    x.fillRect(0, 0, w, h);
    if (surface === 'plain') return;
    if (surface === 'mat') {
      for (const [step, alpha] of [[20, 0.08], [100, 0.22]]) {
        x.fillStyle = `rgba(255,255,255,${alpha})`;
        for (let gx = 0; gx < w; gx += step * k) x.fillRect(gx, 0, Math.max(1, k), h);
        for (let gy = 0; gy < h; gy += step * k) x.fillRect(0, gy, w, Math.max(1, k));
      }
      return;
    }
    x.fillStyle = getComputedStyle(this).getPropertyValue('--sb-dot').trim() || 'rgba(0,0,0,.1)';
    for (let gy = 11 * k; gy < h; gy += 22 * k) {
      for (let gx = 11 * k; gx < w; gx += 22 * k) {
        x.beginPath();
        x.arc(gx, gy, 1.3 * k, 0, Math.PI * 2);
        x.fill();
      }
    }
  }

  /** Renders the desk at the screen's full resolution and downloads it as a PNG. */
  downloadWallpaper() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let w = Math.round(screen.width * dpr), h = Math.round(screen.height * dpr);
    const cap = Math.min(1, 5120 / Math.max(w, h));
    w = Math.round(w * cap);
    h = Math.round(h * cap);
    const c = makeCanvas(w, h), x = c.getContext('2d'), kx = w / this.W, ky = h / this.H;
    this.paintSurface(x, w, h, kx);
    for (const st of this.stickers) {
      if (st.mode === 'remove') continue;
      const img = st.fin.compose(st.finish, EXPORT_LIGHT);
      x.save();
      x.translate(st.x * kx, st.y * ky);
      x.rotate((st.rot * Math.PI) / 180);
      x.shadowColor = 'rgba(0,0,0,.28)';
      x.shadowBlur = 2.5 * kx;
      x.shadowOffsetY = 1.2 * kx;
      x.drawImage(img, (-st.dw * kx) / 2, (-st.dh * kx) / 2, st.dw * kx, st.dh * kx);
      x.restore();
      st.dirty = true;
    }
    downloadCanvas(c, `sticker-wallpaper-${w}x${h}.png`, this.shadowRoot);
    this.toast('Saved! Set it as your wallpaper in your device settings', { x: this.W / 2, y: this.H - 70 });
  }

  /* ---- studio (photo → sticker) */

  /** Opens the sticker maker; pass a File to start processing it straight away. */
  openStudio(file) {
    this.select(null);
    this.studio.hidden = false;
    this.setStudio('pick');
    if (file) this.processFile(file);
    else if (!this.hasAttribute('maker')) this.shadowRoot.querySelector('.drop').focus?.();
  }

  closeStudio() {
    if (this.hasAttribute('maker')) return this.setStudio('pick'); // the window is the maker
    this.job++;
    this.studio.hidden = true;
    this.pendingFin = null;
  }

  setStudio(state) {
    if (state === 'pick') this.job++;
    for (const s of this.studio.querySelectorAll('section')) s.hidden = s.dataset.state !== state;
  }

  async processFile(file) {
    const token = ++this.job;
    this.pendingName = stickerName(file.name);
    this.studio.hidden = false;
    const url = URL.createObjectURL(file);
    for (const img of this.studio.querySelectorAll('.thumb img')) img.src = url;
    this.setStudio('work');
    const step = this.studio.querySelector('.step');
    try {
      const canvas = await photoToSticker(file, (s) => token === this.job && (step.textContent = STEPS[s]));
      if (token !== this.job) return;
      this.showPending(canvas, 'vinyl');
    } catch (err) {
      if (token !== this.job) return;
      const code = err instanceof StickerError ? err.code : 'model';
      if (!(err instanceof StickerError)) console.warn('[sticker-board]', err);
      const bad = ['notimage', 'model'].includes(code);
      this.studio.querySelector('[data-state="error"] h4').textContent =
        code === 'notimage' ? "Can't read that file" : code === 'model' ? 'Something went wrong' : 'No clear object found';
      this.studio.querySelector('.lead').hidden = bad;
      this.studio.querySelector('.why').textContent = REASONS[code];
      this.setStudio('error');
      this.dispatchEvent(new CustomEvent('sticker-error', { detail: { reason: code } }));
    }
  }

  /** Shows a finished sticker in the maker, ready to pick a finish and size. */
  showPending(canvas, finish) {
    this.job++;
    this.studio.hidden = false;
    this.pending = canvas;
    this.pendingFin = new Finisher(canvas);
    this.pendingFinish = finish;
    this.syncChips('.chip.pv', finish);
    this.setPendingSize(this.pendingSizeId || 'm');
    this.setStudio('done');
    this.shadowRoot.querySelector('.place').focus();
  }

  setPendingSize(id) {
    const z = SIZES.find((s) => s.id === id) || SIZES[1];
    this.pendingSizeId = z.id;
    for (const b of this.shadowRoot.querySelectorAll('.sz')) b.setAttribute('aria-checked', String(b.dataset.s === z.id));
    // The preview grows and shrinks with the choice, so you can see the difference.
    this.previewCv.style.setProperty('--pv-size', `${Math.round(80 + ((z.size - 130) / 250) * 160)}px`);
  }

  drawPreview(now) {
    const cv = this.previewCv, x = this.previewCtx, r = cv.getBoundingClientRect();
    let L;
    const pc = this.pointerClient;
    if (this.motion && now - this.motion.t < 2000) L = this.motion;
    else if (pc && now - pc.t < 1500 && r.width)
      L = { x: clamp((pc.x - r.left - r.width / 2) / 220, -1, 1), y: clamp((pc.y - r.top - r.height / 2) / 220, -1, 1) };
    else L = { x: Math.sin(now / 1100) * 0.7, y: Math.cos(now / 1700) * 0.45 };
    this.pvL = this.pvL ? { x: lerp(this.pvL.x, L.x, 0.15), y: lerp(this.pvL.y, L.y, 0.15) } : L;
    const img = this.pendingFin.compose(this.pendingFinish, this.pvL);
    const s = Math.min(cv.width / img.width, cv.height / img.height);
    x.clearRect(0, 0, cv.width, cv.height);
    x.drawImage(img, (cv.width - img.width * s) / 2, (cv.height - img.height * s) / 2, img.width * s, img.height * s);
    cv.style.transform = `rotateY(${this.pvL.x * 14}deg) rotateX(${-this.pvL.y * 14}deg)`;
  }

  placePending() {
    if (!this.pending) return;
    const size = (SIZES.find((s) => s.id === this.pendingSizeId) || SIZES[1]).size;
    if (this.hasAttribute('maker')) {
      notifyHost({ type: 'place', src: this.pending.toDataURL('image/png'), finish: this.pendingFinish, size, name: this.pendingName });
      this.toast('Stuck on your desktop', { x: this.W / 2, y: this.H - 24 });
    } else {
      this.addCanvas(this.pending, this.pendingFinish, { size, name: this.pendingName });
    }
    this.pending = null;
    this.closeStudio();
  }
}

// Tells the Sticker Desk Mac app what's happening (a no-op on the web).
function notifyHost(message) {
  window.webkit?.messageHandlers?.desk?.postMessage(message);
}

// Where the desk is saved: localStorage on the web, or whatever the host app provides.
function store() {
  return window.STICKER_STORE || {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: (k) => localStorage.removeItem(k),
  };
}

function hasTransparency(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) clear++;
  return clear > d.length / 16 / 100;
}

// Clears soft drop shadows and glows baked into icons so the die-cut border hugs the shape itself.
function dropFaintPixels(c, min = 110) {
  const x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < min) d[i] = 0;
    else if (d[i] < min + 40) d[i] = ((d[i] - min) / 40) * 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}

// "IMG_2041.jpg" or "penguin.holo.sticker.png" → a name for the sticker made from it.
function stickerName(fileName = '') {
  const base = String(fileName).replace(/(?:\.[a-z]+)?\.sticker[^./]*\.png$/i, '').replace(/\.[a-z0-9]+$/i, '');
  return base && base !== 'photo' ? base : 'my sticker';
}

// The sticker as it looks on the desk, finish included, lit from a fixed angle.
function finished(fin, finish) {
  const img = fin.compose(finish, EXPORT_LIGHT), c = makeCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// "penguin.holo.sticker.png": the finish is baked in, and the name tells you which one it was.
function stickerFileName(name, finish) {
  const slug = String(name || 'sticker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sticker';
  return `${slug}.${finish}.sticker.png`;
}

function downloadCanvas(canvas, name, host) {
  // In the Mac app, the app shows a save dialog instead.
  if (window.webkit?.messageHandlers?.desk) return notifyHost({ type: 'download', name, src: canvas.toDataURL('image/png') });
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    host.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

// The load event, not img.decode(): decode() can stall while the page is hidden
// (the Mac app's page is "hidden" whenever windows cover the desktop).
function imageFrom(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = url;
  });
}

async function canvasFromURL(url) {
  const img = await imageFrom(url);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

if (!customElements.get('sticker-board')) customElements.define('sticker-board', StickerBoard);

export { StickerBoard, photoToSticker };
