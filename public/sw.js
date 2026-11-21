// src/sw.js
// Service worker. Built by vite-plugin-pwa (injectManifest strategy).
// Runs in the SW context — no window, no DOM, but full access to IDB,
// fetch, and self.clients.

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// Pure, DOM-free project modules — safe in SW context.
import { executeOp } from './lib/core/ops.js';
import { Queue, OpLog, Meta, Errors } from './lib/core/db.js';

// ──────────────────────────────────────────────────────────────
// 1. Precache app shell
// ──────────────────────────────────────────────────────────────
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ──────────────────────────────────────────────────────────────
// 2. Runtime caching
// ──────────────────────────────────────────────────────────────
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    (url.pathname.startsWith('/kiems/') ||
      url.pathname.startsWith('/movement/') ||
      url.pathname.startsWith('/api/')),
  new NetworkFirst({
    cacheName: 'iebc-api',
    networkTimeoutSeconds: 4,
    plugins: [
      new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 }),
    ],
  }),
);

registerRoute(
  ({ url }) => /tile\.openstreetmap\.org/.test(url.host),
  new StaleWhileRevalidate({
    cacheName: 'osm-tiles',
    plugins: [
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 14 }),
    ],
  }),
);

// ──────────────────────────────────────────────────────────────
// 3. Message channel from page
// ──────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'drain-queue') event.waitUntil(drainQueue('message'));
  if (msg.type === 'ping') event.source?.postMessage({ type: 'pong', at: Date.now() });
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ──────────────────────────────────────────────────────────────
// 4. Background Sync — the whole point of goal #6
// ──────────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'drain-queue') {
    event.waitUntil(drainQueue('background-sync'));
  }
});

// ──────────────────────────────────────────────────────────────
// 5. Periodic Sync (Chromium)
// ──────────────────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'periodic-drain') {
    event.waitUntil(drainQueue('periodicsync'));
  }
});

// ──────────────────────────────────────────────────────────────
// 6. Drain implementation — SW-local mirror of sync.js
// ──────────────────────────────────────────────────────────────
let _draining = false;

async function drainQueue(source = 'sw') {
  if (_draining) return;
  _draining = true;
  const startedAt = Date.now();
  let sent = 0;
  let failed = 0;

  try {
    const all = await Queue.all();
    const ops = all
      .filter((o) => o.state !== 'done' && o.state !== 'gaveup')
      .sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10) || a.createdAt - b.createdAt);

    for (const op of ops) {
      if (op.state === 'retry' && op.nextRetryAt > Date.now()) continue;

      let verdict;
      try {
        verdict = await executeOp(op);
      } catch (e) {
        verdict = { ok: false, error: e.message, transient: true };
      }

      if (verdict.ok) {
        await Queue.del(op.id);
        await OpLog.put({
          id: op.id,
          kind: op.kind,
          outcome: 'ok',
          attempts: op.attempts || 0,
          createdAt: op.createdAt,
          finishedAt: Date.now(),
          via: source,
        });
        sent++;
      } else {
        const attempts = (op.attempts || 0) + 1;
        if (!verdict.transient || attempts >= 10) {
          await Queue.put({
            ...op,
            attempts,
            lastError: verdict.error || 'Failed',
            state: 'gaveup',
            updatedAt: Date.now(),
          });
          failed++;
        } else {
          const base = Math.min(5 * 60_000, 3000 * Math.pow(2, attempts - 1));
          const nextRetryAt = Date.now() + base + Math.floor(base * 0.3 * Math.random());
          await Queue.put({
            ...op,
            attempts,
            lastError: verdict.error || 'Retry',
            state: 'retry',
            nextRetryAt,
            updatedAt: Date.now(),
          });
        }
        if (verdict.auth) break;
      }
    }

    if (sent > 0) await Meta.set('lastSync', Date.now());
    await OpLog.trim(200);

    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) {
      c.postMessage({
        type: 'SYNC_DONE',
        source,
        sent,
        failed,
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      const remaining = await Queue.all();
      await fetch('/api/sync/event/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sent,
          failed,
          still_queued: remaining.filter((o) => o.state !== 'done').length,
          duration_ms: Date.now() - startedAt,
          app_version: 'v2-sw',
        }),
      });
    } catch { /* ignore */ }
  } catch (err) {
    await Errors.log(err, { where: 'sw.drainQueue', source });
  } finally {
    _draining = false;
  }

  return { sent, failed };
}

// ──────────────────────────────────────────────────────────────
// 7. Push — full reminder logic comes later
// ──────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = {}; }

  const title = data.title || 'KIEMS';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: data.url || '/' },
    tag: data.tag || 'kiems-default',
    renotify: !!data.renotify,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        c.postMessage({ type: 'NAVIGATE', url: target });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.subscribe(event.oldSubscription.options);
      await fetch('/api/push/subscribe/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch (e) {
      await Errors.log(e, { where: 'pushsubscriptionchange' });
    }
  })());
});