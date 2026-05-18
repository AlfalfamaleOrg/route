/**
 * Content script for Google Maps. When the current URL refers to a saved
 * list (matched by `!2s<id>!3e3` in the data path, or by /placelists/list/<id>),
 * injects a floating "Optimaliseer route" button that opens the list in
 * route.vdhout.cc.
 *
 * Google Maps is a single-page app, so the URL changes without a full page
 * reload. A MutationObserver re-runs the check whenever the DOM mutates.
 */

const ROUTE_APP = 'https://route.vdhout.cc/';
const BUTTON_ID = 'route-vdhout-button';

/**
 * Tries to find a Google Maps list ID in the given URL.
 *
 * @param {string} url
 * @returns {string|null}
 */
function getListId(url) {
  let m = url.match(/!2s([A-Za-z0-9_-]+)!3e3/);
  if (m) return m[1];
  m = url.match(/\/placelists\/list\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

/**
 * Adds or removes the floating button based on whether the current URL
 * looks like a list.
 *
 * @returns {void}
 */
function syncButton() {
  const id = getListId(location.href);
  const existing = document.getElementById(BUTTON_ID);
  if (!id) {
    if (existing) existing.remove();
    return;
  }
  if (existing) {
    existing.dataset.listId = id;
    existing.href = `${ROUTE_APP}?list=${encodeURIComponent(location.href)}`;
    return;
  }
  const a = document.createElement('a');
  a.id = BUTTON_ID;
  a.href = `${ROUTE_APP}?list=${encodeURIComponent(location.href)}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.dataset.listId = id;
  a.title = 'Open deze lijst in route.vdhout.cc';
  a.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="10" r="3"/>
      <path d="M12 2a8 8 0 0 0-8 8c0 5.5 8 12 8 12s8-6.5 8-12a8 8 0 0 0-8-8z"/>
    </svg>
    <span>Optimaliseer route</span>`;
  document.body.appendChild(a);
}

syncButton();

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    syncButton();
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('popstate', syncButton);
window.addEventListener('pushstate', syncButton);
