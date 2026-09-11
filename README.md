# Ember

A dark, tangled wireframe figure smolders with golden embers, burns down
completely, and reassembles as a new silhouette to a synthesized 136.1 Hz
tuning-fork tone.

View the live work at [ember.ks-design.art](https://ember.ks-design.art).

## Implementation

- The artwork is one dependency-free page in `website/src/index.html`, with
  inline CSS and JavaScript, Canvas 2D, Web Audio, and system fonts.
- Hover creates a local burn and recovery. Play runs one complete burn and
  rebirth cycle. Sound starts only after a user gesture and can be fully muted.
- The build publishes exactly four allowlisted files and rejects unexpected
  files and off-origin references. The Cloudflare Worker serves them with
  security headers.
- User-facing motion honors `prefers-reduced-motion`, and the controls use
  native accessible elements.

## Structure

```text
website/
├── src/index.html       # page, rendering, interaction, and sound
├── src/*.png            # two favicons and the social card
├── scripts/             # build, social card, and local preview
├── tests/               # shipped-output and policy tests
├── worker/index.ts      # security headers for static assets
└── wrangler.json        # deployable Worker configuration
```
