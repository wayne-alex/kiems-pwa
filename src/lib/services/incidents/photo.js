// src/lib/services/incidents/photo.js
//
// Capture a photo, compress it to WebP (max 1600px), return a Blob.
// Keeps IDB payloads small (~150KB) so the queue drains reliably even
// on 2G/3G connections.

export async function compressImage(file, { maxDim = 1600, quality = 0.72 } = {}) {
  // Load into an image
  const bitmap = await createImageBitmap(file);

  // Scale down
  let { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Prefer WebP (all Chromium), fall back to JPEG on iOS Safari < 16.4
  const mime = supportsWebp() ? 'image/webp' : 'image/jpeg';

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), mime, quality),
  );

  bitmap.close?.();

  if (!blob) throw new Error('Image compression failed');
  return {
    blob,
    ext: mime === 'image/webp' ? 'webp' : 'jpg',
    size: blob.size,
  };
}

let _webpSupport = null;
function supportsWebp() {
  if (_webpSupport !== null) return _webpSupport;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    _webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    _webpSupport = false;
  }
  return _webpSupport;
}