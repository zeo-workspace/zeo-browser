// The sidebar view (story 045, design.md §A4): header, connection banner, transcript, status line,
// permission cards and the composer, driven by the native channel (§A3).
//
// - Header: the thread's title, project and agent; the target menu ("Follow active thread" plus
//   the threads `list_threads` returns, R5.1); "Open in Zeo" (R5.7), showing its error if any.
// - Banner: the connection state in its exact words (R8.4–R8.8), each fatal error's own message
//   with "Try again", and the thread notices (no thread R5.6, closed R5.5, AI disabled R7.10).
// - Transcript: entries keyed by index — replaced on update, spliced on removal (R6.2–R6.4) — with
//   the earlier-entries line (R6.1) and the status line (R6.7). Event indices are the thread's own
//   (`AcpThread` indices); the snapshot's first entry is index `earlier`. An index past the end
//   means an event was missed, and the view re-subscribes to resync instead of guessing.
// - Thread binding: thread events apply only while the view is bound to a thread (after its
//   snapshot or a `target_changed` naming one). Choosing another target, or a subscribe that
//   fails, unbinds it and clears the old thread off the screen, so a late event from the old
//   thread cannot land under the new choice.
// - Storage: only `target` (`"follow" | {thread_id}`) is written (R5.8, R8.10).
//
// Model output reaches the page only through `markdownFragment` (markdown.ts); every other string
// goes in as text.
import type {
  ConnState,
  RequestKind,
  RequestMsg,
  ServerEvent,
  ServerReply,
  StateDetail,
} from "../channel.js";
import { fitSend, reencodeJpeg } from "../capture.js";
import {
  type ClientMsg,
  type Entry,
  type Permission,
  type ServerMsgOf,
  type Status,
  type ThreadInfo,
  attachment as attachmentSchema,
} from "../contract.js";
import { MAX_ELEMENTS } from "../limits.js";
import type { Browser } from "../platform.js";
import { z } from "zod";
import { Composer, button, errorText, failureText } from "./composer.js";
import { markdownFragment } from "./markdown.js";
import { type BackgroundPort, type PortLike, connectBackground } from "./background-port.js";
import { type PageDeps, type PickTool, mountPickTool } from "./pick-tool.js";
import { type RecordTool, type RecorderApi, mountRecordTool } from "./record-tool.js";
import { type ScreenshotTool, type ShotDeps, mountScreenshotTool } from "./screenshot-tool.js";
import { NOTICES, type NoticeKey, TEXT, versionMismatchText } from "./text.js";

/** The slice of `Channel` the view uses. */
export interface SidebarChannel {
  connect(): void;
  close(): void;
  request<K extends RequestKind>(msg: RequestMsg<K> & { kind: K }): Promise<ServerReply<K>>;
  on(ev: "state", f: (state: ConnState, detail?: StateDetail) => void): void;
  on(ev: "event", f: (event: ServerEvent) => void): void;
}

