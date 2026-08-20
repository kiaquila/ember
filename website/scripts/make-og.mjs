#!/usr/bin/env node
/* Renders src/og.png — the 1200×630 social card for the Ember study.

   The figure is the page's own: buildFigure() and the draw pass from
   src/index.html are ported line for line (fibonacci-sphere shell, short
   edges capped at degree four, stray threads), so the card cannot drift away
   from what the study actually shows. The one deliberate departure: the lump
   deformation is flattened (LUMP = 0), so the card reads as a clean sphere —
   the client picked this composition from ten candidates on 2026-08-20
   (variant 1: sphere, smolder at the upper right). The state is the approved
   hover moment — a local smolder with gold shards rising — not the full
   burn, because the card has to read at thumbnail size.

   Wording is left to og:title and og:description, so nothing here needs a
   font: only the figure, the warm stage, and the small wireframe-ball mark
   (the favicon's exact geometry) in the corner.

   Pure Node and fully seeded — a float framebuffer, supersampled 2× and
   encoded as a PNG by hand, including the deflate stream itself (fixed
   Huffman + greedy LZ77, integer math only). Node's zlib is deliberately not
   used for compression: its byte stream differs between zlib builds (Node 22
   and Node 24+ ship different ones), which would leave the committed og.png
   dirty after a faithful `npm run og` on another runtime. With the encoder
   in this file, the bytes depend on nothing but this file — reproducible on
   any Node the package supports. zlib is still imported, but only to verify
   the stream round-trips before the PNG is written.

   Run from the project: npm run og */

import { inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FIGURE_FINGERPRINT_KEY,
  RENDERER_FINGERPRINT_KEY,
  figureFingerprint,
  rendererFingerprint
} from "./og-fingerprint.mjs";

const SRC = resolve(import.meta.dirname, "..", "src");
const OUT = join(SRC, "og.png");
const W = 1200;
const H = 630;
const SS = 2; /* rendered at 2×, then box-filtered down */

/* Card composition: the page centers at H*0.44 above the control row; the
   card has no chrome, so the figure sits a touch lower and larger. */
const CX = W / 2;
const CY = H * 0.47;
const R = 215;

const SEED = 3;
const ROT_Y = 0.9; /* page: rnd(0, 2π); chosen so the profile reads */
const TILT = 0.25; /* the page's reduced-motion tilt */
const LUMP = 0; /* lump amplitude scale; 0 = clean sphere (client's pick) */

/* The hash of the page's figure-geometry section that the hand-ported code
   below was written against. This is what keeps the drift gate honest: when
   the page's geometry changes, rerunning this script must not quietly bless
   a stale render, so it refuses to run until the port is brought back in
   line and this constant is bumped to the value the error prints. Bumping
   the constant without updating the port is a deliberate false statement,
   not an accident this file can make for you. */
const PORTED_FIGURE_FINGERPRINT =
  "2cb88beffc9b118b2b66b7c785342f8f05d72a972d1288dbd3dad0628136e2b9";

const pageFingerprint = figureFingerprint(
  readFileSync(resolve(import.meta.dirname, "..", "src", "index.html"), "utf8")
);
if (pageFingerprint !== PORTED_FIGURE_FINGERPRINT) {
  throw new Error(
    "src/index.html's figure geometry no longer matches the port in this script.\n" +
      `  page:   ${pageFingerprint}\n` +
      `  ported: ${PORTED_FIGURE_FINGERPRINT}\n` +
      "Update the ported geometry/draw code in make-og.mjs to match the page, " +
      "verify the render, then set PORTED_FIGURE_FINGERPRINT to the page value."
  );
}

