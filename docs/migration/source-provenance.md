# Source provenance

This repository was extracted from the `ember/` directory of the
`kiaquila/web-design` multi-project workspace on 2026-08-21. Nothing was
re-created by hand: the published tree and the project's whole commit history
were carried over by `git filter-repo` and then proved against the source.

## Source identity

| Fact | Value |
| --- | --- |
| Source repository | `kiaquila/web-design` |
| Source commit (published `main`) | `3b99cb3d23328013c28eb73ab8525b13b6992d9e` |
| Source subtree | `ember/` |
| Source subtree tree object | `d813adb9d9e5794e4f9d73d74b68cc00a8e73ce6` |
| Rewritten `main` | `ca149515a25da1bb218273c9ff4c993926ecebc6` |
| Tags | none — the source project carried no tag |

## How the history was rewritten

In a disposable clone of `kiaquila/web-design`, taken with
`--single-branch --branch main` so that no unrelated branch could be carried
along:

```bash
git filter-repo --path ember/ --path-rename ember/:
```

The rename lifts `ember/website` to `website` and the two project documents —
`README.md` and `AGENTS.md` — to the repository root, which is the only topology
change the history rewrite makes.

## Proof taken before any migration edit

All four checks were run on the filtered clone, before the baseline or any
adaptation was committed.

1. **Exact tree.** The root tree of the rewritten `main` is
   `d813adb9d9e5794e4f9d73d74b68cc00a8e73ce6` — the same tree object the source
   repository published under `ember/` at
   `3b99cb3d23328013c28eb73ab8525b13b6992d9e`. All 15 files are therefore
   byte-identical to the source, not merely equivalent.
