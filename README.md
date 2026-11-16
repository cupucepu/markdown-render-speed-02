# markdown-render-speed-02 — fast marked-compatible renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/cupucepu/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/cupucepu/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Built for the [markdown-render-speed-02 bounty on make.fun](https://make.fun/bounty/markdown-render-speed-02). A hybrid fast+safe Markdown renderer: a handwritten fast path handles
constructs it can prove byte-identical to marked 18.1.3 (default
options); anything doubtful falls back to a vendored copy of marked
18.1.3. Dependency-free, Node 22, no WASM/native.

## Layout

- `parse.js` — the entry point (bundled, single file). Exports `parse(markdown)`.
- `main.ts` — driver: reads `/input/cases.json`, renders each case with
  `parse()`, writes `/output/html.json`.
- `src/` — human-editable source: `fast.js` (block fast path),
  `inline.js` (inline fast path), `legacy.js` (marked fallback wrapper).
- `vendor/marked/` — marked 18.1.3, vendored (MIT, see `LICENSE`/`NOTICE`).
- `scripts/` — `build.js` (bundle `src/` → `parse.js`), `diff.js`
  (byte-compare vs marked on the practice set), `bench.js`
  (CPU-time comparison), `fuzz.js` (differential fuzz vs marked).

## Status (17 Nov 2026, ~02:45 WITA)

- **Correctness: 720/720 on the practice set** (`node scripts/diff.js`).
  The fallback alone is 720/720; the fast path keeps it 720/720.
- **Fast-path coverage:** 214/680 spec cases take the whole-document
  fast path; 0/40 docs do (docs contain tables, HTML blocks, lists,
  and link reference definitions, which the fast path rejects).
- **Speed:** ~1.0x overall vs marked on the practice set (bench is
  noisy; docs dominate at ~65% of CPU and run at marked speed).
  This is **not yet fast enough to beat the best house entry**
  (the unrecorded reference attempt measured 1.51x but was only
  657/720 correct).
- **Fuzz:** 100/100 identical vs marked (built-in sampler; the kit's
  own generator needs `/input/seed.json` and cannot run standalone).

## What the fast path handles

Blocks: blank lines, ATX headings, backtick fenced code (no info
string), thematic breaks, paragraphs (plain inline or via `inline.js`).
Inline (`src/inline.js`): escapes, code spans, emphasis/strong
(unambiguous cases only — nested/run-splitting cases fall back),
links/images (inline form), strikethrough (`~~` and GFM `~`),
autolinks (`<scheme:...>`, `<email>`), entities (common named +
numeric; unknown named entities fall back), hard breaks.
Rejected (fall back): lists, blockquotes, tables, HTML blocks,
link definitions, indented code, `\r`/`\t` inputs, tilde fences,
GFM extended autolinks (bare `www.`/`http://`/email).

## Block-group mode (attempted, DISABLED)

`src/fast.js` contains `fastParseBlocks` (split docs at blank lines,
fast-render simple blocks, render complex runs with marked). It is
currently **not wired into `parse()`** because correct splitting
needs full link-reference-definition extraction: defs in the docs are
single-line and used, but the spec set contains multi-line defs,
defs inside fenced code, and defs embedded in paragraphs, which a
line-regex collector gets wrong (it broke 4–12 spec cases). Re-enable
only with a def extractor that skips code blocks and handles
multi-line defs, plus HTML-block/list-continuation guards.

## Build / test

```sh
node scripts/build.js   # rebuild parse.js from src/
node scripts/diff.js    # must show PASS 720/720 FAIL 0
node scripts/bench.js   # docs + all, vs marked
node scripts/fuzz.js [seeds] [casesPerSeed]
```

## License

MIT (see `LICENSE`). The vendored marked copy is MIT (see
`vendor/marked/LICENSE` + `NOTICE`).
