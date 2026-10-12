// Story 045, task 3.1 — the native channel client (design.md §A3, §Error Handling Strategy).
// Requirements: R8.4, R8.5, R8.6, R8.7, R8.8, R8.9, R4.1 (approval_pending), R4.3 (denied),
// R13.4 (the channel logs kinds only). Q4.
//
// Contract and the one assumed seam (adjust `makeChannel` only if it moves):
//   `new Channel({ connectNative, lastError })` — `connectNative(name)` returns a
//   `chrome.runtime.Port`-shaped object; `lastError()` returns the current
//   `runtime.lastError?.message` (Firefox puts the same text on `port.error`, also set here).
//   `connect()`, `close()`, `request(msg)` (id-correlated, 15 s), `on("state", f)`,
//   `on("event", f)`. A state is a ConnState name, or an object carrying it in `state`.
//
// Hostile halves first:
//   - backoff: no reconnect BEFORE each mark (1, 2, 4, 8, 16, then every 30 s), one AT it;
//   - terminal states: `no_host` and `denied` never retry, while plain unreachability does;
//   - correlation: a reply for request B never resolves A, and an unknown id resolves neither;
//   - resubscribe: a pinned thread comes back pinned (never collapsed into "follow"), and
//     "follow" comes back as follow.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel } from "../src/channel.js";

type Listener = (...args: any[]) => void;
class FakePort {
  sent: any[] = [];
  disconnected = false;
  error: { message: string } | undefined;
  private msg: Listener[] = [];
  private disc: Listener[] = [];
  onMessage = { addListener: (f: Listener) => this.msg.push(f), removeListener() {} };
  onDisconnect = { addListener: (f: Listener) => this.disc.push(f), removeListener() {} };
  constructor(
    readonly name: string,
    private readonly setLastError: (m: string | undefined) => void,
  ) {}
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(m: unknown) {
    for (const f of this.msg) {
      f(m, this);
    }
  }
  drop(error?: string) {
    this.error = error ? { message: error } : undefined;
    this.setLastError(error);
    for (const f of this.disc) {
      f(this);
    }
    this.setLastError(undefined);
  }
}

function makeChannel() {
  let lastErr: string | undefined;
  const ports: FakePort[] = [];
  const channel = new Channel({
    connectNative: (name: string) => {
      const p = new FakePort(name, (m) => (lastErr = m));
      ports.push(p);
      return p as unknown as chrome.runtime.Port;
    },
    lastError: () => lastErr,
  } as any);
  const states: unknown[][] = [];
  const events: unknown[] = [];
  channel.on("state", (...args: unknown[]) => states.push(args));
  channel.on("event", (e: unknown) => events.push(e));
  const stateName = (s: unknown) => (typeof s === "string" ? s : (s as { state?: string })?.state);
  return {
    channel,
    ports,
    events,
    states,
    last: () => ports[ports.length - 1]!,
    state: () => stateName(states[states.length - 1]?.[0]),
  };
}

const welcome = (protocol = 2) => ({ v: 2, kind: "welcome", protocol, zeo_version: "9.9.9" });
const ready = (c: ReturnType<typeof makeChannel>) => {
  c.channel.connect();
  c.last().emit(welcome());
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connect and states", () => {
  it("opens dev.zeo.browser_host and sends hello first", () => {
    const c = makeChannel();
    c.channel.connect();
    expect(c.ports).toHaveLength(1);
    expect(c.last().name).toBe("dev.zeo.browser_host");
    expect(c.last().sent[0]).toMatchObject({ v: 2, kind: "hello" });
    expect(c.state()).toBe("connecting");
  });

  it("approval_pending, then welcome protocol 2 → ready (R8.8, R4.1)", () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit({ v: 2, kind: "approval_pending" });
    expect(c.state()).toBe("approval_pending");
    c.last().emit(welcome());
    expect(c.state()).toBe("ready");
  });

  it("welcome with another protocol → version_mismatch naming Zeo's version (R8.7)", () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit(welcome(3));
    expect(c.state()).toBe("version_mismatch");
    const said = JSON.stringify(c.states[c.states.length - 1]);
    expect(said).toMatch(/3/);
  });
});

