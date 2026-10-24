/* Pure helpers behind the Codex Review gate: who may ask for a review, what
   counts as Codex's answer, and whether that answer blocks the pull request.
   Kept free of I/O so the gate's rules can be tested directly. */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CODEX_REVIEW_LOGIN = "chatgpt-codex-connector[bot]";

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function compareNumericIds(left, right) {
  if (!/^\d+$/.test(String(left || "")) || !/^\d+$/.test(String(right || ""))) return 0;
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
}

export function isTrustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(String(value || "").toUpperCase());
}

export function isTrustedCodexLogin(login) {
  return normalize(login) === CODEX_REVIEW_LOGIN;
}

export function isCodexReviewCommand(body) {
  return /(?:^|\s)@codex\s+review\b/i.test(String(body || ""));
}

/* The full head SHA has to be written out: a bare "@codex review" would keep
   vouching for whatever the branch looked like later. */
export function isCodexReviewCommandForHead(body, headSha) {
  const requestedHead = String(body || "").match(
    /(?:^|\s)@codex\s+review\s+`?([a-f0-9]{40})`?\b/i
  )?.[1];
  return Boolean(requestedHead) && normalize(requestedHead) === normalize(headSha);
}

export function isStrictlyAfterCodexReviewRequest(value, request) {
  const valueTime = Date.parse(value || "");
  const requestedAt = Date.parse(request?.requestedAt || "");
  return Number.isFinite(valueTime) && Number.isFinite(requestedAt) && valueTime > requestedAt;
}

/** The newest trusted "@codex review <head>" comment, or null if none exists.
    This is the gate's whole trust model: a human with write access naming the
    exact commit they are vouching for. */
export function latestTrustedCodexReviewCommand(comments = [], headSha) {
  return comments
    .filter((comment) =>
      comment?.user?.type !== "Bot" &&
      isTrustedAssociation(comment?.author_association) &&
      isCodexReviewCommandForHead(comment?.body, headSha)
    )
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))
    .map((comment) => ({
      sha: headSha,
      commentId: String(comment.id || ""),
      requestedAt: comment.created_at
    }))[0] || null;
}

export function extractCodexPriority(body) {
  const match = String(body || "").match(/\bP([0-3])\b/i);
  return match ? Number(match[1]) : null;
}

// HTML5 named entities whose expansion is whitespace or Unicode format text.
function isEscapedMarkdownStart(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

// Code contexts display link syntax literally; protect their opening bracket
// until visible entities are decoded, after all Markdown transformations.
function indentationColumns(prefix) {
  return Array.from(prefix).reduce((column, character) => column + (character === "\t" ? 4 - column % 4 : 1), 0);
}


function consumeIndentationColumns(line, required) {
  let column = 0, index = 0;
  while (column < required && /[ \t]/.test(line[index] || "x")) {
    column += line[index++] === "\t" ? 4 - column % 4 : 1;
  }
  return column < required ? null : " ".repeat(column - required) + line.slice(index);
}

// HTML tokenizer comment endings, including abrupt empty-comment closure.

function markdownContainerContext(line) {
  const frames = [];
  while (true) {
    const quote = line.match(/^ {0,3}>[ \t]?/);
    if (quote) { frames.push({ kind: "quote" }); line = line.slice(quote[0].length); continue; }
    const list = line.match(/^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/);
    if (list) { frames.push({ kind: "list", width: indentationColumns(list[0]) }); line = line.slice(list[0].length); continue; }
    return { content: line, frames };
  }
}


function markdownContainerContinuation(line, frames) {
  for (const frame of frames) {
    if (frame.kind === "list") {
      line = consumeIndentationColumns(line, frame.width);
      if (line === null) return null;
    } else {
      const prefix = line.match(/^ {0,3}>[ \t]?/);
      if (!prefix) return null;
      line = line.slice(prefix[0].length);
    }
  }
  return line;
}


function stripMarkdownContainers(text, preserveBoundaries = false) {
  let previousFrames = [];
  return text.split("\n").map((line) => {
    const context = markdownContainerContext(line);
    const continuation = markdownContainerContinuation(line, previousFrames);
    const boundary = preserveBoundaries && previousFrames.length && continuation === null ? "\n" : "";
    previousFrames = context.frames.length ? context.frames : continuation === null ? [] : previousFrames;
    return boundary + context.content;
  }).join("\n");
}

function nextEqualTickRuns(ticks) {
  const nextByLength = new Map();
  const successors = new Array(ticks.length);
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const length = ticks[index][0].length;
    successors[index] = nextByLength.get(length);
    nextByLength.set(length, ticks[index]);
  }
  return successors;
}

// CommonMark delimiter runs: flanking, intraword underscores, and rule of three.
function activeMarkdownEmphasis(text) {
  const removed = new Set();
  const runs = [];
  const whitespace = (value) => !value || /\s/u.test(value);
  const punctuation = (value) => !!value && /[\p{P}\p{S}]/u.test(value);
  const escaped = (index) => isEscapedMarkdownStart(text, index);
  // Matched code-span delimiters disappear; their literal content is protected
  // by the existing code-context stage before this projection.
  const ticks = [...text.matchAll(/`+/g)];
  const nextTicks = nextEqualTickRuns(ticks);
  let consumed = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    const start = ticks[i];
    if (start.index < consumed || escaped(start.index)) continue;
    const end = nextTicks[i];
    if (!end) continue;
    for (let j = 0; j < start[0].length; j += 1) { removed.add(start.index + j); removed.add(end.index + j); }
    consumed = end.index + end[0].length;
  }
  for (const match of text.matchAll(/\*+|_+|~{2,}/g)) {
    if (escaped(match.index)) continue;
    const beforeIndex = match.index - (match.index >= 2 && /[\uDC00-\uDFFF]/.test(text[match.index - 1]) && /[\uD800-\uDBFF]/.test(text[match.index - 2]) ? 2 : 1);
    const before = beforeIndex >= 0 ? String.fromCodePoint(text.codePointAt(beforeIndex)) : "";
    const afterIndex = match.index + match[0].length;
    const after = afterIndex < text.length ? String.fromCodePoint(text.codePointAt(afterIndex)) : "";
    const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
    const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
    runs.push({ character: match[0][0], start: match.index, length: match[0].length, usedOpen: 0, usedClose: 0,
      open: match[0][0] === "_" ? left && (!right || punctuation(before)) : left,
      close: match[0][0] === "_" ? right && (!left || punctuation(after)) : right });
  }
  const eligibleOpeners = new Map();
  for (let closeIndex = 0; closeIndex < runs.length; closeIndex += 1) {
    const closer = runs[closeIndex];
    const candidates = eligibleOpeners.get(closer.character) || [];
    if (closer.close) for (let candidate = candidates.length - 1; candidate >= 0 && closer.length - closer.usedClose >= (closer.character === "~" ? 2 : 1); candidate -= 1) {
      const openIndex = candidates[candidate];
      const opener = runs[openIndex];
      if (!opener.open || opener.character !== closer.character || /\r?\n[ \t\f\v]*\r?\n/.test(text.slice(opener.start, closer.start))) continue;
      let availableOpen = opener.length - opener.usedOpen - opener.usedClose;
      let availableClose = closer.length - closer.usedOpen - closer.usedClose;
      if (availableOpen < (closer.character === "~" ? 2 : 1)) continue;
      if (closer.character !== "~" && (opener.close || closer.open) &&
          (availableOpen + availableClose) % 3 === 0 && (availableOpen % 3 !== 0 || availableClose % 3 !== 0)) continue;
      while (availableOpen >= (closer.character === "~" ? 2 : 1) && availableClose >= (closer.character === "~" ? 2 : 1)) {
        const count = availableOpen >= 2 && availableClose >= 2 ? 2 : 1;
        for (let j = 0; j < count; j += 1) {
          removed.add(opener.start + opener.length - opener.usedOpen - 1 - j);
          removed.add(closer.start + closer.usedClose + j);
        }
        opener.usedOpen += count; closer.usedClose += count;
        for (let nested = openIndex + 1; nested < closeIndex; nested += 1) { runs[nested].open = false; runs[nested].close = false; }
        availableOpen -= count; availableClose -= count;
      }
    }
    if (closer.open) {
      candidates.push(closeIndex);
      eligibleOpeners.set(closer.character, candidates);
    }
  }
  return text.split("").map((character, index) => removed.has(index) ? "" : character).join("");
}

function preserveLiteralMarkdownLinks(text) {
  const spans = [];
  let consumed = 0;
  const ticks = [...text.matchAll(/`+/g)];
  const nextTicks = nextEqualTickRuns(ticks);
  for (let i = 0; i < ticks.length; i += 1) {
    const start = ticks[i];
    if (start.index < consumed || isEscapedMarkdownStart(text, start.index)) continue;
    const end = nextTicks[i];
    if (!end) continue;
    spans.push([start.index, end.index + end[0].length]);
    consumed = end.index + end[0].length;
  }
  for (const tag of text.matchAll(/<(code|pre|script|style|textarea)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tail = text.slice(tag.index + tag[0].length);
    const close = tail.search(new RegExp("</" + tag[1] + "\\s*>", "i"));
    spans.push([tag.index + tag[0].length, close === -1 ? text.length : tag.index + tag[0].length + close]);
  }
  let cachedLineStart = -1;
  let cachedLineEnd = -1;
  let cachedContext = null;
  let stableLine = false;
  return text.replace(/[&<\[*_~]/g, (bracket, index) => {
    if (index > cachedLineEnd) {
      cachedLineStart = text.lastIndexOf("\n", index - 1) + 1;
      const newline = text.indexOf("\n", index);
      cachedLineEnd = newline === -1 ? text.length : newline;
      cachedContext = null;
      stableLine = !/[<`~]/.test(text.slice(cachedLineStart, cachedLineEnd));
    }
    let flags = stableLine ? cachedContext : null;
    if (!flags) {
      const context = stripMarkdownContainers(text.slice(0, index));
      const indentation = context.slice(context.lastIndexOf("\n") + 1).match(/^[ \t]*/)[0];
      flags = { raw: isRawHtmlRowContext(text, index, true), literal: indentation.includes("\t") || indentation.length >= 4 || isProtocolCodeExample(context, context.length) };
      if (stableLine) cachedContext = flags;
    }
    return (/[\[*_~]/.test(bracket) && flags.raw) ||
      spans.some(([start, end]) => index >= start && index < end) || flags.literal
      ? "&#" + bracket.codePointAt(0) + ";" : bracket;
  });
}

function isVisibleLinkLabel(label, reference = false) {
  if (reference && ([...label].length > 999 || !/[^ \t\r\n\f\v]/.test(label) || /[\[\]]/.test(label.replace(/\\[!-/:-@[-`{-~]/g, "")))) return false;
  return !/\n[ \t\f\v]*\n/.test(label.replace(/\r\n?/g, "\n"));
}

function isVisibleLinkDestination(destination, allowEmpty = true) {
  destination = destination.replace(/\r\n?/g, "\n");
  if (/\r?\n[ \t\f\v]*\r?\n/.test(destination)) return false;
  const target = destination.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
  if (!target) return allowEmpty;
  const bare = target.replace(/\\[!-/:-@[-`{-~]/g, "");
  const titled = target.match(/^(<[^<>\r\n]*>|[^ \t\r\n\f\v]+)[ \t\r\n\f\v]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))[ \t\r\n\f\v]*$/);
  const linkTarget = titled ? titled[1] : target;
  if (!linkTarget.startsWith("<")) {
    let depth = 0;
    for (const character of linkTarget.replace(/\\[!-/:-@[-`{-~]/g, "")) {
      if (character === "(" && ++depth > 32) return false;
      else if (character === ")" && --depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return !(/[ \t\r\n\f\v]/.test(bare) && !titled && !/^<[^<>\r\n]*>$/.test(linkTarget)) && !(/[<>]/.test(linkTarget) && !/^<[^<>\r\n]*>$/.test(linkTarget));
}

// Unicode 16.0 full case-fold exceptions to per-code-point lowercase.
// Generated with Python str.casefold(): {c: c.casefold() for c in map(chr, range(0x110000)) if c.casefold() != c.lower()}.
const unicodeCaseFold = Object.freeze({
  "\u00b5": "\u03bc", "\u00df": "ss", "\u0149": "\u02bcn", "\u017f": "s", "\u01f0": "j\u030c", "\u0345": "\u03b9", "\u0390": "\u03b9\u0308\u0301", "\u03b0": "\u03c5\u0308\u0301",
  "\u03c2": "\u03c3", "\u03d0": "\u03b2", "\u03d1": "\u03b8", "\u03d5": "\u03c6", "\u03d6": "\u03c0", "\u03f0": "\u03ba", "\u03f1": "\u03c1", "\u03f5": "\u03b5",
  "\u0587": "\u0565\u0582", "\u13a0": "\u13a0", "\u13a1": "\u13a1", "\u13a2": "\u13a2", "\u13a3": "\u13a3", "\u13a4": "\u13a4", "\u13a5": "\u13a5", "\u13a6": "\u13a6",
  "\u13a7": "\u13a7", "\u13a8": "\u13a8", "\u13a9": "\u13a9", "\u13aa": "\u13aa", "\u13ab": "\u13ab", "\u13ac": "\u13ac", "\u13ad": "\u13ad", "\u13ae": "\u13ae",
  "\u13af": "\u13af", "\u13b0": "\u13b0", "\u13b1": "\u13b1", "\u13b2": "\u13b2", "\u13b3": "\u13b3", "\u13b4": "\u13b4", "\u13b5": "\u13b5", "\u13b6": "\u13b6",
  "\u13b7": "\u13b7", "\u13b8": "\u13b8", "\u13b9": "\u13b9", "\u13ba": "\u13ba", "\u13bb": "\u13bb", "\u13bc": "\u13bc", "\u13bd": "\u13bd", "\u13be": "\u13be",
  "\u13bf": "\u13bf", "\u13c0": "\u13c0", "\u13c1": "\u13c1", "\u13c2": "\u13c2", "\u13c3": "\u13c3", "\u13c4": "\u13c4", "\u13c5": "\u13c5", "\u13c6": "\u13c6",
  "\u13c7": "\u13c7", "\u13c8": "\u13c8", "\u13c9": "\u13c9", "\u13ca": "\u13ca", "\u13cb": "\u13cb", "\u13cc": "\u13cc", "\u13cd": "\u13cd", "\u13ce": "\u13ce",
  "\u13cf": "\u13cf", "\u13d0": "\u13d0", "\u13d1": "\u13d1", "\u13d2": "\u13d2", "\u13d3": "\u13d3", "\u13d4": "\u13d4", "\u13d5": "\u13d5", "\u13d6": "\u13d6",
  "\u13d7": "\u13d7", "\u13d8": "\u13d8", "\u13d9": "\u13d9", "\u13da": "\u13da", "\u13db": "\u13db", "\u13dc": "\u13dc", "\u13dd": "\u13dd", "\u13de": "\u13de",
  "\u13df": "\u13df", "\u13e0": "\u13e0", "\u13e1": "\u13e1", "\u13e2": "\u13e2", "\u13e3": "\u13e3", "\u13e4": "\u13e4", "\u13e5": "\u13e5", "\u13e6": "\u13e6",
  "\u13e7": "\u13e7", "\u13e8": "\u13e8", "\u13e9": "\u13e9", "\u13ea": "\u13ea", "\u13eb": "\u13eb", "\u13ec": "\u13ec", "\u13ed": "\u13ed", "\u13ee": "\u13ee",
  "\u13ef": "\u13ef", "\u13f0": "\u13f0", "\u13f1": "\u13f1", "\u13f2": "\u13f2", "\u13f3": "\u13f3", "\u13f4": "\u13f4", "\u13f5": "\u13f5", "\u13f8": "\u13f0",
  "\u13f9": "\u13f1", "\u13fa": "\u13f2", "\u13fb": "\u13f3", "\u13fc": "\u13f4", "\u13fd": "\u13f5", "\u1c80": "\u0432", "\u1c81": "\u0434", "\u1c82": "\u043e",
  "\u1c83": "\u0441", "\u1c84": "\u0442", "\u1c85": "\u0442", "\u1c86": "\u044a", "\u1c87": "\u0463", "\u1c88": "\ua64b", "\u1e96": "h\u0331", "\u1e97": "t\u0308",
  "\u1e98": "w\u030a", "\u1e99": "y\u030a", "\u1e9a": "a\u02be", "\u1e9b": "\u1e61", "\u1e9e": "ss", "\u1f50": "\u03c5\u0313", "\u1f52": "\u03c5\u0313\u0300", "\u1f54": "\u03c5\u0313\u0301",
  "\u1f56": "\u03c5\u0313\u0342", "\u1f80": "\u1f00\u03b9", "\u1f81": "\u1f01\u03b9", "\u1f82": "\u1f02\u03b9", "\u1f83": "\u1f03\u03b9", "\u1f84": "\u1f04\u03b9", "\u1f85": "\u1f05\u03b9", "\u1f86": "\u1f06\u03b9",
  "\u1f87": "\u1f07\u03b9", "\u1f88": "\u1f00\u03b9", "\u1f89": "\u1f01\u03b9", "\u1f8a": "\u1f02\u03b9", "\u1f8b": "\u1f03\u03b9", "\u1f8c": "\u1f04\u03b9", "\u1f8d": "\u1f05\u03b9", "\u1f8e": "\u1f06\u03b9",
  "\u1f8f": "\u1f07\u03b9", "\u1f90": "\u1f20\u03b9", "\u1f91": "\u1f21\u03b9", "\u1f92": "\u1f22\u03b9", "\u1f93": "\u1f23\u03b9", "\u1f94": "\u1f24\u03b9", "\u1f95": "\u1f25\u03b9", "\u1f96": "\u1f26\u03b9",
  "\u1f97": "\u1f27\u03b9", "\u1f98": "\u1f20\u03b9", "\u1f99": "\u1f21\u03b9", "\u1f9a": "\u1f22\u03b9", "\u1f9b": "\u1f23\u03b9", "\u1f9c": "\u1f24\u03b9", "\u1f9d": "\u1f25\u03b9", "\u1f9e": "\u1f26\u03b9",
  "\u1f9f": "\u1f27\u03b9", "\u1fa0": "\u1f60\u03b9", "\u1fa1": "\u1f61\u03b9", "\u1fa2": "\u1f62\u03b9", "\u1fa3": "\u1f63\u03b9", "\u1fa4": "\u1f64\u03b9", "\u1fa5": "\u1f65\u03b9", "\u1fa6": "\u1f66\u03b9",
  "\u1fa7": "\u1f67\u03b9", "\u1fa8": "\u1f60\u03b9", "\u1fa9": "\u1f61\u03b9", "\u1faa": "\u1f62\u03b9", "\u1fab": "\u1f63\u03b9", "\u1fac": "\u1f64\u03b9", "\u1fad": "\u1f65\u03b9", "\u1fae": "\u1f66\u03b9",
  "\u1faf": "\u1f67\u03b9", "\u1fb2": "\u1f70\u03b9", "\u1fb3": "\u03b1\u03b9", "\u1fb4": "\u03ac\u03b9", "\u1fb6": "\u03b1\u0342", "\u1fb7": "\u03b1\u0342\u03b9", "\u1fbc": "\u03b1\u03b9", "\u1fbe": "\u03b9",
  "\u1fc2": "\u1f74\u03b9", "\u1fc3": "\u03b7\u03b9", "\u1fc4": "\u03ae\u03b9", "\u1fc6": "\u03b7\u0342", "\u1fc7": "\u03b7\u0342\u03b9", "\u1fcc": "\u03b7\u03b9", "\u1fd2": "\u03b9\u0308\u0300", "\u1fd3": "\u03b9\u0308\u0301",
  "\u1fd6": "\u03b9\u0342", "\u1fd7": "\u03b9\u0308\u0342", "\u1fe2": "\u03c5\u0308\u0300", "\u1fe3": "\u03c5\u0308\u0301", "\u1fe4": "\u03c1\u0313", "\u1fe6": "\u03c5\u0342", "\u1fe7": "\u03c5\u0308\u0342", "\u1ff2": "\u1f7c\u03b9",
  "\u1ff3": "\u03c9\u03b9", "\u1ff4": "\u03ce\u03b9", "\u1ff6": "\u03c9\u0342", "\u1ff7": "\u03c9\u0342\u03b9", "\u1ffc": "\u03c9\u03b9", "\uab70": "\u13a0", "\uab71": "\u13a1", "\uab72": "\u13a2",
  "\uab73": "\u13a3", "\uab74": "\u13a4", "\uab75": "\u13a5", "\uab76": "\u13a6", "\uab77": "\u13a7", "\uab78": "\u13a8", "\uab79": "\u13a9", "\uab7a": "\u13aa",
  "\uab7b": "\u13ab", "\uab7c": "\u13ac", "\uab7d": "\u13ad", "\uab7e": "\u13ae", "\uab7f": "\u13af", "\uab80": "\u13b0", "\uab81": "\u13b1", "\uab82": "\u13b2",
  "\uab83": "\u13b3", "\uab84": "\u13b4", "\uab85": "\u13b5", "\uab86": "\u13b6", "\uab87": "\u13b7", "\uab88": "\u13b8", "\uab89": "\u13b9", "\uab8a": "\u13ba",
  "\uab8b": "\u13bb", "\uab8c": "\u13bc", "\uab8d": "\u13bd", "\uab8e": "\u13be", "\uab8f": "\u13bf", "\uab90": "\u13c0", "\uab91": "\u13c1", "\uab92": "\u13c2",
  "\uab93": "\u13c3", "\uab94": "\u13c4", "\uab95": "\u13c5", "\uab96": "\u13c6", "\uab97": "\u13c7", "\uab98": "\u13c8", "\uab99": "\u13c9", "\uab9a": "\u13ca",
  "\uab9b": "\u13cb", "\uab9c": "\u13cc", "\uab9d": "\u13cd", "\uab9e": "\u13ce", "\uab9f": "\u13cf", "\uaba0": "\u13d0", "\uaba1": "\u13d1", "\uaba2": "\u13d2",
  "\uaba3": "\u13d3", "\uaba4": "\u13d4", "\uaba5": "\u13d5", "\uaba6": "\u13d6", "\uaba7": "\u13d7", "\uaba8": "\u13d8", "\uaba9": "\u13d9", "\uabaa": "\u13da",
  "\uabab": "\u13db", "\uabac": "\u13dc", "\uabad": "\u13dd", "\uabae": "\u13de", "\uabaf": "\u13df", "\uabb0": "\u13e0", "\uabb1": "\u13e1", "\uabb2": "\u13e2",
  "\uabb3": "\u13e3", "\uabb4": "\u13e4", "\uabb5": "\u13e5", "\uabb6": "\u13e6", "\uabb7": "\u13e7", "\uabb8": "\u13e8", "\uabb9": "\u13e9", "\uabba": "\u13ea",
  "\uabbb": "\u13eb", "\uabbc": "\u13ec", "\uabbd": "\u13ed", "\uabbe": "\u13ee", "\uabbf": "\u13ef", "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
  "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st", "\ufb13": "\u0574\u0576", "\ufb14": "\u0574\u0565", "\ufb15": "\u0574\u056b", "\ufb16": "\u057e\u0576",
  "\ufb17": "\u0574\u056d",
});

function caseFoldLabel(label) {
  return Array.from(label, (character) => unicodeCaseFold[character] ?? character.toLowerCase()).join("");
}

function visibleFootnoteBodies(text) {
  const key = caseFoldLabel;
  const definitions = [...text.matchAll(/^ {0,3}\[\^([^\[\]\x00-\x20]+)\]:[^\n]*(?:\n(?: {2,}|\t)[^\n]*)*/gm)];
  const references = (content) => {
    const visible = visibleMarkdownLinkLabels(content, false);
    return [...visible.matchAll(/\[\^([^\[\]\x00-\x20]+)\]/g)]
      .filter((match) => !isEscapedMarkdownStart(visible, match.index)).map((match) => key(match[1]));
  };
  let usage = text;
  for (const definition of [...definitions].reverse()) usage = usage.slice(0, definition.index) + "\n" + usage.slice(definition.index + definition[0].length);
  const used = new Set(references(usage));
  for (const label of used) {
    const definition = definitions.find((entry) => key(entry[1]) === label);
    if (definition) for (const reference of references(definition[0].replace(/^ {0,3}\[\^[^\]\n]+\]:/, ""))) used.add(reference);
  }
  for (const definition of [...definitions].reverse()) {
    const replacement = used.has(key(definition[1])) ? definition[0].replace(/^ {0,3}\[\^[^\]\n]+\]:/, "") : definition[0].replace(/[^\n]/g, "");
    text = text.slice(0, definition.index) + replacement + text.slice(definition.index + definition[0].length);
  }
  return text;
}

function visibleMarkdownLinkLabels(text, projectFootnotes = true) {
  text = text.replace(/\r\n?/g, "\n");
  if (!text.includes("]")) return text;
  if (projectFootnotes) text = visibleFootnoteBodies(text);
  let result = "";
  let consumed = 0;
  for (const match of (text.includes("](") ? text.matchAll(/\[((?:\\.|[^\]\\])*)\]\(/g) : [])) {
    if (match.index < consumed || isEscapedMarkdownStart(text, match.index) || !isVisibleLinkLabel(match[1])) continue;
    let depth = 1;
    let cursor = match.index + match[0].length;
    for (; cursor < text.length && depth; cursor += 1) {
      if (text[cursor] === "\\") { cursor += 1; continue; }
      if (text[cursor] === "(") depth += 1;
      else if (text[cursor] === ")") depth -= 1;
    }
    const destination = text.slice(match.index + match[0].length, cursor - 1);
    if (depth || !isVisibleLinkDestination(destination)) continue;
    result += text.slice(consumed, match.index) + match[1];
    consumed = cursor;
  }
  const definitions = new Set();
  const definitionBodies = new Set();
  const definitionPattern = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:[ \t\f\v]*(?:\r?\n[ \t\f\v]*)?([^\r\n]+)(?:\r?\n[ \t\f\v]*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))))?[ \t\f\v]*$/gm;
  for (const entry of text.matchAll(definitionPattern)) {
    const destination = entry[2] + (entry[3] ? " " + entry[3] : "");
    if (isVisibleLinkLabel(entry[1], true) && isVisibleLinkDestination(destination, false)) {
      definitions.add(caseFoldLabel(entry[1].trim().replace(/\s+/g, " ")));
      definitionBodies.add(entry[0]);
    }
  }
  const projected = (result + text.slice(consumed)).replace(definitionPattern, (source) => definitionBodies.has(source) ? "" : source);
  if (definitions.size === 0) return projected;
  const references = projected.replace(/\[([^\]]*)\]\[([^\]]*)\]/g, (source, label, reference, offset, whole) => !isEscapedMarkdownStart(whole, offset) && isVisibleLinkLabel(label) && isVisibleLinkLabel(reference || label, true) && definitions.has(caseFoldLabel((reference || label).trim().replace(/\s+/g, " "))) ? label : source);
  return references.replace(/\[([^\]]+)\](?![\[(])/g, (source, label, offset, whole) => !isEscapedMarkdownStart(whole, offset) && isVisibleLinkLabel(label, true) && definitions.has(caseFoldLabel(label.trim().replace(/\s+/g, " "))) ? label : source);
}

