// src/lib/services/forms-tracking/queue.js
//
// Thin shim that lets the Form A screen enqueue ops without
// knowing the internal plumbing of the queue/sync engine.
//
// Design note on "reallocate":
//   A reallocation is decomposed into TWO ops:
//     - form_a.deallocate (remove the old allocation row)
//     - form_a.allocate   (create the new one)
//   Each op carries its own id, so the retry semantics stay clean:
//   if deallocate succeeds and allocate fails, the next drain tick
//   will retry only the allocate. No rollback needed — the user can
//   still see "X forms in the pool" and try again.

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
 * @param {object} body   Full payload for the corresponding endpoint.
 *                        Should include `fingerprint`.
 * @returns {Promise<object>} The persisted op record.
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

  const payload = { ...body };
  if (!payload.op_id) {
    payload.op_id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const op = await enqueue(scope, payload);

  try {
    askServiceWorkerToDrain();
  } catch { /* SW not ready yet */ }

  return op;
}

/**
 * Move forms from one kit to another. Two ops under the hood:
 *   1. Deallocate the old allocation (if any)
 *   2. Allocate to the new kit
 *
 * Either can be a no-op:
 *   - if the old kit has no allocation on this receipt → skip step 1
 *   - if formsToMove is 0 → skip step 2
 *
 * Both ops fire through the normal queue, so the caller gets two
 * op records to wait on.
 *
 * @param {object} args
 *   fingerprint   : device fingerprint
 *   receipt_id    : the receipt being reallocated
 *   from_kit_id   : kit losing forms (may be null → allocate from pool)
 *   to_kit_id     : kit gaining forms
 *   forms_to_move : positive integer
 *   note          : optional note for the new allocation
 * @returns {Promise<{deallocate: object|null, allocate: object|null}>}
 */
export async function reallocate({ fingerprint, receipt_id, from_kit_id, to_kit_id, forms_to_move, note = '' }) {
  const ops = { deallocate: null, allocate: null };

  if (!fingerprint || !receipt_id || !to_kit_id || !(forms_to_move > 0)) {
    throw new Error('reallocate: fingerprint, receipt_id, to_kit_id, and forms_to_move are required.');
  }

  if (from_kit_id && String(from_kit_id) === String(to_kit_id)) {
    throw new Error('reallocate: from_kit_id and to_kit_id must differ.');
  }

  if (from_kit_id) {
    ops.deallocate = await queueAction('form_a.deallocate', {
      fingerprint,
      receipt_id: String(receipt_id),
      kit_id: Number(from_kit_id),
      allocation_amount: Number(forms_to_move),
    });
  }

  ops.allocate = await queueAction('form_a.allocate', {
    fingerprint,
    receipt_id,
    kit_id: to_kit_id,
    forms_allocated: forms_to_move,
    note,
  });

  return ops;
}

/**
 * Convenience wrappers so callers don't have to remember scope strings.
 */
export const FormAQueue = {
  spoil: (payload) => queueAction('form_a.spoil', payload),
  allocate: (payload) => queueAction('form_a.allocate', payload),
  deallocate: (payload) => queueAction('form_a.deallocate', payload),
  reallocate,
};