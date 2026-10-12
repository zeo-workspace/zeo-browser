// The sidebar composer (story 045, design.md §A4): textarea, attachment chips, Send, Stop, the
// page-tool buttons and a notice line.
//
// - Send is disabled while the text and the attachments are both empty (R7.8), and `checkSend`
//   runs before anything goes out, naming the limit a message breaks (R7.11).
// - The composer is cleared only on `sent`; on an `error` the text, the chips and the reason stay
//   (R7.9). Removing a chip drops its attachment (R9.12).
// - Stop sends `cancel` (R7.4).
//
// The page tools (picker, screenshot, recorder) are Task 4's. They reach the composer through
// `attach` / `remove` / `notify` / `setTool`; a tool button stays disabled until its handler is
// installed, and the handler runs synchronously inside the click so it can call
// `permissions.request` as its first statement (the Firefox user-input rule).
import { type Attachment, type Status, checkSend } from "../contract.js";
import { LIMIT_TEXT, TEXT } from "./text.js";
import type { SidebarChannel } from "./view.js";

export type ToolName = "pick" | "screenshot" | "record";
export type Tone = "info" | "error";

export interface ComposerDeps {
  channel: Pick<SidebarChannel, "request">;
  /** Whether a Record button exists at all (Chrome's `debugger`, R11.9). */
  hasDebugger: boolean;
  log: Pick<Console, "info" | "warn">;
}

interface Chip {
  id: number;
  attachment: Attachment;
  node: HTMLLIElement;
  remove: HTMLButtonElement;
}

/** The host a chip names, without the scheme or the path ("file" for a local page). */
function hostOf(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return url.hostname || url.protocol.replace(/:$/, "");
  } catch {
    return "page";
  }
}

/** A chip's words: `<tag> · <host>`, `Console · <host> (<n>)`, … */
export function chipLabel(att: Attachment): string {
  switch (att.type) {
    case "element":
      return `${att.dom.tag} · ${hostOf(att.page_url)}`;
    case "image":
      return `Screenshot ${att.w}×${att.h}`;
    case "console":
      return `Console · ${hostOf(att.page_url)} (${att.entries.length})`;
    case "network":
      return `Network · ${hostOf(att.page_url)} (${att.entries.length})`;
  }
}

/** The words an `error` reply shows: Zeo's message, or the fixed text where one exists. */
export function errorText(reply: { error: string; message: string }): string {
  if (reply.error === "ai_disabled") {
    return TEXT.aiDisabled;
  }
  return reply.message || `Zeo answered ${reply.error}`;
}

/** A rejected request's words ("Zeo is not connected", "Zeo did not answer"). */
export function failureText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : TEXT.noAnswer;
}

/** A `type="button"` button with its visible label. */
export function button(doc: Document, label: string, className: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  return b;
}

export class Composer {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly deps: ComposerDeps;
  private readonly textarea: HTMLTextAreaElement;
  private readonly chipList: HTMLUListElement;
  private readonly noticeEl: HTMLElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly includeShot: HTMLInputElement;
  private readonly tools = new Map<
    ToolName,
    { button: HTMLButtonElement; handler: (() => void) | null }
  >();
  private chips: Chip[] = [];
  private nextChipId = 1;
  private sending = false;
  private stopping = false;
  private turnRunning = false;

