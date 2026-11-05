/*! WhisperLink OSS — small CSP-safe page helpers (no inline handlers).
 * Author: Antonio Brandao
 * License: MIT
 */
document.querySelectorAll('.wave i').forEach((el, i) => el.style.setProperty('--i', i));
document.querySelectorAll('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
document.querySelectorAll('.flash').forEach((f) => setTimeout(() => f.classList.add('fade'), 6000));
