// Options page for Acumatica Trace Copier. Plain script, no bundler: it shares
// ACU_PROMPT_PRESETS / ACU_DEFAULT_PROMPT with content.js through prompts.js,
// which manifest.json and options.html both load first.
//
// Layout and styling are the Acumatica Developer Toolkit's options page, so the
// two products present one surface. Two things are deliberately NOT ported from
// it: settings live in chrome.storage.sync, not .local (see repairs entry 2 --
// the synced prompt is what the Firefox add-on ID exists to protect), and the
// storage calls stay callback-style, which is what every target supports.

const PLACEHOLDERS = ['screenId', 'command', 'requestType', 'count', 'url'];
const SAMPLE = {
  screenId: 'SO301000',
  command: 'RecalculatePackages',
  requestType: 'Screen',
  count: '2',
  url: 'https://erp.example/Main?ScreenId=SO301000'
};
const CUSTOM_ID = 'custom';

const STORE_NAMES = { chrome: 'Chrome Web Store', edge: 'Edge Add-ons', firefox: 'Firefox Add-ons' };
// Keyed by the card's id prefix in options.html; mirrors tool-links.ts in the
// Power Tools repo, which is where these URLs are kept verified.
const STORE_LINKS = {
  power: {
    chrome: 'https://chromewebstore.google.com/detail/acumatica-power-tools/pfkkhjcimlnldmcobphjbbbjncncjfmj',
    edge: 'https://microsoftedge.microsoft.com/addons/detail/acumatica-power-tools/cpiihgoldnjneadfodphdnkkjfnegejm',
    firefox: 'https://addons.mozilla.org/en-US/firefox/addon/acumatica-power-tools/'
  },
  audit: {
    chrome: 'https://chromewebstore.google.com/detail/acumatica-audit-trail-ana/goacaifbkahgafpfkpghnhpocckjjcdd',
    edge: 'https://microsoftedge.microsoft.com/addons/detail/acumatica-audit-trail-ana/lnlbokkopkhnbjdblnbbijkdadhalbfe',
    firefox: 'https://addons.mozilla.org/en-US/firefox/addon/acumatica-audit-trail-analyzer/'
  }
};
const WEBSITE = 'https://www.acugenconsulting.com/';

const presetSelect = document.getElementById('preset');
const promptArea = document.getElementById('prompt');
const statusEl = document.getElementById('status');
const dirtyEl = document.getElementById('dirty');
const previewEl = document.getElementById('prompt-preview');

let saved = { prompt: '', theme: 'system' };

// ---------------------------------------------------------------- presets --

for (const entry of ACU_PROMPT_PRESETS.concat([{ id: CUSTOM_ID, name: 'Custom (write your own)', text: '' }])) {
  const option = document.createElement('option');
  option.value = entry.id;
  option.textContent = entry.name;
  presetSelect.append(option);
}

function matchPreset() {
  const hit = ACU_PROMPT_PRESETS.find(entry => entry.text === promptArea.value);
  presetSelect.value = hit ? hit.id : CUSTOM_ID;
}

// ---------------------------------------------------------------- preview --

function renderPreview() {
  const parts = promptArea.value.split(/(\{[^{}]+\})/).filter(Boolean).map(part => {
    const key = part.slice(1, -1);
    if (part.startsWith('{') && PLACEHOLDERS.indexOf(key) !== -1) {
      const mark = document.createElement('mark');
      mark.textContent = SAMPLE[key];
      mark.title = '{' + key + '}';
      return mark;
    }
    return document.createTextNode(part);
  });
  previewEl.replaceChildren.apply(previewEl, parts);
}

// ------------------------------------------------------------ dirty state --

const themeInputs = Array.from(document.querySelectorAll('input[name=theme]'));
const currentTheme = () => (themeInputs.find(input => input.checked) || { value: 'system' }).value;
const snapshot = () => ({ prompt: promptArea.value.trim(), theme: currentTheme() });

