# Chrome Web Store listing — draft copy

Paste these into the Developer Dashboard fields. Adjust freely.

## Title
Acumatica Trace Copier

## Summary (max 132 characters)
Copy Acumatica trace exceptions to your clipboard as clean text, ready to paste into Claude or any AI assistant.

(131 characters)

## Category
Developer Tools

## Language
English (United States)

## Detailed description

```
Copy Acumatica trace exceptions straight to your clipboard — clean, formatted, ready to paste into Claude or any AI assistant for debugging.

If you build customizations on Acumatica, you know the trace/exception log: multiple exceptions, each with a truncated stack trace behind a "Show more" link, no easy way to grab them all at once. This extension does that in one click.

FEATURES

• Auto-detect: a small floating "Copy Exceptions" button appears automatically on any Acumatica trace page.
• One-click copy: expands every truncated stack trace and "Expand All" toggle, then copies every exception block as clean, numbered plain text — no HTML clutter, no tooltip noise.
• Copy for AI: prepends your own configurable prompt (with placeholders like the screen ID and command) so the result is ready to paste straight into Claude or any AI assistant. Built-in presets included.
• Request context: the copied header includes which request errored — screen ID, request type, command, start time and duration — pulled from the trace grid.
• Auto-select: if the errored request isn't the row you have selected (so its exceptions aren't on screen yet), the extension selects each errored row for you, waits for the panel to load, and copies them all, grouped per request.
• Pick element mode: click any other panel (Messages, SQL, a single exception card) to copy just that instead.
• Works from the toolbar popup too, useful if the floating button was dismissed or the trace panel is inside an iframe.

PRIVACY

Nothing is collected, stored, or transmitted anywhere. All processing happens locally in your browser — the extension only reads the current page's text and writes it to your clipboard. No analytics, no network requests. Full policy: see the Privacy tab / linked policy.

This is an independent developer tool and is not affiliated with, endorsed by, or sponsored by Acumatica, Inc.
```

## Screenshots (1280x800 or 640x400, PNG without alpha or JPEG)

Take these from your own environment (don't reuse another company's real data if it contains sensitive info):

1. The floating "Copy Exceptions" button visible on a trace page with a few exceptions listed.
2. The toolbar popup showing the two action buttons.
3. (Optional) A before/after: the exceptions panel next to a pasted, cleaned-up text block in an editor or in Claude.

## Privacy practices tab (single purpose + permission justifications)

- **Single purpose**: Copies Acumatica trace/exception panels to the clipboard for debugging.
- **activeTab / scripting justification**: Used to read the currently open trace page's text so it can be copied to the clipboard.
- **Host permission (`<all_urls>`) justification**: Needed so the floating copy button can detect and appear automatically on Acumatica trace pages, which run on arbitrary customer domains (cloud and self-hosted instances alike).
- **clipboardWrite justification**: Writes the extracted trace text to the local clipboard.
- **storage justification**: Stores the user's own AI prompt template (a setting they type themselves) via chrome.storage.sync so it persists across sessions. No page data or user activity is ever stored.
- **Data collection**: No — answer "No" to every category in the questionnaire.
- **Privacy policy URL**: link to `PRIVACY.md` in this repo (e.g. `https://github.com/alconroy/acumatica-trace-copier/blob/main/PRIVACY.md`).

## Distribution

Visibility: **Unlisted** — installable only via direct link, not searchable in the Store.
