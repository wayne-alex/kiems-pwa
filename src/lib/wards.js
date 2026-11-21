// src/lib/wards.js
import { apiFetch } from './api.js';

/**
 * Fetch active wards for a constituency.
 * Returns an array of { id, name, code }.
 *
 * Note: this hits the /api/wards-by-constituency/ endpoint on the Django
 * backend, which is still served by home/views.py (a read view).
 */
export async function fetchWards(constituencyId) {
  if (!constituencyId) return [];
  const res = await apiFetch(
    `/api/wards-by-constituency/?constituency_id=${encodeURIComponent(constituencyId)}`,
  );
  return res.wards || [];
}