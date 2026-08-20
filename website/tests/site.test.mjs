#!/usr/bin/env node
/* Verifies the built study: the properties the project promises rather than
   the pixels it draws. Everything here reads dist/, so it tests what ships. */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { before } from "node:test";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");

let page = "";
let worker = "";

before(async () => {
  page = await readFile(join(dist, "index.html"), "utf8");
  worker = await readFile(join(root, "worker/index.ts"), "utf8");
});

test("the study ships as one page, its two favicons and the social card", async () => {
  /* The whole point of the piece is that it depends on nothing: one file to
     read, one file to host. A build that started emitting a bundle would have
     quietly changed what this project is. */
  const files = (await readdir(dist)).sort();
  assert.deepEqual(files, ["apple-touch-icon.png", "favicon-32.png", "index.html", "og.png"]);
  for (const name of files) {
    const info = await stat(join(dist, name));
    assert.ok(info.size > 0, `${name} is empty`);
  }
});

test("nothing is loaded from another origin", () => {
  /* No fonts, no analytics, no CDN: a network dependency would also break the
     Content-Security-Policy the Worker sets. */
  const offsite = [...page.matchAll(/(?:src|href)\s*=\s*["']([a-z]+:)?\/\/[^"']+/gi)]
    .map((match) => match[0])
    .filter((reference) => !/href\s*=\s*["']https:\/\/ks-design\.art/i.test(reference));
  assert.deepEqual(offsite, [], `the page reaches off-origin: ${offsite.join(", ")}`);
  assert.doesNotMatch(page, /<link[^>]+rel=["']?stylesheet/i);
  assert.doesNotMatch(page, /<script[^>]+src=/i);
});

test("the social card is declared and matches what ships", async () => {
  /* Scrapers need absolute URLs, so these are the one place the page names
     its own origin. The image the tags promise has to be the file the build
     publishes, at the size the tags claim — a scraper caches whatever it
     finds, and a mismatch would live on in other people's feeds. Every
     number is pinned literally so the tags and the file cannot drift in
     lockstep unnoticed. */
  assert.match(page, /<meta property="og:url" content="https:\/\/ember\.ks-design\.art\/">/);
  assert.match(page, /<meta property="og:image" content="https:\/\/ember\.ks-design\.art\/og\.png">/);
  assert.match(page, /<meta property="og:image:width" content="1200">/);
  assert.match(page, /<meta property="og:image:height" content="630">/);
  assert.match(page, /<meta name="twitter:card" content="summary_large_image">/);
  const card = await readFile(join(dist, "og.png"));
  assert.deepEqual(
    [...card.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "og.png is not a PNG"
  );
  assert.equal(card.toString("ascii", 12, 16), "IHDR");
  assert.equal(card.readUInt32BE(16), 1200, "og.png width disagrees with the tags");
  assert.equal(card.readUInt32BE(20), 630, "og.png height disagrees with the tags");
  /* ~880 KB today: the film grain is most of the file (client-approved
     pixels), and the deterministic in-script deflate trades ~25% size
     against zlib level 9 for byte-stable output. The budget only catches
     runaway. */
  assert.ok(card.length <= 1024 * 1024, `og.png is ${card.length} bytes, budget 1 MB`);
  /* No off-origin leak through the allowance: an absolute URL in a meta tag
     must be one of the two published own-origin URLs, exactly. */
  const allowed = new Set([
    "https://ember.ks-design.art/",
    "https://ember.ks-design.art/og.png"
  ]);
  for (const [tag] of page.matchAll(/<meta\b[^>]*>/gi)) {
    const url = tag.match(/content="(https?:[^"]*)"/i);
    if (url) assert.ok(allowed.has(url[1]), `unexpected absolute URL in ${tag}`);
  }
});

test("the off-origin check still bites", async () => {
  /* The og allowance must not have turned the scan into a tunnel. The build
     script exports its scan exactly so this can be proven against the
     shipped page rather than assumed. */
  const { findOffOrigin } = await import("../scripts/build.mjs");
  assert.deepEqual(findOffOrigin(page), [], "the shipped page scans clean");
  const bad = (markup) => findOffOrigin(markup).length > 0;
  assert.ok(bad('<img src="https://cdn.example.com/x.png">'), "a CDN reference passes");
  assert.ok(
    bad('<meta property="og:image" content="https://evil.example.com/og.png">'),
    "a foreign og:image passes"
  );
  assert.ok(
    bad('<meta property="og:image" content="https://ember.ks-design.art/x?u=https://evil.example.com/a.js">'),
    "a smuggled second URL passes"
  );
  assert.ok(
    bad('<meta property="og:image" content="https://ember.ks-design.art/og.png?v=2">'),
    "a non-enumerated own-origin URL passes"
  );
  assert.ok(
    bad('<meta data-content="https://evil.example.com/">'),
    "a data-content attribute passes"
  );
});

test("the social card was rendered from the page's current figure geometry", async () => {
  /* make-og.mjs ports the page's figure code by hand, so the two can drift
     apart silently: reshape buildFigure() and the committed card keeps
     showing the old figure in every feed. make-og.mjs bakes a hash of the
     page's figure-geometry section into the PNG; recomputing it from the
     shipped page turns that silent drift into this red test. */
  const {
    FIGURE_FINGERPRINT_KEY,
    RENDERER_FINGERPRINT_KEY,
    figureFingerprint,
    rendererFingerprint
  } = await import("../scripts/og-fingerprint.mjs");
  const card = await readFile(join(dist, "og.png"));
  const baked = {};
  for (let offset = 8; offset < card.length;) {
    const length = card.readUInt32BE(offset);
    const type = card.toString("ascii", offset + 4, offset + 8);
    if (type === "tEXt") {
      const [keyword, value] = card
        .toString("latin1", offset + 8, offset + 8 + length)
        .split("\0");
      baked[keyword] = value;
    }
    offset += 12 + length;
  }
  assert.equal(
    baked[FIGURE_FINGERPRINT_KEY],
    figureFingerprint(page),
    "og.png was rendered from different figure code — update the port in " +
      "scripts/make-og.mjs to match the page, then regenerate (see " +
      "PORTED_FIGURE_FINGERPRINT there)"
  );
  /* The same gate from the other side: the renderer changed but the card
     was not regenerated. */
  assert.equal(
    baked[RENDERER_FINGERPRINT_KEY],
    rendererFingerprint(join(root, "scripts")),
    "og.png predates the current renderer — run `npm run og`"
  );
});

test("both favicon fallbacks are declared", () => {
  /* Safari ignores SVG favicons, so the baked PNGs are the ones it uses. */
  assert.match(page, /rel="icon" type="image\/svg\+xml"/);
  assert.match(page, /rel="icon" type="image\/png" sizes="32x32" href="favicon-32\.png"/);
  assert.match(page, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
});

test("the wordmark stays two words for a screen reader", () => {
  /* The gold dot is decorative; without a separator the mark fuses into one
     announced word. The portfolio pins the same property. */
  const mark = page.match(/<strong>[\s\S]*?<\/strong>/)[0];
  assert.match(mark, /aria-hidden="true"/);
  assert.equal(
    mark.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    "ks design"
  );
});

test("the audio only ever starts from a gesture", () => {
  /* Autoplay policy aside, a study that made noise on load would be hostile.
     The context is resumed and unlocked from click, tap and key handlers, and
     the mute button silences the master gain outright. */
  assert.match(page, /function unlockAudio\(\)/);
  assert.match(page, /unlockAudio\(\)/);
  assert.match(page, /master\.gain\.setTargetAtTime\(m \? 0 : 1/);
  /* Resuming is asynchronous: both the iOS unlock sample and the first strike
     have to run after it settles, or the opening burn is silent. */
  assert.match(page, /AC\.resume\(\)\.then\(playUnlockSample\)/);
  assert.match(page, /if \(!opts\.awaitResume\) return;/);
});

test("reduced motion is honoured", () => {
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /reducedMotion \? 0 :/);
});

test("the Worker attaches security headers to the assets", () => {
  for (const header of [
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "Permissions-Policy",
    "X-Frame-Options",
    "Content-Security-Policy"
  ]) {
    assert.ok(worker.includes(header), `the Worker does not set ${header}`);
  }
  /* The page is deliberately one file, so inline sources are allowed — but
     only those. A policy that also opened up an origin would defeat the build
     check that keeps the study self-contained. */
  assert.match(worker, /"default-src 'self'"/);
  assert.match(worker, /"connect-src 'none'"/);
  assert.doesNotMatch(worker, /script-src[^"]*https:/);
});

test("the preview server survives paths it cannot serve", async () => {
  /* The dev server died twice here: once streaming a 404 page this build
     never publishes, once on a malformed escape. Both were reported from a
     running process rather than a reading, so this test runs one too. */
  const { spawn } = await import("node:child_process");
  const port = 4700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, [join(root, "scripts/serve.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(`${base}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/%`)).status, 404);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);

    /* The point of the test: it is still answering after all of that. */
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ember Study/);
  } finally {
    server.kill();
  }
});
