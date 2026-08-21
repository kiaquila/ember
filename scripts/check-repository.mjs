#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requirePolicyDependency = createRequire(
  new URL("../.web-design/policy/package.json", import.meta.url)
);
const policyNodeModules = resolve(
  fileURLToPath(new URL("../.web-design/policy/node_modules", import.meta.url))
);
const yamlEntry = resolve(requirePolicyDependency.resolve("yaml"));
if (!yamlEntry.startsWith(`${policyNodeModules}${sep}`)) {
  throw new Error("Managed policy dependency yaml is not installed under .web-design/policy");
}
const { isAlias, isMap, isScalar, isSeq, parseDocument } = requirePolicyDependency(yamlEntry);

const REQUIRED_ROOT_FILES = [
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

const FORBIDDEN_SEGMENTS = new Set([
  ".next",
  ".vinext",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules"
]);
const FORBIDDEN_NAMES = [
  /^\.DS_Store$/,
  /^\.env(?:\..+)?$/,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
  /\.(?:key|p12|pfx|pem|session)$/i
];
const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["OpenAI-style API key", /sk-[A-Za-z0-9_-]{32,}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/]
];
const PERSONAL_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/
];

// Validating free-form shell here is a losing game: every round of review found
// another construct that runs the check but discards its verdict — a trailing
// `; true`, a `|| true`, a `| tee`, a comment, a nested `sh -c`, a line
// continuation. Rather than keep enumerating them, a product check is
// constrained to a shape whose exit status provably comes from a real command.
//
// A check is one line of simple commands joined only by `&&`. That operator is
// the one separator that propagates failure: `A && B` fails when A fails and
// reports B otherwise. `;`, `||`, `|`, and `&` each let an earlier failure be
// discarded, and command substitution, redirection, and expansion can reach
// around the rule entirely. Anything that needs them belongs in a script file
// the project runs, where the code is reviewed rather than quoted.
const KNOWN_NO_OP_COMMAND = /^(?:true|:|exit\s+0|echo(?:\s+.*)?|printf(?:\s+.*)?)$/;
const SHELL_CONTROL_CHARACTERS = /[;|&`<>(){}$\\]/;
// `! npm test` succeeds precisely when the product tests fail.
const SHELL_NEGATION = /(?:^|[\s;&|(])!(?:\s|$)/;

function splitOutsideQuotes(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += character;
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

function outsideQuotes(command) {
  let bare = "";
  let quote = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    bare += character;
  }
  return bare;
}

// The structural rule above bans the shell operators, which leaves one way to
// reach a second round of parsing: hand the text to another shell. Tokens are
// compared rather than pattern-matched so a wrapper (`env sh -c`), a path
// (`/bin/sh -c`), and combined flags (`sh -ec`) are all caught.
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish"]);

// `command true` and `env true` run `true`. These wrappers pass their arguments
// through to another executable, so the word that decides the exit status is
// behind them and the no-op test has to look there.
const COMMAND_WRAPPERS = new Set([
  "command", "env", "exec", "nice", "ionice", "nohup", "stdbuf", "time", "timeout", "xargs"
]);

function unwrapCommandWrappers(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const name = tokens[index].slice(tokens[index].lastIndexOf("/") + 1);
    if (!COMMAND_WRAPPERS.has(name)) break;
    index += 1;
    // Step over the wrapper's own options and their values: `timeout 60`,
    // `nice -n 5`, `env FOO=bar`. Anything containing `=` is an assignment.
    while (index < tokens.length && (tokens[index].startsWith("-") || /=/.test(tokens[index]) || /^\d+$/.test(tokens[index]))) {
      index += 1;
    }
  }
  return tokens.slice(index).join(" ");
}

function executesNestedShell(bareSegment) {
  const tokens = bareSegment.split(/\s+/).filter(Boolean);
  for (const [index, token] of tokens.entries()) {
    if (token === "eval") return true;
    const name = token.slice(token.lastIndexOf("/") + 1);
    if (!SHELL_NAMES.has(name)) continue;
    for (const flag of tokens.slice(index + 1)) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) return true;
    }
  }
  return false;
}

// Single quotes suppress every expansion; double quotes do not, so a command
// substitution can hide inside them and decide the command word at runtime.
function hasExpansionOutsideSingleQuotes(segment) {
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === "$" || character === "`" || character === "\\") return true;
  }
  return false;
}

