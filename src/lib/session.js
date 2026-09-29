// src/lib/session.js
import { writable, get } from 'svelte/store';
import { getDeviceFingerprint } from './device.js';
import { apiFetch } from './api.js';
import { apiUrl } from './config.js';

// ═══════════════════════════════════════════════════════════
// CACHE — persisted session snapshot for offline boot
// ═══════════════════════════════════════════════════════════
const SESSION_CACHE_KEY = 'iebc:session';
const STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadCachedSession() {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > STALENESS_MS) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[session] cache read failed:', err);
    return null;
  }
}

function saveCachedSession(snapshot) {
  try {
    localStorage.setItem(
      SESSION_CACHE_KEY,
      JSON.stringify({ ...snapshot, cachedAt: Date.now() })
    );
  } catch (err) {
    console.warn('[session] cache write failed:', err);
  }
}

function clearCachedSession() {
  try {
    localStorage.removeItem(SESSION_CACHE_KEY);
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const initial = {
  status: 'idle',        // 'idle' | 'loading' | 'bound' | 'unbound' | 'error'
  fingerprint: null,
  deviceId: null,
  vra: null,             // { id, name }
  ward: null,            // { id, name }
  constituency: null,    // { id, name }
  error: null,
  lastRefresh: 0,
  fromCache: false,      // true until a network refresh completes
  refreshing: false,     // true while background refresh is in-flight
};

const state = writable(initial);

export const session = {
  subscribe: state.subscribe,
};

/** Synchronous snapshot for use inside handlers. */
export function sessionValue() {
  return get(state);
}

// ═══════════════════════════════════════════════════════════
// RESTORE — synchronous boot from cache (no network)
// ═══════════════════════════════════════════════════════════
/**
 * Try to bring the session up from localStorage without any network.
 * Returns true if a valid cached session was restored, false otherwise.
 *
 * Called from App.svelte's onMount BEFORE any network request.
 */
export function restoreSession() {
  const cached = loadCachedSession();
  if (!cached) return false;

  // Verify fingerprint matches — otherwise the cache is from another device
  const currentFp = localStorage.getItem('device_fingerprint');
  if (!currentFp || cached.fingerprint !== currentFp) {
    clearCachedSession();
    return false;
  }

  // Must actually be bound to be useful
  if (!cached.ward || !cached.vra) {
    clearCachedSession();
    return false;
  }

  state.update((s) => ({
    ...s,
    status: 'bound',
    fingerprint: cached.fingerprint,
    deviceId: cached.deviceId,
    vra: cached.vra,
    ward: cached.ward,
    constituency: cached.constituency,
    error: null,
    lastRefresh: cached.cachedAt,
    fromCache: true,
    refreshing: false,
  }));

  return true;
}

// ═══════════════════════════════════════════════════════════
// RESOLVE — network-first, updates cache on success
// ═══════════════════════════════════════════════════════════
/**
 * Full resolution against the server. Call this:
 *   - on first-ever boot (no cache available)
 *   - in the background after a cached restore
 *   - after the BindModal succeeds
 *   - on an explicit retry from the UI
 *
 * Pass { silent: true } to keep the current status while refreshing
 * (used for background refreshes so we don't flash the loading state).
 */
export async function resolveSession({ silent = false } = {}) {
  if (!silent) {
    state.update((s) => ({ ...s, status: 'loading', error: null }));
  } else {
    state.update((s) => ({ ...s, refreshing: true }));
  }

  try {
    const fingerprint = await getDeviceFingerprint();

    // 1. Ensure device record exists (creates if needed)
    let reg = null;
    try {
      const res = await fetch(apiUrl('/kiems/register-device/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': cookie('csrftoken') || '',
        },
        credentials: 'include',
        body: JSON.stringify({
          fingerprint,
          device_info: {
            screenResolution: `${screen.width}x${screen.height}`,
            language: navigator.language,
            platform: navigator.platform,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
      });
      if (res.ok) reg = await res.json();
    } catch (err) {
      console.warn('[session] register-device failed:', err);
    }

    // 2. Resolve VRA binding
    const resolved = await apiFetch(
      `/kiems/resolve-vra/?fingerprint=${encodeURIComponent(fingerprint)}`
    );

    if (resolved.bound) {
      const snapshot = {
        status: 'bound',
        fingerprint,
        deviceId: reg?.device_id || null,
        vra: { id: resolved.vra_id, name: resolved.vra_name },
        ward: { id: resolved.ward_id, name: resolved.ward_name },
        constituency: resolved.constituency_name
          ? { id: resolved.constituency_id, name: resolved.constituency_name }
          : null,
        error: null,
        lastRefresh: Date.now(),
        fromCache: false,
        refreshing: false,
      };

      state.update((s) => ({ ...s, ...snapshot }));
      saveCachedSession(snapshot);
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
        fromCache: false,
        refreshing: false,
      }));
      clearCachedSession();
    }
  } catch (err) {
    console.error('[session] resolve failed:', err);

    // If we already have a cached session, keep it and mark as stale
    const current = get(state);
    if (current.status === 'bound' && current.fromCache) {
      state.update((s) => ({
        ...s,
        refreshing: false,
        error: err.message || 'Refresh failed',
      }));
      // Don't change status — user keeps working offline
    } else {
      state.update((s) => ({
        ...s,
        status: 'error',
        error: err.message || 'Failed to resolve session.',
        refreshing: false,
      }));
    }
  }
}

// ═══════════════════════════════════════════════════════════
// BIND — called from BindModal after picking a ward
// ═══════════════════════════════════════════════════════════
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

  const snapshot = {
    status: 'bound',
    fingerprint: fingerprint || get(state).fingerprint,
    deviceId: get(state).deviceId,
    vra: { id: res.vra_id, name: res.vra_name },
    ward: { id: res.ward_id, name: res.ward_name },
    constituency: res.constituency_name
      ? { id: res.constituency_id, name: res.constituency_name }
      : null,
    error: null,
    lastRefresh: Date.now(),
    fromCache: false,
    refreshing: false,
  };

  state.update((s) => ({ ...s, ...snapshot }));
  saveCachedSession(snapshot);

  return res;
}

// ═══════════════════════════════════════════════════════════
// RESET — force a fresh resolve (e.g. after a failed bind)
// ═══════════════════════════════════════════════════════════
export function resetSession() {
  clearCachedSession();
  state.set({ ...initial });
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function cookie(name) {
  const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}