import { apiUrl } from '../config.js';

export class ApiError extends Error {
  constructor(message, { transient = false, status = 0, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.transient = transient;
    this.status = status;
    this.data = data;
  }
}

function getCookie(name) {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}

let _csrfPromise = null;
async function refreshCsrf() {
  if (_csrfPromise) return _csrfPromise;
  _csrfPromise = (async () => {
    try {
      await fetch(apiUrl('/kiems/csrf/'), { credentials: 'include' });
    } catch {
      /* swallow; retry will still fail cleanly */
    }
  })();
  return _csrfPromise;
}

/**
 * Main fetch. Returns parsed JSON on success (throws ApiError on failure).
 *
 * Options:
 *   method, body, json, headers, idempotencyKey, retryOn403=true
 */
export async function apiFetch(url, opts = {}) {
  const {
    method = 'GET',
    body,
    json,
    headers = {},
    idempotencyKey = null,
    retryOn403 = true,
  } = opts;

  const finalHeaders = {
    'X-CSRFToken': getCookie('csrftoken') || '',
    ...headers,
  };
  if (idempotencyKey) finalHeaders['Idempotency-Key'] = idempotencyKey;

  let payload = body;
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }

  const doFetch = () =>
    fetch(apiUrl(url), {
      method,
      headers: finalHeaders,
      body: payload,
      credentials: 'include',
    });

  let res;
  try {
    res = await doFetch();
  } catch (e) {
    throw new ApiError(e.message || 'Network error', { transient: true });
  }

  if (res.status === 403 && retryOn403 && method !== 'GET') {
    await refreshCsrf();
    finalHeaders['X-CSRFToken'] = getCookie('csrftoken') || '';
    try {
      res = await doFetch();
    } catch (e) {
      throw new ApiError(e.message || 'Network error', { transient: true });
    }
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Non-JSON response (${res.status})`, {
      transient: res.status >= 500,
      status: res.status,
    });
  }

  if (data == null) {
    throw new ApiError(`Empty response (${res.status})`, {
      transient: res.status >= 500,
      status: res.status,
    });
  }

  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new ApiError(msg, {
      transient: res.status >= 500 || res.status === 429 || res.status === 409,
      status: res.status,
      data,
    });
  }

  return data;
}