/** `storage.local`, as far as the view uses it. */
export interface SidebarStorage {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type RuntimeListener = (message: unknown, sender?: unknown) => void;

/**
 * `runtime`, as far as the view uses it: the picker's `picked` messages arrive here, and the
 * `sidebar` port to the background is opened through `connect` (absent in some tests).
 */
export interface SidebarRuntime {
  /** This extension's id; a `picked` message is accepted only from it. */
  id?: string;
  connect?(info: { name: string }): PortLike;
  onMessage: {
    addListener(f: RuntimeListener): void;
    removeListener(f: RuntimeListener): void;
  };
}

export interface SidebarDeps {
  channel: SidebarChannel;
  storage: SidebarStorage;
  runtime: SidebarRuntime;
  platform: { BROWSER: Browser; HAS_DEBUGGER: boolean };
  /**
   * The browser APIs the page tools reach the page tab through (`tabs`, `windows`, `permissions`,
   * `scripting`). Without them the Pick and Screenshot buttons stay disabled.
   */
  page?: PageDeps & ShotDeps;
  /**
   * The console/network recorder (`src/recorder.ts`), handed over by the Chrome build only. With
   * it, `HAS_DEBUGGER` and `page`, the Record button works (R11.1, R11.9).
   */
  recorder?: RecorderApi;
  /** The structured logger; `console` when absent. */
  log?: Pick<Console, "info" | "warn">;
}

/** What `mountSidebar` hands back, for the page tools (Task 4) and for teardown. */
export interface SidebarHandle {
  composer: Composer;
  /** Shows one of the fixed notices in the composer ("Recording stopped early: …", …). */
  showNotice(key: NoticeKey): void;
  /** The rects and viewport of the last pick, for "Include screenshot" (Task 4.3). */
  lastPick(): PickGeometry | null;
  /** Removes the listeners and closes the channel. */
  close(): void;
}

/** Page coordinates are bounded so a hostile content script cannot hand over absurd numbers. */
const MAX_COORD = 1_000_000;
const MAX_VIEWPORT_EDGE = 100_000;
const coord = z.number().min(-MAX_COORD).max(MAX_COORD);
const extent = z.number().min(0).max(MAX_COORD);
const edge = z.number().gt(0).max(MAX_VIEWPORT_EDGE);
const pickGeometry = z.object({
  rects: z.array(z.strictObject({ x: coord, y: coord, w: extent, h: extent })).max(MAX_ELEMENTS),
  viewport: z.strictObject({ innerWidth: edge, innerHeight: edge }),
});
/** Where the picked elements were, in the page's CSS pixels, and the page's viewport. */
export type PickGeometry = z.infer<typeof pickGeometry>;

/** The stored subscription choice (R5.8). */
export type StoredTarget = "follow" | { thread_id: string };
type WireTarget = ClientMsg<"subscribe">["target"];

const FOLLOW_VALUE = "follow";
const threadValue = (id: string): string => `thread:${id}`;

/** The stored choice, read defensively: anything but a pinned thread id means follow. */
export function parseTarget(value: unknown): StoredTarget {
  if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>).thread_id;
    if (typeof id === "string" && id.length > 0) {
      return { thread_id: id };
    }
  }
  return "follow";
}

const toWire = (t: StoredTarget): WireTarget =>
  t === "follow" ? { follow: true } : { thread_id: t.thread_id };

const STATUS_WORDS: Record<Status["state"], string> = {
  idle: "Idle",
  working: "Working…",
  awaiting_permission: "Waiting for permission",
  error: "Error",
};

const TOOL_STATUS_WORDS: Record<NonNullable<Entry["tool"]>["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  awaiting_permission: "Waiting for permission",
};

const NOTICE_TONE: Record<NoticeKey, "info" | "error"> = {
  recording_cut_short: "error",
  screenshot_access: "error",
  images_skipped: "info",
  queued: "info",
  ai_disabled: "error",
};

/** The banner's content: lines of text and, optionally, one action button. */
interface BannerSpec {
  tone: "info" | "warn" | "error";
  lines: string[];
  action?: { label: string; run: () => void };
}

type ThreadNotice = "no_thread" | "closed" | "ai_disabled" | { message: string } | null;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

class SidebarView {
  readonly composer: Composer;
  private readonly doc: Document;
  private readonly deps: SidebarDeps;
  private readonly log: Pick<Console, "info" | "warn">;

  // Header
  private readonly titleEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly menu: HTMLSelectElement;
  private readonly headerError: HTMLElement;
  // Body
  private readonly banner: HTMLElement;
  private readonly earlierEl: HTMLElement;
  private readonly entryList: HTMLOListElement;
  private readonly statusEl: HTMLElement;
  private readonly permsEl: HTMLElement;

  // State
  private target: StoredTarget = "follow";
  private conn: ConnState = "connecting";
  private connDetail: StateDetail | undefined;
  private thread: ThreadInfo | null = null;
  private threadNotice: ThreadNotice = null;
  private threads: ThreadInfo[] = [];
  private menuKey = "";
  private listing = false;
  private subscribeSeq = 0;
  /** Whether thread events apply: the view shows the thread they belong to. */
  private bound = false;
  /** A resync subscribe is in flight; index events wait for its snapshot. */
  private resyncing = false;
  /** Thread index of the first entry shown (the snapshot's `earlier`). */
  private base = 0;
  private entries: HTMLLIElement[] = [];
  private permissions = new Map<string, HTMLElement>();
  private pick: PickGeometry | null = null;
  private readonly pickTool: PickTool | null;
  private readonly shotTool: ScreenshotTool | null;
  private readonly recordTool: RecordTool | null;
  /** The `sidebar` port: announces this sidebar to the background and feeds the janitor. */
  readonly backgroundPort: BackgroundPort | null;

