// Opening the sidebar and starting the picker (story 045, design.md §A2; R8.1–R8.3, R9.1, R9.9).
//
// Gesture-bound calls: the browser opens a side panel / sidebar only from inside the handler of a
// user action, and Firefox refuses `sidebarAction.open()` / `toggle()` once that handler has
// awaited anything. So in every listener the open call is the first browser call, nothing is
// awaited before it, and its promise only gets a `.catch` that logs the error kind.
//
// - Chrome: the toolbar click, `open-sidebar` and `start-picker` all call
//   `sidePanel.open({windowId})`. `openPanelOnActionClick` is set to false at install: with it on,
//   Chrome opens the panel itself and the click is no action invocation, so it grants no
//   `activeTab` (measured on Chrome 155, story 045 live proof F1).
// - Firefox: the toolbar click toggles the sidebar; both commands open it. Firefox has no
//   `_execute_sidebar_action` command here, so `open-sidebar` is this listener's.
// - `start-picker` then injects picker.js into the shortcut's tab under the `activeTab` grant the
//   shortcut gave — no `permissions.request`, which would be refused outside a gesture — and
//   skips a protected URL (R9.9). The sidebar hears `{type: "start-picker", tabId}`, followed by
//   `{type: "picker-status", tabId, status}` when the picker is not running there:
//   - on its `sidebar` port, once it announces itself by connecting it (the sidebar this shortcut
//     opened), or at once when that port is already known here. Only a port from this
//     extension's own page counts (`port-guard.ts`): a content script's is refused;
//   - as a one-shot `runtime.sendMessage` broadcast when no sidebar has connected within
//     `START_PICKER_FALLBACK_MS`: a sidebar that was already open before this background (re)started
//     holds no port the background knows of, since a worker or event-page restart drops ports and
//     the sidebar reconnects only when it next posts.
//
// Logs carry event names and error names only, never a URL or a tab's content (R13.4).
import { injectPicker, isProtectedUrl, type PickApi } from "../picker/inject.js";
import { acceptSidebarPort, type GuardedPort } from "./port-guard.js";
import type { Browser } from "../platform.js";
import type { BackgroundPortMessage, PickerBootStatus } from "../sidebar-port.js";

interface BrowserEvent<F> {
  addListener(f: F): void;
}

/** The tab a command or a toolbar click names (absent fields are ones the browser withheld). */
export interface GestureTab {
  id?: number;
  windowId?: number;
  url?: string;
}

/** The slice of `runtime.Port` used here. */
export interface SidebarPort extends GuardedPort {
  postMessage(message: unknown): void;
  onDisconnect: BrowserEvent<(port: SidebarPort) => void>;
}

/**
 * The slice of the WebExtension API used here (`api` from `src/platform.ts`). `sidePanel` exists
 * in Chrome only, `sidebarAction` in Firefox only (and not in `@types/chrome`).
 */
export interface SidebarApi {
  runtime: {
    onInstalled: BrowserEvent<(details: { reason?: string }) => void>;
    onConnect: BrowserEvent<(port: SidebarPort) => void>;
    sendMessage(message: unknown): Promise<unknown>;
    id?: string;
    getURL?(path: string): string;
  };
  commands: { onCommand: BrowserEvent<(command: string, tab?: GestureTab) => void> };
  action: { onClicked: BrowserEvent<(tab: GestureTab) => void> };
  scripting: PickApi["scripting"];
  sidePanel?: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
    open(options: { windowId: number }): Promise<void>;
  };
  sidebarAction?: { toggle(): Promise<void>; open(): Promise<void> };
}

/**
 * How long a `start-picker` waits for a sidebar to connect, in ms. Past it, a sidebar opened later
 * by other means must not receive a stale shortcut.
 */
export const START_PICKER_TTL_MS = 15_000;

/**
 * How long a `start-picker` waits for a sidebar to connect before broadcasting it to an
 * already-open sidebar instead, in ms. A side panel or sidebar the shortcut opened connects well
 * within it.
 */
export const START_PICKER_FALLBACK_MS = 1_000;