function htmlCommentEnd(source, start) {
  if (source.startsWith("<!-->", start)) return start + 5;
  if (source.startsWith("<!--->", start)) return start + 6;
  const close = /--!?>/g;
  close.lastIndex = start + 4;
  const match = close.exec(source);
  return match ? match.index + match[0].length : null;
}

function withoutHtmlComments(source) {
  let result = "", cursor = 0, start;
  while ((start = source.indexOf("<!--", cursor)) >= 0) {
    const end = htmlCommentEnd(source, start) ?? source.length;
    result += source.slice(cursor, start) + source.slice(start, end).replace(/[^\r\n]/g, "");
    cursor = end;
  }
  return result + source.slice(cursor);
}

// HTML5 legacy named references: Python html.entities.html5 keys without semicolons.
const LEGACY_HTML_NAMES = Object.freeze({
  "Aacute": "\u00c1", "aacute": "\u00e1", "Acirc": "\u00c2", "acirc": "\u00e2", "acute": "\u00b4", "AElig": "\u00c6", "aelig": "\u00e6", "Agrave": "\u00c0",
  "agrave": "\u00e0", "AMP": "&", "amp": "&", "Aring": "\u00c5", "aring": "\u00e5", "Atilde": "\u00c3", "atilde": "\u00e3", "Auml": "\u00c4",
  "auml": "\u00e4", "brvbar": "\u00a6", "Ccedil": "\u00c7", "ccedil": "\u00e7", "cedil": "\u00b8", "cent": "\u00a2", "COPY": "\u00a9", "copy": "\u00a9",
  "curren": "\u00a4", "deg": "\u00b0", "divide": "\u00f7", "Eacute": "\u00c9", "eacute": "\u00e9", "Ecirc": "\u00ca", "ecirc": "\u00ea", "Egrave": "\u00c8",
  "egrave": "\u00e8", "ETH": "\u00d0", "eth": "\u00f0", "Euml": "\u00cb", "euml": "\u00eb", "frac12": "\u00bd", "frac14": "\u00bc", "frac34": "\u00be",
  "GT": ">", "gt": ">", "Iacute": "\u00cd", "iacute": "\u00ed", "Icirc": "\u00ce", "icirc": "\u00ee", "iexcl": "\u00a1", "Igrave": "\u00cc",
  "igrave": "\u00ec", "iquest": "\u00bf", "Iuml": "\u00cf", "iuml": "\u00ef", "laquo": "\u00ab", "LT": "<", "lt": "<", "macr": "\u00af",
  "micro": "\u00b5", "middot": "\u00b7", "nbsp": "\u00a0", "not": "\u00ac", "Ntilde": "\u00d1", "ntilde": "\u00f1", "Oacute": "\u00d3", "oacute": "\u00f3",
  "Ocirc": "\u00d4", "ocirc": "\u00f4", "Ograve": "\u00d2", "ograve": "\u00f2", "ordf": "\u00aa", "ordm": "\u00ba", "Oslash": "\u00d8", "oslash": "\u00f8",
  "Otilde": "\u00d5", "otilde": "\u00f5", "Ouml": "\u00d6", "ouml": "\u00f6", "para": "\u00b6", "plusmn": "\u00b1", "pound": "\u00a3", "QUOT": "\"",
  "quot": "\"", "raquo": "\u00bb", "REG": "\u00ae", "reg": "\u00ae", "sect": "\u00a7", "shy": "\u00ad", "sup1": "\u00b9", "sup2": "\u00b2",
  "sup3": "\u00b3", "szlig": "\u00df", "THORN": "\u00de", "thorn": "\u00fe", "times": "\u00d7", "Uacute": "\u00da", "uacute": "\u00fa", "Ucirc": "\u00db",
  "ucirc": "\u00fb", "Ugrave": "\u00d9", "ugrave": "\u00f9", "uml": "\u00a8", "Uuml": "\u00dc", "uuml": "\u00fc", "Yacute": "\u00dd", "yacute": "\u00fd",
  "yen": "\u00a5", "yuml": "\u00ff",
});
// HTML5 named values: https://html.spec.whatwg.org/entities.json; exact Python html.entities.html5 match verified 2026-10-22.
// Generated from its 2125 semicolon-terminated names; 106 legacy names remain raw-HTML-context-only.
// Values are decoded only after raw structure parsing; literal code remains protected.
const HTML_NAMED_ENTITIES = Object.freeze({
  "AElig": "\u00c6", "AMP": "&", "Aacute": "\u00c1", "Abreve": "\u0102", "Acirc": "\u00c2", "Acy": "\u0410",
  "Afr": "\ud835\udd04", "Agrave": "\u00c0", "Alpha": "\u0391", "Amacr": "\u0100", "And": "\u2a53", "Aogon": "\u0104",
  "Aopf": "\ud835\udd38", "ApplyFunction": "\u2061", "Aring": "\u00c5", "Ascr": "\ud835\udc9c", "Assign": "\u2254", "Atilde": "\u00c3",
  "Auml": "\u00c4", "Backslash": "\u2216", "Barv": "\u2ae7", "Barwed": "\u2306", "Bcy": "\u0411", "Because": "\u2235",
  "Bernoullis": "\u212c", "Beta": "\u0392", "Bfr": "\ud835\udd05", "Bopf": "\ud835\udd39", "Breve": "\u02d8", "Bscr": "\u212c",
  "Bumpeq": "\u224e", "CHcy": "\u0427", "COPY": "\u00a9", "Cacute": "\u0106", "Cap": "\u22d2", "CapitalDifferentialD": "\u2145",
  "Cayleys": "\u212d", "Ccaron": "\u010c", "Ccedil": "\u00c7", "Ccirc": "\u0108", "Cconint": "\u2230", "Cdot": "\u010a",
  "Cedilla": "\u00b8", "CenterDot": "\u00b7", "Cfr": "\u212d", "Chi": "\u03a7", "CircleDot": "\u2299", "CircleMinus": "\u2296",
  "CirclePlus": "\u2295", "CircleTimes": "\u2297", "ClockwiseContourIntegral": "\u2232", "CloseCurlyDoubleQuote": "\u201d", "CloseCurlyQuote": "\u2019", "Colon": "\u2237",
  "Colone": "\u2a74", "Congruent": "\u2261", "Conint": "\u222f", "ContourIntegral": "\u222e", "Copf": "\u2102", "Coproduct": "\u2210",
  "CounterClockwiseContourIntegral": "\u2233", "Cross": "\u2a2f", "Cscr": "\ud835\udc9e", "Cup": "\u22d3", "CupCap": "\u224d", "DD": "\u2145",
  "DDotrahd": "\u2911", "DJcy": "\u0402", "DScy": "\u0405", "DZcy": "\u040f", "Dagger": "\u2021", "Darr": "\u21a1",
  "Dashv": "\u2ae4", "Dcaron": "\u010e", "Dcy": "\u0414", "Del": "\u2207", "Delta": "\u0394", "Dfr": "\ud835\udd07",
  "DiacriticalAcute": "\u00b4", "DiacriticalDot": "\u02d9", "DiacriticalDoubleAcute": "\u02dd", "DiacriticalGrave": "`", "DiacriticalTilde": "\u02dc", "Diamond": "\u22c4",
  "DifferentialD": "\u2146", "Dopf": "\ud835\udd3b", "Dot": "\u00a8", "DotDot": "\u20dc", "DotEqual": "\u2250", "DoubleContourIntegral": "\u222f",
  "DoubleDot": "\u00a8", "DoubleDownArrow": "\u21d3", "DoubleLeftArrow": "\u21d0", "DoubleLeftRightArrow": "\u21d4", "DoubleLeftTee": "\u2ae4", "DoubleLongLeftArrow": "\u27f8",
  "DoubleLongLeftRightArrow": "\u27fa", "DoubleLongRightArrow": "\u27f9", "DoubleRightArrow": "\u21d2", "DoubleRightTee": "\u22a8", "DoubleUpArrow": "\u21d1", "DoubleUpDownArrow": "\u21d5",
  "DoubleVerticalBar": "\u2225", "DownArrow": "\u2193", "DownArrowBar": "\u2913", "DownArrowUpArrow": "\u21f5", "DownBreve": "\u0311", "DownLeftRightVector": "\u2950",
  "DownLeftTeeVector": "\u295e", "DownLeftVector": "\u21bd", "DownLeftVectorBar": "\u2956", "DownRightTeeVector": "\u295f", "DownRightVector": "\u21c1", "DownRightVectorBar": "\u2957",
  "DownTee": "\u22a4", "DownTeeArrow": "\u21a7", "Downarrow": "\u21d3", "Dscr": "\ud835\udc9f", "Dstrok": "\u0110", "ENG": "\u014a",
  "ETH": "\u00d0", "Eacute": "\u00c9", "Ecaron": "\u011a", "Ecirc": "\u00ca", "Ecy": "\u042d", "Edot": "\u0116",
  "Efr": "\ud835\udd08", "Egrave": "\u00c8", "Element": "\u2208", "Emacr": "\u0112", "EmptySmallSquare": "\u25fb", "EmptyVerySmallSquare": "\u25ab",
  "Eogon": "\u0118", "Eopf": "\ud835\udd3c", "Epsilon": "\u0395", "Equal": "\u2a75", "EqualTilde": "\u2242", "Equilibrium": "\u21cc",
  "Escr": "\u2130", "Esim": "\u2a73", "Eta": "\u0397", "Euml": "\u00cb", "Exists": "\u2203", "ExponentialE": "\u2147",
  "Fcy": "\u0424", "Ffr": "\ud835\udd09", "FilledSmallSquare": "\u25fc", "FilledVerySmallSquare": "\u25aa", "Fopf": "\ud835\udd3d", "ForAll": "\u2200",
  "Fouriertrf": "\u2131", "Fscr": "\u2131", "GJcy": "\u0403", "GT": ">", "Gamma": "\u0393", "Gammad": "\u03dc",
  "Gbreve": "\u011e", "Gcedil": "\u0122", "Gcirc": "\u011c", "Gcy": "\u0413", "Gdot": "\u0120", "Gfr": "\ud835\udd0a",
  "Gg": "\u22d9", "Gopf": "\ud835\udd3e", "GreaterEqual": "\u2265", "GreaterEqualLess": "\u22db", "GreaterFullEqual": "\u2267", "GreaterGreater": "\u2aa2",
  "GreaterLess": "\u2277", "GreaterSlantEqual": "\u2a7e", "GreaterTilde": "\u2273", "Gscr": "\ud835\udca2", "Gt": "\u226b", "HARDcy": "\u042a",
  "Hacek": "\u02c7", "Hat": "^", "Hcirc": "\u0124", "Hfr": "\u210c", "HilbertSpace": "\u210b", "Hopf": "\u210d",
  "HorizontalLine": "\u2500", "Hscr": "\u210b", "Hstrok": "\u0126", "HumpDownHump": "\u224e", "HumpEqual": "\u224f", "IEcy": "\u0415",
  "IJlig": "\u0132", "IOcy": "\u0401", "Iacute": "\u00cd", "Icirc": "\u00ce", "Icy": "\u0418", "Idot": "\u0130",
  "Ifr": "\u2111", "Igrave": "\u00cc", "Im": "\u2111", "Imacr": "\u012a", "ImaginaryI": "\u2148", "Implies": "\u21d2",
  "Int": "\u222c", "Integral": "\u222b", "Intersection": "\u22c2", "InvisibleComma": "\u2063", "InvisibleTimes": "\u2062", "Iogon": "\u012e",
  "Iopf": "\ud835\udd40", "Iota": "\u0399", "Iscr": "\u2110", "Itilde": "\u0128", "Iukcy": "\u0406", "Iuml": "\u00cf",
  "Jcirc": "\u0134", "Jcy": "\u0419", "Jfr": "\ud835\udd0d", "Jopf": "\ud835\udd41", "Jscr": "\ud835\udca5", "Jsercy": "\u0408",
  "Jukcy": "\u0404", "KHcy": "\u0425", "KJcy": "\u040c", "Kappa": "\u039a", "Kcedil": "\u0136", "Kcy": "\u041a",
  "Kfr": "\ud835\udd0e", "Kopf": "\ud835\udd42", "Kscr": "\ud835\udca6", "LJcy": "\u0409", "LT": "<", "Lacute": "\u0139",
  "Lambda": "\u039b", "Lang": "\u27ea", "Laplacetrf": "\u2112", "Larr": "\u219e", "Lcaron": "\u013d", "Lcedil": "\u013b",
  "Lcy": "\u041b", "LeftAngleBracket": "\u27e8", "LeftArrow": "\u2190", "LeftArrowBar": "\u21e4", "LeftArrowRightArrow": "\u21c6", "LeftCeiling": "\u2308",
  "LeftDoubleBracket": "\u27e6", "LeftDownTeeVector": "\u2961", "LeftDownVector": "\u21c3", "LeftDownVectorBar": "\u2959", "LeftFloor": "\u230a", "LeftRightArrow": "\u2194",
  "LeftRightVector": "\u294e", "LeftTee": "\u22a3", "LeftTeeArrow": "\u21a4", "LeftTeeVector": "\u295a", "LeftTriangle": "\u22b2", "LeftTriangleBar": "\u29cf",
  "LeftTriangleEqual": "\u22b4", "LeftUpDownVector": "\u2951", "LeftUpTeeVector": "\u2960", "LeftUpVector": "\u21bf", "LeftUpVectorBar": "\u2958", "LeftVector": "\u21bc",
  "LeftVectorBar": "\u2952", "Leftarrow": "\u21d0", "Leftrightarrow": "\u21d4", "LessEqualGreater": "\u22da", "LessFullEqual": "\u2266", "LessGreater": "\u2276",
  "LessLess": "\u2aa1", "LessSlantEqual": "\u2a7d", "LessTilde": "\u2272", "Lfr": "\ud835\udd0f", "Ll": "\u22d8", "Lleftarrow": "\u21da",
  "Lmidot": "\u013f", "LongLeftArrow": "\u27f5", "LongLeftRightArrow": "\u27f7", "LongRightArrow": "\u27f6", "Longleftarrow": "\u27f8", "Longleftrightarrow": "\u27fa",
  "Longrightarrow": "\u27f9", "Lopf": "\ud835\udd43", "LowerLeftArrow": "\u2199", "LowerRightArrow": "\u2198", "Lscr": "\u2112", "Lsh": "\u21b0",
  "Lstrok": "\u0141", "Lt": "\u226a", "Map": "\u2905", "Mcy": "\u041c", "MediumSpace": "\u205f", "Mellintrf": "\u2133",
  "Mfr": "\ud835\udd10", "MinusPlus": "\u2213", "Mopf": "\ud835\udd44", "Mscr": "\u2133", "Mu": "\u039c", "NJcy": "\u040a",
  "Nacute": "\u0143", "Ncaron": "\u0147", "Ncedil": "\u0145", "Ncy": "\u041d", "NegativeMediumSpace": "\u200b", "NegativeThickSpace": "\u200b",
  "NegativeThinSpace": "\u200b", "NegativeVeryThinSpace": "\u200b", "NestedGreaterGreater": "\u226b", "NestedLessLess": "\u226a", "NewLine": "\n", "Nfr": "\ud835\udd11",
  "NoBreak": "\u2060", "NonBreakingSpace": "\u00a0", "Nopf": "\u2115", "Not": "\u2aec", "NotCongruent": "\u2262", "NotCupCap": "\u226d",
  "NotDoubleVerticalBar": "\u2226", "NotElement": "\u2209", "NotEqual": "\u2260", "NotEqualTilde": "\u2242\u0338", "NotExists": "\u2204", "NotGreater": "\u226f",
  "NotGreaterEqual": "\u2271", "NotGreaterFullEqual": "\u2267\u0338", "NotGreaterGreater": "\u226b\u0338", "NotGreaterLess": "\u2279", "NotGreaterSlantEqual": "\u2a7e\u0338", "NotGreaterTilde": "\u2275",
  "NotHumpDownHump": "\u224e\u0338", "NotHumpEqual": "\u224f\u0338", "NotLeftTriangle": "\u22ea", "NotLeftTriangleBar": "\u29cf\u0338", "NotLeftTriangleEqual": "\u22ec", "NotLess": "\u226e",
  "NotLessEqual": "\u2270", "NotLessGreater": "\u2278", "NotLessLess": "\u226a\u0338", "NotLessSlantEqual": "\u2a7d\u0338", "NotLessTilde": "\u2274", "NotNestedGreaterGreater": "\u2aa2\u0338",
  "NotNestedLessLess": "\u2aa1\u0338", "NotPrecedes": "\u2280", "NotPrecedesEqual": "\u2aaf\u0338", "NotPrecedesSlantEqual": "\u22e0", "NotReverseElement": "\u220c", "NotRightTriangle": "\u22eb",
  "NotRightTriangleBar": "\u29d0\u0338", "NotRightTriangleEqual": "\u22ed", "NotSquareSubset": "\u228f\u0338", "NotSquareSubsetEqual": "\u22e2", "NotSquareSuperset": "\u2290\u0338", "NotSquareSupersetEqual": "\u22e3",
  "NotSubset": "\u2282\u20d2", "NotSubsetEqual": "\u2288", "NotSucceeds": "\u2281", "NotSucceedsEqual": "\u2ab0\u0338", "NotSucceedsSlantEqual": "\u22e1", "NotSucceedsTilde": "\u227f\u0338",
  "NotSuperset": "\u2283\u20d2", "NotSupersetEqual": "\u2289", "NotTilde": "\u2241", "NotTildeEqual": "\u2244", "NotTildeFullEqual": "\u2247", "NotTildeTilde": "\u2249",
  "NotVerticalBar": "\u2224", "Nscr": "\ud835\udca9", "Ntilde": "\u00d1", "Nu": "\u039d", "OElig": "\u0152", "Oacute": "\u00d3",
  "Ocirc": "\u00d4", "Ocy": "\u041e", "Odblac": "\u0150", "Ofr": "\ud835\udd12", "Ograve": "\u00d2", "Omacr": "\u014c",
  "Omega": "\u03a9", "Omicron": "\u039f", "Oopf": "\ud835\udd46", "OpenCurlyDoubleQuote": "\u201c", "OpenCurlyQuote": "\u2018", "Or": "\u2a54",
  "Oscr": "\ud835\udcaa", "Oslash": "\u00d8", "Otilde": "\u00d5", "Otimes": "\u2a37", "Ouml": "\u00d6", "OverBar": "\u203e",
  "OverBrace": "\u23de", "OverBracket": "\u23b4", "OverParenthesis": "\u23dc", "PartialD": "\u2202", "Pcy": "\u041f", "Pfr": "\ud835\udd13",
  "Phi": "\u03a6", "Pi": "\u03a0", "PlusMinus": "\u00b1", "Poincareplane": "\u210c", "Popf": "\u2119", "Pr": "\u2abb",
  "Precedes": "\u227a", "PrecedesEqual": "\u2aaf", "PrecedesSlantEqual": "\u227c", "PrecedesTilde": "\u227e", "Prime": "\u2033", "Product": "\u220f",
  "Proportion": "\u2237", "Proportional": "\u221d", "Pscr": "\ud835\udcab", "Psi": "\u03a8", "QUOT": "\"", "Qfr": "\ud835\udd14",
  "Qopf": "\u211a", "Qscr": "\ud835\udcac", "RBarr": "\u2910", "REG": "\u00ae", "Racute": "\u0154", "Rang": "\u27eb",
  "Rarr": "\u21a0", "Rarrtl": "\u2916", "Rcaron": "\u0158", "Rcedil": "\u0156", "Rcy": "\u0420", "Re": "\u211c",
  "ReverseElement": "\u220b", "ReverseEquilibrium": "\u21cb", "ReverseUpEquilibrium": "\u296f", "Rfr": "\u211c", "Rho": "\u03a1", "RightAngleBracket": "\u27e9",
  "RightArrow": "\u2192", "RightArrowBar": "\u21e5", "RightArrowLeftArrow": "\u21c4", "RightCeiling": "\u2309", "RightDoubleBracket": "\u27e7", "RightDownTeeVector": "\u295d",
  "RightDownVector": "\u21c2", "RightDownVectorBar": "\u2955", "RightFloor": "\u230b", "RightTee": "\u22a2", "RightTeeArrow": "\u21a6", "RightTeeVector": "\u295b",
  "RightTriangle": "\u22b3", "RightTriangleBar": "\u29d0", "RightTriangleEqual": "\u22b5", "RightUpDownVector": "\u294f", "RightUpTeeVector": "\u295c", "RightUpVector": "\u21be",
  "RightUpVectorBar": "\u2954", "RightVector": "\u21c0", "RightVectorBar": "\u2953", "Rightarrow": "\u21d2", "Ropf": "\u211d", "RoundImplies": "\u2970",
  "Rrightarrow": "\u21db", "Rscr": "\u211b", "Rsh": "\u21b1", "RuleDelayed": "\u29f4", "SHCHcy": "\u0429", "SHcy": "\u0428",
  "SOFTcy": "\u042c", "Sacute": "\u015a", "Sc": "\u2abc", "Scaron": "\u0160", "Scedil": "\u015e", "Scirc": "\u015c",
  "Scy": "\u0421", "Sfr": "\ud835\udd16", "ShortDownArrow": "\u2193", "ShortLeftArrow": "\u2190", "ShortRightArrow": "\u2192", "ShortUpArrow": "\u2191",
  "Sigma": "\u03a3", "SmallCircle": "\u2218", "Sopf": "\ud835\udd4a", "Sqrt": "\u221a", "Square": "\u25a1", "SquareIntersection": "\u2293",
  "SquareSubset": "\u228f", "SquareSubsetEqual": "\u2291", "SquareSuperset": "\u2290", "SquareSupersetEqual": "\u2292", "SquareUnion": "\u2294", "Sscr": "\ud835\udcae",
  "Star": "\u22c6", "Sub": "\u22d0", "Subset": "\u22d0", "SubsetEqual": "\u2286", "Succeeds": "\u227b", "SucceedsEqual": "\u2ab0",
  "SucceedsSlantEqual": "\u227d", "SucceedsTilde": "\u227f", "SuchThat": "\u220b", "Sum": "\u2211", "Sup": "\u22d1", "Superset": "\u2283",
  "SupersetEqual": "\u2287", "Supset": "\u22d1", "THORN": "\u00de", "TRADE": "\u2122", "TSHcy": "\u040b", "TScy": "\u0426",
  "Tab": "\t", "Tau": "\u03a4", "Tcaron": "\u0164", "Tcedil": "\u0162", "Tcy": "\u0422", "Tfr": "\ud835\udd17",
  "Therefore": "\u2234", "Theta": "\u0398", "ThickSpace": "\u205f\u200a", "ThinSpace": "\u2009", "Tilde": "\u223c", "TildeEqual": "\u2243",
  "TildeFullEqual": "\u2245", "TildeTilde": "\u2248", "Topf": "\ud835\udd4b", "TripleDot": "\u20db", "Tscr": "\ud835\udcaf", "Tstrok": "\u0166",
  "Uacute": "\u00da", "Uarr": "\u219f", "Uarrocir": "\u2949", "Ubrcy": "\u040e", "Ubreve": "\u016c", "Ucirc": "\u00db",
  "Ucy": "\u0423", "Udblac": "\u0170", "Ufr": "\ud835\udd18", "Ugrave": "\u00d9", "Umacr": "\u016a", "UnderBar": "_",
  "UnderBrace": "\u23df", "UnderBracket": "\u23b5", "UnderParenthesis": "\u23dd", "Union": "\u22c3", "UnionPlus": "\u228e", "Uogon": "\u0172",
  "Uopf": "\ud835\udd4c", "UpArrow": "\u2191", "UpArrowBar": "\u2912", "UpArrowDownArrow": "\u21c5", "UpDownArrow": "\u2195", "UpEquilibrium": "\u296e",
  "UpTee": "\u22a5", "UpTeeArrow": "\u21a5", "Uparrow": "\u21d1", "Updownarrow": "\u21d5", "UpperLeftArrow": "\u2196", "UpperRightArrow": "\u2197",
  "Upsi": "\u03d2", "Upsilon": "\u03a5", "Uring": "\u016e", "Uscr": "\ud835\udcb0", "Utilde": "\u0168", "Uuml": "\u00dc",
  "VDash": "\u22ab", "Vbar": "\u2aeb", "Vcy": "\u0412", "Vdash": "\u22a9", "Vdashl": "\u2ae6", "Vee": "\u22c1",
  "Verbar": "\u2016", "Vert": "\u2016", "VerticalBar": "\u2223", "VerticalLine": "|", "VerticalSeparator": "\u2758", "VerticalTilde": "\u2240",
  "VeryThinSpace": "\u200a", "Vfr": "\ud835\udd19", "Vopf": "\ud835\udd4d", "Vscr": "\ud835\udcb1", "Vvdash": "\u22aa", "Wcirc": "\u0174",
  "Wedge": "\u22c0", "Wfr": "\ud835\udd1a", "Wopf": "\ud835\udd4e", "Wscr": "\ud835\udcb2", "Xfr": "\ud835\udd1b", "Xi": "\u039e",
  "Xopf": "\ud835\udd4f", "Xscr": "\ud835\udcb3", "YAcy": "\u042f", "YIcy": "\u0407", "YUcy": "\u042e", "Yacute": "\u00dd",
  "Ycirc": "\u0176", "Ycy": "\u042b", "Yfr": "\ud835\udd1c", "Yopf": "\ud835\udd50", "Yscr": "\ud835\udcb4", "Yuml": "\u0178",
  "ZHcy": "\u0416", "Zacute": "\u0179", "Zcaron": "\u017d", "Zcy": "\u0417", "Zdot": "\u017b", "ZeroWidthSpace": "\u200b",
  "Zeta": "\u0396", "Zfr": "\u2128", "Zopf": "\u2124", "Zscr": "\ud835\udcb5", "aacute": "\u00e1", "abreve": "\u0103",
  "ac": "\u223e", "acE": "\u223e\u0333", "acd": "\u223f", "acirc": "\u00e2", "acute": "\u00b4", "acy": "\u0430",
  "aelig": "\u00e6", "af": "\u2061", "afr": "\ud835\udd1e", "agrave": "\u00e0", "alefsym": "\u2135", "aleph": "\u2135",
  "alpha": "\u03b1", "amacr": "\u0101", "amalg": "\u2a3f", "amp": "&", "and": "\u2227", "andand": "\u2a55",
  "andd": "\u2a5c", "andslope": "\u2a58", "andv": "\u2a5a", "ang": "\u2220", "ange": "\u29a4", "angle": "\u2220",
  "angmsd": "\u2221", "angmsdaa": "\u29a8", "angmsdab": "\u29a9", "angmsdac": "\u29aa", "angmsdad": "\u29ab", "angmsdae": "\u29ac",
  "angmsdaf": "\u29ad", "angmsdag": "\u29ae", "angmsdah": "\u29af", "angrt": "\u221f", "angrtvb": "\u22be", "angrtvbd": "\u299d",
  "angsph": "\u2222", "angst": "\u00c5", "angzarr": "\u237c", "aogon": "\u0105", "aopf": "\ud835\udd52", "ap": "\u2248",
  "apE": "\u2a70", "apacir": "\u2a6f", "ape": "\u224a", "apid": "\u224b", "apos": "'", "approx": "\u2248",
  "approxeq": "\u224a", "aring": "\u00e5", "ascr": "\ud835\udcb6", "ast": "*", "asymp": "\u2248", "asympeq": "\u224d",
  "atilde": "\u00e3", "auml": "\u00e4", "awconint": "\u2233", "awint": "\u2a11", "bNot": "\u2aed", "backcong": "\u224c",
  "backepsilon": "\u03f6", "backprime": "\u2035", "backsim": "\u223d", "backsimeq": "\u22cd", "barvee": "\u22bd", "barwed": "\u2305",
  "barwedge": "\u2305", "bbrk": "\u23b5", "bbrktbrk": "\u23b6", "bcong": "\u224c", "bcy": "\u0431", "bdquo": "\u201e",
  "becaus": "\u2235", "because": "\u2235", "bemptyv": "\u29b0", "bepsi": "\u03f6", "bernou": "\u212c", "beta": "\u03b2",
  "beth": "\u2136", "between": "\u226c", "bfr": "\ud835\udd1f", "bigcap": "\u22c2", "bigcirc": "\u25ef", "bigcup": "\u22c3",
  "bigodot": "\u2a00", "bigoplus": "\u2a01", "bigotimes": "\u2a02", "bigsqcup": "\u2a06", "bigstar": "\u2605", "bigtriangledown": "\u25bd",
  "bigtriangleup": "\u25b3", "biguplus": "\u2a04", "bigvee": "\u22c1", "bigwedge": "\u22c0", "bkarow": "\u290d", "blacklozenge": "\u29eb",
  "blacksquare": "\u25aa", "blacktriangle": "\u25b4", "blacktriangledown": "\u25be", "blacktriangleleft": "\u25c2", "blacktriangleright": "\u25b8", "blank": "\u2423",
  "blk12": "\u2592", "blk14": "\u2591", "blk34": "\u2593", "block": "\u2588", "bne": "=\u20e5", "bnequiv": "\u2261\u20e5",
  "bnot": "\u2310", "bopf": "\ud835\udd53", "bot": "\u22a5", "bottom": "\u22a5", "bowtie": "\u22c8", "boxDL": "\u2557",
  "boxDR": "\u2554", "boxDl": "\u2556", "boxDr": "\u2553", "boxH": "\u2550", "boxHD": "\u2566", "boxHU": "\u2569",
  "boxHd": "\u2564", "boxHu": "\u2567", "boxUL": "\u255d", "boxUR": "\u255a", "boxUl": "\u255c", "boxUr": "\u2559",
  "boxV": "\u2551", "boxVH": "\u256c", "boxVL": "\u2563", "boxVR": "\u2560", "boxVh": "\u256b", "boxVl": "\u2562",
  "boxVr": "\u255f", "boxbox": "\u29c9", "boxdL": "\u2555", "boxdR": "\u2552", "boxdl": "\u2510", "boxdr": "\u250c",
  "boxh": "\u2500", "boxhD": "\u2565", "boxhU": "\u2568", "boxhd": "\u252c", "boxhu": "\u2534", "boxminus": "\u229f",
  "boxplus": "\u229e", "boxtimes": "\u22a0", "boxuL": "\u255b", "boxuR": "\u2558", "boxul": "\u2518", "boxur": "\u2514",
  "boxv": "\u2502", "boxvH": "\u256a", "boxvL": "\u2561", "boxvR": "\u255e", "boxvh": "\u253c", "boxvl": "\u2524",
  "boxvr": "\u251c", "bprime": "\u2035", "breve": "\u02d8", "brvbar": "\u00a6", "bscr": "\ud835\udcb7", "bsemi": "\u204f",
  "bsim": "\u223d", "bsime": "\u22cd", "bsol": "\\", "bsolb": "\u29c5", "bsolhsub": "\u27c8", "bull": "\u2022",
  "bullet": "\u2022", "bump": "\u224e", "bumpE": "\u2aae", "bumpe": "\u224f", "bumpeq": "\u224f", "cacute": "\u0107",
  "cap": "\u2229", "capand": "\u2a44", "capbrcup": "\u2a49", "capcap": "\u2a4b", "capcup": "\u2a47", "capdot": "\u2a40",
  "caps": "\u2229\ufe00", "caret": "\u2041", "caron": "\u02c7", "ccaps": "\u2a4d", "ccaron": "\u010d", "ccedil": "\u00e7",
  "ccirc": "\u0109", "ccups": "\u2a4c", "ccupssm": "\u2a50", "cdot": "\u010b", "cedil": "\u00b8", "cemptyv": "\u29b2",
  "cent": "\u00a2", "centerdot": "\u00b7", "cfr": "\ud835\udd20", "chcy": "\u0447", "check": "\u2713", "checkmark": "\u2713",
  "chi": "\u03c7", "cir": "\u25cb", "cirE": "\u29c3", "circ": "\u02c6", "circeq": "\u2257", "circlearrowleft": "\u21ba",
  "circlearrowright": "\u21bb", "circledR": "\u00ae", "circledS": "\u24c8", "circledast": "\u229b", "circledcirc": "\u229a", "circleddash": "\u229d",
  "cire": "\u2257", "cirfnint": "\u2a10", "cirmid": "\u2aef", "cirscir": "\u29c2", "clubs": "\u2663", "clubsuit": "\u2663",
  "colon": ":", "colone": "\u2254", "coloneq": "\u2254", "comma": ",", "commat": "@", "comp": "\u2201",
  "compfn": "\u2218", "complement": "\u2201", "complexes": "\u2102", "cong": "\u2245", "congdot": "\u2a6d", "conint": "\u222e",
  "copf": "\ud835\udd54", "coprod": "\u2210", "copy": "\u00a9", "copysr": "\u2117", "crarr": "\u21b5", "cross": "\u2717",
  "cscr": "\ud835\udcb8", "csub": "\u2acf", "csube": "\u2ad1", "csup": "\u2ad0", "csupe": "\u2ad2", "ctdot": "\u22ef",
  "cudarrl": "\u2938", "cudarrr": "\u2935", "cuepr": "\u22de", "cuesc": "\u22df", "cularr": "\u21b6", "cularrp": "\u293d",
  "cup": "\u222a", "cupbrcap": "\u2a48", "cupcap": "\u2a46", "cupcup": "\u2a4a", "cupdot": "\u228d", "cupor": "\u2a45",
  "cups": "\u222a\ufe00", "curarr": "\u21b7", "curarrm": "\u293c", "curlyeqprec": "\u22de", "curlyeqsucc": "\u22df", "curlyvee": "\u22ce",
  "curlywedge": "\u22cf", "curren": "\u00a4", "curvearrowleft": "\u21b6", "curvearrowright": "\u21b7", "cuvee": "\u22ce", "cuwed": "\u22cf",
  "cwconint": "\u2232", "cwint": "\u2231", "cylcty": "\u232d", "dArr": "\u21d3", "dHar": "\u2965", "dagger": "\u2020",
  "daleth": "\u2138", "darr": "\u2193", "dash": "\u2010", "dashv": "\u22a3", "dbkarow": "\u290f", "dblac": "\u02dd",
  "dcaron": "\u010f", "dcy": "\u0434", "dd": "\u2146", "ddagger": "\u2021", "ddarr": "\u21ca", "ddotseq": "\u2a77",
  "deg": "\u00b0", "delta": "\u03b4", "demptyv": "\u29b1", "dfisht": "\u297f", "dfr": "\ud835\udd21", "dharl": "\u21c3",
  "dharr": "\u21c2", "diam": "\u22c4", "diamond": "\u22c4", "diamondsuit": "\u2666", "diams": "\u2666", "die": "\u00a8",
  "digamma": "\u03dd", "disin": "\u22f2", "div": "\u00f7", "divide": "\u00f7", "divideontimes": "\u22c7", "divonx": "\u22c7",
  "djcy": "\u0452", "dlcorn": "\u231e", "dlcrop": "\u230d", "dollar": "$", "dopf": "\ud835\udd55", "dot": "\u02d9",
  "doteq": "\u2250", "doteqdot": "\u2251", "dotminus": "\u2238", "dotplus": "\u2214", "dotsquare": "\u22a1", "doublebarwedge": "\u2306",
  "downarrow": "\u2193", "downdownarrows": "\u21ca", "downharpoonleft": "\u21c3", "downharpoonright": "\u21c2", "drbkarow": "\u2910", "drcorn": "\u231f",
  "drcrop": "\u230c", "dscr": "\ud835\udcb9", "dscy": "\u0455", "dsol": "\u29f6", "dstrok": "\u0111", "dtdot": "\u22f1",
  "dtri": "\u25bf", "dtrif": "\u25be", "duarr": "\u21f5", "duhar": "\u296f", "dwangle": "\u29a6", "dzcy": "\u045f",
  "dzigrarr": "\u27ff", "eDDot": "\u2a77", "eDot": "\u2251", "eacute": "\u00e9", "easter": "\u2a6e", "ecaron": "\u011b",
  "ecir": "\u2256", "ecirc": "\u00ea", "ecolon": "\u2255", "ecy": "\u044d", "edot": "\u0117", "ee": "\u2147",
  "efDot": "\u2252", "efr": "\ud835\udd22", "eg": "\u2a9a", "egrave": "\u00e8", "egs": "\u2a96", "egsdot": "\u2a98",
  "el": "\u2a99", "elinters": "\u23e7", "ell": "\u2113", "els": "\u2a95", "elsdot": "\u2a97", "emacr": "\u0113",
  "empty": "\u2205", "emptyset": "\u2205", "emptyv": "\u2205", "emsp": "\u2003", "emsp13": "\u2004", "emsp14": "\u2005",
  "eng": "\u014b", "ensp": "\u2002", "eogon": "\u0119", "eopf": "\ud835\udd56", "epar": "\u22d5", "eparsl": "\u29e3",
  "eplus": "\u2a71", "epsi": "\u03b5", "epsilon": "\u03b5", "epsiv": "\u03f5", "eqcirc": "\u2256", "eqcolon": "\u2255",
  "eqsim": "\u2242", "eqslantgtr": "\u2a96", "eqslantless": "\u2a95", "equals": "=", "equest": "\u225f", "equiv": "\u2261",
  "equivDD": "\u2a78", "eqvparsl": "\u29e5", "erDot": "\u2253", "erarr": "\u2971", "escr": "\u212f", "esdot": "\u2250",
  "esim": "\u2242", "eta": "\u03b7", "eth": "\u00f0", "euml": "\u00eb", "euro": "\u20ac", "excl": "!",
  "exist": "\u2203", "expectation": "\u2130", "exponentiale": "\u2147", "fallingdotseq": "\u2252", "fcy": "\u0444", "female": "\u2640",
  "ffilig": "\ufb03", "fflig": "\ufb00", "ffllig": "\ufb04", "ffr": "\ud835\udd23", "filig": "\ufb01", "fjlig": "fj",
  "flat": "\u266d", "fllig": "\ufb02", "fltns": "\u25b1", "fnof": "\u0192", "fopf": "\ud835\udd57", "forall": "\u2200",
  "fork": "\u22d4", "forkv": "\u2ad9", "fpartint": "\u2a0d", "frac12": "\u00bd", "frac13": "\u2153", "frac14": "\u00bc",
  "frac15": "\u2155", "frac16": "\u2159", "frac18": "\u215b", "frac23": "\u2154", "frac25": "\u2156", "frac34": "\u00be",
  "frac35": "\u2157", "frac38": "\u215c", "frac45": "\u2158", "frac56": "\u215a", "frac58": "\u215d", "frac78": "\u215e",
  "frasl": "\u2044", "frown": "\u2322", "fscr": "\ud835\udcbb", "gE": "\u2267", "gEl": "\u2a8c", "gacute": "\u01f5",
  "gamma": "\u03b3", "gammad": "\u03dd", "gap": "\u2a86", "gbreve": "\u011f", "gcirc": "\u011d", "gcy": "\u0433",
  "gdot": "\u0121", "ge": "\u2265", "gel": "\u22db", "geq": "\u2265", "geqq": "\u2267", "geqslant": "\u2a7e",
  "ges": "\u2a7e", "gescc": "\u2aa9", "gesdot": "\u2a80", "gesdoto": "\u2a82", "gesdotol": "\u2a84", "gesl": "\u22db\ufe00",
  "gesles": "\u2a94", "gfr": "\ud835\udd24", "gg": "\u226b", "ggg": "\u22d9", "gimel": "\u2137", "gjcy": "\u0453",
  "gl": "\u2277", "glE": "\u2a92", "gla": "\u2aa5", "glj": "\u2aa4", "gnE": "\u2269", "gnap": "\u2a8a",
  "gnapprox": "\u2a8a", "gne": "\u2a88", "gneq": "\u2a88", "gneqq": "\u2269", "gnsim": "\u22e7", "gopf": "\ud835\udd58",
  "grave": "`", "gscr": "\u210a", "gsim": "\u2273", "gsime": "\u2a8e", "gsiml": "\u2a90", "gt": ">",
  "gtcc": "\u2aa7", "gtcir": "\u2a7a", "gtdot": "\u22d7", "gtlPar": "\u2995", "gtquest": "\u2a7c", "gtrapprox": "\u2a86",
  "gtrarr": "\u2978", "gtrdot": "\u22d7", "gtreqless": "\u22db", "gtreqqless": "\u2a8c", "gtrless": "\u2277", "gtrsim": "\u2273",
  "gvertneqq": "\u2269\ufe00", "gvnE": "\u2269\ufe00", "hArr": "\u21d4", "hairsp": "\u200a", "half": "\u00bd", "hamilt": "\u210b",
  "hardcy": "\u044a", "harr": "\u2194", "harrcir": "\u2948", "harrw": "\u21ad", "hbar": "\u210f", "hcirc": "\u0125",
  "hearts": "\u2665", "heartsuit": "\u2665", "hellip": "\u2026", "hercon": "\u22b9", "hfr": "\ud835\udd25", "hksearow": "\u2925",
  "hkswarow": "\u2926", "hoarr": "\u21ff", "homtht": "\u223b", "hookleftarrow": "\u21a9", "hookrightarrow": "\u21aa", "hopf": "\ud835\udd59",
  "horbar": "\u2015", "hscr": "\ud835\udcbd", "hslash": "\u210f", "hstrok": "\u0127", "hybull": "\u2043", "hyphen": "\u2010",
  "iacute": "\u00ed", "ic": "\u2063", "icirc": "\u00ee", "icy": "\u0438", "iecy": "\u0435", "iexcl": "\u00a1",
  "iff": "\u21d4", "ifr": "\ud835\udd26", "igrave": "\u00ec", "ii": "\u2148", "iiiint": "\u2a0c", "iiint": "\u222d",
  "iinfin": "\u29dc", "iiota": "\u2129", "ijlig": "\u0133", "imacr": "\u012b", "image": "\u2111", "imagline": "\u2110",
  "imagpart": "\u2111", "imath": "\u0131", "imof": "\u22b7", "imped": "\u01b5", "in": "\u2208", "incare": "\u2105",
  "infin": "\u221e", "infintie": "\u29dd", "inodot": "\u0131", "int": "\u222b", "intcal": "\u22ba", "integers": "\u2124",
  "intercal": "\u22ba", "intlarhk": "\u2a17", "intprod": "\u2a3c", "iocy": "\u0451", "iogon": "\u012f", "iopf": "\ud835\udd5a",
  "iota": "\u03b9", "iprod": "\u2a3c", "iquest": "\u00bf", "iscr": "\ud835\udcbe", "isin": "\u2208", "isinE": "\u22f9",
  "isindot": "\u22f5", "isins": "\u22f4", "isinsv": "\u22f3", "isinv": "\u2208", "it": "\u2062", "itilde": "\u0129",
  "iukcy": "\u0456", "iuml": "\u00ef", "jcirc": "\u0135", "jcy": "\u0439", "jfr": "\ud835\udd27", "jmath": "\u0237",
  "jopf": "\ud835\udd5b", "jscr": "\ud835\udcbf", "jsercy": "\u0458", "jukcy": "\u0454", "kappa": "\u03ba", "kappav": "\u03f0",
  "kcedil": "\u0137", "kcy": "\u043a", "kfr": "\ud835\udd28", "kgreen": "\u0138", "khcy": "\u0445", "kjcy": "\u045c",
  "kopf": "\ud835\udd5c", "kscr": "\ud835\udcc0", "lAarr": "\u21da", "lArr": "\u21d0", "lAtail": "\u291b", "lBarr": "\u290e",
  "lE": "\u2266", "lEg": "\u2a8b", "lHar": "\u2962", "lacute": "\u013a", "laemptyv": "\u29b4", "lagran": "\u2112",
  "lambda": "\u03bb", "lang": "\u27e8", "langd": "\u2991", "langle": "\u27e8", "lap": "\u2a85", "laquo": "\u00ab",
  "larr": "\u2190", "larrb": "\u21e4", "larrbfs": "\u291f", "larrfs": "\u291d", "larrhk": "\u21a9", "larrlp": "\u21ab",
  "larrpl": "\u2939", "larrsim": "\u2973", "larrtl": "\u21a2", "lat": "\u2aab", "latail": "\u2919", "late": "\u2aad",
  "lates": "\u2aad\ufe00", "lbarr": "\u290c", "lbbrk": "\u2772", "lbrace": "{", "lbrack": "[", "lbrke": "\u298b",
  "lbrksld": "\u298f", "lbrkslu": "\u298d", "lcaron": "\u013e", "lcedil": "\u013c", "lceil": "\u2308", "lcub": "{",
  "lcy": "\u043b", "ldca": "\u2936", "ldquo": "\u201c", "ldquor": "\u201e", "ldrdhar": "\u2967", "ldrushar": "\u294b",
  "ldsh": "\u21b2", "le": "\u2264", "leftarrow": "\u2190", "leftarrowtail": "\u21a2", "leftharpoondown": "\u21bd", "leftharpoonup": "\u21bc",
  "leftleftarrows": "\u21c7", "leftrightarrow": "\u2194", "leftrightarrows": "\u21c6", "leftrightharpoons": "\u21cb", "leftrightsquigarrow": "\u21ad", "leftthreetimes": "\u22cb",
  "leg": "\u22da", "leq": "\u2264", "leqq": "\u2266", "leqslant": "\u2a7d", "les": "\u2a7d", "lescc": "\u2aa8",
  "lesdot": "\u2a7f", "lesdoto": "\u2a81", "lesdotor": "\u2a83", "lesg": "\u22da\ufe00", "lesges": "\u2a93", "lessapprox": "\u2a85",
  "lessdot": "\u22d6", "lesseqgtr": "\u22da", "lesseqqgtr": "\u2a8b", "lessgtr": "\u2276", "lesssim": "\u2272", "lfisht": "\u297c",
  "lfloor": "\u230a", "lfr": "\ud835\udd29", "lg": "\u2276", "lgE": "\u2a91", "lhard": "\u21bd", "lharu": "\u21bc",
  "lharul": "\u296a", "lhblk": "\u2584", "ljcy": "\u0459", "ll": "\u226a", "llarr": "\u21c7", "llcorner": "\u231e",
  "llhard": "\u296b", "lltri": "\u25fa", "lmidot": "\u0140", "lmoust": "\u23b0", "lmoustache": "\u23b0", "lnE": "\u2268",
  "lnap": "\u2a89", "lnapprox": "\u2a89", "lne": "\u2a87", "lneq": "\u2a87", "lneqq": "\u2268", "lnsim": "\u22e6",
  "loang": "\u27ec", "loarr": "\u21fd", "lobrk": "\u27e6", "longleftarrow": "\u27f5", "longleftrightarrow": "\u27f7", "longmapsto": "\u27fc",
  "longrightarrow": "\u27f6", "looparrowleft": "\u21ab", "looparrowright": "\u21ac", "lopar": "\u2985", "lopf": "\ud835\udd5d", "loplus": "\u2a2d",
  "lotimes": "\u2a34", "lowast": "\u2217", "lowbar": "_", "loz": "\u25ca", "lozenge": "\u25ca", "lozf": "\u29eb",
  "lpar": "(", "lparlt": "\u2993", "lrarr": "\u21c6", "lrcorner": "\u231f", "lrhar": "\u21cb", "lrhard": "\u296d",
  "lrm": "\u200e", "lrtri": "\u22bf", "lsaquo": "\u2039", "lscr": "\ud835\udcc1", "lsh": "\u21b0", "lsim": "\u2272",
  "lsime": "\u2a8d", "lsimg": "\u2a8f", "lsqb": "[", "lsquo": "\u2018", "lsquor": "\u201a", "lstrok": "\u0142",
  "lt": "<", "ltcc": "\u2aa6", "ltcir": "\u2a79", "ltdot": "\u22d6", "lthree": "\u22cb", "ltimes": "\u22c9",
  "ltlarr": "\u2976", "ltquest": "\u2a7b", "ltrPar": "\u2996", "ltri": "\u25c3", "ltrie": "\u22b4", "ltrif": "\u25c2",
  "lurdshar": "\u294a", "luruhar": "\u2966", "lvertneqq": "\u2268\ufe00", "lvnE": "\u2268\ufe00", "mDDot": "\u223a", "macr": "\u00af",
  "male": "\u2642", "malt": "\u2720", "maltese": "\u2720", "map": "\u21a6", "mapsto": "\u21a6", "mapstodown": "\u21a7",
  "mapstoleft": "\u21a4", "mapstoup": "\u21a5", "marker": "\u25ae", "mcomma": "\u2a29", "mcy": "\u043c", "mdash": "\u2014",
  "measuredangle": "\u2221", "mfr": "\ud835\udd2a", "mho": "\u2127", "micro": "\u00b5", "mid": "\u2223", "midast": "*",
  "midcir": "\u2af0", "middot": "\u00b7", "minus": "\u2212", "minusb": "\u229f", "minusd": "\u2238", "minusdu": "\u2a2a",
  "mlcp": "\u2adb", "mldr": "\u2026", "mnplus": "\u2213", "models": "\u22a7", "mopf": "\ud835\udd5e", "mp": "\u2213",
  "mscr": "\ud835\udcc2", "mstpos": "\u223e", "mu": "\u03bc", "multimap": "\u22b8", "mumap": "\u22b8", "nGg": "\u22d9\u0338",
  "nGt": "\u226b\u20d2", "nGtv": "\u226b\u0338", "nLeftarrow": "\u21cd", "nLeftrightarrow": "\u21ce", "nLl": "\u22d8\u0338", "nLt": "\u226a\u20d2",
  "nLtv": "\u226a\u0338", "nRightarrow": "\u21cf", "nVDash": "\u22af", "nVdash": "\u22ae", "nabla": "\u2207", "nacute": "\u0144",
  "nang": "\u2220\u20d2", "nap": "\u2249", "napE": "\u2a70\u0338", "napid": "\u224b\u0338", "napos": "\u0149", "napprox": "\u2249",
  "natur": "\u266e", "natural": "\u266e", "naturals": "\u2115", "nbsp": "\u00a0", "nbump": "\u224e\u0338", "nbumpe": "\u224f\u0338",
  "ncap": "\u2a43", "ncaron": "\u0148", "ncedil": "\u0146", "ncong": "\u2247", "ncongdot": "\u2a6d\u0338", "ncup": "\u2a42",
  "ncy": "\u043d", "ndash": "\u2013", "ne": "\u2260", "neArr": "\u21d7", "nearhk": "\u2924", "nearr": "\u2197",
  "nearrow": "\u2197", "nedot": "\u2250\u0338", "nequiv": "\u2262", "nesear": "\u2928", "nesim": "\u2242\u0338", "nexist": "\u2204",
  "nexists": "\u2204", "nfr": "\ud835\udd2b", "ngE": "\u2267\u0338", "nge": "\u2271", "ngeq": "\u2271", "ngeqq": "\u2267\u0338",
  "ngeqslant": "\u2a7e\u0338", "nges": "\u2a7e\u0338", "ngsim": "\u2275", "ngt": "\u226f", "ngtr": "\u226f", "nhArr": "\u21ce",
  "nharr": "\u21ae", "nhpar": "\u2af2", "ni": "\u220b", "nis": "\u22fc", "nisd": "\u22fa", "niv": "\u220b",
  "njcy": "\u045a", "nlArr": "\u21cd", "nlE": "\u2266\u0338", "nlarr": "\u219a", "nldr": "\u2025", "nle": "\u2270",
  "nleftarrow": "\u219a", "nleftrightarrow": "\u21ae", "nleq": "\u2270", "nleqq": "\u2266\u0338", "nleqslant": "\u2a7d\u0338", "nles": "\u2a7d\u0338",
  "nless": "\u226e", "nlsim": "\u2274", "nlt": "\u226e", "nltri": "\u22ea", "nltrie": "\u22ec", "nmid": "\u2224",
  "nopf": "\ud835\udd5f", "not": "\u00ac", "notin": "\u2209", "notinE": "\u22f9\u0338", "notindot": "\u22f5\u0338", "notinva": "\u2209",
  "notinvb": "\u22f7", "notinvc": "\u22f6", "notni": "\u220c", "notniva": "\u220c", "notnivb": "\u22fe", "notnivc": "\u22fd",
  "npar": "\u2226", "nparallel": "\u2226", "nparsl": "\u2afd\u20e5", "npart": "\u2202\u0338", "npolint": "\u2a14", "npr": "\u2280",
  "nprcue": "\u22e0", "npre": "\u2aaf\u0338", "nprec": "\u2280", "npreceq": "\u2aaf\u0338", "nrArr": "\u21cf", "nrarr": "\u219b",
  "nrarrc": "\u2933\u0338", "nrarrw": "\u219d\u0338", "nrightarrow": "\u219b", "nrtri": "\u22eb", "nrtrie": "\u22ed", "nsc": "\u2281",
  "nsccue": "\u22e1", "nsce": "\u2ab0\u0338", "nscr": "\ud835\udcc3", "nshortmid": "\u2224", "nshortparallel": "\u2226", "nsim": "\u2241",
  "nsime": "\u2244", "nsimeq": "\u2244", "nsmid": "\u2224", "nspar": "\u2226", "nsqsube": "\u22e2", "nsqsupe": "\u22e3",
  "nsub": "\u2284", "nsubE": "\u2ac5\u0338", "nsube": "\u2288", "nsubset": "\u2282\u20d2", "nsubseteq": "\u2288", "nsubseteqq": "\u2ac5\u0338",
  "nsucc": "\u2281", "nsucceq": "\u2ab0\u0338", "nsup": "\u2285", "nsupE": "\u2ac6\u0338", "nsupe": "\u2289", "nsupset": "\u2283\u20d2",
  "nsupseteq": "\u2289", "nsupseteqq": "\u2ac6\u0338", "ntgl": "\u2279", "ntilde": "\u00f1", "ntlg": "\u2278", "ntriangleleft": "\u22ea",
  "ntrianglelefteq": "\u22ec", "ntriangleright": "\u22eb", "ntrianglerighteq": "\u22ed", "nu": "\u03bd", "num": "#", "numero": "\u2116",
  "numsp": "\u2007", "nvDash": "\u22ad", "nvHarr": "\u2904", "nvap": "\u224d\u20d2", "nvdash": "\u22ac", "nvge": "\u2265\u20d2",
  "nvgt": ">\u20d2", "nvinfin": "\u29de", "nvlArr": "\u2902", "nvle": "\u2264\u20d2", "nvlt": "<\u20d2", "nvltrie": "\u22b4\u20d2",
  "nvrArr": "\u2903", "nvrtrie": "\u22b5\u20d2", "nvsim": "\u223c\u20d2", "nwArr": "\u21d6", "nwarhk": "\u2923", "nwarr": "\u2196",
  "nwarrow": "\u2196", "nwnear": "\u2927", "oS": "\u24c8", "oacute": "\u00f3", "oast": "\u229b", "ocir": "\u229a",
  "ocirc": "\u00f4", "ocy": "\u043e", "odash": "\u229d", "odblac": "\u0151", "odiv": "\u2a38", "odot": "\u2299",
  "odsold": "\u29bc", "oelig": "\u0153", "ofcir": "\u29bf", "ofr": "\ud835\udd2c", "ogon": "\u02db", "ograve": "\u00f2",
  "ogt": "\u29c1", "ohbar": "\u29b5", "ohm": "\u03a9", "oint": "\u222e", "olarr": "\u21ba", "olcir": "\u29be",
  "olcross": "\u29bb", "oline": "\u203e", "olt": "\u29c0", "omacr": "\u014d", "omega": "\u03c9", "omicron": "\u03bf",
  "omid": "\u29b6", "ominus": "\u2296", "oopf": "\ud835\udd60", "opar": "\u29b7", "operp": "\u29b9", "oplus": "\u2295",
  "or": "\u2228", "orarr": "\u21bb", "ord": "\u2a5d", "order": "\u2134", "orderof": "\u2134", "ordf": "\u00aa",
  "ordm": "\u00ba", "origof": "\u22b6", "oror": "\u2a56", "orslope": "\u2a57", "orv": "\u2a5b", "oscr": "\u2134",
  "oslash": "\u00f8", "osol": "\u2298", "otilde": "\u00f5", "otimes": "\u2297", "otimesas": "\u2a36", "ouml": "\u00f6",
  "ovbar": "\u233d", "par": "\u2225", "para": "\u00b6", "parallel": "\u2225", "parsim": "\u2af3", "parsl": "\u2afd",
  "part": "\u2202", "pcy": "\u043f", "percnt": "%", "period": ".", "permil": "\u2030", "perp": "\u22a5",
  "pertenk": "\u2031", "pfr": "\ud835\udd2d", "phi": "\u03c6", "phiv": "\u03d5", "phmmat": "\u2133", "phone": "\u260e",
  "pi": "\u03c0", "pitchfork": "\u22d4", "piv": "\u03d6", "planck": "\u210f", "planckh": "\u210e", "plankv": "\u210f",
  "plus": "+", "plusacir": "\u2a23", "plusb": "\u229e", "pluscir": "\u2a22", "plusdo": "\u2214", "plusdu": "\u2a25",
  "pluse": "\u2a72", "plusmn": "\u00b1", "plussim": "\u2a26", "plustwo": "\u2a27", "pm": "\u00b1", "pointint": "\u2a15",
  "popf": "\ud835\udd61", "pound": "\u00a3", "pr": "\u227a", "prE": "\u2ab3", "prap": "\u2ab7", "prcue": "\u227c",
  "pre": "\u2aaf", "prec": "\u227a", "precapprox": "\u2ab7", "preccurlyeq": "\u227c", "preceq": "\u2aaf", "precnapprox": "\u2ab9",
  "precneqq": "\u2ab5", "precnsim": "\u22e8", "precsim": "\u227e", "prime": "\u2032", "primes": "\u2119", "prnE": "\u2ab5",
  "prnap": "\u2ab9", "prnsim": "\u22e8", "prod": "\u220f", "profalar": "\u232e", "profline": "\u2312", "profsurf": "\u2313",
  "prop": "\u221d", "propto": "\u221d", "prsim": "\u227e", "prurel": "\u22b0", "pscr": "\ud835\udcc5", "psi": "\u03c8",
  "puncsp": "\u2008", "qfr": "\ud835\udd2e", "qint": "\u2a0c", "qopf": "\ud835\udd62", "qprime": "\u2057", "qscr": "\ud835\udcc6",
  "quaternions": "\u210d", "quatint": "\u2a16", "quest": "?", "questeq": "\u225f", "quot": "\"", "rAarr": "\u21db",
  "rArr": "\u21d2", "rAtail": "\u291c", "rBarr": "\u290f", "rHar": "\u2964", "race": "\u223d\u0331", "racute": "\u0155",
  "radic": "\u221a", "raemptyv": "\u29b3", "rang": "\u27e9", "rangd": "\u2992", "range": "\u29a5", "rangle": "\u27e9",
  "raquo": "\u00bb", "rarr": "\u2192", "rarrap": "\u2975", "rarrb": "\u21e5", "rarrbfs": "\u2920", "rarrc": "\u2933",
  "rarrfs": "\u291e", "rarrhk": "\u21aa", "rarrlp": "\u21ac", "rarrpl": "\u2945", "rarrsim": "\u2974", "rarrtl": "\u21a3",
  "rarrw": "\u219d", "ratail": "\u291a", "ratio": "\u2236", "rationals": "\u211a", "rbarr": "\u290d", "rbbrk": "\u2773",
  "rbrace": "}", "rbrack": "]", "rbrke": "\u298c", "rbrksld": "\u298e", "rbrkslu": "\u2990", "rcaron": "\u0159",
  "rcedil": "\u0157", "rceil": "\u2309", "rcub": "}", "rcy": "\u0440", "rdca": "\u2937", "rdldhar": "\u2969",
  "rdquo": "\u201d", "rdquor": "\u201d", "rdsh": "\u21b3", "real": "\u211c", "realine": "\u211b", "realpart": "\u211c",
  "reals": "\u211d", "rect": "\u25ad", "reg": "\u00ae", "rfisht": "\u297d", "rfloor": "\u230b", "rfr": "\ud835\udd2f",
  "rhard": "\u21c1", "rharu": "\u21c0", "rharul": "\u296c", "rho": "\u03c1", "rhov": "\u03f1", "rightarrow": "\u2192",
  "rightarrowtail": "\u21a3", "rightharpoondown": "\u21c1", "rightharpoonup": "\u21c0", "rightleftarrows": "\u21c4", "rightleftharpoons": "\u21cc", "rightrightarrows": "\u21c9",
  "rightsquigarrow": "\u219d", "rightthreetimes": "\u22cc", "ring": "\u02da", "risingdotseq": "\u2253", "rlarr": "\u21c4", "rlhar": "\u21cc",
  "rlm": "\u200f", "rmoust": "\u23b1", "rmoustache": "\u23b1", "rnmid": "\u2aee", "roang": "\u27ed", "roarr": "\u21fe",
  "robrk": "\u27e7", "ropar": "\u2986", "ropf": "\ud835\udd63", "roplus": "\u2a2e", "rotimes": "\u2a35", "rpar": ")",
  "rpargt": "\u2994", "rppolint": "\u2a12", "rrarr": "\u21c9", "rsaquo": "\u203a", "rscr": "\ud835\udcc7", "rsh": "\u21b1",
  "rsqb": "]", "rsquo": "\u2019", "rsquor": "\u2019", "rthree": "\u22cc", "rtimes": "\u22ca", "rtri": "\u25b9",
  "rtrie": "\u22b5", "rtrif": "\u25b8", "rtriltri": "\u29ce", "ruluhar": "\u2968", "rx": "\u211e", "sacute": "\u015b",
  "sbquo": "\u201a", "sc": "\u227b", "scE": "\u2ab4", "scap": "\u2ab8", "scaron": "\u0161", "sccue": "\u227d",
  "sce": "\u2ab0", "scedil": "\u015f", "scirc": "\u015d", "scnE": "\u2ab6", "scnap": "\u2aba", "scnsim": "\u22e9",
  "scpolint": "\u2a13", "scsim": "\u227f", "scy": "\u0441", "sdot": "\u22c5", "sdotb": "\u22a1", "sdote": "\u2a66",
  "seArr": "\u21d8", "searhk": "\u2925", "searr": "\u2198", "searrow": "\u2198", "sect": "\u00a7", "semi": ";",
  "seswar": "\u2929", "setminus": "\u2216", "setmn": "\u2216", "sext": "\u2736", "sfr": "\ud835\udd30", "sfrown": "\u2322",
  "sharp": "\u266f", "shchcy": "\u0449", "shcy": "\u0448", "shortmid": "\u2223", "shortparallel": "\u2225", "shy": "\u00ad",
  "sigma": "\u03c3", "sigmaf": "\u03c2", "sigmav": "\u03c2", "sim": "\u223c", "simdot": "\u2a6a", "sime": "\u2243",
  "simeq": "\u2243", "simg": "\u2a9e", "simgE": "\u2aa0", "siml": "\u2a9d", "simlE": "\u2a9f", "simne": "\u2246",
  "simplus": "\u2a24", "simrarr": "\u2972", "slarr": "\u2190", "smallsetminus": "\u2216", "smashp": "\u2a33", "smeparsl": "\u29e4",
  "smid": "\u2223", "smile": "\u2323", "smt": "\u2aaa", "smte": "\u2aac", "smtes": "\u2aac\ufe00", "softcy": "\u044c",
  "sol": "/", "solb": "\u29c4", "solbar": "\u233f", "sopf": "\ud835\udd64", "spades": "\u2660", "spadesuit": "\u2660",
  "spar": "\u2225", "sqcap": "\u2293", "sqcaps": "\u2293\ufe00", "sqcup": "\u2294", "sqcups": "\u2294\ufe00", "sqsub": "\u228f",
  "sqsube": "\u2291", "sqsubset": "\u228f", "sqsubseteq": "\u2291", "sqsup": "\u2290", "sqsupe": "\u2292", "sqsupset": "\u2290",
  "sqsupseteq": "\u2292", "squ": "\u25a1", "square": "\u25a1", "squarf": "\u25aa", "squf": "\u25aa", "srarr": "\u2192",
  "sscr": "\ud835\udcc8", "ssetmn": "\u2216", "ssmile": "\u2323", "sstarf": "\u22c6", "star": "\u2606", "starf": "\u2605",
  "straightepsilon": "\u03f5", "straightphi": "\u03d5", "strns": "\u00af", "sub": "\u2282", "subE": "\u2ac5", "subdot": "\u2abd",
  "sube": "\u2286", "subedot": "\u2ac3", "submult": "\u2ac1", "subnE": "\u2acb", "subne": "\u228a", "subplus": "\u2abf",
  "subrarr": "\u2979", "subset": "\u2282", "subseteq": "\u2286", "subseteqq": "\u2ac5", "subsetneq": "\u228a", "subsetneqq": "\u2acb",
  "subsim": "\u2ac7", "subsub": "\u2ad5", "subsup": "\u2ad3", "succ": "\u227b", "succapprox": "\u2ab8", "succcurlyeq": "\u227d",
  "succeq": "\u2ab0", "succnapprox": "\u2aba", "succneqq": "\u2ab6", "succnsim": "\u22e9", "succsim": "\u227f", "sum": "\u2211",
  "sung": "\u266a", "sup": "\u2283", "sup1": "\u00b9", "sup2": "\u00b2", "sup3": "\u00b3", "supE": "\u2ac6",
  "supdot": "\u2abe", "supdsub": "\u2ad8", "supe": "\u2287", "supedot": "\u2ac4", "suphsol": "\u27c9", "suphsub": "\u2ad7",
  "suplarr": "\u297b", "supmult": "\u2ac2", "supnE": "\u2acc", "supne": "\u228b", "supplus": "\u2ac0", "supset": "\u2283",
  "supseteq": "\u2287", "supseteqq": "\u2ac6", "supsetneq": "\u228b", "supsetneqq": "\u2acc", "supsim": "\u2ac8", "supsub": "\u2ad4",
  "supsup": "\u2ad6", "swArr": "\u21d9", "swarhk": "\u2926", "swarr": "\u2199", "swarrow": "\u2199", "swnwar": "\u292a",
  "szlig": "\u00df", "target": "\u2316", "tau": "\u03c4", "tbrk": "\u23b4", "tcaron": "\u0165", "tcedil": "\u0163",
  "tcy": "\u0442", "tdot": "\u20db", "telrec": "\u2315", "tfr": "\ud835\udd31", "there4": "\u2234", "therefore": "\u2234",
  "theta": "\u03b8", "thetasym": "\u03d1", "thetav": "\u03d1", "thickapprox": "\u2248", "thicksim": "\u223c", "thinsp": "\u2009",
  "thkap": "\u2248", "thksim": "\u223c", "thorn": "\u00fe", "tilde": "\u02dc", "times": "\u00d7", "timesb": "\u22a0",
  "timesbar": "\u2a31", "timesd": "\u2a30", "tint": "\u222d", "toea": "\u2928", "top": "\u22a4", "topbot": "\u2336",
  "topcir": "\u2af1", "topf": "\ud835\udd65", "topfork": "\u2ada", "tosa": "\u2929", "tprime": "\u2034", "trade": "\u2122",
  "triangle": "\u25b5", "triangledown": "\u25bf", "triangleleft": "\u25c3", "trianglelefteq": "\u22b4", "triangleq": "\u225c", "triangleright": "\u25b9",
  "trianglerighteq": "\u22b5", "tridot": "\u25ec", "trie": "\u225c", "triminus": "\u2a3a", "triplus": "\u2a39", "trisb": "\u29cd",
  "tritime": "\u2a3b", "trpezium": "\u23e2", "tscr": "\ud835\udcc9", "tscy": "\u0446", "tshcy": "\u045b", "tstrok": "\u0167",
  "twixt": "\u226c", "twoheadleftarrow": "\u219e", "twoheadrightarrow": "\u21a0", "uArr": "\u21d1", "uHar": "\u2963", "uacute": "\u00fa",
  "uarr": "\u2191", "ubrcy": "\u045e", "ubreve": "\u016d", "ucirc": "\u00fb", "ucy": "\u0443", "udarr": "\u21c5",
  "udblac": "\u0171", "udhar": "\u296e", "ufisht": "\u297e", "ufr": "\ud835\udd32", "ugrave": "\u00f9", "uharl": "\u21bf",
  "uharr": "\u21be", "uhblk": "\u2580", "ulcorn": "\u231c", "ulcorner": "\u231c", "ulcrop": "\u230f", "ultri": "\u25f8",
  "umacr": "\u016b", "uml": "\u00a8", "uogon": "\u0173", "uopf": "\ud835\udd66", "uparrow": "\u2191", "updownarrow": "\u2195",
  "upharpoonleft": "\u21bf", "upharpoonright": "\u21be", "uplus": "\u228e", "upsi": "\u03c5", "upsih": "\u03d2", "upsilon": "\u03c5",
  "upuparrows": "\u21c8", "urcorn": "\u231d", "urcorner": "\u231d", "urcrop": "\u230e", "uring": "\u016f", "urtri": "\u25f9",
  "uscr": "\ud835\udcca", "utdot": "\u22f0", "utilde": "\u0169", "utri": "\u25b5", "utrif": "\u25b4", "uuarr": "\u21c8",
  "uuml": "\u00fc", "uwangle": "\u29a7", "vArr": "\u21d5", "vBar": "\u2ae8", "vBarv": "\u2ae9", "vDash": "\u22a8",
  "vangrt": "\u299c", "varepsilon": "\u03f5", "varkappa": "\u03f0", "varnothing": "\u2205", "varphi": "\u03d5", "varpi": "\u03d6",
  "varpropto": "\u221d", "varr": "\u2195", "varrho": "\u03f1", "varsigma": "\u03c2", "varsubsetneq": "\u228a\ufe00", "varsubsetneqq": "\u2acb\ufe00",
  "varsupsetneq": "\u228b\ufe00", "varsupsetneqq": "\u2acc\ufe00", "vartheta": "\u03d1", "vartriangleleft": "\u22b2", "vartriangleright": "\u22b3", "vcy": "\u0432",
  "vdash": "\u22a2", "vee": "\u2228", "veebar": "\u22bb", "veeeq": "\u225a", "vellip": "\u22ee", "verbar": "|",
  "vert": "|", "vfr": "\ud835\udd33", "vltri": "\u22b2", "vnsub": "\u2282\u20d2", "vnsup": "\u2283\u20d2", "vopf": "\ud835\udd67",
  "vprop": "\u221d", "vrtri": "\u22b3", "vscr": "\ud835\udccb", "vsubnE": "\u2acb\ufe00", "vsubne": "\u228a\ufe00", "vsupnE": "\u2acc\ufe00",
  "vsupne": "\u228b\ufe00", "vzigzag": "\u299a", "wcirc": "\u0175", "wedbar": "\u2a5f", "wedge": "\u2227", "wedgeq": "\u2259",
  "weierp": "\u2118", "wfr": "\ud835\udd34", "wopf": "\ud835\udd68", "wp": "\u2118", "wr": "\u2240", "wreath": "\u2240",
  "wscr": "\ud835\udccc", "xcap": "\u22c2", "xcirc": "\u25ef", "xcup": "\u22c3", "xdtri": "\u25bd", "xfr": "\ud835\udd35",
  "xhArr": "\u27fa", "xharr": "\u27f7", "xi": "\u03be", "xlArr": "\u27f8", "xlarr": "\u27f5", "xmap": "\u27fc",
  "xnis": "\u22fb", "xodot": "\u2a00", "xopf": "\ud835\udd69", "xoplus": "\u2a01", "xotime": "\u2a02", "xrArr": "\u27f9",
  "xrarr": "\u27f6", "xscr": "\ud835\udccd", "xsqcup": "\u2a06", "xuplus": "\u2a04", "xutri": "\u25b3", "xvee": "\u22c1",
  "xwedge": "\u22c0", "yacute": "\u00fd", "yacy": "\u044f", "ycirc": "\u0177", "ycy": "\u044b", "yen": "\u00a5",
  "yfr": "\ud835\udd36", "yicy": "\u0457", "yopf": "\ud835\udd6a", "yscr": "\ud835\udcce", "yucy": "\u044e", "yuml": "\u00ff",
  "zacute": "\u017a", "zcaron": "\u017e", "zcy": "\u0437", "zdot": "\u017c", "zeetrf": "\u2128", "zeta": "\u03b6",
  "zfr": "\ud835\udd37", "zhcy": "\u0436", "zigrarr": "\u21dd", "zopf": "\ud835\udd6b", "zscr": "\ud835\udccf", "zwj": "\u200d",
  "zwnj": "\u200c",
});
const HTML_ENTITY_NAMES = new Set(Object.keys(HTML_NAMED_ENTITIES));
const legacyHtmlNames = Object.keys(LEGACY_HTML_NAMES).sort((a, b) => b.length - a.length);