describe("reconnect (R8.4, R8.5)", () => {
  it("hostile: retries at 1, 2, 4, 8, 16, then every 30 s — never before a mark", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().drop();
    expect(c.state()).toBe("unreachable");
    let ports = 1;
    for (const gap of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(c.ports.length, `before the ${gap} ms mark`).toBe(ports);
      await vi.advanceTimersByTimeAsync(1);
      ports += 1;
      expect(c.ports.length, `at the ${gap} ms mark`).toBe(ports);
      expect(c.last().sent[0]).toMatchObject({ kind: "hello" });
      c.last().drop();
    }
  });

  it("bridge_unavailable from the host means unreachable and a retry", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit({ v: 2, kind: "bridge_unavailable", reason: "absent" });
    c.last().drop();
    expect(c.state()).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.ports).toHaveLength(2);
  });

  it("hostile: a pinned thread is re-subscribed pinned after the reconnect", async () => {
    const c = makeChannel();
    ready(c);
    const reply = c.channel.request({
      v: 2,
      kind: "subscribe",
      id: "",
      target: { thread_id: "t1" },
    } as any);
    const sub = c.last().sent.find((m) => m.kind === "subscribe");
    c.last().emit({
      v: 2,
      kind: "snapshot",
      id: sub.id,
      thread: null,
      earlier: 0,
      entries: [],
      status: { state: "idle", message: null },
      permissions: [],
    });
    await reply;
    c.last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    c.last().emit(welcome());
    await vi.advanceTimersByTimeAsync(0);
    const again = c.last().sent.find((m) => m.kind === "subscribe");
    expect(again?.target).toEqual({ thread_id: "t1" });
  });

  it("follow is re-subscribed as follow", async () => {
    const c = makeChannel();
    ready(c);
    void c.channel
      .request({ v: 2, kind: "subscribe", id: "", target: { follow: true } } as any)
      .catch(() => {});
    c.last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    c.last().emit(welcome());
    await vi.advanceTimersByTimeAsync(0);
    expect(c.last().sent.find((m) => m.kind === "subscribe")?.target).toEqual({ follow: true });
  });
});

describe("terminal states", () => {
  it("host not installed → no_host and no retry (R8.6)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().drop("Specified native messaging host not found.");
    expect(c.state()).toBe("no_host");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  it("approval_denied → denied, no retry until connect() is called again (R4.3)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit({
      v: 2,
      kind: "error",
      error: "approval_denied",
      message: "Denied in Zeo",
      fatal: true,
    });
    c.last().drop();
    expect(c.state()).toBe("denied");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
    c.channel.connect();
    expect(c.ports).toHaveLength(2);
    expect(c.last().sent[0]).toMatchObject({ kind: "hello" });
  });

  // Planned amendment (post-review): the v1 bridge, Firefox's wording, and the other approval
  // failures against busy/overloaded.
  it("a v1 bridge's reply to hello → version_mismatch naming both versions, no retry (R8.7)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit({
      v: 1,
      ok: false,
      error: "unsupported_version",
      message: "unsupported protocol version",
    });
    c.last().drop();
    expect(c.state()).toBe("version_mismatch");
    const said = JSON.stringify(c.states[c.states.length - 1]);
    expect(said).toMatch(/"protocol":1\b/);
    expect(said).toMatch(/"protocol":2\b/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  it("Firefox's 'No such native application' → no_host and no retry (R8.6)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().drop("No such native application dev.zeo.browser_host");
    expect(c.state()).toBe("no_host");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  for (const error of ["approval_timeout", "approval_unavailable"]) {
    it(`${error} → approval_failed with Zeo's message, no retry until connect() (R4.4, R4.7)`, async () => {
      const c = makeChannel();
      c.channel.connect();
      c.last().emit({ v: 2, kind: "error", error, message: `Zeo says ${error}`, fatal: true });
      c.last().drop();
      expect(c.state()).toBe("approval_failed");
      expect(JSON.stringify(c.states[c.states.length - 1])).toContain(`Zeo says ${error}`);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.ports).toHaveLength(1);
      c.channel.connect();
      expect(c.ports).toHaveLength(2);
      expect(c.last().sent[0]).toMatchObject({ kind: "hello" });
    });
  }

  for (const error of ["busy", "overloaded"]) {
    it(`hostile: ${error} shows its message and keeps the backoff (R3.4, R3.8)`, async () => {
      const c = makeChannel();
      c.channel.connect();
      c.last().emit({ v: 2, kind: "error", error, message: `Zeo says ${error}`, fatal: true });
      c.last().drop();
      expect(JSON.stringify(c.states[c.states.length - 1])).toContain(`Zeo says ${error}`);
      await vi.advanceTimersByTimeAsync(999);
      expect(c.ports).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(c.ports).toHaveLength(2);
      expect(c.last().sent[0]).toMatchObject({ kind: "hello" });
    });
  }

  it("close() disconnects the port and stops every timer (R8.9)", async () => {
    const c = makeChannel();
    ready(c);
    const port = c.last();
    c.channel.close();
    expect(port.disconnected).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });
});

