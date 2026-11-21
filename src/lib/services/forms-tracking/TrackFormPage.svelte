<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache, Queue } from '$lib/core/db.js';
  import { enqueue, discardOp, subscribeQueue } from '$lib/core/queue.js';
  import { drainQueue } from '$lib/core/sync.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';
  import CountStepper from '$lib/../components/CountStepper.svelte';

  const dispatch = createEventDispatcher();

  const REASONS = [
    { value: 'TORN', label: 'Torn' },
    { value: 'MISPRINT', label: 'Misprint' },
    { value: 'WRONG_ENTRY', label: 'Wrong entry' },
    { value: 'WATER_DAMAGE', label: 'Water damage' },
    { value: 'OTHER', label: 'Other' },
  ];
  const reasonLabel = (v) => REASONS.find((r) => r.value === v)?.label || v;

  const pad = (n) => String(n).padStart(2, '0');
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ── State ─────────────────────────────────────────────────
  let phase = 'idle'; // idle | loading | ready | error | unbound
  let errorMsg = '';
  let ward = null;
  let activeTab = 'allocate'; // allocate | spoil | history

  let selectedDate = todayIso();
  let receipts = [];
  let kits = [];
  let history = [];
  let receiptId = '';
  let detail = null;

  // allocate
  let allocKitId = '';
  let allocForms = 0;
  let allocNote = '';
  let allocating = false;

  // spoil
  let spoilKitId = '';
  let spoilSerial = '';
  let spoilReason = 'TORN';
  let spoilNote = '';
  let spoiling = false;

  let toast = '';
  let toastTimer;
  function flash(msg, ms = 1800) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), ms);
  }

  const tick = (ms = 8) => {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  };

  // ── Queue (optimistic view + auto refresh) ────────────────
  let snap = { ops: [], online: true };
  let lastPending = 0;
  let refreshTimer;

  const unsub = subscribeQueue((s) => {
    snap = s;
    const n = s.ops.filter((o) => String(o.kind).startsWith('form_a.') && o.state !== 'done').length;
    if (n < lastPending) {
      // something was sent: reload real numbers
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadAll({ quiet: true }), 400);
    }
    lastPending = n;
  });

  onDestroy(() => {
    unsub();
    clearTimeout(toastTimer);
    clearTimeout(refreshTimer);
  });

  // ── Session ───────────────────────────────────────────────
  $: if ($session.status === 'unbound') phase = 'unbound';

  $: if ($session.status === 'bound' && $session.ward && !ward) {
    ward = $session.ward;
    loadAll();
  }

  // ── Derived ───────────────────────────────────────────────
  $: receipt = receipts.find((r) => r.receipt_id === receiptId) || null;
  $: isAck = receipt?.form_type === 'ACKNOWLEDGMENT';
  $: step = isAck ? 50 : 1;
  $: quickAmounts = isAck ? [50, 100] : [10, 20];

  $: formOps = snap.ops.filter((o) => String(o.kind).startsWith('form_a.'));
  $: live = formOps.filter((o) => o.state !== 'done' && o.state !== 'gaveup');
  $: pendingAllocs = live.filter((o) => o.kind === 'form_a.allocate' && o.payload?.receipt_id === receiptId);
  $: pendingSpoils = live.filter((o) => o.kind === 'form_a.spoil');
  $: pendingSpoilsHere = pendingSpoils.filter((o) => o.payload?.receipt_id === receiptId);
  $: waitingCount = live.length;
  $: failedCount = formOps.filter((o) => o.state === 'gaveup').length;

  $: qForms = pendingAllocs.reduce((s, o) => s + (o.payload?.forms_allocated || 0), 0);
  $: formCount = detail?.form_count ?? 0;
  $: allocated = (detail?.allocated ?? 0) + qForms;
  $: spoiled = (detail?.spoiled ?? 0) + pendingSpoilsHere.length;
  $: left = detail ? Math.max(0, detail.unallocated - qForms - pendingSpoilsHere.length) : receipt?.remaining ?? 0;

  $: pctAlloc = formCount ? Math.min(100, (allocated / formCount) * 100) : 0;
  $: pctSpoil = formCount ? Math.min(100 - pctAlloc, (spoiled / formCount) * 100) : 0;

  $: allocRows = [
    ...pendingAllocs.map((o) => {
      const k = kits.find((x) => String(x.kit_id) === String(o.payload.kit_id));
      return { key: o.id, kit_name: k?.kit_name || 'Kit', serial_no: k?.serial_no || '', forms: o.payload.forms_allocated, queued: true };
    }),
    ...(detail?.allocations || []).map((a, i) => ({
      key: `s${i}`, kit_name: a.kit_name, serial_no: a.serial_no, forms: a.forms_allocated, queued: false,
    })),
  ];

  function allocatedFor(k, det, pend) {
    const base = (det?.allocations || [])
      .filter((a) => a.serial_no === k.serial_no)
      .reduce((s, a) => s + (a.forms_allocated || 0), 0);
    const q = pend
      .filter((o) => String(o.payload?.kit_id) === String(k.kit_id))
      .reduce((s, o) => s + (o.payload?.forms_allocated || 0), 0);
    return base + q;
  }

  $: allocError = !allocForms
    ? ''
    : allocForms > left
      ? `Only ${left} form${left === 1 ? '' : 's'} left in this booklet.`
      : isAck && allocForms % 50 !== 0
        ? 'Must be a multiple of 50 (one booklet).'
        : '';
  $: selectedKit = kits.find((k) => String(k.kit_id) === String(allocKitId)) || null;
  $: canAllocate = !!receiptId && !!allocKitId && allocForms > 0 && !allocError && !allocating;
  $: allocMissing = [!allocKitId && 'a kit', !(allocForms > 0) && 'how many forms'].filter(Boolean);
  $: showAllocForm = !detail || left > 0;

  function serialProblem(raw, r) {
    const s = raw.trim();
    if (!s || !r) return '';
    const startNum = /^\d+$/.test(String(r.serial_start));
    if (startNum && !/^\d+$/.test(s)) return 'Serial numbers are digits only.';
    if (startNum && /^\d+$/.test(String(r.serial_end))) {
      const n = parseInt(s, 10);
      if (n < parseInt(r.serial_start, 10) || n > parseInt(r.serial_end, 10)) {
        return `Must be between ${r.serial_start} and ${r.serial_end}.`;
      }
    }
    return '';
  }
  function normalizeSerial(raw, r) {
    const s = raw.trim();
    if (r && /^\d+$/.test(s) && /^\d+$/.test(String(r.serial_start))) {
      return s.padStart(String(r.serial_start).length, '0');
    }
    return s;
  }

  $: serialErr = serialProblem(spoilSerial, receipt);
  $: canSpoil = !!receiptId && spoilSerial.trim().length > 0 && !serialErr && !!selectedDate && !spoiling;

  $: queuedHistory = pendingSpoils
    .filter((o) => o.payload?.date === selectedDate)
    .map((o) => ({
      id: o.id,
      serial_number: o.payload.serial_number,
      reason_label: reasonLabel(o.payload.reason),
      note: o.payload.note,
      created_at: new Date(o.createdAt).toISOString(),
      queued: true,
    }));
  $: historyView = [...queuedHistory, ...history];

  // ── Data ──────────────────────────────────────────────────
  async function loadAll({ quiet = false } = {}) {
    if (!ward) return;
    if (!quiet && phase !== 'ready') phase = 'loading';
    if (!quiet) errorMsg = '';

    const ck = `form-a:v3:${ward.id}`;

    if (!quiet && !receipts.length) {
      try {
        const cached = await Cache.get(ck);
        if (cached?.value) {
          receipts = cached.value.receipts || [];
          kits = cached.value.kits || [];
          if (receipts.length || kits.length) {
            phase = 'ready';
            pickDefaultReceipt();
          }
        }
      } catch { /* ignore */ }
    }

    const fp = encodeURIComponent($session.fingerprint);
    const [r, k, h] = await Promise.allSettled([
      apiFetch(`/api/form-a/mine/?fingerprint=${fp}`),
      apiFetch(`/api/form-a/kits/?fingerprint=${fp}`),
      apiFetch(`/api/form-a/spoilages-mine/?fingerprint=${fp}&date=${selectedDate}`),
    ]);
    const val = (x) => (x.status === 'fulfilled' && x.value?.ok ? x.value : null);
    const rv = val(r);
    const kv = val(k);
    const hv = val(h);

    if (rv) receipts = rv.receipts || [];
    if (kv) kits = kv.kits || [];
    if (hv) history = hv.spoilages || [];
    if (rv && kv) {
      try { await Cache.set(ck, { receipts, kits }); } catch { /* ignore */ }
    }

    if (!rv && !kv) {
      if (phase !== 'ready' && !quiet) {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and nothing is saved on this device yet."
            : r.reason?.message || 'Could not load Form A data.';
      }
      return;
    }

    phase = 'ready';
    pickDefaultReceipt();
    await loadDetail();
  }

  function pickDefaultReceipt() {
    if (!receipts.some((r) => r.receipt_id === receiptId)) {
      receiptId = receipts[0]?.receipt_id || '';
      detail = null;
      loadDetail();
    }
  }

  async function loadDetail() {
    if (!receiptId) {
      detail = null;
      return;
    }
    const id = receiptId;
    const key = `form-a:alloc:${id}`;
    try {
      const row = await Cache.get(key);
      if (row?.value && id === receiptId && !detail) detail = row.value;
    } catch { /* ignore */ }
    try {
      const res = await apiFetch(
        `/api/form-a/receipts/${id}/allocations/?fingerprint=${encodeURIComponent($session.fingerprint)}`,
      );
      if (res.ok && id === receiptId) {
        detail = res;
        try { await Cache.set(key, res); } catch { /* ignore */ }
      }
    } catch { /* keep current */ }
  }

  function selectReceipt(id) {
    if (id === receiptId) return;
    receiptId = id;
    detail = null;
    allocForms = 0;
    allocKitId = '';
    errorMsg = '';
    tick(5);
    loadDetail();
  }

  async function loadHistory() {
    const key = `form-a:spoil:${ward?.id}:${selectedDate}`;
    try {
      const row = await Cache.get(key);
      if (row?.value) history = row.value;
    } catch { /* ignore */ }
    try {
      const res = await apiFetch(
        `/api/form-a/spoilages-mine/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${selectedDate}`,
      );
      if (res.ok) {
        history = res.spoilages || [];
        try { await Cache.set(key, history); } catch { /* ignore */ }
      }
    } catch { /* keep current */ }
  }

  function onDateChange(e) {
    selectedDate = e.currentTarget.value || todayIso();
    loadHistory();
  }

  // ── Send through the queue ────────────────────────────────
  // Same op id is the idempotency key, so a retry can never create a duplicate.
  // Returns 'sent' | 'queued' | { failed: message }
  async function waitForOp(id, ms = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const op = await Queue.get(id).catch(() => null);
      if (!op) return 'sent';
      if (op.state === 'gaveup') return { failed: op.lastError || 'Rejected by the server.' };
      if (op.state === 'retry' || !navigator.onLine) return 'queued';
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'queued';
  }

  async function sendOp(kind, body) {
    const op = await enqueue(kind, body);
    drainQueue().catch(() => {});
    const out = await waitForOp(op.id);
    if (typeof out === 'object') await discardOp(op.id); // rejected: don't keep it in the queue
    return out;
  }

  // ── Allocate ──────────────────────────────────────────────
  async function submitAllocate() {
    if (!canAllocate) return;
    allocating = true;
    errorMsg = '';
    tick(8);

    const forms = allocForms;
    const kitName = selectedKit?.kit_name || 'kit';

    try {
      const out = await sendOp('form_a.allocate', {
        fingerprint: $session.fingerprint,
        receipt_id: receiptId,
        kit_id: parseInt(allocKitId, 10),
        forms_allocated: forms,
        note: allocNote.trim(),
      });

      if (typeof out === 'object') {
        errorMsg = out.failed; // keep the form so they can fix it
      } else {
        allocForms = 0;
        allocNote = '';
        allocKitId = '';
        tick([12, 40, 12]);
        flash(out === 'sent' ? `Allocated ${forms} to ${kitName}` : 'Saved · will sync when online');
      }
    } catch (err) {
      errorMsg = err.message || 'Could not save.';
    } finally {
      allocating = false;
    }
  }

  // ── Spoil ─────────────────────────────────────────────────
  async function submitSpoil() {
    if (!canSpoil) return;
    spoiling = true;
    errorMsg = '';
    tick(8);

    try {
      const out = await sendOp('form_a.spoil', {
        fingerprint: $session.fingerprint,
        receipt_id: receiptId,
        kit_id: spoilKitId ? parseInt(spoilKitId, 10) : undefined,
        serial_number: normalizeSerial(spoilSerial, receipt),
        date: selectedDate,
        reason: spoilReason,
        note: spoilNote.trim(),
      });

      if (typeof out === 'object') {
        errorMsg = out.failed;
      } else {
        spoilSerial = '';
        spoilNote = '';
        tick([12, 40, 12]);
        flash(out === 'sent' ? 'Spoilage recorded' : 'Saved · will sync when online');
      }
    } catch (err) {
      errorMsg = err.message || 'Could not save.';
    } finally {
      spoiling = false;
    }
  }

  function setTab(t) {
    activeTab = t;
    errorMsg = '';
    tick(5);
    if (t === 'history') loadHistory();
  }

  function timeOf(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }
