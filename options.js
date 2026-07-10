const presetSelect = document.getElementById('preset');
const promptArea = document.getElementById('prompt');
const statusEl = document.getElementById('status');

const CUSTOM_ID = 'custom';

function buildPresetOptions() {
  for (const p of ACU_PROMPT_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_ID;
  custom.textContent = 'Custom (write your own)';
  presetSelect.appendChild(custom);
}

function matchPresetId(text) {
  const hit = ACU_PROMPT_PRESETS.find(p => p.text === text);
  return hit ? hit.id : CUSTOM_ID;
}

function setStatus(msg) {
  statusEl.textContent = msg;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

function load() {
  chrome.storage.sync.get({ aiPrompt: ACU_DEFAULT_PROMPT }, data => {
    const text = data.aiPrompt || ACU_DEFAULT_PROMPT;
    promptArea.value = text;
    presetSelect.value = matchPresetId(text);
  });
}

presetSelect.addEventListener('change', () => {
  const preset = ACU_PROMPT_PRESETS.find(p => p.id === presetSelect.value);
  if (preset) promptArea.value = preset.text;
});

promptArea.addEventListener('input', () => {
  presetSelect.value = matchPresetId(promptArea.value);
});

document.getElementById('save').addEventListener('click', () => {
  const text = promptArea.value.trim();
  if (!text) {
    setStatus('Prompt is empty — nothing saved.');
    return;
  }
  chrome.storage.sync.set({ aiPrompt: text }, () => setStatus('Saved ✓'));
});

document.getElementById('reset').addEventListener('click', () => {
  promptArea.value = ACU_DEFAULT_PROMPT;
  presetSelect.value = matchPresetId(ACU_DEFAULT_PROMPT);
  chrome.storage.sync.set({ aiPrompt: ACU_DEFAULT_PROMPT }, () => setStatus('Default restored ✓'));
});

buildPresetOptions();
load();