describe("requests", () => {
  it("hostile: replies are matched by id, out of order; an unknown id resolves nothing", async () => {
    const c = makeChannel();
    ready(c);
    const a = c.channel.request({ v: 2, kind: "cancel", id: "" } as any);
    const b = c.channel.request({ v: 2, kind: "open_in_zeo", id: "" } as any);
    const [ma, mb] = c.last().sent.filter((m) => m.kind === "cancel" || m.kind === "open_in_zeo");
    expect(ma.id).toBeTruthy();
    expect(mb.id).toBeTruthy();
    expect(ma.id).not.toBe(mb.id);
    let aDone = false;
    void a.then(() => (aDone = true));
    c.last().emit({ v: 2, kind: "ok", id: "not-a-request" });
    c.last().emit({ v: 2, kind: "ok", id: mb.id });
    await expect(b).resolves.toMatchObject({ kind: "ok", id: mb.id });
    expect(aDone).toBe(false);
    c.last().emit({ v: 2, kind: "ok", id: ma.id });
    await expect(a).resolves.toMatchObject({ kind: "ok", id: ma.id });
  });

  it("a request with no reply rejects after 15 s with 'Zeo did not answer', not before", async () => {
    const c = makeChannel();
    ready(c);
    const p = c.channel.request({ v: 2, kind: "cancel", id: "" } as any);
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow("Zeo did not answer");
  });
});

describe("validation", () => {
  it("drops an invalid message, never emits it, and logs no content (R13.4)", () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logs.push(JSON.stringify(a)),
      );
    }
    const c = makeChannel();
    ready(c);
    const before = c.events.length;
    c.last().emit({
      v: 2,
      kind: "entry_added",
      index: "zero",
      entry: { markdown: "SECRET-ENTRY-TEXT" },
    });
    expect(c.events.length).toBe(before);
    expect(logs.join("\n")).not.toContain("SECRET-ENTRY-TEXT");
  });

  it("emits a valid event to the view", () => {
    const c = makeChannel();
    ready(c);
    const e = { v: 2, kind: "title", title: "Fix the build" };
    c.last().emit(e);
    expect(c.events).toContainEqual(
      expect.objectContaining({ kind: "title", title: "Fix the build" }),
    );
  });
});

