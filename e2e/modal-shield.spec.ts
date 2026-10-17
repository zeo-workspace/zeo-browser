// Story 045, task 13.4 — E2E: the picker's frame shield under a modal dialog (R9.19; design.md
// §A5 "Under a modal dialog", v5; live-proof failure F4, check 16 of
// docs/assets/045-live-proof-2026-10-17). Tool: playwright (@playwright/test). Quality: Q13.
//
// F4, as measured: with a modal <dialog> open, the hover label `iframe · #frame` shows, but the
// press goes into the iframe and nothing is picked — everything outside an open modal is inert,
// the picker's top-layer host included, so its shield over the iframe is never hit-tested.
//
// Self-contained: launch, the native-messaging wrapper, the popup stand-in sidebar, pressShortcut
// and the xvfb-run guard are copied from e2e/sidebar.spec.ts (task 8.3), whose header explains the
// setup. Only the fake Zeo is shared (./fake-zeo.js).
//
// The Pick shortcut is read ONCE, into PICK_SHORTCUT, from the built manifest's `start-picker`
// default: Alt+Shift+P once task 13.3 lands, Alt+Shift+E before it. The spec follows the build
// either way and names no key itself.
//
// How the picker host is found without knowing its shape: every element of the fixture is
// marked before the picker starts, so any unmarked element in the page document is the picker's
// (the fixture adds nothing after load). Its label lives in a closed shadow root, read over CDP
// (`DOM.getDocument` with `pierce`), which page scripts and Playwright locators cannot reach.
//
// Hostile halves:
//   - the press on the iframe must NOT reach the iframe's own document, and must NOT pick the
//     dialog, the frame's content or nothing: exactly one `iframe` chip, selector `#frame`;
//   - with two stacked modals, a host placed in the lower one is as inert as one at the root:
//     the iframe of the TOPMOST modal must be the one picked;
//   - the host must leave with the picker: no element of the picker stays in the dialog (or
//     anywhere) after the picker ends, by a press or by Esc; after a pick the dialog is still the
//     open modal the page made it;
//   - regression: a button inside the dialog stays pickable and its page handler gets no click
//     (R9.5); with the modal closed mid-pick, an element outside any dialog is still picked.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import { buildManifest } from "../scripts/manifest.mjs";
import { extensionIdFromKey } from "../scripts/extension-id.mjs";
import { startFakeZeoV2, type FakeZeoV2 } from "./fake-zeo.js";

const DIST = fileURLToPath(new URL("../dist/chrome", import.meta.url));
const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/modal.html", import.meta.url)),
  "utf8",
);
const BIN = process.env.ZEO_BROWSER_HOST_BIN;
const ID = extensionIdFromKey((buildManifest("chrome") as { key: string }).key);

/**
 * The Pick shortcut as xdotool types it ("alt+shift+p"), from the built manifest's
 * `start-picker` suggested key. Without a build the suite is skipped below, so the fallback is
 * never typed.
 */
const PICK_SHORTCUT = pickShortcutFromBuild();

function pickShortcutFromBuild(): string {
  const path = join(DIST, "manifest.json");
  if (!existsSync(path)) {
    return "alt+shift+p";
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    commands?: Record<string, { suggested_key?: { default?: string; linux?: string } }>;
  };
  const key = manifest.commands?.["start-picker"]?.suggested_key;
  const chord = key?.linux ?? key?.default;
  if (!chord) {
    throw new Error("dist/chrome/manifest.json binds no key to start-picker");
  }
  return chord
    .split("+")
    .map((k) => k.trim().toLowerCase())
    .join("+");
}

const run = promisify(execFile);

// Refuse before anything launches unless this runs inside `xvfb-run` (`npm run e2e`): the spec
// runs Chromium headed and types real key chords with xdotool, which on the desktop session would
// open windows there and send the Pick chord into the user's own apps. xvfb-run is recognised by
// the Xauthority file it creates (`/tmp/xvfb-run.XXXXXX/Xauthority`).
const UNDER_XVFB =
  process.env.DISPLAY !== undefined &&
  /\/xvfb-run\.[^/]+\/Xauthority$/.test(process.env.XAUTHORITY ?? "");
