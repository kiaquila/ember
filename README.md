# Ember

A dark, tangled wireframe figure smolders with golden embers, burns down
completely, and reassembles as a new silhouette to a synthesized 136.1 Hz
tuning-fork tone.

View the live work at [ember.ks-design.art](https://ember.ks-design.art).
Current deployment settings, stage checks and the version rollback procedure
are documented in [`docs/stage-hosting.md`](docs/stage-hosting.md).

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

## Codex review gate

A trusted human requests native review with `@codex review <full-current-head-sha>`.
`Codex Review` accepts the native connector's formal reviews or a clean legacy /
`codex-review-receipt:v1` answer naming the current head's ten-character prefix.
Receipts must be created after the exact-head request; editing an older answer
cannot renew it. P0–P2 findings and every unresolved Codex review thread block
success, even after another request. The gate rechecks HEAD after reading evidence.

The rerun workflow reads trusted policy from the default branch and routes native
formal reviews plus created/edited receipt and summary comments. The
`codex-pull-request-review-summary` / `codex-review-state:v1` HTML is a wakeup
signal only: neither its JSON, a Completed label nor a thumbs-up grants success.
Reruns wait for an active gate and coalesce events already read by a later attempt.

When this routing fix is itself under review, the default branch still has the
old event filter. After the native connector posts a real current-head receipt,
a maintainer can rerun the existing `Codex Review` Actions run with `gh run rerun
<run-id> --repo kiaquila/ember`. The old trusted parser already accepts that
receipt. This evaluates real review evidence using default-branch code; do not
change checkout trust, fabricate a status, or merge around a failed gate. Once
merged, subsequent native events use the corrected routing automatically.
