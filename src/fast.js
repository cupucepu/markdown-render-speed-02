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

import { inlineParse, escapeHtml } from './inline.js';

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
export function fastParse(md) {
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

export function fastParseBlocks(md, renderComplex) {
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
