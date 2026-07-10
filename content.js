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
  function showToast(msg, duration = 2500) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'acu-copy-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('acu-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('acu-visible'), duration);
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

  // ---------- trace grid context (screen / request type / command) ----------
  // The trace screen's request grid renders rows as <tr class="data-line">
  // with per-field cell classes (col-screenId, col-requestType, col-command…).
  // Rows whose request errored carry the "error" class; the row driving the
  // messages panel below carries selected="true".
  function readRowContext(tr) {
    const cell = cls => {
      const td = tr.querySelector('td.col-' + cls);
      return td ? td.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    return {
      screenId: cell('screenId'),
      requestType: cell('requestType'),
      command: cell('command'),
      startTime: cell('startTime'),
      duration: cell('duration')
    };
  }

  function formatRowContext(ctx) {
    const parts = [];
    if (ctx.screenId) parts.push(`Screen: ${ctx.screenId}`);
    if (ctx.requestType) parts.push(`Request Type: ${ctx.requestType}`);
    if (ctx.command) parts.push(`Command: ${ctx.command}`);
    if (ctx.startTime) parts.push(`Started: ${ctx.startTime}`);
    if (ctx.duration) parts.push(`Duration: ${ctx.duration} ms`);
    return parts.join(' | ');
  }

  function getTraceContext() {
    const rows = Array.from(document.querySelectorAll('tr.data-line'));
    const errorRows = rows.filter(r => r.classList.contains('error'));
    const selected = rows.find(r => r.getAttribute('selected') === 'true');

    // Prefer the selected row when it errored — its exceptions are the ones
    // shown in the panel. Otherwise fall back to the first error row, then to
    // whatever row is selected.
    let primaryRow = null;
    if (selected && selected.classList.contains('error')) primaryRow = selected;
    else if (errorRows.length > 0) primaryRow = errorRows[0];
    else if (selected) primaryRow = selected;

    return {
      primary: primaryRow ? readRowContext(primaryRow) : null,
      errorRows: errorRows.map(readRowContext)
    };
  }

  // ---------- AI prompt ----------
  function getAiPrompt() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get({ aiPrompt: ACU_DEFAULT_PROMPT }, data => {
          resolve((data && data.aiPrompt) || ACU_DEFAULT_PROMPT);
        });
      } catch (e) {
        resolve(ACU_DEFAULT_PROMPT);
      }
    });
  }

  function fillPromptTemplate(template, ctx, count) {
    const values = {
      screenId: (ctx && ctx.screenId) || 'unknown',
      requestType: (ctx && ctx.requestType) || 'unknown',
      command: (ctx && ctx.command) || 'unknown',
      count: String(count),
      url: location.href
    };
    return template.replace(
      /\{(screenId|requestType|command|count|url)\}/g,
      (m, key) => values[key]
    );
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

  // ---------- auto-selecting errored grid rows ----------
  // Acumatica only renders the details panel (and its exception blocks) for
  // the grid row that is currently selected. If nothing is rendered but the
  // grid has rows flagged with errors, select each of those rows in turn and
  // wait for the panel to load before extracting.
  function getErrorRowElements() {
    return Array.from(document.querySelectorAll('tr.data-line.error'));
  }

  async function waitFor(test, timeout, interval = 120) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (test()) return true;
      await sleep(interval);
    }
    return test();
  }

  function renderedExceptionsSnapshot() {
    return findExceptionMessageItems(document.body).map(extractExceptionCard).join('\n\n');
  }

  function synthClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function clickElementWithText(text) {
    const candidates = Array.from(
      document.body.querySelectorAll('a, button, span, div, li')
    ).filter(el => (el.textContent || '').trim() === text);
    if (candidates.length === 0) return false;
    // querySelectorAll is document order, so nested wrappers sharing the same
    // trimmed text put the innermost element last — click that one.
    synthClick(candidates[candidates.length - 1]);
    return true;
  }

  async function selectErrorRowAndWait(tr) {
    const before = renderedExceptionsSnapshot();
    if (tr.getAttribute('selected') !== 'true') {
      synthClick(tr);
      // Aurelia may reuse DOM nodes on re-render, so compare extracted text
      // rather than node identity to detect the panel updating.
      await waitFor(() => {
        const now = renderedExceptionsSnapshot();
        return now !== '' && (before === '' || now !== before);
      }, 2500);
    }
    if (findExceptionMessageItems(document.body).length === 0) {
      // The active tab may not show exceptions — try the EXCEPTIONS tab.
      if (clickElementWithText('EXCEPTIONS')) {
        await waitFor(() => findExceptionMessageItems(document.body).length > 0, 1500);
      }
    }
    await expandAll(document.body);
    return findExceptionMessageItems(document.body).map(extractExceptionCard);
  }

  // ---------- main actions ----------
  async function copyAllExceptions(includeAiPrompt) {
    await expandAll(document.body);

    let items = findExceptionMessageItems(document.body);
    let useGenericExtraction = false;

    if (items.length === 0) {
      items = findExceptionCardsGeneric(document.body);
      useGenericExtraction = true;
    }

    let bodies;
    let sections = null; // per-request grouping when we auto-selected rows

    if (items.length > 0) {
      bodies = items.map(c =>
        useGenericExtraction ? cleanText(c.innerText || '') : extractExceptionCard(c)
      );
    } else {
      // Nothing rendered — the details panel only shows the selected row's
      // messages. If the grid flags errored requests, select them ourselves.
      const errorRows = getErrorRowElements();
      if (errorRows.length === 0) {
        showToast('No exceptions found on this page. Try "Pick element" instead.');
        return;
      }
      showToast(`Loading exceptions from ${errorRows.length} errored request(s)…`);
      sections = [];
      for (const tr of errorRows) {
        const rowBodies = await selectErrorRowAndWait(tr);
        sections.push({ ctx: readRowContext(tr), bodies: rowBodies });
      }
      bodies = sections.flatMap(s => s.bodies);
      if (bodies.length === 0) {
        const hint = formatRowContext(sections[0].ctx);
        showToast(
          `Couldn't load the exception details automatically — click the errored row in the grid (${hint || 'red error icon'}), then copy again.`,
          6000
        );
        return;
      }
    }

    const count = bodies.length;
    const context = getTraceContext();
    const primaryCtx = sections
      ? (sections.find(s => s.bodies.length > 0) || sections[0]).ctx
      : context.primary;

    const headerLines = [`Acumatica Trace — ${count} exception(s)`];
    if (!sections && primaryCtx) {
      const line = formatRowContext(primaryCtx);
      if (line) headerLines.push(line);
    }
    headerLines.push(`URL: ${location.href}`);
    headerLines.push(`Captured: ${new Date().toISOString()}`);
    if (!sections && context.errorRows.length > 1) {
      headerLines.push('', `Requests with errors (${context.errorRows.length}):`);
      context.errorRows.forEach((c, i) => {
        headerLines.push(`  ${i + 1}. ${formatRowContext(c)}`);
      });
    }

    let bodyText;
    if (sections) {
      let n = 0;
      bodyText = sections
        .map(s => {
          const head = `=== Errored request — ${formatRowContext(s.ctx) || '(unknown request)'} ===`;
          if (s.bodies.length === 0) {
            return `${head}\n(couldn't load this request's exceptions automatically — select its row in the grid to view them)`;
          }
          const ex = s.bodies.map(b => `--- Exception ${++n} of ${count} ---\n${b}`);
          return `${head}\n${ex.join('\n\n')}`;
        })
        .join('\n\n');
    } else {
      bodyText = bodies
        .map((b, i) => `--- Exception ${i + 1} of ${count} ---\n${b}`)
        .join('\n\n');
    }

    let text = `${headerLines.join('\n')}\n\n${bodyText}`;

    if (includeAiPrompt) {
      const template = await getAiPrompt();
      const prompt = fillPromptTemplate(template, primaryCtx, count);
      text = `${prompt}\n\n${text}`;
    }

    await copyToClipboard(text);
    showToast(
      includeAiPrompt
        ? `Copied ${count} exception(s) + AI prompt`
        : `Copied ${count} exception(s) to clipboard`
    );
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
    mainBtn.addEventListener('click', () => copyAllExceptions(false));

    const aiBtn = document.createElement('button');
    aiBtn.className = 'acu-ai';
    aiBtn.textContent = '🤖 Copy for AI';
    aiBtn.addEventListener('click', () => copyAllExceptions(true));

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
    fabRoot.appendChild(aiBtn);
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
      copyAllExceptions(false);
    } else if (msg === 'copy-exceptions-ai') {
      copyAllExceptions(true);
    } else if (msg === 'start-picker') {
      startPicking();
    }
    sendResponse({ ok: true });
  });
})();
