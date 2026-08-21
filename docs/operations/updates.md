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
whole update stops. Writes are staged and rolled back if apply fails before the
new lock is installed.

If a release changes `.web-design/managed-files.json`, review the ownership diff
first and pass `--accept-ownership-change` (or enable the matching manual
workflow input). Without that explicit acknowledgement, newly managed paths are
rejected. The trusted pull-request validator then compares every proposed byte,
including additions and removals, with the exact pinned upstream commit.

The manual `Web Design Update` workflow runs from the consumer default branch,
downloads bytes at the supplied full SHA, commits them on a dedicated branch,
and opens a pull request. Downloaded scripts are not executed during that run.
The workflow's ownership-change option defaults to off. Normal pull-request
checks use policy from the trusted default branch and verify the proposed new
updater before it can become trusted for a later update.

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
