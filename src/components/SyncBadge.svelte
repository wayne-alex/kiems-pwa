<script>
  import { sync, syncNow } from '../lib/sync.svelte.js';

  let syncing = false;

  async function retry() {
    if (syncing) return;
    syncing = true;
    try {
      await syncNow();
    } finally {
      syncing = false;
    }
  }
</script>

{#if !$sync.online || $sync.pending > 0}
  <button
    class="badge"
    class:offline={!$sync.online}
    class:pending={$sync.online && $sync.pending > 0}
    on:click={retry}
    disabled={syncing || !$sync.online}
    title={!$sync.online
      ? 'You are offline — work is saved locally'
      : `${$sync.pending} change${$sync.pending === 1 ? '' : 's'} waiting to sync`}
  >
    <span class="dot"></span>
    <span class="label">
      {#if !$sync.online}
        Offline
      {:else if syncing}
        Syncing…
      {:else if $sync.pending === 1}
        1 pending
      {:else}
        {$sync.pending} pending
      {/if}
    </span>
  </button>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px 5px 8px;
    border: none;
    border-radius: 999px;
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: var(--shadow-1);
    transition: transform .2s var(--ease);
  }
  .badge:active:not(:disabled) { transform: scale(.95); }
  .badge:disabled { cursor: default; opacity: .85; }

  .badge.offline {
    background: #FBE8E6;
    color: var(--danger);
  }
  .badge.pending {
    background: var(--amber-tint, #FFF4DE);
    color: var(--warn, #9A6B00);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
  .badge.pending .dot {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%      { opacity: 1; }
  }
</style>