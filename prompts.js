// Shared AI prompt presets — loaded by both the content script and the
// options page. Placeholders {screenId}, {requestType}, {command}, {count}
// and {url} are filled in from the trace grid at copy time.
const ACU_PROMPT_PRESETS = [
  {
    id: 'explain-fix',
    name: 'Explain & suggest a fix (developer)',
    text:
      'I was working in Acumatica on screen {screenId} and ran the "{command}" action ({requestType} request) when I got {count} exception(s). The full trace is below. Can you explain the likely root cause and suggest how to fix it?'
  },
  {
    id: 'quick-fix',
    name: 'Quick fix suggestion',
    text:
      'The Acumatica trace below shows {count} exception(s) from screen {screenId} (command: {command}). Identify the root cause and give me the most likely fix, including code if relevant.'
  },
  {
    id: 'plain-english',
    name: 'Plain-English explanation (support)',
    text:
      'I got the following error in Acumatica on screen {screenId} while running "{command}". Please explain in plain, non-technical English what went wrong and what I could try next.'
  },
  {
    id: 'bug-report',
    name: 'Bug report summary',
    text:
      'Summarize the Acumatica trace below into a concise bug report with: a title, the affected screen ({screenId}), the action performed ({command}), a short error summary, and a technical details section I can paste into a ticket.'
  }
];

const ACU_DEFAULT_PROMPT = ACU_PROMPT_PRESETS[0].text;
