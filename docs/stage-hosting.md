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
which is exactly why the cutover below reused this Worker rather than creating
a second one.

`https://ember.ks-design.art` is the origin baked into the page's `og:url` and
`og:image` meta tags and into `ORIGIN` in `website/scripts/build.mjs`. Those two
absolute URLs are the only ones the build allows, and only as the complete
`content` value of an `og:` meta tag. Renaming the Worker or moving the study to
another domain would therefore be a code change here, not just a dashboard
change.

## Current connection — this repository builds the Worker

**The cutover is done: the Worker `ember` builds from `kiaquila/ember`.** The
Worker was created while the project lived in the `kiaquila/web-design`
monorepository; the account owner moved its Git connection here, and pushing to
`main` in this repository is now what updates the stage. The first production
build from here was the merge of
[pull request #5](https://github.com/kiaquila/ember/pull/5) (`2c5cd6e`), and
Cloudflare's `Workers Builds: ember` check now runs on this repository's pull
requests and commits.

The `stage:deploy` and `stage:preview` scripts in `website/package.json` are
what Cloudflare runs on its own builders. No workflow in this repository calls
them, and no Cloudflare credential is stored in GitHub.

| Setting | Value in Cloudflare today |
| --- | --- |
| Worker name | `ember` |
| Repository | `kiaquila/ember` |
| Production branch | `main` |
| Root directory | `website` |
| Build command | `npm run build` |
| Production deploy command | `npm run stage:deploy` |
| Non-production deploy command | `npm run stage:preview` |
| Included build watch path | default — this repository holds one project |

`kiaquila/web-design` no longer builds this Worker. Its `ember/` source path is
still present there, which is what keeps the full rollback below available.

## Cutover to this repository — completed

This is the procedure the account owner followed, kept as the record of the
order it takes and as the procedure to repeat if the connection ever has to be
rebuilt. Only the account owner can run it: the Git connection and the build
credentials live in Cloudflare.

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
5. Enter the settings from **Current connection** above.
6. Under **Settings → Build → Branch control**, keep `main` as production and
   enable builds for non-production branches.
7. Open a throwaway pull request, or push a branch, and confirm the preview
   builds and answers at its versioned URL before touching production.
8. Only then let `main` build, and verify both the stable URL and the custom
   domain.

The monorepository watch path `ember/*` matches nothing here and would stop
every build, which is why it was cleared back to the default; narrowing it to
`website/*` is also correct and only skips builds for root-document changes.

## Verify the stage

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

- **Fastest:** in Cloudflare, roll the Worker back to an earlier version —
  including the pre-cutover version id recorded in step 1. That restores a
  previously served build without any Git change, and the custom domain follows
  it because it is bound to the Worker.
- **Full:** disconnect `kiaquila/ember`, reconnect `kiaquila/web-design` with
  root `ember/website` and the `ember/*` watch path, and rebuild from `main`.
  This works for as long as `ember/` remains in that repository. That source
  path is still there and is to be kept as the rollback route.

## Still owed in the monorepository

`kiaquila/web-design` still lists `ember` in `stageProjects` in its
`.repo-guard.json`, which is what mirrors stable builds into that repository's
`ember / stage` GitHub environment. Now that this repository owns the Worker,
that entry describes a stage the monorepository no longer builds. Removing it
is the account owner's next step there: its own pull request in that
repository, following its documented procedure for retiring a stage — and the
project source and history stay in place, both as history and as the full
rollback route above.
