// scripts/diff.js — byte-compare parse() against marked 18.1.3 on the
// practice set. Usage: node scripts/diff.js
// Prints PASS n/720 (and the failing ids + first diff position), exits
// non-zero unless every case matches byte for byte.

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
const expected = JSON.parse(
  readFileSync(join(kit, 'practice', 'reference', 'expected.json'), 'utf8')
).cases.map((c) => c.html);

let pass = 0;
const failed = [];
for (let i = 0; i < cases.length; i++) {
  const got = parse(cases[i].markdown);
  const want = expected[i];
  if (got === want) {
    pass++;
  } else {
    failed.push(cases[i].id);
    if (failed.length <= 5) {
      let at = 0;
      while (at < got.length && at < want.length && got[at] === want[at]) at++;
      console.log(`FAIL ${cases[i].id} (first diff at char ${at})`);
      console.log('  got : ' + JSON.stringify(got.slice(Math.max(0, at - 40), at + 80)));
      console.log('  want: ' + JSON.stringify(want.slice(Math.max(0, at - 40), at + 80)));
    }
  }
}
console.log(`\nPASS ${pass}/${cases.length}  FAIL ${failed.length}`);
if (failed.length) console.log('failed ids: ' + failed.join(', '));
process.exit(failed.length ? 1 : 0);