// With expansions refused, quotes are pure grouping, so removing the quote
// characters (keeping their content) yields the words the shell would run.
function withoutQuoteCharacters(segment) {
  let bare = "";
  let quote = null;
  for (const character of segment) {
    if (quote) {
      if (character === quote) quote = null;
      else bare += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    bare += character;
  }
  return bare;
}

export function validateProductCheckCommand(command) {
  if (/[\n\r]/.test(command)) return "must be a single line";
  const segments = splitOutsideQuotes(command);
  if (segments === null) return "must not leave a quote unclosed";
  for (const segment of segments) {
    const trimmed = segment.trim().replace(/\s+/g, " ");
    if (!trimmed) return "must not contain an empty command";
    const bare = outsideQuotes(trimmed);
    if (SHELL_CONTROL_CHARACTERS.test(bare)) {
      return "must join commands only with && and use no other shell operators";
    }
    if (SHELL_NEGATION.test(bare)) {
      return "must not invert a command's exit status";
    }
    if (hasExpansionOutsideSingleQuotes(trimmed)) {
      return "must not expand anything outside single quotes";
    }
    if (bare.includes("#")) return "must not contain a shell comment";
    const unquoted = withoutQuoteCharacters(trimmed).trim().replace(/\s+/g, " ");
    if (executesNestedShell(unquoted)) {
      return "must not hand shell text to another shell";
    }
    if (KNOWN_NO_OP_COMMAND.test(unwrapCommandWrappers(unquoted))) {
      return "must execute a real product check";
    }
  }
  return null;
}

function parseRoot(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--root");
  if (index === -1) return resolve(import.meta.dirname, "..");
  if (!argv[index + 1]) throw new Error("--root requires a path");
  return resolve(argv[index + 1]);
}

function repositoryFiles(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith(".guard-trusted/"));
}

function looksBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

export function validateProjectConfig(config, profiles = []) {
  const failures = [];
  const availableProfiles = Array.isArray(profiles) ? profiles : Object.keys(profiles);
  if (config?.schemaVersion !== 1) failures.push("project.json schemaVersion must be 1");
  const slug = config?.project?.slug;
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    failures.push("project.slug must be lower-case kebab-case");
  }
  const profile = config?.project?.profile;
  if (typeof profile !== "string" || !availableProfiles.includes(profile)) {
    failures.push(`project.profile must name an installed profile: ${JSON.stringify(profile)}`);
  }
  const productPaths = config?.project?.productPaths;
  if (!Array.isArray(productPaths)) {
    failures.push("project.productPaths must be an array");
  } else {
    for (const path of productPaths) {
      const normalized = typeof path === "string" ? normalize(path) : "";
      if (!normalized || isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
        failures.push(`Unsafe product path: ${JSON.stringify(path)}`);
      }
    }
  }
  if (!Array.isArray(config?.commands?.check)) {
    failures.push("commands.check must be an array");
  } else if (config?.governance?.mode === "consumer" && config.commands.check.length === 0) {
    failures.push("consumer projects must configure at least one product check");
  } else {
    for (const [index, check] of config.commands.check.entries()) {
      if (!check || typeof check !== "object" || Array.isArray(check)) {
        failures.push(`commands.check[${index}] must be an object`);
        continue;
      }
      if (typeof check.name !== "string" || !check.name.trim()) {
        failures.push(`commands.check[${index}].name must be a non-empty string`);
      }
      if (typeof check.run !== "string" || !check.run.trim()) {
        failures.push(`commands.check[${index}].run must be a non-empty string`);
        continue;
      }
      const problem = validateProductCheckCommand(check.run);
      if (problem) failures.push(`commands.check[${index}].run ${problem}`);
    }
  }
  const rootDirectory = config?.deployment?.rootDirectory;
  const normalizedRoot = typeof rootDirectory === "string" ? normalize(rootDirectory) : "";
  if (
    !normalizedRoot ||
    isAbsolute(normalizedRoot) ||
    normalizedRoot === ".." ||
    normalizedRoot.startsWith(`..${sep}`)
  ) {
    failures.push("deployment.rootDirectory must stay inside the repository");
  }
  if (config?.deployment?.productionBranch !== "main") {
    failures.push("deployment.productionBranch must be main");
  }
  const profileData = Array.isArray(profiles) ? null : profiles[profile];
  if (profileData && config?.deployment?.provider !== profileData.deploymentProvider) {
    failures.push(`deployment.provider must match profile ${profile}`);
  }
  if (config?.governance?.source !== "kiaquila/web-design") {
    failures.push("governance.source must be kiaquila/web-design");
  }
  if (!new Set(["source", "consumer"]).has(config?.governance?.mode)) {
    failures.push("governance.mode must be source or consumer");
  }
  return failures;
}

