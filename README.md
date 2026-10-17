# Zeo Browser

A Chrome/Chromium and Firefox sidebar on the Zeo agent thread you are already using. You can
read the thread, write to it, stop it and answer its permission requests from the browser, and
attach page elements, screenshots and (Chrome only) console/network recordings to a message.

**It is the same thread, not a second agent.** The sidebar renders the entries of a thread
that is open in a Zeo window, and a message sent from it goes through that thread's own
send-and-queue path: Zeo's history stores it like any other message, and Zeo's composer is
left alone. Nothing in the extension runs an agent session of its own.

How it reaches Zeo:

```
sidebar page ──native messaging──► zeo-browser-host ──unix socket──► Zeo's devtools bridge
                (stdio frames)      (/usr/libexec)    ($XDG_RUNTIME_DIR/zeo/devtools.sock)
```

The native port lives in the sidebar page: opening the sidebar starts the host, and closing it
stops the host. There is no TCP port and no second socket.

## Requirements

| What | Why |
|---|---|
| Node.js ≥ 24 and npm | to build and test the extension |
| Chrome or Chromium ≥ 116, or Firefox ≥ 128 | the manifests' minimum versions |
| Zeo built with USE `browser-extension` (which needs USE `devtools-bridge`) | it installs the native host and the files that tell the browser where the host is |

## Build

```bash
npm ci
npm run build
```

`npm run build` writes three things from the same source:

- `dist/chrome/`: the unpacked Chrome/Chromium build;
- `dist/firefox/`: the unpacked Firefox build;
- `dist/zeo-browser-firefox.zip`: the same Firefox build, zipped and unsigned.

It also prints the Chrome extension ID.

## Install in Chrome or Chromium

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `dist/chrome`.
3. Check the ID on the card. It must be **`dhbddmompicnipfolmglmbnlpgglojid`**.

The ID comes from the public key in `manifests/chrome.json`, so every checkout produces the same
one. The host's manifest allows exactly this ID. A different ID means a different key, and
Chrome will refuse to start the host for it.

## Install in Firefox

The add-on ID is **`zeo-browser@zeo.dev`**. The build is unsigned, so there are two routes.

**Persistent (package manager).** The Gentoo package `www-plugins/zeo-browser` installs the
add-on into Firefox's system scope, and Zeo's USE `browser-extension` pulls it in. It lands as
`/usr/$(get_libdir)/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}/zeo-browser@zeo.dev.xpi`.
No step needs root beyond the package manager. Gentoo's source-built `www-client/firefox`
accepts unsigned add-ons in that scope; Mozilla's signed `firefox-bin` does not, so it uses the
temporary route below.

**Temporary (any Firefox, until it restarts).**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `dist/firefox/manifest.json` (or
   `dist/zeo-browser-firefox.zip`).

## Connect to Zeo

1. Install Zeo with USE `browser-extension`. Its ebuild installs:
   - the host binary, `/usr/libexec/zeo-browser-host`;
   - the host manifest `dev.zeo.browser_host.json`, which lets one extension ID start the host,
     in `/etc/opt/chrome/native-messaging-hosts/` (Chrome), `/etc/chromium/native-messaging-hosts/`
     (Chromium) and `/usr/$(get_libdir)/mozilla/native-messaging-hosts/` (Firefox).
2. Start Zeo and open the sidebar.
3. **Approve the browser in Zeo.** On the first connection, Zeo shows a notification naming the
   browser and the extension ID, with **Allow** and **Deny**. Allow is remembered across
   restarts. Deny refuses that browser for the rest of the Zeo run. Without an answer within
   120 s, the attempt ends.
4. **Revoke access** at any time with the command palette action
   **`devtools bridge: revoke browser access`**. It forgets every approved browser and closes
   every open browser session.

What the sidebar tells you when something is missing:

| Sidebar says | Meaning |
|---|---|
| The Zeo browser host is not installed (USE=browser-extension) | the browser found no host manifest; it stops retrying |
| Zeo is not running, or its devtools bridge is off | the host started but cannot reach Zeo; it retries after 1, 2, 4, 8 and 16 s, then every 30 s |
| Approve this browser in Zeo | waiting for Allow in Zeo |
| a version mismatch naming both versions | the extension and Zeo speak different protocol versions |

## Use

| Action | How |
|---|---|
| Open the sidebar | toolbar icon, or **`Alt+Shift+Y`** |
| Pick elements on the page | **`Alt+Shift+D`** on the page, or **Pick element** in the sidebar. A plain click picks one element and stops. Shift+click adds or removes an element and keeps picking. Esc stops and attaches the set to the composer |
| Screenshot | **Screenshot**, or **Include screenshot** with a pick |
| Console & network (Chrome only) | **Record console & network**, then **Stop** (it stops by itself after 120 s) |

You can change the shortcuts at `chrome://extensions/shortcuts` or in Firefox under
`about:addons` → ⚙ → **Manage Extension Shortcuts**. The sidebar's sentences name whatever key
is bound to **Pick element** when they are shown, and say "the Pick element shortcut" when none
is. The default is `Alt+Shift+D` rather than a menu letter such as `E`: Firefox on Linux gives
`Alt+<menu access key>` to its menu bar even with Shift held, and Chrome keeps several
`Alt+Shift` letters for itself (`Alt+Shift+P` is "new tab group") and never hands them to an
extension.

