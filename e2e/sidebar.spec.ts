// Story 045, task 8.3 — E2E: Chromium with the unpacked extension, the real host binary and a
// fake Zeo socket (design.md §Testing Strategy). Tool: playwright (@playwright/test).
// Requirements: R1.1, R1.2, R5.3, R5.5, R5.6, R6.2, R6.3, R6.8, R7.1, R7.2, R7.4, R7.6, R7.8,
// R8.4, R8.5, R8.6, R8.7, R8.8, R9.1–R9.5, R9.8, R9.9, R9.11, R10.1, R10.2, R10.4, R11.1, R11.2,
// R11.4, R11.6; success metrics (send under 1 s, debugger attached zero seconds); Q13, Q17.
//
// Setup, none of which touches the extension's code:
//   - `dist/chrome` (from `npm run build`) is loaded with --load-extension into a persistent
//     Chromium profile (branded Chrome ignores the flag since 137);
//   - a test native-messaging manifest in `<user-data-dir>/NativeMessagingHosts/` points at a
//     wrapper that execs ZEO_BROWSER_HOST_BIN with ZEO_DEVTOOLS_SOCKET set to the fake Zeo, so the
//     system manifest paths are never touched; unset, the suite is reported SKIPPED;
//   - the sidebar page is opened in a POPUP window by the service worker, so the fixture tab stays
//     the active tab of the last-focused normal window — the tab a real side panel targets. The
//     sidebar must resolve its page tab that way (a side panel's own window is normal).
//   - whether the extension holds the debugger is probed by attaching from the service worker:
//     `debugger.getTargets().attached` is useless under Playwright, which is itself attached to
//     every page.
//   - site access follows Decision A8 (no `tabs`, no `<all_urls>`): the fixture tab's URL is
//     hidden from the sidebar until an `activeTab` grant exists. `pressPickShortcut` sends a real
//     Alt+Shift+E with `xdotool` to the page's X window — Playwright's keyboard goes through CDP
//     and never reaches browser commands — which grants `activeTab`, starts the picker and makes
//     the URL readable. So the browser runs headed, under `xvfb-run`. Chromium's per-site prompt
//     (R9.13) cannot be accepted from here; it is proved in the live proof (task 9.4).
//
// Hostile halves:
//   - a Markdown image in model output must NOT be fetched (the fixture server records requests);
//   - the page's own click handler must not fire while picking, and must fire with the picker off;
//   - no form value, editor text or URL query value leaves in a picked element;
//   - Pick on a hidden URL and a screenshot with no `activeTab` call no `permissions.request`;
//   - the debugger is attached only between Record and Stop, and closing the sidebar detaches it.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// Named import: the package's top-level "types" points at its CJS typings, where the default
// export is the module object, not the class.
import { AxeBuilder } from "@axe-core/playwright";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { buildManifest } from "../scripts/manifest.mjs";
import { extensionIdFromKey } from "../scripts/extension-id.mjs";
import { entry, idle, startFakeZeoV2, thread, type FakeZeoV2 } from "./fake-zeo.js";

const DIST = fileURLToPath(new URL("../dist/chrome", import.meta.url));
const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/page.html", import.meta.url)),
  "utf8",
);
const BIN = process.env.ZEO_BROWSER_HOST_BIN;
const ID = extensionIdFromKey((buildManifest("chrome") as { key: string }).key);

const T = {
  unreachable: "Zeo is not running, or its devtools bridge is off",
  noHost: "The Zeo browser host is not installed (USE=browser-extension)",
  approve: "Approve this browser in Zeo",
  noThread: "No active agent thread in Zeo",
  closed: "This thread was closed in Zeo",
  queued: "Queued in Zeo",
  protectedPage: "Zeo cannot read this page: the browser protects it",
  pageUnknown:
    "Zeo cannot see this page's address yet: on that page, press Alt+Shift+E (Pick element) or click the Zeo toolbar icon",
  screenshotPermission:
    "Zeo needs this page's permission for screenshots: press Alt+Shift+E on the page or click the Zeo toolbar icon, then try again",
};