function mapPair(map, key) {
  if (!isMap(map)) return null;
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key) ?? null;
}

function unsupportedSecurityConstructs(node, kinds = new Set()) {
  if (!node) return kinds;
  if (isAlias(node)) {
    kinds.add("alias");
    return kinds;
  }
  if (node.anchor) kinds.add("anchor");
  if (node.tag) kinds.add("tag");
  if (isScalar(node) && new Set(["BLOCK_FOLDED", "BLOCK_LITERAL"]).has(node.type)) {
    kinds.add("block scalar");
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") kinds.add("merge key");
      unsupportedSecurityConstructs(pair.key, kinds);
      unsupportedSecurityConstructs(pair.value, kinds);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) unsupportedSecurityConstructs(item, kinds);
  }
  return kinds;
}

function unsupportedJobTreeConstructs(node, kinds = new Set()) {
  if (!node) return kinds;
  if (isAlias(node)) {
    kinds.add("alias");
    return kinds;
  }
  if (node.anchor) kinds.add("anchor");
  if (node.tag) kinds.add("tag");
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === "<<") kinds.add("merge key");
      unsupportedJobTreeConstructs(pair.key, kinds);
      unsupportedJobTreeConstructs(pair.value, kinds);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) unsupportedJobTreeConstructs(item, kinds);
  }
  return kinds;
}

function workflowEvents(node, failures, path) {
  const events = new Set();
  for (const kind of unsupportedSecurityConstructs(node)) {
    failures.push(`Workflow trigger uses unsupported YAML ${kind}: ${path}`);
  }
  if (isScalar(node) && typeof node.value === "string") {
    events.add(node.value);
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!isScalar(item) || typeof item.value !== "string") {
        failures.push(`Workflow trigger list must contain event names: ${path}`);
        continue;
      }
      events.add(item.value);
    }
  } else if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        failures.push(`Workflow trigger map must use event-name keys: ${path}`);
        continue;
      }
      events.add(pair.key.value);
    }
  } else {
    failures.push(`Workflow trigger must be a scalar, sequence, or mapping: ${path}`);
  }
  return events;
}

function permissionWrites(node, scope, failures, path) {
  for (const kind of unsupportedSecurityConstructs(node)) {
    failures.push(`Workflow ${scope} use unsupported YAML ${kind}: ${path}`);
  }
  if (isScalar(node)) {
    if (!new Set(["read-all", "write-all"]).has(node.value)) {
      failures.push(`Workflow ${scope} must be read-all, write-all, or a permission map: ${path}`);
    }
    return node.value === "write-all";
  }
  if (!isMap(node)) {
    failures.push(`Workflow ${scope} must be a permission map: ${path}`);
    return true;
  }
  let writes = false;
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      failures.push(`Workflow ${scope} must use scalar permission keys: ${path}`);
      writes = true;
      continue;
    }
    if (!isScalar(pair.value) || !new Set(["read", "write", "none"]).has(pair.value.value)) {
      failures.push(`Workflow ${scope} has an invalid level for ${pair.key.value}: ${path}`);
      writes = true;
      continue;
    }
    if (pair.value.value === "write") writes = true;
  }
  return writes;
}

// GitHub takes the workflow file from a ref the actor chooses for these events,
// so a write-capable job reachable from one of them can run unreviewed code with
// a write token. Every other event runs the default branch's copy of the file.
const REF_SELECTABLE_EVENTS = new Set([
  "create",
  "delete",
  "merge_group",
  "pull_request",
  "pull_request_target",
  "push",
  "release",
  "workflow_call",
  "workflow_dispatch"
]);

// A push filtered to the default branch runs the default branch's own copy of
// the workflow, which is the reviewed, trusted context the security standard
// allows write jobs to run from. Every managed workflow already writes the
// default branch as `main`; a tag filter or a wider branch list is not trusted.
const DEFAULT_BRANCH_REF_NAMES = new Set(["main"]);
const PUSH_FILTER_KEYS_WITHOUT_REF_WIDENING = new Set(["paths", "paths-ignore"]);

