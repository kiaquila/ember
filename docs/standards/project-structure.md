# Project structure

Each repository owns exactly one product or business. Product code, evidence,
design decisions, assets, deployment configuration, and project instructions
stay together; other customer projects are never copied in as examples.

The root `AGENTS.md` contains shared and project-specific instructions.
`.web-design/project.json` records the selected profile and executable checks.
`docs/standards/` is upstream-managed. Product documentation may use any clear
project-local structure and is never overwritten by baseline updates.

Dependency directories, caches, generated builds, local tooling state, private
exports, and deployment credentials are not versioned unless a project document
explicitly identifies a generated artifact as a deliverable and explains why.
