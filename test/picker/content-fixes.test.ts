// @vitest-environment happy-dom
// Story 045, task 4.2 fix round — the picker content script against hostile and awkward pages
// (design.md §A5). Requirements: R9.2, R9.5, R9.6, R9.9, R9.11.
//
// Hostile halves first:
//   - a page that defines `<zeo-picker>` cannot reach or break the overlay: the host is a `<div>`;
//   - a disabled control gets no click, yet it is picked (on pointerdown), and the rest of that
//     press never reaches the page;
//   - a press on a hovered iframe picks the iframe itself, through the shield;
//   - the page removing the overlay stops the picker and delivers nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_KEY, capPageUrl, isPdfViewer, startPicker } from "../../src/picker/content.js";
import { MAX_PAGE_URL_BYTES } from "../../src/limits.js";

let roots: Array<{ host: Element; root: ShadowRoot; mode: string }> = [];
const original = Element.prototype.attachShadow;
beforeEach(() => {
  roots = [];
  // Recorded open so the test can reach inside; the picker still asks for "closed".
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = original.call(this, { ...init, mode: "open" });
    roots.push({ host: this, root, mode: init.mode });
    return root;
  };
  const parsed = new DOMParser().parseFromString(
    '<body><button id="off" disabled>Off</button><button id="on">On</button>' +
      '<iframe id="frame" src="about:blank"></iframe><p id="para">x</p></body>',
    "text/html",
  );
  document.body.replaceChildren(...[...parsed.body.childNodes].map((n) => document.adoptNode(n)));
});
afterEach(() => {
  Element.prototype.attachShadow = original;
  // Ends any press tail left by a pick on a control that never got its click.
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
});

const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }),
  );
const press = (el: Element, shiftKey = false) => {
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    fire(el, t, { shiftKey });
  }
};
const byId = (id: string) => document.getElementById(id)!;

describe("host isolation (R9.11)", () => {
  it("hostile: the host is a built-in div, so a page-defined <zeo-picker> changes nothing", () => {
    customElements.define(
      "zeo-picker",
      class extends HTMLElement {
        constructor() {
          super();
          throw new Error("page trap");
        }
      },
    );
    const send = vi.fn();
    const p = startPicker({ send });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.host.localName).toBe("div");
    expect(roots[0]!.mode).toBe("closed");
    expect(p.active).toBe(true);
    p.stop();
  });

  it("without popover support it still mounts, outside the top layer", () => {
    const p = startPicker({ send: vi.fn() });
    expect(roots[0]!.host.isConnected).toBe(true);
    expect(roots[0]!.host.hasAttribute("popover")).toBe(false);
    p.stop();
  });

  it("with popover support it enters the top layer and is raised when another popover opens", () => {
    const proto = HTMLElement.prototype as any;
    const shown: Element[] = [];
    proto.showPopover = function () {
      shown.push(this);
    };
    proto.hidePopover = function () {};
    try {
      const p = startPicker({ send: vi.fn() });
      const host = roots[0]!.host;
      expect(host.getAttribute("popover")).toBe("manual");
      expect(shown).toEqual([host]);
      byId("para").dispatchEvent(new Event("toggle"));
      expect(shown).toEqual([host, host]);
      p.stop();
    } finally {
      delete proto.showPopover;
      delete proto.hidePopover;
    }
  });
});

