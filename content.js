(() => {
  if (window.__acuCopyInjected) return;
  window.__acuCopyInjected = true;

  const SIGNATURE_RE = /Exception Type:|Last Requests|Stack Trace:/;

  // ---------- clipboard ----------
  function copyToClipboard(text) {
    return navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        ta.remove();
      }
    });
  }

  // ---------- toast ----------
  let toastEl = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'acu-copy-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('acu-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('acu-visible'), 2500);
  }

  // ---------- text cleanup ----------
  function cleanText(text) {
    return text
      .split('\n')
      .map(l => l.replace(/\s+$/, ''))
      .filter((l, i, arr) => !(l.trim() === '' && arr[i - 1] && arr[i - 1].trim() === ''))
      .filter(l => !/^(Show more|Show less|EXPAND ALL|COLLAPSE ALL)$/i.test(l.trim()))
      .join('\n')
      .trim();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------- expand truncated content ----------
  function findClickableByText(root, exactTexts) {
    const all = root.querySelectorAll('a, button, span, div');
    const out = [];
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (exactTexts.includes(t) && el.children.length <= 1) out.push(el);
    }
    return out;
  }

  // Acumatica's global toggle is <input type="button" value="Expand All"> —
  // it flips to value="Collapse All" once everything is already expanded,
  // so we must only click it while it still says "Expand All".
  function findExpandAllInputs(root) {
    return Array.from(root.querySelectorAll('input[type="button"]')).filter(
      el => (el.value || '').trim() === 'Expand All'
    );
  }

  async function expandAll(root) {
    for (let pass = 0; pass < 4; pass++) {
      const showMores = findClickableByText(root, ['Show more']);
      const expandAlls = findExpandAllInputs(root);
      const clickables = [...showMores, ...expandAlls];
      if (clickables.length === 0) break;
      for (const el of clickables) {
        try { el.click(); } catch (e) { /* ignore */ }
      }
      await sleep(80);
    }
  }

  // ---------- exception card detection (Acumatica/Aurelia trace panel) ----------
  // Each exception is a <message-item> custom element containing a
  // ".label-exception" marker span. This is precise and doesn't depend on
  // guessing CSS classes for the surrounding layout.
  function findExceptionMessageItems(root) {
    return Array.from(root.querySelectorAll('message-item')).filter(mi =>
      mi.querySelector('.label-exception')
    );
  }

  // Field rows look like: <td class="caption">...icon/tooltip...Exception Type:</td><td><pre>value</pre></td>
  // The label is the bare trailing text node of the caption cell (icon/tooltip are child elements, not text).
  function captionLabel(captionEl) {
    let label = '';
    captionEl.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) label += n.nodeValue;
    });
    return label.trim();
  }

  function extractExceptionCard(mi) {
    const headerTd = mi.querySelector('td.record-type');
    const header = headerTd ? headerTd.textContent.replace(/\s+/g, ' ').trim() : '(unknown exception)';

    const lines = [];
    mi.querySelectorAll('td.caption').forEach(cap => {
      const label = captionLabel(cap);
      if (!label) return;
      const valueTd = cap.nextElementSibling;
      if (!valueTd) return;
      const pre = valueTd.querySelector('pre');
      const value = (pre ? pre.textContent : valueTd.textContent).trim();
      lines.push(`${label} ${value}`);
    });

    return `${header}\n${lines.join('\n')}`;
  }

  // ---------- generic fallback (unknown/older markup) ----------
  function textNodesMatching(root, regex) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.trim();
      if (t && regex.test(t)) results.push(node);
    }
    return results;
  }

  function findExceptionCardsGeneric(root) {
    const labelNodes = textNodesMatching(root, /^Exception Type:?$/i);
    const cards = new Set();

    for (const tn of labelNodes) {
      let card = tn.parentElement;
      let guard = 0;
      let found = false;
      while (card && card.parentElement && guard < 12) {
        guard++;
        const parent = card.parentElement;
        const siblingHasLabel = Array.from(parent.children).some(
          sib => sib !== card && /Exception Type:?/i.test(sib.textContent || '')
        );
        if (siblingHasLabel) { found = true; break; }
        card = parent;
      }
      // Only trust the result if we actually found a repeating sibling boundary —
      // otherwise bail rather than merging unrelated page content into one "card".
      if (found && card) cards.add(card);
    }

    const arr = Array.from(cards);
    return arr.filter(c => !arr.some(other => other !== c && other.contains(c)));
  }

  // ---------- main actions ----------
  async function copyAllExceptions() {
    await expandAll(document.body);

    let items = findExceptionMessageItems(document.body);
    let useGenericExtraction = false;

    if (items.length === 0) {
      items = findExceptionCardsGeneric(document.body);
      useGenericExtraction = true;
    }

    if (items.length === 0) {
      showToast('No exceptions found on this page. Try "Pick element" instead.');
      return;
    }

    const parts = items.map((c, i) => {
      const body = useGenericExtraction ? cleanText(c.innerText || '') : extractExceptionCard(c);
      return `--- Exception ${i + 1} of ${items.length} ---\n${body}`;
    });

    const header = `Acumatica Trace — ${items.length} exception(s)\nURL: ${location.href}\nCaptured: ${new Date().toISOString()}\n`;
    const text = `${header}\n${parts.join('\n\n')}`;

    await copyToClipboard(text);
    showToast(`Copied ${items.length} exception(s) to clipboard`);
  }

  // ---------- picker mode ----------
  let picking = false;
  let hoveredEl = null;

  function onMouseMove(e) {
    const el = e.target;
    if (el === hoveredEl) return;
    if (hoveredEl) hoveredEl.classList.remove('acu-picker-hover');
    hoveredEl = el;
    hoveredEl.classList.add('acu-picker-hover');
  }

  async function onClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    stopPicking();

    await expandAll(target);
    const text = cleanText(target.innerText || '');
    if (!text) {
      showToast('Selected element has no text.');
      return;
    }
    const header = `Acumatica page capture\nURL: ${location.href}\nCaptured: ${new Date().toISOString()}\n`;
    await copyToClipboard(`${header}\n${text}`);
    showToast('Copied selection to clipboard');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') stopPicking();
  }

  function startPicking() {
    picking = true;
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    showToast('Click an element to copy it (Esc to cancel)');
  }

  function stopPicking() {
    picking = false;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (hoveredEl) hoveredEl.classList.remove('acu-picker-hover');
    hoveredEl = null;
  }

  // ---------- floating button ----------
  let fabRoot = null;

  function injectFab() {
    if (fabRoot) return;
    fabRoot = document.createElement('div');
    fabRoot.id = 'acu-copy-fab-root';

    const mainBtn = document.createElement('button');
    mainBtn.textContent = '📋 Copy Exceptions';
    mainBtn.addEventListener('click', () => copyAllExceptions());

    const pickBtn = document.createElement('button');
    pickBtn.className = 'acu-secondary';
    pickBtn.textContent = '🎯 Pick element';
    pickBtn.addEventListener('click', () => startPicking());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'acu-close';
    closeBtn.textContent = 'Hide';
    closeBtn.addEventListener('click', () => {
      fabRoot.remove();
      fabRoot = null;
    });

    fabRoot.appendChild(mainBtn);
    fabRoot.appendChild(pickBtn);
    fabRoot.appendChild(closeBtn);
    document.body.appendChild(fabRoot);
  }

  function checkAndInject() {
    if (fabRoot) return;
    if (!document.body) return;
    if (SIGNATURE_RE.test(document.body.innerText || '')) {
      injectFab();
    }
  }

  checkAndInject();
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (fabRoot) {
      observer.disconnect();
      return;
    }
    clearTimeout(scanTimer);
    scanTimer = setTimeout(checkAndInject, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ---------- messages from popup ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg === 'copy-all-exceptions') {
      copyAllExceptions();
    } else if (msg === 'start-picker') {
      startPicking();
    }
    sendResponse({ ok: true });
  });
})();