if (!UNDER_XVFB) {
  throw new Error(
    "e2e/modal-shield.spec.ts refuses to run outside xvfb-run (it drives a headed browser and " +
      "types real key chords): use `npm run e2e`",
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
let site: { server: Server; url: string };
let profile: string;
let context: BrowserContext;
let sw: Worker;
let page: Page;

async function serveFixture() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/modal.html") {
      res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  };
}

async function launch() {
  profile = await mkdtemp(join(tmpdir(), "zeo-e2e-profile-"));
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
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    // Headed: browser commands need a real X window, which Xvfb provides. X11 is forced twice
    // (no WAYLAND_DISPLAY, ozone x11) so the window cannot land on the desktop.
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
  await page.goto(site.url + "modal.html");
  // The modal is open (showModal at load) and both frames have their documents.
  await expect
    .poll(() => page.evaluate(() => document.querySelector("dialog:modal")?.id))
    .toBe("dlg");
  await page.waitForFunction(
    () =>
      (
        document.getElementById("frame") as HTMLIFrameElement | null
      )?.contentDocument?.getElementById("framed") != null &&
      (
        document.getElementById("frame2") as HTMLIFrameElement | null
      )?.contentDocument?.getElementById("framed2") != null,
  );
}

/** The sidebar, opened by the service worker in a popup so the fixture tab stays active. */
async function openReadySidebar(): Promise<Page> {
  const opened = context.waitForEvent("page", (p) => p.url().includes("/sidebar/index.html"));
  await sw.evaluate(
    (url) =>
      chrome.windows.create({
        url,
        type: "popup",
        width: 420,
        height: 800,
        focused: false,
      }),
    `chrome-extension://${ID}/sidebar/index.html`,
  );
  const sidebar = await opened;
  await sidebar.waitForLoadState();
  await page.bringToFront();
  await expect(sidebar.getByText("hello from zeo")).toBeVisible();
  return sidebar;
}

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await run("xdotool", args, { timeout: 10_000 });
  return stdout.trim();
}

/**
 * Presses a real key chord on the fixture page's window (browser commands never come from
 * Playwright's CDP input). The window is found by a unique title, restored right after.
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

/** The Pick shortcut: grants `activeTab` and starts the picker (Decision A8). */
const pressPickShortcut = () => pressShortcut(PICK_SHORTCUT);

/** Marks every element the fixture owns, so the picker's own elements are the unmarked ones. */
async function markFixture(): Promise<void> {
  await page.evaluate(() =>
    document.querySelectorAll("*").forEach((e) => e.setAttribute("data-e2e-fixture", "")),
  );
}

/**
 * Where the picker's elements sit: one entry per unmarked element in the page document, the id
 * of the dialog that holds it, or "root" outside any dialog. Empty when the picker is off.
 */
const hostPlaces = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(":not([data-e2e-fixture])")].map(
      (e) => e.parentElement?.closest("dialog")?.id ?? "root",
    ),
  );

async function waitForPicker(on: boolean): Promise<void> {
  await expect.poll(async () => (await hostPlaces()).length > 0).toBe(on);
}

/** The text nodes inside shadow roots of the page document: the picker's label (closed root). */
async function overlayTexts(): Promise<string[]> {
  interface DomNode {
    nodeType: number;
    nodeValue?: string;
    children?: DomNode[];
    shadowRoots?: DomNode[];
  }
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = (await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as {
      root: DomNode;
    };
    const texts: string[] = [];
    // Frame documents (`contentDocument`) are not walked: only the page's own shadow roots.
    const walk = (n: DomNode, inShadow: boolean) => {
      if (inShadow && n.nodeType === 3 && n.nodeValue?.trim()) {
        texts.push(n.nodeValue.trim());
      }
      n.children?.forEach((c) => walk(c, inShadow));
      n.shadowRoots?.forEach((s) => walk(s, true));
    };
    walk(root, false);
    return texts;
  } finally {
    await cdp.detach();
  }
}

