// parse.js — markdown renderer, faster than marked 18.1.3.
//
// Hybrid fast+safe: a handwritten fast path (fastParse + inlineParse)
// handles constructs it can prove byte-identical to marked; anything
// doubtful falls back to the vendored marked 18.1.3 (MIT, see LICENSE).
// Dependency-free, Node 22, no WASM/native.
// Exported function: parse(markdown) -> string.

import { marked } from './vendor/marked/marked.esm.js';

// src/inline.js — handwritten fast inline parser for
// markdown-render-speed-02.
//
// inlineParse(text) returns the HTML for inline `text` when it uses
// only constructs this module can prove identical to marked 18.1.3
// (default options), else null (caller falls back to marked).
//
// Handles: backslash escapes, code spans, emphasis/strong (clear
// cases only — see below), links and images (inline form),
// strikethrough (~~), autolinks (<scheme:...>, <email>), entities,
// and hard breaks (backslash-newline). Raw inline HTML and reference
// links are rejected (fall back).
//
// Emphasis rule (conservative): a delimiter run opens/closes only
// when it is unambiguous — the run is * or ** (or _ / __), its
// flanking matches CommonMark, and the content between a matched pair
// contains no delimiter of the same character (so nesting of the same
// kind is left to marked). Anything else returns null. This covers
// the overwhelmingly common *word*, **word**, _word_, __word__ shapes
// and never guesses on the tricky ones.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ESC[s[i]];
    if (e !== undefined) {
      out += s.slice(start, i) + e;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

function isSpaceCode(code) {
  // Unicode whitespace (CommonMark flanking uses Unicode spaces).
  return (
    code === 32 || code === 9 || code === 10 || code === 11 ||
    code === 12 || code === 13 || code === 160 || code === 5760 ||
    (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
    code === 8239 || code === 8287 || code === 12288
  );
}

function isSpaceCh(c) {
  return isSpaceCode(c.charCodeAt(0));
}

function isPunctCode(code) {
  if (code < 128) return isAsciiPunct(code);
  const ch = String.fromCharCode(code);
  return !/[\p{L}\p{N}]/u.test(ch);
}

// --- entities ---
// marked's rule (escapeTestNoEncode): `&` is escaped to `&amp;`
// UNLESS it is followed by a valid entity pattern
// `(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`. When the pattern matches
// and names a real entity, it is decoded; when it matches but the
// name is unknown, the raw `&name;` is left literal; when the name
// is a real entity we do not know, we fall back (return null from
// decodeEntity's caller) rather than guess.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ',
  para: '¶', sect: '§', dagger: '†', Dagger: '‡', bull: '•',
  prime: '′', Prime: '″', euro: '€', pound: '£', yen: '¥', cent: '¢',
};

const ENTITY_RE = /^&(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z0-9_]+);/;

// Returns {ch, next} to emit `ch` and advance to `next`, or
// {raw: true, next} to emit the raw `&...;` literally, or null when
// the `&` does not start an entity pattern (caller escapes it), or
// 'fallback' when it names an entity we cannot prove.
function decodeEntity(text, i) {
  const m = ENTITY_RE.exec(text.slice(i, i + 40));
  if (!m) return null;
  const body = m[1];
  if (body[0] === '#') {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else cp = parseInt(body.slice(1), 10);
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff || Number.isNaN(cp)) {
      return { ch: '�', next: i + m[0].length };
    }
    return { ch: String.fromCodePoint(cp), next: i + m[0].length };
  }
  const ch = NAMED[body];
  if (ch === undefined) return 'fallback';
  return { ch, next: i + m[0].length };
}

