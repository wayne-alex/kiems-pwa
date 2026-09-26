<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { session } from '../lib/session.js';
  import { apiFetch } from '../lib/api.js';
  import { cacheGet, cacheSet, enqueue, drainQueue } from '../lib/offline.js';
  import SyncBadge from '../components/SyncBadge.svelte';

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════
  let phase = 'loading';        // 'loading' | 'unbound' | 'error' | 'ready'
  let errorMsg = '';
  let fromCache = false;

  let ward = null;
  let constituency = null;
  let scheduleDate = '';
  let kits = [];

  let saving = false;
  let saveMsg = null;           // { kind: 'ok' | 'queued' | 'err', text }
  let toastTimer = null;

  // ═══════════════════════════════════════════════════════════
  // REACTIVE — follow session store
  // ═══════════════════════════════════════════════════════════
  $: if ($session.status === 'unbound') phase = 'unbound';

  $: if ($session.status === 'bound' && $session.ward && !ward) {
    ward = $session.ward;
    loadKits();
  }

  $: if ($session.status === 'error') {
    phase = 'error';
    errorMsg = $session.error || 'Session error.';
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD — network first, cache fallback
  // ═══════════════════════════════════════════════════════════
  async function loadKits() {
    if (!ward) return;
    phase = 'loading';
    fromCache = false;

    const cacheKey = `movement:${ward.id}`;

    try {
      const data = await apiFetch(
        `/movement/kits/?ward_id=${encodeURIComponent(ward.id)}`
      );

      if (!data.ok) {
        const cached = cacheGet(cacheKey);
        if (cached) {
          applyKits(cached);
          fromCache = true;
          phase = 'ready';
          return;
        }
        phase = 'error';
        errorMsg = data.error || 'Could not load kits.';
        return;
      }

      cacheSet(cacheKey, data);
      applyKits(data);
      phase = 'ready';
    } catch (err) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        applyKits(cached);
        fromCache = true;
        phase = 'ready';
        drainQueue();
      } else {
        phase = 'error';
        errorMsg = err.message || 'Failed to load.';
      }
    }
  }

  function applyKits(data) {
    constituency = {
      id: data.constituency_id,
      name: data.constituency_name,
    };
    scheduleDate = data.schedule_date;

    // Merge queued edits on top of fetched data
    const queued = JSON.parse(localStorage.getItem('iebc:queue:ops') || '[]');
    const queuedByKit = new Map();
    for (const op of queued) {
      if (op.kind !== 'movement.save') continue;
      for (const e of op.payload.entries) {
        queuedByKit.set(String(e.kit_id), e.venue);
      }
    }

    kits = (data.kits || []).map((k) => {
      const pendingVenue = queuedByKit.get(String(k.kit_id));
      const venue = pendingVenue !== undefined ? pendingVenue : (k.venue || '');
      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue,
        _original: (k.venue || '').trim(),
      };
    });
  }

  onDestroy(() => {
    if (toastTimer) clearTimeout(toastTimer);
  });

  // ═══════════════════════════════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════════════════════════════
  $: anyDirty = kits.some((k) => (k.venue || '').trim() !== k._original);
  $: filledCount = kits.filter((k) => (k.venue || '').trim()).length;

  // ═══════════════════════════════════════════════════════════
  // SAVE — network first, queue on failure
  // ═══════════════════════════════════════════════════════════
  async function saveAll() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    saveMsg = null;

    const entries = kits
      .filter((k) => (k.venue || '').trim() && k.venue.trim() !== k._original)
      .map((k) => ({ kit_id: k.kit_id, venue: k.venue.trim() }));

    if (entries.length === 0) {
      saveMsg = { kind: 'err', text: 'Nothing to save.' };
      return;
    }

    const payload = {
      ward_id: ward.id,
      fingerprint: $session.fingerprint,
      schedule_date: scheduleDate,
      entries,
    };

    saving = true;

    // Optimistic: freeze current values as new baseline
    const snapshotKits = kits;
    kits = kits.map((k) => ({ ...k, _original: (k.venue || '').trim() }));

    try {
      const res = await apiFetch('/movement/save/', {
        method: 'POST',
        json: payload,
      });

      if (!res.ok) {
        kits = snapshotKits;
        saveMsg = { kind: 'err', text: res.error || 'Could not save.' };
        return;
      }

      const saved = (res.created || 0) + (res.updated || 0);
      saveMsg = {
        kind: 'ok',
        text: `${saved} venue${saved === 1 ? '' : 's'} saved.`,
      };

      // Update cache with the newly saved state
      const cached = cacheGet(`movement:${ward.id}`) || {};
      cacheSet(`movement:${ward.id}`, {
        ...cached,
        kits: kits.map((k) => ({
          kit_id: k.kit_id,
          kit_name: k.kit_name,
          serial_no: k.serial_no,
          venue: k.venue,
          has_schedule: true,
        })),
      });
    } catch (err) {
      // Network failure → queue it
      enqueue('movement.save', payload);
      saveMsg = {
        kind: 'queued',
        text: 'Saved offline — will sync when online.',
      };
    } finally {
      saving = false;
      toastTimer = setTimeout(() => {
        saveMsg = null;
        toastTimer = null;
      }, 3500);
    }
  }
