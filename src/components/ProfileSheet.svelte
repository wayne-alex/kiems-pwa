<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { session, resolveSession, resetSession } from '$lib/session.js';
  import SystemSheet from '$lib/SystemSheet.svelte';
  import { Queue } from '$lib/core/db.js';

  export let open = false;
  export let onClose = () => {};

  let busyRefresh = false;
  let copied = false;
  let showSystem = false;
  let resetStage = 0; // 0 none, 1 confirm, 2 done

  // swipe-down to close
  let startY = null;
  let dragY = 0;
  function dragStart(e) { startY = e.touches[0].clientY; }
  function dragMove(e) {
    if (startY === null) return;
    dragY = Math.max(0, e.touches[0].clientY - startY);
  }
  function dragEnd() {
    if (dragY > 90) close();
    dragY = 0;
    startY = null;
  }

  $: statusLabel =
    $session.status === 'bound' ? 'Authorized'
    : $session.status === 'unbound' ? 'Not set up'
    : $session.status === 'loading' ? 'Resolving…'
    : $session.status === 'error' ? 'Session error'
    : 'Idle';

  $: statusTone =
    $session.status === 'bound' ? 'ok'
    : $session.status === 'unbound' ? 'warn'
    : $session.status === 'error' ? 'err'
    : 'idle';

  $: initial = (($session.vra?.name || 'V').trim().charAt(0) || 'V').toUpperCase();
  $: fingerprintShort = $session.fingerprint ? $session.fingerprint.slice(0, 12).toUpperCase() : '—';

  $: refreshedRel = (() => {
    const t = $session.lastRefresh;
    if (!t) return 'Never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  })();

  async function refresh() {
    if (busyRefresh) return;
    busyRefresh = true;
    try { await resolveSession({ silent: true }); } finally { busyRefresh = false; }
  }

  async function copyFingerprint() {
    try {
      await navigator.clipboard.writeText($session.fingerprint || '');
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {}
  }

  function close() {
    resetStage = 0;
    showSystem = false;
    dragY = 0;
    startY = null;
    onClose();
  }

  function onKey(e) {
    if (open && e.key === 'Escape') close();
  }

  async function doReset() {
    try {
      const ops = await Queue.all();
      for (const op of ops) await Queue.del(op.id);
    } catch {}
    await resetSession();
    resetStage = 2;
  }
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <div class="overlay" transition:fade={{ duration: 160 }} on:click={close} role="presentation">
    <div
      class="sheet"
      class:dragging={startY !== null}
      style="transform: translateY({dragY}px)"
      transition:fly={{ y: 40, duration: 280, easing: cubicOut }}
      on:click|stopPropagation
      role="dialog"
      aria-modal="true"
      aria-label="Profile"
      tabindex="-1"
    >
      <div class="grab" on:touchstart|passive={dragStart} on:touchmove|passive={dragMove} on:touchend={dragEnd}>
        <span></span>
      </div>

      {#if resetStage === 2}
        <div class="done">
          <div class="done-tick">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                 stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.5L10 17.5L19 7" />
            </svg>
          </div>
          <h3>Device reset</h3>
          <p>The session and queued changes were cleared. You will need to set up this device again.</p>
          <button class="btn solid" on:click={close}>Close</button>
        </div>
      {:else}
        <header class="head">
          <div class="avatar">
            {initial}
            <span class="pip {statusTone}"></span>
          </div>
          <div class="who">
            <div class="name">{$session.vra?.name || 'Not identified'}</div>
            <div class="loc">
              {#if $session.ward}
                {$session.ward.name}{#if $session.constituency}, {$session.constituency.name}{/if}
              {:else}
                No ward on this device
              {/if}
            </div>
          </div>
          <span class="chip {statusTone}"><i></i>{statusLabel}</span>
        </header>

        <div class="list">
          <button class="item" on:click={copyFingerprint}>
            <span class="k">Device ID</span>
            <span class="v mono">
              {fingerprintShort}
              <span class="copy" class:copied>
                {#if copied}
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                {:else}
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V5A2 2 0 0 1 7 3H15" />
                  </svg>
                {/if}
              </span>
            </span>
          </button>
          <div class="item">
            <span class="k">Session</span>
            <span class="v">{$session.fromCache ? 'From cache' : $session.status === 'bound' ? 'Live' : '—'}</span>
          </div>
          <div class="item">
            <span class="k">Last refresh</span>
            <span class="v">{refreshedRel}</span>
          </div>
        </div>

        <div class="tiles">
          <button class="tile" on:click={refresh} disabled={busyRefresh}>
            <span class="t-ic green">
              {#if busyRefresh}
                <span class="spin"></span>
              {:else}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 12A8 8 0 1 1 12 4" /><path d="M20 4V10H14" />
                </svg>
              {/if}
            </span>
            <span>{busyRefresh ? 'Refreshing…' : 'Refresh session'}</span>
          </button>

          <button class="tile" on:click={() => (showSystem = true)}>
            <span class="t-ic blue">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V12L15 14" />
              </svg>
            </span>
            <span>Sync status</span>
          </button>
        </div>

        {#if resetStage === 1}
          <div class="confirm">
            <p>Reset this device? Queued changes will be deleted.</p>
            <div class="confirm-row">
              <button class="btn" on:click={() => (resetStage = 0)}>Cancel</button>
              <button class="btn red" on:click={doReset}>Yes, reset</button>
            </div>
          </div>
        {:else}
          <button class="danger" on:click={() => (resetStage = 1)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7H20" /><path d="M9 7V5A2 2 0 0 1 11 3H13A2 2 0 0 1 15 5V7" />
              <path d="M6 7L7 20A2 2 0 0 0 9 22H15A2 2 0 0 0 17 20L18 7" />
            </svg>
            Reset device
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

{#if showSystem}
  <SystemSheet bind:open={showSystem} onClose={() => (showSystem = false)} />
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 220;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(14, 31, 63, 0.45);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .sheet {
    width: 100%;
    max-width: 440px;
    background: #f6f8fb;
    border-radius: 28px 28px 0 0;
    padding: 0 16px calc(20px + env(safe-area-inset-bottom));
    box-shadow: 0 -24px 60px rgba(14, 31, 63, 0.3);
    transition: transform 0.22s cubic-bezier(0.22, 0.8, 0.24, 1);
    touch-action: pan-y;
  }
  .sheet.dragging { transition: none; }

  .grab { padding: 12px 0 10px; display: flex; justify-content: center; }
  .grab span { width: 38px; height: 5px; border-radius: 3px; background: #d6dde8; }

  /* Header card */
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px;
    background: #fff;
    border: 1px solid #edf0f5;
    border-radius: 20px;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04);
  }
  .avatar {
    position: relative;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, #12b67f, #067552);
    color: #fff;
    font-size: 20px;
    font-weight: 800;
    box-shadow: 0 0 0 3px #fff, 0 0 0 4px #d4efe3, 0 10px 18px -8px rgba(6, 117, 82, 0.6);
  }
  .pip {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2.5px solid #fff;
    background: #b9c2d0;
  }
  .pip.ok { background: #22c55e; }
  .pip.warn { background: #f5a524; }
  .pip.err { background: #e23b3b; }

  .who { flex: 1; min-width: 0; }
  .name {
    font-size: 16.5px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #0e1f3f;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .loc {
    margin-top: 3px;
    font-size: 12.5px;
    color: #5c6a82;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 750;
    background: #e9eef4;
    color: #4d5d73;
  }
  .chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip.ok { background: #e3f6ee; color: #067552; }
  .chip.warn { background: #fff2dc; color: #8f5a00; }
  .chip.err { background: #ffe8e8; color: #b23a32; }

  /* Info list */
  .list {
    margin-top: 12px;
    background: #fff;
    border: 1px solid #edf0f5;
    border-radius: 20px;
    overflow: hidden;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 14px 16px;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    color: inherit;
  }
  .item + .item { border-top: 1px solid #edf0f5; }
  button.item { cursor: pointer; }
  button.item:active { background: #f6f8fb; }
  .k { font-size: 13px; color: #5c6a82; font-weight: 600; }
  .v {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 700;
    color: #0e1f3f;
  }
  .v.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .copy {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #f1f4f8;
    color: #5c6a82;
  }
  .copy.copied { background: #e3f6ee; color: #067552; }

  /* Action tiles */
  .tiles { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 14px;
    border: 1px solid #edf0f5;
    border-radius: 20px;
    background: #fff;
    font: inherit;
    font-size: 13.5px;
    font-weight: 750;
    letter-spacing: -0.02em;
    color: #0e1f3f;
    cursor: pointer;
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .tile:active:not(:disabled) { transform: scale(0.97); }
  .tile:disabled { opacity: 0.7; }
  .t-ic {
    width: 38px;
    height: 38px;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .t-ic.green { background: #e3f6ee; color: #0a9d6e; }
  .t-ic.blue { background: #e7f0ff; color: #2f6fe0; }

  /* Danger */
  .danger {
    margin-top: 12px;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 14px;
    border: 1px solid #ffd3cf;
    border-radius: 16px;
    background: #fff5f4;
    color: #b23a32;
    font: inherit;
    font-size: 13.5px;
    font-weight: 750;
    cursor: pointer;
  }
  .danger:active { background: #ffe8e8; }
  .confirm {
    margin-top: 12px;
    padding: 14px;
    border: 1px solid #ffd3cf;
    border-radius: 18px;
    background: #fff5f4;
  }
  .confirm p { margin: 0 0 12px; font-size: 13px; color: #8a2f28; font-weight: 600; line-height: 1.4; }
  .confirm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

  .btn {
    padding: 12px;
    border-radius: 13px;
    border: 1px solid #e3e8ef;
    background: #fff;
    color: #0e1f3f;
    font: inherit;
    font-size: 13.5px;
    font-weight: 750;
    cursor: pointer;
  }
  .btn.red { background: #e23b3b; border-color: #e23b3b; color: #fff; }
  .btn.solid {
    width: 100%;
    background: linear-gradient(135deg, #087451, #0b9a68);
    border: 0;
    color: #fff;
    box-shadow: 0 10px 22px -10px rgba(7, 116, 81, 0.5);
  }

  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .done { text-align: center; padding: 8px 6px 4px; }
  .done-tick {
    width: 60px;
    height: 60px;
    margin: 4px auto 12px;
    border-radius: 50%;
    background: #e3f6ee;
    color: #067552;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .done h3 { margin: 0 0 6px; font-size: 18px; letter-spacing: -0.03em; color: #0e1f3f; }
  .done p { margin: 0 0 18px; font-size: 13px; color: #5c6a82; line-height: 1.5; }

  @media (prefers-reduced-motion: reduce) {
    .sheet, .tile { transition: none; }
  }
</style>