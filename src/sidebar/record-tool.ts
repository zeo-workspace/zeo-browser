// The sidebar's Record button, Chrome only (story 045, design.md §A7, §A2; R11.1, R11.4–R11.6).
//
// - Page tab: the Pick tool's (`PickTool.current` / `onChange`); this module never reads tabs. A
//   protected page disables Record through `Composer.setPageProtected`.
// - Record tells the background which tab it is about to record (`recording`) BEFORE attaching,
//   so a sidebar that dies mid-attach still leaves the janitor a tab to detach; then it calls the
//   recorder's `start` and shows "Recording console & network — Stop" with the elapsed time. While
//   recording it pings the background every 20 s, which keeps a Chrome service worker alive.
// - Stop, the recorder's 120 s cap or a browser detach end it: the two captures are validated
//   against the contract and become two chips (`Console · <host> (<n>)`, `Network · <host> (<n>)`).
//   A new recording replaces the chips of the previous one still in the composer (a send carries
//   at most one capture of each kind). A cut-short recording also shows the cut-short notice.
//   Then the background hears `recording_stopped`.
// - The Firefox build never mounts this tool (no recorder is handed to the view, R11.9).
//
// Logs carry event names, counts and error names only (R13.4).
import { attachment as attachmentSchema } from "../contract.js";
import type { Captures } from "../recorder.js";
import { RECORDING_HEARTBEAT_MS, type SidebarPortMessage } from "../sidebar-port.js";
import { type Composer, button } from "./composer.js";
import type { PickTool } from "./pick-tool.js";
import { type NoticeKey, TEXT } from "./text.js";

/** The recorder as the sidebar uses it (`src/recorder.ts`). */
export interface RecorderApi {
  start(tabId: number, onEnd: (captures: Captures) => void): Promise<void>;
  stop(): Promise<Captures>;
}

/** The composer hooks this tool reaches. */
export type RecordComposer = Pick<
  Composer,
  "setTool" | "notify" | "attach" | "remove" | "addStatusRow"
>;

export interface RecordToolDeps {
  composer: RecordComposer;
  pageTab: Pick<PickTool, "current" | "onChange">;
  recorder: RecorderApi;
  /** The `sidebar` port to the background; null when there is none (no janitor then). */
  port: { post(message: SidebarPortMessage): void } | null;
  /** Shows one of the view's fixed notices (`recording_cut_short`). */
  notice: (key: NoticeKey) => void;
  log: Pick<Console, "info" | "warn">;
  doc: Document;
}

export interface RecordTool {
  /** Whether a recording is starting, running or stopping. */
  active(): boolean;
  /** Stops the timers (the page is going away; the janitor detaches the debugger). */
  close(): void;
}

type State = "idle" | "starting" | "recording" | "stopping";

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** `m:ss`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Why a recording failed, in words: the fixed sentence and the cause's message, if any. */
function failureText(err: unknown): string {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  const message = cause instanceof Error ? cause.message : "";
  return message ? `${TEXT.recordingFailed}: ${message}` : TEXT.recordingFailed;
}

/** Installs the Record handler on the composer, following the Pick tool's page tab. */
export function mountRecordTool(deps: RecordToolDeps): RecordTool {
  const { composer, pageTab, recorder, port, log, doc } = deps;
  let state: State = "idle";
  let startedAt = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let chipIds: number[] = [];

  // The indicator: "Recording console & network — Stop 0:12".
  const row = doc.createElement("div");
  row.className = "recording";
  row.hidden = true;
  const label = doc.createElement("span");
  label.className = "recording-label";
  label.id = "zeo-recording-label";
  label.textContent = TEXT.recording;
  const dash = doc.createElement("span");
  dash.setAttribute("aria-hidden", "true");
  dash.textContent = " — ";
  const stopButton = button(doc, TEXT.recordingStop, "btn btn-quiet recording-stop");
  stopButton.setAttribute("aria-describedby", label.id);
  const clock = doc.createElement("span");
  clock.className = "recording-elapsed";
  row.append(label, dash, stopButton, doc.createTextNode(" "), clock);
  composer.addStatusRow(row);

  const post = (message: SidebarPortMessage): void => port?.post(message);

  const stopTimers = (): void => {
    clearInterval(elapsedTimer);
    clearInterval(heartbeat);
    elapsedTimer = undefined;
    heartbeat = undefined;
  };

  const tick = (): void => {
    clock.textContent = formatElapsed(Date.now() - startedAt);
  };

  const enableRecord = (): void => {
    composer.setTool("record", pageTab.current() === null ? null : onRecord);
  };

  /** Back to idle: no indicator, no timers, the background told, Record usable again. */
  const reset = (): void => {
    state = "idle";
    stopTimers();
    row.hidden = true;
    stopButton.disabled = false;
    post({ type: "recording_stopped" });
    enableRecord();
  };

  const finish = (captures: Captures): void => {
    if (state === "idle") {
      return;
    }
    reset();
    for (const id of chipIds) {
      composer.remove(id);
    }
    chipIds = [];
    let problem: string | null = null;
    for (const capture of [captures.console, captures.network]) {
      const parsed = attachmentSchema.safeParse(capture);
      if (parsed.success) {
        chipIds.push(composer.attach(parsed.data));
      } else {
        problem ??= parsed.error.issues[0]?.message ?? "the capture breaks the contract";
      }
    }
    const cutShort = captures.console.cut_short;
    log.info({
      event: "sidebar_recording_ended",
      cut_short: cutShort,
      console: captures.console.entries.length,
      network: captures.network.entries.length,
      attached: chipIds.length,
    });
    if (problem !== null) {
      composer.notify(`${TEXT.recordingFailed}: ${problem}`, "error");
    } else if (cutShort) {
      deps.notice("recording_cut_short");
    }
  };

  function onRecord(): void {
    const target = pageTab.current();
    if (target === null || state !== "idle") {
      return;
    }
    state = "starting";
    composer.setTool("record", null);
    composer.notify(null);
    // Announced before attaching: the janitor must know the tab even if the attach outlives us.
    post({ type: "recording", tabId: target.id });
    recorder.start(target.id, finish).then(
      () => {
        if (state !== "starting") {
          return;
        }
        state = "recording";
        startedAt = Date.now();
        tick();
        row.hidden = false;
        elapsedTimer = setInterval(tick, 1000);
        heartbeat = setInterval(
          () => post({ type: "recording_heartbeat" }),
          RECORDING_HEARTBEAT_MS,
        );
        log.info({ event: "sidebar_recording_started" });
      },
      (err: unknown) => {
        if (state !== "starting") {
          return;
        }
        log.warn({
          event: "sidebar_recording_failed",
          error: errorName(err instanceof Error ? (err.cause ?? err) : err),
        });
        reset();
        composer.notify(failureText(err), "error");
      },
    );
  }

  stopButton.addEventListener("click", () => {
    if (state !== "recording") {
      return;
    }
    state = "stopping";
    stopButton.disabled = true;
    recorder.stop().then(finish, (err: unknown) => {
      log.warn({ event: "sidebar_recording_stop_failed", error: errorName(err) });
      if (state !== "idle") {
        reset();
        composer.notify(failureText(err), "error");
      }
    });
  });

  pageTab.onChange(() => {
    if (state === "idle") {
      enableRecord();
    }
  });
  enableRecord();

  return {
    active: () => state !== "idle",
    close: stopTimers,
  };
}
