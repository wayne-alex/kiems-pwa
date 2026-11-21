import { writable } from 'svelte/store';

export const swState = writable({
  registered: false,
  updateReady: false,
  waiting: null,
  pushSupported: false,
  bgSyncSupported: false,
  controller: null,
});

let reg = null;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    swState.update((s) => ({ ...s, registered: false }));
    return null;
  }

  // ── Dev guard ──────────────────────────────────────────
  // Vite serves src/sw.js as an unbundled ES module in dev.
  // Bare imports like 'workbox-precaching' don't resolve in
  // native ESM → registration fails with a MIME/module error.
  // Only register the SW in production builds where Vite bundles it.
  if (import.meta.env.DEV) {
    console.info('[sw] dev mode — skip registration (test with npm run preview)');
    return null;
  }

  try {
    reg = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
    swState.update((s) => ({
      ...s,
      registered: true,
      pushSupported: 'PushManager' in window && 'Notification' in window,
      bgSyncSupported: 'sync' in reg,
      controller: navigator.serviceWorker.controller,
    }));

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          swState.update((s) => ({ ...s, updateReady: true, waiting: installing }));
        }
      });
    });

    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });

    return reg;
  } catch (e) {
    console.warn('[sw] register failed:', e);
    return null;
  }
}



export async function applyUpdate() {
  const { waiting } = getState();
  if (!waiting) return;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Register the Background Sync tag; called whenever we enqueue. */
export async function registerDrainTag() {
  if (!reg || !('sync' in reg)) return;
  try {
    await reg.sync.register('drain-queue');
  } catch { /* some browsers require user gesture; harmless */ }
}

/** Register Periodic Sync if supported. Runs every 15m (Chromium). */
export async function registerPeriodicDrain() {
  if (!reg || !('periodicSync' in reg)) return;
  try {
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') return;
    await reg.periodicSync.register('periodic-drain', { minInterval: 15 * 60 * 1000 });
  } catch { /* ignore */ }
}

/** Ask the SW to drain right now. */
export async function askSwToDrain() {
  const c = navigator.serviceWorker.controller;
  c?.postMessage({ type: 'drain-queue' });
}

function getState() {
  let s;
  swState.subscribe((v) => (s = v))();
  return s;
}