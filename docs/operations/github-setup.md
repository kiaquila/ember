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
6. Protect `main` with pull requests, required Code Owner review, conversation
   resolution, no force pushes, no branch deletion, stale approval dismissal,
   and the actual check names from `.web-design/project.json`. Do not register a
   required check before it has run. Keep `.github/CODEOWNERS` aligned with the
   repository owner.
   `baseline-source-verification` is published against the PR head by a trusted
   default-branch `workflow_run`; require that exact check name after its first
   successful run.
7. Enable available dependency alerts, automated fixes, secret scanning, and
   push protection.
8. Keep deployment secrets in environment-scoped stores and restrict production
   environments to `main` plus any required human approval.

Some private-repository plans do not expose every protection. Record the missing
control instead of claiming it is active.

For organization-owned repositories, prefer an organization ruleset with a
required workflow or a GitHub App check for the strongest immutable guard. In a
user-owned repository, the default-branch `workflow_run` plus required Code
Owner review protects the shared workflow and baseline paths from collaborator
changes, but the repository owner remains an administrative trust root.
