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
  let phase = 'idle';
  let errorMsg = '';
  let ward = null;
  let activeTab = 'ledger'; // ledger | allocate | reallocate | spoil | history

  let selectedDate = todayIso();
  let receipts = [];
  let kits = [];
  let ledger = null;
  let history = [];
  let receiptId = '';
  let detail = null;

  // allocate
  let allocKitId = '';
  let allocForms = 0;
  let allocNote = '';
  let allocating = false;

  // reallocate
  let moveFrom = '';
  let moveTo = '';
  let moveAmount = 0;
  let moveNote = '';
  let moving = false;

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

  // ── Queue subscription ───────────────────────────────────
  let snap = { ops: [], online: true };
  let lastPending = 0;
  let refreshTimer;

  const unsub = subscribeQueue((s) => {
    snap = s;
    const n = s.ops.filter(
      (o) => String(o.kind).startsWith('form_a.') && o.state !== 'done',
    ).length;
    if (n < lastPending) {
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
  $: pendingAllocs = live.filter(
    (o) => o.kind === 'form_a.allocate' && o.payload?.receipt_id === receiptId,
  );
  $: pendingDeallocs = live.filter(
    (o) => o.kind === 'form_a.deallocate' && o.payload?.receipt_id === receiptId,
  );
  $: pendingSpoils = live.filter((o) => o.kind === 'form_a.spoil');
  $: pendingSpoilsHere = pendingSpoils.filter((o) => o.payload?.receipt_id === receiptId);
  $: waitingCount = live.length;
  $: failedCount = formOps.filter((o) => o.state === 'gaveup').length;

  $: qForms = pendingAllocs.reduce((s, o) => s + (o.payload?.forms_allocated || 0), 0);
  $: formCount = detail?.form_count ?? 0;
  $: allocated = (detail?.allocated ?? 0) + qForms;
  $: spoiled = (detail?.spoiled ?? 0) + pendingSpoilsHere.length;
  $: left = detail
    ? Math.max(0, detail.unallocated - qForms - pendingSpoilsHere.length)
    : receipt?.remaining ?? 0;

  // ── Ledger rows (server + queued deltas) ─────────────────
  $: ledgerRows = (() => {
    if (!ledger) return [];
    const map = new Map();
    for (const r of ledger.kits) map.set(String(r.kit_id), { ...r, queuedForms: 0, queuedFrees: 0 });

    // Apply queued allocations (adds to kit's allocated/left)
    for (const op of pendingAllocs) {
      const id = String(op.payload.kit_id);
      const row = map.get(id);
      if (row) {
        row.allocated += op.payload.forms_allocated || 0;
        row.left += op.payload.forms_allocated || 0;
        row.queuedForms += op.payload.forms_allocated || 0;
      }
    }

    // Apply queued deallocations (frees forms back to the pool)
    for (const op of pendingDeallocs) {
      const id = String(op.payload.kit_id);
      const row = map.get(id);
      if (row) {
        row.queuedFrees += op.payload.allocation_amount || 0;
      }
    }

    return [...map.values()];
  })();

  $: selectedKit = kits.find((k) => String(k.kit_id) === String(allocKitId)) || null;

  $: allocError = !allocForms
    ? ''
    : allocForms > left
      ? `Only ${left} form${left === 1 ? '' : 's'} left in this booklet.`
      : isAck && allocForms % 50 !== 0
        ? 'Must be a multiple of 50 (one booklet).'
        : '';
  $: canAllocate = !!receiptId && !!allocKitId && allocForms > 0 && !allocError && !allocating;
  $: showAllocForm = !detail || left > 0;

  // ── Reallocate validation ────────────────────────────────
  $: moveSource = ledgerRows.find((r) => String(r.kit_id) === String(moveFrom)) || null;
  $: moveDest = ledgerRows.find((r) => String(r.kit_id) === String(moveTo)) || null;
  $: moveMax = moveSource?.left ?? 0;
  $: moveError = !moveFrom || !moveTo
    ? ''
    : moveFrom === moveTo
      ? 'Pick a different kit for the destination.'
      : !moveAmount
        ? ''
        : moveAmount > moveMax
          ? `Only ${moveMax} left on ${moveSource?.kit_name}.`
          : isAck && moveAmount % 50 !== 0
            ? 'Must be a multiple of 50.'
            : '';
  $: canMove =
    !!moveFrom && !!moveTo && moveFrom !== moveTo &&
    moveAmount > 0 && !moveError && !moving;

  // ── Serial validation ─────────────────────────────────────
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
  $: canSpoil =
    !!receiptId && spoilSerial.trim().length > 0 && !serialErr && !!selectedDate && !spoiling;

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

  // Bar widths helper (kept out of the template so {@const} can live at
  // the top of the {#each} block, as Svelte requires).
  function barWidths(row) {
    const total = Math.max(1, row.allocated || 0);
    const usedPct = Math.min(100, (row.used / total) * 100);
    const spoilPct = Math.min(100 - usedPct, (row.spoiled / total) * 100);
    const leftPct = Math.max(0, 100 - usedPct - spoilPct);
    return { usedPct, spoilPct, leftPct };
  }

  // ── Data ──────────────────────────────────────────────────
  async function loadAll({ quiet = false } = {}) {
    if (!ward) return;
    if (!quiet && phase !== 'ready') phase = 'loading';
    if (!quiet) errorMsg = '';

    const ck = `form-a:v4:${ward.id}`;
    const lk = `form-a:ledger:${ward.id}`;

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
        const cachedLedger = await Cache.get(lk);
        if (cachedLedger?.value) ledger = cachedLedger.value;
      } catch { /* ignore */ }
    }

    const fp = encodeURIComponent($session.fingerprint);
    const [r, k, h, l] = await Promise.allSettled([
      apiFetch(`/api/form-a/mine/?fingerprint=${fp}`),
      apiFetch(`/api/form-a/kits/?fingerprint=${fp}`),
      apiFetch(`/api/form-a/spoilages-mine/?fingerprint=${fp}&date=${selectedDate}`),
      apiFetch(`/api/form-a/kits-ledger/?fingerprint=${fp}`),
    ]);
    const val = (x) => (x.status === 'fulfilled' && x.value?.ok ? x.value : null);
    const rv = val(r);
    const kv = val(k);
    const hv = val(h);
    const lv = val(l);

    if (rv) receipts = rv.receipts || [];
    if (kv) kits = kv.kits || [];
    if (hv) history = hv.spoilages || [];
    if (lv) {
      ledger = lv;
      try { await Cache.set(lk, lv); } catch { /* ignore */ }
    }
    if (rv && kv) {
      try { await Cache.set(ck, { receipts, kits }); } catch { /* ignore */ }
    }

    if (!rv && !kv && !lv) {
      if (phase !== 'ready' && !quiet) {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and nothing is saved on this device yet."
            : 'Could not load Form A data.';
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
    moveFrom = '';
    moveTo = '';
    moveAmount = 0;
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

  // ── Send via queue ────────────────────────────────────────
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
    if (typeof out === 'object') await discardOp(op.id);
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
        errorMsg = out.failed;
      } else {
        allocForms = 0;
        allocNote = '';
        allocKitId = '';
        tick([12, 40, 12]);
        flash(out === 'sent' ? `Allocated ${forms} to ${kitName}` : 'Saved · will sync');
        await loadAll({ quiet: true });
      }
    } catch (err) {
      errorMsg = err.message || 'Could not save.';
    } finally {
      allocating = false;
    }
  }

  // ── Reallocate (move forms between kits) ─────────────────
  async function submitMove() {
    if (!canMove) return;
    moving = true;
    errorMsg = '';
    tick(8);

    const src = moveSource?.kit_name || 'source';
    const dst = moveDest?.kit_name || 'destination';
    const amount = moveAmount;

    try {
      // 1) Remove the allocation row on the source kit
      const d = await sendOp('form_a.deallocate', {
        fingerprint: $session.fingerprint,
        receipt_id: receiptId,
        kit_id: parseInt(moveFrom, 10),
        allocation_amount: amount,
      });
      if (typeof d === 'object') {
        errorMsg = `Deallocate failed: ${d.failed}`;
        return;
      }

      // 2) Add the same amount to the destination kit
      const a = await sendOp('form_a.allocate', {
        fingerprint: $session.fingerprint,
        receipt_id: receiptId,
        kit_id: parseInt(moveTo, 10),
        forms_allocated: amount,
        note: moveNote.trim() || `Moved from ${src}`,
      });
      if (typeof a === 'object') {
        // The source reduction succeeded but the destination failed.
        // Restore the same quantity to the source kit to avoid losing forms.
        const restore = await sendOp('form_a.allocate', {
          fingerprint: $session.fingerprint,
          receipt_id: receiptId,
          kit_id: parseInt(moveFrom, 10),
          forms_allocated: amount,
          note: `Restored after failed move to ${dst}`,
        }).catch(() => null);

        errorMsg = `Destination allocation failed: ${a.failed}${
          typeof restore === 'object' || restore === null
            ? ' The source restoration could not be confirmed; please check the ledger.'
            : ' The forms were returned to the source kit.'
        }`;
        await loadAll({ quiet: true });
        return;
      }

      moveFrom = '';
      moveTo = '';
      moveAmount = 0;
      moveNote = '';
      tick([12, 40, 12]);
      flash(`Moved ${amount} from ${src} to ${dst}`);
      await loadAll({ quiet: true });
    } catch (err) {
      errorMsg = err.message || 'Could not move forms.';
    } finally {
      moving = false;
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
        flash(out === 'sent' ? 'Spoilage recorded' : 'Saved · will sync');
        await loadAll({ quiet: true });
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
          <div class="hero-title">Form A &amp; Ack</div>
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
                  <rect x="4" y="10" width="16" height="11" rx="2" />
                  <path d="M8 10V7A4 4 0 0 1 16 7V10" />
                </svg>
              {:else}
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8V13" />
                  <path d="M12 16.5V16.6" />
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
            <div class="sk sk-bal"></div>
            <div class="sk sk-tabs"></div>
            <div class="sk sk-block"></div>
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

          <!-- Tabs -->
          <div class="tabs" role="tablist" aria-label="Form A sections">
            {#each [['ledger', 'Kits'], ['allocate', 'Allocate'], ['reallocate', 'Move'], ['spoil', 'Spoil'], ['history', 'Spoiled']] as [id, label]}
              <button
                role="tab"
                aria-selected={activeTab === id}
                class:on={activeTab === id}
                on:click={() => setTab(id)}
              >{label}</button>
            {/each}
          </div>

          <!-- ═════════ LEDGER ═════════ -->
          {#if activeTab === 'ledger'}
            {#if !ledger}
              <div class="empty">Loading kit balances…</div>
            {:else}
              <section class="card pool">
                <div class="label" style="margin:0">Unallocated pool</div>
                <div class="pool-num">{ledger.pool}</div>
                <div class="pool-sub">forms received at the office but not yet on any kit</div>
              </section>

              <div class="label">Per-kit balance</div>
              <div class="ledger">
                {#each ledgerRows as row (row.kit_id)}
                  {@const widths = barWidths(row)}
                  <div class="ledger-row">
                    <div class="ledger-head">
                      <div>
                        <div class="ledger-name">{row.kit_name}</div>
                        <div class="ledger-serial mono">{row.serial_no}</div>
                      </div>
                      <div class="ledger-left">
                        <b>{row.left}</b>
                        <span>left</span>
                      </div>
                    </div>
                    <div class="ledger-bar">
                      <span class="b-used" style="width:{widths.usedPct}%"></span>
                      <span class="b-spoil" style="width:{widths.spoilPct}%"></span>
                      <span class="b-left" style="width:{widths.leftPct}%"></span>
                    </div>
                    <div class="ledger-foot">
                      <span><i class="dot d-alloc"></i>Allocated <b>{row.allocated}</b></span>
                      <span><i class="dot d-used"></i>Used <b>{row.used}</b></span>
                      <span><i class="dot d-spoil"></i>Spoiled <b>{row.spoiled}</b></span>
                    </div>
                    {#if row.queuedForms > 0}
                      <div class="ledger-queued">+{row.queuedForms} queued</div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

          <!-- ═════════ ALLOCATE ═════════ -->
          {:else if activeTab === 'allocate'}
            {#if receipts.length === 0}
              <div class="empty">No booklets assigned to your ward yet.</div>
            {:else}
              <div class="label">Booklet</div>
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

              {#if showAllocForm}
                <div class="label">Kit</div>
                <div class="kits" role="radiogroup" aria-label="Kit">
                  {#each kits as k (k.kit_id)}
                    {@const row = ledgerRows.find((x) => String(x.kit_id) === String(k.kit_id))}
                    <button
                      class="kit"
                      class:on={String(allocKitId) === String(k.kit_id)}
                      role="radio"
                      aria-checked={String(allocKitId) === String(k.kit_id)}
                      on:click={() => { allocKitId = String(k.kit_id); tick(5); }}
                    >
                      <span class="kit-name">{k.kit_name}</span>
                      <span class="kit-serial mono">{k.serial_no}</span>
                      {#if row}<span class="kit-n">{row.left} left</span>{/if}
                    </button>
                  {/each}
                </div>

                <div class="row-label">
                  <div class="label inline">Forms to allocate</div>
                  {#if left > 0}
                    <button
                      class="link"
                      on:click={() => (allocForms = isAck ? Math.floor(left / 50) * 50 : left)}
                    >
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
                {#if allocError}<div class="field-err">{allocError}</div>{/if}

                <div class="label">Note <span class="opt">(optional)</span></div>
                <label class="field">
                  <input
                    type="text"
                    bind:value={allocNote}
                    placeholder="e.g. for Kit A at Amani Hall"
                    autocomplete="off"
                  />
                </label>

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
              {:else}
                <div class="empty">This booklet is fully allocated or spoiled.</div>
              {/if}
            {/if}

          <!-- ═════════ REALLOCATE (MOVE) ═════════ -->
          {:else if activeTab === 'reallocate'}
            <p class="hint-intro">
              Take forms from a kit that has some left and give them to another kit.
              Moves the selected quantity from one kit to another.
            </p>

            {#if kits.length < 2}
              <div class="empty">You need at least two kits to move forms between them.</div>
            {:else}
              <div class="label">Booklet</div>
              <div class="books" role="radiogroup" aria-label="Booklet for relocation">
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

              <div class="label">From kit</div>
              <div class="kits" role="radiogroup" aria-label="Source kit">
                {#each kits as k (k.kit_id)}
                  {@const row = ledgerRows.find((x) => String(x.kit_id) === String(k.kit_id))}
                  {@const empty = !row || row.left === 0}
                  <button
                    class="kit"
                    class:on={String(moveFrom) === String(k.kit_id)}
                    class:disabled={empty}
                    role="radio"
                    aria-checked={String(moveFrom) === String(k.kit_id)}
                    disabled={empty}
                    on:click={() => { moveFrom = String(k.kit_id); if (moveTo === moveFrom) moveTo = ''; tick(5); }}
                  >
                    <span class="kit-name">{k.kit_name}</span>
                    <span class="kit-serial mono">{k.serial_no}</span>
                    {#if row}
                      <span class="kit-n" class:zero={row.left === 0}>{row.left} left</span>
                    {/if}
                  </button>
                {/each}
              </div>

              <div class="label">To kit</div>
              <div class="kits" role="radiogroup" aria-label="Destination kit">
                {#each kits as k (k.kit_id)}
                  {@const row = ledgerRows.find((x) => String(x.kit_id) === String(k.kit_id))}
                  {@const same = String(moveFrom) === String(k.kit_id)}
                  <button
                    class="kit"
                    class:on={String(moveTo) === String(k.kit_id)}
                    class:disabled={same}
                    role="radio"
                    aria-checked={String(moveTo) === String(k.kit_id)}
                    disabled={same}
                    on:click={() => { moveTo = String(k.kit_id); tick(5); }}
                  >
                    <span class="kit-name">{k.kit_name}</span>
                    <span class="kit-serial mono">{k.serial_no}</span>
                    {#if row}<span class="kit-n">{row.left} left</span>{/if}
                  </button>
                {/each}
              </div>

              {#if moveFrom && moveTo && moveFrom !== moveTo}
                <div class="row-label">
                  <div class="label inline">How many</div>
                  {#if moveMax > 0}
                    <button
                      class="link"
                      on:click={() => (moveAmount = isAck ? Math.floor(moveMax / 50) * 50 : moveMax)}
                    >
                      Use {isAck ? Math.floor(moveMax / 50) * 50 : moveMax}
                    </button>
                  {/if}
                </div>
                <CountStepper
                  bind:value={moveAmount}
                  label={isAck ? 'Forms (booklets of 50)' : 'Forms'}
                  tone="neutral"
                  min={0}
                  max={Math.max(moveMax, 0) || 99999}
                  {step}
                  quick={quickAmounts}
                />
                {#if moveError}<div class="field-err">{moveError}</div>{/if}

                <div class="label">Note <span class="opt">(optional)</span></div>
                <label class="field">
                  <input
                    type="text"
                    bind:value={moveNote}
                    placeholder="e.g. Kit A is idle, Kit B is busy"
                    autocomplete="off"
                  />
                </label>

                <div class="move-summary">
                  <div class="move-line">
                    <span class="move-from">{moveSource?.kit_name}</span>
                    <span class="move-amount">−{moveAmount || 0}</span>
                  </div>
                  <div class="move-line">
                    <span class="move-to">{moveDest?.kit_name}</span>
                    <span class="move-amount plus">+{moveAmount || 0}</span>
                  </div>
                </div>

                {#if errorMsg}<div class="error" role="alert">{errorMsg}</div>{/if}
                <button class="cta" disabled={!canMove} on:click={submitMove}>
                  {moving ? 'Moving…' : `Move ${moveAmount || 0} forms`}
                </button>
              {:else}
                <div class="empty">Choose two different kits to continue.</div>
              {/if}
            {/if}
<!-- ═════════ SPOIL ═════════ -->

          {:else if activeTab === 'spoil'}

            {#if receipts.length === 0}

              <div class="empty">No booklets assigned to your ward yet.</div>

            {:else}

              <div class="label">Booklet</div>

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

                  <button

                    class="hchip"

                    class:on={String(spoilKitId) === String(k.kit_id)}

                    on:click={() => (spoilKitId = String(k.kit_id))}

                  >{k.kit_name}</button>

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



              {#if errorMsg}<div class="error" role="alert">{errorMsg}</div>{/if}

              <button class="cta danger" disabled={!canSpoil} on:click={submitSpoil}>

                {spoiling ? 'Saving…' : 'Report spoilage'}

              </button>

            {/if}



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

      {/if}

    </div>



    {#if toast}

      <div class="toast" role="status" transition:fly={{ y: 10, duration: 200, easing: cubicOut }}>

        {toast}

      </div>

    {/if}

  </div>

</PageTransition>



<style>

  .fa {

    \--bg: #f6f8fb;

    \--card: #fff;

    \--ink: #0e1f3f;

    \--ink-2: #5c6a82;

    \--ink-3: #8c97aa;

    \--line: #edf0f5;

    \--acc: #ef9400;

    \--acc-d: #b36a00;

    \--acc-l: #fff2dc;

    \--teal: #0e9aa7;

    \--teal-l: #def6f8;

    \--green: #0a9d6e;

    \--green-l: #e3f6ee;

    \--red: #e23b3b;

    \--red-d: #b23a32;

    \--red-l: #ffe8e8;

    \--slate-l: #e9eef4;

    \--ease: cubic-bezier(0.22, 0.8, 0.24, 1);



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

    -webkit-tap-highlight-color: transparent;

    touch-action: manipulation;

    overscroll-behavior: none;

  }



  /* ── Hero ───────────────────────────────────────────── */

  .hero {

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

  .hero-title {

    font-size: clamp(21px, 6vw, 26px);

    font-weight: 780;

    letter-spacing: -0.045em;

    line-height: 1.05;

  }

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



  /* ── Tabs ───────────────────────────────────────────── */

  .tabs {

    display: flex;

    gap: 4px;

    margin: 0 0 8px;

    padding: 4px;

    border-radius: 16px;

    background: var(--slate-l);

  }

  .tabs button {

    flex: 1;

    padding: 10px 6px;

    border: 0;

    border-radius: 12px;

    background: transparent;

    color: var(--ink-2);

    font: inherit;

    font-size: 12.5px;

    font-weight: 720;

    cursor: pointer;

    transition: *background* 0.16s var(--ease), color 0.16s var(--ease);

  }

  .tabs button.on {

    background: #fff;

    color: var(--ink);

    box-shadow: 0 2px 8px rgba(14, 31, 63, 0.1);

  }



  /* ── Ledger ─────────────────────────────────────────── */

  .card {

    padding: 16px;

    background: var(--card);

    border: 1px solid var(--line);

    border-radius: 22px;

    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 30px -18px rgba(14, 31, 63, 0.2);

  }

  .pool { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }

  .pool-num { font-size: 42px; font-weight: 800; letter-spacing: -0.055em; line-height: 1; color: var(--acc-d); }

  .pool-sub { font-size: 11.5px; color: var(--ink-3); font-weight: 600; }



  .ledger { display: flex; flex-direction: column; gap: 8px; }

  .ledger-row {

    padding: 12px 14px;

    border: 1px solid var(--line);

    border-radius: 16px;

    background: var(--card);

  }

  .ledger-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }

  .ledger-name { font-size: 14px; font-weight: 750; letter-spacing: -0.02em; }

  .ledger-serial { font-size: 11px; color: var(--ink-3); margin-top: 2px; }

  .ledger-left { text-align: right; }

  .ledger-left b { font-size: 22px; font-weight: 800; letter-spacing: -0.04em; }

  .ledger-left span {

    display: block;

    font-size: 10px;

    font-weight: 700;

    letter-spacing: 0.06em;

    text-transform: uppercase;

    color: var(--ink-3);

  }



  .ledger-bar {

    display: flex;

    height: 6px;

    margin: 10px 0 8px;

    border-radius: 999px;

    background: #eee;

    overflow: hidden;

  }

  .b-used { background: var(--teal); }

  .b-spoil { background: var(--red); }

  .b-left { background: var(--acc-l); }



  .ledger-foot {

    display: flex;

    justify-content: space-between;

    gap: 6px;

    font-size: 10.5px;

    color: var(--ink-2);

    font-weight: 650;

  }

  .ledger-foot span { display: inline-flex; align-items: center; gap: 4px; }

  .ledger-foot b { font-weight: 800; color: var(--ink); font-family: ui-monospace, monospace; }

  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

  .d-alloc { background: var(--teal); }

  .d-used { background: var(--teal); }

  .d-spoil { background: var(--red); }

  .ledger-queued { margin-top: 6px; font-size: 10.5px; font-weight: 750; color: var(--acc-d); }



  /* ── Booklets + kits ───────────────────────────────── */

  .books {

    display: flex;

    gap: 8px;

    margin: 0 -14px 14px;

    padding: 2px 14px 4px;

    overflow-x: auto;

    scrollbar-width: none;

  }

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

  }

  .book.on { border-color: var(--acc); background: #fffaf0; }

  .book-type { font-size: 13.5px; font-weight: 750; }

  .book-range { font-family: ui-monospace, monospace; font-size: 11.5px; color: var(--ink-3); }

  .book-left { font-size: 11.5px; font-weight: 750; color: var(--acc-d); }



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

  }

  .kit.on { border-color: var(--acc); background: #fffaf0; }

  .kit-name {

    font-size: 13.5px;

    font-weight: 750;

    overflow: hidden;

    text-overflow: ellipsis;

    white-space: nowrap;

  }

  .kit-serial {

    font-size: 10.5px;

    color: var(--ink-3);

    overflow: hidden;

    text-overflow: ellipsis;

    white-space: nowrap;

  }

  .kit-n { margin-top: 3px; font-size: 11.5px; font-weight: 750; color: var(--teal); }



  /* ── Fields ─────────────────────────────────────────── */

  .field {

    display: flex;

    align-items: center;

    border: 1.5px solid var(--line);

    border-radius: 18px;

    background: var(--card);

  }

  .field:focus-within {

    border-color: var(--acc);

    box-shadow: 0 0 0 4px rgba(239, 148, 0, 0.12);

  }

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

  }

  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em; }

  .field-hint { margin: 8px 4px 0; font-size: 12px; color: var(--ink-3); }

  .field-err { margin: 8px 4px 0; font-size: 12.5px; font-weight: 700; color: var(--red-d); }



  .reasons { display: flex; flex-wrap: wrap; gap: 8px; }

  .reason,

  .hchip {

    padding: 10px 15px;

    border: 1.5px solid var(--line);

    border-radius: 999px;

    background: var(--card);

    color: var(--ink-2);

    font: inherit;

    font-size: 13px;

    font-weight: 700;

    cursor: pointer;

  }

  .reason.on { border-color: var(--red); background: var(--red-l); color: var(--red-d); }

  .hchips {

    display: flex;

    gap: 8px;

    margin: 0 -14px;

    padding: 0 14px 2px;

    overflow-x: auto;

    scrollbar-width: none;

  }

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

  .item-title { font-size: 14px; font-weight: 740; }

  .item-sub { margin-top: 3px; font-size: 11.5px; color: var(--ink-3); font-weight: 600; }

  .item-note { margin-top: 5px; font-size: 12.5px; color: var(--ink-2); line-height: 1.4; }

  .tag {

    padding: 3px 9px;

    border-radius: 999px;

    font-size: 10px;

    font-weight: 800;

    letter-spacing: 0.05em;

    text-transform: uppercase;

  }

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



  /* ── CTA ────────────────────────────────────────────── */

  .cta {

    width: 100%;

    margin-top: 16px;

    padding: 15px 16px;

    border: 0;

    border-radius: 16px;

    background: linear-gradient(135deg, #b36a00, #ef9400);

    color: #fff;

    font: inherit;

    font-size: 15px;

    font-weight: 760;

    cursor: pointer;

    box-shadow: 0 14px 26px -14px rgba(239, 148, 0, 0.75);

  }

  .cta.danger { background: linear-gradient(135deg, #e23b3b, #b0202f); }

  .cta:disabled { background: #cbd2de; box-shadow: none; cursor: not-allowed; }

  .error {

    margin: 10px 0;

    padding: 10px 13px;

    border-radius: 14px;

    background: var(--red-l);

    color: var(--red-d);

    font-size: 12.5px;

    font-weight: 650;

  }



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

  .state h3 { margin: 0 0 6px; font-size: 18px; font-weight: 780; color: var(--ink); }

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

    background: linear-gradient(

      90deg,

      rgba(14, 31, 63, 0.05) 0%,

      rgba(14, 31, 63, 0.1) 50%,

      rgba(14, 31, 63, 0.05) 100%

    );

    background-size: 200% 100%;

    animation: shimmer 1.4s ease-in-out infinite;

  }

  .sk-bal { height: 150px; }

  .sk-tabs { height: 48px; border-radius: 16px; }

  .sk-block { height: 200px; }

  @keyframes shimmer {

    0% { background-position: 200% 0; }

    100% { background-position: -200% 0; }

  }



  .toast {

    position: fixed;

    left: 0;

    right: 0;

    bottom: calc(24px + env(safe-area-inset-bottom));

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


  /* ── Relocation ───────────────────────────────────────── */
  .hint-intro {
    margin: 2px 2px 14px;
    color: var(--ink-3);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .kit.disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }
  .kit-n.zero { color: var(--ink-3); }
  .move-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--slate-l);
  }
  .move-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 12.5px;
    font-weight: 700;
  }
  .move-from, .move-to {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .move-amount {
    flex: 0 0 auto;
    color: var(--red-d);
    font-family: ui-monospace, monospace;
    font-weight: 800;
  }
  .move-amount.plus { color: #067552; }

</style>