/* ---- seeded PRNG (mulberry32) — the only source of randomness ---------- */
let prngState = SEED >>> 0;
function rand() {
  prngState = (prngState + 0x6d2b79f5) >>> 0;
  let t = prngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rnd(min, max) { return min + rand() * (max - min); }

/* ---- framebuffer -------------------------------------------------------- */
const w = W * SS;
const h = H * SS;
const buf = new Float32Array(w * h * 3);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** source-over: lerp toward color (0..1 channels) by alpha. */
function blendPx(x, y, color, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  buf[i] += (color[0] - buf[i]) * alpha;
  buf[i + 1] += (color[1] - buf[i + 1]) * alpha;
  buf[i + 2] += (color[2] - buf[i + 2]) * alpha;
}

/** canvas "lighter": add color premultiplied by alpha. */
function addPx(x, y, color, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  buf[i] += color[0] * alpha;
  buf[i + 1] += color[1] * alpha;
  buf[i + 2] += color[2] * alpha;
}

/** Bilinear plot in supersampled space. */
function plot(x, y, color, alpha, add) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const put = add ? addPx : blendPx;
  put(x0, y0, color, alpha * (1 - fx) * (1 - fy));
  put(x0 + 1, y0, color, alpha * fx * (1 - fy));
  put(x0, y0 + 1, color, alpha * (1 - fx) * fy);
  put(x0 + 1, y0 + 1, color, alpha * fx * fy);
}

/** Stroke of `weight` CSS px between two CSS-px points. */
function stroke(x1, y1, x2, y2, color, alpha, weight, add) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return;
  const nx = ((y2 - y1) / length) * (1 / SS);
  const ny = (-(x2 - x1) / length) * (1 / SS);
  const passes = Math.max(1, Math.round(weight * SS));
  const steps = Math.max(2, Math.ceil(length * SS));
  for (let p = 0; p < passes; p++) {
    const off = passes === 1 ? 0 : (p / (passes - 1) - 0.5) * (weight - 1 / SS) * SS;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      plot(
        (x1 + (x2 - x1) * t + nx * off) * SS,
        (y1 + (y2 - y1) * t + ny * off) * SS,
        color,
        alpha,
        add
      );
    }
  }
}

/** Solid disc with a one-pixel soft edge, in CSS px. */
function disc(cx, cy, radius, color, alpha, add) {
  const rs = radius * SS;
  const xs = cx * SS;
  const ys = cy * SS;
  for (let y = Math.floor(ys - rs); y <= Math.ceil(ys + rs); y++) {
    for (let x = Math.floor(xs - rs); x <= Math.ceil(xs + rs); x++) {
      const cover = clamp01(rs - Math.hypot(x - xs, y - ys) + 0.5);
      if (cover > 0) plot(x, y, color, alpha * cover, add);
    }
  }
}

/* The page's glow sprites: radial gradient inner → outer at 35% → clear. */
function glow(cx, cy, radius, inner, outer, alpha) {
  const rs = radius * SS;
  const xs = cx * SS;
  const ys = cy * SS;
  for (let y = Math.floor(ys - rs); y <= Math.ceil(ys + rs); y++) {
    for (let x = Math.floor(xs - rs); x <= Math.ceil(xs + rs); x++) {
      const t = Math.hypot(x - xs, y - ys) / rs;
      if (t >= 1 || x < 0 || y < 0 || x >= w || y >= h) continue;
      let cr, cg, cb, ca;
      if (t < 0.35) {
        const k = t / 0.35;
        cr = inner[0] + (outer[0] - inner[0]) * k;
        cg = inner[1] + (outer[1] - inner[1]) * k;
        cb = inner[2] + (outer[2] - inner[2]) * k;
        ca = inner[3] + (outer[3] - inner[3]) * k;
      } else {
        const k = (t - 0.35) / 0.65;
        cr = outer[0];
        cg = outer[1];
        cb = outer[2];
        ca = outer[3] * (1 - k);
      }
      addPx(x, y, [cr, cg, cb], ca * alpha);
    }
  }
}