// Escape text for HTML, but do NOT escape `&` when it starts a
// valid entity pattern (marked leaves those literal). Used for
// attribute values (href/src/title) and for text when the caller
// has already handled entities. For plain text the main loop handles
// `&` itself, so this is mainly for attributes.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const e = decodeEntity(s, i);
      if (e && e !== 'fallback') {
        // Part of an entity pattern: leave the raw `&...;` as-is.
        out += s.slice(start, i) + s.slice(i, e.next);
        i = e.next - 1;
        start = e.next;
        continue;
      }
      if (e === 'fallback') {
        // Unknown named entity: leave literal (marked does).
        const m = ENTITY_RE.exec(s.slice(i, i + 40));
        out += s.slice(start, i) + m[0];
        i += m[0].length - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === '"') {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === '<') {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === '>') {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function findCodeClose(text, from, len) {
  // Find a run of backticks of EXACTLY `len` at or after `from`.
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let rlen = 0;
    while (i + rlen < text.length && text[i + rlen] === '`') rlen++;
    if (rlen === len) return i;
    i += rlen;
  }
  return -1;
}

function parseLinkTarget(text, i) {
  let j = i;
  while (j < text.length && (text[j] === ' ' || text[j] === '\n')) j++;
  if (j >= text.length) return null;
  let dest = '';
  if (text[j] === '<') {
    j++;
    let d = '';
    while (j < text.length && text[j] !== '>') {
      if (text[j] === '\n') return null;
      if (text[j] === '\\' && j + 1 < text.length && isAsciiPunct(text.charCodeAt(j + 1))) {
        d += text[j + 1];
        j += 2;
      } else if (text[j] === '<') {
        return null;
      } else {
        d += text[j];
        j++;
      }
    }
    if (j >= text.length) return null;
    dest = d;
    j++;
  } else {
    let depth = 0;
    let d = '';
    while (j < text.length) {
      const c = text[j];
      if (c === ' ' || c === '\n' || c === '\t') break;
      if (c === '\\' && j + 1 < text.length && isAsciiPunct(text.charCodeAt(j + 1))) {
        d += text[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c.charCodeAt(0) < 32) {
        return null;
      }
      d += c;
      j++;
    }
    if (d === '') return null;
    dest = d;
  }
  let title = null;
  let k = j;
  while (k < text.length && (text[k] === ' ' || text[k] === '\n')) k++;
  if (k < text.length && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const open = text[k];
    const close = open === '(' ? ')' : open;
    k++;
    let t = '';
    let ok = false;
    while (k < text.length) {
      const c = text[k];
      if (c === close) {
        ok = true;
        k++;
        break;
      }
      if (c === '\\' && k + 1 < text.length && isAsciiPunct(text.charCodeAt(k + 1))) {
        t += text[k + 1];
        k += 2;
        continue;
      }
      if (open === '(' && c === '(') return null;
      t += c;
      k++;
    }
    if (!ok) return null;
    title = t;
    while (k < text.length && (text[k] === ' ' || text[k] === '\n')) k++;
  }
  if (k >= text.length || text[k] !== ')') return null;
  return { dest, title, next: k + 1 };
}

function encodeHref(dest) {
  try {
    return encodeURI(dest).replace(/%(?:25|3B|2F|3F|3A|40|26|3D|2B|24|2C|23)/g, (m) => {
      const keep = { '%25': '%', '%3B': ';', '%2F': '/', '%3F': '?', '%3A': ':', '%40': '@', '%26': '&', '%3D': '=', '%2B': '+', '%24': '$', '%2C': ',', '%23': '#' };
      return keep[m] || m;
    });
  } catch {
    return dest;
  }
}

// Flanking for a delimiter run starting at `pos` with length `len`
// in `text`. Returns {canOpen, canClose}.
function flanking(text, pos, len, ch) {
  const before = pos > 0 ? text.charCodeAt(pos - 1) : 32;
  const afterPos = pos + len;
  const after = afterPos < text.length ? text.charCodeAt(afterPos) : 32;
  const beforeSpace = isSpaceCode(before);
  const afterSpace = isSpaceCode(after);
  const beforePunct = isPunctCode(before);
  const afterPunct = isPunctCode(after);
  const leftFlank = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlank = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (ch === '*') return { canOpen: leftFlank, canClose: rightFlank };
  return {
    canOpen: leftFlank && (!rightFlank || beforePunct),
    canClose: rightFlank && (!leftFlank || afterPunct),
  };
}

/**
 * Parse inline `text` to HTML. Returns the HTML, or null when `text`
 * uses anything this parser cannot prove identical to marked.
 */
function inlineParse(text) {
  return parseRange(text, 0, text.length);
}

// Parse text[start..end) to HTML. Recursive for emphasis/link content.
function parseRange(text, start, end) {
  const out = [];
  let i = start;

  const pushText = (s) => {
    if (s) out.push(escapeHtml(s));
  };

  while (i < end) {
    const c = text[i];

    // Backslash escape / hard break.
    if (c === '\\') {
      if (i + 1 < end && text[i + 1] === '\n') {
        out.push('<br>');
        i += 2;
        continue;
      }
      if (i + 1 < end && isAsciiPunct(text.charCodeAt(i + 1))) {
        pushText(text[i + 1]);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }

    // Code span.
    if (c === '`') {
      let len = 0;
      while (i + len < end && text[i + len] === '`') len++;
      const close = findCodeClose(text.slice(0, end), i + len, len);
      if (close === -1 || close >= end) {
        pushText('`'.repeat(len));
        i += len;
        continue;
      }
      let content = text.slice(i + len, close);
      // Newlines in a code span are treated as spaces, then the
      // strip-one-space rule applies to the result.
      content = content.replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      out.push('<code>' + escapeHtml(content) + '</code>');
      i = close + len;
      continue;
    }

    // Strikethrough ~~...~~ and GFM single ~...~.
    if (c === '~') {
      let rlen = 0;
      while (i + rlen < end && text[i + rlen] === '~') rlen++;
      if (rlen >= 3) return null; // fence or complex -> fall back
      const closeStr = rlen === 2 ? '~~' : '~';
      // Find a closing run of exactly `rlen`.
      let close = -1;
      let j = i + rlen;
      while (j < end) {
        if (text[j] === '~') {
          let clen = 0;
          while (j + clen < end && text[j + clen] === '~') clen++;
          if (clen === rlen) {
            close = j;
            break;
          }
          j += clen;
        } else {
          j++;
        }
      }
      if (close === -1 || close >= end) {
        pushText('~'.repeat(rlen));
        i += rlen;
        continue;
      }
      const inner = text.slice(i + rlen, close);
      if (inner === '') {
        pushText('~'.repeat(rlen));
        i += rlen;
        continue;
      }
      const innerHtml = parseRange(text, i + rlen, close);
      if (innerHtml === null) return null;
      out.push('<del>' + innerHtml + '</del>');
      i = close + rlen;
      continue;
    }

    // Emphasis / strong.
    if (c === '*' || c === '_') {
      let len = 0;
      while (i + len < end && text[i + len] === c) len++;
      const fl = flanking(text, i, len, c);
      if (!fl.canOpen) {
        pushText(c.repeat(len));
        i += len;
        continue;
      }
      const matched = matchEmphasis(text, i, len, c, end);
      if (matched === 'ambiguous') return null; // fall back to marked
      if (!matched) {
        // No closer at all: literal.
        pushText(c.repeat(len));
        i += len;
        continue;
      }
      const innerHtml = parseRange(text, matched.innerStart, matched.innerEnd);
      if (innerHtml === null) return null;
      const tag = matched.use === 2 ? 'strong' : 'em';
      out.push('<' + tag + '>' + innerHtml + '</' + tag + '>');
      i = matched.after;
      continue;
    }

    // Link / image.
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const isImg = c === '!';
      const open = isImg ? i + 1 : i;
      let depth = 0;
      let j = open + 1;
      let closeB = -1;
      while (j < end) {
        if (text[j] === '\\' && j + 1 < end) {
          j += 2;
          continue;
        }
        // A `]` inside a code span does not close the label.
        if (text[j] === '`') {
          let blen = 0;
          while (j + blen < end && text[j + blen] === '`') blen++;
          const bclose = findCodeClose(text.slice(0, end), j + blen, blen);
          if (bclose !== -1 && bclose < end) {
            j = bclose + blen;
            continue;
          }
          j += blen;
          continue;
        }
        if (text[j] === '[') depth++;
        else if (text[j] === ']') {
          if (depth === 0) {
            closeB = j;
            break;
          }
          depth--;
        }
        j++;
      }
      if (closeB === -1) {
        pushText(c);
        i++;
        continue;
      }
      const label = text.slice(open + 1, closeB);
      if (closeB + 1 < end && text[closeB + 1] === '(') {
        const tgt = parseLinkTarget(text.slice(0, end), closeB + 2);
        if (tgt && tgt.next <= end) {
          const labelHtml = parseRange(text, open + 1, closeB);
          if (labelHtml === null) return null;
          if (isImg) {
            // A nested image in the label would make the alt text
            // wrong (its alt is lost when stripping tags) -> fall back.
            if (label.indexOf('![') !== -1) return null;
            const alt = labelHtml.replace(/<[^>]*>/g, '');
            const src = escapeAttr(encodeHref(tgt.dest));
            const title = tgt.title !== null && tgt.title !== undefined
              ? ' title="' + escapeAttr(tgt.title) + '"'
              : '';
            out.push('<img src="' + src + '" alt="' + escapeAttr(alt) + '"' + title + '>');
          } else {
            // A link cannot contain another link.
            if (labelHtml.indexOf('<a ') !== -1) return null;
            const href = escapeAttr(encodeHref(tgt.dest));
            const title = tgt.title !== null && tgt.title !== undefined
              ? ' title="' + escapeAttr(tgt.title) + '"'
              : '';
            out.push('<a href="' + href + '"' + title + '>' + labelHtml + '</a>');
          }
          i = tgt.next;
          continue;
        }
      }
      // Not an inline link: reference links need defs -> fall back.
      return null;
    }

    // Autolink <...> or raw HTML.
    if (c === '<') {
      const slice = text.slice(i, Math.min(end, i + 160));
      const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(slice);
      if (m) {
        const url = m[1];
        out.push('<a href="' + escapeHtml(encodeHref(url)) + '">' + escapeHtml(url) + '</a>');
        i += m[0].length;
        continue;
      }
      const em = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(slice);
      if (em) {
        const addr = em[1];
        out.push('<a href="mailto:' + escapeHtml(addr) + '">' + escapeHtml(addr) + '</a>');
        i += em[0].length;
        continue;
      }
      return null;
    }

    // Entity.
    if (c === '&') {
      const e = decodeEntity(text, i);
      if (e === 'fallback') return null;
      if (e && e.next <= end) {
        pushText(e.ch);
        i = e.next;
        continue;
      }
      pushText('&');
      i++;
      continue;
    }

    // Plain character.
    pushText(c);
    i++;
  }

  return out.join('');
}

// Find an unambiguous emphasis match for the opener at `pos` (run of
// `len` of char `ch`). Returns {use, innerStart, innerEnd, after},
// 'ambiguous' (a closer exists but nesting/link structure makes the
// match unsafe -- caller must fall back), or null (no closer at all --
// caller emits the run literally).
function matchEmphasis(text, pos, len, ch, end) {
  if (len !== 1 && len !== 2) return 'ambiguous';
  const use = len;
  const flOpen = flanking(text, pos, len, ch);
  if (!flOpen.canOpen) return null;
  let j = pos + len;
  while (j < end) {
    // Skip escaped delimiters and code spans: they cannot close.
    if (text[j] === '\\' && j + 1 < end) {
      j += 2;
      continue;
    }
    if (text[j] === '`') {
      let blen = 0;
      while (j + blen < end && text[j + blen] === '`') blen++;
      const bclose = findCodeClose(text.slice(0, end), j + blen, blen);
      if (bclose !== -1 && bclose < end) {
        j = bclose + blen;
        continue;
      }
      j += blen;
      continue;
    }
    if (text[j] === ch) {
      let rlen = 0;
      while (j + rlen < end && text[j + rlen] === ch) rlen++;
      if (rlen === use) {
        const fl = flanking(text, j, use, ch);
        if (fl.canClose) {
          // Content must not contain an unmatched `[` (a link
          // starting inside the emphasis would consume the closer).
          if (!bracketsBalanced(text, pos + len, j)) return 'ambiguous';
          return { use, innerStart: pos + len, innerEnd: j, after: j + rlen };
        }
        if (fl.canOpen) return 'ambiguous'; // nested opener
        // Neither open nor close: literal, keep scanning.
      }
      j += rlen;
    } else {
      j++;
    }
  }
  // No exact closer. If the same delimiter appears anywhere later,
  // the emphasis might still form (run splitting, nesting) -- fall
  // back rather than emit literally. Only emit literally when no
  // same-char delimiter exists later at all.
  if (text.indexOf(ch, pos + len) !== -1 && text.indexOf(ch, pos + len) < end) {
    return 'ambiguous';
  }
  return null;
}

// True when the `[`/`]` brackets in text[start..end) are balanced
// (ignoring escaped brackets and brackets inside code spans).
function bracketsBalanced(text, start, end) {
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === '\\' && i + 1 < end) {
      i += 2;
      continue;
    }
    if (c === '`') {
      let len = 0;
      while (i + len < end && text[i + len] === '`') len++;
      const close = findCodeClose(text.slice(0, end), i + len, len);
      if (close === -1 || close >= end) {
        i += len;
        continue;
      }
      i = close + len;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth < 0) return false;
    }
    i++;
  }
  return depth === 0;
}

