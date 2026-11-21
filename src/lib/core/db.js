
const DB_NAME = 'iebc';
const DB_VERSION = 1;

export const STORES = {
  QUEUE: 'queue',
  OPLOG: 'oplog',
  CACHE: 'cache',
  SESSION: 'session',
  META: 'meta',
  ERRORS: 'errors',
  INCIDENTS: 'incidents',
  VERIFICATIONS: 'verifications',
};

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORES.QUEUE)) {
        const q = db.createObjectStore(STORES.QUEUE, { keyPath: 'id' });
        q.createIndex('kind', 'kind');
        q.createIndex('state', 'state');
        q.createIndex('nextRetryAt', 'nextRetryAt');
        q.createIndex('createdAt', 'createdAt');
      }

      if (!db.objectStoreNames.contains(STORES.OPLOG)) {
        const o = db.createObjectStore(STORES.OPLOG, { keyPath: 'id' });
        o.createIndex('finishedAt', 'finishedAt');
      }

      if (!db.objectStoreNames.contains(STORES.CACHE)) {
        const c = db.createObjectStore(STORES.CACHE, { keyPath: 'key' });
        c.createIndex('ts', 'ts');
      }

      if (!db.objectStoreNames.contains(STORES.SESSION)) {
        db.createObjectStore(STORES.SESSION, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(STORES.ERRORS)) {
        const e = db.createObjectStore(STORES.ERRORS, { keyPath: 'id', autoIncrement: true });
        e.createIndex('ts', 'ts');
      }

      if (!db.objectStoreNames.contains(STORES.INCIDENTS)) {
        const i = db.createObjectStore(STORES.INCIDENTS, { keyPath: 'id' });
        i.createIndex('state', 'state');
      }

      if (!db.objectStoreNames.contains(STORES.VERIFICATIONS)) {
        const v = db.createObjectStore(STORES.VERIFICATIONS, { keyPath: 'id' });
        v.createIndex('createdAt', 'createdAt');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB upgrade blocked — close other tabs'));
  });
  return _dbPromise;
}

function tx(db, store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Generic API ---

export async function idbGet(store, key) {
  const db = await openDB();
  return reqToPromise(tx(db, store).get(key));
}

export async function idbPut(store, value) {
  const db = await openDB();
  return reqToPromise(tx(db, store, 'readwrite').put(value));
}

export async function idbDelete(store, key) {
  const db = await openDB();
  return reqToPromise(tx(db, store, 'readwrite').delete(key));
}

export async function idbGetAll(store) {
  const db = await openDB();
  return reqToPromise(tx(db, store).getAll());
}

export async function idbGetAllByIndex(store, index, value) {
  const db = await openDB();
  const idx = tx(db, store).index(index);
  return reqToPromise(idx.getAll(value));
}

export async function idbCount(store) {
  const db = await openDB();
  return reqToPromise(tx(db, store).count());
}

/** Read-modify-write inside one transaction. `fn(items)` mutates in place. */
export async function idbMutate(store, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    const objectStore = transaction.objectStore(store);
    const req = objectStore.getAll();
    let changed = false;

    req.onsuccess = () => {
      const items = req.result || [];
      const next = fn(items) || items;
      if (next === items && JSON.stringify(items) === JSON.stringify(next)) {
        // no change — still resolve
      } else {
        changed = true;
        for (const item of next) objectStore.put(item);
      }
    };

    transaction.oncomplete = () => resolve(changed);
    transaction.onerror = () => reject(transaction.error);
  });
}

// --- Convenience wrappers for each store ---

export const Queue = {
  put:    (op)   => idbPut(STORES.QUEUE, op),
  get:    (id)   => idbGet(STORES.QUEUE, id),
  all:    ()     => idbGetAll(STORES.QUEUE),
  del:    (id)   => idbDelete(STORES.QUEUE, id),
  count:  ()     => idbCount(STORES.QUEUE),
  byState:(st)   => idbGetAllByIndex(STORES.QUEUE, 'state', st),
  mutate: (fn)   => idbMutate(STORES.QUEUE, fn),
};

export const OpLog = {
  put:   (rec) => idbPut(STORES.OPLOG, rec),
  all:   ()    => idbGetAll(STORES.OPLOG),
  del:   (id)  => idbDelete(STORES.OPLOG, id),
  // keep only the newest N entries
  async trim(keep = 200) {
    const all = await idbGetAll(STORES.OPLOG);
    if (all.length <= keep) return;
    all.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    for (const r of all.slice(keep)) await idbDelete(STORES.OPLOG, r.id);
  },
};

export const Cache = {
  async get(key) {
    const row = await idbGet(STORES.CACHE, key);
    return row || null;
  },
  async set(key, value) {
    await idbPut(STORES.CACHE, { key, ts: Date.now(), value });
  },
  async age(key) {
    const row = await idbGet(STORES.CACHE, key);
    return row ? Date.now() - row.ts : null;
  },
  del: (key) => idbDelete(STORES.CACHE, key),
  all: ()    => idbGetAll(STORES.CACHE),
};

export const Session = {
  async get()       { return (await idbGet(STORES.SESSION, 'current')) || null; },
  async set(snap)   { await idbPut(STORES.SESSION, { key: 'current', ...snap }); },
  async clear()     { await idbDelete(STORES.SESSION, 'current'); },
};

export const Meta = {
  async get(key, fallback = null) {
    const row = await idbGet(STORES.META, key);
    return row ? row.value : fallback;
  },
  async set(key, value) {
    await idbPut(STORES.META, { key, value });
  },
};

export const Errors = {
  async log(err, context = {}) {
    const rec = {
      ts: Date.now(),
      message: String(err?.message || err),
      stack: String(err?.stack || ''),
      context,
    };
    await idbPut(STORES.ERRORS, rec);
    // trim to 100
    const all = await idbGetAll(STORES.ERRORS);
    if (all.length > 100) {
      all.sort((a, b) => a.ts - b.ts);
      for (const r of all.slice(0, all.length - 100)) {
        await idbDelete(STORES.ERRORS, r.id);
      }
    }
  },
  all: () => idbGetAll(STORES.ERRORS),
  clear: async () => {
    const db = await openDB();
    return reqToPromise(tx(db, STORES.ERRORS, 'readwrite').clear());
  },
};