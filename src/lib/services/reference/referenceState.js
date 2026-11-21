import { Meta } from '$lib/core/db.js';

// Which guides this device has read (stored on the device only)
const KEY = 'reference:read:v1';

export async function getReadSet() {
  try {
    const v = await Meta.get(KEY, []);
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

export async function markDocRead(slug) {
  try {
    const set = await getReadSet();
    if (set.has(slug)) return false;
    set.add(slug);
    await Meta.set(KEY, [...set]);
    return true;
  } catch {
    return false;
  }
}