  constructor(root: HTMLElement, deps: SidebarDeps) {
    this.doc = root.ownerDocument;
    this.deps = deps;
    this.log = deps.log ?? console;
    const doc = this.doc;

    // Header
    const header = el(doc, "header", "hdr");
    const ident = el(doc, "div", "hdr-thread");
    this.titleEl = el(doc, "h1", "hdr-title", "Zeo");
    this.metaEl = el(doc, "p", "hdr-meta");
    ident.append(this.titleEl, this.metaEl);
    const controls = el(doc, "div", "hdr-controls");
    const menuLabel = el(doc, "label", "visually-hidden", "Thread shown in the sidebar");
    menuLabel.htmlFor = "zeo-target";
    this.menu = el(doc, "select", "hdr-menu");
    this.menu.id = "zeo-target";
    this.menu.addEventListener("focus", () => void this.listThreads());
    this.menu.addEventListener("mousedown", () => void this.listThreads());
    this.menu.addEventListener("change", () => void this.choose(this.menu.value));
    const open = button(doc, TEXT.openInZeo, "btn btn-quiet");
    open.addEventListener("click", () => void this.openInZeo());
    controls.append(menuLabel, this.menu, open);
    this.headerError = el(doc, "p", "hdr-error");
    this.headerError.setAttribute("role", "alert");
    header.append(ident, controls, this.headerError);

    // Banner
    this.banner = el(doc, "div", "banner");
    this.banner.setAttribute("role", "status");
    this.banner.setAttribute("aria-live", "polite");

    // Transcript
    const transcript = el(doc, "main", "transcript");
    transcript.setAttribute("aria-label", "Thread transcript");
    this.earlierEl = el(doc, "p", "earlier");
    this.entryList = el(doc, "ol", "entries");
    transcript.append(this.earlierEl, this.entryList);

    // Status, permissions, composer
    this.statusEl = el(doc, "p", "status");
    this.statusEl.setAttribute("role", "status");
    this.permsEl = el(doc, "section", "perms");
    this.permsEl.setAttribute("aria-label", "Permission requests");
    this.composer = new Composer(doc, {
      channel: deps.channel,
      hasDebugger: deps.platform.HAS_DEBUGGER,
      log: this.log,
      fitSend: (text, attachments) => fitSend(text, attachments, reencodeJpeg, this.log),
    });

    root.classList.add("zeo-sidebar");
    root.replaceChildren(
      header,
      this.banner,
      transcript,
      this.statusEl,
      this.permsEl,
      this.composer.element,
    );
    this.renderHeader();
    this.renderMenu();
    this.renderBanner();
    this.renderStatus(null);
    this.pickTool = deps.page ? mountPickTool(this.composer, deps.page, this.log) : null;
    this.shotTool =
      deps.page && this.pickTool
        ? mountScreenshotTool(this.composer, deps.page, this.pickTool, this.log)
        : null;
    const connect = deps.runtime.connect?.bind(deps.runtime);
    this.backgroundPort = connect ? connectBackground({ connect }, this.log) : null;
    // The shortcut's `start-picker` and its boot outcome arrive on the port (Task 4.5).
    this.backgroundPort?.onMessage((message) => this.onBackgroundMessage(message));
    this.recordTool =
      deps.platform.HAS_DEBUGGER && deps.recorder && this.pickTool
        ? mountRecordTool({
            composer: this.composer,
            pageTab: this.pickTool,
            recorder: deps.recorder,
            port: this.backgroundPort,
            notice: (key) => this.composer.notify(NOTICES[key], NOTICE_TONE[key]),
            log: this.log,
            doc,
          })
        : null;
  }

  /** Removes the page tools' browser listeners and closes the background port. */
  closeTools(): void {
    this.pickTool?.close();
    this.recordTool?.close();
    this.backgroundPort?.close();
  }

  /** Restores the stored choice; must finish before the channel can report `ready`. */
  async restoreTarget(): Promise<void> {
    try {
      const got = await this.deps.storage.get("target");
      this.target = parseTarget(got?.target);
    } catch (err) {
      this.log.warn({ event: "sidebar_target_read_failed", error: failureText(err) });
      this.target = "follow";
    }
    this.renderMenu();
  }

