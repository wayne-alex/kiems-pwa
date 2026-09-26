// src/lib/wards.js
import { apiFetch } from './api.js';

export async function fetchWards(constituencyId) {
  if (!constituencyId) return [];
  const res = await apiFetch(
    `/api/wards-by-constituency/?constituency_id=${encodeURIComponent(constituencyId)}`
  );
  return res.wards || [];
}