describe("picking on pointerdown (R9.2, R9.5)", () => {
  it("hostile: a disabled button is picked, and the rest of the press never reaches the page", () => {
    const seen = vi.fn();
    for (const t of ["mousedown", "pointerup", "mouseup", "click"]) {
      byId("on").addEventListener(t, seen);
    }
    const send = vi.fn();
    startPicker({ send });
    // A disabled control gets pointer events only: no mousedown, mouseup or click.
    fire(byId("off"), "pointerdown");
    fire(byId("off"), "pointerup");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].items[0].selector).toBe("#off");
    // The press tail is still open (a disabled control never gets its click).
    fire(byId("on"), "mouseup");
    expect(seen).not.toHaveBeenCalled();
  });

  it("a plain press on an enabled control ends the picker, swallows its click, then lets go", () => {
    const seen = vi.fn();
    byId("on").addEventListener("click", seen);
    const send = vi.fn();
    startPicker({ send });
    press(byId("on"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
    fire(byId("on"), "click");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a secondary-button press picks nothing", () => {
    const send = vi.fn();
    const p = startPicker({ send });
    fire(byId("on"), "pointerdown", { button: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(p.active).toBe(true);
    p.stop();
  });
});

describe("frames", () => {
  it("hostile: a hovered iframe gets a shield, and a press on it picks the iframe", () => {
    const send = vi.fn();
    startPicker({ send });
    fire(byId("frame"), "pointermove");
    const shield = roots[0]!.root.querySelector<HTMLElement>(".shield")!;
    expect(shield.style.display).toBe("block");
    fire(shield, "pointermove");
    expect(roots[0]!.root.textContent).toContain("iframe · #frame");
    fire(shield, "pointerdown");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].items[0]).toMatchObject({ selector: "#frame" });
  });

  it("the shield goes away when the pointer moves to an ordinary element", () => {
    const p = startPicker({ send: vi.fn() });
    fire(byId("frame"), "pointermove");
    fire(byId("para"), "pointermove");
    expect(roots[0]!.root.querySelector<HTMLElement>(".shield")!.style.display).toBe("none");
    p.stop();
  });
});

describe("lifetime", () => {
  it("hostile: the page removing the overlay stops the picker and delivers nothing", async () => {
    const send = vi.fn();
    const p = startPicker({ send });
    press(byId("on"), true);
    roots[0]!.host.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.active).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("page_url (R9.6)", () => {
  it("is never cut inside a %XX escape", () => {
    const base = "https://app.example/";
    for (const pad of [0, 1, 2]) {
      const url = base + "a".repeat(MAX_PAGE_URL_BYTES - base.length - pad) + "%41%42%43";
      const cut = capPageUrl(url);
      expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(MAX_PAGE_URL_BYTES);
      expect(cut).not.toMatch(/%[0-9A-Fa-f]?$/);
      expect(() => decodeURI(cut)).not.toThrow();
    }
  });
});

describe("PDF viewer (R9.9)", () => {
  const doc = (html: string, contentType = "text/html") => {
    const d = new DOMParser().parseFromString(html, "text/html");
    Object.defineProperty(d, "contentType", { value: contentType });
    return d;
  };

  it("a PDF document and Chrome's viewer wrapper are recognised; an ordinary page is not", () => {
    expect(isPdfViewer(doc("<body></body>", "application/pdf"))).toBe(true);
    expect(isPdfViewer(doc('<body><embed type="application/pdf" src="about:blank"></body>'))).toBe(
      true,
    );
    expect(
      isPdfViewer(
        doc(
          '<body><embed src="chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"></body>',
        ),
      ),
    ).toBe(true);
    // A page that merely embeds a PDF among its content is an ordinary page.
    expect(
      isPdfViewer(doc('<body><p>Report</p><embed type="application/pdf" src="/r.pdf"></body>')),
    ).toBe(false);
  });

  async function bootIn(contentType: string) {
    delete (globalThis as any)[GLOBAL_KEY];
    Object.defineProperty(document, "contentType", { value: contentType, configurable: true });
    vi.resetModules();
    vi.doMock("../../src/platform.js", () => ({
      api: {
        runtime: {
          id: "ext",
          onMessage: { addListener() {} },
          sendMessage: vi.fn(async () => undefined),
        },
      },
    }));
    try {
      await import("../../src/picker/content.js");
      return (globalThis as any)[GLOBAL_KEY];
    } finally {
      vi.doUnmock("../../src/platform.js");
      delete (document as any).contentType;
    }
  }

  it("hostile: injected into a PDF viewer, the script mounts nothing and reports protected", async () => {
    const state = await bootIn("application/pdf");
    expect(state.status).toBe("protected");
    expect(state.picker).toBeNull();
    expect(roots).toHaveLength(0);
  });

  it("injected into an ordinary page, it mounts and reports mounted", async () => {
    const state = await bootIn("text/html");
    expect(state.status).toBe("mounted");
    expect(roots).toHaveLength(1);
    state.picker.stop();
  });

  it("the bundle evaluates to that status: the build's last statement reads the same key", () => {
    const build = readFileSync(join(process.cwd(), "scripts/build.mjs"), "utf8");
    expect(build).toContain(`globalThis[Symbol.for("${GLOBAL_KEY.description}")]?.status;`);
  });
});