const run = promisify(execFile);

// Refuse before anything launches unless this runs inside `xvfb-run` (`npm run e2e`): the spec
// runs Chromium headed and types real key chords with xdotool, which on the desktop session would
// open windows there and send Alt+Shift+E into the user's own apps. xvfb-run is recognised by the
// Xauthority file it creates (`/tmp/xvfb-run.XXXXXX/Xauthority`), which an exported variable in a
// shell profile cannot fake by accident.
const UNDER_XVFB =
  process.env.DISPLAY !== undefined &&
  /\/xvfb-run\.[^/]+\/Xauthority$/.test(process.env.XAUTHORITY ?? "");
if (!UNDER_XVFB) {
  throw new Error(
    "e2e/sidebar.spec.ts refuses to run outside xvfb-run (it drives a headed browser and types " +
      "real key chords): use `npm run e2e`",
  );
}

/** The environment Chromium gets: no WAYLAND_DISPLAY, so it can only reach Xvfb's X display. */
const BROWSER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => e[0] !== "WAYLAND_DISPLAY" && e[1] !== undefined,
  ),
);

test.skip(
  !BIN || !existsSync(join(DIST, "manifest.json")),
  "SKIPPED: set ZEO_BROWSER_HOST_BIN and run `npm run build` first",
);

let fake: FakeZeoV2;
let site: { server: Server; url: string; hits: string[] };
let profile: string;
let context: BrowserContext;
let sw: Worker;
let page: Page;

async function serveFixture() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/" || path.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE);
    } else if (req.url?.startsWith("/data.json")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits };
}

async function launch(withHost = true, path = "") {
  profile = await mkdtemp(join(tmpdir(), "zeo-e2e-profile-"));
  if (withHost) {
    const wrapper = join(profile, "host.sh");
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport ZEO_DEVTOOLS_SOCKET='${fake.path}'\nexec '${BIN}' "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
    await writeFile(
      join(profile, "NativeMessagingHosts", "dev.zeo.browser_host.json"),
      JSON.stringify({
        name: "dev.zeo.browser_host",
        description: "test",
        path: wrapper,
        type: "stdio",
        allowed_origins: [`chrome-extension://${ID}/`],
      }),
    );
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    // Headed: browser commands (Alt+Shift+E) need a real X window, which Xvfb provides. X11 is
    // forced twice (no WAYLAND_DISPLAY, ozone x11) so the window cannot land on the desktop.
    headless: false,
    env: BROWSER_ENV,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--ozone-platform=x11",
    ],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(site.url + path);
}

async function openSidebar(): Promise<Page> {
  const opened = context.waitForEvent("page", (p) => p.url().includes("/sidebar/index.html"));
  await sw.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 420, height: 800, focused: false }),
    `chrome-extension://${ID}/sidebar/index.html`,
  );
  const sidebar = await opened;
  await sidebar.waitForLoadState();
  await page.bringToFront();
  return sidebar;
}

/** Opens the sidebar and waits for Zeo's snapshot, so pushed events land on a bound thread. */
async function openReadySidebar(): Promise<Page> {
  const sidebar = await openSidebar();
  await expect(sidebar.getByText("hello from zeo")).toBeVisible();
  return sidebar;
}

/**
 * The fixture tab's id. Without `tabs` a URL filter matches nothing (the URL is hidden), so the
 * tab is found as the active tab of the only normal window.
 */
async function fixtureTabId(): Promise<number> {
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowType: "normal" });
    return tab!.id!;
  });
}

/** Whether THIS extension holds the debugger on the tab: a second attach from it is refused. */
async function extensionAttached(tabId: number): Promise<boolean> {
  return sw.evaluate(async (id) => {
    try {
      await chrome.debugger.attach({ tabId: id }, "1.3");
      await chrome.debugger.detach({ tabId: id });
      return false;
    } catch (e) {
      return /already attached/i.test(String((e as Error).message));
    }
  }, tabId);
}

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await run("xdotool", args, { timeout: 10_000 });
  return stdout.trim();
}

