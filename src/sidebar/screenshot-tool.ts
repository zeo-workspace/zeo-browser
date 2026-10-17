// The sidebar's Screenshot button and "Include screenshot" toggle (story 045, design.md §A6;
// R9.8, R10.1–R10.4, R10.6).
//
// - Page tab: the Pick tool's (`PickTool.current` / `onChange`); this module never reads tabs
//   itself. The button is enabled once a page tab is known; a protected page disables it through
//   `Composer.setPageProtected`, whatever handler is installed.
// - Permission rule (the operator's "shortcut first, least privilege" decision):
//   `captureVisibleTab` needs `activeTab` or `<all_urls>`. `activeTab` comes from the shortcut
//   (`start-picker`, default Alt+Shift+D) or the toolbar-icon click on the page; the per-origin
//   optional host permission that Pick requests does NOT cover `captureVisibleTab`, and
//   `<all_urls>` is never requested. So nothing here calls `permissions.request`: both paths
//   capture directly, and a capture the browser rejects for missing permission shows
//   `screenshotPermissionText` — naming the key bound to `start-picker`, read when it is shown
//   (R10.8) — and nothing else.
// - Screenshot: captures the whole visible area. A hidden URL does not block it: `activeTab` may
//   be granted while the sidebar still cannot read the URL, and the capture does not need it.
// - Include screenshot: when a pick is delivered with the toggle on, the visible area is captured
//   and cropped to the union of the picked elements' rects, in the page's viewport (R9.8), under
//   the same permission rule.
// - Overlay: the picker's overlay is hidden for the capture with `tabs.sendMessage({type:"hide"})`
//   and shown again with `{type:"show"}`; a tab where picker.js never ran has no receiver and
//   nothing to hide (R10.2).
// - Every failure is `Error("screenshot failed", {cause})`: the reason goes to the notice line,
//   the log gets the error's name only, and the other chips stay.
import {
  type ImageAttachment,
  type Overlay,
  type Rect,
  type Viewport,
  captureVisible,
  cropAndFit,
  screenshotFailed,
  unionRect,
} from "../capture.js";
import { attachment as attachmentSchema } from "../contract.js";
import type { OverlayMessage } from "../picker/content.js";
import type { Composer } from "./composer.js";
import { type CommandsApi, pickShortcut } from "./pick-shortcut.js";
import type { PickTool } from "./pick-tool.js";
import { TEXT, screenshotPermissionText } from "./text.js";

/** The slice of the WebExtension API the Screenshot tool uses (`api` from `src/platform.ts`). */
export interface ShotDeps {
  tabs: { sendMessage(tabId: number, message: OverlayMessage): Promise<unknown> };
  /** Where the key named by the permission sentence is read (R10.8); absent, it says unbound. */
  commands?: CommandsApi;
}

/** The capture functions, injectable for tests; `src/capture.ts` by default. */
export interface CaptureFns {
  captureVisible(windowId: number, overlay?: Overlay): Promise<string>;
  cropAndFit(
    dataUrl: string,
    rect: Rect | null,
    viewport: Viewport | null,
  ): Promise<ImageAttachment>;
}

/** The composer hooks this tool reaches. */
export type ShotComposer = Pick<Composer, "setTool" | "notify" | "attach" | "includeScreenshot">;

/** Where the picked elements were, and the page's viewport (`SidebarHandle.lastPick`). */
export interface PickGeometryLike {
  rects: readonly Rect[];
  viewport: Viewport;
}

export interface ScreenshotTool {
  /**
   * Called with each delivered pick: with "Include screenshot" on, captures `tab` and attaches
   * the crop to the picked elements' union rect. Resolves when done, never rejects.
   */
  includeFor(geometry: PickGeometryLike, tab: { id: number; windowId: number }): Promise<void>;
}

/** How long the content script has to acknowledge `hide`, in ms. */
export const HIDE_ACK_TIMEOUT_MS = 1000;

