// ==========================================================================
// Finora — core/modal.js
// Every floating panel gets: title, sections, primary + secondary action,
// a clear close control, mobile-friendly width (21 - UI/UX Design System).
// ==========================================================================

let activeScrim = null;
let previouslyFocused = null;
let modalSeq = 0;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.bodyHtml
 * @param {'sm'|'md'|'lg'|'xl'} [opts.size] default 'sm' (440px) — use 'lg'/'xl' for detail views with a lot of content (Committee, Loan, Account, People)
 * @param {{label: string, variant?: string, onClick: (close: () => void, root: HTMLElement) => void}[]} [opts.actions]
 * @param {(root: HTMLElement) => void} [opts.onMount] called after the modal is in the DOM, for wiring inputs
 * @returns {() => void} a close() function
 */
export function openModal({ title, bodyHtml, actions = [], onMount, size = 'sm' }) {
  closeModal(); // only one modal at a time

  const sizeClass = size !== 'sm' ? ` modal-${size}` : '';
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  scrim.innerHTML = `
    <div class="modal${sizeClass}" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2></h2>
        <button class="modal-close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-error" role="alert" hidden></div>
      <div class="modal-footer"></div>
    </div>
  `;

  // Title is ALWAYS plain text: account/person/goal names flow into titles, and
  // setting them via textContent means a name like <img onerror=...> can never run.
  const dialogEl = scrim.querySelector('.modal');
  const titleEl = scrim.querySelector('.modal-header h2');
  titleEl.textContent = String(title ?? '');
  titleEl.id = `modal-title-${++modalSeq}`;
  dialogEl.setAttribute('aria-labelledby', titleEl.id);

  previouslyFocused = document.activeElement;
  document.body.appendChild(scrim);
  activeScrim = scrim;

  const footer = scrim.querySelector('.modal-footer');
  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.className = `btn ${action.variant || 'btn-secondary'}`;
    btn.textContent = action.label;
    // Lock the button while the (usually async) handler runs, so a fast
    // double-click can never fire the same money action twice. Re-enabled
    // afterwards so validation errors can be fixed and re-submitted.
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      clearModalError();
      try {
        await action.onClick(closeModal, scrim);
      } finally {
        btn.disabled = false;
      }
    });
    footer.appendChild(btn);
  });

  scrim.querySelector('.modal-close').addEventListener('click', closeModal);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
  document.addEventListener('keydown', onKeydown);

  if (onMount) onMount(scrim);

  // Move focus into the dialog (first field, else the first button).
  const first = scrim.querySelector('input, select, textarea, .modal-footer button') || scrim.querySelector('.modal-close');
  first?.focus();

  return closeModal;
}

/**
 * Shows an error INSIDE the open dialog, right above its buttons (and announces it to
 * screen readers), instead of a toast at the screen corner that is easy to miss and
 * disappears. Returns false when no dialog is open so the caller can fall back to a toast.
 */
export function showModalError(message) {
  const el = activeScrim?.querySelector('.modal-error');
  if (!el) return false;
  el.textContent = String(message ?? '');
  el.hidden = false;
  el.scrollIntoView?.({ block: 'nearest' });
  return true;
}

export function clearModalError() {
  const el = activeScrim?.querySelector('.modal-error');
  if (el) { el.textContent = ''; el.hidden = true; }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKeydown(e) {
  if (e.key === 'Escape') { closeModal(); return; }
  // Focus trap: Tab / Shift+Tab cycle inside the open dialog.
  if (e.key === 'Tab' && activeScrim) {
    const items = [...activeScrim.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    else if (!activeScrim.contains(document.activeElement)) { e.preventDefault(); firstEl.focus(); }
  }
}

export function closeModal() {
  if (activeScrim) {
    activeScrim.remove();
    activeScrim = null;
    document.removeEventListener('keydown', onKeydown);
    // Give focus back to whatever opened the dialog.
    if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus?.();
    previouslyFocused = null;
  }
}

/** Simple confirm dialog built on the same modal component. */
export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: '<p class="confirm-message"></p>',
      onMount: (root) => { root.querySelector('.confirm-message').textContent = String(message ?? ''); },
      actions: [
        { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary', onClick: (close) => { close(); resolve(true); } },
      ],
    });
  });
}
