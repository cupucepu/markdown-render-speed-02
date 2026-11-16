// Driver for markdown-render-speed-02.
// Reads the case set, renders each case alone with parse() from parse.js,
// and writes the HTML strings in order. Runs as `node /bot/main.ts` on
// Node 22. Outside a container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
