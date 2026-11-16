// scripts/build.js — bundle src/ into a single dependency-free parse.js.
//
// Usage: node scripts/build.js
//
// Concatenates src/inline.js and src/fast.js (imports/exports
// stripped) into parse.js, which imports only the vendored marked
// (for the fallback) and exports parse(markdown).
// The entry (parse.js) is what gets submitted; src/ stays as the
// human-editable source.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function stripModuleSyntax(src) {
  // Remove `import ... from '...';` lines.
  src = src.replace(/^import\s+[^;]+;\s*$/gm, '');
  // Remove `export ` prefix (keep the declaration).
  src = src.replace(/^export\s+(function|const|let|var|class)\s/mg, '$1 ');
  return src;
}

const inline = stripModuleSyntax(readFileSync(join(root, 'src/inline.js'), 'utf8'));
const fast = stripModuleSyntax(readFileSync(join(root, 'src/fast.js'), 'utf8'));

const bundle = `// parse.js — markdown renderer, faster than marked 18.1.3.
//
// Hybrid fast+safe: a handwritten fast path (fastParse + inlineParse)
// handles constructs it can prove byte-identical to marked; anything
// doubtful falls back to the vendored marked 18.1.3 (MIT, see LICENSE).
// Dependency-free, Node 22, no WASM/native.
// Exported function: parse(markdown) -> string.

import { marked } from './vendor/marked/marked.esm.js';

${inline}

${fast}

export function parse(markdown) {
  const fastResult = fastParse(markdown);
  if (fastResult !== null) return fastResult;
  return marked.parse(markdown);
}
`;

writeFileSync(join(root, 'parse.js'), bundle);
console.log('wrote parse.js (' + bundle.length + ' bytes)');
