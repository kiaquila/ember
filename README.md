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
reviews and created/edited summary comments. Version 1 structured state now offers
independent evidence: the official bot must report the full current head,
`code_review.status: "completed"` and both finding flags exactly `false`.
`security_review` must be all `null`, or the same exact-head completed/false/false
state. Both objects have exactly four required fields; malformed JSON, duplicate
keys, extra fields, unknown markers and versions fail closed. A fresh state update
must follow the current trusted request, with IDs ordering same-second events.
Newer non-clean state supersedes older clean state, including pending, malformed
and wrong-head updates; ambiguous equal-time summaries fail closed.

This intentionally replaces the old wakeup-only treatment of structured state.
Headings, reactions and prose still cannot grant success. A new presentation
closing such as `Swish!` or `Chef's kiss.` remains pending until a strictly newer
affirmative machine summary supersedes it. A later or equal-time unfamiliar
receipt requires a fresh summary; the receipt cannot pass alone. Strict legacy receipt validation remains
the fallback. Malformed or contradictory receipts and native blocking findings
or unresolved threads cannot be rescued by a clean machine summary. Reruns wait
for an active gate and coalesce events already read by a later attempt.

While this contract upgrade is under review, the trusted default-branch gate
still requires its accepted legacy receipt or native formal review. Request real
review for the exact PR head and rerun the existing Actions gate if necessary.
New presentation prose plus structured state cannot make the old parser accept
an unsupported format. Do not execute proposed scripts with write permission,
fabricate a status, or bypass a failed gate. Subsequent reviews use this contract
only after it has been merged normally.
