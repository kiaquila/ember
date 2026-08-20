# Ember — interactive burn study

A single-page interactive study for the **ks·design lab**: a dark tangled
wireframe figure smolders with golden embers, burns down completely, and
reassembles — scored by a deep meditative tuning-fork tone (136.1 Hz,
synthesized with the Web Audio API, no audio files).

## Source provenance

- Motion reference: Pinterest pin <https://pin.it/163xR16nq> — a hero
  animation by `@skvortsov.design` (shared by NewForm's "Designer of the
  Week"). Only the motion idea is reproduced (smoldering particle figure with
  golden embers, smoke, and flying gold shards on a warm light-gray stage);
  no assets, code, or copy were taken from it.
- Interaction/layout reference: <https://reactive-dots.vercel.app> — a
  centered figure with a minimal control row at the bottom.
- Client decisions (Kristina, 2026-08-19): hover makes the figure burn
  locally and then recover instead of burning away; Play runs the full
  burn-and-reassemble cycle with the tuning-fork strike (a shape-shifting
  rebirth variant was tried and rolled back the same day); controls are
  limited to play/stop and mute; the favicon is the wireframe ball with an
  inverted palette for dark color schemes plus PNG fallbacks for Safari; the
  wordmark is "ks·design" — tracked caps with the brand-gold dot on the
  baseline, hugging the KS with a wide gap before DESIGN (`#e8a038`, shared
  with the ks portfolio) — used in the header only; the footer credit stays plain
  text: "Designed by ks-design · Built with AI workflows", linking to
  <https://ks-design.art>.

## Implementation

- [`website/src/index.html`](./website/src/index.html) — the whole page:
  inline CSS and vanilla JS, canvas 2D rendering, Web Audio synthesis. No
  dependencies, no network requests, system fonts only. The only sibling files
  are the two baked favicon PNGs and the baked social card.
- [`website/scripts/build.mjs`](./website/scripts/build.mjs) — copies those
  four files into `dist/` and refuses to build a page that gained an
  off-origin reference or lost a favicon. The `og:` meta tags are the one
  place the page may name its own origin in full (scrapers ignore relative
  URLs); any other absolute URL still fails the build.
- [`website/scripts/make-og.mjs`](./website/scripts/make-og.mjs) — renders
  [`website/src/og.png`](./website/src/og.png), the 1200×630 social card, in
  pure seeded Node (`npm run og`). It ports the page's own figure builder and
  draw pass — with the lump deformation flattened to a clean sphere — frozen
  at the approved hover moment: a local smolder with gold shards, plus the
  favicon's wireframe ball as a corner mark. No text is baked in; wording
  stays in `og:title`/`og:description`. Composition is a client decision
  (Kristina, 2026-08-20): sphere with the smolder at the upper right, chosen
  as variant 1 from ten seeded candidates. The constants in the script pin
  that choice; rerun `npm run og` to reproduce it byte for byte — the script
  carries its own fixed-Huffman deflate, so the bytes do not depend on the
  runtime's zlib build. A fingerprint of the page's figure-geometry section
  is baked into the PNG and re-checked by the tests
  ([`website/scripts/og-fingerprint.mjs`](./website/scripts/og-fingerprint.mjs)),
  so reshaping the page's figure without regenerating the card fails the
  build instead of leaving a stale card in other people's feeds.
- [`website/worker/index.ts`](./website/worker/index.ts) — the Cloudflare
  Worker that serves `dist/` and attaches the security headers.
- Audio starts only after a user gesture (browser autoplay policy). The page
  follows the same pattern as the reactive-dots reference: a best-effort
  `AudioContext` resume on the first pointer move (works on returning visits
  where the browser already trusts the site), a guaranteed unlock on any
  click/tap/key (with a one-sample silent buffer for iOS), and the mute
  button silences everything.
- The favicon is an inline SVG data URI with a `prefers-color-scheme: dark`
  media query inside the SVG (supported by Chrome and Firefox). Safari
  ignores SVG favicons, so [`website/favicon-32.png`](./website/src/favicon-32.png)
  and [`website/apple-touch-icon.png`](./website/src/apple-touch-icon.png) carry
  the same ball baked onto the page's warm-gray ground.
- `prefers-reduced-motion` disables rotation, sparks, and smoke while keeping
  the play cycle functional.

## Stage

The study is published as its own Cloudflare Worker, `ember`, at
[ember.ks-design.workers.dev](https://ember.ks-design.workers.dev) and at the
custom domain [ember.ks-design.art](https://ember.ks-design.art) the portfolio
links. Its dashboard settings live in
[`docs/stage-hosting.md`](../docs/stage-hosting.md); the deploy itself is run
by Cloudflare, not by this repository.

## Checks

- `npm --prefix ember/website run check` — the build plus its tests.
- `npm --prefix ember/website run dev` — build and serve `dist/` on port 4660.
- Verify by hand: hover ignition and recovery, the full Play cycle (burn →
  gone → reassemble → loop), Stop, mute, the footer link, the favicon in light
  and dark browser themes, and a narrow-viewport layout. Sound needs a real
  gesture — a scripted `click()` grants no user activation, and a browser
  profile that has already earned media engagement resumes the context
  immediately, which hides exactly the bug a fresh profile reveals.
- `node scripts/check-repository.mjs` from the repository root.
