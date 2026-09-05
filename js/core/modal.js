// ==========================================================================
// Finora — core/modal.js
// Every floating panel gets: title, sections, primary + secondary action,
// a clear close control, mobile-friendly width (21 - UI/UX Design System).
// ==========================================================================

let activeScrim = null;

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
    <div class="modal${sizeClass}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer"></div>
    </div>
  `;

  document.body.appendChild(scrim);
  activeScrim = scrim;

  const footer = scrim.querySelector('.modal-footer');
  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.className = `btn ${action.variant || 'btn-secondary'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => action.onClick(closeModal, scrim));
    footer.appendChild(btn);
  });

  scrim.querySelector('.modal-close').addEventListener('click', closeModal);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
  document.addEventListener('keydown', onEscape);

  if (onMount) onMount(scrim);

  return closeModal;
}

function onEscape(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  if (activeScrim) {
    activeScrim.remove();
    activeScrim = null;
    document.removeEventListener('keydown', onEscape);
  }
}

/** Simple confirm dialog built on the same modal component. */
export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary', onClick: (close) => { close(); resolve(true); } },
      ],
    });
  });
}
