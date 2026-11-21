<script>
  import { fly } from 'svelte/transition';
  import { swState, applyUpdate } from '$lib/core/sw-register.js';
  import { portal } from '$lib/core/portal.js';

  $: updateReady = $swState.updateReady;
  let dismissed = false;
</script>

<div use:portal>
  {#if updateReady && !dismissed}
    <div class="banner" role="status" transition:fly={{ y: -24, duration: 240 }}>
      <span class="ic">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 12A8 8 0 1 1 12 4" />
          <path d="M20 4V10H14" />
        </svg>
      </span>
      <span class="txt">
        <b>Update ready</b>
        <small>Reload to get the latest version</small>
      </span>
      <button class="go" on:click={applyUpdate}>Reload</button>
      <button class="x" on:click={() => (dismissed = true)} aria-label="Dismiss">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round">
          <path d="M6 6L18 18M18 6L6 18" />
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .banner {
    position: fixed;
    top: calc(64px + env(safe-area-inset-top));
    left: 0;
    right: 0;
    margin: 0 auto;
    width: calc(100% - 24px);
    max-width: 420px;
    z-index: 300;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 8px 10px 10px;
    background: #fff;
    border: 1px solid #edf0f5;
    border-radius: 18px;
    box-shadow: 0 18px 36px -14px rgba(14, 31, 63, 0.35), 0 2px 4px rgba(14, 31, 63, 0.05);
    color: #0e1f3f;
  }
  .ic {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, #12b67f, #067552);
    color: #fff;
  }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .txt b { font-size: 13.5px; font-weight: 750; letter-spacing: -0.02em; }
  .txt small {
    font-size: 12px;
    color: #5c6a82;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .go {
    padding: 9px 14px;
    border: 0;
    border-radius: 999px;
    background: #0e1f3f;
    color: #fff;
    font: inherit;
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .go:active { transform: scale(0.94); }
  .x {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #8c97aa;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }
  .x:active { background: #f1f4f8; }
</style>