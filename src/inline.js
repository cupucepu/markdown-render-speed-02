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

export function escapeHtml(s) {
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
export function escapeAttr(s) {
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
export function inlineParse(text) {
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