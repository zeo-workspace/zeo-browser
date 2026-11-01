// Story 064, task 7.3 — zeo-browser 0.2.0 accepts the thread snapshot's optional `subagents`
// field and the `unconfirmed` thread state that Zeo 0.8.0 sends (R6.2; operator decision
// 2026-10-29, "field + zeo-browser 0.2"). Zeo's half: `crates/agent_ui/src/browser_wire/
// subagents_tests.rs` (task 7.2), which omits the field for a thread with no children.
// Runs with the extension's own suite, in zeo-browser: `npm test -- contract.subagents`
// (vitest); its fixture `test/contract/server/valid/snapshot-subagents.json` also runs through
// Zeo's `channel.rs` in `ZEO_BROWSER_CONTRACT_DIR=<zeo-browser>/test/contract cargo test -p
// devtools_bridge browser_contract_agreement`.
//
// Contract: `subagents` is optional (absent for a thread without children, never `null`), an
// array of strict `{ title: string, status }`, status one of R1.3's six words
// `running | waiting | done | failed | canceled | unknown`; `unconfirmed` joins the thread
// states (Rust `ThreadState::Unconfirmed`) in both `thread.status` and `status.state`.
//
// Hostile halves first: the snapshot without the field is still accepted; two children with one
// title and one status are two entries; an entry with any other key, a status outside the six,
// or a `null` list is refused (strictness kept per entry); then the benign states and fixture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseServer } from "../src/contract.js";

const VALID = fileURLToPath(new URL("./contract/server/valid/", import.meta.url));

function fixture(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(`${VALID}${name}`, "utf8")) as Record<string, unknown>;
  delete raw.$expect;
  return raw;
}

type R = { ok: boolean; error?: string; value?: unknown };
const verdict = (r: unknown) => {
  const res = r as R;
  return res.ok ? "accepted" : res.error;
};

const base = () => fixture("snapshot.json");
const withSubagents = (subagents: unknown) => ({ ...base(), subagents });

describe("snapshot.subagents (R6.2)", () => {
  it("hostile: the snapshot without the field — every thread with no child — is still accepted", () => {
    expect(verdict(parseServer(base()))).toBe("accepted");
  });

  it("hostile: two children with one title and one status stay two entries", () => {
    const parsed = parseServer(
      withSubagents([
        { title: "Worker", status: "running" },
        { title: "Worker", status: "running" },
      ]),
    ) as R;
    expect(verdict(parsed)).toBe("accepted");
    expect((parsed.value as { subagents: unknown[] }).subagents).toHaveLength(2);
  });

  it("hostile: an entry is exactly { title, status }", () => {
    expect(
      verdict(parseServer(withSubagents([{ title: "A", status: "running", session_id: "a" }]))),
    ).toBe("bad_request");
    expect(verdict(parseServer(withSubagents([{ title: "A" }])))).toBe("bad_request");
    expect(verdict(parseServer(withSubagents([{ status: "running" }])))).toBe("bad_request");
  });

  it("hostile: a status outside R1.3's six, or a null list, is refused", () => {
    expect(verdict(parseServer(withSubagents([{ title: "A", status: "completed" }])))).toBe(
      "bad_request",
    );
    expect(verdict(parseServer(withSubagents(null)))).toBe("bad_request");
  });

  it("accepts the unconfirmed thread state, in the thread info and in the status", () => {
    const snapshot = base();
    const thread = { ...(snapshot.thread as Record<string, unknown>), status: "unconfirmed" };
    const parsed = parseServer({
      ...snapshot,
      thread,
      status: { state: "unconfirmed", message: null },
    }) as R;
    expect(verdict(parsed)).toBe("accepted");
    expect(
      verdict(
        parseServer({ v: 2, kind: "status", status: { state: "unconfirmed", message: null } }),
      ),
    ).toBe("accepted");
    expect(verdict(parseServer({ ...snapshot, status: { state: "paused", message: null } }))).toBe(
      "bad_request",
    );
  });

  it("accepts every status word and an empty list", () => {
    for (const status of ["running", "waiting", "done", "failed", "canceled", "unknown"]) {
      expect(verdict(parseServer(withSubagents([{ title: "A", status }]))), status).toBe(
        "accepted",
      );
    }
    expect(verdict(parseServer(withSubagents([])))).toBe("accepted");
  });

  it("accepts the shared fixture Zeo's channel.rs also round-trips", () => {
    const parsed = parseServer(fixture("snapshot-subagents.json")) as R;
    expect(verdict(parsed)).toBe("accepted");
    expect(
      (parsed.value as { subagents: Array<{ title: string }> }).subagents.map((s) => s.title),
    ).toEqual(["Worker", "Worker", "Reviewer"]);
  });
});
