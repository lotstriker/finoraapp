// ==========================================================================
// Finora — core/toast.js
// Custom Toast notifications. Never expose raw technical errors here —
// callers must pass a user-friendly message (see 21 - UI/UX, 22 - Validation).
// ==========================================================================

const ICONS = {
  success: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4L8.5 12l6.8-6.8a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>',
  error: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.7 7.3a1 1 0 011.4 0l0 0 1.9 1.9 1.9-1.9a1 1 0 111.4 1.4L11.4 10.6l1.9 1.9a1 1 0 11-1.4 1.4l-1.9-1.9-1.9 1.9a1 1 0 01-1.4-1.4l1.9-1.9-1.9-1.9a1 1 0 010-1.4z" clip-rule="evenodd"/></svg>',
  warning: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.3 3.3c.7-1.2 2.7-1.2 3.4 0l6.5 11.4a2 2 0 01-1.7 3H3.5a2 2 0 01-1.7-3L8.3 3.3zM10 7a1 1 0 011 1v3a1 1 0 11-2 0V8a1 1 0 011-1zm0 7a1.1 1.1 0 100 2.2A1.1 1.1 0 0010 14z" clip-rule="evenodd"/></svg>',
  info: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zM9 8a1 1 0 112 0v5a1 1 0 11-2 0V8zm1-3a1.1 1.1 0 100 2.2A1.1 1.1 0 0010 5z" clip-rule="evenodd"/></svg>',
};

let stackEl = null;

function ensureStack() {
  if (!stackEl) {
    stackEl = document.createElement('div');
    stackEl.className = 'toast-stack';
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

/**
 * @param {string} message user-friendly text — never a raw db/technical error
 * @param {'success'|'error'|'warning'|'info'} [type]
 * @param {number} [duration] ms before auto-dismiss
 */
export function showToast(message, type = 'info', duration = 4000) {
  const stack = ensureStack();
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[type] || ICONS.info}</span><span>${message}</span>`;
  stack.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 160ms ease';
    setTimeout(() => el.remove(), 180);
  }, duration);
}

export const toast = {
  success: (msg, d) => showToast(msg, 'success', d),
  error: (msg, d) => showToast(msg, 'error', d),
  warning: (msg, d) => showToast(msg, 'warning', d),
  info: (msg, d) => showToast(msg, 'info', d),
};
