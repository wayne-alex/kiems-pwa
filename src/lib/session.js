// src/lib/session.js
import { writable, derived, get } from 'svelte/store';
import { getDeviceFingerprint } from './device.js';
import { apiFetch } from './api.js';

/**
 * Session store — holds the device identity and whatever VRA/ward
 * this device is bound to. Single source of truth for pages.
 *
 * status:
 *   'idle'      → not resolved yet
 *   'loading'   → resolving
 *   'bound'     → device is attached to a VRA
 *   'unbound'   → device is registered but not attached → show BindModal
 *   'error'     → network error
 */

const state = writable({
  status: 'idle',
  fingerprint: null,
  deviceId: null,
  vra: null,            // { id, name }
  ward: null,           // { id, name }
  constituency: null,   // { id, name, county }
  error: null,
  lastRefresh: 0,
});

export const session = {
  subscribe: state.subscribe,
};

/** Read the current snapshot synchronously (for use inside handlers). */
export function sessionValue() {
  return get(state);
}

/**
 * Ensure the device is registered and resolve its VRA binding.
 * Idempotent — safe to call on every boot.
 */
export async function resolveSession() {
  state.update((s) => ({ ...s, status: 'loading', error: null }));

  try {
    const fingerprint = await getDeviceFingerprint();

    // 1. Ensure device record exists (creates if needed)
    const reg = await fetch('/kiems/register-device/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': cookie('csrftoken') || '',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        fingerprint,
        device_info: {
          screenResolution: `${screen.width}x${screen.height}`,
          language: navigator.language,
          platform: navigator.platform,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    }).then((r) => (r.ok ? r.json() : null));

    // 2. Resolve VRA binding
    const resolved = await apiFetch(
      `/kiems/resolve-vra/?fingerprint=${encodeURIComponent(fingerprint)}`
    );

    if (resolved.bound) {
      state.update((s) => ({
        ...s,
        status: 'bound',
        fingerprint,
        deviceId: reg?.device_id || null,
        vra: { id: resolved.vra_id, name: resolved.vra_name },
        ward: { id: resolved.ward_id, name: resolved.ward_name },
        constituency: resolved.constituency_name
          ? { id: resolved.constituency_id, name: resolved.constituency_name }
          : s.constituency,
        error: null,
        lastRefresh: Date.now(),
      }));
    } else {
      state.update((s) => ({
        ...s,
        status: 'unbound',
        fingerprint,
        deviceId: reg?.device_id || null,
        vra: null,
        ward: null,
        constituency: null,
        error: null,
        lastRefresh: Date.now(),
      }));
    }
  } catch (err) {
    console.error('[session] resolve failed:', err);
    state.update((s) => ({
      ...s,
      status: 'error',
      error: err.message || 'Failed to resolve session.',
    }));
  }
}

/**
 * Bind this device to a specific ward. Called from BindModal.
 * After success, updates the session store to `bound` state.
 */
export async function bindToWard({ wardId, constituencyId, fingerprint }) {
  const body = new URLSearchParams();
  body.append('ward_id', wardId);
  if (constituencyId) body.append('constituency_id', constituencyId);
  if (fingerprint) body.append('fingerprint', fingerprint);

  const res = await apiFetch('/kiems/bind-ward/', {
    method: 'POST',
    body,
  });

  if (!res.ok) {
    throw new Error(res.error || 'Could not bind to ward.');
  }

  state.update((s) => ({
    ...s,
    status: 'bound',
    vra: { id: res.vra_id, name: res.vra_name },
    ward: { id: res.ward_id, name: res.ward_name },
    constituency: res.constituency_name
      ? { id: res.constituency_id, name: res.constituency_name }
      : s.constituency,
    error: null,
    lastRefresh: Date.now(),
  }));

  return res;
}

/** Force a re-resolve (e.g. after a failed bind). */
export function resetSession() {
  state.update((s) => ({ ...s, status: 'idle' }));
}

function cookie(name) {
  const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}