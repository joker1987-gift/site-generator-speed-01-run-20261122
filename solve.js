// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns, for one case's input { site, templates, files }, exactly the output tree makefun-site 1.0.0's
// build returns: a JSON object of every written path to its text, byte for byte. The dialect is makefun-site's own
// (its README states it; its code is the reference wherever the two differ) and this module reproduces that
// behaviour with faster machinery:
//
//   - front matter is parsed by scanning lines in place, never splitting the whole source;
//   - Markdown lines are classified by character scans, not per-line regexes, blocks render as they are lexed
//     (no token objects), and the inline renderer walks each string once, flushing plain runs through one escape
//     pass instead of escaping character by character;
//   - slugs and long dates are memoised per build (titles, tag names and headings repeat by design);
//   - templates are parsed once, then compiled to flat op lists with includes expanded inline at the exact
//     depth the reference's renderer would reach them (depth 8 renders nothing), and rendering is a single
//     iterative walk over the ops with a shared output array.
//
// Nothing is cached from one case (one run call) to the next: every memo table lives inside run().

'use strict';

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " and ' escaped, returned as itself when there is nothing to escape. */
function escapeHtml(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
}

const SLUG_MAX = 64;

/** The slug of `text`, makefun-site's rule: NFKD, marks dropped, lowered, runs of other characters one "-". */
function slugifyRaw(text) {
  // Pure-ASCII text is unchanged by NFKD and holds no combining marks, so it can skip both passes.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is JavaScript whitespace (\s), for word runs and link targets. */
function isWsCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** ASCII whitespace lookup for the word scan (the full \s set is isWsCode's, for codes >= 128). */
const WS_TABLE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TABLE[c] = 1;

/** The number of words in `text`: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS_TABLE[c] === 1 : isWsCode(c)) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** Whether every character of `line` is a space or a tab (or it is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const err = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return err;
      for (let p = 0; p < 10; p++) {
        if (p === 4 || p === 7) continue;
        const c = raw.charCodeAt(p);
        if (c < 48 || c > 57) return err;
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return err;
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']'))
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      let needAlnum = true; // at the start, and just after a "-"
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) needAlnum = false;
        else if (c === 45 && !needAlnum) needAlnum = true;
        else ok = false;
      }
      if (needAlnum) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** One front-matter line into `data`: an error string, or null when the line is fine. */
function fmLine(data, line, lineNo) {
  if (isBlank(line) || line.charCodeAt(0) === 35) return null;
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || line.charCodeAt(j) !== 58) return `line ${lineNo} is not "key: value"`;
  const key = line.slice(0, j);
  let raw;
  if (j + 1 === line.length) raw = '';
  else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
  else return `line ${lineNo} is not "key: value"`;
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  if (e !== raw.length) raw = raw.slice(0, e);
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. The closing "---" is located before any line is judged, as in the reference: an unclosed front
 * matter reports that, whatever its lines hold.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  const lines = [];
  let pos = nl + 1;
  let body = null;
  while (true) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      body = e === -1 ? '' : text.slice(e + 1);
      break;
    }
    lines.push(line);
    if (e === -1) return { error: 'the front matter is not closed' };
    pos = e + 1;
  }
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const err = fmLine(data, lines[i], i + 2);
    if (err !== null) return { error: err };
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds a whitespace character (a link target must not). */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

