import { Queue, Cache, Meta } from './db.js';
import { enqueue } from './queue.js';

const LEGACY_QUEUE_KEY = 'iebc:queue:ops';
const LEGACY_META_KEY = 'iebc:queue:meta';
const LEGACY_CACHE_PREFIX = 'iebc:cache:';
const MIGRATION_FLAG = 'idb_migrated_v1';

export async function migrateLegacyStorage() {
  if (await Meta.get(MIGRATION_FLAG, false)) return;

  // Queue
  try {
    const raw = localStorage.getItem(LEGACY_QUEUE_KEY);
    if (raw) {
      const ops = JSON.parse(raw);
      for (const op of ops) {
        // Preserve id if it's a UUID-ish string; else let enqueue mint one.
        await enqueue(op.kind, op.payload);
      }
      localStorage.removeItem(LEGACY_QUEUE_KEY);
    }
  } catch (e) {
    console.warn('[migrate] legacy queue migration failed:', e);
  }

  // Cache
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_CACHE_PREFIX)) {
        const val = localStorage.getItem(k);
        if (val) {
          try {
            const parsed = JSON.parse(val);
            await Cache.set(k.replace(LEGACY_CACHE_PREFIX, ''), parsed.value);
          } catch { /* ignore bad entry */ }
        }
        localStorage.removeItem(k);
      }
    }
  } catch (e) {
    console.warn('[migrate] cache migration failed:', e);
  }

  // Meta
  try {
    const raw = localStorage.getItem(LEGACY_META_KEY);
    if (raw) {
      const m = JSON.parse(raw);
      if (m.lastSync) await Meta.set('lastSync', m.lastSync);
      localStorage.removeItem(LEGACY_META_KEY);
    }
  } catch { /* ignore */ }

  await Meta.set(MIGRATION_FLAG, true);
  console.info('[migrate] localStorage → IndexedDB complete');
}