// scripts/bench.js — CPU time (process.cpuUsage) of parse() vs marked
// 18.1.3 on the practice set. Usage: node scripts/bench.js
// Reports median of 3 runs for the 40 docs and for all 720 cases,
// plus the speedup (marked / mine). CPU time, not wall time.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../parse.js';
import { marked } from '../vendor/marked/marked.esm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = join(root, '..', 'kit', 'markdown-render-speed-02-kit');

const cases = JSON.parse(
  readFileSync(join(kit, 'practice', 'input', 'cases.json'), 'utf8')
);
const docs = cases.slice(-40);

function cpuMs(fn, list) {
  const start = process.cpuUsage();
  for (const c of list) fn(c.markdown);
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

function median3(fn, list) {
  const runs = [cpuMs(fn, list), cpuMs(fn, list), cpuMs(fn, list)];
  runs.sort((a, b) => a - b);
  return { median: runs[1], runs };
}

const markedDocs = median3((md) => marked.parse(md), docs);
const mineDocs = median3((md) => parse(md), docs);
const markedAll = median3((md) => marked.parse(md), cases);
const mineAll = median3((md) => parse(md), cases);

console.log(`marked  docs (40): median ${markedDocs.median.toFixed(0)} ms  runs=[${markedDocs.runs.map((r) => r.toFixed(0)).join(', ')}]`);
console.log(`mine    docs (40): median ${mineDocs.median.toFixed(0)} ms  runs=[${mineDocs.runs.map((r) => r.toFixed(0)).join(', ')}]`);
console.log(`docs speedup: ${(markedDocs.median / mineDocs.median).toFixed(2)}x`);
console.log(`marked  all (720): median ${markedAll.median.toFixed(0)} ms  runs=[${markedAll.runs.map((r) => r.toFixed(0)).join(', ')}]`);
console.log(`mine    all (720): median ${mineAll.median.toFixed(0)} ms  runs=[${mineAll.runs.map((r) => r.toFixed(0)).join(', ')}]`);
console.log(`all speedup: ${(markedAll.median / mineAll.median).toFixed(2)}x`);
