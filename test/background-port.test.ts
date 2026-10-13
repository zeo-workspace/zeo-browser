// Story 045, task 4.4 — the sidebar's `sidebar` port to the background (design.md §A2; R11.6).
// Seam: `connectBackground(runtime, log)` from `src/sidebar/background-port.ts`.
// Hostile half: a port lost to a service-worker restart is reopened on the next message, and the
// fresh port hears the recorded tab again before anything else, so the janitor of the new worker
// knows what to detach.
import { describe, expect, it, vi } from "vitest";
import { connectBackground } from "../src/sidebar/background-port.js";

function fakeRuntime() {
  const ports: Array<{ name: string; sent: unknown[]; drop(): void; disconnect: any }> = [];
  const runtime = {
    connect: vi.fn(({ name }: { name: string }) => {
      const disconnect: Array<() => void> = [];
      const p = {
        name,
        sent: [] as unknown[],
        postMessage: (m: unknown) => p.sent.push(m),
        disconnect: vi.fn(),
        onMessage: { addListener() {} },
        onDisconnect: { addListener: (l: () => void) => disconnect.push(l) },
        drop: () => disconnect.forEach((l) => l()),
      };
      ports.push(p);
      return p;
    }),
  };
  return { runtime, ports };
}
const log = { info() {}, warn() {} };

describe("connectBackground", () => {
  it("opens the sidebar port at once (the background's sign that a sidebar exists)", () => {
    const { runtime, ports } = fakeRuntime();
    connectBackground(runtime, log);
    expect(runtime.connect).toHaveBeenCalledWith({ name: "sidebar" });
    expect(ports).toHaveLength(1);
  });

  it("hostile: after a worker restart, the next message reopens the port and re-announces the tab first", () => {
    const { runtime, ports } = fakeRuntime();
    const bg = connectBackground(runtime, log);
    bg.post({ type: "recording", tabId: 5 });
    ports[0]!.drop();
    bg.post({ type: "recording_heartbeat" });
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent).toEqual([
      { type: "recording", tabId: 5 },
      { type: "recording_heartbeat" },
    ]);
  });

  it("does not re-announce once the recording stopped, and close is final", () => {
    const { runtime, ports } = fakeRuntime();
    const bg = connectBackground(runtime, log);
    bg.post({ type: "recording", tabId: 5 });
    bg.post({ type: "recording_stopped" });
    ports[0]!.drop();
    bg.post({ type: "recording_heartbeat" });
    expect(ports[1]!.sent).toEqual([{ type: "recording_heartbeat" }]);
    bg.close();
    expect(ports[1]!.disconnect).toHaveBeenCalled();
    bg.post({ type: "recording", tabId: 6 });
    expect(ports).toHaveLength(2);
  });
});

describe("connectBackground, fix round: worker restart while recording", () => {
  it("hostile: a port dropped while recording is reopened at once and re-announced", () => {
    const { runtime, ports } = fakeRuntime();
    const bg = connectBackground(runtime, log);
    bg.post({ type: "recording", tabId: 5 });
    ports[0]!.drop();
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent).toEqual([{ type: "recording", tabId: 5 }]);
  });

  it("does not reconnect on a drop while idle, nor after close", () => {
    const { runtime, ports } = fakeRuntime();
    const bg = connectBackground(runtime, log);
    ports[0]!.drop();
    expect(ports).toHaveLength(1);
    bg.post({ type: "recording", tabId: 5 });
    bg.close();
    ports[1]!.drop();
    expect(ports).toHaveLength(2);
  });

  it("hostile: a background that keeps dropping the port gets at most 3 immediate reconnects", () => {
    const { runtime, ports } = fakeRuntime();
    const bg = connectBackground(runtime, log);
    bg.post({ type: "recording", tabId: 5 });
    for (let i = 0; i < 10; i++) {
      ports.at(-1)!.drop();
    }
    expect(ports).toHaveLength(1 + 3);
  });
});