// src/fast.js — handwritten fast path for markdown-render-speed-02.
//
// fastParse(md) returns the HTML for `md` when `md` uses ONLY
// constructs this module can prove identical to marked 18.1.3
// (default options), else null (caller falls back to marked).
//
// Rules (conservative by design — when in doubt, return null):
// - Input must use \n line ends only (no \r) and contain no tab.
//   marked normalises \r\n/\r and expands tabs; we do not replicate
//   that here, so those inputs go to the fallback.
// - Blocks handled: blank lines, ATX headings (plain inline), fenced
//   code (backtick, no info string), thematic breaks, and paragraphs
//   whose inline content is PLAIN text (no character that can start
//   an inline construct). Anything else (lists, blockquotes, tables,
//   setext headings, HTML blocks, link definitions, indented code,
//   and any inline markup) returns null.
// - Inline "plain" means the text contains none of: * _ ` [ ] < >
//   ~ \ & ! — the characters that can start emphasis, code spans,
//   links, images, autolinks, HTML, strikethrough, escapes or
//   entities. Such text is rendered by HTML-escaping only, which is
//   exactly what marked does for it.
//
// Position-based: a single index `pos` walks the source; the source
// string is never sliced. Lines are located with indexOf('\n').


// True when `ch` (a code unit) can start an inline construct.
// (Kept for the eligibility pre-scan; inlineParse does the real work.)
function isSpecial(code) {
  // * _ ` [ ] < > ~ \ & !
  return (
    code === 42 || // *
    code === 95 || // _
    code === 96 || // `
    code === 91 || // [
    code === 93 || // ]
    code === 60 || // <
    code === 62 || // >
    code === 126 || // ~
    code === 92 || // backslash
    code === 38 || // &
    code === 33 // !
  );
}