  // ---------------------------------------------------------------------------------------------
  // Channel

  onState(state: ConnState, detail?: StateDetail): void {
    this.conn = state;
    this.connDetail = detail;
    if (state === "ready") {
      this.threadNotice = null;
      // Synchronous: the channel joins this subscribe to its own re-subscribe (R8.5).
      this.subscribe();
    }
    this.renderBanner();
  }

  onEvent(e: ServerEvent): void {
    switch (e.kind) {
      case "snapshot":
        this.applySnapshot(e);
        return;
      case "target_changed":
        // The old thread's entries must not sit under the new title; Zeo sends a snapshot next.
        this.unbind();
        this.thread = e.thread;
        this.bound = e.thread !== null;
        this.threadNotice = e.thread === null ? "no_thread" : null;
        this.renderHeader();
        this.renderBanner();
        return;
      default:
        break;
    }
    if (!this.bound) {
      // An event of a thread the view no longer shows (or does not show yet).
      return;
    }
    switch (e.kind) {
      case "title":
        if (this.thread) {
          this.thread = { ...this.thread, title: e.title };
          this.renderHeader();
        }
        break;
      case "entry_added":
        this.insertEntry(e.index, e.entry);
        break;
      case "entry_updated":
        this.updateEntry(e.index, e.entry);
        break;
      case "entries_removed":
        this.removeEntries(e.start, e.end);
        break;
      case "status":
        this.renderStatus(e.status);
        break;
      case "permission_requested":
        this.addPermission(e.permission);
        break;
      case "permission_resolved":
        this.removePermission(e.request_id);
        break;
      case "thread_closed":
        this.bound = false;
        this.threadNotice = "closed";
        this.clearPermissions();
        this.renderBanner();
        break;
      default:
        // `sent`, `ok`, `threads`, `error` without a waiting request: nothing to show.
        break;
    }
  }

  /** Clears the shown thread — header, transcript, status, permissions — and stops its events. */
  private unbind(): void {
    this.bound = false;
    this.thread = null;
    this.resetTranscript(0);
    this.clearPermissions();
    this.renderStatus(null);
    this.renderHeader();
  }

  /** Re-subscribes to the current target after a missed event (an index out of range). */
  private resync(event: string, index: number): void {
    this.log.warn({ event: "sidebar_transcript_resync", kind: event, index });
    if (this.resyncing || this.conn !== "ready") {
      return;
    }
    this.resyncing = true;
    this.subscribe();
  }

  private subscribe(): void {
    const seq = ++this.subscribeSeq;
    this.deps.channel
      .request({ v: 2, kind: "subscribe", target: toWire(this.target) })
      .then((reply) => {
        if (seq !== this.subscribeSeq) {
          return;
        }
        this.resyncing = false;
        if (reply.kind === "snapshot") {
          this.applySnapshot(reply);
        } else {
          // Whatever was shown is not the target's: clear it, as target_changed does.
          this.unbind();
          this.showThreadError(reply);
        }
      })
      .catch((err: unknown) => {
        this.log.warn({ event: "sidebar_subscribe_failed", error: failureText(err) });
        if (seq !== this.subscribeSeq) {
          return;
        }
        this.resyncing = false;
        this.threadNotice = { message: failureText(err) };
        this.renderBanner();
      });
  }

  private showThreadError(reply: ServerMsgOf<"error">): void {
    switch (reply.error) {
      case "no_thread":
        this.threadNotice = "no_thread";
        break;
      case "thread_closed":
        this.threadNotice = "closed";
        break;
      case "ai_disabled":
        this.threadNotice = "ai_disabled";
        break;
      default:
        this.threadNotice = { message: errorText(reply) };
    }
    this.renderBanner();
  }

  // ---------------------------------------------------------------------------------------------
  // Header and target menu

  private renderHeader(): void {
    this.titleEl.textContent = this.thread?.title || "Zeo";
    this.metaEl.textContent = this.thread ? `${this.thread.project} · ${this.thread.agent}` : "";
    this.renderMenu();
  }

