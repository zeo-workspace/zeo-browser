// The sidebar's Pick element button and the page it acts on (story 045, design.md §A5; R9.1,
// R9.9, R9.10).
//
// - Page tab: the active tab of the window hosting this page (`windows.getCurrent`), which is the
//   window a side panel or a Firefox sidebar belongs to — each Firefox window has its own sidebar.
//   When this page is not in a normal window (the E2E spec opens it in a popup) the last-focused
//   normal window is used instead. The tab is re-read when a tab is activated, the tracked tab
//   updates, the focused window changes, and after every Pick; a stale answer is dropped.
// - Protected page: when the tab's URL is one the browser protects, Pick, Screenshot and Record
//   are disabled and the protected sentence is shown (`Composer.setPageProtected`). An injection
//   refused with "Cannot access", or one where picker.js reports a PDF viewer (whose URL is the
//   PDF's own), turns the same state on for that tab until its URL changes — whether the Pick
//   button injected it or the shortcut did (the background's `picker-status`, `showBoot`).
// - Pick: the handler calls `startPick` on the tab as last read, without awaiting anything first,
//   so its `permissions.request` stays inside the click (Firefox's user-input rule). A refusal
//   picks nothing.
// - The browser shows a tab's URL only with the `tabs` permission (which this extension does not
//   ask for) or with access to that page. Until one of those exists the URL is unknown, no
//   per-site permission can be named, and Pick says how to proceed instead (the operator's
//   "shortcut first" decision): the shortcut or the toolbar icon grants `activeTab`, after which
//   the URL is readable.
//
// The chips themselves arrive through the view's `picked` receiver; this module never builds one.
// The Screenshot tool (screenshot-tool.ts) reads the same page tab through `current` and
// `onChange` instead of tracking it a second time.
import { isProtectedUrl, startPick, type PickApi } from "../picker/inject.js";
import type { PickerBootStatus } from "../sidebar-port.js";
import type { Composer } from "./composer.js";
import { TEXT } from "./text.js";

interface BrowserEvent<F> {
  addListener(f: F): void;
  removeListener(f: F): void;
}

/** The slice of the WebExtension API the Pick tool uses (`api` from `src/platform.ts`). */
export interface PageDeps extends PickApi {
  tabs: {
    query(q: { active: true; windowId: number }): Promise<Array<{ id?: number; url?: string }>>;
    onActivated: BrowserEvent<() => void>;
    onUpdated: BrowserEvent<(tabId: number) => void>;
  };
  windows: {
    getCurrent(): Promise<{ id?: number; type?: string }>;
    getLastFocused(q: { windowTypes: Array<"normal"> }): Promise<{ id?: number }>;
    onFocusChanged: BrowserEvent<() => void>;
  };
}

/** The page the tools act on; `url` is absent while the browser hides it. */
export interface PageTab {
  id: number;
  /** The window the tab is in (what `captureVisibleTab` names). */
  windowId: number;
  url?: string;
}

