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

This intentionally replaces the old wakeup-only treatment of structured state
with an independent machine verdict and explicit chronology. Every unfamiliar
receipt is pending, whether its prose appears positive or negative; a strictly
newer affirmative machine completion independently supersedes that unstructured
text. Later or same-second unfamiliar text requires a fresh completion. The
legacy receipt parser remains strict and arbitrary prose never grants success.

Strict positive receipt freshness and ordering use creation time; an edit cannot
renew approval or outrank a later pending verdict. Unknown or negative receipt
edits retain their update time so they can invalidate an older clean completion.

A trusted exact-head clean formal review can also supersede strictly older
pending summary evidence. Valid exact-head structured findings survive a repeated request for that head. Earlier valid section-specific clearing proof also remains effective when another section is absent or running, so repeated requests do not resurrect resolved findings; historical proof alone cannot grant the new request approval.
Code findings require newer affirmative code proof; security findings require
newer completed false/false security proof for that head (null is insufficient).
Clearing checks exclude severity only inside the other section’s unique validated completed row; ambiguous global severity remains pending. Typed finding order uses the affected section’s canonical completion time; unrelated summary edits do not renew that finding. Malformed and foreign-head historical state cannot become permanent vetoes.
Explicit structured code/security findings require newer affirmative structured proof; a formal code review cannot clear them.
Its submission time uses the same second buckets;
tied or newer pending comments still block, and malformed receipt envelopes,
native findings and unresolved threads retain their vetoes.

A mutable summary updated in the request’s second remains ambiguous even if its
original comment ID is lower: that ID dates creation, not the edit. Such ties
stay pending; a fresh request or completion in a later second removes ambiguity.

The visible code-review row must name the same head and a valid completion time
strictly after the trusted request. Evidence order uses that code completion
time, rather than summary `updated_at`, so a security-only edit cannot renew old
code approval or supersede later receipt text. GitHub's second-precision comment
times and subsecond completion rows use second buckets; ambiguous ties stay
pending. Headings and reactions are not proof. Native P0–P2 findings, unresolved
threads and malformed receipt envelopes retain their vetoes, including duplicate
verdict/SHA fields, unknown markers, extra lines and explicit P0–P2 receipt
findings. Contradictory visible summary status invalidates machine state. Reruns
wait for active gates and coalesce events already read by a later attempt.

While this contract upgrade is under review, the trusted default-branch gate
still requires its accepted legacy receipt or native formal review. Request real
review for the exact PR head and rerun the existing Actions gate if necessary.
New presentation prose plus structured state cannot make the old parser accept
an unsupported format. Do not execute proposed scripts with write permission,
fabricate a status, or bypass a failed gate. Subsequent reviews use this contract
only after it has been merged normally.