function isPlainInline(s) {
  for (let i = 0; i < s.length; i++) {
    if (isSpecial(s.charCodeAt(i))) return false;
  }
  return true;
}

// GFM extended autolinks (bare www. / http(s):// / email) are turned
// into links by marked but inlineParse does not handle them, so any
// text that might contain one is ineligible for the fast path.
function hasExtendedAutolink(s) {
  return s.indexOf('://') !== -1 || s.indexOf('www.') !== -1 || s.indexOf('@') !== -1;
}

// Count leading spaces (0..n) at `pos`; tabs already excluded.
function leadSpaces(src, pos) {
  let n = 0;
  while (src.charCodeAt(pos + n) === 32) n++;
  return n;
}

// Try to read an ATX heading starting at line `line` (no leading
// spaces counted yet). Returns {level, text} or null.
function atxHeading(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  let level = 0;
  while (line.charCodeAt(i) === 35) {
    level++;
    i++;
  }
  if (level === 0 || level > 6) return null;
  // Must be followed by space/tab or end of line.
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9 && i !== line.length) return null;
  // Heading text: strip leading/trailing spaces and closing #'s.
  // A closing sequence is #'s at the end preceded by a space, or the
  // whole rest being #'s (e.g. "### ###" is an empty heading).
  let text = line.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { level, text };
}