function refresh() {
  const now = snapshot();
  dirtyEl.hidden = now.prompt === saved.prompt && now.theme === saved.theme;
  if (!dirtyEl.hidden && statusEl.textContent === 'Settings saved.') statusEl.textContent = '';
  renderPreview();
}

// ------------------------------------------------------------------ theme --

// Applied live so the radio doubles as a preview; persisted with Save, like
// every other setting on the page.
function applyTheme(value) {
  document.documentElement.dataset.theme = value === 'light' || value === 'dark' ? value : 'system';
}

themeInputs.forEach(input => input.addEventListener('change', () => { applyTheme(input.value); refresh(); }));

// ------------------------------------------------------------------ edits --

presetSelect.addEventListener('change', () => {
  const entry = ACU_PROMPT_PRESETS.find(item => item.id === presetSelect.value);
  if (entry) promptArea.value = entry.text;
  refresh();
});

promptArea.addEventListener('input', () => { matchPreset(); refresh(); });

document.querySelectorAll('[data-placeholder]').forEach(button => button.addEventListener('click', () => {
  const token = '{' + button.dataset.placeholder + '}';
  promptArea.focus();
  promptArea.setRangeText(token, promptArea.selectionStart, promptArea.selectionEnd, 'end');
  promptArea.dispatchEvent(new Event('input'));
}));

document.getElementById('reset').addEventListener('click', () => {
  promptArea.value = ACU_DEFAULT_PROMPT;
  matchPreset();
  refresh();
  statusEl.textContent = 'Default prompt restored. Select Save settings to apply.';
});

document.getElementById('settings').addEventListener('submit', event => {
  event.preventDefault();
  const text = promptArea.value.trim();
  if (!text) {
    statusEl.textContent = 'Enter a prompt before saving.';
    return;
  }
  const theme = currentTheme();
  chrome.storage.sync.set({ aiPrompt: text, theme: theme }, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      statusEl.textContent = error.message || String(error);
      return;
    }
    saved = { prompt: text, theme: theme };
    statusEl.textContent = 'Settings saved.';
    refresh();
  });
});

// ------------------------------------------------------------------- load --

chrome.storage.sync.get({ aiPrompt: ACU_DEFAULT_PROMPT, theme: 'system' }, data => {
  promptArea.value = (data && data.aiPrompt) || ACU_DEFAULT_PROMPT;
  const theme = data && (data.theme === 'light' || data.theme === 'dark') ? data.theme : 'system';
  themeInputs.forEach(input => { input.checked = input.value === theme; });
  applyTheme(theme);
  matchPreset();
  saved = snapshot();
  refresh();
});

// ------------------------------------------------------------ page furniture --

const indexLinks = Array.from(document.querySelectorAll('.index a'));
if (typeof IntersectionObserver === 'function') {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        indexLinks.forEach(link => link.setAttribute('aria-current', String(link.hash === '#' + entry.target.id)));
      }
    }
  }, { rootMargin: '0px 0px -70% 0px' });
  document.querySelectorAll('.ledger').forEach(section => observer.observe(section));
}

const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = manifest.version;

// Only the Firefox build's manifest carries a gecko ID (the build script adds
// it). Chrome and Edge share one payload and Edge installs happily from the
// Chrome Web Store, so both point there first and list the rest as "Also on".
const store = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko ? 'firefox' : 'chrome';
for (const tool of ['power', 'audit']) {
  const card = document.getElementById(tool + '-tool');
  card.href = STORE_LINKS[tool][store];
  card.querySelector('.store').textContent = STORE_NAMES[store];

  const also = document.querySelector('.also[data-tool="' + tool + '"]');
  also.replaceChildren('Also on ');
  ['chrome', 'edge', 'firefox'].filter(other => other !== store).forEach((other, index) => {
    const link = document.createElement('a');
    link.href = STORE_LINKS[tool][other];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = STORE_NAMES[other];
    also.append.apply(also, index ? [' and ', link] : [link]);
  });
}

document.getElementById('website').href = WEBSITE;
