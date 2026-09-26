import { apiUrl } from './config.js';

function getCookie(name) {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  if (!match) return null;
  return decodeURIComponent(match.split('=').slice(1).join('='));
}

export async function apiFetch(url, { method = 'GET', body, json, headers = {} } = {}) {
  const finalHeaders = {
    'X-CSRFToken': getCookie('csrftoken') || '',
    ...headers,
  };

  let payload;
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  } else if (body !== undefined) {
    payload = body;
  }

  const res = await fetch(apiUrl(url), {
    method,
    headers: finalHeaders,
    body: payload,
    credentials: 'include',
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server returned non-JSON (status ${res.status})`);
  }
  if (data === null) throw new Error(`Empty response (status ${res.status})`);
  return data;
}