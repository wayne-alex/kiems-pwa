// src/lib/services/forms-tracking/queue.js
//
// Thin shim that lets the Form A screen enqueue ops without
// knowing the internal plumbing of the queue/sync engine.
//
// The actual storage lives in `$lib/core/queue.js` (IndexedDB-backed,
// with coalescing + backoff), and the actual HTTP execution lives in
// `$lib/core/ops.js` (registered in OP_KINDS).
//
// This module just:
//   1. Validates the scope name against what the server supports.
//   2. Calls enqueue() on the storage layer.
//   3. Kicks the drain loop so the op fires immediately when online.

import { enqueue } from '$lib/core/queue.js';
import { askServiceWorkerToDrain } from '$lib/core/sync.js';

const ALLOWED_SCOPES = [
  'form_a.spoil',
  'form_a.allocate',
  'form_a.deallocate',
];

/**
 * Enqueue a Form A mutation.
 *
 * @param {string} scope  One of ALLOWED_SCOPES.
 *                        Must match OP_KINDS in $lib/core/ops.js,
 *                        and the server-side with_idempotency scope.
 * @param {object} body   Full payload for the corresponding endpoint.
 *                        Should include `fingerprint`, and optionally
 *                        `op_id` (the enqueue layer will also generate one).
 *
 * @returns {Promise<object>} The persisted op record, including:
 *   - id           (used as the Idempotency-Key header on drain)
 *   - kind         (echoes `scope`)
 *   - payload      (echoes `body`, plus injected op_id)
 *   - state        ('queued')
 *   - createdAt    (ms epoch)
 */
export async function queueAction(scope, body) {
  if (!ALLOWED_SCOPES.includes(scope)) {
    throw new Error(
      `queueAction: unknown Form A scope "${scope}". ` +
        `Allowed: ${ALLOWED_SCOPES.join(', ')}`,
    );
  }

  if (!body || typeof body !== 'object') {
    throw new Error('queueAction: body must be a plain object.');
  }

  // Ensure the payload has an op_id for the server-side client_op_id audit
  // column. If the caller didn't provide one, generate a short ID here.
  // (The queue layer also generates op.id independently for Idempotency-Key;
  // that's intentional — one is for the audit trail, one is for dedupe.)
  const payload = { ...body };
  if (!payload.op_id) {
    payload.op_id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Persist to IndexedDB queue (handles coalescing + backoff internally).
  const op = await enqueue(scope, payload);

  // Try to kick the drain immediately — the op will likely fire right away
  // if the device is online. If offline, this is a no-op and the online
  // event (or the 30s sweep in initSync) will pick it up later.
  try {
    askServiceWorkerToDrain();
  } catch {
    // Best-effort. Non-fatal if the SW isn't registered yet.
  }

  return op;
}

/**
 * Convenience wrappers so callers don't have to remember scope strings.
 * They also make grep-ing for "where is spoil enqueued?" trivial.
 */
export const FormAQueue = {
  spoil: (payload) => queueAction('form_a.spoil', payload),
  allocate: (payload) => queueAction('form_a.allocate', payload),
  deallocate: (payload) => queueAction('form_a.deallocate', payload),
};