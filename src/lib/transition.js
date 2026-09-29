// src/lib/transition.js
import { writable } from 'svelte/store';

/**
 * Holds the source rect of a card that triggered a route change.
 * Read by destination pages to animate in as if the card grew.
 *
 * shape: {
 *   top: number, left: number, width: number, height: number,
 *   radius: number, // computed border-radius on the source card
 *   accent: string  // 'green' | 'blue' | null — for color continuity
 * }
 */
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