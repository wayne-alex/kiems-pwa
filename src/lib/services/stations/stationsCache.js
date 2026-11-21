import { Cache } from '$lib/core/db.js';
import { apiFetch } from '$lib/core/net.js';

// Shared by the Stations page and Movement. Same cache key and shape as the Stations page.
const KEY = 'stations:all:v2';
const TTL = 30 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 400;

let memory = null; // { stations, complete }
let inflight = null;

/**
 * Returns every station. Uses the saved copy when it is complete and fresh.
 * onProgress(list) is called while pages are still arriving, so the UI can start early.
 * A partial download is never saved as complete.
 */
export async function getStations({ onProgress } = {}) {
  if (memory?.complete) return memory.stations;
  if (inflight) return inflight;

  inflight = (async () => {
    let saved = [];
    try {
      const row = await Cache.get(KEY);
      if (row?.value?.stations?.length) {
        saved = row.value.stations;
        if (row.value.complete && Date.now() - (row.ts || 0) < TTL) {
          memory = { stations: saved, complete: true };
          return saved;
        }
        onProgress?.(saved); // old but usable while we refresh
      }
    } catch { /* ignore */ }

    const all = [];
    try {
      for (let p = 1; p <= MAX_PAGES; p++) {
        const res = await apiFetch(`/api/stations/?limit=${PAGE_LIMIT}&page=${p}`);
        if (!res.ok || !Array.isArray(res.stations)) {
          throw new Error(res.error || 'Unexpected response');
        }
        for (const s of res.stations) all.push(s);
        if (!saved.length && (p === 1 || p % 5 === 0)) onProgress?.(all.slice());
        if (!res.has_more) break;
      }
      memory = { stations: all, complete: true };
      try { await Cache.set(KEY, { stations: all, complete: true }); } catch { /* ignore */ }
      return all;
    } catch {
      return saved.length ? saved : all; // partial: use it, but don't cache it as complete
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}