/** The error a message to a tab with no content script listening rejects with. */
const NO_RECEIVER = /Receiving end does not exist/i;
/**
 * A capture rejected for lack of permission. Chrome says "Either the '<all_urls>' or 'activeTab'
 * permission is required"; Firefox's wording differs, so the match is loose, on the word itself.
 */
const NO_PERMISSION = /activeTab/i;

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * The reason a screenshot failed, in words: the permission sentence when the browser refused the
 * capture for lack of `activeTab` (naming the key bound to `start-picker`, read now from
 * `commands`), otherwise the cause's message. Never rejects.
 */
export async function failureReason(
  err: unknown,
  commands?: CommandsApi,
  log?: Pick<Console, "warn">,
): Promise<string> {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (NO_PERMISSION.test(message)) {
    return screenshotPermissionText(await pickShortcut(commands, log));
  }
  return message ? `${TEXT.screenshotFailed}: ${message}` : TEXT.screenshotFailed;
}

/** The picker overlay of `tabId`, reached over `tabs.sendMessage`. */
export function tabOverlay(tabs: ShotDeps["tabs"], tabId: number): Overlay {
  return {
    hide: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the picker did not hide its overlay")),
          HIDE_ACK_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([tabs.sendMessage(tabId, { type: "hide" }), timeout]);
      } catch (err) {
        if (err instanceof Error && NO_RECEIVER.test(err.message)) {
          // picker.js never ran in this tab: there is no overlay to hide.
          return;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    show: () =>
      tabs.sendMessage(tabId, { type: "show" }).catch(() => {
        // No receiver, or the tab is gone: nothing is left to show.
      }),
  };
}

/** Installs the Screenshot handler on `composer`, following the Pick tool's page tab. */
export function mountScreenshotTool(
  composer: ShotComposer,
  page: ShotDeps,
  pageTab: Pick<PickTool, "current" | "onChange">,
  log: Pick<Console, "info" | "warn">,
  capture: CaptureFns = { captureVisible, cropAndFit },
): ScreenshotTool {
  /** Captures `tab`, crops, validates against the contract and attaches the chip. */
  const shoot = async (
    tab: { id: number; windowId: number },
    rect: Rect | null,
    viewport: Viewport | null,
    via: "button" | "pick",
  ): Promise<void> => {
    try {
      const dataUrl = await capture.captureVisible(tab.windowId, tabOverlay(page.tabs, tab.id));
      const image = await capture.cropAndFit(dataUrl, rect, viewport);
      const parsed = attachmentSchema.safeParse(image);
      if (!parsed.success) {
        throw screenshotFailed(
          new Error(parsed.error.issues[0]?.message ?? "the image breaks the contract"),
        );
      }
      composer.attach(parsed.data);
      log.info({
        event: "sidebar_screenshot_attached",
        via,
        mime: image.mime,
        w: image.w,
        h: image.h,
      });
    } catch (err) {
      const failure =
        err instanceof Error && err.message === "screenshot failed" ? err : screenshotFailed(err);
      log.warn({ event: "sidebar_screenshot_failed", via, error: errorName(failure.cause) });
      composer.notify(await failureReason(failure, page.commands, log), "error");
    }
  };

  const onShot = (): void => {
    // A protected page never gets here (Composer.setPageProtected disables the button), and a
    // hidden URL is no obstacle: the capture needs activeTab, not the URL.
    const target = pageTab.current();
    if (target === null) {
      return;
    }
    composer.notify(null);
    void shoot(target, null, null, "button");
  };

  pageTab.onChange((tab) => composer.setTool("screenshot", tab === null ? null : onShot));
  if (pageTab.current() !== null) {
    composer.setTool("screenshot", onShot);
  }

  return {
    includeFor: async (geometry, tab) => {
      if (!composer.includeScreenshot()) {
        return;
      }
      const rect = unionRect(geometry.rects);
      if (rect === null) {
        // Every element was left out (no unique selector): nothing to crop to.
        return;
      }
      await shoot(tab, rect, geometry.viewport, "pick");
    },
  };
}