// True when `line` is a thematic break.
function isHr(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  const c = line.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false; // - _ *
  let count = 0;
  for (; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
  }
  return count >= 3;
}

// True when `line` (already known to start a fence) opens a fenced
// code block. Returns {marker, len} or null. Only backtick fences
// with no info string are fast-pathed.
function fenceOpen(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  if (line.charCodeAt(i) !== 96) return null; // backtick only
  let len = 0;
  while (line.charCodeAt(i) === 96) {
    len++;
    i++;
  }
  if (len < 3) return null;
  // Rest of line must be blank (no info string).
  for (; i < line.length; i++) {
    if (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return null;
  }
  return { marker: 96, len };
}

// True when `line` closes a fence of `len` backticks.
function fenceClose(line, len) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  let n = 0;
  while (line.charCodeAt(i) === 96) {
    n++;
    i++;
  }
  if (n < len) return false;
  for (; i < line.length; i++) {
    if (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return false;
  }
  return true;
}

// A line that starts a block we do NOT fast-path (list, blockquote,
// table, HTML, setext underline is handled by the paragraph logic,
// indented code). Conservative: any of these returns true.
function startsComplexBlock(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3) return true; // 4+ spaces = indented code (or complex)
  const c = line.charCodeAt(i);
  if (c === 62) return true; // > blockquote
  if (c === 60) return true; // < HTML block (or autolink, but at block start)
  if (c === 124) return true; // | table
  // List item: -, +, * or 1-9 digits + . or ) followed by space.
  if (c === 45 || c === 43 || c === 42) {
    const d = line.charCodeAt(i + 1);
    if (d === 32 || d === 9 || i + 1 === line.length) return true;
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    const d = line.charCodeAt(j);
    if ((d === 46 || d === 41) && j - i <= 9) {
      const e = line.charCodeAt(j + 1);
      if (e === 32 || e === 9 || j + 1 === line.length) return true;
    }
  }
  return false;
}

