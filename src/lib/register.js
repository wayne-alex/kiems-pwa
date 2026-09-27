// src/lib/register.js
import { getDeviceFingerprint } from './device.js';
import { apiUrl } from './config.js';

export async function registerDevice() {
  try {
    const fingerprint = await getDeviceFingerprint();
    const res = await fetch(apiUrl('/kiems/register-device/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCookie('csrftoken') || '',
      },
      credentials: 'include',
      body: JSON.stringify({
        fingerprint,
        device_info: {
          screenResolution: `${screen.width}x${screen.height}`,
          language: navigator.language,
          platform: navigator.platform,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    });

    if (!res.ok) {
      console.warn('[register] HTTP', res.status);
      return null;
    }

    const data = await res.json();
    return {
      ok: data.ok,
      isBurned: data.is_burned,
      isActive: data.is_active,
      vraId: data.vra_id,
      vraName: data.vra_name,
      wardId: data.ward_id,
      wardName: data.ward_name,
    };
  } catch (err) {
    console.warn('[register] failed:', err);
    return null;
  }
}

function getCookie(name) {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}