/**
 * Presses a real key chord on the fixture page's window: browser commands (Alt+Shift+E,
 * Alt+Shift+Y) only come from the keyboard, never from Playwright's CDP input. The window is
 * found by a unique title set for the search and restored right after; X input focus goes to it
 * before the chord is typed.
 */
async function pressShortcut(keys: string): Promise<void> {
  const marker = `zeo-e2e-target-${Date.now()}`;
  const original = await page.evaluate((m) => {
    const t = document.title;
    document.title = m;
    return t;
  }, marker);
  await page.bringToFront();
  const [wid] = (await xdotool("search", "--sync", "--onlyvisible", "--name", marker)).split("\n");
  await page.evaluate((t) => {
    document.title = t;
  }, original);
  await xdotool("windowfocus", wid!);
  await xdotool("key", "--clearmodifiers", keys);
}

/**
 * Alt+Shift+E: grants `activeTab`, opens the real side panel and starts the picker (Decision A8).
 */
const pressPickShortcut = () => pressShortcut("alt+shift+e");

/** The real side panel, which Playwright does not attach to, driven over raw CDP. */
interface SidePanel {
  evaluate<R>(expression: string): Promise<R>;
  close(): Promise<void>;
}

/**
 * Presses `keys` (a shortcut that opens the side panel) and attaches to the real side panel it
 * opens. Only a sidebar target that did not exist before the chord counts: a popup stand-in that
 * is closing can still be listed. The panel's `sidebar` port carries no `sender.tab`, unlike the
 * popup's, so the background knows it: the shortcut's `picker-status` and the debugger janitor
 * reach this page, not the popup.
 */
async function openSidePanel(keys: string): Promise<SidePanel> {
  const cdp = await context.newCDPSession(page);
  const sidebars = async () =>
    (await cdp.send("Target.getTargets")).targetInfos.filter(
      (t) => t.type === "page" && t.url.endsWith("/sidebar/index.html"),
    );
  const before = new Set((await sidebars()).map((t) => t.targetId));
  await pressShortcut(keys);
  const find = async () => (await sidebars()).find((t) => !before.has(t.targetId));
  await expect.poll(async () => (await find()) !== undefined).toBe(true);
  const { targetId } = (await find())!;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
  let next = 0;
  const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>();
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    const m = JSON.parse(e.message) as {
      id?: number;
      result?: { result?: { value?: unknown } };
    };
    if (m.id !== undefined) {
      waiting.get(m.id)?.(m);
    }
  });
  return {
    evaluate: <R>(expression: string) =>
      new Promise<R>((resolve) => {
        const id = ++next;
        waiting.set(id, (m) => resolve(m.result?.result?.value as R));
        void cdp.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        });
      }),
    close: async () => {
      await cdp.send("Target.closeTarget", { targetId });
    },
  };
}

/** The side panel's button named `name`: its state, or "missing". */
const panelButton = (panel: SidePanel, name: string) =>
  panel.evaluate<string>(
    `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(name)}); return b ? (b.disabled ? "disabled" : "enabled") : "missing"; })()`,
  );

const panelText = (panel: SidePanel) => panel.evaluate<string>("document.body.innerText");

/** Whether the picker's overlay host (a manual popover on the root element) is in the page. */
async function waitForPicker(on: boolean): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.querySelector("[popover]") !== null))
    .toBe(on);
}

/** Counts the sidebar's `permissions.request` calls from now on (`permissionRequests`). */
async function countPermissionRequests(sidebar: Page): Promise<void> {
  await sidebar.evaluate(() => {
    const w = window as unknown as { __requests: number; browser?: typeof chrome };
    w.__requests = 0;
    for (const ns of new Set([globalThis.chrome, w.browser])) {
      const perms = ns?.permissions as { request: (...a: unknown[]) => unknown } | undefined;
      if (perms && !(perms.request as { counted?: boolean }).counted) {
        const original = perms.request.bind(perms);
        const counted = (...a: unknown[]) => {
          w.__requests++;
          return original(...a);
        };
        (counted as { counted?: boolean }).counted = true;
        perms.request = counted;
      }
    }
  });
}

