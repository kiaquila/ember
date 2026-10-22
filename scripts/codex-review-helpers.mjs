/* Pure helpers behind the Codex Review gate: who may ask for a review, what
   counts as Codex's answer, and whether that answer blocks the pull request.
   Kept free of I/O so the gate's rules can be tested directly. */

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CODEX_REVIEW_LOGIN = "chatgpt-codex-connector[bot]";
const POSITIVE_RECEIPT_SUFFIXES = new Set([
  "", ":rocket:", ":tada:", "🚀", "🎉", "👍", "keep it up!", "hooray!",
  "more of your lovely prs please.", "nice work!", "great work!", "great job!",
  "well done!", "looks good!", "looking good!", "you're on fire!", "you’re on fire!",
  "you rock!", "keep up the good work!", "happy merging!", "all good!", "ship it!",
  "another round soon, please!", "you're on a roll.", "you’re on a roll.",
  "already looking forward to the next diff.", "breezy!",
  "what shall we delve into next?", "can't wait for the next one!", ":+1:"
]);

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
const HTML_SPACING_ENTITIES = {"ApplyFunction": "\u2061", "InvisibleComma": "\u2063", "InvisibleTimes": "\u2062", "MediumSpace": "\u205f", "NegativeMediumSpace": "\u200b", "NegativeThickSpace": "\u200b", "NegativeThinSpace": "\u200b", "NegativeVeryThinSpace": "\u200b", "NewLine": "\n", "NoBreak": "\u2060", "NonBreakingSpace": "\u00a0", "Tab": "\t", "ThickSpace": "\u205f\u200a", "ThinSpace": "\u2009", "VeryThinSpace": "\u200a", "ZeroWidthSpace": "\u200b", "af": "\u2061", "emsp": "\u2003", "emsp13": "\u2004", "emsp14": "\u2005", "ensp": "\u2002", "hairsp": "\u200a", "ic": "\u2063", "it": "\u2062", "lrm": "\u200e", "nbsp": "\u00a0", "numsp": "\u2007", "puncsp": "\u2008", "rlm": "\u200f", "shy": "\u00ad", "thinsp": "\u2009", "zwj": "\u200d", "zwnj": "\u200c"};
function isEscapedMarkdownStart(text, index) {
  return ((text.slice(0, index).match(/\\+$/)?.[0].length || 0) % 2) === 1;
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

// CommonMark delimiter runs: flanking, intraword underscores, and rule of three.
function activeMarkdownEmphasis(text) {
  const removed = new Set();
  const runs = [];
  const whitespace = (value) => !value || /\s/u.test(value);
  const punctuation = (value) => !!value && /[\p{P}\p{S}]/u.test(value);
  const escaped = (index) => ((text.slice(0, index).match(/\\+$/)?.[0].length || 0) % 2) === 1;
  // Matched code-span delimiters disappear; their literal content is protected
  // by the existing code-context stage before this projection.
  const ticks = [...text.matchAll(/`+/g)];
  let consumed = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    const start = ticks[i];
    if (start.index < consumed || escaped(start.index)) continue;
    const end = ticks.slice(i + 1).find((run) => run[0].length === start[0].length);
    if (!end) continue;
    for (let j = 0; j < start[0].length; j += 1) { removed.add(start.index + j); removed.add(end.index + j); }
    consumed = end.index + end[0].length;
  }
  for (const match of text.matchAll(/\*+|_+|~{2,}/g)) {
    if (escaped(match.index)) continue;
    const before = [...text.slice(0, match.index)].at(-1) || "";
    const after = [...text.slice(match.index + match[0].length)][0] || "";
    const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
    const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
    runs.push({ character: match[0][0], start: match.index, length: match[0].length, usedOpen: 0, usedClose: 0,
      open: match[0][0] === "_" ? left && (!right || punctuation(before)) : left,
      close: match[0][0] === "_" ? right && (!left || punctuation(after)) : right });
  }
  for (let closeIndex = 0; closeIndex < runs.length; closeIndex += 1) {
    const closer = runs[closeIndex];
    if (!closer.close) continue;
    for (let openIndex = closeIndex - 1; openIndex >= 0 && closer.length - closer.usedClose >= (closer.character === "~" ? 2 : 1); openIndex -= 1) {
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
  }
  return text.split("").map((character, index) => removed.has(index) ? "" : character).join("");
}

function preserveLiteralMarkdownLinks(text) {
  const spans = [];
  let consumed = 0;
  const ticks = [...text.matchAll(/`+/g)];
  for (let i = 0; i < ticks.length; i += 1) {
    const start = ticks[i];
    if (start.index < consumed || isEscapedMarkdownStart(text, start.index)) continue;
    const end = ticks.slice(i + 1).find((entry) => entry[0].length === start[0].length);
    if (!end) continue;
    spans.push([start.index, end.index + end[0].length]);
    consumed = end.index + end[0].length;
  }
  for (const tag of text.matchAll(/<(code|pre|script|style|textarea)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tail = text.slice(tag.index + tag[0].length);
    const close = tail.search(new RegExp("</" + tag[1] + "\\s*>", "i"));
    spans.push([tag.index + tag[0].length, close === -1 ? text.length : tag.index + tag[0].length + close]);
  }
  return text.replace(/[&<\[*_~]/g, (bracket, index) => {
    const context = stripMarkdownContainers(text.slice(0, index));
    const indentation = context.slice(context.lastIndexOf("\n") + 1).match(/^[ \t]*/)[0];
    return (/[\[*_~]/.test(bracket) && isRawHtmlRowContext(text, index, true)) ||
      spans.some(([start, end]) => index >= start && index < end) ||
      indentation.includes("\t") || indentation.length >= 4 ||
      isProtocolCodeExample(context, context.length) ? "&#" + bracket.codePointAt(0) + ";" : bracket;
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
  return !(/[ \t\r\n\f\v]/.test(bare) && !titled) && !(/[<>]/.test(linkTarget) && !/^<[^<>\r\n]*>$/.test(linkTarget));
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
  if (projectFootnotes) text = visibleFootnoteBodies(text);
  let result = "";
  let consumed = 0;
  for (const match of text.matchAll(/\[((?:\\.|[^\]\\])*)\]\(/g)) {
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
// Valid semicolon-terminated HTML5 names take precedence over legacy prefixes.
const HTML_ENTITY_NAMES = new Set([
  "AElig|AMP|Aacute|Abreve|Acirc|Acy|Afr|Agrave|Alpha|Amacr|And|Aogon|Aopf|ApplyFunction|Aring|Ascr|Assign|Atilde|Auml|Backslash|Barv|Barwed|Bcy|Because|Bernoullis|Beta|Bfr|Bopf|Breve|Bscr|Bumpeq|CHcy|COPY|Cacute|Cap|CapitalDifferentialD|Cayleys|Ccaron|Ccedil|Ccirc|Cconint|Cdot|Cedilla|CenterDot|Cfr|Chi|CircleDot|CircleMinus|CirclePlus|CircleTimes|ClockwiseContourIntegral|CloseCurlyDoubleQuote|CloseCurlyQuote|Colon|Colone|Congruent|Conint|ContourIntegral|Copf|Coproduct|CounterClockwiseContourIntegral|Cross|Cscr|Cup|CupCap|DD|DDotrahd|DJcy|DScy|DZcy|Dagger|Darr|Dashv|Dcaron|Dcy|Del|Delta|Dfr|DiacriticalAcute|DiacriticalDot",
  "DiacriticalDoubleAcute|DiacriticalGrave|DiacriticalTilde|Diamond|DifferentialD|Dopf|Dot|DotDot|DotEqual|DoubleContourIntegral|DoubleDot|DoubleDownArrow|DoubleLeftArrow|DoubleLeftRightArrow|DoubleLeftTee|DoubleLongLeftArrow|DoubleLongLeftRightArrow|DoubleLongRightArrow|DoubleRightArrow|DoubleRightTee|DoubleUpArrow|DoubleUpDownArrow|DoubleVerticalBar|DownArrow|DownArrowBar|DownArrowUpArrow|DownBreve|DownLeftRightVector|DownLeftTeeVector|DownLeftVector|DownLeftVectorBar|DownRightTeeVector|DownRightVector|DownRightVectorBar|DownTee|DownTeeArrow|Downarrow|Dscr|Dstrok|ENG|ETH|Eacute|Ecaron|Ecirc|Ecy|Edot|Efr|Egrave|Element|Emacr|EmptySmallSquare|EmptyVerySmallSquare|Eogon|Eopf|Epsilon|Equal|EqualTilde|Equilibrium|Escr|Esim|Eta|Euml|Exists|ExponentialE|Fcy|Ffr|FilledSmallSquare|FilledVerySmallSquare|Fopf|ForAll|Fouriertrf|Fscr|GJcy|GT|Gamma|Gammad|Gbreve|Gcedil|Gcirc|Gcy",
  "Gdot|Gfr|Gg|Gopf|GreaterEqual|GreaterEqualLess|GreaterFullEqual|GreaterGreater|GreaterLess|GreaterSlantEqual|GreaterTilde|Gscr|Gt|HARDcy|Hacek|Hat|Hcirc|Hfr|HilbertSpace|Hopf|HorizontalLine|Hscr|Hstrok|HumpDownHump|HumpEqual|IEcy|IJlig|IOcy|Iacute|Icirc|Icy|Idot|Ifr|Igrave|Im|Imacr|ImaginaryI|Implies|Int|Integral|Intersection|InvisibleComma|InvisibleTimes|Iogon|Iopf|Iota|Iscr|Itilde|Iukcy|Iuml|Jcirc|Jcy|Jfr|Jopf|Jscr|Jsercy|Jukcy|KHcy|KJcy|Kappa|Kcedil|Kcy|Kfr|Kopf|Kscr|LJcy|LT|Lacute|Lambda|Lang|Laplacetrf|Larr|Lcaron|Lcedil|Lcy|LeftAngleBracket|LeftArrow|LeftArrowBar|LeftArrowRightArrow|LeftCeiling",
  "LeftDoubleBracket|LeftDownTeeVector|LeftDownVector|LeftDownVectorBar|LeftFloor|LeftRightArrow|LeftRightVector|LeftTee|LeftTeeArrow|LeftTeeVector|LeftTriangle|LeftTriangleBar|LeftTriangleEqual|LeftUpDownVector|LeftUpTeeVector|LeftUpVector|LeftUpVectorBar|LeftVector|LeftVectorBar|Leftarrow|Leftrightarrow|LessEqualGreater|LessFullEqual|LessGreater|LessLess|LessSlantEqual|LessTilde|Lfr|Ll|Lleftarrow|Lmidot|LongLeftArrow|LongLeftRightArrow|LongRightArrow|Longleftarrow|Longleftrightarrow|Longrightarrow|Lopf|LowerLeftArrow|LowerRightArrow|Lscr|Lsh|Lstrok|Lt|Map|Mcy|MediumSpace|Mellintrf|Mfr|MinusPlus|Mopf|Mscr|Mu|NJcy|Nacute|Ncaron|Ncedil|Ncy|NegativeMediumSpace|NegativeThickSpace|NegativeThinSpace|NegativeVeryThinSpace|NestedGreaterGreater|NestedLessLess|NewLine|Nfr|NoBreak|NonBreakingSpace|Nopf|Not|NotCongruent|NotCupCap|NotDoubleVerticalBar|NotElement|NotEqual|NotEqualTilde|NotExists|NotGreater|NotGreaterEqual|NotGreaterFullEqual",
  "NotGreaterGreater|NotGreaterLess|NotGreaterSlantEqual|NotGreaterTilde|NotHumpDownHump|NotHumpEqual|NotLeftTriangle|NotLeftTriangleBar|NotLeftTriangleEqual|NotLess|NotLessEqual|NotLessGreater|NotLessLess|NotLessSlantEqual|NotLessTilde|NotNestedGreaterGreater|NotNestedLessLess|NotPrecedes|NotPrecedesEqual|NotPrecedesSlantEqual|NotReverseElement|NotRightTriangle|NotRightTriangleBar|NotRightTriangleEqual|NotSquareSubset|NotSquareSubsetEqual|NotSquareSuperset|NotSquareSupersetEqual|NotSubset|NotSubsetEqual|NotSucceeds|NotSucceedsEqual|NotSucceedsSlantEqual|NotSucceedsTilde|NotSuperset|NotSupersetEqual|NotTilde|NotTildeEqual|NotTildeFullEqual|NotTildeTilde|NotVerticalBar|Nscr|Ntilde|Nu|OElig|Oacute|Ocirc|Ocy|Odblac|Ofr|Ograve|Omacr|Omega|Omicron|Oopf|OpenCurlyDoubleQuote|OpenCurlyQuote|Or|Oscr|Oslash|Otilde|Otimes|Ouml|OverBar|OverBrace|OverBracket|OverParenthesis|PartialD|Pcy|Pfr|Phi|Pi|PlusMinus|Poincareplane|Popf|Pr|Precedes|PrecedesEqual|PrecedesSlantEqual|PrecedesTilde",
  "Prime|Product|Proportion|Proportional|Pscr|Psi|QUOT|Qfr|Qopf|Qscr|RBarr|REG|Racute|Rang|Rarr|Rarrtl|Rcaron|Rcedil|Rcy|Re|ReverseElement|ReverseEquilibrium|ReverseUpEquilibrium|Rfr|Rho|RightAngleBracket|RightArrow|RightArrowBar|RightArrowLeftArrow|RightCeiling|RightDoubleBracket|RightDownTeeVector|RightDownVector|RightDownVectorBar|RightFloor|RightTee|RightTeeArrow|RightTeeVector|RightTriangle|RightTriangleBar|RightTriangleEqual|RightUpDownVector|RightUpTeeVector|RightUpVector|RightUpVectorBar|RightVector|RightVectorBar|Rightarrow|Ropf|RoundImplies|Rrightarrow|Rscr|Rsh|RuleDelayed|SHCHcy|SHcy|SOFTcy|Sacute|Sc|Scaron|Scedil|Scirc|Scy|Sfr|ShortDownArrow|ShortLeftArrow|ShortRightArrow|ShortUpArrow|Sigma|SmallCircle|Sopf|Sqrt|Square|SquareIntersection|SquareSubset|SquareSubsetEqual|SquareSuperset|SquareSupersetEqual|SquareUnion|Sscr",
  "Star|Sub|Subset|SubsetEqual|Succeeds|SucceedsEqual|SucceedsSlantEqual|SucceedsTilde|SuchThat|Sum|Sup|Superset|SupersetEqual|Supset|THORN|TRADE|TSHcy|TScy|Tab|Tau|Tcaron|Tcedil|Tcy|Tfr|Therefore|Theta|ThickSpace|ThinSpace|Tilde|TildeEqual|TildeFullEqual|TildeTilde|Topf|TripleDot|Tscr|Tstrok|Uacute|Uarr|Uarrocir|Ubrcy|Ubreve|Ucirc|Ucy|Udblac|Ufr|Ugrave|Umacr|UnderBar|UnderBrace|UnderBracket|UnderParenthesis|Union|UnionPlus|Uogon|Uopf|UpArrow|UpArrowBar|UpArrowDownArrow|UpDownArrow|UpEquilibrium|UpTee|UpTeeArrow|Uparrow|Updownarrow|UpperLeftArrow|UpperRightArrow|Upsi|Upsilon|Uring|Uscr|Utilde|Uuml|VDash|Vbar|Vcy|Vdash|Vdashl|Vee|Verbar|Vert",
  "VerticalBar|VerticalLine|VerticalSeparator|VerticalTilde|VeryThinSpace|Vfr|Vopf|Vscr|Vvdash|Wcirc|Wedge|Wfr|Wopf|Wscr|Xfr|Xi|Xopf|Xscr|YAcy|YIcy|YUcy|Yacute|Ycirc|Ycy|Yfr|Yopf|Yscr|Yuml|ZHcy|Zacute|Zcaron|Zcy|Zdot|ZeroWidthSpace|Zeta|Zfr|Zopf|Zscr|aacute|abreve|ac|acE|acd|acirc|acute|acy|aelig|af|afr|agrave|alefsym|aleph|alpha|amacr|amalg|amp|and|andand|andd|andslope|andv|ang|ange|angle|angmsd|angmsdaa|angmsdab|angmsdac|angmsdad|angmsdae|angmsdaf|angmsdag|angmsdah|angrt|angrtvb|angrtvbd|angsph|angst|angzarr|aogon",
  "aopf|ap|apE|apacir|ape|apid|apos|approx|approxeq|aring|ascr|ast|asymp|asympeq|atilde|auml|awconint|awint|bNot|backcong|backepsilon|backprime|backsim|backsimeq|barvee|barwed|barwedge|bbrk|bbrktbrk|bcong|bcy|bdquo|becaus|because|bemptyv|bepsi|bernou|beta|beth|between|bfr|bigcap|bigcirc|bigcup|bigodot|bigoplus|bigotimes|bigsqcup|bigstar|bigtriangledown|bigtriangleup|biguplus|bigvee|bigwedge|bkarow|blacklozenge|blacksquare|blacktriangle|blacktriangledown|blacktriangleleft|blacktriangleright|blank|blk12|blk14|blk34|block|bne|bnequiv|bnot|bopf|bot|bottom|bowtie|boxDL|boxDR|boxDl|boxDr|boxH|boxHD|boxHU",
  "boxHd|boxHu|boxUL|boxUR|boxUl|boxUr|boxV|boxVH|boxVL|boxVR|boxVh|boxVl|boxVr|boxbox|boxdL|boxdR|boxdl|boxdr|boxh|boxhD|boxhU|boxhd|boxhu|boxminus|boxplus|boxtimes|boxuL|boxuR|boxul|boxur|boxv|boxvH|boxvL|boxvR|boxvh|boxvl|boxvr|bprime|breve|brvbar|bscr|bsemi|bsim|bsime|bsol|bsolb|bsolhsub|bull|bullet|bump|bumpE|bumpe|bumpeq|cacute|cap|capand|capbrcup|capcap|capcup|capdot|caps|caret|caron|ccaps|ccaron|ccedil|ccirc|ccups|ccupssm|cdot|cedil|cemptyv|cent|centerdot|cfr|chcy|check|checkmark|chi|cir",
  "cirE|circ|circeq|circlearrowleft|circlearrowright|circledR|circledS|circledast|circledcirc|circleddash|cire|cirfnint|cirmid|cirscir|clubs|clubsuit|colon|colone|coloneq|comma|commat|comp|compfn|complement|complexes|cong|congdot|conint|copf|coprod|copy|copysr|crarr|cross|cscr|csub|csube|csup|csupe|ctdot|cudarrl|cudarrr|cuepr|cuesc|cularr|cularrp|cup|cupbrcap|cupcap|cupcup|cupdot|cupor|cups|curarr|curarrm|curlyeqprec|curlyeqsucc|curlyvee|curlywedge|curren|curvearrowleft|curvearrowright|cuvee|cuwed|cwconint|cwint|cylcty|dArr|dHar|dagger|daleth|darr|dash|dashv|dbkarow|dblac|dcaron|dcy|dd|ddagger",
  "ddarr|ddotseq|deg|delta|demptyv|dfisht|dfr|dharl|dharr|diam|diamond|diamondsuit|diams|die|digamma|disin|div|divide|divideontimes|divonx|djcy|dlcorn|dlcrop|dollar|dopf|dot|doteq|doteqdot|dotminus|dotplus|dotsquare|doublebarwedge|downarrow|downdownarrows|downharpoonleft|downharpoonright|drbkarow|drcorn|drcrop|dscr|dscy|dsol|dstrok|dtdot|dtri|dtrif|duarr|duhar|dwangle|dzcy|dzigrarr|eDDot|eDot|eacute|easter|ecaron|ecir|ecirc|ecolon|ecy|edot|ee|efDot|efr|eg|egrave|egs|egsdot|el|elinters|ell|els|elsdot|emacr|empty|emptyset|emptyv|emsp|emsp13|emsp14",
  "eng|ensp|eogon|eopf|epar|eparsl|eplus|epsi|epsilon|epsiv|eqcirc|eqcolon|eqsim|eqslantgtr|eqslantless|equals|equest|equiv|equivDD|eqvparsl|erDot|erarr|escr|esdot|esim|eta|eth|euml|euro|excl|exist|expectation|exponentiale|fallingdotseq|fcy|female|ffilig|fflig|ffllig|ffr|filig|fjlig|flat|fllig|fltns|fnof|fopf|forall|fork|forkv|fpartint|frac12|frac13|frac14|frac15|frac16|frac18|frac23|frac25|frac34|frac35|frac38|frac45|frac56|frac58|frac78|frasl|frown|fscr|gE|gEl|gacute|gamma|gammad|gap|gbreve|gcirc|gcy|gdot|ge",
  "gel|geq|geqq|geqslant|ges|gescc|gesdot|gesdoto|gesdotol|gesl|gesles|gfr|gg|ggg|gimel|gjcy|gl|glE|gla|glj|gnE|gnap|gnapprox|gne|gneq|gneqq|gnsim|gopf|grave|gscr|gsim|gsime|gsiml|gt|gtcc|gtcir|gtdot|gtlPar|gtquest|gtrapprox|gtrarr|gtrdot|gtreqless|gtreqqless|gtrless|gtrsim|gvertneqq|gvnE|hArr|hairsp|half|hamilt|hardcy|harr|harrcir|harrw|hbar|hcirc|hearts|heartsuit|hellip|hercon|hfr|hksearow|hkswarow|hoarr|homtht|hookleftarrow|hookrightarrow|hopf|horbar|hscr|hslash|hstrok|hybull|hyphen|iacute|ic|icirc|icy",
  "iecy|iexcl|iff|ifr|igrave|ii|iiiint|iiint|iinfin|iiota|ijlig|imacr|image|imagline|imagpart|imath|imof|imped|in|incare|infin|infintie|inodot|int|intcal|integers|intercal|intlarhk|intprod|iocy|iogon|iopf|iota|iprod|iquest|iscr|isin|isinE|isindot|isins|isinsv|isinv|it|itilde|iukcy|iuml|jcirc|jcy|jfr|jmath|jopf|jscr|jsercy|jukcy|kappa|kappav|kcedil|kcy|kfr|kgreen|khcy|kjcy|kopf|kscr|lAarr|lArr|lAtail|lBarr|lE|lEg|lHar|lacute|laemptyv|lagran|lambda|lang|langd|langle|lap|laquo",
  "larr|larrb|larrbfs|larrfs|larrhk|larrlp|larrpl|larrsim|larrtl|lat|latail|late|lates|lbarr|lbbrk|lbrace|lbrack|lbrke|lbrksld|lbrkslu|lcaron|lcedil|lceil|lcub|lcy|ldca|ldquo|ldquor|ldrdhar|ldrushar|ldsh|le|leftarrow|leftarrowtail|leftharpoondown|leftharpoonup|leftleftarrows|leftrightarrow|leftrightarrows|leftrightharpoons|leftrightsquigarrow|leftthreetimes|leg|leq|leqq|leqslant|les|lescc|lesdot|lesdoto|lesdotor|lesg|lesges|lessapprox|lessdot|lesseqgtr|lesseqqgtr|lessgtr|lesssim|lfisht|lfloor|lfr|lg|lgE|lhard|lharu|lharul|lhblk|ljcy|ll|llarr|llcorner|llhard|lltri|lmidot|lmoust|lmoustache|lnE|lnap|lnapprox",
  "lne|lneq|lneqq|lnsim|loang|loarr|lobrk|longleftarrow|longleftrightarrow|longmapsto|longrightarrow|looparrowleft|looparrowright|lopar|lopf|loplus|lotimes|lowast|lowbar|loz|lozenge|lozf|lpar|lparlt|lrarr|lrcorner|lrhar|lrhard|lrm|lrtri|lsaquo|lscr|lsh|lsim|lsime|lsimg|lsqb|lsquo|lsquor|lstrok|lt|ltcc|ltcir|ltdot|lthree|ltimes|ltlarr|ltquest|ltrPar|ltri|ltrie|ltrif|lurdshar|luruhar|lvertneqq|lvnE|mDDot|macr|male|malt|maltese|map|mapsto|mapstodown|mapstoleft|mapstoup|marker|mcomma|mcy|mdash|measuredangle|mfr|mho|micro|mid|midast|midcir|middot|minus|minusb",
  "minusd|minusdu|mlcp|mldr|mnplus|models|mopf|mp|mscr|mstpos|mu|multimap|mumap|nGg|nGt|nGtv|nLeftarrow|nLeftrightarrow|nLl|nLt|nLtv|nRightarrow|nVDash|nVdash|nabla|nacute|nang|nap|napE|napid|napos|napprox|natur|natural|naturals|nbsp|nbump|nbumpe|ncap|ncaron|ncedil|ncong|ncongdot|ncup|ncy|ndash|ne|neArr|nearhk|nearr|nearrow|nedot|nequiv|nesear|nesim|nexist|nexists|nfr|ngE|nge|ngeq|ngeqq|ngeqslant|nges|ngsim|ngt|ngtr|nhArr|nharr|nhpar|ni|nis|nisd|niv|njcy|nlArr|nlE|nlarr|nldr|nle",
  "nleftarrow|nleftrightarrow|nleq|nleqq|nleqslant|nles|nless|nlsim|nlt|nltri|nltrie|nmid|nopf|not|notin|notinE|notindot|notinva|notinvb|notinvc|notni|notniva|notnivb|notnivc|npar|nparallel|nparsl|npart|npolint|npr|nprcue|npre|nprec|npreceq|nrArr|nrarr|nrarrc|nrarrw|nrightarrow|nrtri|nrtrie|nsc|nsccue|nsce|nscr|nshortmid|nshortparallel|nsim|nsime|nsimeq|nsmid|nspar|nsqsube|nsqsupe|nsub|nsubE|nsube|nsubset|nsubseteq|nsubseteqq|nsucc|nsucceq|nsup|nsupE|nsupe|nsupset|nsupseteq|nsupseteqq|ntgl|ntilde|ntlg|ntriangleleft|ntrianglelefteq|ntriangleright|ntrianglerighteq|nu|num|numero|numsp|nvDash",
  "nvHarr|nvap|nvdash|nvge|nvgt|nvinfin|nvlArr|nvle|nvlt|nvltrie|nvrArr|nvrtrie|nvsim|nwArr|nwarhk|nwarr|nwarrow|nwnear|oS|oacute|oast|ocir|ocirc|ocy|odash|odblac|odiv|odot|odsold|oelig|ofcir|ofr|ogon|ograve|ogt|ohbar|ohm|oint|olarr|olcir|olcross|oline|olt|omacr|omega|omicron|omid|ominus|oopf|opar|operp|oplus|or|orarr|ord|order|orderof|ordf|ordm|origof|oror|orslope|orv|oscr|oslash|osol|otilde|otimes|otimesas|ouml|ovbar|par|para|parallel|parsim|parsl|part|pcy|percnt|period",
  "permil|perp|pertenk|pfr|phi|phiv|phmmat|phone|pi|pitchfork|piv|planck|planckh|plankv|plus|plusacir|plusb|pluscir|plusdo|plusdu|pluse|plusmn|plussim|plustwo|pm|pointint|popf|pound|pr|prE|prap|prcue|pre|prec|precapprox|preccurlyeq|preceq|precnapprox|precneqq|precnsim|precsim|prime|primes|prnE|prnap|prnsim|prod|profalar|profline|profsurf|prop|propto|prsim|prurel|pscr|psi|puncsp|qfr|qint|qopf|qprime|qscr|quaternions|quatint|quest|questeq|quot|rAarr|rArr|rAtail|rBarr|rHar|race|racute|radic|raemptyv|rang|rangd|range|rangle",
  "raquo|rarr|rarrap|rarrb|rarrbfs|rarrc|rarrfs|rarrhk|rarrlp|rarrpl|rarrsim|rarrtl|rarrw|ratail|ratio|rationals|rbarr|rbbrk|rbrace|rbrack|rbrke|rbrksld|rbrkslu|rcaron|rcedil|rceil|rcub|rcy|rdca|rdldhar|rdquo|rdquor|rdsh|real|realine|realpart|reals|rect|reg|rfisht|rfloor|rfr|rhard|rharu|rharul|rho|rhov|rightarrow|rightarrowtail|rightharpoondown|rightharpoonup|rightleftarrows|rightleftharpoons|rightrightarrows|rightsquigarrow|rightthreetimes|ring|risingdotseq|rlarr|rlhar|rlm|rmoust|rmoustache|rnmid|roang|roarr|robrk|ropar|ropf|roplus|rotimes|rpar|rpargt|rppolint|rrarr|rsaquo|rscr|rsh|rsqb|rsquo",
  "rsquor|rthree|rtimes|rtri|rtrie|rtrif|rtriltri|ruluhar|rx|sacute|sbquo|sc|scE|scap|scaron|sccue|sce|scedil|scirc|scnE|scnap|scnsim|scpolint|scsim|scy|sdot|sdotb|sdote|seArr|searhk|searr|searrow|sect|semi|seswar|setminus|setmn|sext|sfr|sfrown|sharp|shchcy|shcy|shortmid|shortparallel|shy|sigma|sigmaf|sigmav|sim|simdot|sime|simeq|simg|simgE|siml|simlE|simne|simplus|simrarr|slarr|smallsetminus|smashp|smeparsl|smid|smile|smt|smte|smtes|softcy|sol|solb|solbar|sopf|spades|spadesuit|spar|sqcap|sqcaps|sqcup",
  "sqcups|sqsub|sqsube|sqsubset|sqsubseteq|sqsup|sqsupe|sqsupset|sqsupseteq|squ|square|squarf|squf|srarr|sscr|ssetmn|ssmile|sstarf|star|starf|straightepsilon|straightphi|strns|sub|subE|subdot|sube|subedot|submult|subnE|subne|subplus|subrarr|subset|subseteq|subseteqq|subsetneq|subsetneqq|subsim|subsub|subsup|succ|succapprox|succcurlyeq|succeq|succnapprox|succneqq|succnsim|succsim|sum|sung|sup|sup1|sup2|sup3|supE|supdot|supdsub|supe|supedot|suphsol|suphsub|suplarr|supmult|supnE|supne|supplus|supset|supseteq|supseteqq|supsetneq|supsetneqq|supsim|supsub|supsup|swArr|swarhk|swarr|swarrow|swnwar",
  "szlig|target|tau|tbrk|tcaron|tcedil|tcy|tdot|telrec|tfr|there4|therefore|theta|thetasym|thetav|thickapprox|thicksim|thinsp|thkap|thksim|thorn|tilde|times|timesb|timesbar|timesd|tint|toea|top|topbot|topcir|topf|topfork|tosa|tprime|trade|triangle|triangledown|triangleleft|trianglelefteq|triangleq|triangleright|trianglerighteq|tridot|trie|triminus|triplus|trisb|tritime|trpezium|tscr|tscy|tshcy|tstrok|twixt|twoheadleftarrow|twoheadrightarrow|uArr|uHar|uacute|uarr|ubrcy|ubreve|ucirc|ucy|udarr|udblac|udhar|ufisht|ufr|ugrave|uharl|uharr|uhblk|ulcorn|ulcorner|ulcrop|ultri|umacr|uml",
  "uogon|uopf|uparrow|updownarrow|upharpoonleft|upharpoonright|uplus|upsi|upsih|upsilon|upuparrows|urcorn|urcorner|urcrop|uring|urtri|uscr|utdot|utilde|utri|utrif|uuarr|uuml|uwangle|vArr|vBar|vBarv|vDash|vangrt|varepsilon|varkappa|varnothing|varphi|varpi|varpropto|varr|varrho|varsigma|varsubsetneq|varsubsetneqq|varsupsetneq|varsupsetneqq|vartheta|vartriangleleft|vartriangleright|vcy|vdash|vee|veebar|veeeq|vellip|verbar|vert|vfr|vltri|vnsub|vnsup|vopf|vprop|vrtri|vscr|vsubnE|vsubne|vsupnE|vsupne|vzigzag|wcirc|wedbar|wedge|wedgeq|weierp|wfr|wopf|wp|wr|wreath|wscr|xcap|xcirc|xcup",
  "xdtri|xfr|xhArr|xharr|xi|xlArr|xlarr|xmap|xnis|xodot|xopf|xoplus|xotime|xrArr|xrarr|xscr|xsqcup|xuplus|xutri|xvee|xwedge|yacute|yacy|ycirc|ycy|yen|yfr|yicy|yopf|yscr|yucy|yuml|zacute|zcaron|zcy|zdot|zeetrf|zeta|zfr|zhcy|zigrarr|zopf|zscr|zwj|zwnj",
].join("|").split("|"));
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
  const decode = (text) => text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, digits) => {
    const point = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  }).replace(/&([A-Za-z][A-Za-z0-9]*);/g, (entity, name) => Object.hasOwn(HTML_SPACING_ENTITIES, name) ? HTML_SPACING_ENTITIES[name] : entity);
  return ["", " "].flatMap((separator) => {
    const visible = decode(activeMarkdownEmphasis(visibleMarkdownLinkLabels(images.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, (tag, offset) => {
      if (!validTag.test(tag) && !isRawHtmlRowContext(images, offset, true)) return tag;
      return blockBoundaries && /^<\/?(?:address|article|aside|blockquote|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|menu|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|br)(?:\s|\/?>)/i.test(tag) ? "\n\n" : separator;
    }))));
    return [visible.replace(/\p{Default_Ignorable_Code_Point}/gu, ""), visible.replace(/\p{Default_Ignorable_Code_Point}/gu, " ")];
  }).join(" ").replace(/[^\S\n]+/g, " ").replace(/\n(?: *\n)+/g, "\n\n").replace(/(?<!\n)\n(?!\n)/g, " ");
}

function hasPositiveFindingStatement(text) {
  const paragraphs = String(text).replace(/\r\n/g, "\n").split(/[\r\n][ \t\f\v]*[\r\n]/);
  return paragraphs.some((paragraph) => paragraph.replace(/[ \t\r\n\f\v]+/g, " ")
    .replace(/\b(?:no|zero) +(?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies))[^.!?;]*?\bexcept +((?:[1-9][0-9]*|one|some|several|multiple))\b/giu, (match, count) => match + "; " + count + " findings remain")
    .replace(/\b(no|zero) +((?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies))) +(?:and|or) +(?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies))\b/giu, "$1 $2")
    .replace(/\b(no|zero) +(?:(?!(?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies)|is|are|was|were|has|have|been|get|gets|got|a|an|one|some|several|multiple)\b)[\p{L}-]+ +)+(?:and|or) +(?:(?!(?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies)|is|are|was|were|has|have|been|get|gets|got|a|an|one|some|several|multiple)\b)[\p{L}-]+ +)*((?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies))\b)/giu, "$1 $2")
    .split(/[.!?;]|(?<![0-9]),|,(?![0-9])|\b(?:and|or|but|however|yet)\b/i).some((clause) => {
      // Negating a resolution preserves the finding, unlike negating its noun.
      clause = clause.replace(/\b(?:not|never) +(?:(?:be|been|being|get|gets|got|gotten|getting) +)*(?:resolved|fixed|addressed|cleared|removed|closed|eliminated)\b|\b(?:is|are|was|were|has|have|had)n['’]t +(?:(?:be|been|being|get|gets|got|gotten|getting) +)*(?:resolved|fixed|addressed|cleared|removed|closed|eliminated)\b/gi, " unresolved ");
      const noun = "(?<![\\p{L}\\p{N}_\\p{Pd}])(?:issues?|findings?|problems?|bugs?|flaws?|vulnerabilit(?:y|ies))(?![\\p{L}\\p{N}_\\p{Pd}])";
      const headingNoun = noun.replace("(?![\\p{L}\\p{N}_\\p{Pd}])", "(?![\\p{L}\\p{N}_-])");
      const isAffirmative = (match, counted = false) => {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!counted && /^ *(?::|[–—-]) *(?:no|none|zero|0+(?:,000)*)(?: +(?:found|outstanding|exist|exists|remain|remains))? *$/iu.test(after)) return false;
        // Scope negation to this construction, not an unrelated earlier clause.
        if (/\b(?:no|zero|not|without|never|cannot)\b|\b[\p{L}]+n['’]t\b/iu.test(match[0])) return false;
        if (/(?:\b(?:no|zero|not|without|never|cannot)|\b[\p{L}]+n['’]t)(?: +(?:be|been|being|get|gets|got|gotten|getting|considered))* +$/iu.test(before)) return false;
        const matchedNoun = [...match[0].matchAll(new RegExp(noun, "giu"))].at(-1);
        const predicate = matchedNoun ? match[0].slice(matchedNoun.index + matchedNoun[0].length) : match[0];
        const modifiers = matchedNoun ? match[0].slice(0, matchedNoun.index) : "";
        if (/\b(?:resolved|fixed|addressed|cleared|removed|closed|eliminated)\b/i.test(modifiers) && !/^ +(?:(?:is|are|was|were|has|have|had|be|been|being|get|gets|got|gotten|getting) +)*(?:found|[\p{L}]+ed|[\p{L}]+s)\b/iu.test(predicate + after)) return false;
        if (/\b(?:resolved|fixed|addressed|cleared|removed|closed|eliminated)\b/i.test(predicate)) return false;
        if (/^(?: +| *(?::|[–—-]) *)(?:(?:that|which) +)?(?:(?:is|are|was|were|has|have|had|be|been|being|get|gets|got|gotten|getting|now) +)*(?:resolved|fixed|addressed|cleared|removed|closed|eliminated)\b/i.test(after)) return false;
        return true;
      };
      const counts = [...clause.matchAll(new RegExp("(?<![\\p{L}\\p{N}_])[*_~`]*([0-9]+(?:,[0-9]{3})*)[*_~`]* +(?:[\\p{L}-]+ +)*?" + noun, "giu"))];
      if (counts.some((match) => !/^0+$/.test(match[1].replaceAll(",", "")) && isAffirmative(match, true))) return true;
      const reporting = clause.replace(new RegExp("(?<![\\p{L}\\p{N}_])[*_~`]*0+(?:,000)*[*_~`]* +(?:[\\p{L}-]+ +)*?" + noun, "giu"), (match) => " ".repeat(match.length));
      const cardinalPattern = "\\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?) +(?:[\\p{L}-]+ +)*?" + noun;
      if ([...reporting.matchAll(new RegExp(cardinalPattern, "giu"))].some((match) => isAffirmative(match, true))) return true;
      const patterns = [
        "\\b(?:a|an) +(?:[\\p{L}-]+ +)*?" + noun + " +(?:(?:can|could|may|might|will|would|must|should) +[\\p{L}-]+|[\\p{L}]+s)\\b",
        "\\bthe +" + noun + " +(?:(?:is|are|was|were) +[\\p{L}-]+|(?:can|could|may|might|will|would|must|should) +[\\p{L}-]+|[\\p{L}]+s)\\b",
        "\\b(?:this|that|these|those) +(?:(?:code|security|blocking|critical|high|medium|low|major|minor|unresolved|open|new|resolved|fixed|addressed|cleared|removed|closed|eliminated) +)*" + noun + " +(?:(?:is|are|was|were) +[\\p{L}-]+|[\\p{L}]+s)\\b",
        "\\b(?:this|that|these|those) +(?:is|are|was|were) +(?:a|an) +(?:[\\p{L}-]+ +)*?" + noun,
        "(?<![\\p{L}\\p{N}_] )\\b(?:(?:a|an|one|some|several|multiple) +)?(?:(?!(?:the|this|that|these|those)\\b)[\\p{L}-]+ +)*?" + headingNoun + "(?= *(?::|[–—-]) *[^ \\t])",
        "\\b(?:found|[\\p{L}]+ed) +(?:[\\p{L}-]+ +)*?" + noun,
        "(?:\\b(?:a|an|one|some|several|multiple|[0-9]+) +(?:[\\p{L}-]+ +)*?" + noun + "|\\bthe +" + noun + "|(?<![\\p{L}\\p{N}_] )" + noun + ")" + " +(?:(?:is|are|was|were|has|have|had|be|been|being|get|gets|got|gotten|getting) +)*(?:found|[\\p{L}]+ed|remains?|exists?)\\b",
        "\\bthere +(?:is|are) +(?:[\\p{L}-]+ +)*?" + noun,
        "\\b(?:a|an) +(?:[\\p{L}-]+ +)*?" + noun + " +(?:(?:is|are|was|were) +[\\p{L}-]+|(?!(?:is|was|has)\\b)[\\p{L}]+s)\\b",
        "\\b(?:this|that|these|those) +" + noun + " +(?:(?:is|are|was|were) +[\\p{L}-]+|(?!(?:is|was|has)\\b)[\\p{L}]+s)\\b",
        "(?<![\\p{L}\\p{N}_] )(?:issues|findings|problems|bugs|flaws|vulnerabilities)\\b +(?:(?:is|are|was|were) +[\\p{L}-]+|(?!(?:is|was|has)\\b)[\\p{L}]+)\\b"
      ];
      return patterns.some((pattern) => [...reporting.matchAll(new RegExp(pattern, "giu"))].some((match) => isAffirmative(match)));
    }));
}

function hasContradictoryCodexPresentation(body) {
  const visible = visibleCodexReviewText(body, true);
  return hasPositiveFindingStatement(visible) || /\b(?:unresolved|failed|failure|running|pending|cancelled|incomplete|in.progress|not.completed|changes.requested|security.concerns?|do.not.merge|P[0-2])\b/i.test(visible);
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
export function isAcceptableCodexSummaryComment(comment, headSha, requestedAt, requestCommentId) {
  const body = String(comment?.body || "").trim();
  if (!/^[a-f0-9]{40}$/i.test(String(headSha || ""))) return false;
  /* Match one complete answer, not a positive line embedded in findings or
     duplicated receipts. The optional details block is GitHub boilerplate. */
  const answer = body.match(
    /^(?:<!-- codex-review-receipt:v1 -->\s+)?Codex Review: Didn't find any major issues\.([^\r\n]*)\s+\*\*Reviewed commit:\*\* `([a-f0-9]{10})`(?:\s+<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>)?$/i
  );
  if (!answer || (body.match(/<!-- codex-review-/gi) || []).length > 1 ||
      (body.match(/\*\*Reviewed commit:/gi) || []).length !== 1 ||
      containsBlockingCodexSeverity(body)) return false;
  /* Only known positive decorations may qualify the explicit verdict.
     Unknown prose must not turn a provisional answer into a passing gate. */
  if (!POSITIVE_RECEIPT_SUFFIXES.has(normalize(answer[1]))) return false;
  const shortSha = String(headSha || "").slice(0, 10);
  const commentCreatedAt = Date.parse(comment?.created_at || "");
  const requestTime = Date.parse(requestedAt || "");
  /* Same-second comments are ordered by id, which GitHub assigns in order. */
  const ordering = commentCreatedAt === requestTime
    ? compareNumericIds(comment?.id, requestCommentId) > 0
    : commentCreatedAt > requestTime;
  const isAfterRequest = !requestedAt ||
    (Number.isFinite(commentCreatedAt) && Number.isFinite(requestTime) && ordering);
  return isAfterRequest &&
    isTrustedCodexLogin(comment?.user?.login) &&
    normalize(answer[2]) === normalize(shortSha);
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

function codeReviewCompletedAt(body, headSha, section = "code_review") {
  const renderedLabel = section === "security_review" ? "Security Review" : "Code Review";
  if (String(body).split("\n").filter((line) => hasRenderedCodexSectionRow(line, renderedLabel)).length !== 1) return NaN;
  body = body.replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (section === "security_review") body = body.replaceAll("📝 **Code Review**", "ignored-code-row").replaceAll("🛡️ **Security Review**", "📝 **Code Review**");
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
  if (!match || (body.match(/<!--/g) || []).length !== 2 ||
      (body.match(/codex-review-state:/g) || []).length !== 1 ||
      (body.match(/codex-pull-request-review-summary/g) || []).length !== 1 ||
      /Codex Review:|\*\*Reviewed commit:/i.test(body) || containsBlockingCodexSeverity(body) || hasContradictoryCodexPresentation(body)) return false;
  const presentation = body.slice(match[0].length).replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (!/^(?:[ \t]*\r?\n)* {0,3}## Codex Review Summary\b/.test(presentation) ||
      (/<details>|<summary>/i.test(visibleCodexReviewText(presentation)) || hasContradictoryCodexPresentation(presentation))) return false;
  if ([...presentation.matchAll(/\b[a-f0-9]{7,40}\b/gi)].some(([sha]) => !headSha.startsWith(sha))) return false;
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  const requested = Date.parse(requestedAt || "");
  const completed = codeReviewCompletedAt(body, headSha);
  if (!Number.isFinite(completed) || Math.floor(completed / 1000) <= Math.floor(requested / 1000) || completed >= observed + 1000 ||
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
    return complete(state.code_review) && ((absent(state.security_review) && !hasRenderedCodexSectionRow(body, "Security Review")) || complete(state.security_review));
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
          ((value.status === "completed" && typeof value.has_any_findings === "boolean" && typeof value.has_unresolved_findings === "boolean") ||
           (value.status === "running" && value.has_any_findings === null && value.has_unresolved_findings === null))));
    if (!valid(state.code_review) || !valid(state.security_review)) return null;
    for (const section of ["code_review", "security_review"]) {
      if (negativeOnly || state[section].status !== "completed") continue;
      const completed = codeReviewCompletedAt(body, state[section].commit_sha, section);
      const observed = Date.parse(comment.updated_at || comment.created_at || "");
      if (!Number.isFinite(completed) || !Number.isFinite(observed) || completed >= observed + 1000) return null;
    }
    return state;
  } catch { return null; }
}

// Validate a section's clearing proof with the same presentation checks as
// approval, while allowing an independently pending/absent other section.
function isSectionClearingState(comment, section, headSha) {
  const state = typedCodexReviewState(comment);
  const body = String(comment.body || "");
  if (!state) return false;
  const encodedMatch = body.match(/codex-review-state:v1 (\{[^\r\n]*\}) -->/);
  if (!encodedMatch) return false;
  const encoded = encodedMatch[1];
  const absent = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null };
  const other = section === "code_review" ? "Security Review" : "Code Review";
  const otherSection = section === "code_review" ? "security_review" : "code_review";
  const otherPrefix = "| " + (other === "Code Review" ? "📝" : "🛡️") + " **" + other + "** | ";
  if (state[otherSection].status === "completed" && state[otherSection].has_any_findings === false && state[otherSection].has_unresolved_findings === false) {
    const companion = body.split("\n").find((line) => line.startsWith(otherPrefix));
    if (hasContradictoryCodexPresentation(companion || "")) return false;
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
    if (!Number.isFinite(started) || !Number.isFinite(observed) || started >= observed + 1000) return false;
  }
  let normalized = body.replace(encoded, JSON.stringify({ code_review: state[section], security_review: absent }))
    .split("\n").filter((line) => !line.startsWith("| " + (other === "Code Review" ? "📝" : "🛡️") + " **" + other + "** | ")).join("\n");
  if (section === "security_review") normalized = normalized.replaceAll("🛡️ **Security Review**", "📝 **Code Review**");
  return isAffirmativeCodexReviewState({ ...comment, body: normalized }, headSha, "1970-01-01T00:00:00Z", 0);
}

function findingCompletedAt(comment, section, headSha) {
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
  const state = typedCodexReviewState(comment, { negativeOnly: true });
  const other = section === "code_review" ? "security_review" : "code_review";
  const label = other === "code_review" ? "Code Review" : "Security Review";
  let presentation = String(comment.body || "");
  // A unique coherent completed counterpart row describes its own section.
  // It cannot renew an older finding clock in this section. Global prose,
  // malformed rows, and this section's warning remain observation-time evidence.
  if (state?.[other].status === "completed") {
    const otherCompleted = codeReviewCompletedAt(presentation, state[other].commit_sha, other);
    if (Number.isFinite(otherCompleted) && otherCompleted <= observed + 999) {
      const prefix = "| " + (other === "code_review" ? "📝" : "🛡️") + " **" + label + "** | ";
      const rows = presentation.split("\n");
      const companion = rows.find((line) => line.startsWith(prefix));
      const reportsFinding = state[other].has_any_findings === true || state[other].has_unresolved_findings === true;
      if (reportsFinding || !hasContradictoryCodexPresentation(companion || "")) {
        presentation = rows.filter((line) => !line.startsWith(prefix)).join("\n");
      }
    }
  }
  if (hasContradictoryCodexPresentation(presentation)) return observed;
  if (state?.[other].status === null && hasRenderedCodexSectionRow(comment.body, label)) return observed;
  const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
  return Number.isFinite(completed) && completed <= observed + 999 ? completed : observed;
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
  const candidates = [...summaries, ...receipts];
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
    return Number.isFinite(completed) && completed <= observed + 999 ? Math.floor(completed / 1000) : -Infinity;
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
