// The sidebar side of the picker (story 045, design.md §A5; R9.1, R9.9, R9.10): which pages the
// browser protects, the per-site permission and the injection of picker.js.
//
// `startPick` must be called synchronously from the Pick button's click handler: its first
// browser call is `permissions.request`, and Firefox refuses that call once the handler has
// awaited anything (the user-input rule). The protected check before it is pure.
//
// The shortcut path does not come through here: the background injects picker.js itself under the
// shortcut's `activeTab` grant (Task 4.5), where `permissions.request` would be refused.
import { TEXT } from "../sidebar/text.js";

/** Schemes the browser never lets an extension script. */
const PROTECTED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "moz-extension:",
  "view-source:",
]);
/** Extension stores, matched on the exact hostname. */
const PROTECTED_HOSTS = new Set(["chromewebstore.google.com", "addons.mozilla.org"]);
/** The old Chrome Web Store lives under one path of a host that is otherwise ordinary. */
const OLD_STORE_HOST = "chrome.google.com";
const OLD_STORE_PATH = "/webstore";
/**
 * Injection errors that mean the page is out of reach: Chrome's "Cannot access contents of the
 * page" / "Cannot access a chrome:// URL", and Firefox's "Missing host permission for the tab".
 */
const NO_ACCESS = /Cannot access|Missing host permission/i;

/**
 * Absolute on purpose. Firefox resolves a relative `files` entry against the calling page, so
 * "picker.js" called from the sidebar (`sidebar/index.html`) became `sidebar/picker.js` and
 * failed to load; Chrome resolves it against the extension root. A leading slash means the
 * root in both.
 */
export const PICKER_FILE = "/picker.js";

/**
 * Whether the browser forbids scripting `url` (R9.9). The URL is parsed and compared by scheme,
 * exact hostname and path prefix, so a store name in a subdomain, a path or a query does not
 * count. An unparseable URL counts as protected: nothing can be injected into it either.
 * Chrome's PDF viewer (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`) is covered by its
 * scheme.
 */
export function isProtectedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (PROTECTED_SCHEMES.has(parsed.protocol)) {
    return true;
  }
  if (PROTECTED_HOSTS.has(parsed.hostname)) {
    return true;
  }
  return (
    parsed.hostname === OLD_STORE_HOST &&
    (parsed.pathname === OLD_STORE_PATH || parsed.pathname.startsWith(`${OLD_STORE_PATH}/`))
  );
}

/**
 * The host-permission pattern of `url`'s site (`https://app.example/*`), or null for a scheme
 * no host permission can name (data:, blob:, …).
 */
export function originPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return `${parsed.origin}/*`;
  }
  if (parsed.protocol === "file:") {
    // A file: URL's origin is "null"; its pattern is the scheme with an empty host.
    return "file:///*";
  }
  return null;
}

/** The slice of the WebExtension API `startPick` uses (the platform shim's shape). */
export interface PickApi {
  permissions: { request(permissions: { origins: string[] }): Promise<boolean> };
  scripting: {
    executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
}

export type StartPickResult =
  | { ok: true }
  | {
      ok: false;
      reason: "protected" | "refused" | "failed";
      /** The sentence the sidebar shows. */
      message?: string;
      /** The error's name, for the log (never its text, which may name the page). */
      error?: string;
    };

const PROTECTED: StartPickResult = { ok: false, reason: "protected", message: TEXT.protectedPage };

/**
 * Asks for `tab`'s site (synchronously, before anything is awaited), then injects picker.js into
 * the tab's top frame. A protected page asks nothing and injects nothing; a refusal injects
 * nothing; an injection refused for lack of access, or a PDF viewer reported by the script, is
 * the protected state too, and a script that reports it did not start the picker is a failure.
 */
export async function startPick(
  tab: { id: number; url: string },
  browser: PickApi,
): Promise<StartPickResult> {
  const pattern = isProtectedUrl(tab.url) ? null : originPattern(tab.url);
  if (pattern === null) {
    return PROTECTED;
  }
  // First browser call, before any await: Firefox's user-input rule.
  const asked = browser.permissions.request({ origins: [pattern] });
  let granted: boolean;
  try {
    granted = await asked;
  } catch (err) {
    return failed(err);
  }
  if (!granted) {
    return { ok: false, reason: "refused", message: TEXT.pickAccess };
  }
  return injectPicker(tab.id, browser.scripting);
}

/**
 * Injects picker.js into `tabId`'s top frame and reads its boot status. It asks for nothing, so
 * the caller must already hold access to the tab: a granted site (the Pick button) or the
 * shortcut's `activeTab` grant (the background). An injection refused for lack of access is the
 * protected state; any other error, thrown or rejected, is a failure. Never rejects.
 */
export async function injectPicker(
  tabId: number,
  scripting: PickApi["scripting"],
): Promise<StartPickResult> {
  let results: unknown;
  try {
    results = await scripting.executeScript({ target: { tabId }, files: [PICKER_FILE] });
  } catch (err) {
    if (NO_ACCESS.test(messageOf(err))) {
      return PROTECTED;
    }
    return failed(err);
  }
  return readBootResult(results);
}

/**
 * Reads what picker.js evaluated to in the top frame (its boot status; see content.ts `boot`).
 * `protected` is a PDF viewer, whose URL is the PDF's own. A frame that threw (no status, or an
 * `error` entry as Firefox reports it) or reported `failed` did not start the picker. An empty
 * list says nothing about the frame and counts as started.
 */
export function readBootResult(results: unknown): StartPickResult {
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: true };
  }
  const top = (results[0] ?? {}) as { result?: unknown; error?: unknown };
  if (top.error !== undefined && top.error !== null) {
    return failed(top.error);
  }
  switch (top.result) {
    case "mounted":
      return { ok: true };
    case "protected":
      return PROTECTED;
    default:
      return { ok: false, reason: "failed", message: TEXT.pickFailed, error: "not_mounted" };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failed(err: unknown): StartPickResult {
  const error = err instanceof Error ? err.name : typeof err;
  return { ok: false, reason: "failed", message: TEXT.pickFailed, error };
}