async function permissionRequests(sidebar: Page): Promise<number> {
  return sidebar.evaluate(() => (window as unknown as { __requests: number }).__requests);
}

test.beforeEach(async () => {
  fake = await startFakeZeoV2();
  site = await serveFixture();
});
test.afterEach(async () => {
  await context?.close().catch(() => {});
  await fake.dispose();
  await new Promise<void>((r) => site.server.close(() => r()));
  await rm(profile, { recursive: true, force: true });
});

test("the unpacked build loads with its fixed ID (R1.1, R1.2)", async () => {
  await launch();
  expect(new URL(sw.url()).host).toBe(ID);
});

test.describe("connection states", () => {
  test("approval pending, then welcome: the transcript arrives (R8.8)", async () => {
    let welcomeLater: (() => void) | undefined;
    const base = fake.handler;
    fake.handler = (msg, reply, socket) => {
      if (msg.kind === "hello") {
        reply({ v: 2, kind: "approval_pending" });
        welcomeLater = () => reply({ v: 2, kind: "welcome", protocol: 2, zeo_version: "0.5.0" });
        return;
      }
      base(msg, reply, socket);
    };
    await launch();
    const sidebar = await openSidebar();
    await expect(sidebar.getByText(T.approve)).toBeVisible();
    welcomeLater!();
    await expect(sidebar.getByText("hello from zeo")).toBeVisible();
    await expect(sidebar.getByText(T.approve)).toBeHidden();
  });

  test("a protocol mismatch names both versions (R8.7)", async () => {
    fake.handler = (msg, reply) =>
      msg.kind === "hello" && reply({ v: 2, kind: "welcome", protocol: 3, zeo_version: "9.0.0" });
    await launch();
    const sidebar = await openSidebar();
    const body = sidebar.locator("body");
    await expect(body).toContainText(/version/i);
    await expect(body).toContainText("3");
    await expect(body).toContainText("2");
  });

  test("Zeo going away shows the banner; coming back reattaches without a click (R8.4, R8.5)", async () => {
    await launch();
    const sidebar = await openSidebar();
    await expect(sidebar.getByText("hello from zeo")).toBeVisible();
    const subscribes = () => fake.received.filter((m) => m.kind === "subscribe").length;
    const before = subscribes();
    await fake.stop();
    await expect(sidebar.getByText(T.unreachable)).toBeVisible({ timeout: 5000 });
    await fake.start();
    await expect(sidebar.getByText(T.unreachable)).toBeHidden({ timeout: 10_000 });
    expect(subscribes()).toBeGreaterThan(before);
    await expect(sidebar.getByText("hello from zeo")).toBeVisible();
  });

  test("no host installed: the install hint, and no retry (R8.6)", async () => {
    await launch(false);
    const sidebar = await openSidebar();
    await expect(sidebar.getByText(T.noHost)).toBeVisible();
  });
});

