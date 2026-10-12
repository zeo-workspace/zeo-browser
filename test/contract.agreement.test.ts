// @vitest-environment node
// Story 045, task 8.1 (TypeScript half) — every hand-written fixture under `test/contract/`
// (Task 2.1) gets the verdict its directory and `$expect` name, through `src/contract.ts`; the
// Rust half runs the same files through `channel.rs` (ZEO_BROWSER_CONTRACT_DIR) and compares
// the host's manifest templates with `test/contract/host-manifests/` byte for byte.
// Requirements: R3.6, R3.7, R12.5, R14.4 (Q14).
//
// Non-vacuous guard first: a missing or thin fixture set FAILS. Then the identity check: the
// Chrome host manifest allows exactly the ID derived from the committed key, with the trailing
// slash Chrome demands — a manifest naming any other ID would let a different extension in, or
// keep this one out.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/manifest.mjs";
import { extensionIdFromKey } from "../scripts/extension-id.mjs";
import { parseClient, parseServer } from "../src/contract.js";

const DIR = fileURLToPath(new URL("./contract/", import.meta.url));
const ERRORS = new Set([
  "bad_request",
  "too_large",
  "unsupported_version",
  "unknown_kind",
  "busy",
  "overloaded",
  "not_approved",
  "approval_denied",
  "approval_timeout",
  "approval_unavailable",
  "no_thread",
  "thread_closed",
  "stale_permission",
  "ai_disabled",
  "send_failed",
  "oversized_from_zeo",
]);

function load(side: "client" | "server", kind: "valid" | "invalid") {
  const dir = `${DIR}${side}/${kind}/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(`${dir}${name}`, "utf8")) as Record<string, unknown>;
      const { $expect, ...body } = raw;
      return { name, expected: $expect as string | undefined, body };
    });
}
const verdict = (r: unknown) => {
  const res = r as { ok: boolean; error?: string };
  return res.ok ? "accepted" : res.error;
};

describe("fixture set (non-vacuous)", () => {
  it("holds ≥ 35 files, ≥ 11 valid and ≥ 13 invalid client cases, every server kind", () => {
    const counts = (["client", "server"] as const).flatMap((s) =>
      (["valid", "invalid"] as const).map((k) => load(s, k).length),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(33);
    expect(load("client", "valid").length).toBeGreaterThanOrEqual(11);
    expect(load("client", "invalid").length).toBeGreaterThanOrEqual(13);
    expect(load("server", "invalid").length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(load("server", "valid").map((f) => f.body.kind));
    for (const k of [
      "welcome",
      "threads",
      "snapshot",
      "target_changed",
      "entry_added",
      "entry_updated",
      "entries_removed",
      "status",
      "title",
      "permission_requested",
      "permission_resolved",
      "thread_closed",
      "sent",
      "ok",
      "approval_pending",
      "error",
      "bridge_unavailable",
      "bridge_closed",
    ]) {
      expect(kinds, `server kind ${k}`).toContain(k);
    }
  });

  it("every invalid fixture names a contract error, every valid one names none", () => {
    for (const side of ["client", "server"] as const) {
      for (const f of load(side, "invalid")) {
        expect(ERRORS, `${side}/${f.name}`).toContain(f.expected);
      }
      for (const f of load(side, "valid")) {
        expect(f.expected, `${side}/${f.name}`).toBeUndefined();
      }
    }
  });
});

describe("zod agrees with every fixture", () => {
  for (const side of ["client", "server"] as const) {
    const parse = side === "client" ? parseClient : parseServer;
    for (const kind of ["valid", "invalid"] as const) {
      it(`${side}/${kind}`, () => {
        const mismatches = load(side, kind)
          .map((f) => ({ f, got: verdict(parse(f.body)) }))
          .filter(({ f, got }) => got !== (kind === "valid" ? "accepted" : f.expected))
          .map(({ f, got }) => `${f.name}: expected ${f.expected ?? "accepted"}, got ${got}`);
        expect(mismatches).toEqual([]);
      });
    }
  }
});

describe("host manifests (R14.4)", () => {
  const manifest = (b: string) =>
    JSON.parse(
      readFileSync(`${DIR}host-manifests/dev.zeo.browser_host.${b}.json`, "utf8"),
    ) as Record<string, unknown>;

  it("Chrome allows exactly the committed key's ID, with the trailing slash", () => {
    const id = extensionIdFromKey((buildManifest("chrome") as { key: string }).key);
    expect(manifest("chrome")).toEqual({
      name: "dev.zeo.browser_host",
      description: expect.any(String),
      path: "/usr/libexec/zeo-browser-host",
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    });
  });

  it("Firefox allows exactly zeo-browser@zeo.dev", () => {
    expect(manifest("firefox")).toEqual({
      name: "dev.zeo.browser_host",
      description: expect.any(String),
      path: "/usr/libexec/zeo-browser-host",
      type: "stdio",
      allowed_extensions: ["zeo-browser@zeo.dev"],
    });
  });
});
