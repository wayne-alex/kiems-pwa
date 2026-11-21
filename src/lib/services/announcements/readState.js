const KEY = 'announcements:read:v1';
const MAX = 500;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function save(set) {
  try {
    const arr = [...set];
    // Trim oldest entries so localStorage doesn't grow forever
    if (arr.length > MAX) arr.splice(0, arr.length - MAX);
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch { /* ignore */ }
}

export function isRead(id) {
  return load().has(id);
}

export function markRead(id) {
  const set = load();
  if (set.has(id)) return;
  set.add(id);
  save(set);
}

export function markAllRead(ids) {
  const set = load();
  let changed = false;
  for (const id of ids) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (changed) save(set);
}

export function countUnread(ids) {
  const set = load();
  return ids.reduce((n, id) => n + (set.has(id) ? 0 : 1), 0);
}

export function clearRead() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}