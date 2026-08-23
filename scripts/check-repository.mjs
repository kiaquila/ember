#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { REQUIRED_ROOT_FILES } from "./repository-paths.mjs";
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
// Listing the no-ops was the same losing game one level down: `true`, then
// `:`, then `/bin/true`, then `sleep 0`. A shell has an unbounded supply of
// commands that exit zero without touching the product, so the check names the
// small class that can run a project's own code instead — a package manager, a
// language runtime, a build driver, or a shell handed a script file (with
// `-c` refused as a nested shell above). Anything else belongs behind a script
// the project runs, where the code is reviewed rather than quoted.
// What makes a check real depends on the kind of tool, so the executables are
// classified rather than pooled: `node --version` and `npm --version` fail for
// different reasons, and `npm --prefix build --version` looked like a build
// only because a pooled scan could not tell an option's value from a command.
// Each kind states what it needs, and the tool's own command position is where
// it has to be — `npm run check --prefix website` is the same run as
// `npm --prefix website run check`, so nothing is lost by insisting on it.

// Running these exercises the project on their own.
const SELF_SUFFICIENT_CHECK = new Set([
  "pytest", "tox", "rspec", "jest", "vitest", "mocha", "phpunit"
]);
// An analyser class lived here for one round: eslint, tsc and their kin, with
// options allowed because they need paths to say what to read. `tsc
// --showConfig` prints the configuration and exits zero, and naming the modes
// that print instead of analysing is a list per tool and per version — the
// same seam that took the option-arity table. A dependency's binary is code
// this guard cannot read anyway, so the class is gone: an analyser runs as
// `npm run lint`, a script the package defines, or as a script this repository
// holds. Both are reviewed; neither has to be parsed.
// These run the file they are handed, wherever it sits in the arguments.
const RUNTIME_CHECK = new Set([
  "node", "deno", "bun", "python", "python3", "ruby", "php",
  "bash", "sh", "zsh"
]);
// These dispatch to a named tool, so the name is the command position.
// `npx <tool>` reaches for a dependency's binary, which is code this guard
// cannot read; with the analyser class gone there is nothing left for a runner
// to dispatch to that is not already better written as `npm run <script>` or a
// script in the tree. So npx and its kin are not check executables at all.
// These take a subcommand that has to run project code.
// `swift test` and `swift build` are subcommands, not a file handed to a
// runtime — classifying swift as a runtime meant a Swift project could not
// state its check at all. `java` is gone from both: it runs an application
// rather than returning a verdict, and its own informational surface is
// idiosyncratic (`-X` prints help on extra options and exits zero). A Java
// project's check is `mvn verify` or `gradle test`, which this reads already.
const SUBCOMMAND_CHECK = new Set([
  "npm", "pnpm", "yarn", "go", "cargo", "dotnet", "make", "mvn", "gradle",
  "gradlew", "./gradlew", "rake", "bundle", "composer", "poetry", "pipenv", "uv",
  "swift"
]);
const PRODUCT_CHECK_EXECUTABLE = new Set([
  ...SELF_SUFFICIENT_CHECK,
  ...RUNTIME_CHECK,
  ...SUBCOMMAND_CHECK
]);

// Every verb here has to put the project's own code through something:
// compiled, executed, or read by an analyser. `audit` reads the dependency
// tree, `format` and `fmt` rewrite files and exit zero either way, and `start`
// launches a server that a CI run then waits on — none of them is a verdict on
// the product, so none of them is here. A project that wants one of those runs
// it as a named script, where `run` and the script name are the target.
const PRODUCT_CHECK_VERB = new Set([
  "run", "test", "tests", "check", "checks", "build", "lint",
  "typecheck", "vet", "verify", "e2e", "coverage", "bench", "exec", "all"
]);
// A formatter rewrites files and exits zero either way, except when it is
// asked for a verdict instead: `cargo fmt --check` returns nonzero when the
// source needs changing, which is a real reading of the project's own code.
// So the verb is a target only with the flag that turns it into one.
const VERDICT_VERB = new Set(["fmt", "format"]);
const VERDICT_FLAG = new Set(["--check", "--check-only"]);
// `npm run check` names a script the package defines. That script's contents
// are not something this guard can read, and it does not try to — a name is
// enough. Every other dispatching verb names a command instead, and a command
// is read like any other check. Nothing may sit between a verb and what it
// dispatches to, whichever kind it is; see `dispatchTargetIndex`.
const SCRIPT_NAME_DISPATCH = new Set(["npm", "pnpm", "yarn"]);
// `npm install` and `npm ci` fetch dependencies and exit zero without running
// a line of the product, so neither is a check. They are still how a check
// gets something to run, though, so a command may contain them as long as
// something in it is a real check: `npm ci --prefix website && npm run check
// --prefix website` passes, `npm install` on its own does not.
const DEPENDENCY_VERB = new Set(["ci", "install"]);
// `npm run` lists the scripts and exits zero, so a dispatching verb is a
// target only once the name follows it, and immediately: reading
// `npm run --workspace website` as a dispatch would mean knowing which options
// consume the next word.
const VERB_NEEDING_ARGUMENT = new Set(["run", "exec"]);
// `npm test --version` prints the version and exits zero, and `pytest -h`
// prints usage and exits zero: an informational flag wins over whatever verb
// precedes it, so these are refused anywhere ahead of `--`. `-h` and `-V` are
// here because every tool in the classes above reads them as help and version;
// `-v` is not, because `pytest -v` and `go test -v` are real runs asking to be
// louder, and the tools that read `-v` as a version (`npm -v`, `node -v`)
// already fail for having no target at all.
const INFORMATIONAL_WORD = new Set([
  "version", "--version", "-V", "help", "--help", "-h"
]);
// Every family that used to sit here named a way to exit zero without doing
// the work: `--if-present` tolerating a missing script, `--show-bin-path` and
// `--dry-run` naming output instead of work, Make's `--touch` and `--question`
// claiming the work already done, `--ignore-errors` and `--script-shell`
// detaching the verdict, then their abbreviations, their negations, their
// attached values, and their one-dash spellings. Each round closed the
// spelling in front of it and the next tool had another: `go test -exec
// /bin/true` swaps the test binary for a no-op, `-toolexec` does it one layer
// down, `cargo test --no-run` builds the tests and runs none, `gradle test
// --exclude-task test` drops the task, `go test -count=0` runs it zero times.
// There is no end to that list, because it is every option of every tool, and
// nothing in a name separates `--no-run` from `--prefix`.
//
// So the reading is inverted here, the way it already is for the other two
// classes: a runtime takes its file first with nothing before it, a
// self-sufficient tool takes no options at all, and a subcommand tool takes
// only the options this file can name. The set below is small on purpose — it
// says where in the repository the project lives, and asks a formatter for a
// verdict. Anything else a check needs goes into a script the project runs,
// where the flags are reviewed rather than parsed. The trade refuses commands
// that were doing nothing wrong, and is taken deliberately: a refused check is
// a red build, and a misread one is a green build that tested nothing.
const READABLE_OPTION = new Set([
  "--prefix", "--silent", "--check", "--check-only"
]);
// Naming an option is not the same as reading it. `--prefix` points npm at a
// directory, and an unconstrained value points it out of the product: `npm run
// check --prefix /tmp/noop-package` runs an unreviewed package's always-green
// script, and `--prefix=node_modules/noop-package` reaches a dependency
// without leaving the tree. So the value is read the way a product path is —
// relative, inside the repository, and clear of the directories this guard
// already refuses to read.
//
// `--workspace` was named here for one round and is not, because it takes a
// name rather than a path. A name is resolved by reading the package manifest
// this guard does not open, so `--workspace -foo` is a real check that looks
// exactly like an option, and `--prefix --if-present` is an option that looks
// exactly like a value. Neither reading is available without the arity rules
// that defeated `dispatchTargetIndex`. A path has no such ambiguity — it never
// starts with a dash — and `npm run test --prefix packages/website` reaches a
// workspace by the readable spelling.
const OPTION_TAKING_PATH = new Set(["--prefix"]);
// A name that describes output rather than work. It is read as a word now
// rather than as an option — options are decided by the set above — and its
// one use is Swift's reporting subcommands, below.
const REPORTING_NAME = ["show", "print", "list", "dry-run"];
const REPORTING_WORD = new RegExp(`^(?:${REPORTING_NAME.join("|")})(?:-|$)`);
// `-v` is the one spelling the tools disagree about: `npm test -v` prints
// npm's version and runs nothing, while `pytest -v` and `go test -v` are real
// runs asking to be louder. Naming the tools that read it as verbose keeps a
// tool added to the lists above failing closed until someone decides which it
// is.
const VERBOSE_SHORT_FLAG_TOOL = new Set([
  "pytest", "tox", "go", "cargo", "rake", "dotnet", "composer", "python",
  "python3", "swift", "bash", "sh", "zsh"
]);