// Setext underline: a line of only = or - (with up to 3 leading
// spaces, trailing spaces allowed), a SINGLE run — no spaces inside
// ("= =" and "--- -" are not underlines). Returns 1 (=), 2 (-), or 0.
function setextLevel(line) {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > 3 || i === line.length) return 0;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let j = i;
  while (line.charCodeAt(j) === c) j++;
  for (; j < line.length; j++) {
    if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return 0;
  }
  return c === 61 ? 1 : 2;
}

/**
 * Fast-parse `md`. Returns HTML, or null when `md` uses anything
 * outside the fast subset (caller falls back to marked).
 */
function fastParse(md) {
  // Reject inputs whose normalisation we do not replicate.
  if (md.indexOf('\r') !== -1 || md.indexOf('\t') !== -1) return null;

  // Tilde fenced code blocks (~~~) are not handled by the fast path.
  // Reject any line that starts (after 0-3 spaces of indent) with
  // three or more tildes.
  {
    let p = 0;
    while (p < md.length) {
      let q = p;
      let indent = 0;
      while (q < md.length && md[q] === ' ' && indent < 4) {
        q++;
        indent++;
      }
      if (
        indent <= 3 &&
        md[q] === '~' && md[q + 1] === '~' && md[q + 2] === '~'
      ) {
        return null;
      }
      const nl = md.indexOf('\n', p);
      if (nl === -1) break;
      p = nl + 1;
    }
  }

  const out = [];
  const n = md.length;
  let pos = 0;

  while (pos < n) {
    // Read one line (without the trailing \n).
    let eol = md.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = md.slice(pos, eol);
    const next = eol < n ? eol + 1 : n;

    // Blank line.
    if (/^[ ]*$/.test(line)) {
      pos = next;
      continue;
    }

    // Fenced code block.
    const fence = fenceOpen(line);
    if (fence) {
      // Content lines lose up to the fence's indent (leading spaces).
      const indent = leadSpaces(line, 0);
      let content = '';
      let p = next;
      let closed = false;
      while (p < n) {
        let e2 = md.indexOf('\n', p);
        if (e2 === -1) e2 = n;
        const l2 = md.slice(p, e2);
        const nx = e2 < n ? e2 + 1 : n;
        if (fenceClose(l2, fence.len)) {
          closed = true;
          p = nx;
          break;
        }
        let strip = 0;
        while (strip < indent && l2.charCodeAt(strip) === 32) strip++;
        content += l2.slice(strip) + '\n';
        p = nx;
      }
      if (!closed) return null; // unclosed fence: let marked decide
      out.push('<pre><code>' + escapeHtml(content) + '</code></pre>\n');
      pos = p;
      continue;
    }

    // ATX heading.
    const h = atxHeading(line);
    if (h) {
      if (hasExtendedAutolink(h.text)) return null;
      const html = inlineParse(h.text);
      if (html === null) return null;
      out.push('<h' + h.level + '>' + html + '</h' + h.level + '>\n');
      pos = next;
      continue;
    }

    // Thematic break.
    if (isHr(line)) {
      out.push('<hr>\n');
      pos = next;
      continue;
    }

    // Anything that starts a complex block -> fall back.
    if (startsComplexBlock(line)) return null;

    // Paragraph: gather consecutive non-blank lines that do not start
    // a new block (fence/heading/hr/complex) and are not a setext
    // underline for the paragraph so far. Paragraph lines keep their
    // leading spaces (marked keeps them); only a setext heading's
    // text is stripped.
    const paraLines = [line];
    let p = next;
    let isSetext = 0;
    while (p < n) {
      let e2 = md.indexOf('\n', p);
      if (e2 === -1) e2 = n;
      const l2 = md.slice(p, e2);
      const nx = e2 < n ? e2 + 1 : n;
      if (/^[ ]*$/.test(l2)) break; // blank ends paragraph
      const sl = setextLevel(l2);
      if (sl) {
        isSetext = sl;
        p = nx;
        break;
      }
      if (fenceOpen(l2) || atxHeading(l2) || isHr(l2) || startsComplexBlock(l2)) break;
      paraLines.push(l2);
      p = nx;
    }
    // Join paragraph lines with \n (marked joins them, then inline
    // parsing turns a soft break into \n in the output).
    // Hard break / trailing-space guard: a non-final line ending in
    // 2+ spaces is a <br /> in marked, and trailing spaces at the end
    // of a paragraph are stripped. We do not replicate that here, so
    // any paragraph line ending in a space falls back to marked.
    for (let i = 0; i < paraLines.length; i++) {
      if (/ $/.test(paraLines[i])) return null;
    }
    const text = paraLines.join('\n');
    if (hasExtendedAutolink(text)) return null;
    const html = inlineParse(text);
    if (html === null) return null;
    if (isSetext) {
      // A setext heading's text is stripped of leading/trailing
      // whitespace; a paragraph's is not. inlineParse already
      // rendered the text, so re-derive the stripped form by parsing
      // the trimmed text.
      const head = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      const headHtml = inlineParse(head);
      if (headHtml === null) return null;
      out.push('<h' + isSetext + '>' + headHtml + '</h' + isSetext + '>\n');
    } else {
      out.push('<p>' + html + '</p>\n');
    }
    pos = p;
  }

  return out.join('');
}

