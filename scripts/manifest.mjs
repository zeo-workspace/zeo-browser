// One source, two manifests: manifest.base.json plus a per-browser overlay (design.md §A1).
// Overlay keys replace base keys whole; nothing is deep-merged, so a browser can never inherit
// the other one's background or sidebar key.
import BASE from "../manifest.base.json" with { type: "json" };
import chrome from "../manifests/chrome.json" with { type: "json" };
import firefox from "../manifests/firefox.json" with { type: "json" };

/** @type {Record<string, Record<string, unknown>>} */
const OVERLAYS = { chrome, firefox };

/**
 * @param {"chrome" | "firefox"} browser
 * @returns {Record<string, unknown>} a fresh manifest object; callers may mutate it
 */
export function buildManifest(browser) {
  const overlay = Object.hasOwn(OVERLAYS, browser) ? OVERLAYS[browser] : undefined;
  if (!overlay) {
    throw new Error(`unknown browser ${JSON.stringify(browser)}: expected chrome or firefox`);
  }
  return structuredClone({ ...BASE, ...overlay });
}
