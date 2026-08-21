# GitHub repository setup

The template contains guardrail workflows; repository settings still require an
owner with GitHub administration access.

The template-v2 cutover PR is a one-time trust bootstrap: if the default branch
does not yet contain `.web-design/project.json`, Repository Guard uses the
proposed template-v2 checker and emits a warning. After that PR is merged, every
later pull request uses the checker from the trusted default branch. Review the
bootstrap PR independently before merge and never reintroduce a pre-v2 default
branch afterward.

After the first green workflow run:

1. Confirm the repository is private unless its content is intentionally public.
2. Keep `main` as the default branch and enable automatic head-branch deletion.
3. Allow GitHub Actions to create pull requests so `Web Design Update` can work.
4. If `kiaquila/web-design` remains private, add `WEB_DESIGN_READ_TOKEN` as an
   Actions secret. Use a fine-grained token or GitHub App installation token
   with read-only Contents access to that repository and no access to customer
   repositories. It is used only by trusted `workflow_dispatch` and
   `workflow_run` jobs, never by a pull-request job. Rotate it independently.
5. Configure the Codex repository environment/application, then request a review
   for the current full PR head SHA.
6. When the repository plan supports it, protect `main` with pull requests,
   required Code Owner review, conversation resolution, no force pushes, no
   branch deletion, stale approval dismissal, and the actual check names from
   `.web-design/project.json`. Do not register a required check before it has
   run. Keep `.github/CODEOWNERS` aligned with the repository owner.
   `baseline-source-verification` is published against the PR head by a trusted
   default-branch `workflow_run`; require that exact check name after its first
   successful run.
7. Protect the privileged manual workflow with an environment, not only with
   its `if` condition. A manual run selects a ref, and GitHub loads that ref's
   copy of the workflow file, so a branch can delete the condition it disagrees
   with before asking for the write token. The repository guard can only check
   the workflows a pull request proposes; it cannot police a direct branch push.
   Give `Web Design Update` a deployment environment whose branch rule allows
   only the default branch, so GitHub — not the workflow file — decides whether
   the job may run and whether its secrets are readable. Until that environment
   exists, treat push access to this repository as equivalent to write access
   through this workflow, and record that rather than claiming the condition
   enforces it.
8. Enable available dependency alerts, automated fixes, secret scanning, and
   push protection.
9. Keep deployment secrets in environment-scoped stores and restrict production
   environments to `main` plus any required human approval.

Some private-repository plans do not expose branch protection or rulesets and
may return `403` from their APIs. Record the missing control instead of claiming
it is active. Do not make a private repository public to unlock a protection
feature.

When enforced protection is unavailable, the repository owner must apply the
completion contract manually before every merge: record the exact full head SHA;
confirm that every contractual check is successful on that same head; confirm
that every P0-P2 review finding is resolved; then observe a 120-second quiet
period and fetch the PR again. Immediately before merging, recheck that the head
SHA is unchanged, the same checks are still green, and no unresolved P0-P2
thread or newer blocking review has appeared. This documented procedure is a
mandatory fallback, not a claim that the branch is technically protected.

For organization-owned repositories, prefer an organization ruleset with a
required workflow or a GitHub App check for the strongest immutable guard. In a
user-owned repository, the default-branch `workflow_run` plus required Code
Owner review protects the shared workflow and baseline paths from collaborator
changes, but the repository owner remains an administrative trust root.
