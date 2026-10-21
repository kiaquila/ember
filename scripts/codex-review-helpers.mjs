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
function stripMarkdownContainers(text, preserveBoundaries = false) {
  let previousQuotes = 0;
  return text.split("\n").map((line) => {
      let previous;
      let quotes = 0;
      do {
        previous = line;
        if (/^ {0,3}>/.test(line)) quotes += 1;
        line = line.replace(/^ {0,3}>[ \t]?/, "").replace(/^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]/, "");
      } while (line !== previous);
      const boundary = preserveBoundaries && quotes < previousQuotes ? "\n" : "";
      previousQuotes = quotes;
      return boundary + line;
  }).join("\n");
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
  return text.replace(/[&<\[]/g, (bracket, index) => {
    const context = stripMarkdownContainers(text.slice(0, index));
    const indentation = context.slice(context.lastIndexOf("\n") + 1).match(/^[ \t]*/)[0];
    return (bracket === "[" && isRawHtmlRowContext(text, index, true)) ||
      spans.some(([start, end]) => index >= start && index < end) ||
      indentation.includes("\t") || indentation.length >= 4 ||
      isProtocolCodeExample(context, context.length) ? ({ "[": "&#91;", "<": "&#60;", "&": "&#38;" })[bracket] : bracket;
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

function visibleFootnoteBodies(text) {
  const key = (label) => Array.from(label, (character) => unicodeCaseFold[character] ?? character.toLowerCase()).join("");
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
      definitions.add(entry[1].trim().replace(/\s+/g, " ").toLowerCase());
      definitionBodies.add(entry[0]);
    }
  }
  const projected = (result + text.slice(consumed)).replace(definitionPattern, (source) => definitionBodies.has(source) ? "" : source);
  const references = projected.replace(/\[([^\]]*)\]\[([^\]]*)\]/g, (source, label, reference, offset, whole) => !isEscapedMarkdownStart(whole, offset) && isVisibleLinkLabel(label) && isVisibleLinkLabel(reference || label, true) && definitions.has((reference || label).trim().replace(/\s+/g, " ").toLowerCase()) ? label : source);
  return references.replace(/\[([^\]]+)\](?![\[(])/g, (source, label, offset, whole) => !isEscapedMarkdownStart(whole, offset) && isVisibleLinkLabel(label, true) && definitions.has(label.trim().replace(/\s+/g, " ").toLowerCase()) ? label : source);
}

// Normalize only human-visible negative evidence; protocol and clocks stay raw.
function visibleCodexReviewText(value) {
  // Parse raw structural delimiters before decoding text entities: an encoded
  // quote is attribute data, and an encoded angle bracket cannot create a tag.
  const raw = String(value || "").replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, ""));
  const literalSafe = preserveLiteralMarkdownLinks(raw);
  const htmlReferences = literalSafe.replace(/&#(?:x[0-9a-f]+|[0-9]+);?/gi, (entity, index) =>
    entity.endsWith(";") || !isRawHtmlRowContext(literalSafe, index, true) ? entity : entity + ";");
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
    const visible = decode(visibleMarkdownLinkLabels(images.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, (tag, offset) => validTag.test(tag) || isRawHtmlRowContext(images, offset, true) ? separator : tag))).replace(/[*_~`]/g, "");
    return [visible.replace(/\p{Default_Ignorable_Code_Point}/gu, ""), visible.replace(/\p{Default_Ignorable_Code_Point}/gu, " ")];
  }).join(" ").replace(/\s+/g, " ");
}

function hasContradictoryCodexPresentation(body) {
  const visible = visibleCodexReviewText(body).replace(/\bfound\s+(?:no|0)\s+(?:issues?|bugs?)\b/gi, "");
  return /\b(?:found|unresolved|issues?|findings?|bugs?|failed|failure|running|pending|cancelled|incomplete|in.progress|not.completed|changes.requested|security.concerns?|do.not.merge|P[0-2])\b/i.test(visible);
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

// GFM raw HTML blocks cannot supply a live Markdown status-table row.
function isRawHtmlRowContext(body, index, markdownOnly = false) {
  let prefix = body.slice(0, index).replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, ""));
  if (markdownOnly) prefix = stripMarkdownContainers(prefix, true);
  const blockTags = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));
  const voidTags = new Set("area base basefont br col embed frame hr img input link meta param source track wbr".split(" "));
  const containers = [];
  let until = null;
  let untilBlank = false;
  let offset = 0;
  for (const line of (prefix.endsWith("\n") ? prefix.slice(0, -1) : prefix).split("\n")) {
    const lineOffset = offset;
    offset += line.length + 1;
    if (isProtocolCodeExample(prefix, lineOffset + (line.match(/^ */)?.[0].length || 0))) continue;
    if (until) { if (until.test(line)) until = null; continue; }
    const raw = line.match(/^ {0,3}<(script|pre|style|textarea)(?=[\s>])/i);
    if (raw) {
      const end = new RegExp("</" + raw[1] + "\\s*>", "i");
      if (!end.test(line)) until = end;
      continue;
    }
    if (/^ {0,3}<\?/.test(line)) { if (!line.includes("?>")) until = /\?>/; continue; }
    if (/^ {0,3}<!\[CDATA\[/.test(line)) { if (!line.includes("]]>")) until = /\]\]>/; continue; }
    if (/^ {0,3}<![A-Z]/.test(line)) { if (!line.includes(">")) until = />/; continue; }
    if (!line.trim() && !(markdownOnly && !prefix.endsWith("\n") && offset > prefix.length)) untilBlank = false;
    const start = line.match(/^ {0,3}<\/?([a-z][a-z0-9-]*)(?=[\s/>])/i);
    const completeTag = /^ {0,3}<\/?[a-z][a-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>[ \t]*$/i.test(line);
    if (start && (blockTags.has(start[1].toLowerCase()) || completeTag)) untilBlank = true;
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
  if (hasContradictoryCodexPresentation(comment.body)) return Date.parse(comment.updated_at || comment.created_at || "");
  const presentation = String(comment.body || "").replace(/\s*<details>\s*<summary>ℹ️ About Codex in GitHub<\/summary>[\s\S]*<\/details>\s*$/, "");
  if (/\b(?:P[0-2]|failed|failure|do.not.merge|found\s+(?:[1-9]\d*\s+)?issues?)\b/i.test(visibleCodexReviewText(presentation))) return Date.parse(comment.updated_at || comment.created_at || "");
  const state = typedCodexReviewState(comment, { negativeOnly: true });
  const other = section === "code_review" ? "security_review" : "code_review";
  const label = other === "code_review" ? "Code Review" : "Security Review";
  if (state?.[other].status === null && hasRenderedCodexSectionRow(comment.body, label)) return Date.parse(comment.updated_at || comment.created_at || "");
  const completed = codeReviewCompletedAt(String(comment.body || ""), headSha, section);
  const observed = Date.parse(comment.updated_at || comment.created_at || "");
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
