function withActiveTab(fn) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;
    fn(tab);
  });
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

document.getElementById('copyAll').addEventListener('click', () => {
  withActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, 'copy-all-exceptions', () => {
      if (chrome.runtime.lastError) {
        setStatus('Could not reach page. Try reloading it.');
        return;
      }
      setStatus('Done — check the page for confirmation.');
    });
  });
});

document.getElementById('copyAi').addEventListener('click', () => {
  withActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, 'copy-exceptions-ai', () => {
      if (chrome.runtime.lastError) {
        setStatus('Could not reach page. Try reloading it.');
        return;
      }
      setStatus('Done — check the page for confirmation.');
    });
  });
});

document.getElementById('openOptions').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('pick').addEventListener('click', () => {
  withActiveTab(tab => {
    chrome.tabs.sendMessage(tab.id, 'start-picker', () => {
      if (chrome.runtime.lastError) {
        setStatus('Could not reach page. Try reloading it.');
        return;
      }
      window.close();
    });
  });
});
