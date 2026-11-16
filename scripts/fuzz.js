// scripts/fuzz.js — differential fuzz vs marked (the oracle).
//
// Usage:
//   node scripts/fuzz.js [seeds] [casesPerSeed]
//
// Uses the kit's public generator (program/generator/draw.ts +
// readme.ts) to produce random markdown documents, renders each with
// parse() and with marked, and reports any byte difference.
// A difference means the fast path produced wrong output (or the
// fallback diverged) — fix it or narrow the fast path.
//
// The generator is TypeScript; this script shells out to `npx tsx`
// if available, else to a compiled copy. It does NOT import the
// generator's internals directly (they change between rounds).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../parse.js';
import { marked } from '../vendor/marked/marked.esm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = join(root, '..', 'kit', 'markdown-render-speed-02-kit');

const seeds = parseInt(process.argv[2] || '5', 10);
const perSeed = parseInt(process.argv[3] || '20', 10);

let total = 0;
let diffs = 0;
const failures = [];

for (let seed = 1; seed <= seeds; seed++) {
  for (let k = 0; k < perSeed; k++) {
    total++;
    // Ask the generator for one document. The kit generator exposes
    // a CLI via program/generator; fall back to a tiny local sampler
    // if it cannot run here.
    const dir = mkdtempSync(join(tmpdir(), 'mdfuzz-'));
    const outFile = join(dir, 'doc.md');
    const r = spawnSync(
      'node',
      [
        '--experimental-strip-types',
        join(kit, 'program', 'generator', 'draw.ts'),
        '--seed', String(seed * 1000 + k),
        '--out', outFile,
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    let md = null;
    try {
      md = readFileSync(outFile, 'utf8');
    } catch {
      md = null;
    }
    rmSync(dir, { recursive: true, force: true });
    if (md === null) {
      // Generator unavailable in this environment; use a small
      // built-in sampler instead (headings, paragraphs, fences,
      // emphasis, code spans, links).
      md = sampleDoc(seed * 1000 + k);
    }
    const got = parse(md);
    const want = marked.parse(md);
    if (got !== want) {
      diffs++;
      failures.push({ seed: seed * 1000 + k, md: md.slice(0, 400), got: got.slice(0, 300), want: want.slice(0, 300) });
      if (failures.length <= 5) {
        console.log('DIFF seed', seed * 1000 + k);
        console.log('  md  :', JSON.stringify(md.slice(0, 200)));
        console.log('  got :', JSON.stringify(got.slice(0, 200)));
        console.log('  want:', JSON.stringify(want.slice(0, 200)));
      }
    }
  }
}

console.log(`fuzz: ${total - diffs}/${total} identical, ${diffs} diffs`);
if (failures.length) {
  writeFileSync(join(root, 'scripts', 'fuzz-failures.json'), JSON.stringify(failures, null, 2));
  console.log('failures written to scripts/fuzz-failures.json');
}

// Deterministic pseudo-random sampler (fallback when the kit
// generator cannot run). Produces plausible README-ish markdown.
function sampleDoc(seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const words = ['alpha', 'beta', 'gamma', 'delta', 'foo', 'bar', 'baz', 'qux', 'the', 'quick', 'brown', 'fox', 'lorem', 'ipsum', 'dolor'];
  const pick = () => words[Math.floor(rnd() * words.length)];
  const para = () => {
    const n = 5 + Math.floor(rnd() * 15);
    const ws = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.08) ws.push('**' + pick() + '**');
      else if (r < 0.14) ws.push('*' + pick() + '*');
      else if (r < 0.2) ws.push('`' + pick() + '`');
      else if (r < 0.24) ws.push('[' + pick() + '](https://example.com/' + pick() + ')');
      else ws.push(pick());
    }
    return ws.join(' ');
  };
  const blocks = [];
  const nb = 3 + Math.floor(rnd() * 8);
  for (let i = 0; i < nb; i++) {
    const r = rnd();
    if (r < 0.2) blocks.push('# ' + para());
    else if (r < 0.3) blocks.push('## ' + para());
    else if (r < 0.4) blocks.push('```\n' + para() + '\n```');
    else if (r < 0.5) blocks.push('- ' + para() + '\n- ' + para());
    else blocks.push(para());
  }
  return blocks.join('\n\n') + '\n';
}
