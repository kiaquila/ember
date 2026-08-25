# Baseline updates

`web-design` publishes immutable releases. A consumer pins the release's exact
40-character commit SHA in `.web-design/lock.json`; a tag or channel is only a
human discovery aid.

Use `sync-project.mjs plan` before `apply`. The installed trusted updater reads
the upstream release manifest, validates path traversal, duplicate paths,
symlinks, and SHA-256 hashes, then compares the destination with its previous
lock. If any managed destination differs from that lock, the whole operation
stops before writing. There is no force mode. A revoked managed file is deleted
only when its current hash still matches the installed lock; otherwise the
whole update stops — except for a path the repository is required to have,
which is handed over instead of taken away: it leaves the lock and keeps
whatever bytes it has, local edits included. Writes are staged and rolled back
if apply fails before the new lock is installed.

A release may not revoke a required root file in the same release that
introduces that handover. The update workflow checks the consumer out and runs
the `scripts/sync-project.mjs` already in its tree, so the updater performing
any given upgrade is the previous one: it would delete a pristine required file
and refuse the update outright over an edited one. Ship the handover first, and
revoke in the release after it, once consumers are running the updater that
performs it.

A release may also tighten what the guard accepts in project-owned
configuration, and the updater cannot fix that for the consumer: it writes
managed bytes and does not touch `.web-design/project.json`, so the guard run
after a successful update is where the consumer finds out. This release reads a
product check at its command position rather than searching the line for the
tool's verb, so an option may no longer precede that position, and a step that
only installs dependencies is not a check by itself. Existing checks are
rewritten in place, keeping the same work and the same order:

```bash
npm --prefix website test                 # before
npm test --prefix website                 # after

npm ci --prefix website                   # before, on its own
npm ci --prefix website && npm run lint --prefix website   # after, joined to the check it prepares
```

That ordering cannot rescue a consumer whose managed file is *already* edited.
The installed updater compares the destination against its lock before it reads
any release, so no release can change what happens next: restore the file to
its locked bytes, run the update, and make the edit again afterwards if the
release hands the file over.

If a release changes `.web-design/managed-files.json`, review the ownership diff
first and pass `--accept-ownership-change` (or enable the matching manual
workflow input). Without that explicit acknowledgement, newly managed paths are
rejected. The trusted pull-request validator then compares every proposed byte,
including additions and removals, with the exact pinned upstream commit.

The manual `Web Design Update` workflow runs from the consumer default branch,
downloads bytes at the supplied full SHA, commits them on a dedicated branch,
and opens a pull request. Downloaded scripts are not executed during that run.
The branch name includes the workflow run ID and attempt, so retrying an update
cannot collide with a branch left by an earlier failed or closed run. The
workflow's ownership-change option defaults to off. It creates the branch and
pull request with `GITHUB_TOKEN`, so GitHub keeps candidate-controlled
`pull_request` workflows approval-gated. The already trusted update workflow
instead validates the exact generated head in read-only jobs, publishes
head-bound `project-ci`, `repository-guard`, `osv-scan`, and
`baseline-source-verification` checks, and dispatches the trusted Codex gate.
Candidate workflow bytes therefore do not execute automatically before the
update has passed the trust-promotion review boundary.

After applying or checking out an update, run
`npm ci --ignore-scripts --prefix .web-design/policy` before any structural
repository check or `npm run preflight`. The dependency and lockfile under
`.web-design/policy/` are managed baseline files; the consumer's root package
files remain project-owned and must stay byte-for-byte unchanged by the updater.

For a private `web-design` source, the consumer stores a read-only
`WEB_DESIGN_READ_TOKEN` as described in `github-setup.md`. The token is not
available to `pull_request` jobs. After the read-only Repository Guard finishes,
a trusted default-branch `workflow_run` downloads the pinned source, checks the
proposal, and publishes `baseline-source-verification` on the exact SHA of the
completed Repository Guard run. It fails closed if that SHA no longer matches
the associated pull-request head. Canonical-source validation is selected only
when `github.repository` is exactly `kiaquila/web-design`; a consumer cannot
promote itself by editing project configuration. A
public source needs no extra token and falls back to the repository token.

Project-owned files include product code and assets, root README and AGENTS,
`.web-design/project.json`, deploy workflows and configuration, secrets, domains,
and business documentation. They are never listed in the managed manifest.
