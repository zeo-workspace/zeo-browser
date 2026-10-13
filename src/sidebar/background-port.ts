// The sidebar's end of the `sidebar` port to the background (story 045, design.md §A2).
//
// The port is opened when the sidebar mounts and closed when it goes away; the browser also
// closes it when the page dies, which is what the debugger janitor relies on (R11.6). A Chrome
// service worker can be stopped and restarted under an open port, which disconnects it: while
// recording, the port is reopened at once and the announcement repeated, so a restarted worker
// knows which tab to detach; otherwise the next `post` reconnects.
import { SIDEBAR_PORT, type SidebarPortMessage } from "../sidebar-port.js";

interface BrowserEvent<F> {
  addListener(f: F): void;
}

/** The slice of `runtime.Port` used here. */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: BrowserEvent<(message: unknown) => void>;
  onDisconnect: BrowserEvent<() => void>;
}

/** `runtime.connect`, as far as the sidebar uses it. */
export interface PortRuntime {
  connect(info: { name: string }): PortLike;
}

export interface BackgroundPort {
  /** Sends a message, reconnecting first when the port was lost. */
  post(message: SidebarPortMessage): void;
  /** Receives the background's messages (Task 4.5's `start-picker`). */
  onMessage(f: (message: unknown) => void): void;
  /** Closes the port for good. */
  close(): void;
}

/**
 * Reconnects on disconnect before a message goes through again: a background that refuses the
 * port at once must not turn into a reconnect loop.
 */
const MAX_RAPID_RECONNECTS = 3;

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Opens the `sidebar` port now and keeps it usable until `close`. */
export function connectBackground(
  runtime: PortRuntime,
  log: Pick<Console, "info" | "warn">,
): BackgroundPort {
  const listeners: Array<(message: unknown) => void> = [];
  let port: PortLike | null = null;
  let closed = false;
  /** The tab being recorded, repeated after a reconnect; null when not recording. */
  let recording: number | null = null;
  /** Reconnects made on disconnect since the last message went through. */
  let rapidReconnects = 0;

  const send = (p: PortLike, message: SidebarPortMessage): boolean => {
    try {
      p.postMessage(message);
      return true;
    } catch (err) {
      // Posting on a port the other end dropped throws: forget it and reconnect next time.
      log.warn({ event: "sidebar_port_post_failed", error: errorName(err) });
      if (port === p) {
        port = null;
      }
      return false;
    }
  };

  const open = (): PortLike | null => {
    try {
      const p = runtime.connect({ name: SIDEBAR_PORT });
      p.onMessage.addListener((message) => {
        for (const f of listeners) {
          f(message);
        }
      });
      p.onDisconnect.addListener(() => {
        if (port !== p) {
          return;
        }
        port = null;
        // A worker restart drops the port. While recording, reconnect and re-announce at once:
        // waiting for the next heartbeat would leave the new worker's janitor blind for up to
        // 20 s, so a sidebar closed in that window would leave the tab attached.
        if (recording !== null && !closed && rapidReconnects < MAX_RAPID_RECONNECTS) {
          rapidReconnects++;
          port = open();
          if (port !== null) {
            send(port, { type: "recording", tabId: recording });
          }
        }
      });
      return p;
    } catch (err) {
      log.warn({ event: "sidebar_port_failed", error: errorName(err) });
      return null;
    }
  };

  /** The live port, opened again when lost; a fresh one first hears the recorded tab again. */
  const ensure = (message: SidebarPortMessage): PortLike | null => {
    if (port === null) {
      port = open();
      if (port !== null && recording !== null && message.type !== "recording") {
        send(port, { type: "recording", tabId: recording });
      }
    }
    return port;
  };

  port = open();

  return {
    post: (message) => {
      if (closed) {
        return;
      }
      if (message.type === "recording") {
        recording = message.tabId;
      } else if (message.type === "recording_stopped") {
        recording = null;
      }
      // A second attempt on a fresh port, so a message survives a worker restart.
      for (let attempt = 0; attempt < 2; attempt++) {
        const p = ensure(message);
        if (p === null) {
          return;
        }
        if (send(p, message)) {
          rapidReconnects = 0;
          return;
        }
      }
    },
    onMessage: (f) => {
      listeners.push(f);
    },
    close: () => {
      closed = true;
      const p = port;
      port = null;
      try {
        p?.disconnect();
      } catch {
        // Already disconnected.
      }
    },
  };
}