// Normalize only human-visible negative evidence; protocol and clocks stay raw.
function visibleCodexReviewText(value, blockBoundaries = false) {
  // Parse raw structural delimiters before decoding text entities: an encoded
  // quote is attribute data, and an encoded angle bracket cannot create a tag.
  const raw = withoutHtmlComments(String(value || ""));
  const literalSafe = preserveLiteralMarkdownLinks(raw);
  const legacySafe = literalSafe.replace(/&([A-Za-z][A-Za-z0-9]*)(;?)/g, (entity, token, semicolon, index) => {
    if ((semicolon && HTML_ENTITY_NAMES.has(token)) || !isRawHtmlRowContext(literalSafe, index, true)) return entity;
    const name = legacyHtmlNames.find((candidate) => token.startsWith(candidate));
    return name ? Array.from(LEGACY_HTML_NAMES[name], (character) => "&#" + character.codePointAt(0) + ";").join("") + token.slice(name.length) + semicolon : entity;
  });
  const htmlReferences = legacySafe.replace(/&#(?:x[0-9a-f]+|[0-9]+);?/gi, (entity, index) =>
    entity.endsWith(";") || !isRawHtmlRowContext(legacySafe, index, true) ? entity : entity + ";");
  const validTag = /^<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'|[^ \t\r\n"'=<>`]+))?)*[ \t\r\n]*\/?>$|^<\/[A-Za-z][A-Za-z0-9-]*[ \t\r\n]*>$/;
  const images = htmlReferences.replace(/<img\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi, (tag, attributes, offset) => {
    if (!validTag.test(tag) && !isRawHtmlRowContext(htmlReferences, offset, true)) return tag;
    const alt = attributes.match(/(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    return alt ? " " + alt.slice(1).find((value) => value !== undefined) + " " : " ";
  });
  const decode = (text) => text.replace(/&#(x[0-9a-f]+|[0-9]+);|&([A-Za-z][A-Za-z0-9]*);/gi, (entity, digits, name) => {
    if (name) return Object.hasOwn(HTML_NAMED_ENTITIES, name) ? HTML_NAMED_ENTITIES[name] : entity;
    const point = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
  return ["", " "].flatMap((separator) => {
    const visible = decode(activeMarkdownEmphasis(visibleMarkdownLinkLabels(images.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, (tag, offset) => {
      if (!validTag.test(tag) && !isRawHtmlRowContext(images, offset, true)) return tag;
      if (/^<br(?:\s|\/?>)/i.test(tag)) return " ";
      return blockBoundaries && /^<\/?(?:address|article|aside|blockquote|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|menu|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|br)(?:\s|\/?>)/i.test(tag) ? "\n\n" : separator;
    }))));
    return [visible.replace(/\p{Default_Ignorable_Code_Point}/gu, ""), visible.replace(/\p{Default_Ignorable_Code_Point}/gu, " ")];
  }).join(" ").replace(/[^\S\n]+/g, " ").replace(/\n(?: *\n)+/g, "\n\n").replace(/(?<!\n)\n(?!\n)/g, " ");
}


function hasRenderedCodexSectionRow(body, label) {
  return String(body || "").split("\n").some((line) => line.includes("|") && visibleCodexReviewText(line).toLowerCase().includes(label.toLowerCase()));
}

export function containsBlockingCodexSeverity(body) {
  return /\bP[0-2]\b/i.test(visibleCodexReviewText(body));
}

/** "pass", "fail", or null when the review does not answer for this head. */
export function classifyCodexNativeReview(review, reviewComments = [], headSha) {
  if (!review || review.commit_id !== headSha) return null;
  if (!isTrustedCodexLogin(review.user?.login)) return null;
  if (containsBlockingCodexSeverity(review.body)) return "fail";
  if (review.state === "CHANGES_REQUESTED") return "fail";

  const commentsForReview = reviewComments.filter((comment) =>
    comment.pull_request_review_id === review.id &&
    isTrustedCodexLogin(comment.user?.login)
  );
  if (commentsForReview.length > 0) {
    const priorities = commentsForReview.map((comment) => extractCodexPriority(comment.body));
    /* An unlabelled finding is treated as blocking: the gate must not pass a
       comment it could not grade. */
    if (priorities.some((priority) => priority === null)) return "fail";
    if (commentsForReview.some((comment) => containsBlockingCodexSeverity(comment.body))) return "fail";
  }

  return review.state === "APPROVED" || review.state === "COMMENTED" ? "pass" : null;
}

export function latestCodexNativeReviewResult(reviews = [], reviewComments = [], headSha) {
  return reviews
    .map((review) => ({ review, result: classifyCodexNativeReview(review, reviewComments, headSha) }))
    .filter((entry) => entry.result !== null)
    .sort((left, right) => {
      const bySubmissionTime = Date.parse(right.review.submitted_at || "") -
        Date.parse(left.review.submitted_at || "");
      return bySubmissionTime || compareNumericIds(right.review.id, left.review.id);
    })[0]?.result || null;
}

/** Codex reports "no findings" as a plain comment rather than a review, so
    that shape is accepted too - but only for this head and only after the
    request it answers. */
// Closed native presentation is the clock/approval boundary. Unknown prose is
// pending evidence; its meaning is never inferred from English or Markdown.
const NATIVE_RECEIPT_CLOSINGS = new Set(["", ":+1:", ":rocket:", ":tada:", "Already looking forward to the next diff.", "Another round soon, please!", "Bravo.", "Breezy!", "Can't wait for the next one!", "Chef's kiss.", "Delightful!", "Hooray!", "Keep it up!", "Keep them coming!", "More of your lovely PRs please.", "Nice work!", "Swish!", "What shall we delve into next?", "You're on a roll.", "🚀", "🎉", "👍", "Chef’s kiss.", "You’re on a roll.", "Great work!", "Great job!", "Well done!", "Looks good!", "Looking good!", "You're on fire!", "You’re on fire!", "You rock!", "Keep up the good work!", "Happy merging!", "All good!", "Ship it!"]);
const NATIVE_HELP_TEXTS = new Set(["[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you - Open a pull request for review - Mark a draft as ready - Comment \"@codex review\". If Codex has suggestions, it will comment; otherwise it will react with 👍. Codex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".", "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you - Open a pull request for review - Mark a draft as ready - Comment \"@codex review\" or \"@codex security review\". Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings."]);
function withoutNativeHelp(body) {
  const source = String(body || "").trim();
  const index = source.indexOf("<details>");
  if (index < 0) return source;
  const match = source.slice(index).match(/^<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>\s*(?:<br\s*\/>)?\s*([\s\S]*?)\s*<\/details>$/);
  if (!match || !NATIVE_HELP_TEXTS.has(match[1].replace(/\s+/g, " ").trim())) return null;
  return source.slice(0, index).trim();
}
function isCanonicalCodexPresentation(body, state) {
  const envelope = String(body || "").match(/^ {0,3}<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!envelope || !state) return false;
  const presentation = withoutNativeHelp(String(body).slice(envelope[0].length));
  if (presentation === null) return false;
  const rawLines = presentation.split(/\r?\n/);
  if (rawLines.some(line => line.trim() ? !/^ {0,3}\S/.test(line) : !/^[ \t]*$/.test(line))) return false;
  const lines = rawLines.map(line => line.trim());
  if (lines.shift() !== "## Codex Review Summary") return false;
  while (lines[0] === "") lines.shift();
  if (lines[0] === "This comment shows the latest Codex review activity on this pull request.") {
    lines.shift(); while (lines[0] === "") lines.shift();
  }
  // Preserve this repository's older row-only native summary, as well as the
  // current connector's contiguous four-column table.
  if (lines[0] === "| Review | Status | Commit | Review trigger |") {
    lines.shift();
    if (!/^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/.test(lines.shift() || "")) return false;
  }
  while (lines.at(-1) === "") lines.pop();
  const sections = ["code_review", "security_review"].filter(section => state[section].status !== null);
  if (lines.length !== sections.length) return false;
  return sections.every((section, index) => {
    const value = state[section];
    const label = section === "code_review" ? "Code Review" : "Security Review";
    const row = lines[index].match(/^\| (📝|🛡️|🔒) \*\*(Code Review|Security Review)\*\* \| (✅ \*\*Completed\*\*|🔄 \*\*Running\*\* since) <relative-time datetime="([^"<>]+)">([^<>]+)<\/relative-time> \| `([a-f0-9]{7,40})` \| ([^|<>`]+) \|$/);
    if (!row || row[2] !== label || (section === "code_review" ? row[1] !== "📝" : !["🛡️", "🔒"].includes(row[1])) ||
        row[3] !== (value.status === "completed" ? "✅ **Completed**" : value.status === "running" ? "🔄 **Running** since" : "") ||
        !value.commit_sha.startsWith(row[6]) || row[4] !== row[5] || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row[4]) || !Number.isFinite(Date.parse(row[4]))) return false;
    // A typed finding's original row may carry its severity. A clean or null
    // state cannot assign arbitrary prose to a native review trigger.
    return ["Manual request", "PR opened"].includes(row[7]) ||
      ((value.has_any_findings === true || value.has_unresolved_findings === true) && /^(?:Manual request )?P[0-2](?: [A-Za-z]+)*$/.test(row[7]));
  });
}

