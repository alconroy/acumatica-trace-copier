# Acumatica Trace Copier

Browser extension that captures Acumatica trace exceptions (or any panel) and copies clean text to the clipboard for pasting into Claude or any AI assistant for debugging.

Unofficial project — not affiliated with, endorsed by, or sponsored by Acumatica, Inc.

## Install

### Chrome

[Check here to download from Chrome Web Store](https://tinyurl.com/AcumaticaTraceCopier)

**From source (developer mode):**

1. Clone or download this repo.
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

**Packaged zip:** grab the latest `acumatica-trace-copier-chrome-vX.Y.Z.zip` from [Releases](../../releases), unzip it, then follow the same "Load unpacked" steps pointing at the unzipped folder.

### Firefox

Submitted to addons.mozilla.org and awaiting review — a listing link will be added here once it's approved.

Until then, install from source: run the [build](#building), then open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and select `dist\firefox\manifest.json`. Note that a temporary add-on is removed when Firefox restarts.

Load `dist\firefox\`, **not the repo root** — see the note under [Building](#building) for why.

## Building

You don't need a build to run this in Chrome — the repo root is the source of truth and is Chrome-shaped, so **Load unpacked** on the repo folder works as-is. The build is for producing release zips, and for Firefox.

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1
```

That stages `dist\chrome\` and `dist\firefox\` and zips each. Use `-Browser chrome|firefox|all` to build a single target, and `-NoZip` to stage the folders without zipping while iterating.

The `-ExecutionPolicy Bypass` is per-invocation and changes nothing on your machine. Windows blocks unsigned scripts under the default `Restricted` policy, and a script cloned or downloaded from GitHub carries a mark-of-the-web that `RemoteSigned` blocks too — so this form is the one that works everywhere without you having to loosen a machine-wide security setting.

Every `.js`, `.css` and `.html` file is identical in both builds. The only difference is the manifest: Firefox requires a `browser_specific_settings.gecko` block, which Chrome reports as an unrecognized key. The script injects it into the Firefox build only, so there is one manifest to maintain and the two builds cannot drift. Don't add that key to the root manifest by hand — the build script refuses to run if it finds one.

> **Load `dist\firefox\` in Firefox, not the repo root.** The root manifest has no add-on ID, and Firefox keys `storage.sync` on that ID — the extension will load and appear to work, but your saved AI prompt will silently fail to persist.

The Firefox build also carries a `data_collection_permissions` declaration of `none`, which addons.mozilla.org requires, and a floor of Firefox 140 — the release that introduced support for that key.

Desktop Firefox only. There is deliberately no `gecko_android` key, the absence of which is what marks an add-on desktop-only on AMO: the floating button over a trace grid is a desktop-shaped UX and it has never been tested on Firefox for Android.

## Use

On an Acumatica trace page (any page containing "Exception Type:", "Stack Trace:", or "Last Requests"), a floating button appears bottom-right:

- **📋 Copy Exceptions** — auto-expands all "Show more" links and the "Expand All" toggle, finds every exception block, and copies them all as numbered plain text.
- **🤖 Copy for AI** — same as above, but prepends your configurable AI prompt so the result is ready to paste straight into Claude or any AI assistant.
- **🎯 Pick element** — crosshair mode; click any panel (Messages tab, SQL tab, a single exception card, an iframe body, etc.) to copy just that element's text. Press Esc to cancel.

The toolbar icon opens the same actions as a popup, useful if the floating button was dismissed or the trace panel is inside an iframe.

### Request context

On the trace screen, the copied header also includes which request caused the error — screen ID, request type, command, start time and duration — read from the trace request grid. If the row you have selected is the errored one, that row is used; otherwise the extension falls back to the rows flagged with errors, and lists all of them if there's more than one.

Acumatica only renders the details panel for the row you have selected, so if the errored request isn't the selected one, its exceptions aren't in the page at all. In that case the extension selects each errored row automatically, waits for the panel to load (switching to the EXCEPTIONS tab if needed), and copies every errored request's exceptions in one go, grouped per request. If the panel doesn't load in time, a toast tells you which row to click manually.

### AI prompt settings

Open **⚙️ AI prompt settings** from the popup (or the extension's options page). Choose one of the built-in presets or write your own prompt. Placeholders are filled in from the trace page at copy time:

| Placeholder | Filled with |
|---|---|
| `{screenId}` | Acumatica screen ID, e.g. `SO301000` |
| `{command}` | The action that ran, e.g. `RecalculatePackages` |
| `{requestType}` | Request type, e.g. `Screen` |
| `{count}` | Number of exceptions captured |
| `{url}` | The page URL |

The prompt is saved via `storage.sync`, so it follows you across profiles signed into the same account — a Google account in Chrome, a Firefox Account in Firefox.

## How detection works

Acumatica's trace panel is an Aurelia app. Exception blocks are `<message-item>` custom elements marked with a `.label-exception` span; field values live in `<pre>` tags next to label text in `td.caption`. The extension targets that structure directly rather than guessing CSS classes, with a generic text-based fallback for older/different markup versions. If a future layout change ever breaks auto-detection, "Pick element" always works as a manual fallback.

Clipboard write tries the modern Clipboard API first, falling back to `document.execCommand('copy')` for reliability when triggered from the popup.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: nothing is collected, stored, or transmitted anywhere — all processing is local to your browser.

## License

[MIT](LICENSE)
