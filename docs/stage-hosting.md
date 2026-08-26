# Stage hosting

The study is served from one Cloudflare Worker named `ember`, built by
Cloudflare Workers Builds from a connected Git repository. The repository is the
source of truth for the Worker name and its runtime configuration
([`website/wrangler.json`](../website/wrangler.json)); Cloudflare owns the Git
connection and the build credentials, so no Cloudflare token is stored in GitHub
or committed here.

The page is one self-contained HTML file, so its build copies rather than
compiles: [`website/scripts/build.mjs`](../website/scripts/build.mjs) assembles
`dist/` from `src/` — exactly `index.html`, `favicon-32.png`,
`apple-touch-icon.png` and `og.png` — and fails if the page ever gains an
off-origin reference, loses a favicon, references a file the build does not
publish, or if `src/` grows a fifth file.

[`website/worker/index.ts`](../website/worker/index.ts) exists only to attach
the security headers Workers Static Assets does not set on its own. Its
Content-Security-Policy is the one place in this project that allows inline
script and style, because the page's stylesheet and its canvas program are
inline by design. Everything else stays shut, including `connect-src 'none'`,
and it is the build's off-origin check that makes that allowance safe. Do not
widen the inline exception and do not weaken that check.

| Event | Command after `npm run build` | Result |
| --- | --- | --- |
| Push or merge to `main` | `npm run stage:deploy` | Updates the stable stage |
| Push to any other branch | `npm run stage:preview` | Uploads an isolated version and adds its URL to the pull request |

The stable URL is `https://ember.ks-design.workers.dev`, and the study is also
reachable at the custom domain `https://ember.ks-design.art`, which the ks
portfolio links. A pull request gets a versioned URL shaped like
`https://<version>-ember.ks-design.workers.dev`. The version prefix is assigned
by Cloudflare and must not be hard-coded.

`workers_dev: true` keeps the stable stage reachable and `preview_urls: true`
keeps the per-pull-request previews. Both are set in `website/wrangler.json`,
together with the pinned `compatibility_date`, `run_worker_first: true` so the
headers are attached to every response, `html_handling:
"auto-trailing-slash"` and `not_found_handling: "single-page-application"`,
which serves the one page for any unknown path.

The custom domain is bound to the Worker in Cloudflare, not to the Git
connection. Changing which repository builds this Worker does not touch it —
which is exactly why the cutover below must reuse this Worker rather than
create a second one.

`https://ember.ks-design.art` is the origin baked into the page's `og:url` and
`og:image` meta tags and into `ORIGIN` in `website/scripts/build.mjs`. Those two
absolute URLs are the only ones the build allows, and only as the complete
`content` value of an `og:` meta tag. Renaming the Worker or moving the study to
another domain would therefore be a code change here, not just a dashboard
change.

## Current connection — Cloudflare integration off

**This repository has no Cloudflare integration and deploys nothing.** The
Worker was created while the project lived in the `kiaquila/web-design`
monorepository and **still builds from that repository**. Nothing in Cloudflare
has been changed by this migration, and connecting it is out of scope here: the
cutover below is an account-owner action, to be run deliberately and separately.

The `stage:deploy` and `stage:preview` scripts in `website/package.json` are
what Cloudflare runs on its own builders once connected. No workflow in this
repository calls them, and no Cloudflare credential is stored in GitHub.

| Setting | Value in Cloudflare today |
| --- | --- |
| Worker name | `ember` |
| Repository | `kiaquila/web-design` |
| Production branch | `main` |
| Root directory | `ember/website` |
| Build command | `npm run build` |
| Production deploy command | `npm run stage:deploy` |
| Non-production deploy command | `npm run stage:preview` |
| Included build watch path | `ember/*` |

The source path `ember/` is still present in `kiaquila/web-design`, so that
connection keeps working until it is deliberately changed.

## Cutover to this repository

Only the account owner can do this: the Git connection and the build credentials
live in Cloudflare. Do not start before this repository's migration pull request
is merged and its checks are green on `main`.

1. In Cloudflare, record the Worker's **current active version id** and the
   commit it was built from. That is the rollback point.
2. Authorize the Cloudflare GitHub App for `kiaquila/ember`. The repository is
   private, so the installation has to be granted access to it explicitly.
3. **Disconnect the existing Git connection** from `kiaquila/web-design` before
   connecting the new one. Two repositories must never be able to build the same
   Worker at the same time.
4. Connect `kiaquila/ember` to the same Worker — do not create a second Worker,
   and do not rename this one. Cloudflare requires the dashboard name to match
   `name` in `website/wrangler.json`, and the `ember.ks-design.art` custom
   domain is attached to this Worker.
5. Enter the settings below.
6. Under **Settings → Build → Branch control**, keep `main` as production and
   enable builds for non-production branches.
7. Open a throwaway pull request, or push a branch, and confirm the preview
   builds and answers at its versioned URL before touching production.
8. Only then let `main` build, and verify both the stable URL and the custom
   domain.

| Setting | Value after cutover |
| --- | --- |
| Worker name | `ember` (unchanged) |
| Repository | `kiaquila/ember` |
| Production branch | `main` |
| Root directory | `website` |
| Build command | `npm run build` |
| Production deploy command | `npm run stage:deploy` |
| Non-production deploy command | `npm run stage:preview` |
| Included build watch path | default — this repository holds one project |

The monorepository watch path `ember/*` matches nothing here and would stop
every build. Clearing it back to the default is what replaces it; narrowing it
to `website/*` is also correct and only skips builds for root-document changes.

## Verify after cutover

- `https://ember.ks-design.workers.dev` and `https://ember.ks-design.art` both
  return the study, and an unknown path returns the same page — the asset
  configuration is a single-page-application fallback, not a 404.
- The security headers from `website/worker/index.ts` are present, including the
  Content-Security-Policy with `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'` and `connect-src 'none'`, unchanged from
  what this repository ships.
- `https://ember.ks-design.art/og.png` returns the 1200×630 social card, and the
  page's `og:url` and `og:image` still name `https://ember.ks-design.art`.
- `favicon-32.png` and `apple-touch-icon.png` are served; the inline SVG favicon
  still inverts under a dark browser theme.
- With a real gesture: hover ignites and recovers, Play runs the full burn →
  reassemble cycle with the tuning-fork strike, Stop halts it, and mute silences
  everything. A scripted `click()` grants no user activation and proves nothing.
- The console is clean and no request leaves the origin.
- The portfolio's link to the study still resolves.

## Rollback

- **Fastest:** in Cloudflare, roll the Worker back to the version id recorded in
  step 1. That restores the previously served build without any Git change, and
  the custom domain follows it because it is bound to the Worker.
- **Full:** disconnect `kiaquila/ember`, reconnect `kiaquila/web-design` with
  root `ember/website` and the `ember/*` watch path, and rebuild from `main`.
  This works for as long as `ember/` remains in that repository, which is why
  the source path must not be deleted until this stage has been verified from
  here.

## After a verified cutover

`kiaquila/web-design` still lists `ember` in `stageProjects` in its
`.repo-guard.json`, which is what mirrors stable builds into that repository's
`ember / stage` GitHub environment. Once this repository owns the Worker, that
entry describes a stage the monorepository no longer builds. Remove it there in
its own pull request, following that repository's documented procedure for
retiring a stage — and keep the project source and history in place.