// A runtime hands everything after its file operand to that file, so
// `python3 scripts/check.py -V` is the script's own flag rather than a request
// for the interpreter's version; the caller passes only the words ahead of the
// operand. A package runner is the other way round: the tool it dispatches to
// reads `-h` the same way its runner would, so every word counts.
// npm accepts `-if-present` for `--if-present`, so the dashes say how a word
// was typed rather than what it means. A long name is read with its dashes and
// any `no-` prefix removed, and compared against the named options the same
// way; a short flag keeps its exact spelling, since `-h` is not an
// abbreviation of `help`.
function longOptionName(name) {
  if (!name.startsWith("-")) return null;
  const stripped = name.replace(/^-+/, "");
  if (stripped.length < 2) return null;
  return stripped.startsWith("no-") ? stripped.slice(3) : stripped;
}

function abbreviatesOption(name, flags) {
  const long = longOptionName(name);
  if (long === null) return false;
  const names = [...flags].map((flag) => flag.replace(/^-+/, ""));
  if (names.includes(long)) return false;
  return names.some((flag) => flag.length > 1 && flag.startsWith(long));
}

function matchesOption(name, flags) {
  if (flags.has(name)) return true;
  const long = longOptionName(name);
  if (long === null) return false;
  return [...flags].some((flag) => flag.startsWith("--") && flag.slice(2) === long);
}

// Past `--` the words reach whatever the named script runs, and that can be
// another tool in these same classes: `npm run check -- --dry-run` hands
// `--dry-run` to a `check` script that may be `make test`, and no recipe runs.
// Which tool receives them is a fact about a package script this guard does
// not read, so the region cannot be read either — scanning it for known-bad
// names only moves the enumeration one tool along. The separator is refused
// instead. Arguments a check needs belong in the script that is being run,
// where they are reviewed; a runtime is unaffected, since the words after its
// file operand reach a file in this repository.
// `swift test list` is a documented subcommand; `cargo test list` is a test
// filter that happens to read the same way.
const SUBCOMMAND_REPORTING_TOOL = new Set(["swift"]);

function isRepositoryDirectoryWord(word) {
  // A path this guard could read: literal path characters only, nothing
  // quoted, spaced, or commented, and nothing climbing out of the tree. A word
  // that starts with a dash is an option rather than a path, whatever it
  // spells — which is why only options taking a path are named at all. `@` is
  // a path character here: a scoped package sits at `packages/@scope/pkg`, and
  // traversal out of the tree is caught by the segment normalization below
  // rather than by the alphabet.
  if (word.startsWith("-")) return false;
  if (!/^[@A-Za-z0-9._/-]+$/.test(word)) return false;
  const segments = normalizedRelativeSegments(word);
  if (segments === null) return false;
  return segments.every((segment) => !FORBIDDEN_SEGMENTS.has(segment));
}

function informsInsteadOfRunning(words, { versionIsShort = false } = {}) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const bare = bareWord(word);
    if (bare === "--") return true;
    // `--help=config` is the same request with its topic attached, so the
    // value comes off before the word is read — but only from an option, since
    // `make test version=1` is a variable assignment and its target is `test`.
    const option = bare.startsWith("-") ? bare.replace(/=[\s\S]*$/, "") : bare;
    if (matchesOption(option, INFORMATIONAL_WORD)) return true;
    if (!option.startsWith("-")) continue;
    // `-v` is the one spelling the tools disagree about: `npm test -v` prints
    // npm's version and runs nothing, while `pytest -v` and `go test -v` are
    // real runs asking to be louder. The tool classes model that much, so it
    // is read; every other option has to be one this file names.
    if (bare === "-v") {
      if (versionIsShort) return true;
      continue;
    }
    if (!READABLE_OPTION.has(option)) return true;
    if (OPTION_TAKING_PATH.has(option)) {
      // The value is attached to this word or is the next one; a named option
      // with no value at all is npm's error, and this file's too.
      const attached = bare.includes("=") ? bare.replace(/^[^=]*=/, "") : null;
      const value = attached ?? bareWord(words[index + 1] ?? "");
      if (!value || !isRepositoryDirectoryWord(value)) return true;
      if (attached === null) index += 1;
    }
  }
  return false;
}

