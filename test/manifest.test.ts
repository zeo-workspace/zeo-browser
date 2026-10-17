// Story 045, task 1.2 — one source, two manifests (design.md §A1 per-browser table).
// Requirements: R1.1, R1.2, R1.3, R1.4, R8.1, R8.3, R11.9 (the Firefox build has no debugger).
// Contract: `scripts/manifest.mjs` exports `buildManifest(browser: "chrome" | "firefox"): object`,
// pure, returning the manifest.json object the build writes into `dist/<browser>/`.
//
// Hostile halves first: each browser's manifest must carry ONLY its own background key and
// sidebar key (Chrome refuses `background.scripts`; Firefox MV3 ignores `service_worker`), and
// the permission sets are exact sets — an extra permission fails as much as a missing one.
import { describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/manifest.mjs";

type Manifest = Record<string, any>;
const chrome = () => buildManifest("chrome") as Manifest;
const firefox = () => buildManifest("firefox") as Manifest;
const sorted = (xs: unknown) => [...(xs as string[])].sort();

describe("background and sidebar keys never leak across browsers (hostile)", () => {
  it("Chrome: service_worker module, no background.scripts, side_panel, no sidebar_action", () => {
    const m = chrome();
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(m.background.scripts).toBeUndefined();
    expect(m.side_panel).toEqual({ default_path: "sidebar/index.html" });
    expect(m.sidebar_action).toBeUndefined();
  });

  it("Firefox: background.scripts event page, no service_worker, sidebar_action, no side_panel", () => {
    const m = firefox();
    expect(m.background.scripts).toEqual(["background.js"]);
    expect(m.background.service_worker).toBeUndefined();
    expect(m.sidebar_action).toMatchObject({ default_panel: "sidebar/index.html" });
    expect(m.side_panel).toBeUndefined();
  });
});

describe("permissions (R1.3, R1.4)", () => {
  it("Chrome requests exactly the six permissions", () => {
    expect(sorted(chrome().permissions)).toEqual(
      sorted(["nativeMessaging", "sidePanel", "activeTab", "scripting", "storage", "debugger"]),
    );
  });

  it("Firefox requests the same minus debugger and sidePanel (R11.9: no debugger at all)", () => {
    expect(sorted(firefox().permissions)).toEqual(
      sorted(["nativeMessaging", "activeTab", "scripting", "storage"]),
    );
  });

  it("both ask for <all_urls> only as an optional host permission", () => {
    for (const m of [chrome(), firefox()]) {
      expect(m.optional_host_permissions).toEqual(["<all_urls>"]);
      expect(m.host_permissions ?? []).toEqual([]);
      expect(m.permissions).not.toContain("<all_urls>");
    }
  });
});

describe("identity (R1.2) and minimum versions (Q11)", () => {
  it("Chrome carries the committed public key and minimum_chrome_version 116", () => {
    const m = chrome();
    expect(typeof m.key).toBe("string");
    expect(m.key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(m.key.length).toBeGreaterThan(300);
    expect(m.minimum_chrome_version).toBe("116");
  });

  it("Firefox has the fixed add-on id, strict_min_version 128.0, and no Chrome key", () => {
    const m = firefox();
    expect(m.browser_specific_settings.gecko.id).toBe("zeo-browser@zeo.dev");
    expect(m.browser_specific_settings.gecko.strict_min_version).toBe("128.0");
    expect(m.key).toBeUndefined();
  });

  it("both are MV3 from the same source: same name and version", () => {
    expect(chrome().manifest_version).toBe(3);
    expect(firefox().manifest_version).toBe(3);
    expect(firefox().name).toBe(chrome().name);
    expect(firefox().version).toBe(chrome().version);
  });
});

describe("commands (R8.3, R9.1)", () => {
  // Task 13.3 (design.md §A1 v5): start-picker moved from Alt+Shift+E, which Firefox on Linux
  // gives to the Edit menu, to Alt+Shift+D.
  it("both declare open-sidebar Alt+Shift+Y and start-picker Alt+Shift+D", () => {
    for (const m of [chrome(), firefox()]) {
      expect(m.commands["open-sidebar"].suggested_key.default).toBe("Alt+Shift+Y");
      expect(m.commands["start-picker"].suggested_key.default).toBe("Alt+Shift+D");
    }
  });

  // Amended at Run mode (post-review): _execute_sidebar_action would bind Alt+Shift+Y a second
  // time in Firefox, so neither browser declares it.
  it("neither browser declares _execute_sidebar_action", () => {
    expect(firefox().commands._execute_sidebar_action).toBeUndefined();
    expect(chrome().commands._execute_sidebar_action).toBeUndefined();
  });
});

it("buildManifest is pure: two calls give equal, independent objects", () => {
  const a = chrome();
  const b = chrome();
  expect(b).toEqual(a);
  a.permissions.push("tabs");
  expect(chrome().permissions).not.toContain("tabs");
});
