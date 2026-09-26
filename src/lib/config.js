// src/lib/config.js
// In dev, Vite's proxy handles /kiems, /api, /movement → localhost:8000.
// In production, API_BASE points at the Django deployment.

export const API_BASE = import.meta.env.VITE_API_BASE || '';

export function apiUrl(path) {
  if (!path.startsWith('/')) path = '/' + path;
  return API_BASE + path;
}