function bareWord(word) {
  return String(word ?? "").replace(/^["']|["']$/g, "");
}

function isFileWord(word) {
  // `pycache_prefix=foo/bar` is an option's value wearing a slash, not a file.
  if (word.includes("=")) return false;
  return word.includes("/") || /\.[A-Za-z0-9]+$/.test(word);
}

// `node /dev/null` exits zero having run nothing: a slash is not a project.
// A runtime's operand has to be a path the repository could actually hold, so
// absolute paths, home-relative paths, drive letters, and anything climbing
// out of the tree are not targets.
function isRepositoryFileWord(word) {
  // `python3 -c "'' # scripts/check.py"` hides a comment and a source string
  // behind something path-shaped, so a file operand has to read as a plain
  // path: literal path characters only, nothing quoted, spaced, or commented.
  if (!/^[A-Za-z0-9._/-]+$/.test(word)) return false;
  if (!isFileWord(word)) return false;
  if (word.startsWith("/")) return false;
  return normalizedRelativeSegments(word) !== null;
}

// A dispatched command has to be found, not guessed, and finding it past
// options means knowing which of them take a value. A partial table leaks —
// naming `--with` while missing its `-w` spelling put an option's value in the
// command position and read `uv run --no-project -w pytest true` as a pytest
// run — and a complete one means tracking sixty-odd options per tool across
// versions. So no options sit between the verb and the command: `uv run
// pytest` and `bundle exec rspec` are the readable forms, and an invocation
// that needs flags becomes `uv run scripts/check.py`, where the flags live in
// reviewed code instead of in a string this scanner has to parse.
function dispatchTargetIndex(words) {
  const following = bareWord(words[1]);
  if (!following || following.startsWith("-")) return -1;
  return 1;
}

function commandPositionIsTarget(words, executable) {
  const first = bareWord(words[0]);
  if (!first || first.startsWith("-")) return false;
  if (VERB_NEEDING_ARGUMENT.has(first)) {
    // `npm run check` names a script the package defines: unreadable from
    // here, and a name is enough. Everything else names a command — `npm exec
    // true` reaches a dependency's no-op binary — so it is read like any
    // other check.
    if (first === "run" && SCRIPT_NAME_DISPATCH.has(executable)) {
      const index = dispatchTargetIndex(words);
      if (index < 0) return false;
      // `npm run env` prints the environment and exits zero unless the
      // package happens to define a script by that name, and which it is
      // cannot be read from here. A project that has one renames it; the name
      // is unambiguous to npm and ambiguous to everyone reading the check.
      return bareWord(words[index]) !== "env";
    }
    // The command follows the verb directly; see the note on
    // `dispatchTargetIndex` for why nothing may sit between them.
    const index = dispatchTargetIndex(words);
    if (index < 0) return false;
    const dispatched = bareWord(words[index]);
    if (isRepositoryFileWord(dispatched)) return true;
    const child = executableBasename(dispatched);
    return PRODUCT_CHECK_EXECUTABLE.has(child) && runsProjectCode(child, words.slice(index + 1));
  }
  // `swift test list` lists the test methods and runs none of them: the same
  // promise the reporting options make, worn as a subcommand. This is Swift's
  // grammar and not a general one — `cargo test list` runs the tests whose
  // name contains "list", so applying it everywhere refused a real check —
  // and Swift puts its options before the subcommand, so the word is looked
  // for rather than counted to.
  if (SUBCOMMAND_REPORTING_TOOL.has(executable) && PRODUCT_CHECK_VERB.has(first)) {
    const reporting = words.slice(1).some((word) => {
      const bare = bareWord(word);
      return bare && !bare.startsWith("-") && REPORTING_WORD.test(bare);
    });
    if (reporting) return false;
  }
  if (VERDICT_VERB.has(first)) {
    return words.some((word) => VERDICT_FLAG.has(bareWord(word)));
  }
  return PRODUCT_CHECK_VERB.has(first) || isRepositoryFileWord(first);
}

// A runtime's operand is the first word that is not a flag. Everything before
// it belongs to the interpreter and must be a flag outright: `-X
// pycache_prefix=foo/bar` puts a slash where the operand would be, and reading
// that as the file would leave a trailing `-V` unnoticed. `--test tests/a.mjs`
// is unaffected, since a flag with no separated value is still just a flag.
function runtimeOperandIndex(words) {
  for (let index = 0; index < words.length; index += 1) {
    const bare = bareWord(words[index]);
    if (bare === "--") return index + 1 < words.length ? index + 1 : -1;
    if (bare.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function preparesDependencies(executable, words) {
  if (!SUBCOMMAND_CHECK.has(executable)) return false;
  if (informsInsteadOfRunning(words, {
    versionIsShort: !VERBOSE_SHORT_FLAG_TOOL.has(executable)
  })) {
    return false;
  }
  return DEPENDENCY_VERB.has(bareWord(words[0]));
}

function runsProjectCode(executable, words) {
  const isRuntime = RUNTIME_CHECK.has(executable);
  const operand = isRuntime ? runtimeOperandIndex(words) : -1;
  const informs = informsInsteadOfRunning(isRuntime ? words.slice(0, Math.max(operand, 0)) : words, {
    versionIsShort: !VERBOSE_SHORT_FLAG_TOOL.has(executable)
  });
  if (informs) return false;
  if (SELF_SUFFICIENT_CHECK.has(executable)) {
    // Options are the only way to neuter a tool that runs the suite by
    // itself — `--collect-only` gathers the tests and executes none of them —
    // and telling those from a verbosity flag would be a table per tool and
    // per version. A self-sufficient check is therefore the bare command, or
    // the command with paths to run.
    return words.every((word) => !bareWord(word).startsWith("-"));
  }
  if (isRuntime) {
    // The file comes first, with nothing before it. Options ahead of a
    // runtime's operand are how `java -X`, `python3 --help-env` and `node
    // --v8-options` each printed something and exited zero while a path sat
    // further along the line looking like the check; each arrived as its own
    // finding, and every runtime has more of them. Nothing legitimate is lost
    // that cannot be said another way: `node --test tests/a.mjs` becomes a
    // package script or `node scripts/check.mjs`, which is how the template's
    // own suite runs `node --test` already.
    const first = bareWord(words[0]);
    return Boolean(first) && !first.startsWith("-") && isRepositoryFileWord(first);
  }
  return commandPositionIsTarget(words, executable);
}

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

// `command true`, `env -u FOO true`, `stdbuf -o L true` — each wrapper has its
// own option grammar, and getting one wrong lets the word that decides the exit
// status hide behind it. Rather than learn every grammar, a product check may
// not be wrapped at all: the first word is the command whose status counts.
const COMMAND_WRAPPERS = new Set([
  "command", "env", "exec", "nice", "ionice", "nohup", "stdbuf", "time", "timeout",
  "xargs", "setsid", "chrt", "taskset", "unbuffer", "script", "sudo", "doas", "su"
]);

// `FOO=bar true` runs `true`: leading assignments are environment, not the
// command, so the executable is the first word that is not one.
// `FOO='a b' true` is one assignment and then `true`. Splitting on whitespace
// after the quotes are gone would see `FOO=a`, `b`, `true` and call `b` the
// command, so words are cut on unquoted whitespace and unquoted afterwards.
function wordsRespectingQuotes(segment) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of segment) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

function commandWordsAfterAssignments(segment) {
  const words = wordsRespectingQuotes(segment);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  return words.slice(index);
}

function executableBasename(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

function wrapsTheProductCommand(command) {
  const first = commandWordsAfterAssignments(command)[0];
  if (!first) return false;
  return COMMAND_WRAPPERS.has(executableBasename(first));
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
  let checks = 0;
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
    if (wrapsTheProductCommand(trimmed)) {
      return "must not wrap the product command; the first word decides the exit status";
    }
    // `npm_config_if_present=true npm run check` sets the flag through the
    // environment, and `npm_config_script_shell=true npm test` replaces the
    // shell a script runs in. Every tool reads its own environment, so which
    // names matter is unknowable here; a check's behaviour has to be visible
    // in the command, and a check that needs environment sets it inside the
    // script it runs.
    if (wordsRespectingQuotes(trimmed).length !== commandWordsAfterAssignments(trimmed).length) {
      return "must not set environment variables ahead of the command";
    }
    const words = commandWordsAfterAssignments(trimmed);
    if (!words.length) return "must execute a real product check";
    // `npm run check --pref website` expands to `--prefix` and an exact lookup
    // never sees it. Whether an abbreviation is unambiguous is a question about
    // the tool's whole option list — npm expands `--i` to `--iwr`, not to
    // `--if-present` — and that list is not something this file can hold. The
    // allowlist refuses an abbreviation already, by not naming it; this says
    // why, because "spell the option out" is the fix and the general refusal
    // does not suggest it.
    const abbreviated = words.some((word) => {
      const bare = bareWord(word).replace(/=[\s\S]*$/, "");
      return (
        abbreviatesOption(bare, INFORMATIONAL_WORD) ||
        abbreviatesOption(bare, READABLE_OPTION)
      );
    });
    if (abbreviated) return "must spell out its options rather than abbreviate them";
    const executable = executableBasename(words[0]);
    if (!PRODUCT_CHECK_EXECUTABLE.has(executable)) {
      return "must execute a real product check";
    }
    // `npm --version` clears the executable allowlist and still runs no
    // project code, and so do `node -v`, `go version`, and
    // `npm --prefix build --version`. The executable only says which tool
    // runs; what it is pointed at is what makes the check real.
    const rest = words.slice(1);
    if (!runsProjectCode(executable, rest) && !preparesDependencies(executable, rest)) {
      return "must execute a real product check";
    }
    if (runsProjectCode(executable, rest)) checks += 1;
  }
  if (!checks) return "must execute a real product check";
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
      failures.push(`Workflow ${scope} must be read-all or a permission map: ${path}`);
    }
    // `docs/standards/security.md` refuses write-all outright, and a job may
    // ask for it as readily as a workflow can.
    if (node.value === "write-all") {
      failures.push(`Workflow ${scope} may not use write-all permissions: ${path}`);
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

// The events whose payload the repository itself produces. A `push` qualifies
// only when it is filtered to the default branch, which the caller checks;
// `workflow_call` is absent because the caller decides what arrives.
const REPOSITORY_CONTROLLED_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);

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

// `repository:` retargets the checkout: any other repository's tree replaces
// the workspace even when `ref` is absent, because Checkout then takes that
// repository's default branch. Only `${{ github.repository }}` is provably
// this repository — a literal owner/name cannot be verified statically in a
// template shared across consumers, so it fails closed as untrusted.
function checkoutTargetsCurrentRepository(withNode) {
  const repository = mapPair(withNode, "repository")?.value;
  if (repository === undefined) return true;
  if (!isScalar(repository) || typeof repository.value !== "string") return false;
  return /^\$\{\{\s*github\.repository\s*\}\}$/.test(repository.value.trim());
}

function untrustedCheckoutDirectory(step) {
  const uses = mapPair(step, "uses");
  if (!isScalar(uses?.value) || typeof uses.value.value !== "string") return undefined;
  if (!/^actions\/checkout@/.test(uses.value.value)) return undefined;
  const withNode = mapPair(step, "with")?.value;
  if (!isMap(withNode)) return undefined;
  const ref = mapPair(withNode, "ref")?.value;
  if (checkoutTargetsCurrentRepository(withNode)) {
    if (!ref) return undefined;
    if (isScalar(ref) && typeof ref.value === "string") {
      const requested = ref.value.trim();
      if (TRUSTED_CHECKOUT_REFS.some((pattern) => pattern.test(requested))) return undefined;
    }
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
  // `candidate/sub/..` resolves back into `candidate`, so `..` is applied
  // rather than treated as unknown. Escaping above the workspace is unknown.
  const resolved = [];
  for (const segment of requested.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (!resolved.length) return null;
    resolved.pop();
  }
  return resolved;
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

// Enumerating the commands that can fetch proposed code was a losing game:
// `git fetch`, then `git pull`, then past Git's global options, then a line
// continuation, then `gh pr checkout`. The command surface is open-ended, so
// the rule is about inputs instead. A write-capable job's shell may not name
// an actor-controlled ref at all — not the expressions that carry one, not a
// pull ref, not `FETCH_HEAD`, not the CLI that resolves one for you. Trusted
// refs stay available, and anything that genuinely needs proposed code belongs
// in a read-only job that hands its findings on.
// Some inputs are acquisition on their own: a pull ref, `FETCH_HEAD`, or the
// `gh pr` subcommands exist only to obtain proposed code.
const ALWAYS_UNTRUSTED_REF_INPUT = [
  /\brefs\/pull\//,
  /[\s'"=]pull\/[^\s'"]*\/(?:head|merge)\b/i,
  /\bFETCH_HEAD\b/,
  /\bgh\s+pr\s+(?:checkout|diff|view)\b/
];

// Pairing the expression with a tool that can fetch code was the last denylist
// standing: it knew `git` and `gh repo clone`, so
// `curl -o payload "$URL" && bash payload` walked straight through it. Every
// runner carries a dozen ways to turn a URL into a file and a file into a
// process, so the tool half of the test is gone. An actor-controlled
// expression may not reach a write-capable job's environment or shell at all —
// then nothing there can be fed one, whatever it invokes. A trusted script
// that needs event data reads `$GITHUB_EVENT_PATH`, where the payload is data
// and never becomes a shell word; `scripts/verify-baseline-source.mjs` is the
// baseline's own instance of that.
const ACTOR_CONTROLLED_REF_EXPRESSION =
  /\$\{\{[^}]*(?:github\.event\.(?:issue|comment|pull_request|client_payload|workflow_run)|github\.head_ref)\b/;

// A backslash-newline is a line continuation: the shell sees one command, so
// the scan must too.
function joinShellContinuations(text) {
  return text.replace(/\\\r?\n[ \t]*/g, " ");
}

function alwaysUntrustedInput(text) {
  const joined = joinShellContinuations(text);
  return ALWAYS_UNTRUSTED_REF_INPUT.some((pattern) => pattern.test(joined));
}

function environmentRefExpression(node) {
  const env = mapPair(node, "env")?.value;
  if (!isMap(env)) return false;
  return env.items.some((pair) => {
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") return false;
    return (
      ACTOR_CONTROLLED_REF_EXPRESSION.test(pair.value.value) ||
      alwaysUntrustedInput(pair.value.value)
    );
  });
}

function stepNamesActorControlledRef(step, refExpressionInScope) {
  if (refExpressionInScope || environmentRefExpression(step)) return true;
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  if (alwaysUntrustedInput(run.value)) return true;
  return ACTOR_CONTROLLED_REF_EXPRESSION.test(joinShellContinuations(run.value));
}

function changeDirectoryDestinations(text) {
  const destinations = [];
  const pattern = /(?:^|[\s;&|(])(?:cd|pushd)((?:\s+(?:--|-[A-Za-z]+))*)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    destinations.push(match[2].replace(/^["']|["']$/g, ""));
  }
  return destinations;
}

// `target=candidate; cd "$target"` resolves at run time. With an untrusted
// checkout present there is no safe reading of a computed destination.
function hasComputedChangeDirectory(text) {
  // Enumerating shell metacharacters kept missing expansions (`cand{i..i}date`
  // slipped past a `$`/backtick/glob denylist), so only destinations made of
  // plain literal path characters are readable; anything else — variables,
  // backticks, globs, braces, tildes, escapes, or `cd -` — resolves at run time.
  return changeDirectoryDestinations(text).some(
    (destination) => destination === "-" || !/^[A-Za-z0-9._/-]+$/.test(destination)
  );
}

// `working-directory: ${{ 'candidate' }}` resolves at run time, so no static
// comparison can clear it. A write-capable job with an isolated untrusted
// checkout may not have a computed working directory at all.
function stepHasComputedWorkingDirectory(step) {
  const hasRun = isScalar(mapPair(step, "run")?.value);
  if (!hasRun) return false;
  const workingDirectory = mapPair(step, "working-directory")?.value;
  if (!workingDirectory) return false;
  if (!isScalar(workingDirectory) || typeof workingDirectory.value !== "string") return true;
  return workingDirectory.value.includes("${{");
}

// `actions/github-script` with `script: await import(...'/candidate/x.mjs')`
// executes the isolated tree without a `run:` block, and nothing structural
// separates an action that evaluates its inputs from one that does not: inputs
// are opaque, and scanning them would be reading a language again. So beside
// an untrusted checkout a write-capable job may reach for only the published
// actions that stand this tree up — checkout and the pinned runtime, whose
// handling of inputs the baseline vouches for. A job needing another published
// action does not belong beside proposed code; `docs/standards/security.md`
// keeps that work in a read-only job that hands its findings on. A local
// action is this repository's own code under the same CODEOWNERS boundary as
// the scripts a `run:` step calls, so it stays available — one that reaches
// into the tree is refused as execution, above.
const TREE_ADJACENT_ACTION = /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/;

function usesUnvouchedReference(uses) {
  if (!isScalar(uses) || typeof uses.value !== "string") return true;
  const reference = uses.value.trim();
  if (reference.startsWith("./")) return false;
  return !TREE_ADJACENT_ACTION.test(reference);
}

function stepUsesUnvouchedAction(step) {
  const uses = mapPair(step, "uses")?.value;
  if (!uses) return false;
  return usesUnvouchedReference(uses);
}

// A called workflow's `with:` inputs are the actor-controlled surface a step's
// `env` is, and they arrive holding the caller's token.
function jobInputsCarryActorControlledRef(job) {
  const inputs = mapPair(job, "with")?.value;
  if (!isMap(inputs)) return false;
  return inputs.items.some((pair) => {
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") return false;
    return (
      ACTOR_CONTROLLED_REF_EXPRESSION.test(pair.value.value) ||
      alwaysUntrustedInput(pair.value.value)
    );
  });
}

// `github['event']['comment']['body']` indexes its way to the same commenter
// text the dotted form reaches, and `fromJSON`, `format`, and the rest are a
// language a pattern cannot chase. Matching payload syntax is the losing side
// of this; in a write-capable actor-triggered job an expression is instead
// read by the same allowlist used beside an untrusted checkout, wherever it
// appears — `env`, `with`, or run text. A checkout's own inputs are exempt
// because pointing one at proposed code under its own path is exactly what
// isolation is; `untrustedCheckoutDirectory` governs that.
function valuesCarryUnreadableExpression(node, key) {
  const map = mapPair(node, key)?.value;
  if (!isMap(map)) return false;
  return map.items.some(
    (pair) =>
      isScalar(pair.value) &&
      typeof pair.value.value === "string" &&
      computedEnvironmentValue(pair.value.value)
  );
}

// Only the two checkout inputs the checkout rules actually read are exempt.
// `github-server-url: ${{ github.event.comment.body }}` sends the checkout and
// its write-scoped token to a server the commenter picks, while `ref` and
// `repository` stay innocent enough that the workspace is never classified as
// untrusted — an exemption has to be per input, not per action.
const GOVERNED_CHECKOUT_INPUTS = new Set(["ref", "repository"]);

function checkoutInputsCarryUnreadableExpression(step) {
  const inputs = mapPair(step, "with")?.value;
  if (!isMap(inputs)) return false;
  return inputs.items.some((pair) => {
    if (!isScalar(pair.key) || !GOVERNED_CHECKOUT_INPUTS.has(String(pair.key.value))) {
      return (
        isScalar(pair.value) &&
        typeof pair.value.value === "string" &&
        computedEnvironmentValue(pair.value.value)
      );
    }
    return false;
  });
}

function stepCarriesUnreadableExpression(step) {
  const directory = runDirectoryValue(step);
  if (directory !== null && computedEnvironmentValue(directory)) return true;
  if (valuesCarryUnreadableExpression(step, "env")) return true;
  const uses = mapPair(step, "uses")?.value;
  const isCheckout =
    isScalar(uses) &&
    typeof uses.value === "string" &&
    /^actions\/checkout@/.test(uses.value.trim());
  if (isCheckout && checkoutInputsCarryUnreadableExpression(step)) return true;
  if (!isCheckout && valuesCarryUnreadableExpression(step, "with")) return true;
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  return computedEnvironmentValue(joinShellContinuations(run.value));
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
  const text = joinShellContinuations(run.value);
  // `cd website/../candidate` resolves into the tree, so destinations are
  // normalized rather than matched literally.
  if (changeDirectoryDestinations(text).some((d) => pathEntersUntrustedTree(d, directory))) {
    return true;
  }
  if (hasComputedChangeDirectory(text)) return true;
  const quoted = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const interpreters = "node|bash|sh|zsh|dash|python3?|npx|deno|ruby|perl|go|make";
  return (
    new RegExp(`(?:^|[\\s;&|(])(?:[^\\s;&|(]*/)?${quoted}/`, "m").test(text) ||
    new RegExp(`(?:^|[\\s;&|(])(?:${interpreters})\\s+\\S*${quoted}/`, "m").test(text) ||
    new RegExp(`--prefix\\s+\\S*${quoted}(?:\\s|$|["'])`, "m").test(text)
  );
}

// `PATH="$PWD/candidate:$PATH" evil` executes the checkout's `evil` without
// the directory ever being followed by a slash, and `NODE_PATH`, `PYTHONPATH`,
// `LD_PRELOAD`, or `BASH_ENV` reach the same place — enumerating search-path
// variables is a denylist. So no environment value, shell assignment or YAML
// `env:`, may name the untrusted tree at all; the directory stays passable as
// a program argument to a trusted tool. Assignment values are read quote-aware
// with backslashes applied, so `X="a b/candidate"` and `X=cand\idate` cannot
// hide the name, while `X='cand\idate'` stays the literal it is.
function shellAssignmentValues(text) {
  const values = [];
  const starts = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=/g;
  let match;
  while ((match = starts.exec(text)) !== null) {
    const valueStart = starts.lastIndex;
    let index = starts.lastIndex;
    let quote = null;
    let value = "";
    while (index < text.length) {
      const character = text[index];
      if (quote === "'") {
        if (character === "'") quote = null;
        else value += character;
      } else if (quote === '"') {
        if (character === '"') quote = null;
        else if (character === "\\") {
          index += 1;
          if (index < text.length) value += text[index];
        } else value += character;
      } else if (character === "'") {
        quote = "'";
      } else if (character === '"') {
        quote = '"';
      } else if (character === "\\") {
        index += 1;
        if (index < text.length) value += text[index];
      } else if (/[\s;&|)]/.test(character)) {
        break;
      } else {
        value += character;
      }
      index += 1;
    }
    values.push({ value, raw: text.slice(valueStart, index) });
    starts.lastIndex = index;
  }
  return values;
}

function valueNamesTree(value, directory) {
  const quoted = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[=:/'"\\s])${quoted}(?:[=:/'"\\s]|$)`).test(value);
}

function environmentSeedsTree(node, directory) {
  const env = mapPair(node, "env")?.value;
  if (!isMap(env)) return false;
  return env.items.some(
    (pair) =>
      isScalar(pair.value) &&
      typeof pair.value.value === "string" &&
      valueNamesTree(pair.value.value, directory)
  );
}

function stepSeedsEnvironmentWithTree(step, directory) {
  if (environmentSeedsTree(step, directory)) return true;
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  const text = joinShellContinuations(run.value);
  return shellAssignmentValues(text).some(({ value }) => valueNamesTree(value, directory));
}

// `y=cand && x="$y"idate` assembles the tree name without ever writing it, and
// `name=GITHUB_""OUTPUT` does the same to an environment-file name, so beside
// an untrusted checkout a shell assignment may only be a whole literal or a
// whole-value copy of one other variable: `code=$?`, `head_sha="$HEAD_SHA"`,
// and `-f name=baseline-source-verification` stay expressible, while any
// splice — quotes closing mid-value, concatenation, command substitution,
// arithmetic — fails closed. The raw text decides, because quote stripping
// would make `"$y"idate` look like the single variable `$yidate`.
const WHOLE_VALUE_EXPANSION = /^"?\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|[?$!#*@0-9])"?$/;
const WHOLE_LITERAL_VALUE = [/^[^'"$`]*$/, /^'[^']*'$/, /^"[^"'$`]*"$/];

// Actions substitutes `${{ }}` before the shell parses the line, so the shell
// layer is read with the expressions removed — what they may contain is the
// expression allowlist's business, not the word scanner's.
function stepShellText(step, { ignoreExpressions = false } = {}) {
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return null;
  const text = joinShellContinuations(run.value);
  return ignoreExpressions ? text.replace(/\$\{\{[^}]*\}\}/g, "") : text;
}

function stepAssemblesShellValue(step, options) {
  const text = stepShellText(step, options);
  if (text === null) return false;
  return shellAssignmentValues(text).some(
    ({ raw }) =>
      !WHOLE_VALUE_EXPANSION.test(raw) && !WHOLE_LITERAL_VALUE.some((form) => form.test(raw))
  );
}

// `./cand''idate/evil` executes the tree without the scan ever seeing its
// name: the empty quoted fragment splices one word out of two, and an escape,
// a glob, or `./cand{i..i}date/evil` does the same. Naming the constructs that
// expand has now missed globs once and braces twice, so an unquoted word is
// read by allowlist instead — only characters that cannot expand, plus the
// operator words a command list is built from. A quoted word is whole or it is
// nothing, and a `NAME=` prefix is stripped first because the assignment rule
// already constrains what follows it.
const READABLE_UNQUOTED_WORD = /^[A-Za-z0-9._/=:,+@%^-]*$/;
const SHELL_OPERATOR_WORD = new Set(["&&", "||", "|", ";", "&", ">", ">>", "<", "[", "]"]);
const WHOLE_WORD_FRAGMENT = [READABLE_UNQUOTED_WORD, /^'[^']*'$/, /^"[^"\\]*"$/];

function shellWords(text) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

function stepUsesUnreadableWord(step, options) {
  const text = stepShellText(step, options);
  if (text === null) return false;
  return shellWords(text).some((word) => {
    if (SHELL_OPERATOR_WORD.has(word)) return false;
    const value = word.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
    return !WHOLE_WORD_FRAGMENT.some((form) => form.test(value));
  });
}

// `cp -R candidate staged && ./staged/evil` re-homes the proposed bytes under
// a name the execution scan has never heard of. Following that copy would be
// flow analysis; instead the tree may not be named in a write-capable job's
// shell at all. With globs, substitution, indirection, and splices refused,
// naming it outright is the only way left to designate it, so refusing that
// leaves no path that can come to hold its bytes. A step that genuinely needs
// the directory gets it from a managed script, which derives the path from
// `$GITHUB_WORKSPACE` itself — `scripts/verify-baseline-source.mjs` is the
// baseline's own instance of that.
function stepNamesTreeInShell(step, directory) {
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  return valueNamesTree(joinShellContinuations(run.value), directory);
}

// `>> "${!name}"` resolves to whatever `name` spells, so scanning for the
// literal `GITHUB_OUTPUT` reads a name the shell never has to write. Indirect
// expansion, command substitution, arithmetic, and the modifier forms are all
// ways to produce a word the scan cannot predict, so beside an untrusted
// checkout a shell may expand only whole variables — `$VAR`, `${VAR}`, and the
// simple specials. With assembly refused above, that makes the literal
// environment-file scan sound: those files can then only be named outright.
// Single-quoted spans cannot expand at all, so they are read as the literals
// they are.
function stepUsesUnreadableExpansion(step, options) {
  const text = stepShellText(step, options);
  if (text === null) return false;
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      index += 1;
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      index += 1;
      continue;
    }
    if (character === "`") return true;
    if (character === "$") {
      const rest = text.slice(index + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*/.test(rest) || /^[?$!#*@0-9]/.test(rest)) {
        index += 1;
        continue;
      }
      if (/^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rest)) {
        index += 1;
        continue;
      }
      return true;
    }
    index += 1;
  }
  return false;
}

// `PATH: ${{ format('{0}/{1}', github.workspace, 'candidate') }}` resolves to
// the isolated checkout without the tree name surviving the boundary scan.
// Expressions are a full language, so a scanner cannot read what one
// assembles; beside an untrusted checkout an environment value may carry only
// expression forms that provably cannot build a path — a token, a named
// secret, a dispatch input, fixed run metadata, or a step outcome selecting
// between short literals — and the raw value, quoted literals included, still
// may not name the tree. `steps.X.outputs.Y` is not among them: a producer
// step can read `$GITHUB_EVENT_PATH` and write a comment body into
// `$GITHUB_OUTPUT`, so an output carries whatever its producer put there.
// `outcome` stays, because the runner writes it and it is one of four words.
const TRUSTED_ENVIRONMENT_EXPRESSION = [
  /^github\.token$/,
  /^secrets\.[A-Za-z0-9_]+(?:\s*\|\|\s*github\.token)?$/,
  /^inputs\.[A-Za-z0-9_]+$/,
  /^github\.(?:server_url|repository|run_id|sha)$/,
  /^steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'[A-Za-z0-9_-]+'\s*&&\s*'[A-Za-z0-9_-]+'\s*\|\|\s*'[A-Za-z0-9_-]+'$/
];

function computedEnvironmentValue(value) {
  const chunks = value.match(/\$\{\{[^}]*\}\}|\$\{\{/g) ?? [];
  return chunks.some((chunk) => {
    // A chunk the scanner cannot close — nested braces, an unterminated
    // expression — is unreadable, which is enough to refuse it.
    if (!chunk.endsWith("}}")) return true;
    const inner = chunk.slice(3, -2).trim();
    return !TRUSTED_ENVIRONMENT_EXPRESSION.some((pattern) => pattern.test(inner));
  });
}

function environmentCarriesComputedValue(node) {
  const env = mapPair(node, "env")?.value;
  if (!isMap(env)) return false;
  return env.items.some(
    (pair) =>
      isScalar(pair.value) &&
      typeof pair.value.value === "string" &&
      computedEnvironmentValue(pair.value.value)
  );
}

// Actions substitutes `${{ }}` into run text before the shell parses it, so
// what the shell actually runs is not the text being scanned. Beside an
// untrusted checkout a write-capable shell gets no interpolation at all —
// values arrive through `env`, where the forms above keep them readable.
function stepInterpolatesExpression(step) {
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  return run.value.includes("${{");
}

// `echo "$PWD/candidate" >> "$GITHUB_PATH"` puts the checkout on every later
// step's PATH, and `$GITHUB_ENV` persists arbitrary variables the same way.
// `$GITHUB_OUTPUT` feeds the allowlisted `steps.X.outputs.Y` form, and
// staging through intermediate files — `printf '%s/candidate' "$PWD" > result`
// then `cat result >> "$GITHUB_OUTPUT"` — defeats any line-local provenance
// scan. What flows into these files cannot be read statically, so beside an
// untrusted checkout all of them are off the table for free-form shell;
// outputs in that configuration come only from SHA-pinned actions or managed,
// hash-locked scripts, whose provenance is the lock rather than the scan.
const STEP_ENVIRONMENT_FILE = /\bGITHUB_(?:ENV|PATH|OUTPUT|STATE)\b/;

// `eval "$(jq -r .comment.body "$GITHUB_EVENT_PATH")"` carries no expression
// at all: the payload arrives as a file. Moving payload reads into managed
// scripts was the point of that file, so in a write-capable actor-triggered
// job free-form shell may not name it — the script that needs the event reads
// it, and its bytes are hash-locked.
const EVENT_PAYLOAD_FILE = /\bGITHUB_EVENT_(?:PATH|NAME)\b/;

function stepReadsEventPayload(step) {
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  return EVENT_PAYLOAD_FILE.test(run.value);
}

// `../../_temp/_github_workflow/event.json` is that same payload reached by
// walking to it, and `$RUNNER_TEMP` is the same walk with a variable for a
// map. Naming the file's spellings one at a time is the losing side; what
// they have in common is leaving the workspace. The workspace holds the
// repository's own reviewed bytes, so shell in a write-capable
// actor-triggered job stays inside it: no absolute path, nothing climbing
// above the root, and none of the variables that point at runner state.
const RUNNER_STATE_VARIABLE = /\b(?:RUNNER_TEMP|RUNNER_TOOL_CACHE|RUNNER_WORKSPACE|HOME)\b/;

// Both separators count: `D:\\a\\_temp\\_github_workflow\\event.json` on a
// Windows runner holds no forward slash at all, and a drive letter or a
// leading separator is as absolute as `/`.
function pathEscapesWorkspace(value) {
  // `dd if=../../_temp/...` glues an operand prefix to the first `..`, and
  // cancelling one `..` against a later segment is how normalization was
  // talked out of seeing the climb. Nothing here needs `..` at all, so the
  // prefix comes off and any `..` segment is the answer on its own — no
  // arithmetic to be fooled.
  // Quoting is grouping, not part of the path, and it can sit anywhere: an
  // outer quote around the whole word, or one that surfaces only after the
  // `if=` prefix comes off. Spliced words are already refused in these jobs,
  // so dropping every quote character leaves the path the shell would use.
  const bare = value.replace(/^["']|["']$/g, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replace(/["']/g, "");
  if (/^[\\/]/.test(bare) || /^[A-Za-z]:/.test(bare)) return true;
  return bare
    .split(/[\\/]+/)
    .some((segment) => segment === ".." || segment.startsWith("..") || segment.endsWith(".."));
}

// A path that leaves the workspace does not have to sit in the shell text: an
// `env` value can hold it and the shell then names only a variable. Literal
// values are checked here; a value carrying an expression is the expression
// allowlist's business, and nothing it admits builds a path.
function valuesEscapeWorkspace(node, key) {
  const map = mapPair(node, key)?.value;
  if (!isMap(map)) return false;
  return map.items.some((pair) => {
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") return false;
    const value = pair.value.value.trim();
    if (value.includes("${{")) return false;
    return pathEscapesWorkspace(value);
  });
}

// `working-directory` moves the shell before it runs, so an escape there needs
// no escaping word in the command at all: `../../_temp/_github_workflow` puts
// the runner's event file one plain filename away. A job's `defaults.run`
// carries the same move to every step that does not override it.
function runDirectoryValue(node) {
  const directory = mapPair(node, "working-directory")?.value;
  if (!isScalar(directory) || typeof directory.value !== "string") return null;
  return directory.value.trim();
}

function defaultRunDirectoryValue(node) {
  const defaults = mapPair(node, "defaults")?.value;
  const run = isMap(defaults) ? mapPair(defaults, "run")?.value : undefined;
  return isMap(run) ? runDirectoryValue(run) : null;
}

function directoryEscapesWorkspace(value) {
  if (value === null || value.includes("${{")) return false;
  return pathEscapesWorkspace(value) || normalizedRelativeSegments(value) === null;
}

// `printenv > vars && ... && read EVENT < path && jq ... "$EVENT"` rebuilds the
// event path at run time without ever spelling it: `read` binds a name that no
// assignment created. Chasing the builtins that can bind a name — `read`,
// `mapfile`, `source`, and whatever comes next — is the losing side again, so
// the rule is about references instead. A name may be used only if the
// workflow put it there: declared in `env`, assigned earlier in this same
// command by an assignment the assembly rule already vetted, or one of the
// runner's own settled values. A name that merely exists is unknown, however
// it came to exist.
const SAFE_RUNNER_VARIABLE = new Set([
  "CI", "PWD", "PATH", "GITHUB_WORKSPACE", "GITHUB_REPOSITORY", "GITHUB_SHA",
  "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
  "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_ACTOR", "RUNNER_OS", "RUNNER_ARCH"
]);

function environmentNames(node) {
  const env = mapPair(node, "env")?.value;
  if (!isMap(env)) return [];
  return env.items
    .filter((pair) => isScalar(pair.key) && typeof pair.key.value === "string")
    .map((pair) => String(pair.key.value));
}

// A file holding `EVENT=/path/to/event.json`, then `. bind`, rebinds a name
// that appears nowhere in the command — the lexical scan cannot see a name
// that exists only inside a file it never reads. Rather than adding sourcing
// to a list that has grown once per round, the ability to move data is what
// goes: a shell here runs commands, it does not plumb them. No redirection,
// no pipe, no sourcing — so there is no file to build, no file to read back,
// and no second shell reading anything the first one wrote. Everything a step
// needs still arrives through `env`, and anything that genuinely needs to
// move bytes is a script, where the code is reviewed rather than quoted.
// Only in command position: `git -C . pull` has a `.` as an argument, which
// is not sourcing anything.
const SOURCING_COMMAND = /(?:^|[\n;&|(]\s*)(?:\.|source)\s/;

// `python3 -c 'import json,os;exec(...)'` is a program in another language
// wearing quotes, and quotes are exactly what the shell scan steps over.
// Listing the flags that take a program (`-c`, `-e`, `--eval`, an awk script,
// a jq filter) is the losing side once more, so a quoted word may only be
// what a quoted word is needed for here: a path, a flag, a token, or one
// whole variable reference with a path after it. A program belongs in a file,
// where it is reviewed rather than quoted.
function isPlainQuotedContent(content) {
  const rest = content.replace(/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/, "");
  return READABLE_UNQUOTED_WORD.test(rest);
}

// A program can also arrive through the door the shell is allowed to use:
// `env: PROGRAM: 'import json,os;exec(...)'` with `run: python3 -c "$PROGRAM"`
// hands the same source through a reference that reads as perfectly whole. So
// a literal value declared for one of these jobs is held to what a quoted word
// is held to — a path, a flag, a token — and a value carrying an expression is
// the expression allowlist's business, as before.
function valuesQuoteAProgram(node, key) {
  const map = mapPair(node, key)?.value;
  if (!isMap(map)) return false;
  return map.items.some((pair) => {
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") return false;
    const value = pair.value.value.trim();
    if (!value || value.includes("${{")) return false;
    return !isPlainQuotedContent(value);
  });
}

function stepQuotesAProgram(step) {
  const text = stepShellText(step, { ignoreExpressions: true });
  if (text === null) return false;
  return shellWords(text).some((word) => {
    const quoted = /^(['"])([\s\S]*)\1$/.exec(word);
    return quoted ? !isPlainQuotedContent(quoted[2]) : false;
  });
}

function stepMovesData(step) {
  const text = stepShellText(step, { ignoreExpressions: true });
  if (text === null) return false;
  const bare = outsideQuotes(text);
  return /[<>|]/.test(bare) || SOURCING_COMMAND.test(bare);
}

function stepNamesUnknownVariable(step, declared) {
  const text = stepShellText(step, { ignoreExpressions: true });
  if (text === null) return false;
  const known = new Set([...declared, ...environmentNames(step), ...SAFE_RUNNER_VARIABLE]);
  // `EVENT=safe && ... && read EVENT < path && ... "$EVENT"` reads the name
  // the workflow set and gets the one `read` put there instead. Deciding
  // which binding a reference lands on is dataflow, and the commands that can
  // rebind a name have no end, so a name that appears as a word of the
  // command at all — an assignment target, an argument to something that
  // binds — is no longer readable there. A workflow value is used as it
  // arrives, or the work belongs in a script.
  const bound = new Set();
  for (const word of shellWords(text)) {
    const name = word.replace(/["']/g, "").replace(/=[\s\S]*$/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bound.add(name);
  }
  for (const match of text.matchAll(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g)) {
    const name = match[1] ?? match[2];
    if (!known.has(name) || bound.has(name)) return true;
  }
  return false;
}

function stepReachesOutsideWorkspace(step) {
  if (directoryEscapesWorkspace(runDirectoryValue(step))) return true;
  if (valuesEscapeWorkspace(step, "env") || valuesEscapeWorkspace(step, "with")) return true;
  const text = stepShellText(step, { ignoreExpressions: true });
  if (text === null) return false;
  if (RUNNER_STATE_VARIABLE.test(text)) return true;
  return shellWords(text).some((word) => pathEscapesWorkspace(word));
}

function stepTouchesEnvironmentFiles(step) {
  const run = mapPair(step, "run")?.value;
  if (!isScalar(run) || typeof run.value !== "string") return false;
  return STEP_ENVIRONMENT_FILE.test(run.value);
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
  // The condition cannot enforce itself: a manual run picks a ref, GitHub
  // loads that ref's copy of the workflow, and a branch copy can simply delete
  // the `if`. What a branch cannot rewrite is an environment — GitHub decides
  // which refs may deploy to one — so a write-capable dispatch job has to name
  // one, with its deployment branches restricted to the default branch in the
  // repository settings. `docs/operations/github-setup.md` carries that step.
  const environment = mapPair(job, "environment")?.value;
  const guarded =
    (isScalar(environment) && typeof environment.value === "string" && environment.value.trim()) ||
    (isMap(environment) && mapPair(environment, "name") !== undefined);
  return dispatchEvent && defaultBranch && Boolean(guarded);
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
    // A default-branch push, a manual dispatch, and a schedule carry only what
    // the repository already holds. Every other event arrives with a payload
    // someone outside the trust boundary shaped — a comment body, a run to
    // inspect, a caller's inputs — so a write-capable job under one of those
    // may reach only for the actions this baseline vouches for. A deploy job
    // on a repository-controlled event keeps its own tooling.
    const actorTriggered =
      events.size === 0 ||
      [...events].some((event) =>
        event === "push" ? !trustedPush : !REPOSITORY_CONTROLLED_EVENTS.has(event)
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
        if (writes && actorTriggered) {
          // A job that calls a reusable workflow has no steps to scan, and the
          // called workflow runs with this job's token. Its inputs are the
          // same actor-controlled surface a step's `env` is, and a published
          // workflow is third-party code holding the token.
          if (
            jobInputsCarryActorControlledRef(jobPair.value) ||
            valuesCarryUnreadableExpression(jobPair.value, "with")
          ) {
            failures.push(
              `Write-capable job ${jobName} passes an actor-controlled ref to what it calls: ${path}`
            );
          }
          if (
            valuesQuoteAProgram(root, "env") ||
            valuesQuoteAProgram(jobPair.value, "env") ||
            valuesQuoteAProgram(jobPair.value, "with")
          ) {
            failures.push(
              `Write-capable job ${jobName} quotes a program in its environment: ${path}`
            );
          }
          const declaredEnvironmentNames = [
            ...environmentNames(root),
            ...environmentNames(jobPair.value)
          ];
          if (
            valuesEscapeWorkspace(root, "env") ||
            valuesEscapeWorkspace(jobPair.value, "env") ||
            valuesEscapeWorkspace(jobPair.value, "with") ||
            directoryEscapesWorkspace(defaultRunDirectoryValue(root)) ||
            directoryEscapesWorkspace(defaultRunDirectoryValue(jobPair.value))
          ) {
            failures.push(
              `Write-capable job ${jobName} reaches outside the workspace: ${path}`
            );
          }
          if (
            valuesCarryUnreadableExpression(root, "env") ||
            valuesCarryUnreadableExpression(jobPair.value, "env")
          ) {
            failures.push(
              `Write-capable job ${jobName} carries an expression that cannot be read: ${path}`
            );
          }
          if (reusableWorkflow && usesUnvouchedReference(reusableWorkflow.value)) {
            failures.push(
              `Write-capable job ${jobName} calls a workflow that is not vouched for: ${path}`
            );
          }
          if (isSeq(steps)) {
            for (const step of steps.items) {
              if (!isMap(step)) continue;
              if (stepUsesUnvouchedAction(step)) {
                failures.push(
                  `Write-capable job ${jobName} uses an action that is not vouched for: ${path}`
                );
              }
              if (stepCarriesUnreadableExpression(step)) {
                failures.push(
                  `Write-capable job ${jobName} carries an expression that cannot be read: ${path}`
                );
              }
              // Reading the payload and running what comes back needs no
              // expression, so the shell here is held to the same standard it
              // is held to beside proposed code.
              const shellOptions = { ignoreExpressions: true };
              if (
                stepUsesUnreadableExpansion(step, shellOptions) ||
                stepUsesUnreadableWord(step, shellOptions) ||
                stepAssemblesShellValue(step, shellOptions)
              ) {
                failures.push(
                  `Write-capable job ${jobName} runs shell that cannot be read: ${path}`
                );
              }
              if (stepReadsEventPayload(step)) {
                failures.push(
                  `Write-capable job ${jobName} reads the event payload in its shell: ${path}`
                );
              }
              if (stepQuotesAProgram(step)) {
                failures.push(
                  `Write-capable job ${jobName} quotes a program in its shell: ${path}`
                );
              }
              if (valuesQuoteAProgram(step, "env") || valuesQuoteAProgram(step, "with")) {
                failures.push(
                  `Write-capable job ${jobName} quotes a program in its environment: ${path}`
                );
              }
              if (stepMovesData(step)) {
                failures.push(
                  `Write-capable job ${jobName} moves data through its shell: ${path}`
                );
              }
              if (stepNamesUnknownVariable(step, declaredEnvironmentNames)) {
                failures.push(
                  `Write-capable job ${jobName} uses a variable the workflow did not set: ${path}`
                );
              }
              if (stepReachesOutsideWorkspace(step)) {
                failures.push(
                  `Write-capable job ${jobName} reaches outside the workspace: ${path}`
                );
              }
            }
          }
        }
        if (writes && isSeq(steps)) {
          const refExpressionInScope =
            environmentRefExpression(root) || environmentRefExpression(jobPair.value);
          const isolated = [];
          for (const step of steps.items) {
            if (!isMap(step)) continue;
            if (stepNamesActorControlledRef(step, refExpressionInScope)) {
              failures.push(
                `Write-capable job ${jobName} names an actor-controlled ref in its shell: ${path}`
              );
            }
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
          // The effective default is what the steps inherit, so it is the one
          // that has to be statically knowable — job-level or workflow-level.
          const computedRootDefault =
            effectiveWorkingDirectory !== undefined &&
            (!isScalar(effectiveWorkingDirectory) ||
              typeof effectiveWorkingDirectory.value !== "string" ||
              effectiveWorkingDirectory.value.includes("${{"));
          for (const directory of isolated) {
            const defaultsEnterTree = directoryEntersUntrustedTree(effectiveWorkingDirectory, directory);
            if (environmentSeedsTree(root, directory) || environmentSeedsTree(jobPair.value, directory)) {
              failures.push(
                `Write-capable job ${jobName} seeds the environment with the untrusted checkout ${directory}: ${path}`
              );
            }
            if (environmentCarriesComputedValue(root) || environmentCarriesComputedValue(jobPair.value)) {
              failures.push(
                `Write-capable job ${jobName} carries a computed environment value alongside the untrusted checkout ${directory}: ${path}`
              );
            }
            for (const step of steps.items) {
              if (!isMap(step)) continue;
              if (stepExecutesFromDirectory(step, directory, defaultsEnterTree)) {
                failures.push(
                  `Write-capable job ${jobName} executes code from the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepSeedsEnvironmentWithTree(step, directory)) {
                failures.push(
                  `Write-capable job ${jobName} seeds the environment with the untrusted checkout ${directory}: ${path}`
                );
              }
              if (environmentCarriesComputedValue(step)) {
                failures.push(
                  `Write-capable job ${jobName} carries a computed environment value alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepAssemblesShellValue(step)) {
                failures.push(
                  `Write-capable job ${jobName} assembles a shell value alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepUsesUnreadableExpansion(step)) {
                failures.push(
                  `Write-capable job ${jobName} expands more than a whole variable alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepUsesUnreadableWord(step)) {
                failures.push(
                  `Write-capable job ${jobName} splices a shell word alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepNamesTreeInShell(step, directory)) {
                failures.push(
                  `Write-capable job ${jobName} names the untrusted checkout ${directory} in its shell: ${path}`
                );
              }
              if (stepUsesUnvouchedAction(step)) {
                failures.push(
                  `Write-capable job ${jobName} uses an action that is not vouched for beside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepInterpolatesExpression(step)) {
                failures.push(
                  `Write-capable job ${jobName} interpolates an expression into its shell alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepTouchesEnvironmentFiles(step)) {
                failures.push(
                  `Write-capable job ${jobName} touches the step environment files alongside the untrusted checkout ${directory}: ${path}`
                );
              }
              if (stepHasComputedWorkingDirectory(step) || (computedRootDefault && !mapPair(step, "working-directory"))) {
                failures.push(
                  `Write-capable job ${jobName} runs with a computed working directory alongside the untrusted checkout ${directory}: ${path}`
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
    if (!stat.isFile()) continue;
    // The size and binary caps exist so a large asset is not read as text, and
    // they used to skip the file entirely — including a workflow, which is the
    // one kind of file here whose contents are a security boundary. A workflow
    // the scan cannot read is refused instead of waved through; nothing else
    // changes.
    const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized);
    if (stat.size > 2_000_000) {
      if (isWorkflow) failures.push(`Workflow file is too large to validate: ${normalized}`);
      continue;
    }
    const buffer = readFileSync(absolute);
    if (looksBinary(buffer)) {
      if (isWorkflow) failures.push(`Workflow file is not readable text: ${normalized}`);
      continue;
    }
    const text = buffer.toString("utf8");
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) failures.push(`Possible ${label} in ${normalized}`);
    }
    if (PERSONAL_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
      failures.push(`Personal absolute path in ${normalized}`);
    }
    if (isWorkflow) failures.push(...validateWorkflowText(normalized, text));
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