2. **Commit history.** Both project commits that ever touched `ember/` are
   present, with their original authors and dates, and the rewritten `main`
   carries exactly those two and nothing else:

   | Rewritten | Source | Subject |
   | --- | --- | --- |
   | `84680b6` | `9dc986a` | Add the Ember lab study and the ks·design wordmark (#44) |
   | `ca14951` | `3b99cb3` | Add the Ember og social card (#45) |

   The source repository squash-merges its pull requests, so each of those two
   pull requests was already a single commit upstream before this migration
   existed, and there are no merge commits to preserve. `git filter-repo` parsed
   143 upstream commits and pruned the 141 that never touched `ember/`.
3. **No stray refs.** Only `main` was pushed. The source repository's one tag,
   `chaijana-iteration-01`, belongs to another project and was pruned by the
   rewrite — `ref-map` records it as deleted — so no tag was carried over.
4. **Object integrity.** `git fsck --full --strict` reports no problem.

### The uncommitted `make-og.mjs` was not carried over

At the time of this migration a separate local worktree held an uncommitted
edit to `ember/website/scripts/make-og.mjs`. The source of this repository is
strictly the immutable commit above, and that edit is not in it. The filter ran
against `3b99cb3d23328013c28eb73ab8525b13b6992d9e` in a fresh clone taken
directly from GitHub, so no working-tree file could enter the rewrite at all.
The proof is the same tree object as above, and, for that one file, the blob:

| Fact | Value |
| --- | --- |
| `website/scripts/make-og.mjs` blob here | `e006d7187fce62b28381571bfccff789433595a7` |
| `ember/website/scripts/make-og.mjs` blob at the source commit | `e006d7187fce62b28381571bfccff789433595a7` |
| SHA-256 of the file's contents | `6bba5eaf61cf6d71ae9bebb8f72e429bdccba10663937a3137af019c32dab521` |

## Deliberately not migrated

- **Other customer projects.** `alex-neon`, `alphacentr`, `chaijana`, `ks` and
  `misha` never entered this history. The filter kept a single path.
- **Monorepository-only infrastructure.** `.repo-guard.json`, the multi-project
  `ci.yml`, the shared `docs/stage-hosting.md`, the Cloudflare
  stage-registration workflow and script, and the KS production-deploy workflow
  describe a workspace that no longer exists here; the `web-design` baseline
  replaces them, and this project's own stage settings now live in
  `docs/stage-hosting.md` at this root.
- **Generated output.** `website/dist/` was never tracked upstream and is not
  tracked here; `npm run build` reproduces it from `website/src/`.
- **Third-party notices for other projects.** `third-party-notices.md` keeps
  only the baseline's own notice. This study ships no third-party font, image,
  script or style: it is system fonts, canvas 2D and synthesized audio.

## Commit map

`git filter-repo` wrote a full old→new commit map for all 143 rewritten
commits. It is not committed — it describes the migration event, not the
product — and is kept locally at
`~/projects/web-design/.claude/migration/ember-2026-08-21/`:

| File | SHA-256 |
| --- | --- |
| `commit-map.txt` | `230e8826cf901b53a4f9d7b06493ade0f6a3101e3afdcaa89644f77fedeaffa6` |
| `ref-map.txt` | `85b8571c31a753e17ea7d8e36c9146f566d3a6bb969e63692a16e2def3a6ff51` |

The same map can be reproduced at any time by re-running the command above
against `3b99cb3d23328013c28eb73ab8525b13b6992d9e`; the rewrite is
deterministic.

## Topology adaptation

Only path topology and repository-shape wording were adapted. **No design
decision, source reference, interaction rule or client-approved fact was
changed.** The Pinterest and reactive-dots provenance, the 2026-08-19 and
2026-08-20 client decisions, the rolled-back rebirth variant, the brand-gold
dot value `#e8a038` and the `https://ks-design.art` footer credit are all as
they were.

- `README.md` and `AGENTS.md`: `npm --prefix ember/website run check|dev` lost
  the directory prefix, and `node scripts/check-repository.mjs` became
  `npm run preflight`, which is the baseline's own repository check.
- `AGENTS.md` gained a short **Shared standards** section pointing at
  `docs/standards/` and `.web-design/project.json`, because the baseline's own
  `AGENTS.md` — which normally carries that pointer — was not installed over the
  project's approved instructions. Its opening line no longer defers to a root
  `AGENTS.md`: this file is now the root one.
- The stage sections of both documents point at this repository's own
  [`../stage-hosting.md`](../stage-hosting.md) instead of the monorepository's,
  and both now say plainly that the Worker has not been moved yet. The
  `static-cloudflare` profile keeps Worker names, domains and account
  identifiers project-owned, so they belong here rather than in the baseline.
- `README.md` gained a **Repository baseline** section recording the provisional
  pin and pointing at this document.
- `CLAUDE.md` and the root `package.json` came from the baseline and were named
  for this project.
- `website/` was not touched at all: no source file, script, asset, test or
  `wrangler.json` value differs from the source commit. The single
  dependency-free page, the four-file build and its off-origin check, the seeded
  `og.png` with its geometry fingerprint, the gesture-gated Web Audio synthesis,
  the reduced-motion handling, the favicons and the Worker's inline-source CSP
  exception all carry over unchanged.

## Baseline pin — provisional

`.web-design/lock.json` pins
`f567b125e4ecf07922a6b2f98b5cf17b338b478d` from the
`codex/web-design-template-v2` branch of `kiaquila/web-design`, at version
`0.1.0-dev`.

**This is deliberately a provisional pin.** `kiaquila/web-design` has not yet
published an immutable stable release, because the pull request that turns it
into a template — [`kiaquila/web-design#46`](https://github.com/kiaquila/web-design/pull/46)
— is still a draft and must not be merged until every project has been migrated
and verified. `f567b125` is the exact, reachable commit that pull request
proposes, so it is a real 40-character SHA that `baseline-source-verification`
can download and compare, and the standard `npm run setup` adoption path
accepted it without any workaround.

### Required follow-up

After `kiaquila/web-design#46` is merged and the first immutable stable release
is published, this project must be moved onto that release's full commit SHA in
its own separate pull request:

```bash
npm run sync:web-design -- plan  --source-ref <stable-release-sha> --version <x.y.z>
npm run sync:web-design -- apply --source-ref <stable-release-sha> --version <x.y.z>
```

Until that pull request is merged, this repository is pinned to a prerelease
baseline and `0.1.0-dev` must not be treated as a released version.

## Cloudflare — prepared, not switched

Nothing in Cloudflare was changed during this migration. The Worker `ember`
still builds from `kiaquila/web-design` at root `ember/website`, and both
`https://ember.ks-design.workers.dev` and the custom domain
`https://ember.ks-design.art` keep answering from that build. The target
settings, the verification and the rollback-safe cutover order are in
[`../stage-hosting.md`](../stage-hosting.md). Until the cutover happens, the
source directory in the monorepository must stay in place, and the two
repositories must never both deploy this Worker.
