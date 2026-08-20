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

test("the study ships as one page and its two favicons", async () => {
  /* The whole point of the piece is that it depends on nothing: one file to
     read, one file to host. A build that started emitting a bundle would have
     quietly changed what this project is. */
  const files = (await readdir(dist)).sort();
  assert.deepEqual(files, ["apple-touch-icon.png", "favicon-32.png", "index.html"]);
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
