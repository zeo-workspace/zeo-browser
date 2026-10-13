// Which `sidebar` ports the background trusts (story 045, design.md §A2; R11.6, R9.1).
//
// `runtime.connect` is open to this extension's content scripts too, and picker.js runs inside
// visited pages. A port named "sidebar" from there could otherwise hear the shortcut's
// `start-picker` and announce `recording` for any tab, making the debugger janitor detach it.
// So a port counts as the sidebar only when the browser says it came from one of this extension's
// own pages: no `sender.tab` (content scripts always carry one) and a `sender.url` under
// `runtime.getURL("")`. Without `getURL`, the sender's id must be this extension's.
//
// A port with no `sender` at all is accepted: the browser always sets `sender` on a port handed
// to `runtime.onConnect`, so only a test double lacks it.
import { SIDEBAR_PORT } from "../sidebar-port.js";

/** The slice of `runtime.MessageSender` the check reads. */
export interface PortSender {
  id?: string;
  url?: string;
  tab?: unknown;
}

/** The slice of `runtime.Port` the check reads and, on refusal, closes. */
export interface GuardedPort {
  name: string;
  sender?: PortSender;
  disconnect?(): void;
}

/** The slice of `runtime` the check compares against. */
export interface GuardRuntime {
  id?: string;
  getURL?(path: string): string;
}

/** Whether `port` is this extension's sidebar (see the header). */
export function isOwnSidebarPort(port: GuardedPort, runtime: GuardRuntime): boolean {
  if (port.name !== SIDEBAR_PORT) {
    return false;
  }
  const sender = port.sender;
  if (sender === undefined) {
    return true;
  }
  if (sender.tab != null) {
    return false;
  }
  if (sender.id !== undefined && runtime.id !== undefined && sender.id !== runtime.id) {
    return false;
  }
  const base = typeof runtime.getURL === "function" ? runtime.getURL("") : undefined;
  if (base === undefined) {
    return sender.id !== undefined && sender.id === runtime.id;
  }
  return typeof sender.url === "string" && sender.url.startsWith(base);
}

/**
 * Filters a `runtime.onConnect` port: true for this extension's sidebar, false for any other
 * port. A port named "sidebar" that fails the check is disconnected and logged (no URL).
 */
export function acceptSidebarPort(
  port: GuardedPort,
  runtime: GuardRuntime,
  log: Pick<Console, "warn">,
): boolean {
  if (port.name !== SIDEBAR_PORT) {
    return false;
  }
  if (isOwnSidebarPort(port, runtime)) {
    return true;
  }
  log.warn({ event: "sidebar_port_refused" });
  try {
    port.disconnect?.();
  } catch {
    // Already disconnected (another listener refused it first).
  }
  return false;
}
