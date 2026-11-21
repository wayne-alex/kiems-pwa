// src/lib/offline.js
//
// COMPATIBILITY SHIM — bridges the v1 API surface to the v2 core modules.
//
// HomePage.svelte and MovementPage.svelte still import from here. Once they
// are rewritten on top of $lib/core/index.js, DELETE this file.
//
// Functions that used to be sync are now async under the hood. We keep the
// sync signature where callers expect it, and provide async variants for
// callers that can await.

import { Cache, Queue } from './core/db.js';
import {
  enqueue as coreEnqueue,
  pendingCount as corePendingCount,
  getQueueSorted,
  subscribeQueue,
} from './core/queue.js';
import { drainQueue as coreDrainQueue, subscribeSync } from './core/sync.js';

// ── Cache ────────────────────────────────────────────────────
// Old API: cacheGet(key) → value|null (sync)
// Old API: cacheSet(key, value) (sync)
// New API is async. We can't fake sync reads on IDB, so callers that
// need the value should switch to `await cacheGetAsync(key)` (below).
// For sync callers we return null and let them re-fetch from network —
// that was already their fallback path.

export async function cacheGetAsync(key) {
  const row = await Cache.get(key);
  return row ? row.value : null;
}

export function cacheGet(_key) {
  // Deprecated sync read — returns null, triggering network fallback.
  return null;
}

export function cacheSet(key, value) {
  Cache.set(key, value).catch((e) => console.warn('[offline] cacheSet failed:', e));
}

export async function cacheAge(key) {
  return Cache.age(key);
}

// ── Queue ────────────────────────────────────────────────────

export function enqueue(kind, payload) {
  // Async internally; old callers used it fire-and-forget.
  return coreEnqueue(kind, payload).catch((e) =>
    console.warn('[offline] enqueue failed:', e),
  );
}

export function pendingCount() {
  // Sync API expected but core is async. Return 0; UI refreshes via
  // the subscribeQueue path in SyncBadge/SystemSheet which is already
  // correct.
  return 0;
}

export function getQueue() {
  return getQueueSorted();
}

export function dequeue(_id) {
  // No-op shim; the queue engine drains on its own.
}

export function clearQueue() {
  Queue.mutate(() => []).catch(() => {});
}

// ── Sync ─────────────────────────────────────────────────────

export function drainQueue() {
  return coreDrainQueue();
}

export function subscribeOffline(fn) {
  // Old shape was {online, pending, lastSync}
  return subscribeSync((s) => fn({
    online: s.online ?? true,
    pending: s.pending ?? 0,
    lastSync: s.lastSync ?? 0,
  }));
}

export function initOffline() {
  // Superseded by initSync() in App.svelte. No-op to keep old imports working.
}

export function snapshot() {
  return { online: navigator.onLine, pending: 0, lastSync: 0 };
}