/** Moves the real mouse to the centre of `target` in steps, so the picker sees a hover. */
async function hover(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  expect(box, "target has a box").not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x - 20, y - 10);
  await page.mouse.move(x, y, { steps: 5 });
  return { x, y };
}

/** A plain press at the current pointer position, through Chromium's own hit testing. */
async function press(): Promise<void> {
  await page.mouse.down();
  await page.mouse.up();
}

/** Counts presses that reach a frame's own document (they must not, while picking). */
async function countFramePresses(frameId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as Record<string, number>;
    w[`presses_${id}`] = 0;
    const doc = (document.getElementById(id) as HTMLIFrameElement).contentDocument!;
    for (const type of ["pointerdown", "mousedown", "click"]) {
      doc.addEventListener(type, () => (w[`presses_${id}`] = (w[`presses_${id}`] ?? 0) + 1), true);
    }
  }, frameId);
}

const framePresses = (frameId: string) =>
  page.evaluate((id) => (window as unknown as Record<string, number>)[`presses_${id}`]!, frameId);

/** Sends the composer and returns the element attachments Zeo received. */
async function sendElements(
  sidebar: Page,
): Promise<{ selector: string; html: string; page_url: string }[]> {
  await sidebar.getByRole("textbox").fill("these");
  await sidebar.getByRole("button", { name: /^send$/i }).click();
  const sent = await fake.waitFor("send");
  return sent.attachments.filter((a: { type: string }) => a.type === "element");
}

