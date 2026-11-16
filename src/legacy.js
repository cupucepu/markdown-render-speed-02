// src/legacy.js — the fallback: marked 18.1.3 itself, vendored byte
// for byte in vendor/marked/marked.esm.js (MIT, see
// vendor/marked/LICENSE + NOTICE). This is the correctness anchor:
// anything the fast path cannot prove identical goes here.

import { marked } from '../vendor/marked/marked.esm.js';

/** The HTML marked 18.1.3 renders for `md` with its defaults. */
export function legacyParse(md) {
  return marked.parse(md);
}