/** The picker the last `start-picker` asked for, until it is delivered or expires. */
interface PendingPick {
  tabId: number;
  expires: number;
  /** The boot outcome: undefined while injecting, null when picker.js is running. */
  status: PickerBootStatus | null | undefined;
  /** Whether a sidebar connected after the command (no broadcast is needed then). */
  announced: boolean;
  /** What each port that heard of this pick has been told. */
  told: Map<SidebarPort, { status: boolean }>;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** The messages that tell a sidebar about `pick`, as far as its outcome is known. */
function messagesFor(pick: PendingPick): BackgroundPortMessage[] {
  const out: BackgroundPortMessage[] = [{ type: "start-picker", tabId: pick.tabId }];
  if (pick.status !== undefined && pick.status !== null) {
    out.push({ type: "picker-status", tabId: pick.tabId, status: pick.status });
  }
  return out;
}

/** Installs the toolbar, command, install and `sidebar`-port listeners. */
export function installSidebarActions(
  api: SidebarApi,
  browser: Browser,
  log: Pick<Console, "info" | "warn"> = console,
): void {
  const connected = new Set<SidebarPort>();
  let pending: PendingPick | null = null;

  const logFailure = (event: string) => (err: unknown) => {
    log.warn({ event, error: errorName(err) });
  };

  /** Opens the sidebar of `tab`'s window. Must stay the first browser call of a gesture listener. */
  const openSidebar = (tab: GestureTab | undefined): void => {
    if (browser === "firefox") {
      api.sidebarAction?.open().catch(logFailure("sidebar_open_failed"));
      return;
    }
    if (tab?.windowId === undefined) {
      log.warn({ event: "sidebar_open_no_window" });
      return;
    }
    api.sidePanel?.open({ windowId: tab.windowId }).catch(logFailure("sidebar_open_failed"));
  };

  const post = (port: SidebarPort, message: BackgroundPortMessage): boolean => {
    try {
      port.postMessage(message);
      return true;
    } catch (err) {
      // The sidebar went away between its last message and this one.
      log.warn({ event: "sidebar_post_failed", error: errorName(err) });
      connected.delete(port);
      return false;
    }
  };

  /** Tells `port` what it has not heard yet about the pending pick. */
  const deliver = (port: SidebarPort): void => {
    const pick = pending;
    if (pick === null) {
      return;
    }
    let told = pick.told.get(port);
    if (told === undefined) {
      if (Date.now() > pick.expires) {
        pending = null;
        return;
      }
      if (!post(port, { type: "start-picker", tabId: pick.tabId })) {
        return;
      }
      told = { status: false };
      pick.told.set(port, told);
    }
    if (pick.status !== undefined && pick.status !== null && !told.status) {
      told.status = post(port, { type: "picker-status", tabId: pick.tabId, status: pick.status });
    }
  };

  /** Broadcasts `pick` once to whatever sidebar page is open, unless one connected meanwhile. */
  const broadcast = (pick: PendingPick): void => {
    if (pending !== pick || pick.announced) {
      return;
    }
    for (const message of messagesFor(pick)) {
      // Rejects when no sidebar is open at all, which is a normal outcome here.
      api.runtime
        .sendMessage(message)
        .catch((err: unknown) =>
          log.info({ event: "sidebar_broadcast_unheard", error: errorName(err) }),
        );
    }
  };

  /** Injects picker.js into the shortcut's tab, unless its URL is one the browser protects. */
  const boot = async (tab: GestureTab & { id: number }): Promise<PickerBootStatus | null> => {
    if (tab.url !== undefined && isProtectedUrl(tab.url)) {
      log.info({ event: "background_picker_not_started", reason: "protected" });
      return "protected";
    }
    const result = await injectPicker(tab.id, api.scripting);
    if (result.ok) {
      log.info({ event: "background_picker_started" });
      return null;
    }
    log.info({
      event: "background_picker_not_started",
      reason: result.reason,
      error: result.error,
    });
    return result.reason === "protected" ? "protected" : "failed";
  };

  /** Runs after the command listener has opened the sidebar. */
  const startPicker = (tab: GestureTab | undefined): void => {
    if (tab?.id === undefined) {
      log.warn({ event: "background_picker_no_tab" });
      return;
    }
    const pick: PendingPick = {
      tabId: tab.id,
      expires: Date.now() + START_PICKER_TTL_MS,
      status: undefined,
      announced: false,
      told: new Map(),
    };
    pending = pick;
    // A sidebar whose port is known hears of it now; one being opened, when it connects.
    for (const port of connected) {
      deliver(port);
    }
    const booted = boot({ ...tab, id: tab.id }).then((status) => {
      pick.status = status;
      if (pending === pick) {
        for (const port of connected) {
          deliver(port);
        }
      }
    });
    const waited = new Promise<void>((resolve) => setTimeout(resolve, START_PICKER_FALLBACK_MS));
    void Promise.all([booted, waited]).then(() => broadcast(pick));
  };

  if (browser === "chrome") {
    api.runtime.onInstalled.addListener(() => {
      api.sidePanel
        ?.setPanelBehavior({ openPanelOnActionClick: false })
        .catch(logFailure("sidebar_panel_behavior_failed"));
    });
    api.action.onClicked.addListener((tab) => {
      // First statement: the open must stay inside the click's gesture.
      openSidebar(tab);
    });
  } else {
    api.action.onClicked.addListener(() => {
      // First statement: Firefox refuses the toggle once the handler has awaited anything.
      api.sidebarAction?.toggle().catch(logFailure("sidebar_toggle_failed"));
    });
  }

  // A sidebar connecting its `sidebar` port is how it announces itself. Watched from import in
  // both browsers, so a sidebar that is already open is known when a shortcut comes.
  api.runtime.onConnect.addListener((port) => {
    // Only this extension's own sidebar page; a content script's port hears nothing.
    if (!acceptSidebarPort(port, api.runtime, log)) {
      return;
    }
    connected.add(port);
    port.onDisconnect.addListener(() => {
      connected.delete(port);
    });
    if (pending !== null) {
      pending.announced = true;
    }
    deliver(port);
  });

  api.commands.onCommand.addListener((command, tab) => {
    if (command !== "open-sidebar" && command !== "start-picker") {
      return;
    }
    // First browser call, nothing awaited before it: both commands open the sidebar.
    openSidebar(tab);
    if (command === "start-picker") {
      startPicker(tab);
    }
  });
}