const GOLD_GLOW = [[1, 238 / 255, 200 / 255, 0.95], [1, 170 / 255, 64 / 255, 0.55]];
const ORANGE_GLOW = [[1, 196 / 255, 120 / 255, 0.9], [240 / 255, 120 / 255, 40 / 255, 0.45]];

/* ---- background: the page's bgLayer, per pixel -------------------------- */
const SKY = [[0xde, 0xdb, 0xd5], [0xd6, 0xd3, 0xcd], [0xc9, 0xc6, 0xc0]].map(
  (c) => c.map((v) => v / 255)
);
const HALO = [248 / 255, 245 / 255, 238 / 255];
const INK_RING = [42 / 255, 39 / 255, 34 / 255];
const VIGNETTE = [40 / 255, 36 / 255, 30 / 255];
const RINGS = [1.28, 1.66, 2.12];

const gdx = W * 0.3;
const gdy = H;
const glen2 = gdx * gdx + gdy * gdy;
const vigR0 = Math.min(W, H) * 0.45;
const vigR1 = Math.max(W, H) * 0.85;

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const cssX = x / SS;
    const cssY = y / SS;
    /* sky gradient, stops at 0 / 0.55 / 1 */
    const gt = clamp01((cssX * gdx + cssY * gdy) / glen2);
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      out[c] = gt < 0.55
        ? SKY[0][c] + (SKY[1][c] - SKY[0][c]) * (gt / 0.55)
        : SKY[1][c] + (SKY[2][c] - SKY[1][c]) * ((gt - 0.55) / 0.45);
    }
    const dist = Math.hypot(cssX - CX, cssY - CY);
    /* halo behind the figure */
    const ht = clamp01((dist - R * 0.2) / (R * 1.7 - R * 0.2));
    const ha = 0.5 * (1 - ht);
    for (let c = 0; c < 3; c++) out[c] += (HALO[c] - out[c]) * ha;
    /* concentric rings, 1 CSS px wide */
    for (const m of RINGS) {
      const cover = clamp01(1 - Math.abs(dist - R * m) * SS + 0.5) * 0.055;
      if (cover > 0) for (let c = 0; c < 3; c++) out[c] += (INK_RING[c] - out[c]) * cover;
    }
    /* vignette */
    const va = 0.14 * clamp01((dist - vigR0) / (vigR1 - vigR0));
    for (let c = 0; c < 3; c++) out[c] += (VIGNETTE[c] - out[c]) * va;
    const i = (y * w + x) * 3;
    buf[i] = out[0];
    buf[i + 1] = out[1];
    buf[i + 2] = out[2];
  }
}

/* ---- figure geometry: buildFigure() from the page ----------------------- */
const N = 560;
const dirs = [];
const edges = [];
const lumps = [];
for (let k = 0; k < 5; k++) {
  lumps.push({
    ax: rnd(-2.4, 2.4), ay: rnd(-2.4, 2.4), az: rnd(-2.4, 2.4),
    /* the rnd draw stays even at LUMP = 0 so the PRNG stream — and with it
       every seeded variant — keeps the same layout as the candidate sheet */
    ph: rnd(0, Math.PI * 2), amp: rnd(0.05, 0.13) * LUMP
  });
}
const golden = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < N; i++) {
  const y = 1 - (2 * (i + 0.5)) / N;
  const rr = Math.sqrt(Math.max(0, 1 - y * y));
  const th = i * golden;
  const x = Math.cos(th) * rr;
  const z = Math.sin(th) * rr;
  let rad = 1;
  for (const lp of lumps) rad += lp.amp * Math.sin(lp.ax * x + lp.ay * y + lp.az * z + lp.ph);
  if (i % 4 === 0) rad *= rnd(0.55, 0.85);
  rad *= rnd(0.96, 1.04);
  dirs.push([x * rad, y * rad, z * rad]);
}
const edgeCount = new Array(N).fill(0);
const pairs = [];
for (let a = 0; a < N; a++) {
  for (let b = a + 1; b < N; b++) {
    const dx = dirs[a][0] - dirs[b][0];
    const dy = dirs[a][1] - dirs[b][1];
    const dz = dirs[a][2] - dirs[b][2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 0.055) pairs.push([d2, a, b]);
  }
}
pairs.sort((p, q) => p[0] - q[0]);
for (const [, pa, pb] of pairs) {
  if (edgeCount[pa] >= 4 || edgeCount[pb] >= 4) continue;
  edges.push([pa, pb]);
  edgeCount[pa]++;
  edgeCount[pb]++;
}
for (let s = 0; s < N * 0.03; s++) {
  const sa = (rand() * N) | 0;
  const sb = (rand() * N) | 0;
  if (sa !== sb) edges.push([sa, sb]);
}

