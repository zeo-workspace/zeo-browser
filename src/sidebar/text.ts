// Every fixed sentence the sidebar shows (story 045, design.md §A4, §Error Handling Strategy).
// The words are part of the requirements (R5.5, R5.6, R6.5, R6.6, R7.2, R7.10, R8.4, R8.6, R8.8,
// R10.5, R11.7) and the tests match them exactly, so they live in one place.
import type { SendLimit } from "../contract.js";
import {
  MAX_ELEMENTS,
  MAX_IMAGES,
  MAX_SEND_BYTES,
  MAX_TEXT_CHARS,
  PROTOCOL_VERSION,
} from "../limits.js";

export const TEXT = {
  connecting: "Connecting to Zeo…",
  unreachable: "Zeo is not running, or its devtools bridge is off",
  noHost: "The Zeo browser host is not installed (USE=browser-extension)",
  approve: "Approve this browser in Zeo",
  denied: "Zeo refused this browser",
  approvalFailed: "This browser was not approved in Zeo",
  busy: "Zeo is busy with other browsers",
  tryAgain: "Try again",
  noThread: "No active agent thread in Zeo",
  closed: "This thread was closed in Zeo",
  followActive: "Follow the active thread",
  followMenu: "Follow active thread",
  aiDisabled: "AI is disabled in Zeo",
  imagesSkipped: "Sent without images: this agent does not accept images",
  queued: "Queued in Zeo",
  recording: "Recording console & network",
  recordingStop: "Stop",
  recordingFailed: "Zeo could not record this page",
  recordingCutShort: "Recording stopped early: the debugger was detached",
  // Kept for the `screenshot_access` notice (a frozen sidebar test checks it). The Screenshot path
  // itself shows `screenshotPermissionText`: no per-site request is made for a capture (task 4.3).
  screenshotAccess: "Zeo needs access to this site to take a screenshot",
  screenshotFailed: "Zeo could not take the screenshot",
  protectedPage: "Zeo cannot read this page: the browser protects it",
  pickAccess: "Zeo needs access to this site to pick elements",
  pickFailed: "Zeo could not start the picker on this page",
  noSelector: "Zeo could not build a unique selector for this element",
  question: "The agent asked a question — answer it in Zeo",
  compaction: "Context compacted",
  truncated: "(truncated — open in Zeo for the rest)",
  openInZeo: "Open in Zeo",
  noAnswer: "Zeo did not answer",
} as const;

/** Notices other modules (the page tools of Task 4) ask the sidebar to show. */
export const NOTICES = {
  recording_cut_short: TEXT.recordingCutShort,
  screenshot_access: TEXT.screenshotAccess,
  images_skipped: TEXT.imagesSkipped,
  queued: TEXT.queued,
  ai_disabled: TEXT.aiDisabled,
} as const;
export type NoticeKey = keyof typeof NOTICES;

/**
 * What the address and screenshot sentences say for `<shortcut>` when no key is bound to
 * `start-picker` (R9.10, R10.8).
 */
export const PICK_SHORTCUT_UNBOUND = "the Pick element shortcut";

/**
 * The sentence for Pick on a page whose address the browser hides (R9.10). `shortcut` is the key
 * bound to `start-picker` (`pickShortcut` in pick-shortcut.ts), or `PICK_SHORTCUT_UNBOUND`.
 */
export const pageUnknownText = (shortcut: string): string =>
  `Zeo cannot see this page's address yet: on that page, press ${shortcut} (Pick element) or click the Zeo toolbar icon`;

/** The sentence for a capture refused for lack of permission (R10.8); `shortcut` as above. */
export const screenshotPermissionText = (shortcut: string): string =>
  `Zeo needs this page's permission for screenshots: press ${shortcut} on the page or click the Zeo toolbar icon, then try again`;

const fmt = (n: number): string => n.toLocaleString("en-US");

/** Why a message is refused before sending, naming the limit it breaks (R7.11). */
export const LIMIT_TEXT: Record<SendLimit, string> = {
  text: `Not sent: the text is over ${fmt(MAX_TEXT_CHARS)} characters`,
  elements: `Not sent: more than ${MAX_ELEMENTS} elements are attached`,
  images: `Not sent: more than ${MAX_IMAGES} images are attached`,
  console_captures: "Not sent: more than one console capture is attached",
  network_captures: "Not sent: more than one network capture is attached",
  bytes: `Not sent: the message is over ${fmt(MAX_SEND_BYTES)} bytes in total`,
};

/** The version-mismatch sentence, naming both sides (R8.7); an unknown side says so. */
export function versionMismatchText(versions?: {
  extension: { protocol: number; version: string };
  zeo: { protocol: number | null; version: string | null };
}): string {
  const ext = versions?.extension ?? { protocol: PROTOCOL_VERSION, version: "unknown" };
  const zeo = versions?.zeo ?? { protocol: null, version: null };
  return (
    "The extension and Zeo versions do not match: " +
    `extension ${ext.version} (protocol ${ext.protocol}), ` +
    `Zeo ${zeo.version ?? "unknown"} (protocol ${zeo.protocol ?? "unknown"})`
  );
}
