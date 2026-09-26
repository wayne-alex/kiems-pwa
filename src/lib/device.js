import FingerprintJS from '@fingerprintjs/fingerprintjs';

let fpPromise = null;

export async function getDeviceFingerprint() {
  if (fpPromise) return fpPromise;

  fpPromise = (async () => {
    try {
      const fp = await FingerprintJS.load();
      const result = await fp.get();
      localStorage.setItem('device_fingerprint', result.visitorId);
      return result.visitorId;
    } catch (err) {
      console.warn('FingerprintJS failed, using fallback:', err);
      let fallback = localStorage.getItem('vra_device_token');
      if (!fallback) {
        fallback = crypto.randomUUID();
        localStorage.setItem('vra_device_token', fallback);
      }
      return fallback;
    }
  })();

  return fpPromise;
}

export function getDeviceToken() {
  let t = localStorage.getItem('vra_device_token');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('vra_device_token', t);
  }
  return t;
}