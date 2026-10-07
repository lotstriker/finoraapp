// ==========================================================================
// Finora — utils/dom.js
// ==========================================================================

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Minimal HTML-escaping for interpolating user text into template strings. */
export function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Formats an ISO date string as "12 Sep 2026". */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Makes a clickable non-<a>/<button> element (e.g. a `.list-row` or
 * `.card` used as a row) keyboard-accessible: adds role="button" +
 * tabindex="0", and fires `handler` on click OR Enter/Space, matching
 * native button behavior.
 */
export function bindRowActivation(el, handler) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('click', handler);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  });
}

/**
 * Renders numbered pagination (‹ 1 2 3 … 10 ›) into `el` and wires clicks.
 * @param {HTMLElement} el container to render into
 * @param {number} page current page (1-based)
 * @param {number} totalPages
 * @param {(newPage: number) => void} onChange called with the new page number
 */
export function renderPagination(el, page, totalPages, onChange) {
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const pages = [1];
  if (page > 3) pages.push('...');
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) pages.push(p);
  if (page < totalPages - 2) pages.push('...');
  if (totalPages > 1) pages.push(totalPages);
  const deduped = pages.filter((p, i) => p !== pages[i - 1]);

  el.innerHTML = `
    <div class="pagination">
      <button class="page-btn" data-page="prev" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      ${deduped.map((p) => p === '...'
        ? `<span class="page-ellipsis">…</span>`
        : `<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`
      ).join('')}
      <button class="page-btn" data-page="next" ${page === totalPages ? 'disabled' : ''} aria-label="Next page">›</button>
    </div>
  `;

  el.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.page;
      if (val === 'prev') onChange(page - 1);
      else if (val === 'next') onChange(page + 1);
      else onChange(Number(val));
    });
  });
}

/**
 * Deep-link support for the topbar "Quick add" menu: "#/expenses?add=1" opens that
 * page's Add modal. Returns true (and strips the flag from the URL, so a refresh or
 * Back doesn't re-open the modal) when the flag is present.
 */
export function consumeAddParam(params, routeKey) {
  if (params?.get?.('add') !== '1') return false;
  history.replaceState(null, '', `#/${routeKey}`);
  return true;
}

/**
 * Makes a row of `.tab-btn` buttons a proper WAI-ARIA tabs widget: roles, aria-selected,
 * aria-controls, roving tabindex and Left/Right/Home/End keys. Call it AFTER the page has
 * attached its own click handlers (it only adds attributes and a keyboard layer).
 * Convention used by Finora's pages: button[data-tab="x"] controls element #tab-x.
 */
export function enhanceTabs(root) {
  const buttons = [...root.querySelectorAll('.tab-btn')];
  if (buttons.length === 0) return;
  buttons[0].parentElement.setAttribute('role', 'tablist');
  const select = (btn) => {
    buttons.forEach((b) => {
      const on = b === btn;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  buttons.forEach((btn) => {
    const key = btn.dataset.tab;
    btn.setAttribute('role', 'tab');
    btn.id = btn.id || `tabbtn-${key}`;
    btn.setAttribute('aria-controls', `tab-${key}`);
    const panel = root.querySelector(`#tab-${key}`);
    if (panel) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', btn.id); }
    btn.addEventListener('click', () => select(btn));
    btn.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(btn);
      const next = { ArrowRight: buttons[(i + 1) % buttons.length], ArrowLeft: buttons[(i - 1 + buttons.length) % buttons.length], Home: buttons[0], End: buttons[buttons.length - 1] }[e.key];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.click();
    });
  });
  select(buttons.find((b) => b.classList.contains('active')) || buttons[0]);
}
