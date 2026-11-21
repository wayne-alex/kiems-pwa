import { Queue, OpLog, Meta } from './db.js';
import { OP_KINDS } from './ops.js';

// ── Config ───────────────────────────────────────────────────
export const QUEUE_CONFIG = {
  MAX_ATTEMPTS: 10,
  BASE_BACKOFF_MS: 3000,        // 3s
  MAX_BACKOFF_MS: 5 * 60 * 1000, // 5 min
  OPLOG_KEEP: 200,
};

// ── UID ──────────────────────────────────────────────────────
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ── Content hash for coalescing ──────────────────────────────
// Two entry.submit ops for the same (date, kitset) coalesce: newest wins.
// Same for movement.save, verify.tally. Incidents never coalesce.
function coalesceKey(op) {
  if (op.kind === 'incident.submit') return null;
  const p = op.payload || {};
  switch (op.kind) {
    case 'entry.submit':
      return `entry|${p.fingerprint}|${p.date}|${(p.entries || []).map(e => e.kit_id).sort().join(',')}`;
        case 'movement.save':
      return `movement|${p.ward_id}|${p.schedule_date}|${(p.entries || []).map(e => e.kit_id).sort().join(',')}`;
    case 'verify.tally':
      return `verify|${p.fingerprint}|${p.kit_id}|${p.date}`;
    case 'form_a.allocate':
      return `alloc|${p.receipt_id}|${p.kit_id}`;  // ← new
    default:
      return null;  // form_a.spoil, form_a.deallocate: no coalesce
  }
}

// ── Notifier (subscribers) ───────────────────────────────────
const listeners = new Set();
function notify(patch) {
  // best-effort fire & forget
  snapshot().then((s) => listeners.forEach((fn) => fn(s, patch)));
}
export function subscribeQueue(fn) {
  listeners.add(fn);
  snapshot().then(fn);
  return () => listeners.delete(fn);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Enqueue an op. If a coalescible op with the same key already exists,
 * REPLACE it (same id, so the server-side idempotency key stays stable).
 *
 * Returns the op actually persisted.
 */
export async function enqueue(kind, payload) {
  if (!OP_KINDS[kind]) throw new Error(`Unknown op kind: ${kind}`);

  const base = {
    id: uid(),
    kind,
    payload,
    state: 'queued',
    attempts: 0,
    lastError: null,
    nextRetryAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    priority: OP_KINDS[kind].priority ?? 10,
  };

  const key = coalesceKey(base);

  if (key) {
    const existing = await Queue.all();
    const found = existing.find(
      (o) => o.state !== 'done' && coalesceKey(o) === key,
    );
    if (found) {
      // Coalesce: keep id (idempotency), refresh payload + reset attempts
      const merged = {
        ...found,
        payload,
        state: 'queued',
        attempts: 0,
        lastError: null,
        nextRetryAt: 0,
        updatedAt: Date.now(),
      };
      await Queue.put(merged);
      notify({ kind: 'coalesce', id: found.id, key });
      return merged;
    }
  }

  await Queue.put(base);
  notify({ kind: 'enqueue', id: base.id, kindName: kind });
  return base;
}

/** Remove by id, optionally record in oplog. */
export async function dequeue(id, outcome = null) {
  const op = await Queue.get(id);
  if (!op) return;
  await Queue.del(id);
  if (outcome) {
    await OpLog.put({
      id: op.id,
      kind: op.kind,
      payloadSummary: summarize(op.payload),
      outcome, // 'ok' | 'failed' | 'discarded'
      attempts: op.attempts,
      lastError: op.lastError || null,
      createdAt: op.createdAt,
      finishedAt: Date.now(),
    });
    await OpLog.trim(QUEUE_CONFIG.OPLOG_KEEP);
  }
  notify({ kind: 'dequeue', id, outcome });
}

/** Wipe queue (diagnostics only). */
export async function clearQueue() {
  const all = await Queue.all();
  for (const op of all) await Queue.del(op.id);
  notify({ kind: 'clear' });
}

/** Return queued ops sorted by priority, then createdAt. */
export async function getQueueSorted() {
  const all = await Queue.all();
  return all
    .filter((o) => o.state !== 'done')
    .sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10) || a.createdAt - b.createdAt);
}

/** Count of pending ops (queued + retry + sending). */
export async function pendingCount() {
  const all = await Queue.all();
  return all.filter((o) => o.state !== 'done').length;
}

/**
 * Record a successful attempt:
 * - dequeues + writes oplog
 */
export async function markSuccess(op, verdict) {
  await dequeue(op.id, 'ok');
  await Meta.set('lastSync', Date.now());
  return verdict;
}

/**
 * Record a failed attempt:
 * - bump attempts
 * - compute nextRetryAt with exponential backoff + jitter
 * - if attempts >= MAX or error is non-transient → mark 'gaveup'
 */
export async function markFailure(op, errText, { transient }) {
  const attempts = (op.attempts || 0) + 1;
  const now = Date.now();

  if (!transient) {
    const next = {
      ...op,
      attempts,
      lastError: errText,
      state: 'gaveup',
      updatedAt: now,
    };
    await Queue.put(next);
    notify({ kind: 'giveup', id: op.id, error: errText });
    return next;
  }

  if (attempts >= QUEUE_CONFIG.MAX_ATTEMPTS) {
    const next = {
      ...op,
      attempts,
      lastError: `Gave up after ${attempts} attempts: ${errText}`,
      state: 'gaveup',
      updatedAt: now,
    };
    await Queue.put(next);
    notify({ kind: 'giveup', id: op.id, error: errText });
    return next;
  }

  const base = Math.min(
    QUEUE_CONFIG.MAX_BACKOFF_MS,
    QUEUE_CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempts - 1),
  );
  const jitter = Math.floor(base * 0.3 * Math.random());
  const nextRetryAt = now + base + jitter;

  const next = {
    ...op,
    attempts,
    lastError: errText,
    state: 'retry',
    nextRetryAt,
    updatedAt: now,
  };
  await Queue.put(next);
  notify({ kind: 'retry', id: op.id, nextRetryAt, attempts });
  return next;
}

/** Discard a gaveup op (user action). */
export async function discardOp(id) {
  const op = await Queue.get(id);
  if (!op) return;
  await dequeue(id, 'discarded');
}

/** Retry a gaveup op immediately (user action). */
export async function retryOp(id) {
  const op = await Queue.get(id);
  if (!op) return;
  await Queue.put({
    ...op,
    state: 'queued',
    attempts: 0,
    lastError: null,
    nextRetryAt: 0,
    updatedAt: Date.now(),
  });
  notify({ kind: 'retry-manual', id });
}

// ── Snapshot for UI ──────────────────────────────────────────
export async function snapshot() {
  const all = await Queue.all();
  const pending = all.filter((o) => o.state !== 'done');
  const retrying = pending.filter((o) => o.state === 'retry');
  const gaveup = pending.filter((o) => o.state === 'gaveup');
  const lastSync = (await Meta.get('lastSync', 0)) || 0;
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  return {
    online,
    pending: pending.length,
    retrying: retrying.length,
    gaveup: gaveup.length,
    lastSync,
    ops: all,
  };
}

function summarize(payload) {
  try {
    if (payload == null) return null;
    const clone = { ...payload };
    if (clone.photo instanceof Blob) clone.photo = `<Blob ${clone.photo.size}b>`;
    return clone;
  } catch {
    return null;
  }
}