  private renderMenu(): void {
    const options: Array<[value: string, label: string]> = [[FOLLOW_VALUE, TEXT.followMenu]];
    for (const t of this.threads) {
      options.push([threadValue(t.thread_id), `${t.title || "Untitled"} — ${t.project}`]);
    }
    const pinned = this.target === "follow" ? null : this.target.thread_id;
    if (pinned !== null && !this.threads.some((t) => t.thread_id === pinned)) {
      const title = this.thread?.thread_id === pinned ? this.thread.title : "Pinned thread";
      options.push([threadValue(pinned), title || "Pinned thread"]);
    }
    // Rebuilt only when it changes, so an open menu is not reset under the pointer.
    const key = JSON.stringify(options);
    if (key !== this.menuKey) {
      this.menuKey = key;
      this.menu.replaceChildren(
        ...options.map(([value, label]) => {
          const o = el(this.doc, "option", undefined, label);
          o.value = value;
          return o;
        }),
      );
    }
    this.menu.value = pinned === null ? FOLLOW_VALUE : threadValue(pinned);
  }

  private async listThreads(): Promise<void> {
    if (this.listing || this.conn !== "ready") {
      return;
    }
    this.listing = true;
    try {
      const reply = await this.deps.channel.request({ v: 2, kind: "list_threads" });
      if (reply.kind === "threads") {
        this.threads = reply.items;
        this.headerError.textContent = "";
        this.renderMenu();
      } else {
        this.headerError.textContent = errorText(reply);
      }
    } catch (err) {
      this.log.warn({ event: "sidebar_list_threads_failed", error: failureText(err) });
    } finally {
      this.listing = false;
    }
  }

  private async choose(value: string): Promise<void> {
    const next: StoredTarget = value.startsWith("thread:")
      ? { thread_id: value.slice("thread:".length) }
      : "follow";
    await this.setTarget(next);
  }

  private async setTarget(next: StoredTarget): Promise<void> {
    this.target = next;
    this.threadNotice = null;
    // The old thread leaves the screen now; the new one arrives with its snapshot.
    this.unbind();
    this.renderBanner();
    if (this.conn === "ready") {
      this.subscribe();
    }
    try {
      // Only the choice is stored: never thread content (R8.10).
      await this.deps.storage.set({ target: next });
    } catch (err) {
      this.log.warn({ event: "sidebar_target_write_failed", error: failureText(err) });
    }
  }