/* ---- projection: simulate()'s transform, one frozen frame --------------- */
const px = new Array(N);
const py = new Array(N);
const depth = new Array(N);
{
  const sy = Math.sin(ROT_Y);
  const cy = Math.cos(ROT_Y);
  const sx = Math.sin(TILT);
  const cx = Math.cos(TILT);
  const f = 3.6;
  for (let i = 0; i < N; i++) {
    const [X, Y, Z] = dirs[i];
    const x1 = X * cy + Z * sy;
    const z1 = -X * sy + Z * cy;
    const y2 = Y * cx - z1 * sx;
    const z2 = Y * sx + z1 * cx;
    const s = f / (f - z2);
    px[i] = CX + x1 * s * R;
    py[i] = CY + y2 * s * R;
    depth[i] = 0.45 + 0.55 * clamp01((z2 + 1.2) / 2.2);
  }
}

/* ---- state: the hover moment -------------------------------------------
   A pointer has just grazed the upper shoulder: nodes inside the page's
   hover radius carry real heat, the rest of the figure keeps its idle
   smolder (8% embers flickering 0.10–0.23, as renderHeat computes it). */
const heat = new Array(N).fill(0);
const hoverX = CX + R * 0.38;
const hoverY = CY - R * 0.42;
const hoverR = R * 0.34;
for (let i = 0; i < N; i++) {
  const d = Math.hypot(px[i] - hoverX, py[i] - hoverY);
  if (d < hoverR) {
    const k = 1 - d / hoverR;
    heat[i] = clamp01(0.9 * k * k * (3 - 2 * k) + rnd(-0.06, 0.06));
  }
}
const renderHeat = new Array(N);
for (let i = 0; i < N; i++) {
  const idle = rand() < 0.08 ? 0.1 + 0.13 * (0.5 + 0.5 * Math.sin(rnd(0, Math.PI * 2))) : 0;
  renderHeat[i] = Math.max(heat[i], idle);
}

let avgHeat = 0;
for (let i = 0; i < N; i++) avgHeat += renderHeat[i];
avgHeat /= N;

/* ---- floor reflection ---------------------------------------------------- */
{
  const floorA = 0.04 + avgHeat * 0.22;
  const fy = CY + R * 1.35;
  const fr = R * 1.05;
  const EMBER_FLOOR = [1, 180 / 255, 80 / 255];
  for (let y = Math.floor((fy - fr * 0.22) * SS); y <= Math.ceil((fy + fr * 0.22) * SS); y++) {
    for (let x = Math.floor((CX - fr) * SS); x <= Math.ceil((CX + fr) * SS); x++) {
      const t = Math.hypot(x / SS - CX, (y / SS - fy) / 0.22) / fr;
      if (t >= 1 || x < 0 || y < 0 || x >= w || y >= h) continue;
      blendPx(x, y, EMBER_FLOOR, 0.55 * (1 - t) * floorA);
    }
  }
}

/* ---- inner core glow ----------------------------------------------------- */
{
  const coreA = 0.1 + avgHeat * 0.6;
  const cg = Math.min(0.9, 0.4 + coreA) * R * 1.8;
  glow(CX, CY, cg / 2, ...ORANGE_GLOW, Math.min(0.5, coreA));
}

