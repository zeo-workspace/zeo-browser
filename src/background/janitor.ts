// The debugger janitor, Chrome only (story 045, design.md §A2; R11.6, R11.2).
//
// The sidebar records through `chrome.debugger`, and a debugger session belongs to the extension,
// not to the page that attached it: a sidebar closed mid-recording would leave the tab attached
// (and the browser's "is debugging this browser" bar up). So the sidebar tells the background over
// its `sidebar` port which tab it is recording (`recording`), pings while it does
// (`recording_heartbeat`), and says when it stops (`recording_stopped`). When that port
// disconnects, the janitor detaches exactly the tab it was told about, if any, ignoring a
// "not attached" error (the recording had ended on its own).
//
// It never consults `debugger.getTargets().attached`: that flag says some client is attached, not
// which one — DevTools, another extension, or another window's sidebar recording its own tab.
//
// Logs carry event names and error names only, never a URL or a tab's content (R13.4).
import { acceptSidebarPort, type GuardedPort } from "./port-guard.js";

interface BrowserEvent<F> {
  addListener(f: F): void;
}

/** The slice of `runtime.Port` the janitor uses. */
export interface JanitorPort extends GuardedPort {
  onMessage: BrowserEvent<(message: unknown) => void>;
  onDisconnect: BrowserEvent<(port: JanitorPort) => void>;
}

/** The slice of the WebExtension API the janitor uses (`api` from `src/platform.ts`). */
export interface JanitorApi {
  runtime: {
    onConnect: BrowserEvent<(port: JanitorPort) => void>;
    id?: string;
    getURL?(path: string): string;
  };
  debugger: { detach(target: { tabId: number }): Promise<void> };
}

/** Chrome's words when the extension holds no session on the tab. */
const NOT_ATTACHED = /not attached/i;

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** The tab a `recording` message names, or undefined for any other message. */
function recordedTab(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const m = message as { type?: unknown; tabId?: unknown };
  return m.type === "recording" && Number.isSafeInteger(m.tabId) && (m.tabId as number) >= 0
    ? (m.tabId as number)
    : undefined;
}

/** Watches every `sidebar` port and detaches its recorded tab when the port goes away. */
export function installDebuggerJanitor(
  api: JanitorApi,
  log: Pick<Console, "info" | "warn"> = console,
): void {
  api.runtime.onConnect.addListener((port) => {
    // Only this extension's own sidebar page may name a tab to detach (`port-guard.ts`).
    if (!acceptSidebarPort(port, api.runtime, log)) {
      return;
    }
    let tabId: number | null = null;
    port.onMessage.addListener((message) => {
      const announced = recordedTab(message);
      if (announced !== undefined) {
        tabId = announced;
        return;
      }
      const type = (message as { type?: unknown } | null)?.type;
      if (type === "recording_stopped") {
        tabId = null;
      }
      // `recording_heartbeat` needs no answer: receiving it is what keeps the worker alive.
    });
    port.onDisconnect.addListener(() => {
      if (tabId === null) {
        return;
      }
      const target = { tabId };
      tabId = null;
      api.debugger.detach(target).then(
        () => log.info({ event: "janitor_detached" }),
        (err: unknown) => {
          if (err instanceof Error && NOT_ATTACHED.test(err.message)) {
            return;
          }
          log.warn({ event: "janitor_detach_failed", error: errorName(err) });
        },
      );
    });
  });
}