// --- Block-group rendering (for long docs) ---
//
// Split a document into blank-line-separated groups. A group that is
// a single simple block (ATX heading, fenced code, thematic break,
// paragraph/setext) is rendered with the fast path; anything else
// (lists, blockquotes, tables, HTML, ...) is accumulated and rendered
// with marked via `renderComplex`. Adjacent complex groups are merged
// (with their blank lines) so a multi-block complex region stays
// intact. This is only safe when the document has no link reference
// definitions (they would apply across the split), so the caller must
// have checked for them first.

// Split md into blank-line-separated groups. Each group is
// {lines, start, end} where start/end are offsets into md.
function splitGroups(md) {
  const groups = [];
  const n = md.length;
  let pos = 0;
  while (pos < n) {
    let eol = md.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const line = md.slice(pos, eol);
    if (/^[ ]*$/.test(line)) {
      pos = eol < n ? eol + 1 : n;
      continue;
    }
    const start = pos;
    const lines = [];
    while (pos < n) {
      const e2 = md.indexOf('\n', pos);
      const e = e2 === -1 ? n : e2;
      const l2 = md.slice(pos, e);
      if (/^[ ]*$/.test(l2)) break;
      lines.push(l2);
      pos = e2 === -1 ? n : e2 + 1;
    }
    groups.push({ lines, start, end: pos });
  }
  return groups;
}

