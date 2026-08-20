/* Ties the baked social card to the page's figure code.

   make-og.mjs ports the page's figure geometry by hand, so nothing stops the
   two from drifting apart silently: someone reshapes buildFigure() in
   index.html and the committed og.png keeps showing the old figure in every
   feed. This fingerprint is the tripwire, applied twice. make-og.mjs bakes
   the hash of the page's figure-geometry section into a tEXt chunk of
   og.png, and the tests recompute it from the shipped page and fail on a
   mismatch — so a changed page with a stale card is a red build. And
   make-og.mjs itself refuses to render while the page hash disagrees with
   PORTED_FIGURE_FINGERPRINT — the hash its hand-ported code was written
   against — so rerunning it cannot quietly bless a stale render either.

   Only the geometry section is hashed, on purpose: palette or motion tweaks
   elsewhere in the page change how the live study moves, not what shape the
   frozen card shows, and fingerprinting them too would make the gate cry
   wolf. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* The section markers in src/index.html. buildFigure() and its constants
   live between them. */
const SECTION_START = "// ---------- figure geometry ----------";
const SECTION_END = "// ---------- sprites ----------";

export const FIGURE_FINGERPRINT_KEY = "ember-figure";
export const RENDERER_FINGERPRINT_KEY = "ember-renderer";

/* Every file whose content decides the card's pixels. Hashing them binds the
   committed og.png to the renderer itself: editing a seed, a color, or the
   rasterizer without regenerating turns the tests red. */
export const RENDERER_SOURCES = ["make-og.mjs", "og-fingerprint.mjs"];

/* A Windows checkout with core.autocrlf=true reads these sources with CRLF;
   hash the logical text, not the checkout's line-ending flavor. */
const normalize = (text) => text.replace(/\r\n?/g, "\n");

export function figureFingerprint(pageHtml) {
  const text = normalize(pageHtml);
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "index.html no longer carries the figure-geometry section markers; " +
        "update og-fingerprint.mjs alongside the page."
    );
  }
  return createHash("sha256").update(text.slice(start, end)).digest("hex");
}

export function rendererFingerprint(scriptsDir) {
  const hash = createHash("sha256");
  for (const name of RENDERER_SOURCES) {
    hash.update(name);
    hash.update("\0");
    hash.update(normalize(readFileSync(join(scriptsDir, name), "utf8")));
    hash.update("\0");
  }
  return hash.digest("hex");
}