/* ---- edges: the draw() pass ---------------------------------------------- */
const INK = [38 / 255, 35 / 255, 30 / 255];
for (const [ea, eb] of edges) {
  const eh = (heat[ea] + heat[eb]) * 0.5;
  if (eh > 0.06) {
    const mix = Math.min(1, eh * 1.5);
    stroke(
      px[ea], py[ea], px[eb], py[eb],
      [(38 + mix * 217) / 255, (35 + mix * 125) / 255, (30 + mix * 40) / 255],
      0.45 + mix * 0.4,
      0.8,
      false
    );
  } else {
    stroke(px[ea], py[ea], px[eb], py[eb], INK, 0.55 * ((depth[ea] + depth[eb]) * 0.5), 0.8, false);
  }
}

/* ---- nodes ---------------------------------------------------------------- */
for (let n = 0; n < N; n++) {
  const rh = renderHeat[n];
  if (rh > 0.1) {
    const gs = (3 + rh * 11) * (0.7 + depth[n] * 0.3);
    glow(px[n], py[n], gs, ...(rh > 0.6 ? GOLD_GLOW : ORANGE_GLOW), Math.min(1, rh) * 0.6);
  }
  const mix = Math.min(1, rh * 1.6);
  disc(
    px[n], py[n],
    1.1 + depth[n] * 0.9 + rh * 1.3,
    [(38 + mix * 217) / 255, (35 + mix * 190) / 255, (30 + mix * 158) / 255],
    0.35 + 0.65 * depth[n],
    false
  );
}

/* ---- sparks: gold shards rising off the smolder --------------------------- */
const SHARD_BRIGHT = [1, 216 / 255, 143 / 255]; /* #ffd88f */
const SHARD_DIM = [240 / 255, 147 / 255, 56 / 255]; /* #f09338 */
const SPARK_CORE = [1, 233 / 255, 191 / 255]; /* #ffe9bf */

function triangle(x, y, size, rot, color, alpha) {
  const pts = [
    [0, -size],
    [size * 0.85, size * 0.6],
    [-size * 0.85, size * 0.6]
  ].map(([tx, ty]) => [
    (x + tx * Math.cos(rot) - ty * Math.sin(rot)) * SS,
    (y + tx * Math.sin(rot) + ty * Math.cos(rot)) * SS
  ]);
  const minX = Math.floor(Math.min(pts[0][0], pts[1][0], pts[2][0]));
  const maxX = Math.ceil(Math.max(pts[0][0], pts[1][0], pts[2][0]));
  const minY = Math.floor(Math.min(pts[0][1], pts[1][1], pts[2][1]));
  const maxY = Math.ceil(Math.max(pts[0][1], pts[1][1], pts[2][1]));
  const edge = (a, b, x2, y2) => (b[0] - a[0]) * (y2 - a[1]) - (b[1] - a[1]) * (x2 - a[0]);
  const area = edge(pts[0], pts[1], pts[2][0], pts[2][1]);
  for (let yy = minY; yy <= maxY; yy++) {
    for (let xx = minX; xx <= maxX; xx++) {
      const e0 = edge(pts[0], pts[1], xx + 0.5, yy + 0.5) / area;
      const e1 = edge(pts[1], pts[2], xx + 0.5, yy + 0.5) / area;
      const e2 = edge(pts[2], pts[0], xx + 0.5, yy + 0.5) / area;
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) addPx(xx, yy, color, alpha);
    }
  }
}