// Try to render one blank-line-separated group as a single simple
// block. Returns the HTML, or null when the group is not a single
// simple block (caller renders it with marked).
function fastParseGroup(lines) {
  return fastParse(lines.join('\n') + '\n');
}

function fastParseBlocks(md, renderComplex) {
  if (md.indexOf('\r') !== -1 || md.indexOf('\t') !== -1) return null;
  // Link reference definitions are collected document-wide and
  // prepended to every complex fragment (they render to nothing,
  // but make references inside the fragment resolve). Only
  // COMPLETE single-line defs are collected (label without brackets,
  // destination + optional title all on one line). If any def-like
  // line is not a complete single-line def (multi-line def, or an
  // invalid label), block splitting is unsafe -> return null.
  let defsText = '';
  {
    const defLines = [];
    const lines = md.split('\n');
    const completeDef = /^[ ]{0,3}\[[^\[\]]+\]:[ \t]*(?:<[^<>\n]*>|[^\s]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/;
    for (const l of lines) {
      if (/^[ ]{0,3}\[[^\]]+\]:/.test(l)) {
        if (!completeDef.test(l)) return null;
        defLines.push(l);
      }
    }
    if (defLines.length) defsText = defLines.join('\n') + '\n';
  }
  const render = (t) => renderComplex(defsText + t);
  // HTML blocks of types 1-5 (pre/script/style/textarea, comments,
  // processing instructions, CDATA, doctype) do NOT end at a blank
  // line, so a blank-line split would break them. If any line starts
  // one, do not use block-group mode.
  if (/^[ ]{0,3}<(\/?(pre|script|style|textarea)|!--|\?|!\[CDATA\[|![A-Za-z])/m.test(md)) return null;
  // A list item whose content continues after a blank line (indented
  // continuation paragraph) would be split apart. If the document
  // has a list marker and later a blank line followed by an indented
  // line, do not use block-group mode.
  {
    const lines = md.split('\n');
    let sawList = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^[ ]{0,3}([-*+]|\d{1,9}[.)])($|[ \t])/.test(l)) sawList = true;
      if (
        sawList &&
        /^[ ]*$/.test(l) &&
        i + 1 < lines.length &&
        /^  +\S/.test(lines[i + 1])
      ) {
        return null;
      }
    }
  }
  const groups = splitGroups(md);
  if (groups.length === 0) return '';
  const out = [];
  let complexStart = -1;
  for (const g of groups) {
    const html = fastParseGroup(g.lines);
    if (html !== null) {
      if (complexStart !== -1) {
        out.push(render(md.slice(complexStart, g.start)));
        complexStart = -1;
      }
      out.push(html);
    } else {
      if (complexStart === -1) complexStart = g.start;
    }
  }
  if (complexStart !== -1) {
    const last = groups[groups.length - 1];
    out.push(render(md.slice(complexStart, last.end)));
  }
  return out.join('');
}


export function parse(markdown) {
  const fastResult = fastParse(markdown);
  if (fastResult !== null) return fastResult;
  return marked.parse(markdown);
}