// Fix round (tech review): one subscribe per session, re-entrant listeners, stale ports, a
// synchronous connectNative throw, Chrome's "forbidden" wording, and versions on every mismatch.
describe("review fixes", () => {
  const subscribes = (p: FakePort) => p.sent.filter((m) => m.kind === "subscribe");

  it("hostile: a view that subscribes on ready → exactly one subscribe per session (R8.5)", async () => {
    const c = makeChannel();
    c.channel.on("state", (s: unknown) => {
      if (s === "ready") {
        void c.channel
          .request({ v: 2, kind: "subscribe", target: { thread_id: "t1" } } as any)
          .catch(() => {});
      }
    });
    ready(c);
    expect(subscribes(c.last())).toHaveLength(1);
    c.last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    c.last().emit(welcome());
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribes(c.last())).toHaveLength(1);
    expect(subscribes(c.last())[0].target).toEqual({ thread_id: "t1" });
  });

  it("with no view subscribing, the channel's own re-subscribe is the only one", async () => {
    const c = makeChannel();
    ready(c);
    void c.channel
      .request({ v: 2, kind: "subscribe", target: { follow: true } } as any)
      .catch(() => {});
    c.last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    c.last().emit(welcome());
    expect(subscribes(c.last())).toHaveLength(1);
  });

  it("a later subscribe for the same target joins the channel's pending re-subscribe", async () => {
    const c = makeChannel();
    ready(c);
    void c.channel
      .request({ v: 2, kind: "subscribe", target: { thread_id: "t1" } } as any)
      .catch(() => {});
    c.last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    c.last().emit(welcome());
    const own = subscribes(c.last())[0];
    const joined = c.channel.request({
      v: 2,
      kind: "subscribe",
      target: { thread_id: "t1" },
    } as any);
    expect(subscribes(c.last())).toHaveLength(1);
    const snapshot = {
      v: 2,
      kind: "snapshot",
      id: own.id,
      thread: null,
      earlier: 0,
      entries: [],
      status: { state: "idle", message: null },
      permissions: [],
    };
    c.last().emit(snapshot);
    await expect(joined).resolves.toMatchObject({ kind: "snapshot", id: own.id });
    expect(c.events.filter((e: any) => e.kind === "snapshot")).toHaveLength(0);
    void c.channel
      .request({ v: 2, kind: "subscribe", target: { follow: true } } as any)
      .catch(() => {});
    expect(subscribes(c.last())).toHaveLength(2);
  });

  it("hostile: close() inside a state listener → no port opens after the backoff", async () => {
    const c = makeChannel();
    c.channel.on("state", (s: unknown) => {
      if (s === "unreachable") {
        c.channel.close();
      }
    });
    c.channel.connect();
    c.last().drop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  it("hostile: connect() inside a state listener leaves exactly one live port", async () => {
    const c = makeChannel();
    let once = true;
    c.channel.on("state", (s: unknown) => {
      if (s === "unreachable" && once) {
        once = false;
        c.channel.connect();
      }
    });
    c.channel.connect();
    c.last().drop();
    expect(c.ports).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(2);
    expect(c.last().disconnected).toBe(false);
    expect(c.state()).toBe("connecting");
  });

  it("connect() inside the connecting callback opens one port, not two", () => {
    const c = makeChannel();
    let once = true;
    c.channel.on("state", (s: unknown) => {
      if (s === "connecting" && once) {
        once = false;
        c.channel.connect();
      }
    });
    c.channel.connect();
    expect(c.ports).toHaveLength(1);
    expect(c.ports.filter((p) => !p.disconnected)).toHaveLength(1);
  });

  it("close() during the backoff wait cancels the retry (R8.9)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().drop();
    await vi.advanceTimersByTimeAsync(500);
    c.channel.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  it("hostile: late messages and disconnects from a replaced port are ignored", async () => {
    const c = makeChannel();
    ready(c);
    const stale = c.last();
    stale.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.ports).toHaveLength(2);
    stale.emit(welcome());
    expect(c.state()).toBe("unreachable");
    stale.emit({ v: 2, kind: "title", title: "Stale" });
    expect(c.events).toHaveLength(0);
    c.last().emit(welcome());
    expect(c.state()).toBe("ready");
    stale.drop();
    expect(c.state()).toBe("ready");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(2);
  });

  function throwingChannel(errors: string[]) {
    let opened = 0;
    const ports: FakePort[] = [];
    const channel = new Channel({
      connectNative: (name: string) => {
        const err = errors[opened++];
        if (err !== undefined) {
          throw new Error(err);
        }
        const p = new FakePort(name, () => {});
        ports.push(p);
        return p as unknown as chrome.runtime.Port;
      },
      lastError: () => undefined,
    } as any);
    const states: unknown[] = [];
    channel.on("state", (s: unknown) => states.push(s));
    return { channel, ports, states, opened: () => opened };
  }

  it("a synchronous connectNative throw counts as a disconnect and retries", async () => {
    const c = throwingChannel(["boom"]);
    c.channel.connect();
    expect(c.states[c.states.length - 1]).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.opened()).toBe(2);
    expect(c.ports[0]!.sent[0]).toMatchObject({ kind: "hello" });
  });

  it("a synchronous throw naming a missing host → no_host and no retry", async () => {
    const c = throwingChannel(["Specified native messaging host not found."]);
    c.channel.connect();
    expect(c.states[c.states.length - 1]).toBe("no_host");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.opened()).toBe(1);
  });

  it("Chrome's 'host is forbidden' → no_host and no retry (R8.6)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().drop("Access to the specified native messaging host is forbidden.");
    expect(c.state()).toBe("no_host");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });

  it("a v2 unsupported_version error → version_mismatch that still names both sides (R8.7)", async () => {
    const c = makeChannel();
    c.channel.connect();
    c.last().emit({
      v: 2,
      kind: "error",
      error: "unsupported_version",
      message: "Zeo speaks another version",
      fatal: true,
    });
    expect(c.state()).toBe("version_mismatch");
    const detail = c.states[c.states.length - 1]![1] as any;
    expect(detail.versions.extension.protocol).toBe(2);
    expect(detail.versions.zeo).toEqual({ protocol: null, version: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.ports).toHaveLength(1);
  });
});
