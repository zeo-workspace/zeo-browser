// The sidebar ↔ background port (story 045, design.md §A2). The sidebar holds one
// `runtime.connect({ name: "sidebar" })` port for as long as it is open; its connecting is how the
// background learns a sidebar exists (Task 4.5's start-picker), and its disconnecting is how the
// background learns the sidebar died (the debugger janitor, R11.6).
//
// Sidebar → background messages are tagged `type` and never collide with the background →
// sidebar ones (`start-picker`, `picker-status`, Task 4.5). Type-only plus constants: both
// bundles import it.

/** The port's name. */
export const SIDEBAR_PORT = "sidebar";

/**
 * How often the sidebar pings while recording, in ms. Since Chrome 114 an idle port no longer
 * keeps the service worker alive, and a recording lasts up to 120 s.
 */
export const RECORDING_HEARTBEAT_MS = 20_000;

/** What the sidebar tells the background about a recording. */
export type SidebarPortMessage =
  | { type: "recording"; tabId: number }
  | { type: "recording_heartbeat" }
  | { type: "recording_stopped" };

/** Why the picker the shortcut asked for is not running in a tab. */
export type PickerBootStatus = "protected" | "failed";

/**
 * What the background tells the sidebar after the `start-picker` shortcut (Task 4.5).
 * `start-picker` says the shortcut targeted `tabId`, whose URL its `activeTab` grant has made
 * readable; `picker-status` follows only when picker.js is not running there — a protected page
 * (by URL, by a refused injection, or a PDF viewer) or a failed injection.
 */
export type BackgroundPortMessage =
  | { type: "start-picker"; tabId: number }
  | { type: "picker-status"; tabId: number; status: PickerBootStatus };
