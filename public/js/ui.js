export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Small, polite notification at the top of the screen. */
export function toast(text, { timeout = 3600 } = {}) {
  const host = $('#toasts');
  if (!host) return;
  // Don't stack the same message twice.
  for (const existing of host.children) if (existing.textContent === text) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, timeout);
}

/**
 * Opens a <dialog> modally and resolves with the value of the button that
 * closed it ('' when dismissed with Esc or a click on the backdrop).
 */
export function openDialog(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    if (!dialog.open) dialog.showModal();
  });
}

// Close dialogs when the backdrop is clicked.
document.addEventListener('click', (event) => {
  const dialog = event.target;
  if (dialog instanceof HTMLDialogElement && dialog.open) {
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) dialog.close('');
  }
});