for (let s = 0; s < 9; s++) {
  const sx = hoverX + rnd(-0.26, 0.18) * R;
  const sy = hoverY - rnd(0.06, 0.38) * R;
  const lf = rnd(0.35, 0.95); /* remaining life fraction */
  const flick = 0.55 + 0.45 * Math.sin(rnd(0, Math.PI * 2));
  const a = lf * flick;
  if (rand() < 0.35) {
    triangle(sx, sy, rnd(2.4, 5), rnd(0, Math.PI * 2), lf > 0.5 ? SHARD_BRIGHT : SHARD_DIM, a);
  } else {
    const size = rnd(0.9, 2.1);
    glow(sx, sy, size * 2.4, ...GOLD_GLOW, a * 0.6);
    disc(sx, sy, Math.max(0.5, size * 0.5), SPARK_CORE, a, true);
  }
}

/* ---- corner mark: the favicon's wireframe ball, stroke for stroke -------- */
{
  const MS = 56 / 64; /* favicon viewBox is 64; mark renders at 56 CSS px */
  const MX = 64;
  const MY = 56;
  const at = (vx, vy) => [MX + vx * MS, MY + vy * MS];
  const INK_MARK = [42 / 255, 39 / 255, 34 / 255];
  const GOLD_MARK = [237 / 255, 165 / 255, 69 / 255]; /* #eda545 */
  const hull = [[56, 36], [50, 17], [35, 8], [17, 14], [9, 30], [14, 48], [30, 56], [48, 51]];
  const inner = [
    [[50, 17], [42, 26]], [[42, 26], [56, 36]], [[35, 8], [26, 24]],
    [[17, 14], [26, 24]], [[9, 30], [22, 38]], [[14, 48], [22, 38]],
    [[30, 56], [38, 42]], [[48, 51], [46, 38]], [[46, 38], [56, 36]],
    [[26, 24], [31, 31]], [[42, 26], [31, 31]], [[22, 38], [31, 31]],
    [[38, 42], [31, 31]], [[42, 26], [46, 38]], [[38, 42], [46, 38]],
    [[26, 24], [22, 38]]
  ];
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = at(...hull[i]);
    const [bx, by] = at(...hull[(i + 1) % hull.length]);
    stroke(ax, ay, bx, by, INK_MARK, 0.92, 2.2 * MS, false);
  }
  for (const [a, b] of inner) {
    const [ax, ay] = at(...a);
    const [bx, by] = at(...b);
    stroke(ax, ay, bx, by, INK_MARK, 0.92, 2.2 * MS, false);
  }
  for (const [vx, vy] of hull) disc(...at(vx, vy), 2.2 * MS, INK_MARK, 1, false);
  for (const [vx, vy] of [[26, 24], [22, 38], [38, 42], [46, 38]]) {
    disc(...at(vx, vy), 1.8 * MS, INK_MARK, 1, false);
  }
  disc(...at(31, 31), 3.4 * MS, GOLD_MARK, 1, false);
  disc(...at(42, 26), 2.3 * MS, GOLD_MARK, 1, false);
}

/* ---- downsample, film grain, encode --------------------------------------- */
const rows = [];
const byte = (v) => Math.round(clamp01(v) * 255);
const GRAIN_A = (14 / 255) * 0.35; /* the page's grain sprite × its draw alpha */
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(W * 3 + 1);
  row[0] = 0; /* PNG filter: none */
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * w + (x * SS + sx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const grain = rand();
    row[1 + x * 3] = byte(r / n + (grain - r / n) * GRAIN_A);
    row[2 + x * 3] = byte(g / n + (grain - g / n) * GRAIN_A);
    row[3 + x * 3] = byte(b / n + (grain - b / n) * GRAIN_A);
  }
  rows.push(row);
}

/* ---- deterministic zlib stream (RFC 1950/1951) ---------------------------
   One final fixed-Huffman block over a greedy 32 KB-window LZ77 parse.
   Trails zlib level 9 by a modest margin, which the card can afford for the
   guarantee that the bytes are a pure function of the pixels. */
