# Stage hosting

The study is served from one Cloudflare Worker named `ember`, built by
Cloudflare Workers Builds from a connected Git repository. The repository is the
source of truth for the Worker name and its runtime configuration
([`website/wrangler.json`](../website/wrangler.json)); Cloudflare owns the Git
connection and the build credentials, so no Cloudflare token is stored in GitHub
or committed here.

The page is one self-contained HTML file, so its build copies rather than
compiles: [`website/scripts/build.mjs`](../website/scripts/build.mjs) assembles
`dist/` from `src/` - exactly `index.html`, `favicon-32.png`,
`apple-touch-icon.png` and `og.png` - and fails if the page ever gains an
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
connection. Changing which repository builds this Worker does not touch it -
which is exactly why the cutover below reused this Worker rather than creating
a second one.

`https://ember.ks-design.art` is the origin baked into the page's `og:url` and
`og:image` meta tags and into `ORIGIN` in `website/scripts/build.mjs`. Those two
absolute URLs are the only ones the build allows, and only as the complete
`content` value of an `og:` meta tag. Renaming the Worker or moving the study to
another domain would therefore be a code change here, not just a dashboard
change.

## Current state

**The cutover is done: the Worker `ember` builds from `kiaquila/ember`.** The
Worker was created while the project lived in the `kiaquila/web-design`
monorepository, but its Git connection now points here. Pushing to `main` in
this repository updates the stage, and Cloudflare's `Workers Builds: ember`
check runs on this repository's pull requests and commits.

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
| Included build watch path | default - this repository holds one project |

`kiaquila/web-design` no longer builds or registers this Worker, and its former
`ember/` source directory has been removed. It is history, not a deployable
fallback. Recovery uses a previously deployed Cloudflare Worker version as
described in **Rollback** below.

## Cutover record - completed

The account owner moved the existing Worker rather than creating or renaming
one. The first production build from this repository was the merge of
[pull request #5](https://github.com/kiaquila/ember/pull/5) (`2c5cd6e`) on
2026-08-27. Keeping the same Worker preserved its version history, stable
workers.dev address and custom-domain binding.

The sequence below is retained as the verified history of that cutover, not as
a description of work still to do. Only the account owner could perform it
because the Git connection and build credentials live in Cloudflare.

1. The active Worker version and its source commit were recorded as the
   pre-cutover rollback point.
2. The Cloudflare GitHub App was authorized for the private `kiaquila/ember`
   repository.
3. The `kiaquila/web-design` Git connection was disconnected before the new
   one was attached, so two repositories could not build the same Worker.
4. `kiaquila/ember` was connected to the existing `ember` Worker with the
   settings shown in **Current state** above.
5. A non-production branch build and its versioned preview URL were verified
   before `main` was allowed to build.
6. The production build completed, then both the stable workers.dev URL and the
   custom domain were verified.

The monorepository watch path `ember/*` matches nothing here and would stop
every build, which is why it was cleared back to the default; narrowing it to
`website/*` is also correct and only skips builds for root-document changes.

## Verify the stage

- `https://ember.ks-design.workers.dev` and `https://ember.ks-design.art` both
  return the study, and an unknown path returns the same page - the asset
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

Rollback is a Cloudflare version operation; there is no source checkout to
reconnect in `kiaquila/web-design`.

1. **Immediately before changing production, fetch the active deployment
   again.** Never use a version id copied from this document, an old terminal or
   a build link:

   ```bash
   cd website
   npm exec -- wrangler deployments status
   npm exec -- wrangler deployments list
   ```

   Record the version receiving 100% of traffic and the command timestamp.
2. Choose a known-good earlier version from the fresh deployment list. Confirm
   that it is different from the active version and predates the incident.
3. In the Cloudflare dashboard, roll `ember` back to that version. The locked
   CLI equivalent from `website/` is:

   ```bash
   npm exec -- wrangler rollback <version-id>
   ```

4. Run `npm exec -- wrangler deployments status` again and confirm that the
   intended rollback version receives 100% of production traffic.
5. Repeat **Verify the stage** for both
   `https://ember.ks-design.workers.dev` and `https://ember.ks-design.art`.
   The custom domain follows the rollback because it is bound to the Worker.

The Git connection remains on `kiaquila/ember`; a later successful production
build from `main` supersedes the rollback deployment.
