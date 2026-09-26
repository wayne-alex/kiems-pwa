<script>
  import { createEventDispatcher } from 'svelte';
  import { session } from '../lib/session.js';
  import { apiFetch } from '../lib/api.js';
  import { cacheGet, cacheSet, enqueue, drainQueue } from '../lib/offline.js';
  import SyncBadge from '../components/SyncBadge.svelte';

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════
  let phase = 'loading';
  let errorMsg = '';
  let fromCache = false;

  let ward = null;
  let constituency = null;

  let selectedDate = '';
  let dateRelation = 'today';   // 'today' | 'past' | 'future'

  let kits = [];
  let submitting = false;
  let formError = null;
  let successModal = null;      // { count, queued } | null

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════
  function todayIso() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }
  function classifyDate(d) {
    const t = todayIso();
    if (d === t) return 'today';
    return d < t ? 'past' : 'future';
  }
  function formatDateLabel(iso) {
    if (!iso) return '';
    if (iso === todayIso()) return 'Today';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }

  // ═══════════════════════════════════════════════════════════
  // REACTIVE — follow session store
  // ═══════════════════════════════════════════════════════════
  $: if ($session.status === 'unbound') phase = 'unbound';

  $: if ($session.status === 'bound' && $session.ward && !ward) {
    ward = $session.ward;
    selectedDate = todayIso();
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
    phase = phase === 'ready' ? 'ready' : 'loading';
    formError = null;
    fromCache = false;

    const cacheKey = `entry:${ward.id}:${selectedDate}`;

    try {
      const data = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${selectedDate}`
      );

      if (data.error) {
        const cached = cacheGet(cacheKey);
        if (cached) {
          applyKits(cached);
          fromCache = true;
          phase = 'ready';
          return;
        }
        phase = 'error';
        errorMsg = data.error;
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
        errorMsg = err.message || 'Could not load kits.';
      }
    }
  }

  function applyKits(data) {
    dateRelation = classifyDate(selectedDate);

    // Merge queued edits on top of fetched data
    const queued = JSON.parse(localStorage.getItem('iebc:queue:ops') || '[]');
    const queuedByKit = new Map();
    for (const op of queued) {
      if (op.kind !== 'entry.submit' || op.payload.date !== selectedDate) continue;
      for (const e of op.payload.entries) {
        queuedByKit.set(String(e.kit_id), e);
      }
    }

    kits = (data.kits || []).map((k) => {
      const pending = queuedByKit.get(String(k.kit_id));
      const male = pending ? pending.male : (k.registered_male || 0);
      const female = pending ? pending.female : (k.registered_female || 0);
      const venue = pending ? pending.venue : (k.venue || '');
      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue,
        male,
        female,
        _orig_male: k.registered_male || 0,
        _orig_female: k.registered_female || 0,
        _orig_venue: (k.venue || '').trim(),
        has_registration: !!k.has_registration,
        is_venue_mapping: !!k.is_venue_mapping,
      };
    });
  }

  async function changeDate(newDate) {
    if (!newDate || newDate === selectedDate) return;
    selectedDate = newDate;
    await loadKits();
  }

  // ═══════════════════════════════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════════════════════════════
  $: totalMale = kits.reduce((s, k) => s + (parseInt(k.male) || 0), 0);
  $: totalFemale = kits.reduce((s, k) => s + (parseInt(k.female) || 0), 0);
  $: totalAll = totalMale + totalFemale;
  $: registeredCount = kits.filter((k) => k.has_registration).length;

  $: dirtyKits = kits.filter((k) => {
    const v = (k.venue || '').trim();
    return (
      (parseInt(k.male) || 0) !== k._orig_male ||
      (parseInt(k.female) || 0) !== k._orig_female ||
      v !== k._orig_venue
    );
  });

  $: canSubmit = dateRelation === 'today' && dirtyKits.length > 0 && !submitting;
  $: pendingKits = kits.filter((k) => !k.has_registration);
  $: enteredKits = kits.filter((k) => k.has_registration);

  // ═══════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════
  function validateKit(kit) {
    const venue = (kit.venue || '').trim();
    const m = parseInt(kit.male) || 0;
    const f = parseInt(kit.female) || 0;
    if (!venue) return 'Venue is required.';
    if (m === 0 && f === 0) return 'Enter at least one voter.';
    if (m < 0 || f < 0) return 'Counts cannot be negative.';
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // SAVE — single kit (network first, queue on failure)
  // ═══════════════════════════════════════════════════════════
  async function saveOne(kit) {
    const err = validateKit(kit);
    if (err) { formError = err; return; }

    submitting = true;
    formError = null;

    const entry = {
      kit_id: kit.kit_id,
      venue: kit.venue.trim(),
      male: parseInt(kit.male) || 0,
      female: parseInt(kit.female) || 0,
    };

    const payload = {
      fingerprint: $session.fingerprint,
      date: selectedDate,
      entries: [entry],
    };

    try {
      const body = new URLSearchParams();
      body.append('fingerprint', payload.fingerprint);
      body.append('date', payload.date);
      body.append('kit_id[]', entry.kit_id);
      body.append('venue[]', entry.venue);
      body.append('registered_male[]', String(entry.male));
      body.append('registered_female[]', String(entry.female));

      const res = await apiFetch('/kiems/submit-entries/', { method: 'POST', body });

      if (!res.ok) {
        formError = res.error || 'Could not save.';
        return;
      }

      kit._orig_male = entry.male;
      kit._orig_female = entry.female;
      kit._orig_venue = entry.venue;
      kit.has_registration = entry.male + entry.female > 0;

      kits = [...kits];
      successModal = { count: 1, queued: false };
    } catch (e) {
      enqueue('entry.submit', payload);
      kit._orig_male = entry.male;
      kit._orig_female = entry.female;
      kit._orig_venue = entry.venue;
      kit.has_registration = entry.male + entry.female > 0;
      kits = [...kits];
      successModal = { count: 1, queued: true };
    } finally {
      submitting = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SUBMIT — bulk (network first, queue on failure)
  // ═══════════════════════════════════════════════════════════
  async function submitAll() {
    formError = null;

    const toSubmit = dirtyKits.filter((k) => {
      const err = validateKit(k);
      if (err) {
        formError = `${k.kit_name}: ${err}`;
        return false;
      }
      return true;
    });

    if (formError) return;
    if (toSubmit.length === 0) { formError = 'No changes to submit.'; return; }

    submitting = true;

    const payload = {
      fingerprint: $session.fingerprint,
      date: selectedDate,
      entries: toSubmit.map((k) => ({
        kit_id: k.kit_id,
        venue: k.venue.trim(),
        male: parseInt(k.male) || 0,
        female: parseInt(k.female) || 0,
      })),
    };

    try {
      const body = new URLSearchParams();
      body.append('fingerprint', payload.fingerprint);
      body.append('date', payload.date);
      payload.entries.forEach((e) => {
        body.append('kit_id[]', e.kit_id);
        body.append('venue[]', e.venue);
        body.append('registered_male[]', String(e.male));
        body.append('registered_female[]', String(e.female));
      });

      const res = await apiFetch('/kiems/submit-entries/', { method: 'POST', body });

      if (!res.ok) {
        formError = res.error || 'Could not submit.';
        return;
      }

      kits = kits.map((k) => {
        const m = parseInt(k.male) || 0;
        const f = parseInt(k.female) || 0;
        return {
          ...k,
          _orig_male: m,
          _orig_female: f,
          _orig_venue: (k.venue || '').trim(),
          has_registration: m + f > 0,
        };
      });

      successModal = { count: res.saved || toSubmit.length, queued: false };
    } catch (e) {
      enqueue('entry.submit', payload);
      kits = kits.map((k) => {
        const m = parseInt(k.male) || 0;
        const f = parseInt(k.female) || 0;
        return {
          ...k,
          _orig_male: m,
          _orig_female: f,
          _orig_venue: (k.venue || '').trim(),
          has_registration: m + f > 0,
        };
      });
      successModal = { count: toSubmit.length, queued: true };
    } finally {
      submitting = false;
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
      <div class="header-title">Registration</div>
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
      <div class="header-title">Registration</div>
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
      <div class="header-title">Registration</div>
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
    <!-- Header: back + ward + date chip + sync badge -->
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
          <div class="ward-sub">KIEMS Registration</div>
        {/if}
      </div>

      <SyncBadge />

      <label class="date-chip" class:past={dateRelation === 'past'}
                            class:future={dateRelation === 'future'}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2"/>
          <path d="M3 10 H21 M8 3 V7 M16 3 V7"/>
        </svg>
        <span>{formatDateLabel(selectedDate)}</span>
        <input
          type="date"
          bind:value={selectedDate}
          on:change={() => changeDate(selectedDate)}
          aria-label="Select date"
        />
      </label>
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

    {#if dateRelation === 'past'}
      <div class="notice past">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 8 V12 L15 14"/>
        </svg>
        <span>Past date — read-only historical record.</span>
      </div>
    {:else if dateRelation === 'future'}
      <div class="notice future">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2"/>
          <path d="M3 10 H21 M8 3 V7 M16 3 V7"/>
        </svg>
        <span>Future date — venue planning only. Counts are entered on election day.</span>
      </div>
    {/if}

    {#if dateRelation !== 'future'}
      <div class="summary">
        <div class="summary-total">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="9" cy="8" r="3.2"/>
            <path d="M3 20 C3 16.5 5.7 14 9 14 C12.3 14 15 16.5 15 20"/>
            <circle cx="17.5" cy="9" r="2.6"/>
            <path d="M14.5 20 C14.5 17.4 15.8 15.4 17.5 15.4 C19.2 15.4 20.5 17.4 20.5 20"/>
          </svg>
          <span class="summary-num">{totalAll}</span>
        </div>
        <div class="summary-genders">
          <span class="m">M <b>{totalMale}</b></span>
          <span class="f">F <b>{totalFemale}</b></span>
        </div>
        <div class="summary-kits">{registeredCount}/{kits.length} kits</div>
      </div>
    {/if}

    {#if kits.length === 0}
      <div class="empty"><p>No kits assigned to this ward.</p></div>

    {:else if dateRelation === 'today'}
      {#if pendingKits.length > 0}
        <div class="section-label pending">
          Pending <span class="count">{pendingKits.length}</span>
        </div>
        {#each pendingKits as kit (kit.kit_id)}
          {@const err = validateKit(kit)}
          <div class="kit-card" class:dirty={kit.male !== kit._orig_male || kit.female !== kit._orig_female || (kit.venue || '').trim() !== kit._orig_venue}>
            <div class="kit-head">
              <div class="kit-left">
                <span class="kit-name">{kit.kit_name}</span>
                <span class="kit-serial">{kit.serial_no}</span>
              </div>
              <span class="kit-status pending">Pending</span>
            </div>

            <div class="kit-input">
              <svg class="kit-icon" viewBox="0 0 24 24" width="14" height="14"
                   fill="none" stroke="currentColor" stroke-width="1.9"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z"/>
                <circle cx="11.5" cy="9.5" r="2.5"/>
              </svg>
              <input type="text" bind:value={kit.venue}
                     placeholder="Venue" autocomplete="off" spellcheck="false" />
            </div>

            <div class="count-grid">
              <div class="count-input male">
                <span class="count-label">M</span>
                <input type="number" min="0" inputmode="numeric"
                       bind:value={kit.male} placeholder="0" />
              </div>
              <div class="count-input female">
                <span class="count-label">F</span>
                <input type="number" min="0" inputmode="numeric"
                       bind:value={kit.female} placeholder="0" />
              </div>
            </div>

            <div class="kit-footer">
              <span class="kit-total">Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b></span>
              <button class="save-btn" on:click={() => saveOne(kit)}
                      disabled={submitting || !!err}>
                Save
              </button>
            </div>
          </div>
        {/each}
      {/if}

      {#if enteredKits.length > 0}
        <div class="section-label entered">
          Registered <span class="count">{enteredKits.length}</span>
        </div>
        {#each enteredKits as kit (kit.kit_id)}
          {@const err = validateKit(kit)}
          <div class="kit-card" class:dirty={kit.male !== kit._orig_male || kit.female !== kit._orig_female || (kit.venue || '').trim() !== kit._orig_venue}>
            <div class="kit-head">
              <div class="kit-left">
                <span class="kit-name">{kit.kit_name}</span>
                <span class="kit-serial">{kit.serial_no}</span>
              </div>
              <span class="kit-status entered">Entered</span>
            </div>

            <div class="kit-input">
              <svg class="kit-icon" viewBox="0 0 24 24" width="14" height="14"
                   fill="none" stroke="currentColor" stroke-width="1.9"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z"/>
                <circle cx="11.5" cy="9.5" r="2.5"/>
              </svg>
              <input type="text" bind:value={kit.venue}
                     placeholder="Venue" autocomplete="off" spellcheck="false" />
            </div>

            <div class="count-grid">
              <div class="count-input male">
                <span class="count-label">M</span>
                <input type="number" min="0" inputmode="numeric"
                       bind:value={kit.male} placeholder="0" />
              </div>
              <div class="count-input female">
                <span class="count-label">F</span>
                <input type="number" min="0" inputmode="numeric"
                       bind:value={kit.female} placeholder="0" />
              </div>
            </div>

            <div class="kit-footer">
              <span class="kit-total">Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b></span>
              <button class="save-btn" on:click={() => saveOne(kit)}
                      disabled={submitting || !!err}>
                Update
              </button>
            </div>
          </div>
        {/each}
      {/if}

      <div class="actions">
        <button class="cta" on:click={submitAll} disabled={!canSubmit}>
          {#if submitting}Submitting…{:else}Submit entries{/if}
        </button>
        <div class="hint" class:ready={dirtyKits.length > 0}>
          {#if dirtyKits.length > 0}
            {dirtyKits.length} kit{dirtyKits.length === 1 ? '' : 's'} ready to submit
          {:else}
            Enter counts to enable submit
          {/if}
        </div>

        {#if formError}
          <div class="toast err" role="alert">{formError}</div>
        {/if}
      </div>

    {:else if dateRelation === 'past'}
      {#each kits as kit (kit.kit_id)}
        <div class="kit-card readonly">
          <div class="kit-head">
            <div class="kit-left">
              <span class="kit-name">{kit.kit_name}</span>
              <span class="kit-serial">{kit.serial_no}</span>
            </div>
            <span class="kit-status" class:entered={kit.has_registration}
                                    class:pending={!kit.has_registration}>
              {kit.has_registration ? 'Entered' : 'No data'}
            </span>
          </div>

          {#if kit.venue}
            <div class="readonly-row">
              <span class="readonly-label">Venue</span>
              <span class="readonly-value">{kit.venue}</span>
            </div>
          {/if}

          <div class="count-grid readonly-grid">
            <div class="count-input male">
              <span class="count-label">M</span>
              <span class="count-value">{kit.male}</span>
            </div>
            <div class="count-input female">
              <span class="count-label">F</span>
              <span class="count-value">{kit.female}</span>
            </div>
          </div>

          <div class="kit-footer">
            <span class="kit-total">Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b></span>
          </div>
        </div>
      {/each}

    {:else if dateRelation === 'future'}
      {#if kits.some((k) => k.venue)}
        {#each kits.filter((k) => k.venue) as kit (kit.kit_id)}
          <div class="kit-card readonly">
            <div class="kit-head">
              <div class="kit-left">
                <span class="kit-name">{kit.kit_name}</span>
                <span class="kit-serial">{kit.serial_no}</span>
              </div>
              <span class="kit-status mapped">Mapped</span>
            </div>
            <div class="readonly-row">
              <span class="readonly-label">Venue</span>
              <span class="readonly-value">{kit.venue}</span>
            </div>
            <div class="future-note">
              Voter counts will be entered on election day.
            </div>
          </div>
        {/each}
      {:else}
        <div class="empty"><p>No venues pre-mapped for this date.</p></div>
      {/if}
    {/if}

  </div>
{/if}

<!-- ═══════════════════════════════════════════════════════════
     SUCCESS MODAL
     ═══════════════════════════════════════════════════════════ -->
{#if successModal}
  <div class="modal-overlay" on:click={() => (successModal = null)}
       on:keydown role="presentation">
    <div class="modal-sheet" on:click|stopPropagation on:keydown role="dialog" aria-modal="true">
      <div class="grabber"></div>

      <div class="check-wrap" class:queued={successModal.queued}>
        <svg viewBox="0 0 64 64" class="check-svg">
          {#if successModal.queued}
            <!-- cloud-check for offline -->
            <path class="check-circle" d="M20 30 A14 14 0 0 1 44 26 A10 10 0 0 1 46 46 H20 A8 8 0 0 1 20 30 Z"></path>
            <path class="check-mark" d="M26 38 L31 43 L40 33"></path>
          {:else}
            <circle class="check-circle" cx="32" cy="32" r="28"></circle>
            <path class="check-mark" d="M20 33 L28 41 L44 23"></path>
          {/if}
        </svg>
      </div>

      <h3 class="modal-title">
        {successModal.queued ? 'Saved offline' : 'Entries submitted'}
      </h3>
      <p class="modal-subtitle">
        {successModal.count}
        {successModal.count === 1 ? 'entry' : 'entries'}
        {successModal.queued ? 'will sync when you reconnect' : 'recorded'}
        for {formatDateLabel(selectedDate)}.
      </p>

      <div class="modal-actions">
        <button class="modal-btn primary" on:click={() => (successModal = null)}>
          Done
        </button>
      </div>
    </div>
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
    gap: 8px;
    margin-bottom: 18px;
  }
  .back-btn {
    width: 34px; height: 34px;
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
    position: relative;
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
    cursor: pointer;
    transition: background .2s var(--ease);
  }
  .date-chip:hover { background: var(--paper-2); }
  .date-chip.past   { color: var(--ink-3); }
  .date-chip.future { color: var(--male); }
  .date-chip input[type="date"] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
    height: 100%;
    border: none;
    padding: 0;
    font: inherit;
  }

  /* ═══════════════════════════════════════
     NOTICES
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
  .notice svg { flex-shrink: 0; }
  .notice.past   { background: var(--paper-2); color: var(--ink-2); }
  .notice.future { background: #E5EEF9; color: var(--male); }
  .notice.cached {
    background: var(--amber-tint, #FFF4DE);
    color: var(--warn, #9A6B00);
  }

  /* ═══════════════════════════════════════
     SUMMARY
     ═══════════════════════════════════════ */
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 16px;
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1);
    margin-bottom: 18px;
  }
  .summary-total {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 17px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.02em;
  }
  .summary-total svg { color: var(--ink-2); }
  .summary-num { font-family: var(--font-mono); }
  .summary-genders {
    display: flex;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
  }
  .summary-genders span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 999px;
    font-family: var(--font-mono);
  }
  .summary-genders .m { background: var(--male-tint); color: var(--male); }
  .summary-genders .f { background: var(--female-tint); color: var(--female); }
  .summary-genders b { font-weight: 700; }
  .summary-kits {
    font-size: 11px;
    color: var(--ink-2);
    font-weight: 500;
    background: var(--paper-2);
    padding: 4px 10px;
    border-radius: 999px;
  }

  /* ═══════════════════════════════════════
     SECTIONS
     ═══════════════════════════════════════ */
  .section-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-2);
    margin: 18px 2px 10px;
  }
  .section-label:first-child { margin-top: 4px; }
  .section-label .count {
    background: var(--paper-2);
    color: var(--ink-2);
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 10px;
    letter-spacing: 0;
  }
  .section-label.pending { color: var(--warn); }
  .section-label.pending .count { background: var(--amber-tint); color: var(--warn); }
  .section-label.entered { color: var(--accent); }
  .section-label.entered .count { background: var(--accent-soft); color: var(--accent); }

  /* ═══════════════════════════════════════
     KIT CARDS
     ═══════════════════════════════════════ */
  .kit-card {
    padding: 14px;
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-1);
    margin-bottom: 10px;
    border: 1.5px solid transparent;
    transition: border-color .25s var(--ease), box-shadow .25s var(--ease);
    overflow: hidden;
  }
  .kit-card.dirty {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .kit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .kit-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .kit-name {
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .kit-serial {
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 500;
    color: var(--ink-3);
    background: var(--paper-2);
    padding: 3px 7px;
    border-radius: 6px;
    letter-spacing: 0.02em;
  }
  .kit-status {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .kit-status.pending { background: var(--amber-tint); color: var(--warn); }
  .kit-status.entered { background: var(--accent-soft); color: var(--accent); }
  .kit-status.mapped  { background: var(--male-tint); color: var(--male); }

  .kit-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    background: var(--paper-2);
    border-radius: 10px;
    border: 1.5px solid transparent;
    margin-bottom: 8px;
    transition: border-color .2s var(--ease), background .2s var(--ease);
    min-width: 0;
    box-sizing: border-box;
  }
  .kit-input:focus-within {
    background: var(--surface);
    border-color: var(--accent);
  }
  .kit-icon { color: var(--ink-4); flex-shrink: 0; }
  .kit-input:focus-within .kit-icon { color: var(--accent); }
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
    padding: 0;
  }
  .kit-input input::placeholder { color: var(--ink-4); font-weight: 400; }

  .count-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }
  .count-input {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 10px;
    background: var(--paper-2);
    border-radius: 10px;
    border-left: 3px solid transparent;
    transition: border-color .2s var(--ease), background .2s var(--ease);
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
  }
  .count-input.male   { border-left-color: var(--male); }
  .count-input.female { border-left-color: var(--female); }
  .count-input:focus-within { background: var(--surface); }
  .count-label { font-size: 11px; font-weight: 700; flex-shrink: 0; }
  .count-input.male   .count-label { color: var(--male); }
  .count-input.female .count-label { color: var(--female); }
  .count-input input {
    flex: 1;
    min-width: 0;
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-size: 14px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--ink);
    text-align: right;
    padding: 0;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .count-input input::-webkit-outer-spin-button,
  .count-input input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .kit-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .kit-total {
    font-size: 11.5px;
    color: var(--ink-2);
    letter-spacing: -0.005em;
  }
  .kit-total b {
    font-family: var(--font-mono);
    color: var(--ink);
    font-weight: 700;
    font-size: 13px;
    margin-left: 4px;
  }
  .save-btn {
    padding: 7px 16px;
    border: none;
    border-radius: 9px;
    background: var(--ink);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.005em;
    cursor: pointer;
    transition: transform .2s var(--ease), background .2s var(--ease), opacity .2s var(--ease);
  }
  .save-btn:hover:not(:disabled) { background: #1a1a1a; transform: translateY(-1px); }
  .save-btn:active:not(:disabled) { transform: scale(.97); }
  .save-btn:disabled { background: var(--ink-4); cursor: not-allowed; opacity: .6; }

  .readonly-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 11px;
    background: var(--paper-2);
    border-radius: 10px;
    margin-bottom: 8px;
    font-size: 12.5px;
  }
  .readonly-label { color: var(--ink-3); font-weight: 500; }
  .readonly-value {
    color: var(--ink);
    font-weight: 600;
    text-align: right;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .readonly-grid .count-input { background: var(--paper-2); }
  .count-value {
    flex: 1;
    text-align: right;
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 14px;
    color: var(--ink);
  }
  .future-note {
    font-size: 11.5px;
    color: var(--ink-3);
    font-style: italic;
    margin-top: 4px;
    padding-left: 2px;
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
    transition: transform .2s var(--ease), background .2s var(--ease), opacity .2s var(--ease);
    box-shadow: 0 8px 24px rgba(10,10,10,.14);
  }
  .cta:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 12px 32px rgba(10,10,10,.18); }
  .cta:active:not(:disabled) { transform: scale(.98); }
  .cta:disabled { background: var(--ink-4); cursor: not-allowed; box-shadow: none; opacity: .7; }
  .hint {
    text-align: center;
    font-size: 11.5px;
    color: var(--ink-3);
    margin-top: 10px;
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
  .toast.err { background: #FBE8E6; color: var(--danger); }

  /* ═══════════════════════════════════════
     EMPTY + CENTER
     ═══════════════════════════════════════ */
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

  /* ═══════════════════════════════════════
     SUCCESS MODAL
     ═══════════════════════════════════════ */
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(10,10,10,.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    animation: fadein .2s var(--ease) both;
  }
  .modal-sheet {
    width: 100%;
    max-width: 440px;
    background: var(--surface);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    padding: 12px 24px calc(24px + env(safe-area-inset-bottom));
    text-align: center;
    animation: rise .3s var(--ease) both;
  }
  .grabber {
    width: 36px;
    height: 4px;
    border-radius: 3px;
    background: var(--hairline-2);
    margin: 0 auto 20px;
  }
  .check-wrap {
    width: 68px;
    height: 68px;
    margin: 0 auto 14px;
  }
  .check-svg { width: 100%; height: 100%; }
  .check-circle {
    fill: none;
    stroke: var(--accent);
    stroke-width: 4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 200;
    stroke-dashoffset: 200;
    animation: draw-stroke .5s var(--ease) forwards;
  }
  .check-mark {
    fill: none;
    stroke: var(--accent);
    stroke-width: 5;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 40;
    stroke-dashoffset: 40;
    animation: draw-stroke .35s var(--ease) forwards .45s;
  }
  .check-wrap.queued .check-circle {
    stroke: var(--warn, #9A6B00);
  }
  .check-wrap.queued .check-mark {
    stroke: var(--warn, #9A6B00);
  }
  @keyframes draw-stroke { to { stroke-dashoffset: 0; } }

  .modal-title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin: 0 0 6px;
  }
  .modal-subtitle {
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.5;
    margin: 0 0 20px;
  }
  .modal-actions { display: flex; gap: 8px; }
  .modal-btn {
    flex: 1;
    padding: 13px;
    border: none;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: transform .2s var(--ease), background .2s var(--ease);
  }
  .modal-btn.primary { background: var(--ink); color: #fff; }
  .modal-btn.primary:hover { background: #1a1a1a; }
  .modal-btn:active { transform: scale(.97); }

  @media (min-width: 500px) {
    .modal-overlay { align-items: center; }
    .modal-sheet {
      border-radius: var(--r-xl);
      max-width: 380px;
      padding: 24px 24px 20px;
    }
  }
</style>