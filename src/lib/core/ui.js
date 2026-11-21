// src/lib/core/ui.js
import { writable } from 'svelte/store';

export const profileSheetOpen = writable(false);
export const systemSheetOpen = writable(false);

export function openProfile()  { profileSheetOpen.set(true); }
export function closeProfile() { profileSheetOpen.set(false); }
export function openSystem()   { systemSheetOpen.set(true);  }
export function closeSystem()  { systemSheetOpen.set(false); }