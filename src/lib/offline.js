// src/lib/offline.js
import { apiFetch } from './api.js';

const CACHE_PREFIX = 'iebc:cache:';
const QUEUE_KEY = 'iebc:queue:ops';
const META_KEY = 'iebc:queue:meta';

// ═══════════════════════════════════════════════════════════
// CACHE — last successful fetch per (ward, date) or (ward)
// ═══════════════════════════════════════════════════════════

export function cacheSet(key, value) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ ts: Date.now(), value })
    );
  } catch (e) {
    console.warn('[offline] cache write failed:', e);
  }
}

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.value;
  } catch {
    return null;
  }
}

export function cacheAge(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return Date.now() - JSON.parse(raw).ts;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// QUEUE — pending operations awaiting sync
// ═══════════════════════════════════════════════════════════

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeQueue(ops) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(ops));
  } catch (e) {
    console.warn('[offline] queue write failed:', e);
  }
  notify();
}

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : { lastSync: 0 };
  } catch {
    return { lastSync: 0 };
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* ignore */ }
  notify();
}

/** Generate a short unique id. */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Add an operation to the queue.
 *
 * @param {string} kind   — 'entry.submit' | 'movement.save'
 * @param {object} payload — shape depends on kind, see `runOp` below
 * @returns {object} the queued op
 */
export function enqueue(kind, payload) {
  const op = {
    id: uid(),
    kind,
    payload,
    ts: Date.now(),
    attempts: 0,
    lastError: null,
  };
  const ops = readQueue();
  ops.push(op);
  writeQueue(ops);
  return op;
}

/** Get a snapshot of the current queue. */
export function getQueue() {
  return readQueue();
}

/** Remove an op by id. */
export function dequeue(id) {
  const ops = readQueue().filter((o) => o.id !== id);
  writeQueue(ops);
}

/** Wipe the entire queue (use only for diagnostics). */
export function clearQueue() {
  writeQueue([]);
  writeMeta({ lastSync: 0 });
}

/** Convenience: how many ops are pending. */
export function pendingCount() {
  return readQueue().length;
}

// ═══════════════════════════════════════════════════════════
// EXECUTORS — turn an op into a real HTTP request
// ═══════════════════════════════════════════════════════════

async function runOp(op) {
  switch (op.kind) {
    case 'entry.submit': {
      const body = new URLSearchParams();
      body.append('fingerprint', op.payload.fingerprint);
      body.append('date', op.payload.date);
      op.payload.entries.forEach((e) => {
        body.append('kit_id[]', e.kit_id);
        body.append('venue[]', e.venue);
        body.append('registered_male[]', String(e.male || 0));
        body.append('registered_female[]', String(e.female || 0));
      });
      return apiFetch('/kiems/submit-entries/', { method: 'POST', body });
    }

    case 'movement.save': {
      return apiFetch('/movement/save/', {
        method: 'POST',
        json: {
          ward_id: op.payload.ward_id,
          fingerprint: op.payload.fingerprint,
          schedule_date: op.payload.schedule_date,
          entries: op.payload.entries,
        },
      });
    }

    default:
      throw new Error(`Unknown op kind: ${op.kind}`);
  }
}

// ═══════════════════════════════════════════════════════════
// SYNC — drain the queue
// ═══════════════════════════════════════════════════════════

let syncing = false;

/**
 * Attempt to send every queued op.
 * Returns { sent, failed, stillQueued }.
 */
export async function drainQueue() {
  if (syncing) return { sent: 0, failed: 0, stillQueued: pendingCount() };
  if (!navigator.onLine) {
    return { sent: 0, failed: 0, stillQueued: pendingCount() };
  }
  syncing = true;

  const ops = readQueue();
  const remaining = [];
  let sent = 0;
  let failed = 0;

  for (const op of ops) {
    try {
      const res = await runOp(op);

      // App-level success check: {ok: true} means done.
      if (res && res.ok) {
        sent++;
        continue;
      }

      // App-level failure that isn't network-related → retry-able but
      // don't spam. Bump attempts and keep in queue.
      op.attempts += 1;
      op.lastError = (res && res.error) || 'Server rejected';
      if (op.attempts < 10) {
        remaining.push(op);
      } else {
        // Give up but keep so the user can inspect
        failed++;
        remaining.push({ ...op, givenUp: true });
      }
    } catch (e) {
      // Network error — keep in queue.
      op.attempts += 1;
      op.lastError = e.message || 'Network error';
      remaining.push(op);
    }
  }

  writeQueue(remaining);
  if (sent > 0) {
    writeMeta({ ...readMeta(), lastSync: Date.now() });
  }
  syncing = false;

  return { sent, failed, stillQueued: remaining.length };
}

// ═══════════════════════════════════════════════════════════
// REACTIVE NOTIFIER — subscribers get told when state changes
// ═══════════════════════════════════════════════════════════

const listeners = new Set();

export function subscribeOffline(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

function notify() {
  const s = snapshot();
  listeners.forEach((fn) => fn(s));
}

export function snapshot() {
  return {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    pending: pendingCount(),
    lastSync: readMeta().lastSync,
  };
}

// ═══════════════════════════════════════════════════════════
// LIFECYCLE — auto-retry hooks (call once from App.svelte)
// ═══════════════════════════════════════════════════════════

let initialized = false;

export function initOffline() {
  if (initialized) return;
  initialized = true;

  window.addEventListener('online', () => {
    notify();
    drainQueue();
  });

  window.addEventListener('offline', () => {
    notify();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      drainQueue();
    }
  });

  // Periodic background retry while queue non-empty
  setInterval(() => {
    if (pendingCount() > 0 && navigator.onLine) {
      drainQueue();
    }
  }, 30_000);

  // Best-effort drain at boot
  drainQueue();
}