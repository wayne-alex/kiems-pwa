import { writable } from 'svelte/store';

/**
 * The current route. One of: 'home' | 'entry' | 'movement'
 * Backed by the browser's history stack so the OS back button
 * (and the browser back button) navigate between routes.
 */
export const route = writable('home');

/** Map a route id to its URL path. */
function routeToPath(r) {
  if (r === 'home') return '/';
  return `/${r}`;
}

/** Map a URL path back to a route id (for popstate restore). */
function pathToRoute(path) {
  const clean = (path || '/').replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '') return 'home';
  if (clean === '/entry') return 'entry';
  if (clean === '/movement') return 'movement';
  return 'home';
}

/**
 * Navigate to a route. Pushes a new entry onto browser history so
 * the back button works. Idempotent — no-op if you're already there.
 */
export function navigate(next) {
  let current;
  route.subscribe((r) => (current = r))();

  if (next === current) return;

  history.pushState({ route: next }, '', routeToPath(next));
  route.set(next);
}

/** Replace the current history entry (used for the initial seed). */
export function replaceRoute(next) {
  history.replaceState({ route: next }, '', routeToPath(next));
  route.set(next);
}

/**
 * Attach the popstate listener. Returns a teardown function.
 * Call once from App.svelte's onMount.
 */
export function initNav() {
  const handler = (e) => {
    const r = e.state?.route || pathToRoute(window.location.pathname);
    route.set(r);
  };
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}

/** Read the current route synchronously. */
export function getRoute() {
  let r;
  route.subscribe((v) => (r = v))();
  return r;
}