</script>

<!-- ═══════════════════════════════════════════════════════════
     LOADING
     ═══════════════════════════════════════════════════════════ -->
{#if phase === 'loading'}
  <div class="page">
    <header class="header-row">
      <button class="back-btn" on:click={() => dispatch('back')} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6 L9 12 L15 18"/>
        </svg>
      </button>
      <div class="header-title">Movement plan</div>
      <span class="header-spacer"></span>
    </header>

    <div class="center">
      <div class="spinner"></div>
      <p class="center-text">Loading kits…</p>
    </div>
  </div>

<!-- ═══════════════════════════════════════════════════════════
     UNBOUND
     ═══════════════════════════════════════════════════════════ -->
{:else if phase === 'unbound'}
  <div class="page">
    <header class="header-row">
      <button class="back-btn" on:click={() => dispatch('back')} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6 L9 12 L15 18"/>
        </svg>
      </button>
      <div class="header-title">Movement plan</div>
      <span class="header-spacer"></span>
    </header>

    <div class="center">
      <div class="state-tile">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="10" width="16" height="11" rx="2"/>
          <path d="M8 10 V7 A4 4 0 0 1 16 7 V10"/>
        </svg>
      </div>
      <h2 class="center-title">Set up this device</h2>
      <p class="center-text">Choose your ward to continue. You only do this once.</p>
    </div>
  </div>

<!-- ═══════════════════════════════════════════════════════════
     ERROR
     ═══════════════════════════════════════════════════════════ -->
{:else if phase === 'error'}
  <div class="page">
    <header class="header-row">
      <button class="back-btn" on:click={() => dispatch('back')} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6 L9 12 L15 18"/>
        </svg>
      </button>
      <div class="header-title">Movement plan</div>
      <span class="header-spacer"></span>
    </header>

    <div class="center">
      <div class="state-tile danger">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 8 V13"/>
          <circle cx="12" cy="16.5" r="0.6" fill="currentColor"/>
        </svg>
      </div>
      <h2 class="center-title">Something went wrong</h2>
      <p class="center-text">{errorMsg}</p>
    </div>
  </div>

<!-- ═══════════════════════════════════════════════════════════
     READY
     ═══════════════════════════════════════════════════════════ -->
{:else if phase === 'ready'}
  <div class="page">
    <header class="header-row">
      <button class="back-btn" on:click={() => dispatch('back')} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6 L9 12 L15 18"/>
        </svg>
      </button>

      <div class="meta-left">
        <div class="ward-name">{ward.name}</div>
        {#if constituency && constituency.name}
          <div class="ward-sub">{constituency.name} Constituency</div>
        {:else}
          <div class="ward-sub">Movement plan</div>
        {/if}
      </div>

      <SyncBadge />

      <div class="date-chip">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2"/>
          <path d="M3 10 H21 M8 3 V7 M16 3 V7"/>
        </svg>
        <span>Tomorrow</span>
      </div>
    </header>

    {#if fromCache}
      <div class="notice cached">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 8 V12 L15 14"/>
        </svg>
        <span>Offline — showing cached data. Changes will sync when online.</span>
      </div>
    {/if}

    {#if kits.length === 0}
      <div class="empty">
        <p>No kits assigned to this ward.</p>
      </div>
    {:else}
      <div class="kits">
        {#each kits as kit (kit.kit_id)}
          <div class="kit" class:filled={kit.venue.trim()}>
            <div class="kit-head">
              <span class="kit-name">{kit.kit_name}</span>
              <span class="kit-serial">{kit.serial_no}</span>
            </div>
            <div class="kit-input">
              <svg class="kit-input-icon" viewBox="0 0 24 24"
                   width="14" height="14" fill="none"
                   stroke="currentColor" stroke-width="1.9"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z"/>
                <circle cx="11.5" cy="9.5" r="2.5"/>
              </svg>
              <input
                type="text"
                bind:value={kit.venue}
                placeholder="Enter venue for tomorrow"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
          </div>
        {/each}
      </div>

      <div class="actions">
        <button
          class="cta"
          on:click={saveAll}
          disabled={!anyDirty || saving}
        >
          {#if saving}Saving…{:else}Save movement plan{/if}
        </button>

        <div class="hint" class:ready={anyDirty}>
          {#if anyDirty}
            Unsaved changes
          {:else if filledCount > 0}
            {filledCount} of {kits.length} venues set
          {:else}
            Enter a venue to enable saving
          {/if}
        </div>

        {#if saveMsg}
          <div class="toast {saveMsg.kind}" role="status">
            {saveMsg.text}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .page {
    padding: 22px 18px calc(28px + env(safe-area-inset-bottom));
    min-height: 100%;
    animation: rise .35s var(--ease) both;
  }

  /* ═══════════════════════════════════════
     HEADER
     ═══════════════════════════════════════ */
  .header-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
  }
  .back-btn {
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 10px;
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow-1);
    cursor: pointer;
    flex-shrink: 0;
    transition: transform .2s var(--ease);
  }
  .back-btn:active { transform: scale(.94); }
  .header-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--ink);
  }
  .header-spacer { width: 34px; height: 34px; }

  .meta-left { flex: 1; min-width: 0; }
  .ward-name {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.035em;
    color: var(--ink);
    line-height: 1.1;
    margin-bottom: 2px;
  }
  .ward-sub {
    font-size: 12px;
    color: var(--ink-3);
    letter-spacing: -0.005em;
  }

  .date-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    background: var(--surface);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-2);
    box-shadow: var(--shadow-1);
    flex-shrink: 0;
    letter-spacing: 0.01em;
  }

  /* ═══════════════════════════════════════
     OFFLINE NOTICE
     ═══════════════════════════════════════ */
  .notice {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 14px;
    border-radius: var(--r);
    font-size: 12px;
    font-weight: 500;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  .notice.cached {
    background: var(--amber-tint, #FFF4DE);
    color: var(--warn, #9A6B00);
  }
  .notice svg { flex-shrink: 0; }

  /* ═══════════════════════════════════════
     KITS
     ═══════════════════════════════════════ */
  .kits {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .kit {
    padding: 14px 14px 12px;
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1);
    transition: box-shadow .3s var(--ease);
    overflow: hidden;
  }
  .kit.filled { box-shadow: var(--shadow-2); }

  .kit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .kit-name {
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ink);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kit-serial {
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 500;
    color: var(--ink-3);
    background: var(--paper-2);
    padding: 3px 7px;
    border-radius: 6px;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .kit-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    background: var(--paper-2);
    border-radius: 10px;
    border: 1.5px solid transparent;
    transition: border-color .2s var(--ease), background .2s var(--ease);
    min-width: 0;
    box-sizing: border-box;
  }
  .kit-input:focus-within {
    background: var(--surface);
    border-color: var(--accent);
  }
  .kit-input-icon {
    color: var(--ink-4);
    flex-shrink: 0;
    transition: color .2s var(--ease);
  }
  .kit-input:focus-within .kit-input-icon { color: var(--accent); }
  .kit-input input {
    flex: 1;
    min-width: 0;
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-size: 13.5px;
    font-family: inherit;
    color: var(--ink);
    letter-spacing: -0.005em;
    padding: 0;
  }
  .kit-input input::placeholder {
    color: var(--ink-4);
    font-weight: 400;
  }

  /* ═══════════════════════════════════════
     ACTIONS
     ═══════════════════════════════════════ */
  .actions { margin-top: 22px; }
  .cta {
    width: 100%;
    padding: 15px;
    border: none;
    border-radius: 14px;
    background: var(--ink);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: transform .2s var(--ease), opacity .2s var(--ease), background .2s var(--ease);
    box-shadow: 0 8px 24px rgba(10,10,10,.14);
  }
  .cta:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 12px 32px rgba(10,10,10,.18);
  }
  .cta:active:not(:disabled) { transform: scale(.98); }
  .cta:disabled {
    background: var(--ink-4);
    cursor: not-allowed;
    box-shadow: none;
    opacity: .7;
  }
  .hint {
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-3);
    margin-top: 10px;
    letter-spacing: -0.005em;
    transition: color .2s var(--ease);
  }
  .hint.ready { color: var(--accent); font-weight: 600; }

  .toast {
    margin-top: 10px;
    padding: 11px 14px;
    border-radius: 10px;
    font-size: 12.5px;
    font-weight: 500;
    animation: rise .3s var(--ease) both;
  }
  .toast.ok     { background: var(--accent-soft); color: var(--accent); }
  .toast.err    { background: #FBE8E6; color: var(--danger); }
  .toast.queued {
    background: var(--amber-tint, #FFF4DE);
    color: var(--warn, #9A6B00);
  }

  /* ═══════════════════════════════════════
     CENTER STATES
     ═══════════════════════════════════════ */
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 32px 60px;
    text-align: center;
    min-height: 50vh;
  }
  .center-title {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin: 16px 0 6px;
  }
  .center-text {
    font-size: 13px;
    color: var(--ink-3);
    line-height: 1.5;
    max-width: 280px;
    margin: 0;
  }
  .state-tile {
    width: 52px;
    height: 52px;
    border-radius: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .state-tile.danger { background: #FBE8E6; color: var(--danger); }

  .spinner {
    width: 26px;
    height: 26px;
    border: 2.5px solid var(--hairline-2);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--ink-3);
    font-size: 13px;
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1);
  }
  .empty p { margin: 0; }
</style>