<script>
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { subscribeSync } from '$lib/core/sync.js';
  import SystemSheet from '$lib/SystemSheet.svelte';
  import { portal } from '$lib/core/portal.js';

  let snap = { online: true, pending: 0, retrying: 0, gaveup: 0, lastSync: 0, draining: false };
  let sheetOpen = false;
  let flash = null;

  const unsub = subscribeSync((s) => {
    snap = {
      online: s.online ?? true,
      pending: s.pending ?? 0,
      retrying: s.retrying ?? 0,
      gaveup: s.gaveup ?? 0,
      lastSync: s.lastSync ?? 0,
      draining: !!s.draining,
    };
  });

  let swListener = null;

  onMount(() => {
    if ('serviceWorker' in navigator) {
      swListener = (evt) => {
        const m = evt.data || {};
        if (m.type === 'SYNC_DONE') {
          const ok = (m.sent || 0) > 0 && (m.failed || 0) === 0;
          flash = { kind: ok ? 'synced' : 'error', at: Date.now() };
          try {
            navigator.vibrate?.(ok ? [8, 30, 8] : 40);
          } catch {}
          setTimeout(() => (flash = null), 2400);
        }
      };
      navigator.serviceWorker.addEventListener('message', swListener);
    }
    return () => {
      unsub();
      if (swListener) navigator.serviceWorker.removeEventListener('message', swListener);
    };
  });

  // Precedence: gaveup > offline > pending > ok
  $: mode =
    snap.gaveup > 0 ? 'attention'
    : !snap.online ? 'offline'
    : snap.pending > 0 ? 'pending'
    : 'ok';

  $: label =
    mode === 'attention' ? `${snap.gaveup} failed`
    : mode === 'offline' ? 'Offline'
    : mode === 'pending' ? `${snap.pending} pending`
    : 'Synced';

  function open() {
    try { navigator.vibrate?.(6); } catch {}
    sheetOpen = true;
  }
</script>

<button class="badge {mode}" on:click={open} aria-label="Open sync status. {label}">
  <span class="dot" class:pulse={snap.draining}></span>
  <span class="txt">{label}</span>
</button>

<!-- Moved to <body> so it is never trapped inside the header -->
<div use:portal>
  {#if flash}
    <div class="flash {flash.kind}" transition:fly={{ y: -8, duration: 200 }}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
           stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        {#if flash.kind === 'synced'}<path d="M5 12.5L10 17.5L19 7" />{:else}<path d="M6 6L18 18M18 6L6 18" />{/if}
      </svg>
      {flash.kind === 'synced' ? 'All changes synced' : 'Sync failed'}
    </div>
  {/if}
  <SystemSheet bind:open={sheetOpen} onClose={() => (sheetOpen = false)} />
</div>

<style>
  .badge {
    --c: #067552;
    --bg: #e3f6ee;
    --bd: #c4ebdb;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px 0 10px;
    border-radius: 999px;
    border: 1px solid var(--bd);
    background: var(--bg);
    color: var(--c);
    font: inherit;
    font-size: 12px;
    font-weight: 750;
    letter-spacing: -0.01em;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1), background 0.2s;
  }
  .badge:active { transform: scale(0.95); }
  .badge.pending   { --c: #8f5a00; --bg: #fff2dc; --bd: #fbe0b0; }
  .badge.attention { --c: #b23a32; --bg: #ffe8e8; --bd: #ffcdcd; }
  .badge.offline   { --c: #4d5d73; --bg: #e9eef4; --bd: #d7dfe9; }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 18%, transparent);
  }
  .dot.pulse { animation: pulse 0.9s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: 0.55; }
  }

  .flash {
    position: fixed;
    top: calc(64px + env(safe-area-inset-top));
    right: 16px;
    z-index: 250;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 750;
    pointer-events: none;
    box-shadow: 0 14px 28px -10px rgba(14, 31, 63, 0.45);
  }
  .flash.synced { background: #0e1f3f; color: #7bf0bd; }
  .flash.error  { background: #b23a32; color: #fff; }

  @media (prefers-reduced-motion: reduce) {
    .badge, .dot.pulse { transition: none; animation: none; }
  }
</style>