  private async openInZeo(): Promise<void> {
    this.headerError.textContent = "";
    try {
      const reply = await this.deps.channel.request({ v: 2, kind: "open_in_zeo" });
      if (reply.kind === "error") {
        this.headerError.textContent = errorText(reply);
      }
    } catch (err) {
      this.log.warn({ event: "sidebar_open_in_zeo_failed", error: failureText(err) });
      this.headerError.textContent = failureText(err);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Banner

  private bannerSpec(): BannerSpec | null {
    const retry = { label: TEXT.tryAgain, run: () => this.deps.channel.connect() };
    const message = this.connDetail?.message;
    const withMessage = (line: string): string[] =>
      message && message !== line ? [line, message] : [line];
    switch (this.conn) {
      case "connecting":
        return { tone: "info", lines: [TEXT.connecting] };
      case "approval_pending":
        return { tone: "info", lines: [TEXT.approve] };
      case "unreachable":
        return { tone: "warn", lines: withMessage(TEXT.unreachable), action: retry };
      case "no_host":
        return { tone: "error", lines: [TEXT.noHost], action: retry };
      case "version_mismatch":
        return {
          tone: "error",
          lines: withMessage(versionMismatchText(this.connDetail?.versions)),
          action: retry,
        };
      case "denied":
        return { tone: "error", lines: withMessage(TEXT.denied), action: retry };
      case "approval_failed":
        return { tone: "error", lines: withMessage(TEXT.approvalFailed), action: retry };
      case "busy":
        return { tone: "warn", lines: withMessage(TEXT.busy), action: retry };
      case "ready":
        break;
    }
    const notice = this.threadNotice;
    if (notice === null) {
      return null;
    }
    if (notice === "no_thread") {
      return { tone: "info", lines: [TEXT.noThread] };
    }
    if (notice === "ai_disabled") {
      return { tone: "warn", lines: [TEXT.aiDisabled] };
    }
    if (notice === "closed") {
      return {
        tone: "warn",
        lines: [TEXT.closed],
        action: { label: TEXT.followActive, run: () => void this.setTarget("follow") },
      };
    }
    return { tone: "error", lines: [notice.message] };
  }

  private renderBanner(): void {
    const spec = this.bannerSpec();
    if (spec === null) {
      this.banner.replaceChildren();
      this.banner.hidden = true;
      return;
    }
    const text = el(this.doc, "div", "banner-text");
    for (const line of spec.lines) {
      text.append(el(this.doc, "p", undefined, line));
    }
    const children: HTMLElement[] = [text];
    if (spec.action) {
      const { label, run } = spec.action;
      const b = button(this.doc, label, "btn btn-quiet");
      b.addEventListener("click", run);
      children.push(b);
    }
    this.banner.dataset.tone = spec.tone;
    this.banner.hidden = false;
    this.banner.replaceChildren(...children);
  }

  // ---------------------------------------------------------------------------------------------
  // Transcript

  private applySnapshot(s: ServerMsgOf<"snapshot">): void {
    this.thread = s.thread;
    this.bound = s.thread !== null;
    this.resyncing = false;
    this.threadNotice = s.thread === null ? "no_thread" : null;
    this.resetTranscript(s.earlier);
    for (const entry of s.entries) {
      const node = this.renderEntry(entry);
      this.entries.push(node);
      this.entryList.append(node);
    }
    this.renderStatus(s.status);
    this.clearPermissions();
    for (const p of s.permissions) {
      this.addPermission(p);
    }
    this.renderHeader();
    this.renderBanner();
    this.scrollToEnd();
  }

  private resetTranscript(earlier: number): void {
    this.base = earlier;
    this.entries = [];
    this.entryList.replaceChildren();
    this.renderEarlier();
  }

  private renderEarlier(): void {
    if (this.base <= 0) {
      this.earlierEl.replaceChildren();
      this.earlierEl.hidden = true;
      return;
    }
    const words = this.base === 1 ? "1 earlier entry — " : `${this.base} earlier entries — `;
    const open = button(this.doc, TEXT.openInZeo, "btn-link");
    open.addEventListener("click", () => void this.openInZeo());
    this.earlierEl.hidden = false;
    this.earlierEl.replaceChildren(this.doc.createTextNode(words), open);
  }

  private insertEntry(index: number, entry: Entry): void {
    if (this.resyncing) {
      return;
    }
    if (index < this.base) {
      // Before the shown window: only the count moves.
      this.base++;
      this.renderEarlier();
      return;
    }
    const at = index - this.base;
    if (at > this.entries.length) {
      this.resync("entry_added", index);
      return;
    }
    const node = this.renderEntry(entry);
    const before = this.entries[at] ?? null;
    this.entryList.insertBefore(node, before);
    this.entries.splice(at, 0, node);
    this.scrollToEnd();
  }

  private updateEntry(index: number, entry: Entry): void {
    if (this.resyncing || index < this.base) {
      // Before the shown window: nothing on screen changes.
      return;
    }
    const at = index - this.base;
    const old = this.entries[at];
    if (!old) {
      this.resync("entry_updated", index);
      return;
    }
    const node = this.renderEntry(entry);
    old.replaceWith(node);
    this.entries[at] = node;
  }

  private removeEntries(start: number, end: number): void {
    if (this.resyncing || end <= start) {
      return;
    }
    if (end - this.base > this.entries.length) {
      this.resync("entries_removed", end);
      return;
    }
    // The part before the shown window only lowers the count.
    const hidden = Math.max(0, Math.min(end, this.base) - start);
    const from = Math.max(start - this.base, 0);
    const to = Math.max(end - this.base, 0);
    for (const node of this.entries.splice(from, to - from)) {
      node.remove();
    }
    if (hidden > 0) {
      this.base -= hidden;
      this.renderEarlier();
    }
  }

  private renderEntry(entry: Entry): HTMLLIElement {
    const doc = this.doc;
    const li = el(doc, "li", `entry entry-${entry.role}`);
    switch (entry.role) {
      case "question":
        li.append(el(doc, "p", "entry-note", TEXT.question));
        return li;
      case "compaction":
        li.append(el(doc, "p", "entry-note", TEXT.compaction));
        return li;
      case "tool": {
        const tool = entry.tool;
        const head = el(doc, "span", "tool-head");
        head.append(el(doc, "span", "tool-title", tool?.title || "Tool call"));
        if (tool) {
          const pill = el(doc, "span", "tool-status", TOOL_STATUS_WORDS[tool.status]);
          pill.dataset.status = tool.status;
          head.append(pill);
        }
        if (entry.markdown.length === 0 && !entry.truncated) {
          li.append(head);
          return li;
        }
        const details = el(doc, "details", "tool");
        const summary = el(doc, "summary");
        summary.append(head);
        details.append(summary, this.body(entry));
        li.append(details);
        return li;
      }
      case "user":
      case "assistant":
        li.append(el(doc, "span", "visually-hidden", entry.role === "user" ? "You:" : "Agent:"));
        li.append(this.body(entry));
        return li;
    }
  }

  /** An entry's text: its Markdown, then the truncation note when Zeo cut it (R6.6). */
  private body(entry: Entry): HTMLElement {
    const body = el(this.doc, "div", "md");
    body.append(markdownFragment(entry.markdown, this.doc));
    // Zeo may already end the text with the note; it is shown once.
    if (entry.truncated && !entry.markdown.trimEnd().endsWith(TEXT.truncated)) {
      body.append(el(this.doc, "p", "truncated", TEXT.truncated));
    }
    return body;
  }

  private renderStatus(status: Status | null): void {
    const state = status?.state ?? "idle";
    const words = STATUS_WORDS[state];
    this.statusEl.dataset.state = state;
    this.statusEl.textContent =
      state === "error" && status?.message ? `${words}: ${status.message}` : words;
    this.composer.setStatus(state);
  }

  private scrollToEnd(): void {
    const scroller = this.entryList.parentElement;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Permissions

  private addPermission(p: Permission): void {
    this.removePermission(p.request_id);
    const doc = this.doc;
    const card = el(doc, "article", "perm");
    card.setAttribute("aria-label", `Permission request: ${p.title}`);
    card.append(el(doc, "p", "perm-title", p.title));
    const error = el(doc, "p", "perm-error");
    error.setAttribute("role", "alert");
    const row = el(doc, "div", "perm-options");
    const buttons = p.options.map((o) => {
      const kind = o.kind.startsWith("allow") ? "btn-allow" : "btn-reject";
      const b = button(doc, o.label, `btn ${kind}`);
      b.addEventListener("click", () => void this.authorize(p.request_id, o.option_id, buttons));
      return b;
    });
    row.append(...buttons);
    card.append(row, error);
    this.permissions.set(p.request_id, card);
    this.permsEl.append(card);
  }

  private async authorize(
    requestId: string,
    optionId: string,
    buttons: HTMLButtonElement[],
  ): Promise<void> {
    const card = this.permissions.get(requestId);
    const error = card?.querySelector(".perm-error");
    for (const b of buttons) {
      b.disabled = true;
    }
    let failed: string | null = null;
    try {
      const reply = await this.deps.channel.request({
        v: 2,
        kind: "authorize",
        request_id: requestId,
        option_id: optionId,
      });
      if (reply.kind === "error") {
        if (reply.error === "stale_permission") {
          // Already answered elsewhere: the card has nothing left to ask.
          this.removePermission(requestId);
          return;
        }
        failed = errorText(reply);
      }
    } catch (err) {
      this.log.warn({ event: "sidebar_authorize_failed", error: failureText(err) });
      failed = failureText(err);
    }
    // The card goes on `permission_resolved` (its own request only), not on `ok` (R7.6, R7.7).
    if (failed !== null) {
      if (error) {
        error.textContent = failed;
      }
      for (const b of buttons) {
        b.disabled = false;
      }
    }
  }

  private removePermission(requestId: string): void {
    this.permissions.get(requestId)?.remove();
    this.permissions.delete(requestId);
  }

  private clearPermissions(): void {
    for (const card of this.permissions.values()) {
      card.remove();
    }
    this.permissions.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // The picker's chips

  onRuntimeMessage(message: unknown, sender: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    // Only this extension may speak here; only its content script (a sender with a tab) may
    // attach page elements.
    const from = (sender ?? {}) as { id?: unknown; tab?: unknown };
    const ownId = this.deps.runtime.id;
    if (typeof ownId !== "string" || from.id !== ownId) {
      return;
    }
    const type = (message as { type?: unknown }).type;
    if (type === "start-picker" || type === "picker-status") {
      // The background's notices only: a sender with a tab is a content script, never trusted.
      if (from.tab == null) {
        this.onBackgroundMessage(message);
      }
      return;
    }
    const m = message as {
      type?: unknown;
      items?: unknown;
      rects?: unknown;
      viewport?: unknown;
      skipped?: unknown;
    };
    if (from.tab == null) {
      return;
    }
    if (m.type !== "picked" || !Array.isArray(m.items)) {
      return;
    }
    let dropped = 0;
    for (const item of m.items) {
      const parsed = attachmentSchema.safeParse(item);
      if (parsed.success && parsed.data.type === "element") {
        this.composer.attach(parsed.data);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      this.log.warn({ event: "sidebar_picked_dropped", count: dropped });
    }
    // Elements the picker left out because no selector matches only them (R9.6).
    if (typeof m.skipped === "number" && Number.isInteger(m.skipped) && m.skipped > 0) {
      this.log.info({ event: "sidebar_picked_skipped", count: m.skipped });
      this.composer.notify(TEXT.noSelector, "error");
    }
    const geometry = pickGeometry.safeParse({ rects: m.rects, viewport: m.viewport });
    if (!geometry.success) {
      this.log.warn({ event: "sidebar_pick_geometry_dropped" });
    }
    this.pick = geometry.success ? geometry.data : null;
    // "Include screenshot": the tab the elements were picked in, as the browser names the sender.
    const tab = from.tab as { id?: unknown; windowId?: unknown };
    if (
      geometry.success &&
      this.shotTool !== null &&
      typeof tab.id === "number" &&
      typeof tab.windowId === "number"
    ) {
      void this.shotTool.includeFor(geometry.data, { id: tab.id, windowId: tab.windowId });
    }
  }

  lastPick(): PickGeometry | null {
    return this.pick;
  }

  /**
   * The background's notices after the `start-picker` shortcut, from the `sidebar` port (or, from
   * this extension only, as a runtime message). The background injected picker.js under the
   * shortcut's activeTab grant; the chip receiver is always armed. `start-picker` re-reads the
   * tab, picking up the URL that grant made readable; `picker-status` shows why the picker is not
   * running in that tab. Nothing here may call permissions.request: there is no gesture.
   */
  onBackgroundMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const m = message as { type?: unknown; tabId?: unknown; status?: unknown };
    if (m.type === "start-picker") {
      this.pickTool?.refresh();
      return;
    }
    if (
      m.type === "picker-status" &&
      Number.isSafeInteger(m.tabId) &&
      (m.status === "protected" || m.status === "failed")
    ) {
      this.log.info({ event: "sidebar_shortcut_picker_not_started", reason: m.status });
      this.pickTool?.showBoot(m.tabId as number, m.status);
    }
  }
}

/**
 * Builds the sidebar inside `root`, restores the stored thread choice, wires the channel, the
 * picker messages and `pagehide`, then connects. Resolves once the channel has been asked to
 * connect.
 */
export async function mountSidebar(root: HTMLElement, deps: SidebarDeps): Promise<SidebarHandle> {
  const view = new SidebarView(root, deps);
  const { channel, runtime } = deps;
  channel.on("state", (state, detail) => view.onState(state, detail));
  channel.on("event", (event) => view.onEvent(event));
  await view.restoreTarget();

  const onMessage: RuntimeListener = (message, sender) => view.onRuntimeMessage(message, sender);
  runtime.onMessage.addListener(onMessage);
  const win = root.ownerDocument.defaultView;
  // R8.9: the port must not outlive the page.
  const onPageHide = () => channel.close();
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) {
      channel.connect();
    }
  };
  win?.addEventListener("pagehide", onPageHide);
  win?.addEventListener("pageshow", onPageShow);
  channel.connect();

  return {
    composer: view.composer,
    showNotice: (key) => view.composer.notify(NOTICES[key], NOTICE_TONE[key]),
    lastPick: () => view.lastPick(),
    close: () => {
      runtime.onMessage.removeListener(onMessage);
      view.closeTools();
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("pageshow", onPageShow);
      channel.close();
    },
  };
}
