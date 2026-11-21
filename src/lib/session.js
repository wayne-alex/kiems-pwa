// src/lib/session.js
import { writable, get } from 'svelte/store';

import { getDeviceFingerprint } from './device.js';
import { Session as SessionDB, Meta } from './core/db.js';
import { apiFetch } from './core/net.js';
import { apiUrl } from './config.js';

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const STALENESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
// PERSISTENCE (IDB)
// ═══════════════════════════════════════════════════════════
async function loadCachedSession() {
  try {
    const row = await SessionDB.get();
    if (!row || typeof row !== 'object') return null;
    if (!row.cachedAt || Date.now() - row.cachedAt > STALENESS_MS) return null;
    // A cached session is only usable if we still have a bound ward
    if (!row.ward || !row.vra) return null;
    return row;
  } catch (err) {
    console.warn('[session] cache read failed:', err);
    return null;
  }
}

async function saveCachedSession(snapshot) {
  try {
    await SessionDB.set({
      fingerprint: snapshot.fingerprint,
      deviceId: snapshot.deviceId,
      vra: snapshot.vra,
      ward: snapshot.ward,
      constituency: snapshot.constituency,
      cachedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[session] cache write failed:', err);
  }
}

async function clearCachedSession() {
  try {
    await SessionDB.clear();
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
// RESTORE — synchronous boot from cache (no network)
// ═══════════════════════════════════════════════════════════
/**
 * Try to bring the session up from IDB without any network.
 * Returns true if a valid cached session was restored, false otherwise.
 *
 * NOTE: this is async on purpose — IDB reads are async. Callers must
 * `await restoreSession()`. App.svelte already awaits it before boot.
 */
export async function restoreSession() {
  const cached = await loadCachedSession();
  if (!cached) return false;

  // Verify the fingerprint still matches — otherwise the cache was
  // written by a different device/profile in this browser.
  const currentFp = localStorage.getItem('device_fingerprint');
  if (!currentFp || cached.fingerprint !== currentFp) {
    await clearCachedSession();
    return false;
  }

  state.update((s) => ({
    ...s,
    status: 'bound',
    fingerprint: cached.fingerprint,
    deviceId: cached.deviceId || null,
    vra: cached.vra,
    ward: cached.ward,
    constituency: cached.constituency || null,
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
 * Full resolution against the server.
 *
 * Pass { silent: true } to keep the current status while refreshing
 * in the background (avoids flashing the loading skeleton).
 */
export async function resolveSession({ silent = false } = {}) {
  if (!silent) {
    state.update((s) => ({ ...s, status: 'loading', error: null }));
  } else {
    state.update((s) => ({ ...s, refreshing: true }));
  }

  try {
    const fingerprint = await getDeviceFingerprint();

    // ── 1. Ensure device record exists (creates if needed) ──
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

    // ── 2. Resolve VRA binding ──
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
      await saveCachedSession(snapshot);
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
      await clearCachedSession();
    }
  } catch (err) {
    console.error('[session] resolve failed:', err);

    // If we already had a cached session, keep it and just note the error
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
  await saveCachedSession(snapshot);

  return res;
}

// ═══════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════
export async function resetSession() {
  await clearCachedSession();
  state.set({ ...initial });
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function cookie(name) {
  const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}

// ═══════════════════════════════════════════════════════════
// Boot marker (used by App.svelte to know if it's first-run)
// ═══════════════════════════════════════════════════════════
export async function isFirstRun() {
  const flag = await Meta.get('session_initialized', false);
  return !flag;
}

export async function markInitialized() {
  await Meta.set('session_initialized', true);
}