  constructor(doc: Document, deps: ComposerDeps) {
    this.doc = doc;
    this.deps = deps;

    this.element = doc.createElement("section");
    this.element.className = "composer";
    this.element.setAttribute("aria-label", "Message composer");

    this.chipList = doc.createElement("ul");
    this.chipList.className = "chips";
    this.chipList.setAttribute("aria-label", "Attachments");

    const label = doc.createElement("label");
    label.htmlFor = "zeo-message";
    label.className = "visually-hidden";
    label.textContent = "Message to the agent";
    this.textarea = doc.createElement("textarea");
    this.textarea.id = "zeo-message";
    this.textarea.rows = 3;
    this.textarea.placeholder = "Message the agent — Enter sends, Shift+Enter adds a line";
    this.textarea.addEventListener("input", () => this.refresh());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });

    this.noticeEl = doc.createElement("div");
    this.noticeEl.className = "notice";
    this.noticeEl.setAttribute("role", "status");
    this.noticeEl.setAttribute("aria-live", "polite");

    const bar = doc.createElement("div");
    bar.className = "composer-bar";
    const tools = doc.createElement("div");
    tools.className = "tools";
    this.addTool(tools, "pick", "Pick element");
    this.addTool(tools, "screenshot", "Screenshot");
    const shotLabel = doc.createElement("label");
    shotLabel.className = "toggle";
    this.includeShot = doc.createElement("input");
    this.includeShot.type = "checkbox";
    shotLabel.append(this.includeShot, doc.createTextNode(" Include screenshot"));
    tools.append(shotLabel);
    if (deps.hasDebugger) {
      this.addTool(tools, "record", "Record");
    }

    const actions = doc.createElement("div");
    actions.className = "actions";
    this.stopButton = button(doc, "Stop", "btn btn-quiet");
    this.stopButton.addEventListener("click", () => void this.stop());
    this.sendButton = button(doc, "Send", "btn btn-primary");
    this.sendButton.addEventListener("click", () => void this.send());
    actions.append(this.stopButton, this.sendButton);
    bar.append(tools, actions);

    this.element.append(this.chipList, label, this.textarea, this.noticeEl, bar);
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // Hooks for the page tools (Task 4)

  /** Adds a chip for `attachment` and returns its id, for `remove`. */
  attach(attachment: Attachment, label: string = chipLabel(attachment)): number {
    const id = this.nextChipId++;
    const node = this.doc.createElement("li");
    node.className = `chip chip-${attachment.type}`;
    const name = this.doc.createElement("span");
    name.className = "chip-label";
    name.textContent = label;
    const remove = button(this.doc, "×", "chip-remove");
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.addEventListener("click", () => this.remove(id));
    node.append(name, remove);
    this.chipList.append(node);
    this.chips.push({ id, attachment, node, remove });
    this.refresh();
    return id;
  }

  /** Drops the chip `id` and its attachment (R9.12); an unknown id does nothing. */
  remove(id: number): void {
    const chip = this.chips.find((c) => c.id === id);
    if (!chip) {
      return;
    }
    chip.node.remove();
    this.chips = this.chips.filter((c) => c !== chip);
    this.refresh();
  }

  /** The attachments the next send carries, in chip order. */
  attachments(): Attachment[] {
    return this.chips.map((c) => c.attachment);
  }

  /** Shows `lines` in the notice line, or clears it with `null`. */
  notify(lines: string | readonly string[] | null, tone: Tone = "info"): void {
    const list = lines === null ? [] : typeof lines === "string" ? [lines] : lines;
    this.noticeEl.replaceChildren(
      ...list.map((line) => {
        const p = this.doc.createElement("p");
        p.textContent = line;
        return p;
      }),
    );
    this.noticeEl.dataset.tone = tone;
  }

  /** Installs (or, with `null`, removes) the click handler of a page-tool button. */
  setTool(name: ToolName, handler: (() => void) | null): void {
    const tool = this.tools.get(name);
    if (tool) {
      tool.handler = handler;
      tool.button.disabled = handler === null;
    }
  }

  /** Whether "Include screenshot" is on. */
  includeScreenshot(): boolean {
    return this.includeShot.checked;
  }

  /** The thread's status, which decides whether Stop has a turn to stop. */
  setStatus(state: Status["state"]): void {
    this.turnRunning = state === "working" || state === "awaiting_permission";
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------

  private addTool(parent: HTMLElement, name: ToolName, label: string): void {
    const b = button(this.doc, label, "btn btn-tool");
    b.disabled = true;
    const tool = { button: b, handler: null as (() => void) | null };
    // Synchronous on purpose: the handler's permissions.request must run inside the gesture.
    b.addEventListener("click", () => tool.handler?.());
    this.tools.set(name, tool);
    parent.append(b);
  }

  private isEmpty(): boolean {
    return this.textarea.value.length === 0 && this.chips.length === 0;
  }

  private refresh(): void {
    this.sendButton.disabled = this.sending || this.isEmpty();
    this.stopButton.disabled = this.stopping || !this.turnRunning;
    this.textarea.readOnly = this.sending;
    for (const chip of this.chips) {
      chip.remove.disabled = this.sending;
    }
  }

  /** Clears the text and the chips that went out in a message; chips added since stay. */
  private clearSent(sentIds: ReadonlySet<number>): void {
    this.textarea.value = "";
    for (const chip of this.chips) {
      if (sentIds.has(chip.id)) {
        chip.node.remove();
      }
    }
    this.chips = this.chips.filter((c) => !sentIds.has(c.id));
  }

  private async send(): Promise<void> {
    if (this.sending || this.isEmpty()) {
      return;
    }
    const text = this.textarea.value;
    // Captured now: a chip the page tools attach while this send is in flight is not in it.
    const sentIds = new Set(this.chips.map((c) => c.id));
    const attachments = this.attachments();
    const verdict = checkSend(text, attachments);
    if (!verdict.ok) {
      this.notify(LIMIT_TEXT[verdict.limit], "error");
      return;
    }
    this.sending = true;
    this.notify(null);
    this.refresh();
    try {
      const reply = await this.deps.channel.request({ v: 2, kind: "send", text, attachments });
      if (reply.kind === "sent") {
        this.clearSent(sentIds);
        const lines: string[] = [];
        if (reply.queued) {
          lines.push(TEXT.queued);
        }
        if (reply.images === "skipped_unsupported") {
          lines.push(TEXT.imagesSkipped);
        }
        this.notify(lines.length > 0 ? lines : null);
      } else {
        this.notify(errorText(reply), "error");
      }
    } catch (err) {
      this.deps.log.warn({ event: "sidebar_send_failed", error: failureText(err) });
      this.notify(failureText(err), "error");
    } finally {
      this.sending = false;
      this.refresh();
    }
  }

  private async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.refresh();
    try {
      const reply = await this.deps.channel.request({ v: 2, kind: "cancel" });
      if (reply.kind === "error") {
        this.notify(errorText(reply), "error");
      }
    } catch (err) {
      this.deps.log.warn({ event: "sidebar_cancel_failed", error: failureText(err) });
      this.notify(failureText(err), "error");
    } finally {
      this.stopping = false;
      this.refresh();
    }
  }
}
