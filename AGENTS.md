# AGENTS.md — Ember

Project-specific notes; repository-wide rules in the root `AGENTS.md` remain
in force.

- This is a self-contained lab piece, not a client business site. The page
  lives in [`website/src/index.html`](./website/src/index.html) — keep it a
  single dependency-free file (inline CSS/JS, canvas 2D, Web Audio synthesis,
  system fonts, zero network requests). Its only siblings are the two baked
  favicon PNGs for Safari; the build publishes exactly those three files and
  fails on a fourth, so a new asset is a deliberate decision.
- The stage is a Cloudflare Worker named `ember`, configured as documented in
  [`docs/stage-hosting.md`](../docs/stage-hosting.md). Its Content-Security-
  Policy allows inline script and style because the page is one file by
  design; that allowance is safe only while the build check keeps the page
  free of off-origin references, so do not weaken that check.
- The motion concept is traced in [`README.md`](./README.md). Do not copy
  assets or code from the referenced Pinterest pin or reactive-dots site;
  only the documented motion idea is reproduced.
- The tuning-fork sound is synthesized (136.1 Hz fundamental). Do not add
  audio files or third-party libraries for it.
- Preserve the approved interaction contract: hover = local burn + recovery;
  Play = full burn → reassemble cycle with strikes (a shape-shifting rebirth
  variant was tried and rolled back on 2026-08-19 — do not reintroduce it
  without the client asking); controls are play/stop and mute only; the
  favicon (inline SVG data URI + PNG fallbacks) inverts for dark color
  schemes; the wordmark is "ks·design" in tracked caps with the brand-gold
  dot on the baseline, hugging the KS with a wide gap before DESIGN
  (`--gold-dot: #e8a038`, same value as the ks portfolio's `--brand-gold`) — header only,
  while the footer credit stays plain "ks-design" text; the centered footer
  credit links to <https://ks-design.art>.
- Audio must remain gesture-gated (autoplay policy) and fully silenced by
  mute; keep `prefers-reduced-motion` support working.
- Before pushing: exercise hover, the full play cycle, stop, mute, and a
  narrow viewport; run `node scripts/check-repository.mjs`.