test.describe("reading the thread", () => {
  test("no thread, a retarget, and a closed thread are all said (R5.3, R5.5, R5.6)", async () => {
    const base = fake.handler;
    fake.handler = (msg, reply, s) =>
      msg.kind === "subscribe"
        ? reply({
            v: 2,
            kind: "snapshot",
            id: msg.id,
            thread: null,
            earlier: 0,
            entries: [],
            status: idle,
            permissions: [],
          })
        : base(msg, reply, s);
    await launch();
    const sidebar = await openSidebar();
    await expect(sidebar.getByText(T.noThread)).toBeVisible();
    fake.push({ v: 2, kind: "target_changed", thread: thread("t2", "Write the docs") });
    fake.push({
      v: 2,
      kind: "snapshot",
      thread: thread("t2", "Write the docs"),
      earlier: 0,
      entries: [entry("docs entry")],
      status: idle,
      permissions: [],
    });
    await expect(sidebar.getByText("Write the docs").first()).toBeVisible();
    fake.push({ v: 2, kind: "thread_closed" });
    await expect(sidebar.getByText(T.closed)).toBeVisible();
  });

  test("streaming shows the new entry within 1 s and ends on its final text (R6.2, R6.3)", async () => {
    await launch();
    const sidebar = await openSidebar();
    await expect(sidebar.getByText("hello from zeo")).toBeVisible();
    fake.push({ v: 2, kind: "entry_added", index: 1, entry: entry("first token") });
    await expect(sidebar.getByText("first token")).toBeVisible({ timeout: 1000 });
    for (let i = 0; i < 30; i++) {
      fake.push({ v: 2, kind: "entry_updated", index: 1, entry: entry(`partial ${i}`) });
      await page.waitForTimeout(20);
    }
    fake.push({ v: 2, kind: "entry_updated", index: 1, entry: entry("FINAL-TEXT") });
    await expect(sidebar.getByText("FINAL-TEXT")).toBeVisible({ timeout: 1000 });
  });

  test("hostile: a Markdown image is never fetched; links open in a new tab (R6.8)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    fake.push({
      v: 2,
      kind: "entry_added",
      index: 1,
      entry: entry(`![beacon](${site.url}beacon.png) and [docs](${site.url}docs)`),
    });
    await expect(sidebar.getByText("beacon")).toBeVisible();
    await page.waitForTimeout(500);
    expect(site.hits.some((h) => h.includes("beacon.png"))).toBe(false);
    expect(await sidebar.locator("img").count()).toBe(0);
    await expect(sidebar.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
  });
});

test.describe("driving the thread", () => {
  test("Send is disabled when empty; a message reaches Zeo in under 1 s and clears the composer (R7.1, R7.8)", async () => {
    await launch();
    const sidebar = await openSidebar();
    const send = sidebar.getByRole("button", { name: /^send$/i });
    await expect(send).toBeDisabled();
    await sidebar.getByRole("textbox").fill("hello from the browser");
    const t0 = Date.now();
    await send.click();
    const msg = await fake.waitFor("send", 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(msg).toMatchObject({
      v: 2,
      kind: "send",
      text: "hello from the browser",
      attachments: [],
    });
    await expect(sidebar.getByRole("textbox")).toHaveValue("");
  });

  test("a send while working is queued in Zeo and says so (R7.2)", async () => {
    const base = fake.handler;
    fake.handler = (msg, reply, s) =>
      msg.kind === "send"
        ? reply({ v: 2, kind: "sent", id: msg.id, queued: true, images: "none" })
        : base(msg, reply, s);
    await launch();
    const sidebar = await openSidebar();
    await sidebar.getByRole("textbox").fill("next step");
    await sidebar.getByRole("button", { name: /^send$/i }).click();
    await expect(sidebar.getByText(T.queued)).toBeVisible();
  });

  test("Stop cancels the turn (R7.4)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    fake.push({ v: 2, kind: "status", status: { state: "working", message: null } });
    await sidebar.getByRole("button", { name: /stop/i }).click();
    await fake.waitFor("cancel");
  });

  test("a permission answered in the sidebar is sent, and its resolution removes the card (R7.6)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    fake.push({
      v: 2,
      kind: "permission_requested",
      permission: {
        request_id: "p1",
        entry_index: 0,
        title: "Run cargo test",
        options: [
          { option_id: "o1", label: "Allow once", kind: "allow_once" },
          { option_id: "o2", label: "Reject", kind: "reject_once" },
        ],
      },
    });
    await expect(sidebar.getByText("Run cargo test")).toBeVisible();
    await sidebar.getByRole("button", { name: "Allow once" }).click();
    expect(await fake.waitFor("authorize")).toMatchObject({ request_id: "p1", option_id: "o1" });
    fake.push({ v: 2, kind: "permission_resolved", request_id: "p1" });
    await expect(sidebar.getByText("Run cargo test")).toBeHidden();
  });
});