function deterministicZlib(data) {
  const out = [0x78, 0x01]; /* CMF/FLG: deflate, 32 KB window, checksum ok */
  let bitBuf = 0;
  let bitCnt = 0;
  const putBits = (value, count) => {
    bitBuf |= value << bitCnt;
    bitCnt += count;
    while (bitCnt >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };
  /* Huffman codes are transmitted most-significant bit first, so reverse. */
  const putCode = (code, len) => {
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (code & 1);
      code >>= 1;
    }
    putBits(rev, len);
  };
  const putSymbol = (sym) => {
    if (sym < 144) putCode(0x30 + sym, 8);
    else if (sym < 256) putCode(0x190 + (sym - 144), 9);
    else if (sym < 280) putCode(sym - 256, 7);
    else putCode(0xc0 + (sym - 280), 8);
  };

  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
    193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
    12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  putBits(1, 1); /* BFINAL */
  putBits(1, 2); /* BTYPE: fixed Huffman */

  const HASH_SIZE = 1 << 15;
  const MAX_CHAIN = 64;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const chain = new Int32Array(data.length);
  const hashAt = (p) => ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & (HASH_SIZE - 1);
  const insert = (p) => {
    const hsh = hashAt(p);
    chain[p] = head[hsh];
    head[hsh] = p;
  };

  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < data.length) {
      let cand = head[hashAt(i)];
      let tries = MAX_CHAIN;
      const limit = Math.min(258, data.length - i);
      while (cand >= 0 && tries-- > 0 && i - cand <= 32768) {
        let l = 0;
        while (l < limit && data[cand + l] === data[i + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = i - cand;
          if (l >= limit) break;
        }
        cand = chain[cand];
      }
    }
    if (bestLen >= 3) {
      let li = LEN_BASE.length - 1;
      while (LEN_BASE[li] > bestLen) li--;
      putSymbol(257 + li);
      if (LEN_EXTRA[li]) putBits(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
      let di = DIST_BASE.length - 1;
      while (DIST_BASE[di] > bestDist) di--;
      putCode(di, 5);
      if (DIST_EXTRA[di]) putBits(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
      const stop = i + bestLen;
      while (i < stop) {
        if (i + 2 < data.length) insert(i);
        i++;
      }
    } else {
      putSymbol(data[i]);
      if (i + 2 < data.length) insert(i);
      i++;
    }
  }
  putSymbol(256); /* end of block */
  if (bitCnt > 0) out.push(bitBuf & 0xff);

  /* adler32, deferred modulo (sums stay far below 2^53) */
  let a = 1;
  let b = 0;
  for (let p = 0; p < data.length; p++) {
    a += data[p];
    b += a;
    if ((p & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  a %= 65521;
  b %= 65521;
  out.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff);
  return Buffer.from(out);
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = -1;
  for (const value of body) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([length, body, checksum]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; /* bit depth */
ihdr[9] = 2; /* truecolor */

const raw = Buffer.concat(rows);
const idat = deterministicZlib(raw);
if (!inflateSync(idat).equals(raw)) {
  throw new Error("the deterministic deflate stream does not round-trip");
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("tEXt", Buffer.from(
    `Comment\0ember og card, seed ${SEED}, rotY ${ROT_Y}, lump ${LUMP}`, "latin1")),
  chunk("tEXt", Buffer.from(`${FIGURE_FINGERPRINT_KEY}\0${pageFingerprint}`, "latin1")),
  /* Binds the committed bytes to the renderer itself: a change to SEED, a
     color, or the rasterizer shows up as a hash mismatch in the tests until
     the card is regenerated. */
  chunk("tEXt", Buffer.from(
    `${RENDERER_FINGERPRINT_KEY}\0${rendererFingerprint(import.meta.dirname)}`, "latin1")),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0))
]);

writeFileSync(OUT, png);
console.log(
  `Wrote ${join("src", "og.png")} — ${W}×${H}, ${edges.length} edges, ` +
    `${(png.length / 1024).toFixed(0)} KB, figure ${pageFingerprint.slice(0, 12)}`
);
