import { apiUrl } from '../config.js';

// ── Op kinds registry ────────────────────────────────────────
// Each kind: { priority, buildRequest(payload), interpretResponse(data) }
// `buildRequest` returns { url, init } — SW-compatible.

export const OP_KINDS = {
  'entry.submit': {
    priority: 10, // normal
    buildRequest(payload) {
      const body = new URLSearchParams();
      body.append('fingerprint', payload.fingerprint);
      body.append('date', payload.date);
      for (const e of payload.entries) {
        body.append('kit_id[]', e.kit_id);
        body.append('venue[]', e.venue);
        body.append('registered_male[]', String(e.male || 0));
        body.append('registered_female[]', String(e.female || 0));
      }
      return {
        url: apiUrl('/kiems/submit-entries/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) return { ok: true, saved: data.saved || 0 };
      return { ok: false, error: (data && data.error) || 'Server rejected' };
    },
  },

  'movement.save': {
    priority: 10,
    buildRequest(payload) {
      return {
        url: apiUrl('/movement/save/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ward_id: payload.ward_id,
            fingerprint: payload.fingerprint,
            schedule_date: payload.schedule_date,
            entries: payload.entries,
          }),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) {
        return { ok: true, saved: (data.created || 0) + (data.updated || 0) };
      }
      return { ok: false, error: (data && data.error) || 'Server rejected' };
    },
  },

  'verify.tally': {
    priority: 5,
    buildRequest(payload) {
      return {
        url: apiUrl('/api/verify-tally/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) return { ok: true, result: data };
      return { ok: false, error: (data && data.error) || 'Verify failed' };
    },
  },

  'incident.submit': {
    priority: 1, // HIGHEST — incidents drain first
    buildRequest(payload) {
      const fd = new FormData();
      fd.append('fingerprint', payload.fingerprint || '');
      fd.append('kind', payload.kind);
      fd.append('severity', payload.severity || 'MEDIUM');
      fd.append('ward_id', payload.ward_id);
      if (payload.kit_id) fd.append('kit_id', payload.kit_id);
      if (payload.description) fd.append('description', payload.description);
      if (payload.lat != null) fd.append('lat', String(payload.lat));
      if (payload.lng != null) fd.append('lng', String(payload.lng));
      if (payload.accuracy != null) fd.append('accuracy', String(payload.accuracy));
      if (payload.photo instanceof Blob) {
        fd.append('photo', payload.photo, payload.photo_name || 'incident.webp');
      }
      if (payload.op_id) fd.append('op_id', payload.op_id);
      return {
        url: apiUrl('/api/incidents/'),
        init: {
          method: 'POST',
          body: fd,
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) return { ok: true, id: data.incident_id };
      return { ok: false, error: (data && data.error) || 'Incident submit failed' };
    },
  },

  // ═══════════════════════════════════════════════════════════
  // FORM A / ACKNOWLEDGMENT
  // ═══════════════════════════════════════════════════════════

  'form_a.spoil': {
    // Slightly above allocate — a spoilage is a loss event, get it in first.
    priority: 4,
    buildRequest(payload) {
      return {
        url: apiUrl('/api/form-a/report-spoil/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: payload.fingerprint,
            receipt_id: payload.receipt_id,
            kit_id: payload.kit_id ?? null,
            serial_number: payload.serial_number,
            date: payload.date,
            reason: payload.reason || 'OTHER',
            note: payload.note || '',
            op_id: payload.op_id || '',
          }),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) {
        return {
          ok: true,
          spoilage_id: data.spoilage_id,
          remaining: data.remaining,
        };
      }
      return { ok: false, error: (data && data.error) || 'Spoilage failed' };
    },
  },

  'form_a.allocate': {
    priority: 5,
    buildRequest(payload) {
      return {
        url: apiUrl('/api/form-a/allocate/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: payload.fingerprint,
            receipt_id: payload.receipt_id,
            kit_id: payload.kit_id,
            forms_allocated: payload.forms_allocated,
            note: payload.note || '',
            op_id: payload.op_id || '',
          }),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) {
        return {
          ok: true,
          allocation_id: data.allocation_id,
          created: !!data.created,
          unallocated: data.unallocated,
        };
      }
      return { ok: false, error: (data && data.error) || 'Allocation failed' };
    },
  },

  'form_a.deallocate': {
    priority: 5,
    buildRequest(payload) {
      return {
        url: apiUrl('/api/form-a/deallocate/'),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: payload.fingerprint,
            allocation_id: payload.allocation_id,
            op_id: payload.op_id || '',
          }),
          credentials: 'include',
        },
      };
    },
    interpretResponse(data) {
      if (data && data.ok) {
        return { ok: true, deleted: true, kit_name: data.kit_name };
      }
      return { ok: false, error: (data && data.error) || 'Deallocation failed' };
    },
  },
};

// ── CSRF helper (works in SW too — reads cookie, doesn't touch DOM) ──

export function readCookie(name) {
  if (typeof document !== 'undefined') {
    const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
    return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
  }
  return null;
}

// ── The single executor both page & SW call ──────────────────

/**
 * Execute one op against the server.
 * Returns { ok: true, ...data } or { ok: false, error, transient, auth?, status? }.
 *
 * - transient: true  → network / 5xx / 409 / 429 → retry later
 * - transient: false → server rejected payload → log, don't hammer
 * - auth: true       → 401/403 → drain stops, session expired
 */
export async function executeOp(op) {
  const kind = OP_KINDS[op.kind];
  if (!kind) {
    return { ok: false, error: `Unknown op kind: ${op.kind}`, transient: false };
  }

  let req;
  try {
    req = kind.buildRequest(op.payload);
  } catch (e) {
    return { ok: false, error: `buildRequest failed: ${e.message}`, transient: false };
  }

  // Attach CSRF + idempotency key
  const csrf = readCookie('csrftoken');
  if (csrf) req.init.headers = { ...(req.init.headers || {}), 'X-CSRFToken': csrf };
  req.init.headers = {
    ...(req.init.headers || {}),
    'Idempotency-Key': op.id, // op.id is our UUIDv4 — server dedupes on this
  };

  let res;
  try {
    res = await fetch(req.url, req.init);
  } catch (e) {
    return { ok: false, error: e.message || 'Network error', transient: true };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Authentication expired', transient: false, auth: true };
  }
  if (res.status >= 500) {
    return { ok: false, error: `Server error ${res.status}`, transient: true };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: `Non-JSON response (${res.status})`, transient: false };
  }

  const verdict = kind.interpretResponse(data);
  if (verdict.ok) return verdict;

  // 4xx with app-level error is usually permanent — but 409/429 are retryable
  const transient = res.status === 409 || res.status === 429;
  return { ...verdict, ok: false, transient, status: res.status };
}