function pushRestrictedToDefaultBranch(node) {
  if (!isMap(node)) return false;
  const push = node.items.find((pair) => isScalar(pair.key) && pair.key.value === "push");
  if (!push || !isMap(push.value)) return false;
  let branches = null;
  for (const pair of push.value.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") return false;
    if (pair.key.value === "branches") {
      branches = pair.value;
      continue;
    }
    if (!PUSH_FILTER_KEYS_WITHOUT_REF_WIDENING.has(pair.key.value)) return false;
  }
  if (!isSeq(branches) || branches.items.length === 0) return false;
  return branches.items.every(
    (item) => isScalar(item) && DEFAULT_BRANCH_REF_NAMES.has(item.value)
  );
}

// A trusted event still runs with whatever ref a checkout step asks for. If a
// write-capable job checks proposed code out over the workspace, the next step
// that builds or tests runs that code with the write token. Blocklisting known
// untrusted expressions is not enough — `github.event.comment.body` is supplied
// by whoever commented — so only refs that are provably the trusted branch are
// allowed. Anything else must be isolated under its own `path`, and
// `docs/standards/security.md` carries the rule that such a tree is never
// executed.
const TRUSTED_CHECKOUT_REFS = [
  /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/,
  /^\$\{\{\s*github\.sha\s*\}\}$/,
  /^\$\{\{\s*github\.ref\s*\}\}$/,
  /^\$\{\{\s*github\.ref_name\s*\}\}$/,
  /^main$/,
  /^refs\/heads\/main$/
];

