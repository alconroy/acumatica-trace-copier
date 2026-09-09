(() => {
  if (window.__acuCopyInjected) return;
  window.__acuCopyInjected = true;

  const SIGNATURE_RE = /Exception Type:|Last Requests|Stack Trace:/;

  // Upper bound on how many grid rows a single scan will select in turn. Each
  // selection is a server round-trip, so an unbounded scan on a long-running
  // trace would hammer the instance.
  const MAX_ROWS_TO_SCAN = 40;

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
  // The row driving the messages panel below carries selected="true". Rows may
  // additionally carry an "error" class — see rowLooksErrored for why that is
  // only ever a hint.
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
    const rows = getRequestRows();
    const errorRows = rows.filter(rowLooksErrored);
    const selected = rows.find(r => r.getAttribute('selected') === 'true');

    // Prefer the selected row when it errored — its exceptions are the ones
    // shown in the panel. Otherwise fall back to the first error row, then to
    // whatever row is selected.
    let primaryRow = null;
    if (selected && rowLooksErrored(selected)) primaryRow = selected;
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
  function dedupeBy(items, keyOf) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  // All four trace tabs stay in the DOM at once — the inactive ones are only
  // hidden with display:none — and the ALL panel repeats every item the
  // EXCEPTIONS panel shows. Scanning the whole document therefore returns each
  // exception twice, so narrow to the dedicated exceptions panel when it exists
  // and fall back to de-duplicating by extracted text when it doesn't.
  function findExceptionMessageItems(root) {
    const exceptionsPanel = Array.from(root.querySelectorAll('messages-panel')).find(
      p => (p.getAttribute('data.bind') || '').trim() === 'exceptions'
    );
    const items = Array.from(
      (exceptionsPanel || root).querySelectorAll('message-item')
    ).filter(mi => mi.querySelector('.label-exception'));
    return exceptionsPanel ? items : dedupeBy(items, extractExceptionCard);
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
    const outermost = arr.filter(c => !arr.some(other => other !== c && other.contains(c)));
    // Same duplication as the message-item path: hidden tab panels repeat the
    // visible one's content.
    return dedupeBy(outermost, c => cleanText(c.innerText || ''));
  }

  // ---------- auto-selecting grid rows ----------
  // Acumatica only renders the details panel (and its exception blocks) for
  // the grid row that is currently selected. If nothing is rendered, select
  // each request row in turn and wait for the panel to load before extracting.

  // Two grids on this screen share the "data-line" row class: the requests grid
  // (rows id="grid_trace_N", cells col-screenId/col-command/…) and the SQL grid
  // (id="grid_sql_…", cells col-tableList/col-time/…). Only the requests grid
  // drives the messages panel, so every row query has to be narrowed to it.
  function getRequestRows() {
    const rows = Array.from(document.querySelectorAll('tr.data-line'));
    const byId = rows.filter(tr => (tr.id || '').indexOf('grid_trace') === 0);
    if (byId.length > 0) return byId;
    return rows.filter(tr => tr.querySelector('td.col-screenId'));
  }

  // Acumatica marks a failed request with an "error" class on the row and a
  // count in its col-issues cell. Neither is dependable: first-chance
  // exceptions recorded by the profiler (PXFirstChanceExceptionLogger) are
  // attached to a request without failing it, and the issues column is not
  // displayed on every build. So this is a hint used to scan the likely rows
  // first — never a precondition for scanning at all.
  function rowLooksErrored(tr) {
    if (tr.classList.contains('error')) return true;
    if (tr.querySelector('td.col-issues.errors')) return true;
    if (tr.querySelector('qp-icon[imagesrc*="error"], use[href*="error"]')) return true;
    const issues = tr.querySelector('td.col-issues');
    return !!issues && /[1-9]/.test(issues.textContent || '');
  }

  async function waitFor(test, timeout, interval = 120) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (test()) return true;
      await sleep(interval);
    }
    return test();
  }

  // Fingerprint of every trace tab panel (ALL / MESSAGES / EXCEPTIONS / SQL).
  // Selecting a row reloads all four, and the SQL panel differs between
  // requests even when neither has exceptions, so this changes on virtually
  // every row load — which lets the settle wait below exit in a few hundred ms
  // instead of always burning its full timeout. That matters now that every
  // request gets visited.
  //
  // Deliberately scoped to the panels: fingerprinting the whole page would pick
  // up the trace screen's ticking Local/UTC clock in the footer and report a
  // change on every poll while the panel still showed the previous row.
  function panelsSnapshot() {
    const parts = [];
    document.querySelectorAll('messages-panel').forEach(p => parts.push(p.textContent.length));
    // The SQL tab is a master-grid rather than a messages-panel, and it is the
    // part that reliably differs between requests: plenty of requests have no
    // messages and no exceptions, but every one of them runs SQL. Without it
    // the fingerprint would be identical for every quiet request and each one
    // would burn the full settle timeout.
    document
      .querySelectorAll('master-grid[name="sql"]')
      .forEach(g => parts.push(g.textContent.length));
    return parts.join(',');
  }

  function synthClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function clickElementMatching(re) {
    const candidates = Array.from(
      document.body.querySelectorAll('a, button, span, div, li')
    ).filter(el => re.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
    if (candidates.length === 0) return false;
    // querySelectorAll is document order, so nested wrappers sharing the same
    // trimmed text put the innermost element last — click that one.
    synthClick(candidates[candidates.length - 1]);
    return true;
  }

  async function selectRowAndCollect(tr) {
    if (tr.getAttribute('selected') !== 'true') {
      const before = panelsSnapshot();
      synthClick(tr);
      // The row's selected attribute flips as soon as the click registers; the
      // panel content follows once that request's details load.
      await waitFor(() => tr.getAttribute('selected') === 'true', 1500);
      // Bounded settle wait, not a requirement: two consecutive requests can
      // genuinely render identical panels, in which case this times out and we
      // read what is there, which is correct anyway.
      await waitFor(() => panelsSnapshot() !== before, 1500);
    }
    if (findExceptionMessageItems(document.body).length === 0) {
      // Builds that render only the active tab need the EXCEPTIONS tab opened.
      // Its label carries a count when non-zero ("EXCEPTIONS 2"), so an exact
      // text match would miss it in exactly the case that matters.
      if (clickElementMatching(/^EXCEPTIONS(\s+\d+)?$/i)) {
        await waitFor(() => findExceptionMessageItems(document.body).length > 0, 1500);
      }
    }
    await expandAll(document.body);
    return findExceptionMessageItems(document.body).map(extractExceptionCard);
  }

  // ---------- main actions ----------
  async function copyAllExceptions(includeAiPrompt) {
    await expandAll(document.body);

    let bodies;
    let sections = null;   // per-request grouping when we swept the grid
    let scannedCount = 0;  // how many rows that sweep actually visited
    let headerNote = '';   // note emitted when the sweep hit MAX_ROWS_TO_SCAN

    const rows = getRequestRows();

    if (rows.length === 0) {
      // No request grid — a single-request trace screen, or unknown markup.
      // Take whatever is rendered.
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
      bodies = items.map(c =>
        useGenericExtraction ? cleanText(c.innerText || '') : extractExceptionCard(c)
      );
    } else {
      // The details panel only ever shows the selected row's messages, so the
      // only way to see the whole trace is to visit every request in turn —
      // including when something is already on screen, since that is just the
      // one row the user happens to have selected.
      //
      // Row flags are no help in deciding what to skip: an exception logged
      // against a request Acumatica did not treat as failed leaves no flag, and
      // some builds hide the issues column entirely. They are used only to
      // decide which rows make the cut on a grid longer than the cap.
      const toScan =
        rows.length <= MAX_ROWS_TO_SCAN
          ? rows
          : [...rows.filter(rowLooksErrored), ...rows.filter(r => !rowLooksErrored(r))]
              .slice(0, MAX_ROWS_TO_SCAN);
      const previouslySelected = rows.find(r => r.getAttribute('selected') === 'true');

      sections = [];
      const seenBodies = new Set();
      for (let i = 0; i < toScan.length; i++) {
        showToast(`Scanning request ${i + 1} of ${toScan.length} for exceptions…`, 4000);
        // A row whose details load slowly can leave the previous row's panel on
        // screen; dropping bodies already collected from an earlier row keeps
        // that from being reported against the wrong request.
        const rowBodies = (await selectRowAndCollect(toScan[i])).filter(b => {
          if (seenBodies.has(b)) return false;
          seenBodies.add(b);
          return true;
        });
        if (rowBodies.length > 0) {
          sections.push({ ctx: readRowContext(toScan[i]), bodies: rowBodies });
        }
      }
      scannedCount = toScan.length;

      // Put the grid back on whatever the user was looking at.
      if (previouslySelected && previouslySelected.getAttribute('selected') !== 'true') {
        synthClick(previouslySelected);
      }

      bodies = sections.flatMap(s => s.bodies);
      if (bodies.length === 0) {
        showToast(
          `No exceptions found in ${scannedCount} request(s) on this page. Try "Pick element" instead.`,
          6000
        );
        return;
      }
      if (rows.length > toScan.length) {
        headerNote = `Grid has ${rows.length} requests; scanned the first ${toScan.length} (errored rows first).`;
      }
    }

    const count = bodies.length;
    const context = getTraceContext();
    const primaryCtx = sections ? sections[0].ctx : context.primary;

    const headerLines = [`Acumatica Trace — ${count} exception(s)`];
    if (sections) {
      headerLines.push(
        `Scanned ${scannedCount} request(s); ${sections.length} had exceptions`
      );
    }
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

    if (headerNote) headerLines.push(headerNote);

    let bodyText;
    if (sections) {
      let n = 0;
      bodyText = sections
        .map(s => {
          const head = `=== Request — ${formatRowContext(s.ctx) || '(unknown request)'} ===`;
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
