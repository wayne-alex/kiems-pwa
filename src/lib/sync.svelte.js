// src/lib/sync.svelte.js
import { writable } from 'svelte/store';
import { subscribeOffline, drainQueue } from './offline.js';

export const sync = writable({
  online: true,
  pending: 0,
  lastSync: 0,
});

subscribeOffline((s) => {
  sync.set(s);
});

/** Manually force a drain — call from "Retry now" buttons. */
export async function syncNow() {
  await drainQueue();
}