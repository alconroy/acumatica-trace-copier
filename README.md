# Acumatica Trace Copier

Chrome extension that captures Acumatica trace exceptions (or any panel) and copies clean text to the clipboard for pasting into Claude or any AI assistant for debugging.

Unofficial project — not affiliated with, endorsed by, or sponsored by Acumatica, Inc.

## Install

**From source (developer mode):**

1. Clone or download this repo.
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

**Packaged zip:** grab the latest `acumatica-trace-copier-vX.Y.Z.zip` from [Releases](../../releases), unzip it, then follow the same "Load unpacked" steps pointing at the unzipped folder.

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

The prompt is saved via `chrome.storage.sync`, so it follows you across Chrome profiles on the same account.

## How detection works

Acumatica's trace panel is an Aurelia app. Exception blocks are `<message-item>` custom elements marked with a `.label-exception` span; field values live in `<pre>` tags next to label text in `td.caption`. The extension targets that structure directly rather than guessing CSS classes, with a generic text-based fallback for older/different markup versions. If a future layout change ever breaks auto-detection, "Pick element" always works as a manual fallback.

Clipboard write tries the modern Clipboard API first, falling back to `document.execCommand('copy')` for reliability when triggered from the popup.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: nothing is collected, stored, or transmitted anywhere — all processing is local to your browser.

## License

[MIT](LICENSE)
