// The paths every repository built from this template must have, shared by
// the guard that checks them and the updater that must never delete one.
//
// It lives in its own module because the updater has to run on a bare runner
// with nothing installed: importing this list from `check-repository.mjs`
// pulled in that file's YAML parser at load time and made
// `node scripts/sync-project.mjs` fail with a missing module before it could
// read a release. Nothing here may import anything.
export const FORBIDDEN_REPOSITORY_SEGMENTS = Object.freeze([
  ".next",
  ".vinext",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules"
]);

export function canonicalRepositorySegment(segment) {
  return String(segment).replace(/\.+$/, "").toLowerCase();
}

const forbiddenRepositorySegments = new Set(
  FORBIDDEN_REPOSITORY_SEGMENTS.map(canonicalRepositorySegment)
);
const managedControlSegments = new Set([".git", ".github", ".web-design"]);

export function isRestrictedRepositorySegment(segment) {
  const canonical = canonicalRepositorySegment(segment);
  return forbiddenRepositorySegments.has(canonical) || managedControlSegments.has(canonical);
}

// A configured check may run at the repository root or in project-owned
// source, but never outside the repository, inside a generated/dependency
// tree, or inside the baseline's managed control plane. Keep this dependency
// free so both the policy validator and the bare project-check runner can use
// the same boundary.
export function normalizeProjectOwnedDirectory(value) {
  if (typeof value !== "string") return null;
  const requested = value.trim();
  if (!requested || requested.includes("${{") || !/^[@A-Za-z0-9._/-]+$/.test(requested)) {
    return null;
  }
  if (requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) return null;

  const segments = [];
  for (const segment of requested.split("/")) {
    if (!segment || segment === ".") continue;
    // Do not normalize traversal away: a safe-looking result can still cross
    // a symlink before `..` is applied by the filesystem.
    if (segment === ".." || isRestrictedRepositorySegment(segment)) return null;
    segments.push(segment);
  }
  return segments.join("/") || ".";
}

export const REQUIRED_ROOT_FILES = [
  ".gitignore",
  ".github/CODEOWNERS",
  ".web-design/project.json",
  ".web-design/lock.json",
  ".web-design/managed-files.json",
  ".web-design/release-manifest.json",
  ".github/pull_request_template.md",
  ".github/workflows/baseline-source-verification.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/repository-guard.yml",
  ".github/workflows/osv-scan.yml",
  ".github/workflows/web-design-update.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/standards/content-and-design.md",
  "docs/standards/deployment.md",
  "docs/standards/git-and-reviews.md",
  "docs/standards/project-structure.md",
  "docs/standards/security.md",
  "docs/standards/testing.md",
  "docs/operations/bootstrap.md",
  "docs/operations/github-setup.md",
  "docs/operations/updates.md",
  ".web-design/policy/package-lock.json",
  ".web-design/policy/package.json",
  "scripts/check-managed-files.mjs",
  "scripts/check-baseline-change.mjs",
  "scripts/check-repository.mjs",
  "scripts/build-release-manifest.mjs",
  "scripts/run-project-checks.mjs",
  "scripts/sync-project.mjs",
  "scripts/test-web-design.mjs"
];
