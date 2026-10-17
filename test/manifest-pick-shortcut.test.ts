// Story 045, task 13.3 (F2) — the Pick element shortcut's default key in both built manifests.
// Requirements: R9.1 (default `Alt+Shift+D`). design.md §A1 commands row (v5: was `Alt+Shift+E`,
// which Firefox on Linux gives to the Edit menu's access key) and Implementation Gotchas (avoid
// F, E, V, S, B, T, H for a default command key).
// Contract: `scripts/manifest.mjs` exports `buildManifest(browser: "chrome" | "firefox"): object`.
//
// Hostile halves first:
//   - each browser's manifest is checked on its own: an overlay that carried its own `commands`
//     would leave one browser on the old key while the other moved;
//   - the two commands must stay distinct keys (a default collapsed onto `open-sidebar`'s
//     Alt+Shift+Y would make one shortcut do two things), and `open-sidebar` itself must not move;
//   - the default must not use a letter a browser menu claims as its access key.
import { describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/manifest.mjs";

type Manifest = Record<string, any>;
const BROWSERS = ["chrome", "firefox"] as const;
const build = (b: (typeof BROWSERS)[number]) => buildManifest(b) as Manifest;
const pickKey = (m: Manifest): unknown => m.commands?.["start-picker"]?.suggested_key?.default;

/** Letters Firefox/Chrome menus take as Alt access keys (design.md Implementation Gotchas). */
const MENU_ACCESS_LETTERS = ["F", "E", "V", "S", "B", "T", "H"];
// Chromium keeps these Alt+Shift letters for its own accelerators (accelerator_table.cc) and
// never binds an extension's suggested key to one: P is "new tab group" (13.3 run, 2026-10-17).
const CHROMIUM_RESERVED_LETTERS = ["A", "B", "C", "I", "N", "P", "R", "T", "W", "X", "Z"];

describe("start-picker default key (R9.1, F2)", () => {
  it.each(BROWSERS)(
    "hostile: the %s manifest does not keep Alt+Shift+E for start-picker",
    (browser) => {
      expect(pickKey(build(browser))).not.toBe("Alt+Shift+E");
    },
  );

  it("hostile: start-picker and open-sidebar keep two different keys, open-sidebar unchanged", () => {
    for (const browser of BROWSERS) {
      const m = build(browser);
      expect(m.commands["open-sidebar"].suggested_key.default).toBe("Alt+Shift+Y");
      expect(pickKey(m)).not.toBe(m.commands["open-sidebar"].suggested_key.default);
    }
  });

  it("hostile: the default's letter is not one a browser menu claims as an access key", () => {
    for (const browser of BROWSERS) {
      const key = String(pickKey(build(browser)));
      const letter = key.split("+").at(-1) ?? "";
      expect(MENU_ACCESS_LETTERS).not.toContain(letter.toUpperCase());
      expect(CHROMIUM_RESERVED_LETTERS).not.toContain(letter.toUpperCase());
    }
  });

  it("both built manifests give start-picker the same default, Alt+Shift+D", () => {
    expect(pickKey(build("chrome"))).toBe("Alt+Shift+D");
    expect(pickKey(build("firefox"))).toBe("Alt+Shift+D");
  });
});