test.describe("page tools", () => {
  test("hostile: Pick on a page whose URL is hidden asks nothing and says how to proceed (R9.10)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    await countPermissionRequests(sidebar);
    await sidebar.getByRole("button", { name: /pick element/i }).click();
    await expect(sidebar.getByText(T.pageUnknown)).toBeVisible();
    expect(await permissionRequests(sidebar)).toBe(0);
    await waitForPicker(false);
  });

  test("a protected page disables picking, screenshots and recording (R9.9)", async () => {
    await launch();
    await page.goto("about:blank");
    const sidebar = await openReadySidebar();
    // Without activeTab the URL is hidden, so the protected state cannot be known yet: Pick says
    // how to proceed and asks for nothing.
    await countPermissionRequests(sidebar);
    await sidebar.getByRole("button", { name: /pick element/i }).click();
    await expect(sidebar.getByText(T.pageUnknown)).toBeVisible();
    expect(await permissionRequests(sidebar)).toBe(0);
    // The shortcut opens the real side panel, which hears `picker-status: protected` over its
    // port and turns the state on there (the popup stand-in's port is refused: it is a tab).
    const panel = await openSidePanel("alt+shift+e");
    await expect.poll(() => panelText(panel)).toContain(T.protectedPage);
    await expect.poll(() => panelButton(panel, "Pick element")).toBe("disabled");
    await expect.poll(() => panelButton(panel, "Screenshot")).toBe("disabled");
    await expect.poll(() => panelButton(panel, "Record")).toBe("disabled");
  });

  test("hostile: picking swallows the page's click, attaches a chip, Shift+click keeps going (R9.1–R9.5, R9.11)", async () => {
    await launch(true, "?session=URL-SECRET");
    const sidebar = await openReadySidebar();
    await pressPickShortcut();
    await waitForPicker(true);
    await page.locator("#clicker").hover();
    await page.locator("#clicker").click();
    expect(
      await page.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks),
    ).toBe(0);
    await expect(sidebar.getByText(/button · 127\.0\.0\.1/)).toBeVisible();
    await waitForPicker(false);

    // The Pick button would ask Chromium for the site here (R9.13), a prompt automation cannot
    // answer: the second pass starts from the shortcut too.
    await pressPickShortcut();
    await waitForPicker(true);
    await page
      .locator(".card")
      .nth(0)
      .click({ modifiers: ["Shift"] });
    await page
      .locator(".card")
      .nth(1)
      .click({ modifiers: ["Shift"] });
    await page.keyboard.press("Escape");
    await expect(sidebar.getByText(/div · 127\.0\.0\.1/)).toHaveCount(2);
    await waitForPicker(false);

    await page.locator("#clicker").click();
    expect(
      await page.evaluate(() => (window as unknown as { pageClicks: number }).pageClicks),
    ).toBe(1);

    await sidebar.getByRole("textbox").fill("these");
    await sidebar.getByRole("button", { name: /^send$/i }).click();
    const sent = await fake.waitFor("send");
    const elements = sent.attachments.filter((a: { type: string }) => a.type === "element");
    expect(elements).toHaveLength(3);
    expect(new Set(elements.map((e: { selector: string }) => e.selector)).size).toBe(3);
    expect(JSON.stringify(sent)).not.toContain("FORM-SECRET");
    // URL query values: neither the page's (page_url) nor a link's (outer HTML) leaves.
    expect(JSON.stringify(sent)).not.toContain("URL-SECRET");
    expect(JSON.stringify(sent)).not.toContain("QUERY-SECRET");
    // Editor text leaves neither in the outer HTML (R9.7) nor in the DOM summary (R9.17).
    expect(JSON.stringify(sent)).not.toContain("EDITOR-SECRET");
    expect(JSON.stringify(sent)).toContain("first card");
  });

  test("hostile: a screenshot with no activeTab says how to grant it and asks nothing (R10.6, R10.8)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    await countPermissionRequests(sidebar);
    await sidebar.getByRole("button", { name: /screenshot/i }).click();
    await expect(sidebar.getByText(T.screenshotPermission)).toBeVisible();
    expect(await permissionRequests(sidebar)).toBe(0);
    await sidebar.getByRole("textbox").fill("look");
    await sidebar.getByRole("button", { name: /^send$/i }).click();
    const sent = await fake.waitFor("send");
    expect(sent.attachments.filter((a: { type: string }) => a.type === "image")).toHaveLength(0);
  });

  test("screenshots: the overlay is excluded, rapid requests are spaced, not failed (R10.1, R10.2, R10.4, R10.7, R9.8)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    // The shortcut's activeTab is what a capture runs under (R10.7).
    await pressPickShortcut();
    await waitForPicker(true);
    await page.keyboard.press("Escape");
    await waitForPicker(false);
    const shot = sidebar.getByRole("button", { name: /screenshot/i });
    await shot.click();
    await shot.click();
    await shot.click();
    // Spaced 500 ms apart, the three captures take over a second: wait for their chips.
    await expect(sidebar.getByText(/^Screenshot \d+×\d+$/)).toHaveCount(3);
    await expect(sidebar.getByText(/failed/i)).toHaveCount(0);
    await sidebar.getByRole("textbox").fill("look");
    await sidebar.getByRole("button", { name: /^send$/i }).click();
    const sent = await fake.waitFor("send");
    const images = sent.attachments.filter((a: { type: string }) => a.type === "image");
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(Math.max(img.w, img.h)).toBeLessThanOrEqual(1568);
    }
  });

  test("hostile: the debugger is held only while recording, and closing the sidebar releases it (R11.1, R11.2, R11.4, R11.6)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    const tabId = await fixtureTabId();
    expect(await extensionAttached(tabId)).toBe(false);
    await sidebar.getByRole("button", { name: /record/i }).click();
    await expect.poll(() => extensionAttached(tabId)).toBe(true);
    await page.evaluate(() => (window as unknown as { makeNoise(): void }).makeNoise());
    await page.waitForTimeout(500);
    await sidebar.getByRole("button", { name: /stop/i }).first().click();
    await expect.poll(() => extensionAttached(tabId)).toBe(false);
    await expect(sidebar.getByText(/Console · 127\.0\.0\.1 \(\d+\)/)).toBeVisible();
    await expect(sidebar.getByText(/Network · 127\.0\.0\.1 \(\d+\)/)).toBeVisible();

    // Closing the sidebar mid-recording: the real side panel, whose port the janitor trusts.
    await sidebar.close();
    const panel = await openSidePanel("alt+shift+y");
    await expect.poll(() => panelButton(panel, "Record")).toBe("enabled");
    await panel.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Record").click()`,
    );
    await expect.poll(() => extensionAttached(tabId)).toBe(true);
    await panel.close();
    await expect.poll(() => extensionAttached(tabId), { timeout: 5000 }).toBe(false);
  });
});

test("the sidebar has no serious accessibility violation and every control is reachable by Tab (Q17)", async () => {
  await launch();
  const sidebar = await openSidebar();
  await expect(sidebar.getByText("hello from zeo")).toBeVisible();
  const results = await new AxeBuilder({ page: sidebar }).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => v.id)).toEqual([]);
  // Disabled controls (Stop and Send while idle and empty) are out of the Tab order by HTML's
  // rules; every enabled one must be reached. Each is tagged so the check names elements, not
  // labels that two controls could share.
  const enabled = sidebar.locator(
    "button:visible:enabled, textarea:visible:enabled, select:visible:enabled, input:visible:enabled",
  );
  const controls = await enabled.count();
  await enabled.evaluateAll((els) =>
    els.forEach((e, i) => e.setAttribute("data-e2e-control", String(i))),
  );
  const reached = new Set<string>();
  for (let i = 0; i < controls + 5; i++) {
    await sidebar.keyboard.press("Tab");
    reached.add(
      await sidebar.evaluate(
        () => document.activeElement?.getAttribute("data-e2e-control") ?? "not-a-control",
      ),
    );
  }
  reached.delete("not-a-control");
  expect(reached.size).toBeGreaterThanOrEqual(controls);
});
