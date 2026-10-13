// Story 045, task 4.1 — `src/picker/summary.ts` is a verbatim copy of 033's DOM summary builder
// under a header naming the source path and commit (design.md §A5). Requirement: R9.6.
// The copy is compared with `../zeo-devtools/src/client/summary.ts` byte for byte, header
// excluded: the copy must END with the whole source. When the source is absent (a clean clone of
// zeo-browser alone) the comparison is reported SKIPPED, never passed silently; the header
// check always runs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COPY = fileURLToPath(new URL("../../src/picker/summary.ts", import.meta.url));
const SOURCE = fileURLToPath(
  new URL("../../../zeo-devtools/src/client/summary.ts", import.meta.url),
);

describe("summary.ts copy", () => {
  it("has a header naming the source path and a commit", () => {
    const copy = readFileSync(COPY, "utf8");
    const header = copy.slice(0, 600);
    expect(header).toContain("zeo-devtools/src/client/summary.ts");
    expect(header).toMatch(/\b[0-9a-f]{7,40}\b/);
  });

  it.runIf(existsSync(SOURCE))("equals the zeo-devtools source after its header", () => {
    const copy = readFileSync(COPY, "utf8");
    const source = readFileSync(SOURCE, "utf8");
    expect(copy.endsWith(source)).toBe(true);
    expect(copy.length).toBeGreaterThan(source.length);
  });

  if (!existsSync(SOURCE)) {
    it.skip(`SKIPPED: ${SOURCE} is absent, so the byte comparison cannot run`, () => {});
    console.log(`SKIPPED summary copy comparison: ${SOURCE} is absent`);
  }
});