</script>

<PageTransition>
  <div class="fa">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Form A</div>
          <div class="hero-sub">
            {ward?.name || $session.ward?.name || 'Your ward'}{#if $session.constituency} · {$session.constituency.name}{/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>
    </header>

    <div class="sheet">
      {#if phase === 'unbound' || phase === 'error'}
        <div class="scroll">
          <div class="state">
            <div class="state-ic" class:err={phase === 'error'}>
              {#if phase === 'unbound'}
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7A4 4 0 0 1 16 7V10" />
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
                </svg>
              {/if}
            </div>
            <h3>{phase === 'unbound' ? 'Set up this device first' : "Couldn't load Form A"}</h3>
            <p>{phase === 'unbound' ? 'Choose your ward on the home screen to continue.' : errorMsg}</p>
            {#if phase === 'error'}
              <button class="btn" on:click={() => loadAll()}>Try again</button>
            {:else}
              <button class="btn" on:click={() => dispatch('back')}>Back to home</button>
            {/if}
          </div>
        </div>

      {:else if phase !== 'ready'}
        <div class="scroll">
          <div class="skeleton">
            <div class="sk sk-books"></div>
            <div class="sk sk-bal"></div>
            <div class="sk sk-tabs"></div>
            <div class="sk sk-block"></div>
          </div>
        </div>

      {:else if receipts.length === 0}
        <div class="scroll">
          <div class="state">
            <div class="state-ic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 3.5H15L19 7.5V20.5A1 1 0 0 1 18 21.5H7A1 1 0 0 1 6 20.5V4.5A1 1 0 0 1 7 3.5Z" />
                <path d="M15 3.5V7.5H19" /><path d="M9 13H16" /><path d="M9 17H14" />
              </svg>
            </div>
            <h3>No booklets yet</h3>
            <p>No serialed booklets are assigned to your ward. Ask the ICT officer to record a receipt.</p>
          </div>
        </div>

      {:else}
        <div class="scroll">
          {#if failedCount > 0}
            <div class="notice bad">
              {failedCount} change{failedCount === 1 ? '' : 's'} couldn't be sent. Tap the sync badge to retry.
            </div>
          {:else if waitingCount > 0}
            <div class="notice">
              {waitingCount} change{waitingCount === 1 ? ' is' : 's are'} waiting to send.
            </div>
          {/if}

          <!-- Booklets -->
          <div class="books" role="radiogroup" aria-label="Booklet">
            {#each receipts as r (r.receipt_id)}
              <button
                class="book"
                class:on={r.receipt_id === receiptId}
                role="radio"
                aria-checked={r.receipt_id === receiptId}
                on:click={() => selectReceipt(r.receipt_id)}
              >
                <span class="book-type">{r.form_type_label}</span>
                <span class="book-range">{r.serial_start}–{r.serial_end}</span>
                <span class="book-left">{r.receipt_id === receiptId ? left : r.remaining} left</span>
              </button>
            {/each}
          </div>

          <!-- Balance -->
          {#if detail || receipt}
            <section class="card balance">
              <div class="bal-top">
                <div>
                  <div class="label">Forms left</div>
                  <div class="bal-num">{left}<span>/{formCount || (receipt?.remaining ?? 0)}</span></div>
                </div>
                {#if left === 0 && detail}
                  <span class="chip done">Fully used</span>
                {/if}
              </div>
              <div class="bar" aria-hidden="true">
                <span class="b-alloc" style="width:{pctAlloc}%"></span>
                <span class="b-spoil" style="width:{pctSpoil}%"></span>
              </div>
              <div class="legend">
                <div class="lg"><i class="d-alloc"></i><span>Allocated</span><b>{allocated}</b></div>
                <div class="lg"><i class="d-spoil"></i><span>Spoiled</span><b>{spoiled}</b></div>
                <div class="lg"><i class="d-left"></i><span>Left</span><b>{left}</b></div>
              </div>
            </section>
          {/if}

          <!-- Tabs -->
          <div class="tabs" role="tablist" aria-label="Form A sections">
            {#each [['allocate', 'Allocate'], ['spoil', 'Spoil'], ['history', 'History']] as [id, label]}
              <button role="tab" aria-selected={activeTab === id} class:on={activeTab === id} on:click={() => setTab(id)}>
                {label}
                {#if id === 'history' && historyView.length > 0}<span class="tab-count">{historyView.length}</span>{/if}
              </button>
            {/each}
          </div>

          <!-- ═════════ ALLOCATE ═════════ -->
          {#if activeTab === 'allocate'}
            {#if showAllocForm}
              <div class="label">Which kit?</div>
              <div class="kits" role="radiogroup" aria-label="Kit">
                {#each kits as k (k.kit_id)}
                  {@const n = allocatedFor(k, detail, pendingAllocs)}
                  <button
                    class="kit"
                    class:on={String(allocKitId) === String(k.kit_id)}
                    role="radio"
                    aria-checked={String(allocKitId) === String(k.kit_id)}
                    on:click={() => { allocKitId = String(k.kit_id); tick(5); }}
                  >
                    <span class="kit-name">{k.kit_name}</span>
                    <span class="kit-serial">{k.serial_no}</span>
                    <span class="kit-n" class:zero={n === 0}>{n} allocated</span>
                  </button>
                {:else}
                  <div class="muted">No kits found for this ward.</div>
                {/each}
              </div>

              <div class="row-label">
                <div class="label inline">Forms to allocate</div>
                {#if left > 0}
                  <button class="link" on:click={() => (allocForms = isAck ? Math.floor(left / 50) * 50 : left)}>
                    Use {isAck ? Math.floor(left / 50) * 50 : left}
                  </button>
                {/if}
              </div>
              <CountStepper
                bind:value={allocForms}
                label={isAck ? 'Forms (booklets of 50)' : 'Forms'}
                tone="neutral"
                min={0}
                max={Math.max(left, 0) || 99999}
                {step}
                quick={quickAmounts}
              />
              {#if allocError}
                <div class="field-err">{allocError}</div>
              {:else if isAck}
                <div class="field-hint">One booklet is 50 forms. Use multiples of 50.</div>
              {/if}

              <div class="label">Note <span class="opt">(optional)</span></div>
              <label class="field">
                <input type="text" bind:value={allocNote} placeholder="e.g. for Kit A at Amani Hall" autocomplete="off" />
              </label>
            {:else}
              <div class="empty">This booklet has been fully allocated or spoiled.</div>
            {/if}

            {#if allocRows.length > 0}
              <div class="label">Allocated so far</div>
              <div class="list">
                {#each allocRows as a (a.key)}
                  <div class="item" class:queued={a.queued}>
                    <div class="item-main">
                      <div class="item-title">{a.kit_name}</div>
                      {#if a.serial_no}<div class="item-sub mono">{a.serial_no}</div>{/if}
                    </div>
                    {#if a.queued}<span class="tag queued">Queued</span>{/if}
                    <div class="item-num">{a.forms}</div>
                  </div>
                {/each}
              </div>
            {/if}

          <!-- ═════════ SPOIL ═════════ -->
          {:else if activeTab === 'spoil'}
            <div class="label">Spoiled serial number</div>
            <label class="field" class:bad={!!serialErr}>
              <input
                type="text"
                bind:value={spoilSerial}
                placeholder={receipt ? `e.g. ${receipt.serial_start}` : 'e.g. 000123'}
                inputmode="numeric"
                autocomplete="off"
                class="mono"
              />
            </label>
            {#if serialErr}
              <div class="field-err">{serialErr}</div>
            {:else if receipt}
              <div class="field-hint">This booklet: {receipt.serial_start}–{receipt.serial_end}</div>
            {/if}

            <div class="label">Reason</div>
            <div class="reasons" role="radiogroup" aria-label="Reason">
              {#each REASONS as r (r.value)}
                <button
                  class="reason"
                  class:on={spoilReason === r.value}
                  role="radio"
                  aria-checked={spoilReason === r.value}
                  on:click={() => { spoilReason = r.value; tick(5); }}
                >{r.label}</button>
              {/each}
            </div>

            <div class="label">Kit <span class="opt">(optional)</span></div>
            <div class="hchips">
              <button class="hchip" class:on={!spoilKitId} on:click={() => (spoilKitId = '')}>Not sure</button>
              {#each kits as k (k.kit_id)}
                <button class="hchip" class:on={String(spoilKitId) === String(k.kit_id)}
                        on:click={() => (spoilKitId = String(k.kit_id))}>{k.kit_name}</button>
              {/each}
            </div>

            <div class="label">Date</div>
            <label class="field">
              <input type="date" value={selectedDate} max={todayIso()} on:change={onDateChange} />
            </label>

            <div class="label">Note <span class="opt">(optional)</span></div>
            <label class="field">
              <input type="text" bind:value={spoilNote} placeholder="e.g. torn during signing" autocomplete="off" />
            </label>

          <!-- ═════════ HISTORY ═════════ -->
          {:else}
            <div class="label">Date</div>
            <label class="field">
              <input type="date" value={selectedDate} max={todayIso()} on:change={onDateChange} />
            </label>

            {#if historyView.length === 0}
              <div class="empty">Nothing reported on {selectedDate} yet.</div>
            {:else}
              <div class="label">{historyView.length} spoiled form{historyView.length === 1 ? '' : 's'}</div>
              <div class="list">
                {#each historyView as h (h.id)}
                  <div class="item" class:queued={h.queued}>
                    <div class="item-main">
                      <div class="item-title mono">{h.serial_number}</div>
                      <div class="item-sub">
                        {h.reason_label}{#if timeOf(h.created_at)} · {timeOf(h.created_at)}{/if}
                      </div>
                      {#if h.note}<div class="item-note">{h.note}</div>{/if}
                    </div>
                    {#if h.queued}<span class="tag queued">Queued</span>{:else}<span class="tag ok">Sent</span>{/if}
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <!-- Save bar -->
        {#if activeTab === 'allocate' && showAllocForm}
          <div class="savebar">
            {#if errorMsg}<div class="error" role="alert">{errorMsg}</div>{/if}
            <button class="cta" disabled={!canAllocate} on:click={submitAllocate}>
              {#if allocating}
                Allocating…
              {:else if canAllocate && selectedKit}
                Allocate {allocForms} to {selectedKit.kit_name}
              {:else}
                Allocate to kit
              {/if}
            </button>
            <div class="hint" class:ask={!canAllocate && allocMissing.length > 0 && !allocError}>
              {#if !canAllocate && allocMissing.length > 0 && !allocError}
                Choose {allocMissing.join(' and ')}
              {:else}
                {left} form{left === 1 ? '' : 's'} left in this booklet
              {/if}
            </div>
          </div>
        {:else if activeTab === 'spoil'}
          <div class="savebar">
            {#if errorMsg}<div class="error" role="alert">{errorMsg}</div>{/if}
            <button class="cta danger" disabled={!canSpoil} on:click={submitSpoil}>
              {spoiling ? 'Saving…' : 'Report spoilage'}
            </button>
            <div class="hint" class:ask={!spoilSerial.trim()}>
              {#if !spoilSerial.trim()}Enter the spoiled serial number{:else}Spoiled forms are removed from this booklet's balance{/if}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    {#if toast}
      <div class="toast" role="status" transition:fly={{ y: 10, duration: 200, easing: cubicOut }}>{toast}</div>
    {/if}
  </div>
</PageTransition>

<style>
  .fa {
    --bg: #f6f8fb;
    --card: #fff;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --acc: #ef9400;
    --acc-d: #b36a00;
    --acc-l: #fff2dc;
    --green: #0a9d6e;
    --green-l: #e3f6ee;
    --red: #e23b3b;
    --red-d: #b23a32;
    --red-l: #ffe8e8;
    --slate-l: #e9eef4;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #2a1c02;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    overscroll-behavior: none;
  }

  /* ── Hero ───────────────────────────────────────────── */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 38px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(255, 196, 60, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(180, 110, 0, 0.26), transparent 55%),
      linear-gradient(150deg, #2a1c02 0%, #5f3a04 58%, #8a5406 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-title { font-size: clamp(21px, 6vw, 26px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.05; }
  .hero-sub {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sync-wrap { display: inline-flex; align-items: center; flex-shrink: 0; }
  .glass-btn {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 13px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    cursor: pointer;
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
  .glass-btn:active { transform: scale(0.94); }

  /* ── Sheet ──────────────────────────────────────────── */
  .sheet {
    position: relative;
    flex: 1;
    min-height: 0;
    margin-top: -24px;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 18px 14px calc(22px + env(safe-area-inset-bottom));
  }

  .notice {
    margin-bottom: 14px;
    padding: 11px 13px;
    border-radius: 16px;
    background: var(--acc-l);
    color: #8f5a00;
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.4;
  }
  .notice.bad { background: var(--red-l); color: var(--red-d); }

  .label {
    margin: 22px 2px 10px;
    font-size: 11px;
    font-weight: 780;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .label.inline { margin: 0; }
  .opt { font-size: 10px; font-weight: 650; letter-spacing: 0.02em; text-transform: none; color: var(--ink-3); }
  .row-label { display: flex; align-items: flex-end; justify-content: space-between; margin: 22px 2px 10px; }
  .link {
    padding: 2px 4px;
    border: 0;
    background: none;
    color: var(--acc-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
  }

  /* ── Booklets ───────────────────────────────────────── */
  .books { display: flex; gap: 8px; margin: 0 -14px 14px; padding: 2px 14px 4px; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x proximity; }
  .books::-webkit-scrollbar { display: none; }
  .book {
    flex: 0 0 auto;
    min-width: 168px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border: 1.5px solid var(--line);
    border-radius: 20px;
    background: var(--card);
    text-align: left;
    font: inherit;
    cursor: pointer;
    scroll-snap-align: start;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04);
    transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.14s var(--ease);
  }
  .book:active { transform: scale(0.98); }
  .book.on { border-color: var(--acc); background: #fffaf0; }
  .book-type { font-size: 13.5px; font-weight: 750; letter-spacing: -0.02em; }
  .book-range { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--ink-3); }
  .book-left { font-size: 11.5px; font-weight: 750; color: var(--acc-d); }

  /* ── Balance ────────────────────────────────────────── */
  .card {
    padding: 16px 16px 14px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 30px -18px rgba(14, 31, 63, 0.2);
  }
  .balance .label { margin: 0; }
  .bal-top { display: flex; align-items: flex-start; justify-content: space-between; }
  .bal-num { margin-top: 6px; font-size: 40px; font-weight: 800; letter-spacing: -0.055em; line-height: 1; }
  .bal-num span { font-size: 18px; font-weight: 650; color: var(--ink-3); margin-left: 2px; }
  .chip { padding: 6px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 750; background: var(--slate-l); color: #4d5d73; }
  .chip.done { background: var(--green-l); color: #067552; }

  .bar { display: flex; height: 10px; margin-top: 16px; border-radius: 999px; background: var(--acc-l); overflow: hidden; }
  .b-alloc { background: #0e9aa7; transition: width 0.6s var(--ease); }
  .b-spoil { background: #e55a4f; transition: width 0.6s var(--ease); }
  .legend { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
  .lg { display: grid; grid-template-columns: auto 1fr; grid-template-areas: 'dot name' 'num num'; column-gap: 6px; align-items: center; }
  .lg i { grid-area: dot; width: 8px; height: 8px; border-radius: 50%; }
  .lg span { grid-area: name; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-3); }
  .lg b { grid-area: num; margin-top: 4px; font-size: 20px; font-weight: 800; letter-spacing: -0.04em; }
  .d-alloc { background: #0e9aa7; }
  .d-spoil { background: #e55a4f; }
  .d-left { background: #f3c981; }

  /* ── Tabs ───────────────────────────────────────────── */
  .tabs {
    position: sticky;
    top: -18px;
    z-index: 3;
    display: flex;
    gap: 4px;
    margin: 16px 0 0;
    padding: 4px;
    border-radius: 16px;
    background: var(--slate-l);
  }
  .tabs button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 6px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 720;
    cursor: pointer;
    transition: background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .tabs button.on { background: #fff; color: var(--ink); box-shadow: 0 2px 8px rgba(14, 31, 63, 0.1); }
  .tab-count { min-width: 18px; padding: 1px 6px; border-radius: 999px; background: var(--acc-l); color: var(--acc-d); font-size: 10.5px; font-weight: 800; }

  /* ── Kit tiles ──────────────────────────────────────── */
  .kits { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .kit {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px 13px;
    border: 1.5px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.14s var(--ease);
  }
  .kit:active { transform: scale(0.98); }
  .kit.on { border-color: var(--acc); background: #fffaf0; }
  .kit-name { font-size: 13.5px; font-weight: 750; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kit-serial { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kit-n { margin-top: 3px; font-size: 11.5px; font-weight: 750; color: #0b7a85; }
  .kit-n.zero { color: var(--ink-3); font-weight: 600; }
  .muted { grid-column: 1 / -1; padding: 14px; font-size: 13px; color: var(--ink-3); text-align: center; }

  /* ── Fields ─────────────────────────────────────────── */
  .field {
    display: flex;
    align-items: center;
    border: 1.5px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease);
  }
  .field:focus-within { border-color: var(--acc); box-shadow: 0 0 0 4px rgba(239, 148, 0, 0.12); }
  .field.bad { border-color: var(--red); }
  .field input {
    flex: 1;
    min-width: 0;
    padding: 15px 14px;
    border: 0;
    outline: 0;
    border-radius: 18px;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    -webkit-user-select: text;
    user-select: text;
  }
  .field input.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em; }
  .field input::placeholder { color: #a3adbd; font-weight: 500; }
  .field-hint { margin: 8px 4px 0; font-size: 12px; color: var(--ink-3); }
  .field-err { margin: 8px 4px 0; font-size: 12.5px; font-weight: 700; color: var(--red-d); }

  .reasons { display: flex; flex-wrap: wrap; gap: 8px; }
  .reason, .hchip {
    padding: 10px 15px;
    border: 1.5px solid var(--line);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 0.16s var(--ease), background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .reason.on { border-color: var(--red); background: var(--red-l); color: var(--red-d); }
  .hchips { display: flex; gap: 8px; margin: 0 -14px; padding: 0 14px 2px; overflow-x: auto; scrollbar-width: none; }
  .hchips::-webkit-scrollbar { display: none; }
  .hchip { flex-shrink: 0; }
  .hchip.on { border-color: var(--acc); background: var(--acc-l); color: var(--acc-d); }

  /* ── Lists ──────────────────────────────────────────── */
  .list { display: flex; flex-direction: column; gap: 8px; }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--card);
  }
  .item.queued { border-color: #f6d9a0; background: #fffbf1; }
  .item-main { flex: 1; min-width: 0; }
  .item-title { font-size: 14px; font-weight: 740; letter-spacing: -0.02em; }
  .item-sub { margin-top: 3px; font-size: 11.5px; color: var(--ink-3); font-weight: 600; }
  .item-note { margin-top: 5px; font-size: 12.5px; color: var(--ink-2); line-height: 1.4; }
  .item-num { font-size: 19px; font-weight: 800; letter-spacing: -0.04em; color: #0b7a85; flex-shrink: 0; }
  .tag { padding: 3px 9px; border-radius: 999px; font-size: 10px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; flex-shrink: 0; }
  .tag.queued { background: var(--acc-l); color: var(--acc-d); }
  .tag.ok { background: var(--green-l); color: #067552; }

  .empty {
    margin-top: 18px;
    padding: 30px 20px;
    border: 1px dashed #cfd6e2;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.7);
    color: var(--ink-3);
    font-size: 13px;
    text-align: center;
    line-height: 1.5;
  }

  /* ── Save bar ───────────────────────────────────────── */
  .savebar {
    flex: none;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    background: rgba(255, 255, 255, 0.96);
    border-top: 1px solid var(--line);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  .cta {
    width: 100%;
    padding: 15px 16px;
    border: 0;
    border-radius: 16px;
    background: linear-gradient(135deg, #b36a00, #ef9400);
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 760;
    letter-spacing: -0.01em;
    cursor: pointer;
    box-shadow: 0 14px 26px -14px rgba(239, 148, 0, 0.75);
    transition: transform 0.15s var(--ease);
  }
  .cta.danger { background: linear-gradient(135deg, #e23b3b, #b0202f); box-shadow: 0 14px 26px -14px rgba(226, 59, 59, 0.7); }
  .cta:active:not(:disabled) { transform: scale(0.985); }
  .cta:disabled { background: #cbd2de; box-shadow: none; cursor: not-allowed; }
  .hint { margin-top: 8px; text-align: center; font-size: 11.5px; font-weight: 600; color: var(--ink-3); }
  .hint.ask { color: var(--acc-d); font-weight: 700; }
  .error { margin-bottom: 10px; padding: 10px 13px; border-radius: 14px; background: var(--red-l); color: var(--red-d); font-size: 12.5px; font-weight: 650; }

  /* ── States ─────────────────────────────────────────── */
  .state { padding: 54px 20px; text-align: center; color: var(--ink-2); }
  .state-ic {
    width: 60px;
    height: 60px;
    margin: 0 auto 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--acc-l);
    color: var(--acc-d);
  }
  .state-ic.err { background: var(--red-l); color: var(--red); }
  .state h3 { margin: 0 0 6px; font-size: 18px; font-weight: 780; letter-spacing: -0.03em; color: var(--ink); }
  .state p { margin: 0 0 18px; font-size: 13.5px; line-height: 1.55; }
  .btn {
    padding: 12px 20px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: #fff;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    cursor: pointer;
  }

  .skeleton { display: flex; flex-direction: column; gap: 12px; }
  .sk {
    border-radius: 22px;
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .sk-books { height: 82px; }
  .sk-bal { height: 150px; }
  .sk-tabs { height: 48px; border-radius: 16px; }
  .sk-block { height: 200px; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .toast {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(96px + env(safe-area-inset-bottom));
    margin: 0 auto;
    width: max-content;
    max-width: calc(100% - 32px);
    z-index: 30;
    padding: 11px 18px;
    border-radius: 999px;
    background: var(--ink);
    color: #fff;
    font-size: 13px;
    font-weight: 650;
    box-shadow: 0 14px 28px -10px rgba(0, 0, 0, 0.45);
  }

  @media (prefers-reduced-motion: reduce) {
    .book, .kit, .field, .reason, .hchip, .cta, .tabs button, .b-alloc, .b-spoil { transition: none; }
    .sk { animation-duration: 2s; }
  }
</style>