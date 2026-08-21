# Bootstrap and adoption

For a new repository, use the GitHub template, install the managed policy's
pinned dependency with
`npm ci --ignore-scripts --prefix .web-design/policy`, and then run
`npm run setup` with a
lower-case kebab-case slug, one profile, the exact 40-character SHA of the
immutable `web-design` release used by the template, and one or more real check
commands. Pass the release identity as `--source-commit <sha>`; setup refuses to
create a consumer lock without it.
The setup command changes only `.web-design/project.json` and the local profile
and source records in `.web-design/lock.json`; it never deploys or creates
credentials.

The first project pull request may add or change project-owned files required by
the selected profile, including application code and `wrangler.json`. Trusted
validation still requires every managed baseline byte to match the pinned
release. This broader allowance exists only for the initial transition from the
template's source state to a consumer with a full release SHA; later baseline
updates may not bundle project-owned changes.

For an existing repository, work in an isolated migration branch. Preserve its
history, README, instructions, assets, application code, deploy configuration,
and verified facts. Add the baseline as a separate reviewable commit, configure
the project, run `npm ci --ignore-scripts --prefix .web-design/policy` once, run
both old and new checks, and confirm that no other customer project or
monorepository-only workflow was imported. The isolated policy install must not
replace, rewrite, or claim ownership of the consumer's root `package.json` or
lockfile.