export function isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId) {
  if (!isTrustedCodexLogin(comment?.user?.login) || !/^[a-f0-9]{40}$/.test(String(headSha || ""))) return false;
  const body = withoutNativeHelp(String(comment?.body || ""));
  if (body === null) return false;
  const match = body.match(/^(?:<!-- codex-review-receipt:v1 -->\s*)?Codex Review: Didn't find any major issues\.([^\r\n]*)\s+\*\*Reviewed commit:\*\*\s*`([a-f0-9]{10}|[a-f0-9]{40})`(?:\s+\[View task →\]\(https:\/\/chatgpt\.com\/s\/cd_[a-f0-9]{32}\))?$/i);
  if (!match || ![...NATIVE_RECEIPT_CLOSINGS].some(value => normalize(value) === normalize(match[1])) ||
      (match[1] && !match[1].startsWith(" ")) ||
      ![headSha, headSha.slice(0, 10)].includes(match[2].toLowerCase())) return false;
  if (!requestedAt) return true;
  const created = Date.parse(comment.created_at || ""), requested = Date.parse(requestedAt);
  return Number.isFinite(created) && Number.isFinite(requested) &&
    (created > requested || (created === requested && compareNumericIds(comment.id, requestCommentId) > 0));
}

/** Prefix routing wakes the gate; complete machine state is validated below. */
export function isCodexReviewWakeupComment(body) {
  return /^(?:Codex Review:|<!-- codex-review-receipt:v1 -->|<!-- codex-pull-request-review-summary -->)/i
    .test(String(body || ""));
}

function markdownTableCells(line) {
  const value = String(line).trim();
  const cells = []; let cursor = 0;
  for (let index = 0; index < value.length; index++) if (value[index] === "|" && !isEscapedMarkdownStart(value, index)) {
    cells.push(value.slice(cursor, index).trim()); cursor = index + 1;
  }
  if (!cells.length) return null;
  cells.push(value.slice(cursor).trim());
  if (value.startsWith("|")) cells.shift();
  if (value.endsWith("|") && !isEscapedMarkdownStart(value, value.length - 1)) cells.pop();
  return cells;
}

function isMarkdownTableBoundary(header, delimiter) {
  const heading = markdownTableCells(header), cells = markdownTableCells(delimiter);
  return Boolean(heading && cells && heading.length === cells.length && cells.length && cells.every(cell => /^:?-+:?$/.test(cell)));
}

// GFM raw HTML blocks cannot supply a live Markdown status-table row.
function isRawHtmlRowContext(body, index, markdownOnly = false) {
  let prefix = withoutHtmlComments(body.slice(0, index));
  if (markdownOnly) prefix = stripMarkdownContainers(prefix, true);
  const blockTags = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));
  const voidTags = new Set("area base basefont br col embed frame hr img input link meta param source track wbr".split(" "));
  const containers = [];
  let until = null;
  let untilBlank = false;
  let paragraph = false;
  let tableActive = false;
  let previousContent = "";
  let offset = 0;
  for (const line of (prefix.endsWith("\n") ? prefix.slice(0, -1) : prefix).split("\n")) {
    const lineOffset = offset;
    offset += line.length + 1;
    if (isProtocolCodeExample(prefix, lineOffset + (line.match(/^ */)?.[0].length || 0))) { paragraph = false; continue; }
    if (until) { if (until.test(line)) until = null; paragraph = false; continue; }
    const raw = line.match(/^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i);
    if (raw) {
      const end = new RegExp("</" + raw[1] + "\\s*>", "i");
      if (!end.test(line)) until = end;
      paragraph = false;
      continue;
    }
    if (/^ {0,3}<\?/.test(line)) { if (!line.includes("?>")) until = /\?>/; paragraph = false; continue; }
    if (/^ {0,3}<!\[CDATA\[/.test(line)) { if (!line.includes("]]>")) until = /\]\]>/; paragraph = false; continue; }
    if (/^ {0,3}<![A-Z]/.test(line)) { if (!line.includes(">")) until = />/; paragraph = false; continue; }
    if (!line.trim() && !(markdownOnly && !prefix.endsWith("\n") && offset > prefix.length)) untilBlank = false;
    const start = line.match(/^ {0,3}<\/?([a-z][a-z0-9-]*)(?=[\s/>]|$)/i);
    const completeTag = /^ {0,3}<\/?[a-z][a-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>[ \t]*$/i.test(line);
    if (start && (blockTags.has(start[1].toLowerCase()) || (!paragraph && completeTag))) untilBlank = true;
    if (isMarkdownTableBoundary(previousContent, line)) tableActive = true;
    else if (tableActive && !line.includes("|")) tableActive = false;
    paragraph = !tableActive && !untilBlank && !!line.trim() && !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/.test(line);
    previousContent = line;
    if (start || containers.length) {
      for (const tag of line.matchAll(/<\/?([a-z][a-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
        const name = tag[1].toLowerCase();
        if (tag[0].startsWith("</")) {
          const opened = containers.lastIndexOf(name);
          if (opened !== -1) containers.splice(opened, 1);
        } else if (!voidTags.has(name) && !tag[0].endsWith("/>")) containers.push(name);
      }
    }
  }
  return Boolean(until || untilBlank || (!markdownOnly && containers.length));
}

// Fractional input must not extend the server observation into a later second.
function observationSecondEnd(observed) {
  return (Math.floor(observed / 1000) + 1) * 1000;
}

// Completion cannot predate the comment that carries it. GitHub timestamps
// have second precision while rendered completion rows may include fractions.
function completionWithinComment(comment, completed) {
  const created = Date.parse(comment.created_at || "");
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  return Number.isFinite(completed) && Number.isFinite(created) && Number.isFinite(observed) &&
    Math.floor(completed / 1000) >= Math.floor(created / 1000) && completed < observationSecondEnd(observed);
}

function codeReviewCompletedAt(body, headSha, section = "code_review") {
  const renderedLabel = section === "security_review" ? "Security Review" : "Code Review";
  if (String(body).split("\n").filter((line) => hasRenderedCodexSectionRow(line, renderedLabel)).length !== 1) return NaN;
  body = body.replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (section === "security_review") body = body.replaceAll("📝 **Code Review**", "ignored-code-row").replaceAll("🛡️ **Security Review**", "📝 **Code Review**").replaceAll("🔒 **Security Review**", "📝 **Code Review**");
  const rows = [...body.matchAll(/^\| 📝 \*\*Code Review\*\* \| ✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">([^<]+)<\/relative-time> \| `([a-f0-9]{7,40})` \| [^|\r\n]+ \|$/gm)];
  if (rows.length !== 1 || (body.match(/\*\*Code Review\*\*/g) || []).length !== 1) return NaN;
  if (isProtocolCodeExample(body, rows[0].index)) return NaN;
  const preceding = body.slice(0, rows[0].index);
  if (preceding.lastIndexOf("<!--") > preceding.lastIndexOf("-->")) return NaN;
  if (isRawHtmlRowContext(body, rows[0].index)) return NaN;
  const [, timestamp, visibleTime, sha] = rows[0];
  if (timestamp !== visibleTime || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp) || !headSha.startsWith(sha)) return NaN;
  const completed = Date.parse(timestamp);
  return Number.isFinite(completed) && new Date(completed).toISOString().slice(0, 19) === timestamp.slice(0, 19) ? completed : NaN;
}

/** Affirmative machine evidence has a closed schema and the full current SHA.
 * Prose, reactions and the visible Completed heading never grant approval. */
function isProtocolCodeExample(rawBody, index) {
  const prefix = rawBody.slice(rawBody.lastIndexOf("\n", index - 1) + 1, index).replace(/[^\S\r\n\t]/g, " ");
  if (/^[ \t]*$/.test(prefix) && (prefix.includes("\t") || prefix.length >= 4)) return true;
  let fence = null;
  for (const line of rawBody.slice(0, index).replace(/\uFEFF/g, "").split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (!fence) {
      if (match[1][0] === "`" && match[2].includes("`")) continue;
      fence = match[1];
    } else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  return fence !== null;
}

function hasCodeProtocolEnvelope(rawBody) {
  // Markdown code is not an active protocol envelope. Check before trim.
  let count = 0;
  for (const marker of rawBody.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (!/^codex[-:]/i.test(marker[1].trim())) continue;
    if (count++ >= 2) break;
    if (isProtocolCodeExample(rawBody, marker.index)) return true;
  }
  return false;
}

export function isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId) {
  if (!isTrustedCodexLogin(comment?.user?.login) || !/^[a-f0-9]{40}$/.test(headSha)) return false;
  if (hasCodeProtocolEnvelope(String(comment?.body || ""))) return false;
  const body = String(comment?.body || "").trim();
  const match = body.match(/^<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!match || !isCanonicalCodexPresentation(body, typedCodexReviewState(comment, { negativeOnly: true })) || (body.match(/<!--/g) || []).length !== 2 ||
      (body.match(/codex-review-state:/g) || []).length !== 1 ||
      (body.match(/codex-pull-request-review-summary/g) || []).length !== 1 ||
      /Codex Review:|\*\*Reviewed commit:/i.test(body)) return false;
  const presentation = body.slice(match[0].length).replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (!/^(?:[ \t]*\r?\n)* {0,3}## Codex Review Summary\b/.test(presentation)) return false;
  if ([...presentation.matchAll(/\b[a-f0-9]{7,40}\b/gi)].some(([sha]) => !headSha.startsWith(sha))) return false;
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  const requested = Date.parse(requestedAt || "");
  const completed = codeReviewCompletedAt(body, headSha);
  if (!Number.isFinite(completed) || Math.floor(completed / 1000) <= Math.floor(requested / 1000) || !completionWithinComment(comment, completed) ||
      !Number.isFinite(observed) || !Number.isFinite(requested) ||
      !(observed > requested || (observed === requested && compareNumericIds(comment.id, requestCommentId) > 0))) return false;
  try {
    const state = JSON.parse(match[1]);
    const keys = Object.keys(state);
    if (keys.length !== 2 || !keys.includes("code_review") || !keys.includes("security_review")) return false;
    // Count decoded property names as well: JSON.parse alone accepts duplicate
    // keys, including keys escaped with Unicode sequences.
    const names = [...match[1].matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map((entry) => JSON.parse(entry[1]));
    const expected = { code_review: 1, security_review: 1, commit_sha: 2, has_any_findings: 2, has_unresolved_findings: 2, status: 2 };
    if (names.length !== 10 || Object.entries(expected).some(([key, count]) => names.filter((name) => name === key).length !== count)) return false;
    const closed = (value) => value && !Array.isArray(value) && Object.keys(value).length === 4 &&
      ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"].every((key) => Object.hasOwn(value, key));
    const complete = (value) => closed(value) && value.commit_sha === headSha && value.status === "completed" &&
      value.has_any_findings === false && value.has_unresolved_findings === false;
    const absent = (value) => closed(value) && Object.values(value).every((entry) => entry === null);
    const securityCompleted = codeReviewCompletedAt(body, headSha, "security_review");
    return complete(state.code_review) && ((absent(state.security_review) && !hasRenderedCodexSectionRow(body, "Security Review")) ||
      (complete(state.security_review) && Number.isFinite(securityCompleted) && securityCompleted < observationSecondEnd(observed)));
  } catch { return false; }
}

// Historical findings must be well-formed typed state for this exact head;
// stale malformed/foreign-head summaries are not persistent vetoes.
function typedCodexReviewState(comment, { negativeOnly = false } = {}) {
  const rawBody = String(comment.body || "");
  if (hasCodeProtocolEnvelope(rawBody)) return null;
  const body = rawBody.replace(/<!--([\s\S]*?)-->/g, (marker, content, index) =>
    /^codex[-:]/i.test(content.trim()) && isProtocolCodeExample(rawBody, index) ? "" : marker).trim();
  const envelope = body.replace(/<!--([\s\S]*?)-->/g, (marker, content) => /^codex[-:]/i.test(content.trim()) ? marker : "").trim();
  const match = envelope.match(/^<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[\s\S]*?\}) -->\s*## Codex Review Summary\b/);
  // Trailing presentation cannot erase proven negative facts. Clearing keeps
  // the default whole-body protocol validation and original-body approval checks.
  const protocolBody = negativeOnly && match ? match[0] : body;
  const protocol = [...protocolBody.matchAll(/<!--([\s\S]*?)-->/g)].filter((entry) => /^codex[-:]/i.test(entry[1].trim()));
  if (!match || protocol.length !== 2 ||
      (protocolBody.match(/<!-- codex-pull-request-review-summary -->/g) || []).length !== 1 ||
      !/^ {0,3}## Codex Review Summary\b/m.test(body) ||
      /Codex Review:|\*\*Reviewed commit:/.test(protocolBody)) return null;
  try {
    const state = JSON.parse(match[1]);
    const names = [...match[1].matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map((entry) => JSON.parse(entry[1]));
    const expected = { code_review: 1, security_review: 1, commit_sha: 2, has_any_findings: 2, has_unresolved_findings: 2, status: 2 };
    if (names.length !== 10 || Object.entries(expected).some(([key, count]) => names.filter((name) => name === key).length !== count) ||
        Object.keys(state).length !== 2) return null;
    const valid = (value) => value && !Array.isArray(value) && Object.keys(value).length === 4 &&
      ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"].every((key) => Object.hasOwn(value, key)) &&
      (Object.values(value).every((entry) => entry === null) ||
        (/^[a-f0-9]{40}$/.test(value.commit_sha) &&
          ((value.status === "completed" && ((typeof value.has_any_findings === "boolean" && typeof value.has_unresolved_findings === "boolean") || (value.has_any_findings === null && value.has_unresolved_findings === null))) ||
           (value.status === "running" && value.has_any_findings === null && value.has_unresolved_findings === null))));
    if (!valid(state.code_review) || !valid(state.security_review)) return null;
    for (const section of ["code_review", "security_review"]) {
      if (negativeOnly || state[section].status !== "completed") continue;
      const completed = codeReviewCompletedAt(body, state[section].commit_sha, section);
      const observed = Date.parse(comment.updated_at || comment.created_at || "");
      if (!Number.isFinite(completed) || !Number.isFinite(observed) || completed >= observationSecondEnd(observed)) return null;
    }
    return state;
  } catch { return null; }
}

// Validate a section's clearing proof with the same presentation checks as
// approval, while allowing an independently pending/absent other section.
function isSectionClearingState(comment, section, headSha) {
  const state = typedCodexReviewState(comment);
  const originalBody = String(comment.body || "");
  if (!state || !isCanonicalCodexPresentation(originalBody, state)) return false;
  const body = withoutNativeHelp(originalBody);
  const encodedMatch = body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!encodedMatch) return false;
  const encoded = encodedMatch[1];
  const absent = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null };
  const other = section === "code_review" ? "Security Review" : "Code Review";
  const otherSection = section === "code_review" ? "security_review" : "code_review";
  const otherIcon = other === "Code Review" ? "📝" : body.split("\n").some(line => line.startsWith("| 🔒 **Security Review** | ")) ? "🔒" : "🛡️";
  const otherPrefix = "| " + otherIcon + " **" + other + "** | ";
  if (state[otherSection].status === "completed" && state[otherSection].has_any_findings === false && state[otherSection].has_unresolved_findings === false) {
    const companion = body.split("\n").find((line) => line.startsWith(otherPrefix));
    if (!companion) return false;
  }
  // Only a unique validated completed counterpart row scopes its severity.
  // Global prose and unvalidated rows remain ambiguous vetoes.
  const severityBody = state[otherSection].status === "completed"
    ? body.split("\n").filter((line) => !line.startsWith(otherPrefix)).join("\n") : body;
  if (/\bP[0-2]\b/i.test(visibleCodexReviewText(severityBody))) return false;
  const otherRows = body.split("\n").filter((line) => visibleCodexReviewText(line).toLowerCase().includes(other.toLowerCase()));
  if (otherRows.some((line) => !line.startsWith(otherPrefix))) return false;
  if (otherRows.length && state[otherSection].status !== "completed") {
    if (state[otherSection].status !== "running") return false;
    if (otherRows.length !== 1 || !otherRows[0].startsWith(otherPrefix + "🔄 **Running** since <relative-time")) return false;
    const running = body.replaceAll(" | 🔄 **Running** since <relative-time", " | ✅ **Completed** <relative-time");
    const started = codeReviewCompletedAt(running, state[otherSection].commit_sha, otherSection);
    const observed = Date.parse(comment.updated_at || comment.created_at || "");
    if (!Number.isFinite(started) || !Number.isFinite(observed) || started >= observationSecondEnd(observed)) return false;
  }
  let normalized = body.replace(encoded, JSON.stringify({ code_review: state[section], security_review: absent }))
    .split("\n").filter((line) => !line.startsWith(otherPrefix)).join("\n");
  if (section === "security_review") normalized = normalized.replaceAll("🛡️ **Security Review**", "📝 **Code Review**").replaceAll("🔒 **Security Review**", "📝 **Code Review**");
  return isAffirmativeCodexReviewState({ ...comment, body: normalized }, headSha, "1970-01-01T00:00:00Z", 0);
}

function findingCompletedAt(comment, section, headSha) {
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  const state = typedCodexReviewState(comment, { negativeOnly: true });
  if (!isCanonicalCodexPresentation(comment.body, state)) return observed;
  // A carried companion may predate this comment, but cannot complete after
  // its server observation. A future companion invalidates backdating only.
  const companion = section === "code_review" ? "security_review" : "code_review";
  if (state[companion].status === "completed") {
    const completed = codeReviewCompletedAt(String(comment.body || ""), state[companion].commit_sha, companion);
    if (!Number.isFinite(completed) || !Number.isFinite(observed) || completed >= observationSecondEnd(observed)) return observed;
  }
  const label = section === "code_review" ? "Code Review" : "Security Review";
  const ownRow = String(comment.body).split("\n").find(line => line.includes("**" + label + "**"));
  if (!/\| (?:Manual request|PR opened) \|$/.test(ownRow || "")) return observed;
  const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
  return completionWithinComment(comment, completed) ? completed : observed;
}

function latestCodexCommentResult(comments, headSha, requestedAt, requestCommentId, nativeCompletedAt = NaN) {
  const signals = comments.filter((comment) => isTrustedCodexLogin(comment?.user?.login));
  const summaries = signals.filter((comment) => /codex-pull-request-review-summary|codex-review-state:/i.test(String(comment.body || "")) &&
    Date.parse(comment.updated_at || comment.created_at || "") >= Date.parse(requestedAt || ""));
  summaries.sort((a, b) => (Date.parse(b.updated_at || b.created_at || "") || 0) -
    (Date.parse(a.updated_at || a.created_at || "") || 0) || compareNumericIds(b.id, a.id));
  const receiptObservedAt = (comment) => Date.parse(isAcceptableCodexSummaryComment(comment, headSha)
    ? comment.created_at || "" : comment.updated_at || comment.created_at || "");
  const receipts = signals.filter((comment) => /Codex Review:|codex-review-receipt:/i.test(String(comment.body || "")) &&
    (isAcceptableCodexSummaryComment(comment, headSha)
      ? isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId)
      : receiptObservedAt(comment) >= Date.parse(requestedAt || "")));
  const isReceiptCandidate = (comment) => {
    const body = String(comment.body || "");
    const match = body.match(/(Codex Review: Didn't find any major issues\.)([^\r\n]*)/i);
    if (!match || (match[2] && !match[2].startsWith(" ")) || match[2].length > 121 ||
        (body.match(/Codex Review:/gi) || []).length !== 1 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>{}\[\]`*=\\/|]/u.test(match[2]) ||
        /\b[a-f0-9]{7,40}\b/i.test(match[2]) || containsBlockingCodexSeverity(body)) return false;
    return isAcceptableCodexSummaryComment({ ...comment, body: body.replace(match[0], match[1]) }, headSha);
  };
  // Unknown closings remain pending evidence. Only a strictly newer complete
  // machine summary supersedes one; a later receipt needs a fresh summary.
  // Malformed envelopes and explicit P0-P2 findings remain unconditional vetoes.
  if (receipts.some((comment) => !isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId) && !isReceiptCandidate(comment))) return "pending";
  const unpairedLifecycles = [];
  const usableSummaries = summaries.filter(comment => {
    const state = typedCodexReviewState(comment);
    const value = state?.code_review;
    const other = state?.security_review;
    const lifecycle = value?.commit_sha === headSha && value.status === "completed" &&
      value.has_any_findings === null && value.has_unresolved_findings === null &&
      other?.status === null && isCanonicalCodexPresentation(comment.body, state) &&
      completionWithinComment(comment, codeReviewCompletedAt(comment.body, headSha));
    const completed = codeReviewCompletedAt(comment.body, headSha);
    const created = Date.parse(comment.created_at || "");
    const requested = Date.parse(requestedAt || "");
    const paired = lifecycle && Math.floor(completed / 1000) > Math.floor(requested / 1000) &&
      receipts.some(receipt => {
        const time = Date.parse(receipt.created_at || "");
        return isAcceptableCodexSummaryComment(receipt, headSha, requestedAt, requestCommentId) &&
          Date.parse(receipt.updated_at || receipt.created_at || "") === time &&
          Number.isFinite(created) && time >= created && time <= completed;
      });
    if (lifecycle && !paired) unpairedLifecycles.push(comment);
    return !paired;
  });
  // A code-only lifecycle is retired by newer canonical code proof; the
  // independent security finding remains governed by its own clear below.
  if (unpairedLifecycles.some(comment => !summaries.some(clear =>
    isSectionClearingState(clear, "code_review", headSha) &&
    Math.floor(codeReviewCompletedAt(clear.body, headSha) / 1000) >
      Math.floor(Date.parse(comment.updated_at || comment.created_at || "") / 1000)))) return "pending";
  const candidates = [...usableSummaries, ...receipts];
  const observed = (comment) => {
    const state = typedCodexReviewState(comment, { negativeOnly: true });
    const findings = ["code_review", "security_review"].filter((section) => state?.[section]?.commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true));
    if (findings.length && ![state.code_review, state.security_review].some((value) => value.status === "running")) return Math.max(...findings.map((section) => findingCompletedAt(comment, section, headSha)));
    return summaries.includes(comment) &&
    isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId)
    ? codeReviewCompletedAt(String(comment.body || ""), headSha)
    : summaries.includes(comment) ? Date.parse(comment.updated_at || comment.created_at || "") : receiptObservedAt(comment);
  };
  // Positive receipt edits never renew approval. Unknown or negative edits
  // retain their update time so they can invalidate an older completion.
  // GitHub comment timestamps have second precision while completion rows
  // include microseconds. Compare second buckets so uncertainty stays pending.
  const bucket = (comment) => Math.floor(observed(comment) / 1000);
  const latestTime = Math.max(...candidates.map(bucket));
  // A strictly newer formal clean review is independent affirmative evidence.
  // Same-second ambiguity and newer pending comments still prevent approval.
  const sections = ["code_review", "security_review"];
  // Historical clean proof only resolves historical findings; it cannot grant
  // current-request approval, which still uses candidates above.
  const cleanSummaries = signals.filter((comment) => typedCodexReviewState(comment));
  const lastAffirmativeTime = (section) => Math.max(...cleanSummaries.filter((comment) => {
    const value = typedCodexReviewState(comment)?.[section];
    return value?.commit_sha === headSha && value.status === "completed" &&
      value.has_any_findings === false && value.has_unresolved_findings === false &&
      isSectionClearingState(comment, section, headSha);
  }).map((comment) => {
    const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
    const observed = Date.parse(comment.updated_at || comment.created_at || "");
    return completionWithinComment(comment, completed) ? Math.floor(completed / 1000) : -Infinity;
  }));
  const historical = signals.filter((comment) => {
    const state = typedCodexReviewState(comment, { negativeOnly: true });
    return sections.some((section) => state?.[section]?.commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true));
  });
  const findingSignals = [...new Set([...summaries, ...historical])];
  const unclearedFindings = findingSignals.some((comment) => {
    const state = typedCodexReviewState(comment, { negativeOnly: true });
    const observedBucket = Math.floor(Date.parse(comment.updated_at || comment.created_at || "") / 1000);
    if (state) return sections.some((section) => state[section].commit_sha === headSha &&
      (state[section].has_any_findings === true || state[section].has_unresolved_findings === true) &&
      Math.floor(findingCompletedAt(comment, section, headSha) / 1000) >= lastAffirmativeTime(section));
    // Malformed current-request negative evidence retains its existing veto.
    return summaries.includes(comment) && observedBucket >= Math.max(...summaries.filter((entry) => isAffirmativeCodexReviewState(entry, headSha, requestedAt, requestCommentId)).map(bucket)) &&
      [...String(comment.body || "").matchAll(/("(?:\\.|[^"\\])*")\s*:\s*(true|false|null)/g)].some((entry) => {
        if (entry[2] !== "true") return false;
        try { return ["has_any_findings", "has_unresolved_findings"].includes(JSON.parse(entry[1])); }
        catch { return true; }
      });
  });
  // Code-only formal approval cannot revise an explicit code/security finding.
  // Only a newer affirmative structured state clears that independent signal.
  if (unclearedFindings) return "pending";
  if (!candidates.length) return null;
  if (Math.floor(nativeCompletedAt / 1000) > latestTime) return "pass";
  const latest = candidates.filter((comment) => bucket(comment) === latestTime);
  return latest.every((comment) => summaries.includes(comment)
    ? isAffirmativeCodexReviewState(comment, headSha, requestedAt, requestCommentId)
    : isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId)) ? "pass" : "pending";
}

export function evaluateCodexReviewEvidence({ comments, reviews, reviewComments, threads, headSha }) {
  /* A new request must not erase existing findings, including outdated and
     P3 threads. Resolved state comes from GitHub, not comment prose. */
  if (threads.some((thread) => !thread.isResolved &&
      thread.comments.nodes.some((comment) => comment.author?.__typename === "Bot" &&
        comment.author.login === "chatgpt-codex-connector"))) return "fail";
  /* Body-only findings have no resolvable thread. A later clean review or
     request on the same tree cannot prove that their cause was fixed. */
  if (reviews.some((review) => classifyCodexNativeReview(review, [], headSha) === "fail")) return "fail";
  if (latestCodexNativeReviewResult(reviews, reviewComments, headSha) === "fail") return "fail";

  const request = latestTrustedCodexReviewCommand(comments, headSha);
  if (!request) return "missing_request";
  const afterRequest = reviews.filter((review) =>
    isStrictlyAfterCodexReviewRequest(review.submitted_at, request));
  const nativeResult = latestCodexNativeReviewResult(afterRequest, reviewComments, headSha);
  if (nativeResult === "fail") return nativeResult;
  const nativeCompletedAt = nativeResult === "pass" ? Math.max(...afterRequest.filter((review) =>
    classifyCodexNativeReview(review, reviewComments, headSha) === "pass"
  ).map((review) => Date.parse(review.submitted_at || ""))) : NaN;
  const commentResult = latestCodexCommentResult(comments, headSha, request.requestedAt, request.commentId, nativeCompletedAt);
  return commentResult === "pending" ? "pending" : nativeResult || commentResult || "pending";
}