/** The dialog stays as the page left it: open, modal, and with only its own children. */
async function expectDialogUntouched(id: string): Promise<void> {
  expect(
    await page.evaluate((d) => {
      const dlg = document.getElementById(d) as HTMLDialogElement;
      return {
        open: dlg.open,
        modal: dlg.matches(":modal"),
        foreign: [...dlg.querySelectorAll(":not([data-e2e-fixture])")].length,
      };
    }, id),
  ).toEqual({ open: true, modal: true, foreign: 0 });
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

test.describe("picker under a modal dialog (R9.19)", () => {
  test("hostile: a press on an iframe inside the modal picks the iframe element, not into the frame (R9.19, F4)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    await markFixture();
    await countFramePresses("frame");

    await pressPickShortcut();
    await waitForPicker(true);
    // The overlay shares the modal's non-inert subtree (design §A5, v5). Soft: the behaviour
    // below is the requirement, and still runs and reports when the placement is wrong.
    expect.soft(await hostPlaces(), "picker host inside the open modal").toEqual(["dlg"]);

    await hover(page.locator("#frame"));
    await expect.poll(overlayTexts).toContain("iframe · #frame");

    await press();
    // The shield took the press: nothing reached the frame's document...
    expect(await framePresses("frame")).toBe(0);
    // ...and the frame element itself was picked, once, and nothing else.
    await expect(sidebar.getByText(/iframe · 127\.0\.0\.1/)).toHaveCount(1);
    await expect(sidebar.getByText(/^(dialog|p|html|body) · /)).toHaveCount(0);

    // A plain press ends the picker (R9.2), and the host leaves with it: none in the dialog,
    // none anywhere, and the page's dialog is still the open modal it was.
    await waitForPicker(false);
    expect(await hostPlaces()).toEqual([]);
    await expectDialogUntouched("dlg");

    const elements = await sendElements(sidebar);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.selector).toBe("#frame");
    expect(elements[0]!.html).toMatch(/^<iframe\b/);
    expect(elements[0]!.page_url).toBe(`${site.url}modal.html`);
  });

  test("hostile: with two stacked modals, the iframe of the topmost one is picked (R9.19)", async () => {
    await launch();
    await page.evaluate(() => (document.getElementById("dlg2") as HTMLDialogElement).showModal());
    const sidebar = await openReadySidebar();
    await markFixture();
    await countFramePresses("frame2");

    await pressPickShortcut();
    await waitForPicker(true);
    // The lower modal is inert under the upper one: the host belongs in the topmost.
    expect.soft(await hostPlaces(), "picker host inside the topmost modal").toEqual(["dlg2"]);

    await hover(page.locator("#frame2"));
    await expect.poll(overlayTexts).toContain("iframe · #frame2");
    await press();
    expect(await framePresses("frame2")).toBe(0);
    await expect(sidebar.getByText(/iframe · 127\.0\.0\.1/)).toHaveCount(1);

    await waitForPicker(false);
    expect(await hostPlaces()).toEqual([]);
    await expectDialogUntouched("dlg2");

    const elements = await sendElements(sidebar);
    expect(elements.map((e) => e.selector)).toEqual(["#frame2"]);
  });

  test("regression: a button inside the modal is still pickable and its handler gets no click (R9.2, R9.5, R9.19)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    await markFixture();

    await pressPickShortcut();
    await waitForPicker(true);
    await hover(page.locator("#dialog-btn"));
    await expect.poll(overlayTexts).toContain("button · #dialog-btn");
    await press();
    expect(
      await page.evaluate(() => (window as unknown as { dialogClicks: number }).dialogClicks),
    ).toBe(0);
    await expect(sidebar.getByText(/button · 127\.0\.0\.1/)).toHaveCount(1);
    await waitForPicker(false);
    expect(await hostPlaces()).toEqual([]);
    await expectDialogUntouched("dlg");

    // With the picker off, the page's button is the page's again.
    await page.locator("#dialog-btn").click();
    expect(
      await page.evaluate(() => (window as unknown as { dialogClicks: number }).dialogClicks),
    ).toBe(1);

    const elements = await sendElements(sidebar);
    expect(elements.map((e) => e.selector)).toEqual(["#dialog-btn"]);
  });

  test("hostile: Esc under the modal ends the picker with no host left in the dialog (R9.4, R9.19)", async () => {
    await launch();
    await openReadySidebar();
    await markFixture();

    await pressPickShortcut();
    await waitForPicker(true);
    await hover(page.locator("#frame"));
    await expect.poll(overlayTexts).toContain("iframe · #frame");
    await page.keyboard.press("Escape");

    await waitForPicker(false);
    // Whatever Esc does to the page's own modal (its cancel behaviour is not this story's), no
    // element of the picker stays behind in the dialog or anywhere else.
    expect(await hostPlaces()).toEqual([]);
    expect(
      await page.evaluate(() => document.querySelectorAll("#dlg :not([data-e2e-fixture])").length),
    ).toBe(0);
  });

  test("the modal closing mid-pick moves the overlay back to the root, and an outside element is picked (R9.19)", async () => {
    await launch();
    const sidebar = await openReadySidebar();
    await markFixture();

    await pressPickShortcut();
    await waitForPicker(true);
    await page.evaluate(() => (document.getElementById("dlg") as HTMLDialogElement).close());

    await hover(page.locator("#outside-btn"));
    await expect.poll(hostPlaces).toEqual(expect.arrayContaining(["root"]));
    expect((await hostPlaces()).filter((p) => p !== "root")).toEqual([]);
    await expect.poll(overlayTexts).toContain("button · #outside-btn");
    await press();
    expect(
      await page.evaluate(() => (window as unknown as { outsideClicks: number }).outsideClicks),
    ).toBe(0);
    await expect(sidebar.getByText(/button · 127\.0\.0\.1/)).toHaveCount(1);
    await waitForPicker(false);
    expect(await hostPlaces()).toEqual([]);

    const elements = await sendElements(sidebar);
    expect(elements.map((e) => e.selector)).toEqual(["#outside-btn"]);
  });
});