const INLINE_SPECIAL = /[`*[\\]/;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between constructs are escaped in one pass;
 * a construct that fails (an opener with no closer, an empty span, a bad link) is left in the plain run and
 * consumed exactly as far as the reference consumes it.
 */
function inline(s, env) {
  if (!INLINE_SPECIAL.test(s)) return escapeHtml(s);
  const out = [];
  let plain = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        const e = ESC_MAP[s[i + 1]];
        out.push(e === undefined ? s[i + 1] : e);
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
          out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
          out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
          i = j + 1;
          plain = i;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (n > plain) out.push(escapeHtml(s.slice(plain)));
  return out.join('');
}

/** Whether `c` may appear in a fence's language: A-Z, a-z, 0-9, "_", "+", "-". */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-opening line's language, or null: three backticks, the language, then spaces or tabs only. */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, langEnd);
}

/** A fence-closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: i, text: line.slice(j, e) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  let e = line.length;
  while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e !== 3) return false;
  const a = line.charCodeAt(0);
  return (a === 45 || a === 42) && line.charCodeAt(1) === a && line.charCodeAt(2) === a;
}

/** A bullet item's text ("- " or "* " dropped), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's number and text ("12. " dropped), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i < 1 || i > 9 || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWsCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpenOf(line) !== null || headingOf(line) !== null || isHR(line);
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). Blocks are rendered
 * as they are lexed, in the reference's order of tests.
 */
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      i++;
      const start = i;
      while (i < n && !isFenceClose(lines[i])) i++;
      parts.push(
        '<pre><code',
        lang === '' ? '' : ` class="language-${lang}"`,
        '>',
        i > start ? escapeHtml(lines.slice(start, i).join('\n')) + '\n' : '',
        '</code></pre>\n',
      );
      i++;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inline(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i].slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        const t = trimLine(s);
        if (t !== '') kept.push(t);
        i++;
      }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>', inline(kept.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    }
    const firstBullet = bulletOf(line);
    const firstOrdered = firstBullet === null ? orderedOf(line) : null;
    if (firstBullet !== null || firstOrdered !== null) {
      const isOrd = firstOrdered !== null;
      const start = isOrd ? firstOrdered.num : 1;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        const item = isOrd ? orderedOf(l) : bulletOf(l);
        if (item !== null) {
          cur = [trimLine(isOrd ? item.text : item)];
          items.push(cur);
          i++;
        } else if (isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      parts.push(isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const itemParts of items) parts.push('<li>', inline(itemParts.join('\n'), env), '</li>\n');
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether `text` is a path: names joined by dots, each from a letter or "_", then letters, digits and "_". */
function isPathText(text) {
  if (text === '') return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (segStart) {
      if (!isNameStart(c)) return false;
      segStart = false;
    } else if (c === 46) segStart = true;
    else if (!isNameChar(c)) return false;
  }
  return !segStart;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPathText(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a..b) is all spaces and tabs. */
function isAllSpaceTab(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isAllSpaceTab(src, lineStart, open) && isAllSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A "for <name> in <path>" tag's parts, or null when the tag is not one. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  const rest = tag.slice(4);
  let j = 0;
  if (!isNameStart(rest.charCodeAt(0))) return null;
  while (j < rest.length && isNameChar(rest.charCodeAt(j))) j++;
  if (rest.slice(j, j + 4) !== ' in ') return null;
  const pathText = rest.slice(j + 4);
  if (pathText === '' || hasWs(pathText)) return null;
  return { name: rest.slice(0, j), pathText };
}

/** An "if [not] <path>" tag's parts, or null when the tag is not one. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || hasWs(rest)) return null;
  return { not, pathText: rest };
}

/** An "include "<name>"" tag's name, or null when the tag is not one. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = parseFor(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f.name, path: pathOf(name, f.pathText), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const im = parseIf(tag);
      if (im !== null) {
        const node = { kind: 'if', not: im.not, path: pathOf(name, im.pathText), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
        continue;
      }
      if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
        continue;
      }
      const inc = parseInclude(tag);
      if (inc !== null) {
        body.push({ kind: 'include', name: inc });
        continue;
      }
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Ops: 0 text, 1 var/raw, 2 if, 3 for. Includes are expanded into the op list of the template that holds them, at
// the depth the reference's renderer would reach them: an include met at depth 8 expands to nothing, exactly as a
// render at that depth writes nothing. Expanded lists are memoised per (template, depth) inside one build.

function expandOps(tname, depth, ctx) {
  const key = `${depth}:${tname}`;
  let ops = ctx.expanded.get(key);
  if (ops !== undefined) return ops;
  ops = [];
  ctx.expanded.set(key, ops);
  const tree = ctx.parsed.get(tname);
  if (tree !== undefined) expandInto(tree, depth, ctx, ops);
  return ops;
}

function expandInto(nodes, depth, ctx, ops) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        ops.push({ t: 0, text: n.text });
        break;
      case 'var':
        ops.push({ t: 1, path: n.path, raw: false });
        break;
      case 'raw':
        ops.push({ t: 1, path: n.path, raw: true });
        break;
      case 'if': {
        const then = [];
        expandInto(n.then, depth, ctx, then);
        let els = null;
        if (n.else !== null) {
          els = [];
          expandInto(n.else, depth, ctx, els);
        }
        ops.push({ t: 2, path: n.path, not: n.not, then, els });
        break;
      }
      case 'for': {
        const body = [];
        expandInto(n.body, depth, ctx, body);
        ops.push({ t: 3, name: n.name, path: n.path, body, loops: null });
        break;
      }
      case 'include': {
        if (depth < INCLUDE_DEPTH) {
          const sub = expandOps(n.name, depth + 1, ctx);
          for (const op of sub) ops.push(op);
        }
        break;
      }
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `ops` rendered in `scope` ({ vars, parent }), appending to `out`. */
function renderOps(ops, scope, out) {
  for (let idx = 0; idx < ops.length; idx++) {
    const n = ops[idx];
    switch (n.t) {
      case 0:
        out.push(n.text);
        break;
      case 1: {
        const s = textOf(lookup(scope, n.path));
        out.push(n.raw ? s : escapeHtml(s));
        break;
      }
      case 2: {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.els;
        if (branch !== null) renderOps(branch, scope, out);
        break;
      }
      case 3: {
        const xs = lookup(scope, n.path);
        if (Array.isArray(xs)) {
          const len = xs.length;
          if (n.loops === null) n.loops = new Map();
          let loopArr = n.loops.get(len);
          if (loopArr === undefined) {
            loopArr = new Array(len);
            for (let k = 0; k < len; k++) loopArr[k] = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
            n.loops.set(len, loopArr);
          }
          for (let k = 0; k < len; k++) {
            const vars = {};
            vars[n.name] = xs[k];
            vars.loop = loopArr[k];
            renderOps(n.body, { vars, parent: scope }, out);
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens on a scheme ("https:", "mailto:", ...): a letter, then letters, digits, "+", "-" or ".", then ":". */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45))
      return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's answer for the case's input. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const ctx = { parsed, expanded: new Map() };
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const ldate = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) {
      v = longDateRaw(d);
      dateCache.set(d, v);
    }
    return v;
  };

  // Sources, in code-unit order of path, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md'))
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft; the checks run in this order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
      s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    // A target's resolution depends only on its source's directory and the target; sources share both heavily.
    const linkCache = new Map();
    for (const s of kept) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const key = `${dir}\n${target}`;
          let ent = linkCache.get(key);
          if (ent === undefined) {
            const hash = target.indexOf('#');
            const rel = hash === -1 ? target : target.slice(0, hash);
            const frag = hash === -1 ? '' : target.slice(hash);
            const path = rel === '' ? null : resolvePath(dir, rel);
            if (path !== null && bySource.has(path)) ent = { href: `${bySource.get(path).url}${frag}`, broken: false };
            else if (path !== null && staticPaths.has(path)) ent = { href: `${base}/${path}${frag}`, broken: false };
            else ent = { href: target, broken: true };
            linkCache.set(key, ent);
          }
          if (ent.broken) broken.add(`broken-link ${s.path} -> ${target}`);
          return ent.href;
        },
      };
      const md = renderMarkdown(s.body, env, slug);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // The posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, each named as first met walking the posts in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slug(name)) && seen.add(slug(name)));
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const tslug = slug(name);
      if (!bySlug.has(tslug)) bySlug.set(tslug, { name, slug: tslug, url: `${base}/tags/${tslug}/`, posts: [] });
      const tag = bySlug.get(tslug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept)
    if (!s.post)
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates read.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : ldate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : ldate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });
  const pageOf = (s) => ({
    // A post's card is already built for the collections; a page builds its own here, as the reference's pageOf
    // builds a fresh card either way — the values are the same.
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its own, the index pages and the tag pages through theirs, then the statics.
  const output = {};
  {
    const site = { title: input.site.title, base_url: base };
    const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
    const render = (name, vars) => {
      if (!parsed.has(name)) return null;
      const out = [];
      renderOps(expandOps(name, 0, ctx), { vars: { site, tags: allTags, recent, ...vars }, parent: null }, out);
      return out.join('');
    };
    for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: {
          number: k,
          total: pages,
          url: indexUrl(k),
          newer_url: k === 1 ? '' : indexUrl(k - 1),
          older_url: k === pages ? '' : indexUrl(k + 1),
        },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
