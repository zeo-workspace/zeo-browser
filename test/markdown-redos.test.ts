// Story 068, task 1.1 — GHSA-gfr2-rv44-r23c: one link reference definition whose label or title
// never closes, spread over many lines, renders in quadratic time in markdown-it 15.0.2 with
// default options, so the sidebar's `html: false` does not avoid it. Requirement: Expected
// Behavior 1 (a 20 000-line definition renders within 200 ms). Contract: `renderMarkdown(md:
// string): string` from `src/sidebar/markdown.ts`, the renderer every thread entry goes through.
//
// Why a growth ratio, not only the story's 200 ms budget. Measured 2026-10-25 on the host that
// wrote this test, 15.0.2 renders the 20 000-line case in about 30 ms: the budget holds on the
// vulnerable version, so on its own it cannot fail. The defect is the growth. From 25 000 to
// 100 000 lines (4×), 15.0.2 goes from ~45 ms to ~1.6 s (~35×) while 15.0.3 goes from ~17 ms to
// ~56 ms (~3.5×). Linear is 4×, quadratic 16×; the bound sits between them at 10×. A ratio also
// survives a slower machine (the KVM guest, a GitHub runner), which an absolute budget does not.
//
// Reachability: Zeo truncates an entry past MAX_ENTRY_MARKDOWN_BYTES (64 KiB), but the extension
// does not enforce that cap (contract.ts); the host's 1 000 000-byte line is the bound it relies
// on. The 100 000-line inputs here are 200 KB, inside that bound.
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_MARKDOWN_BYTES } from "../src/limits.js";
import { renderMarkdown } from "../src/sidebar/markdown.js";

/** The definitions the advisory names, each never closed, `lines` lines long. */
const SHAPES: ReadonlyArray<readonly [name: string, build: (lines: number) => string]> = [
  ["unclosed label", (n) => "[" + "a\n".repeat(n)],
  ["unclosed title on the destination's line", (n) => '[a]: /u "' + "x\n".repeat(n)],
  ["unclosed title on its own line", (n) => '[a]:\n/u\n"' + "x\n".repeat(n)],
];

/** The fastest of `runs` renders, in ms: the least disturbed by GC and the scheduler. */
function fastestRender(source: string, runs: number): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    renderMarkdown(source);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const SMALL = 25_000;
const LARGE = 4 * SMALL;
/** Between linear growth (4×) and quadratic growth (16×) for 4× the lines. */
const MAX_GROWTH = 10;

describe("hostile: an unclosed multi-line reference definition renders in linear time", () => {
  it.each(SHAPES)(
    "%s: 4x the lines costs under 10x the time",
    (name, build) => {
      renderMarkdown(build(1_000)); // warm the parser up before anything is timed
      const small = fastestRender(build(SMALL), 5);
      const large = fastestRender(build(LARGE), 3);
      const growth = large / Math.max(small, 0.01);
      expect(
        growth,
        `${name}: ${SMALL} lines ${small.toFixed(1)} ms, ${LARGE} lines ${large.toFixed(1)} ms`,
      ).toBeLessThan(MAX_GROWTH);
    },
    120_000,
  );
});

describe("the story's budget", () => {
  it.each(SHAPES)("%s: 20 000 lines fit one entry and render within 200 ms", (_name, build) => {
    const source = build(20_000);
    // An entry Zeo sends untruncated: the case is reachable through the sidebar as it is.
    expect(new TextEncoder().encode(source).length).toBeLessThanOrEqual(MAX_ENTRY_MARKDOWN_BYTES);
    renderMarkdown(build(1_000));
    expect(fastestRender(source, 3)).toBeLessThan(200);
  });
});
