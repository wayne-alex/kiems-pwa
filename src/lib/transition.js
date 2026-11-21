import { writable } from 'svelte/store';

export const sourceCard = writable(null);

export function captureCardRect(el, accent = null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  sourceCard.set({
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    radius: parseFloat(cs.borderTopLeftRadius) || 0,
    accent,
  });
}

export function clearSourceCard() {
  sourceCard.set(null);
}