**Why the shortcut or the toolbar icon comes first.** The extension does not ask for `tabs` or
`<all_urls>`, so the browser hides a tab's address from it. Pressing `Alt+Shift+D` on a page,
or clicking the toolbar icon there, grants `activeTab` for that tab. That grant makes the
page's address readable, and it is what screenshots need. After that, **Pick element** in the
sidebar asks the browser for that one site (`<origin>/*`). A click inside the sidebar grants
nothing. That is why the sidebar says "Zeo cannot see this page's address yet" until you use
the shortcut or the icon on the page.

## Permissions

| Permission | Browser | Why |
|---|---|---|
| `nativeMessaging` | both | to start `zeo-browser-host`, the only route to Zeo |
| `sidePanel` | Chrome | to show the sidebar (Firefox uses `sidebar_action`, which needs no permission) |
| `activeTab` | both | granted by `Alt+Shift+D` or the toolbar icon on a page: it makes the address readable and allows the screenshot |
| `scripting` | both | to inject the picker into the page you chose, on demand and only in the top frame |
| `storage` | both | to remember the thread choice and the settings, and never thread content |
| `debugger` | Chrome | to record console and network, attached only while recording |
| `<all_urls>` (optional host permission) | both | declared as optional only; the extension asks for one site (`<origin>/*`) at a time, from a Pick click |

There is no `tabs` permission, and `<all_urls>` is never requested as a whole.

## Security model

- **Who can talk to Zeo.** The browser starts the host only for the extension ID listed in the
  root-owned host manifests. The socket keeps the devtools bridge's protections (a 0700
  per-user directory, a 0600 socket and a peer-uid check). Any process running as your user can
  still open the socket and claim to be the extension. That is the same trust boundary as
  Zeo's own thread database. The approval prompt makes each new identity visible, and the
  revoke action withdraws it (Assumption A5).
- **Thread content reaches the sidebar, never the page.** Model output and tool-call text are
  shown in the sidebar, which is an extension page. Content scripts never receive thread
  content, and the extension stores none (Decision A6, operator, 2026-10-10).
- **Least privilege.** The extension has no `tabs` and no `<all_urls>`. Site access is asked for one
  origin at a time, screenshots rely on `activeTab`, and `debugger` exists only in the Chrome
  build. If the sidebar closes during a recording, the debugger is detached (Decision A8,
  operator, 2026-10-12).
- **Page content is untrusted.** Zeo hands elements and captures to the model inside an
  `<untrusted-page-content>` wrapper, so the model treats them as data, not as instructions.
- **Model output is untrusted in the browser.** Markdown is rendered with raw HTML escaped, and
  **images are never loaded**: an image becomes a link, because fetching it could leak data
  to its server. Links open with `noopener noreferrer`.
- **Redaction: what is stripped before anything leaves the page.**
  - **Outer HTML of a picked element** (sanitised in a separate, inert document, so nothing is
    refetched):
    - form values (`value`, `checked`, `selected`), the contents of `<textarea>` and password
      fields, and the contents of `contenteditable` and `role=textbox` elements;
    - `<script>`, `<style>` and `<noscript>` contents, `on*` handlers, `srcdoc`, `integrity`
      and `nonce`;
    - `data-*` attributes whose names look like tokens, and csrf/token `<meta>` content.

    In every URL attribute, `srcset` included, query values become `…`, and fragments and
    credentials are dropped. The result is capped at 16 KiB.
  - **Page address:** scheme, host and path only, with no query and no fragment.
  - **Network entries:** query values become `…`, and credentials and fragments are dropped.
    Headers, cookies and bodies are never read.
  - **Console text:** every URL inside it is redacted the same way.
- **The DOM summary.** Next to the outer HTML, each picked element carries a short summary
  (`dom`): its visible text, a few attributes (`role`, `aria-*`, `href`, `type`, `name`,
  `alt`) and some computed styles. Its text skips form controls and the text inside
  `contenteditable`, `role=textbox` and `textarea` elements, and its `href` is redacted like
  the outer HTML's links (query values become `…`, no credentials or fragment).

## Browser support

| | Chrome / Chromium | Firefox |
|---|---|---|
| Minimum version | 116 | 128 |
| Sidebar | side panel | `sidebar_action` |
| Read, write, stop, answer permissions | yes | yes |
| Pick elements, screenshots | yes | yes |
| Console & network recording | yes | **no**: there is no `debugger` API, so the control is not shown |
| Install | Load unpacked (`dist/chrome`) | system scope through `www-plugins/zeo-browser`, or temporary via `about:debugging` |

## Test

```bash
npm test             # vitest: unit, contract and host integration suites
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
```

The **host integration suite** drives the real `zeo-browser-host` binary. Set
`ZEO_BROWSER_HOST_BIN` to its path, built from a Zeo tree that carries the browser-extension
patch. When the variable is unset, the suite reports **SKIPPED** instead of passing.

```bash
npm run build
ZEO_BROWSER_HOST_BIN=/path/to/zeo-browser-host npm run e2e
```

`npm run e2e` runs Playwright under `xvfb-run`, and the spec refuses to start outside it.
Here is why: it drives a headed browser and types real key chords with `xdotool`, which on your
desktop would land in your own windows. The run needs these things, and without
`ZEO_BROWSER_HOST_BIN` or a built `dist/` it reports SKIPPED:

- `xvfb-run` and `xdotool`;
- a built `dist/`;
- `ZEO_BROWSER_HOST_BIN`;
- Playwright's Chromium (`npx playwright install chromium`). Branded Google Chrome ignores
  `--load-extension`, and Playwright's Firefox cannot load extensions. Firefox is covered by
  the unit tests of the shared code and by a manual live proof.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