// `path: .`, `path: ./`, and `path: ../..` all land back on the workspace, so an
// isolated checkout has to be a literal relative subdirectory.
function isolatedCheckoutDirectory(node) {
  if (!isScalar(node) || typeof node.value !== "string") return null;
  const requested = node.value.trim();
  if (!requested || requested.includes("${{")) return null;
  if (requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) return null;
  const segments = requested.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function untrustedCheckoutDirectory(step) {
  const uses = mapPair(step, "uses");
  if (!isScalar(uses?.value) || typeof uses.value.value !== "string") return undefined;
  if (!/^actions\/checkout@/.test(uses.value.value)) return undefined;
  const withNode = mapPair(step, "with")?.value;
  if (!isMap(withNode)) return undefined;
  const ref = mapPair(withNode, "ref")?.value;
  if (!ref) return undefined;
  if (isScalar(ref) && typeof ref.value === "string") {
    const requested = ref.value.trim();
    if (TRUSTED_CHECKOUT_REFS.some((pattern) => pattern.test(requested))) return undefined;
  }
  return isolatedCheckoutDirectory(mapPair(withNode, "path")?.value);
}

// Isolating the tree keeps it inspectable as data; it stops being data the
// moment a step runs something out of it. Passing the directory as an argument
// to a trusted program is still fine, which is what the baseline's own
// verification workflow does.
function normalizedRelativeSegments(value) {
  if (typeof value !== "string") return null;
  const requested = value.trim();
  if (!requested || requested.includes("${{")) return null;
  if (requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) return null;
  const segments = requested.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments;
}

function pathEntersUntrustedTree(value, directory) {
  const segments = normalizedRelativeSegments(value);
  if (segments === null) return false;
  const target = directory.split("/");
  if (segments.length < target.length) return false;
  return target.every((segment, index) => segments[index] === segment);
}

function directoryEntersUntrustedTree(node, directory) {
  if (!isScalar(node) || typeof node.value !== "string") return false;
  return pathEntersUntrustedTree(node.value, directory);
}

function stepExecutesFromDirectory(step, directory, jobDefaultsEnterTree) {
  const uses = mapPair(step, "uses")?.value;
  if (isScalar(uses) && typeof uses.value === "string") {
    const reference = uses.value.trim();
    if (reference.startsWith("./") && pathEntersUntrustedTree(reference.slice(2), directory)) {
      return true;
    }
  }
  const workingDirectory = mapPair(step, "working-directory")?.value;
  const hasRun = isScalar(mapPair(step, "run")?.value);
  if (hasRun && workingDirectory && directoryEntersUntrustedTree(workingDirectory, directory)) {
    return true;
  }
  if (hasRun && !workingDirectory && jobDefaultsEnterTree) return true;
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  const quoted = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const interpreters = "node|bash|sh|zsh|dash|python3?|npx|deno|ruby|perl|go|make";
  return (
    new RegExp(`(?:^|[\\s;&|(])(?:[^\\s;&|(]*/)?${quoted}/`, "m").test(run.value) ||
    new RegExp(`(?:^|[\\s;&|(])(?:${interpreters})\\s+\\S*${quoted}/`, "m").test(run.value) ||
    new RegExp(`--prefix\\s+\\S*${quoted}(?:\\s|$|["'])`, "m").test(run.value) ||
    // Changing into the tree makes every later command in that step run there,
    // and the directory has no trailing slash in `cd .proposed && npm ci`.
    new RegExp(`(?:^|[\\s;&|(])(?:cd|pushd)\\s+["']?(?:\\./)*${quoted}(?:/|["']|\\s|$)`, "m").test(run.value)
  );
}

function dispatchOnlyJob(job) {
  const conditionNode = mapPair(job, "if")?.value;
  if (!isScalar(conditionNode) || typeof conditionNode.value !== "string") return false;
  if (conditionNode.anchor || conditionNode.tag) return false;
  const condition = conditionNode.value.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
  if (condition.includes("||") || condition.includes("?")) return false;
  const parts = condition.split(/\s*&&\s*/);
  const dispatchEvent = parts.some((part) =>
    /^\(*\s*github\.event_name\s*==\s*["']workflow_dispatch["']\s*\)*$/.test(part)
  );
  const defaultBranch = parts.some((part) =>
    /^\(*\s*github\.ref\s*==\s*format\(\s*["']refs\/heads\/\{0\}["']\s*,\s*github\.event\.repository\.default_branch\s*\)\s*\)*$/.test(part)
  );
  return dispatchEvent && defaultBranch;
}

function directUnsupportedConstructs(node, { blockScalar = false, mergeKey = false } = {}) {
  const kinds = new Set();
  if (!node) return kinds;
  if (isAlias(node)) kinds.add("alias");
  if (node.anchor) kinds.add("anchor");
  if (node.tag) kinds.add("tag");
  if (blockScalar && isScalar(node) && new Set(["BLOCK_FOLDED", "BLOCK_LITERAL"]).has(node.type)) {
    kinds.add("block scalar");
  }
  if (mergeKey && isMap(node) && node.items.some((pair) => isScalar(pair.key) && pair.key.value === "<<")) {
    kinds.add("merge key");
  }
  return kinds;
}

function validateMappingKeys(map, scope, failures, path) {
  if (!isMap(map)) return;
  for (const pair of map.items) {
    const kinds = directUnsupportedConstructs(pair.key, { blockScalar: true });
    if (isScalar(pair.key) && pair.key.value === "<<") kinds.add("merge key");
    for (const kind of kinds) {
      failures.push(`Workflow ${scope} key uses unsupported YAML ${kind}: ${path}`);
    }
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      failures.push(`Workflow ${scope} keys must be undecorated string scalars: ${path}`);
    }
  }
}

function validateActionReference(node, failures, path) {
  for (const kind of directUnsupportedConstructs(node, { blockScalar: true })) {
    failures.push(`Workflow uses value uses unsupported YAML ${kind}: ${path}`);
  }
  if (!isScalar(node) || typeof node.value !== "string") {
    failures.push(`Workflow uses value must be a scalar action reference: ${path}`);
    return;
  }
  const action = node.value;
  if (action.startsWith("./")) return;
  if (action.startsWith("docker://")) {
    if (!/^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/.test(action)) {
      failures.push(`Docker action is not pinned to an immutable SHA-256 digest in ${path}: ${action}`);
    }
    return;
  }
  const ref = action.slice(action.lastIndexOf("@") + 1);
  if (!/^[a-f0-9]{40}$/.test(ref)) {
    failures.push(`GitHub Action is not pinned to a full commit SHA in ${path}: ${action}`);
  }
}

export function validateWorkflowText(path, text) {
  const failures = [];
  const document = parseDocument(text, {
    keepSourceTokens: true,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true
  });
  for (const error of document.errors) {
    failures.push(`Invalid workflow YAML (${error.code}): ${path}: ${error.message}`);
  }
  for (const warning of document.warnings) {
    failures.push(`Unsupported workflow YAML (${warning.code}): ${path}: ${warning.message}`);
  }
  const root = document.contents;
  if (!isMap(root)) {
    failures.push(`Workflow document root must be a mapping: ${path}`);
  } else if (document.errors.length === 0) {
    validateMappingKeys(root, "root mapping", failures, path);
    const onPair = mapPair(root, "on");
    const events = onPair ? workflowEvents(onPair.value, failures, path) : new Set();
    if (!onPair) failures.push(`Workflow must declare triggers: ${path}`);
    if (events.has("pull_request_target")) {
      failures.push(`High-risk pull_request_target trigger in ${path}`);
    }
    const trustedPush = pushRestrictedToDefaultBranch(onPair?.value);
    const refSelectable = [...events].some((event) =>
      event === "push" ? !trustedPush : REF_SELECTABLE_EVENTS.has(event)
    );
    let topLevelWrites = false;
    const rootDefaults = mapPair(root, "defaults")?.value;
    const rootRunDefaults = isMap(rootDefaults) ? mapPair(rootDefaults, "run")?.value : undefined;
    const rootWorkingDirectory = isMap(rootRunDefaults)
      ? mapPair(rootRunDefaults, "working-directory")?.value
      : undefined;
    const topPermissions = mapPair(root, "permissions");
    if (!topPermissions) {
      failures.push(`Workflow must declare top-level permissions: ${path}`);
    } else {
      const writes = permissionWrites(topPermissions.value, "top-level permissions", failures, path);
      topLevelWrites = writes;
      if (isScalar(topPermissions.value) && topPermissions.value.value === "write-all") {
        failures.push(`Workflow may not use write-all permissions: ${path}`);
      }
      if (refSelectable && writes) {
        failures.push(
          `Ref-selectable workflow may not grant top-level write permissions: ${path}`
        );
      }
    }
    const jobs = mapPair(root, "jobs")?.value;
    if (jobs !== undefined && !isMap(jobs)) {
      failures.push(`Workflow jobs must be a mapping: ${path}`);
    } else if (isMap(jobs)) {
      for (const kind of unsupportedJobTreeConstructs(jobs)) {
        failures.push(`Workflow jobs use unsupported YAML ${kind}: ${path}`);
      }
      validateMappingKeys(jobs, "jobs mapping", failures, path);
      for (const jobPair of jobs.items) {
        const jobName = isScalar(jobPair.key) && typeof jobPair.key.value === "string"
          ? jobPair.key.value
          : "<invalid>";
        if (!isMap(jobPair.value)) {
          failures.push(`Workflow job ${jobName} must be a mapping: ${path}`);
          continue;
        }
        validateMappingKeys(jobPair.value, `job ${jobName} mapping`, failures, path);
        const reusableWorkflow = mapPair(jobPair.value, "uses");
        if (reusableWorkflow) validateActionReference(reusableWorkflow.value, failures, path);
        const jobSecrets = mapPair(jobPair.value, "secrets");
        if (jobSecrets && isScalar(jobSecrets.value) && jobSecrets.value.value === "inherit") {
          failures.push(`Workflow job ${jobName} may not inherit caller secrets: ${path}`);
        }
        const steps = mapPair(jobPair.value, "steps")?.value;
        if (steps !== undefined && !isSeq(steps)) {
          failures.push(`Workflow job ${jobName} steps must be a sequence: ${path}`);
        } else if (isSeq(steps)) {
          for (const step of steps.items) {
            for (const kind of directUnsupportedConstructs(step, { mergeKey: true })) {
              failures.push(`Workflow job ${jobName} step uses unsupported YAML ${kind}: ${path}`);
            }
            if (!isMap(step)) {
              failures.push(`Workflow job ${jobName} step must be a mapping: ${path}`);
              continue;
            }
            validateMappingKeys(step, `job ${jobName} step mapping`, failures, path);
            const uses = mapPair(step, "uses");
            if (uses) validateActionReference(uses.value, failures, path);
          }
        }
        const jobPermissions = mapPair(jobPair.value, "permissions");
        const writes = jobPermissions
          ? permissionWrites(jobPermissions.value, `job ${jobName} permissions`, failures, path)
          : topLevelWrites;
        if (writes && isSeq(steps)) {
          const isolated = [];
          for (const step of steps.items) {
            if (!isMap(step)) continue;
            const directory = untrustedCheckoutDirectory(step);
            if (directory === undefined) continue;
            if (directory === null) {
              failures.push(
                `Write-capable job ${jobName} checks an untrusted ref out over the workspace: ${path}`
              );
              continue;
            }
            isolated.push(directory);
          }
          // A job's own defaults win, but a workflow-level default applies to
          // every job that does not override it.
          const jobDefaults = mapPair(jobPair.value, "defaults")?.value;
          const jobRunDefaults = isMap(jobDefaults) ? mapPair(jobDefaults, "run")?.value : undefined;
          const jobWorkingDirectory = isMap(jobRunDefaults)
            ? mapPair(jobRunDefaults, "working-directory")?.value
            : undefined;
          const effectiveWorkingDirectory = jobWorkingDirectory ?? rootWorkingDirectory;
          for (const directory of isolated) {
            const defaultsEnterTree = directoryEntersUntrustedTree(effectiveWorkingDirectory, directory);
            for (const step of steps.items) {
              if (isMap(step) && stepExecutesFromDirectory(step, directory, defaultsEnterTree)) {
                failures.push(
                  `Write-capable job ${jobName} executes code from the untrusted checkout ${directory}: ${path}`
                );
              }
            }
          }
        }
        if (!jobPermissions) continue;
        if (refSelectable && writes && !dispatchOnlyJob(jobPair.value)) {
          failures.push(
            `Ref-selectable job ${jobName} may not grant write permissions: ${path}`
          );
        }
      }
    }
  }
  return failures;
}

export function scanRepository(root) {
  const failures = [];
  for (const path of REQUIRED_ROOT_FILES) {
    if (!existsSync(join(root, path))) failures.push(`Missing required repository file: ${path}`);
  }

  const files = repositoryFiles(root);
  const profileFiles = files.filter((file) => /^\.web-design\/profiles\/[a-z0-9-]+\.json$/.test(file));
  const profiles = {};
  for (const file of profileFiles) {
    const id = basename(file, ".json");
    try {
      profiles[id] = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch (error) {
      failures.push(`Invalid profile ${file}: ${error.message}`);
    }
  }
  const availableProfiles = Object.keys(profiles);
  try {
    const config = JSON.parse(readFileSync(join(root, ".web-design/project.json"), "utf8"));
    failures.push(...validateProjectConfig(config, profiles));
    const profile = profiles[config?.project?.profile];
    const deploymentRoot = config?.deployment?.rootDirectory || ".";
    for (const required of profile?.requiredProjectFiles ?? []) {
      if (!existsSync(join(root, deploymentRoot, required))) {
        failures.push(`Profile ${profile.id} requires ${join(deploymentRoot, required)}`);
      }
    }
    const lock = JSON.parse(readFileSync(join(root, ".web-design/lock.json"), "utf8"));
    if (lock.profile !== config?.project?.profile) {
      failures.push("lock.profile must match project.profile");
    }
  } catch (error) {
    failures.push(`Invalid .web-design/project.json: ${error.message}`);
  }

  for (const file of files) {
    const normalized = file.split(sep).join("/");
    const parts = normalized.split("/");
    const fileName = basename(normalized);
    if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) {
      failures.push(`Generated or dependency directory is tracked: ${normalized}`);
    }
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(fileName)) && fileName !== ".env.example") {
      failures.push(`Sensitive or local-only file is tracked: ${normalized}`);
    }
    const absolute = join(root, file);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      failures.push(`Repository path is missing from the worktree: ${normalized}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      failures.push(`Symbolic links are not allowed: ${normalized}`);
      continue;
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    const buffer = readFileSync(absolute);
    if (looksBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) failures.push(`Possible ${label} in ${normalized}`);
    }
    if (PERSONAL_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
      failures.push(`Personal absolute path in ${normalized}`);
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized)) {
      failures.push(...validateWorkflowText(normalized, text));
    }
  }
  return { failures, files, availableProfiles };
}

export function main(argv = process.argv.slice(2)) {
  const root = parseRoot(argv);
  const result = scanRepository(root);
  if (result.failures.length) {
    console.error("Repository guard failed:");
    for (const message of result.failures) console.error(`- ${message}`);
    return 1;
  }
  console.log(
    `Repository guard passed for ${result.files.length} files and ` +
      `${result.availableProfiles.length} profile(s).`
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