export interface PickTool {
  /** Re-reads the page tab (the shortcut's `start-picker` notice calls this). */
  refresh(): void;
  /**
   * Shows why the shortcut's picker is not running in `tabId` (the background's `picker-status`):
   * the protected state, or the failure sentence. It re-reads the page tab first and applies only
   * when that tab is `tabId`, so a notice for another window's tab changes nothing here.
   */
  showBoot(tabId: number, status: PickerBootStatus): void;
  /** The page tab as last read, or null before the first answer. */
  current(): PageTab | null;
  /** Calls `f` with the page tab each time it is read (after the protected state is applied). */
  onChange(f: (tab: PageTab | null) => void): void;
  /** Removes the browser listeners. */
  close(): void;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Installs the Pick handler on `composer` and keeps the protected state in step with the tab. */
export function mountPickTool(
  composer: Composer,
  page: PageDeps,
  log: Pick<Console, "info" | "warn">,
): PickTool {
  let tab: PageTab | null = null;
  let seq = 0;
  const listeners: Array<(tab: PageTab | null) => void> = [];
  /** Tabs found protected only by trying (a PDF viewer), keyed by id, with the URL they had. */
  const foundProtected = new Map<number, string>();
  /** A shortcut boot outcome waiting for the next page-tab read (`showBoot`). */
  let boot: { tabId: number; status: PickerBootStatus } | null = null;

  const isProtected = (t: PageTab | null): boolean =>
    t?.url !== undefined && (isProtectedUrl(t.url) || foundProtected.get(t.id) === t.url);

  const onPick = (): void => {
    const target = tab;
    if (target === null) {
      return;
    }
    if (target.url === undefined) {
      composer.notify(TEXT.pageUnknown, "error");
      return;
    }
    // No await before this call: its first browser call is permissions.request.
    const started = startPick({ id: target.id, url: target.url }, page);
    const url = target.url;
    composer.notify(null);
    refresh();
    void started.then((result) => {
      if (result.ok) {
        log.info({ event: "sidebar_picker_started" });
        return;
      }
      log.info({ event: "sidebar_picker_not_started", reason: result.reason, error: result.error });
      if (result.reason === "protected") {
        foundProtected.set(target.id, url);
        composer.setPageProtected(isProtected(tab));
        return;
      }
      composer.notify(result.message ?? TEXT.pickFailed, "error");
    });
  };

  const apply = (next: PageTab | null): void => {
    tab = next;
    // A tab found protected stays so until it shows another URL.
    const known = next === null ? undefined : foundProtected.get(next.id);
    if (next !== null && next.url !== undefined && known !== undefined && known !== next.url) {
      foundProtected.delete(next.id);
    }
    const shown = boot;
    boot = null;
    if (shown !== null && next !== null && next.id === shown.tabId) {
      if (shown.status === "failed") {
        composer.notify(TEXT.pickFailed, "error");
      } else if (next.url !== undefined) {
        foundProtected.set(next.id, next.url);
      } else {
        // No URL to key the protected state on: say it once instead.
        composer.notify(TEXT.protectedPage, "error");
      }
    }
    composer.setPageProtected(isProtected(next));
    composer.setTool("pick", next === null ? null : onPick);
    for (const f of listeners) {
      f(next);
    }
  };

  const read = async (): Promise<PageTab | null> => {
    const current = await page.windows.getCurrent();
    const win =
      current.type === "normal"
        ? current
        : await page.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) {
      return null;
    }
    const [active] = await page.tabs.query({ active: true, windowId: win.id });
    if (active?.id === undefined) {
      return null;
    }
    const found = { id: active.id, windowId: win.id };
    return active.url === undefined ? found : { ...found, url: active.url };
  };

  const refresh = (): void => {
    const mine = ++seq;
    read()
      .then((next) => {
        if (mine === seq) {
          apply(next);
        }
      })
      .catch((err: unknown) => {
        log.warn({ event: "sidebar_page_tab_failed", error: errorName(err) });
        if (mine === seq) {
          apply(null);
        }
      });
  };

  const onActivated = () => refresh();
  const onUpdated = (tabId: number) => {
    if (tabId === tab?.id) {
      refresh();
    }
  };
  const onFocusChanged = () => refresh();
  page.tabs.onActivated.addListener(onActivated);
  page.tabs.onUpdated.addListener(onUpdated);
  page.windows.onFocusChanged.addListener(onFocusChanged);
  refresh();

  return {
    refresh,
    showBoot: (tabId, status) => {
      boot = { tabId, status };
      refresh();
    },
    current: () => tab,
    onChange: (f) => {
      listeners.push(f);
    },
    close: () => {
      page.tabs.onActivated.removeListener(onActivated);
      page.tabs.onUpdated.removeListener(onUpdated);
      page.windows.onFocusChanged.removeListener(onFocusChanged);
    },
  };
}
