<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache, Queue } from '$lib/core/db.js';
  import { enqueue, discardOp, subscribeQueue } from '$lib/core/queue.js';
  import { drainQueue } from '$lib/core/sync.js';
  import { getStations } from '$lib/services/stations/stationsCache.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // DATE HELPERS (local time, Kenya is UTC+3)
  // ═══════════════════════════════════════════════════════════
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const localIso = (d) => isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  const parseIso = (iso) => new Date(iso + 'T00:00:00');
  const shiftIso = (iso, n) => {
    const d = parseIso(iso);
    d.setDate(d.getDate() + n);
    return localIso(d);
  };
  const classifyDate = (iso, t) => (iso === t ? 'today' : iso < t ? 'past' : 'future');

  const fmt = (iso, opts) => parseIso(iso).toLocaleDateString('en-KE', opts);
  const weekdayLong = (iso) => fmt(iso, { weekday: 'long' });
  const dateFull = (iso) => fmt(iso, { day: 'numeric', month: 'long', year: 'numeric' });
  const dateShort = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });

  const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const monthKeyOf = (c) => `${c.y}-${pad(c.m + 1)}`;

  // today / tomorrow keep up if the app stays open past midnight
  let nowTs = Date.now();
  const clock = setInterval(() => (nowTs = Date.now()), 60000);
  $: today = localIso(new Date(nowTs));
  $: tomorrow = shiftIso(today, 1);

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════
  let gate = 'loading'; // loading | unbound | error | ok
  let errorMsg = '';

  let ward = null;
  let constituency = null;

  let cursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  let maps = {}; // { 'YYYY-MM': { 'YYYY-MM-DD': { filled, total } } }
  let dir = 1;
  let justSaved = '';

  let view = 'calendar'; // calendar | form

  let formPhase = 'loading'; // loading | ready | error
  let formError = '';
  let fromCache = false;
  let selectedDate = '';
  let dateRelation = 'future';
  let kits = [];
  let saving = false;
  let scroller;
  let askDiscard = false;

  let prevVenues = {}; // kit_id -> venue the day before

  let toast = null;
  let toastTimer;
  let closeTimer;
  let popTimer;
  let refreshTimer;

  // queue
  let lastPending = 0;
  let waiting = 0;
  let failed = 0;

  // stations + suggestions
  let index = [];
  let wardIndex = [];
  let activeKitId = null;
  let suggestions = [];
  let suggestTimer;
  let blurTimer;

  const tick = (ms = 8) => {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  };

  function showToast(kind, text, ms = 3000) {
    clearTimeout(toastTimer);
    toast = { kind, text };
    toastTimer = setTimeout(() => (toast = null), ms);
  }

  // ═══════════════════════════════════════════════════════════
  // QUEUE
  // ═══════════════════════════════════════════════════════════
  const unsub = subscribeQueue((s) => {
    const mine = s.ops.filter((o) => o.kind === 'movement.save');
    const live = mine.filter((o) => o.state !== 'done' && o.state !== 'gaveup').length;
    waiting = live;
    failed = mine.filter((o) => o.state === 'gaveup').length;
    if (live < lastPending) {
      // something was delivered: refresh the calendar with real numbers
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadMonth(), 500);
    }
    lastPending = live;
  });

  onDestroy(() => {
    unsub();
    clearInterval(clock);
    clearTimeout(toastTimer);
    clearTimeout(closeTimer);
    clearTimeout(popTimer);
    clearTimeout(refreshTimer);
    clearTimeout(suggestTimer);
    clearTimeout(blurTimer);
  });

  // ═══════════════════════════════════════════════════════════
  // SESSION
  // ═══════════════════════════════════════════════════════════
  $: if ($session.status === 'unbound') gate = 'unbound';

  $: if ($session.status === 'bound' && $session.ward && !ward) {
    ward = $session.ward;
    gate = 'ok';
    loadStations();
    loadMonth();
    if (tomorrow.slice(0, 7) !== monthKeyOf(cursor)) loadMonth(tomorrow.slice(0, 7));
  }

  $: if ($session.status === 'error') {
    gate = 'error';
    errorMsg = $session.error || 'Session error.';
  }

  // ═══════════════════════════════════════════════════════════
  // STATIONS + SUGGESTIONS
  // ═══════════════════════════════════════════════════════════
  function buildIndex(list) {
    const wl = String($session.ward?.name || '').toLowerCase();
    index = list.map((s) => ({
      s,
      n: String(s.name || '').toLowerCase(),
      w: String(s.ward_name || '').toLowerCase(),
    }));
    wardIndex = wl ? index.filter((i) => i.w === wl) : [];
  }

  async function loadStations() {
    try {
      const list = await getStations({ onProgress: buildIndex });
      buildIndex(list);
    } catch { /* suggestions just stay empty */ }
  }

  function scan(arr, toks, limit) {
    const hits = [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      let ok = true;
      for (const t of toks) {
        if (!it.n.includes(t) && !it.w.includes(t)) { ok = false; break; }
      }
      if (!ok) continue;
      let score = 0;
      if (it.n.startsWith(toks[0])) score += 3;
      else if (it.n.includes(' ' + toks[0])) score += 2;
      hits.push({ s: it.s, score });
      if (hits.length >= limit) break;
    }
    hits.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
    return hits.map((h) => h.s);
  }

  // The VRA's own ward first, then the rest of the country
  function searchStations(q, limit = 3) {
    const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length || String(q).trim().length < 2) return [];
    const out = scan(wardIndex, toks, 60);
    if (out.length < limit) {
      const seen = new Set(out.map((s) => s.id));
      for (const s of scan(index, toks, 200)) {
        if (!seen.has(s.id)) out.push(s);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  function chipsFor(kit, activeId, sugg, all, prev, prevLabel) {
    if (activeId !== kit.kit_id) return [];
    const v = (kit.venue || '').trim();
    const out = [];
    if (v.length >= 2) {
      for (const s of sugg) {
        if (s.name.toLowerCase() !== v.toLowerCase()) {
          out.push({ key: 's' + s.id, venue: s.name, tag: s.ward_name || '' });
        }
      }
    } else if (!v) {
      const p = prev[kit.kit_id];
      if (p) out.push({ key: 'prev', venue: p, tag: `Same as ${prevLabel}`, quick: true });
      const other = all.find((k) => k.kit_id !== kit.kit_id && (k.venue || '').trim());
      if (other && (!p || other.venue.trim() !== p)) {
        out.push({ key: 'other', venue: other.venue.trim(), tag: `Same as ${other.kit_name}`, quick: true });
      }
    }
    return out.slice(0, 3);
  }

  // ═══════════════════════════════════════════════════════════
  // EDITING
  // ═══════════════════════════════════════════════════════════
  const isDirtyKit = (k) => {
    const v = (k.venue || '').trim();
    return !!v && v !== k._original;
  };

  function setVenue(kit, v) {
    kit.venue = v;
    kits = kits; // tell Svelte the list changed
  }

  function onVenueInput(kit, value) {
    setVenue(kit, value);
    activeKitId = kit.kit_id;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => (suggestions = searchStations(value)), 140);
  }

  function onFocusKit(kit) {
    clearTimeout(blurTimer);
    activeKitId = kit.kit_id;
    suggestions = (kit.venue || '').trim().length >= 2 ? searchStations(kit.venue) : [];
  }

  function onBlurKit(kit) {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      // an emptied field goes back to what is saved
      if (!(kit.venue || '').trim() && kit._original) setVenue(kit, kit._original);
      if (activeKitId === kit.kit_id) {
        activeKitId = null;
        suggestions = [];
      }
    }, 180);
  }

  function applyChip(kit, chip) {
    setVenue(kit, chip.venue);
    activeKitId = null;
    suggestions = [];
    tick(5);
  }

  function fillRest() {
    const source = kits.find((k) => (k.venue || '').trim());
    if (!source) return;
    const v = source.venue.trim();
    kits = kits.map((k) => ((k.venue || '').trim() ? k : { ...k, venue: v }));
    tick(6);
  }

  function fillFromPrev() {
    kits = kits.map((k) => ((k.venue || '').trim() || !prevVenues[k.kit_id] ? k : { ...k, venue: prevVenues[k.kit_id] }));
    tick(6);
  }

  // ═══════════════════════════════════════════════════════════
  // CALENDAR
  // ═══════════════════════════════════════════════════════════
  function buildCells(y, m, map, t) {
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
    const count = new Date(y, m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= count; d++) {
      const iso = isoOf(y, m, d);
      const info = map[iso];
      const filled = info ? info.filled : 0;
      const total = info ? info.total : 0;
      let status = 'empty';
      if (filled > 0) status = total && filled >= total ? 'complete' : 'partial';
      const pct = status === 'complete' ? 100 : total ? Math.round((filled / total) * 100) : 0;
      out.push({ iso, day: d, filled, total, status, pct, weekend: (lead + d - 1) % 7 >= 5, rel: classifyDate(iso, t) });
    }
    while (out.length % 7) out.push(null);
    return out;
  }

  $: monthKey = monthKeyOf(cursor);
  $: monthMap = maps[monthKey] || {};
  $: cells = buildCells(cursor.y, cursor.m, monthMap, today);
  $: rows = cells.length / 7;
  $: monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString('en-KE', { month: 'long' });
  $: plannedDays = cells.filter((c) => c && c.status !== 'empty').length;
  $: completeDays = cells.filter((c) => c && c.status === 'complete').length;
  $: isCurrentMonth = monthKey === today.slice(0, 7);

  $: tomorrowInfo = (maps[tomorrow.slice(0, 7)] || {})[tomorrow];
  $: tFilled = tomorrowInfo ? tomorrowInfo.filled : 0;
  $: tTotal = tomorrowInfo ? tomorrowInfo.total : 0;
  $: tPct = tTotal ? Math.round((tFilled / tTotal) * 100) : 0;
  $: tText = tFilled === 0 ? 'No venues set yet' : tTotal && tFilled >= tTotal ? `All ${tTotal} kits set` : `${tFilled} of ${tTotal} kits set`;
  $: tAction = tFilled === 0 ? 'Plan' : tTotal && tFilled >= tTotal ? 'Review' : 'Continue';

  function shiftMonth(delta) {
    dir = delta > 0 ? 1 : -1;
    const d = new Date(cursor.y, cursor.m + delta, 1);
    cursor = { y: d.getFullYear(), m: d.getMonth() };
    tick(6);
    loadMonth();
  }

  function jumpToToday() {
    const n = new Date();
    const target = { y: n.getFullYear(), m: n.getMonth() };
    dir = monthKeyOf(target) > monthKey ? 1 : -1;
    cursor = target;
    tick(6);
    loadMonth();
  }

  let tx = 0;
  let ty = 0;
  function swipeStart(e) {
    const t = e.changedTouches[0];
    tx = t.clientX;
    ty = t.clientY;
  }
  function swipeEnd(e) {
    const t = e.changedTouches[0];
    const dx = t.clientX - tx;
    const dy = t.clientY - ty;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6) shiftMonth(dx < 0 ? 1 : -1);
  }

  async function loadMonth(mk = monthKeyOf(cursor)) {
    if (!ward) return;
    const cacheKey = `movement:month:${ward.id}:${mk}`;
    const [y, mm] = mk.split('-').map(Number);
    const m = mm - 1;

    // 1. saved copy first, so the calendar is never empty
    if (!maps[mk]) {
      try {
        const row = await Cache.get(cacheKey);
        if (row?.value) maps = { ...maps, [mk]: row.value };
      } catch { /* ignore */ }
    }

    // 2. server
    try {
      const data = await apiFetch(`/movement/summary/?ward_id=${encodeURIComponent(ward.id)}&month=${mk}`);
      if (data && data.ok && data.days) {
        maps = { ...maps, [mk]: data.days };
        Cache.set(cacheKey, data.days).catch(() => {});
        return;
      }
    } catch { /* fall through */ }

    // 3. offline and nothing saved for this month: rebuild from the saved days
    if (!maps[mk]) {
      const local = {};
      const count = new Date(y, m + 1, 0).getDate();
      await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const iso = isoOf(y, m, i + 1);
          try {
            const row = await Cache.get(`movement:${ward.id}:${iso}`);
            const ks = row?.value?.kits;
            if (Array.isArray(ks)) {
              local[iso] = { filled: ks.filter((k) => (k.venue || '').trim()).length, total: ks.length };
            }
          } catch { /* ignore */ }
        }),
      );
      maps = { ...maps, [mk]: local };
    }
  }

  function rememberDay(iso, filled, total) {
    const mk = iso.slice(0, 7);
    const next = { ...(maps[mk] || {}), [iso]: { filled, total } };
    maps = { ...maps, [mk]: next };
    if (ward) Cache.set(`movement:month:${ward.id}:${mk}`, next).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════
  // OPEN A DAY → FORM
  // ═══════════════════════════════════════════════════════════
  async function openDay(iso) {
    tick(10);
    selectedDate = iso;
    dateRelation = classifyDate(iso, today);
    kits = [];
    prevVenues = {};
    formPhase = 'loading';
    formError = '';
    fromCache = false;
    activeKitId = null;
    suggestions = [];
    askDiscard = false;
    if (scroller) scroller.scrollTop = 0;
    view = 'form';
    loadPrev(iso);
    await loadKits();
  }

  function backToCalendar() {
    if (anyDirty) {
      askDiscard = true;
      return;
    }
    closeForm();
  }

  function closeForm() {
    askDiscard = false;
    activeKitId = null;
    suggestions = [];
    view = 'calendar';
  }

  async function loadPrev(day) {
    if (!ward) return;
    const prevIso = shiftIso(day, -1);
    const key = `movement:${ward.id}:${prevIso}`;
    const read = (d) => {
      const m = {};
      for (const k of d?.kits || []) {
        const v = (k.venue || '').trim();
        if (v) m[k.kit_id] = v;
      }
      return m;
    };
    try {
      const row = await Cache.get(key);
      if (row?.value && day === selectedDate) prevVenues = read(row.value);
    } catch { /* ignore */ }
    try {
      const d = await apiFetch(`/movement/kits/?ward_id=${encodeURIComponent(ward.id)}&date=${prevIso}`);
      if (d?.ok && day === selectedDate) {
        prevVenues = read(d);
        Cache.set(key, d).catch(() => {});
      }
    } catch { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD KITS: saved copy first, then server
  // ═══════════════════════════════════════════════════════════
  async function loadKits() {
    if (!ward || !selectedDate) return;
    const day = selectedDate;
    const key = `movement:${ward.id}:${day}`;

    let cached = null;
    try {
      cached = (await Cache.get(key))?.value || null;
    } catch { /* ignore */ }
    if (day !== selectedDate) return;

    if (cached?.kits) {
      await applyKits(cached);
      if (day !== selectedDate) return;
      fromCache = true;
      formPhase = 'ready';
    }

    try {
      const data = await apiFetch(`/movement/kits/?ward_id=${encodeURIComponent(ward.id)}&date=${day}`);
      if (day !== selectedDate) return;

      if (!data.ok) {
        if (!cached) {
          formPhase = 'error';
          formError = data.error || 'Could not load kits.';
        }
        return;
      }

      Cache.set(key, data).catch(() => {});
      // never overwrite what the VRA is typing
      if (!kits.some(isDirtyKit)) await applyKits(data);
      if (day !== selectedDate) return;
      fromCache = false;
      formPhase = 'ready';
    } catch (err) {
      if (day !== selectedDate) return;
      if (!cached) {
        formPhase = 'error';
        formError =
          navigator.onLine === false
            ? "You're offline and this day isn't saved on this device yet."
            : err.message || 'Failed to load.';
      }
    }
  }

  async function applyKits(data) {
    constituency = { id: data.constituency_id, name: data.constituency_name };

    if (data.is_past) dateRelation = 'past';
    else if (data.is_today) dateRelation = 'today';
    else dateRelation = classifyDate(selectedDate, today);

    // plans saved on this device but not sent yet
    const queuedByKit = new Map();
    try {
      const ops = await Queue.all();
      for (const op of ops) {
        if (op.kind !== 'movement.save' || op.state === 'done' || op.state === 'gaveup') continue;
        if (op.payload?.schedule_date !== selectedDate) continue;
        if (String(op.payload?.ward_id) !== String(ward.id)) continue;
        for (const e of op.payload.entries || []) queuedByKit.set(String(e.kit_id), e.venue);
      }
    } catch { /* ignore */ }

    kits = (data.kits || []).map((k) => {
      const pending = queuedByKit.get(String(k.kit_id));
      const venue = pending !== undefined ? pending : k.venue || '';
      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue,
        _original: venue.trim(), // queued venues count as saved
        pending: pending !== undefined,
        has_schedule: !!k.has_schedule,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DERIVED (form)
  // ═══════════════════════════════════════════════════════════
  $: editable = dateRelation !== 'past';
  $: dirtyCount = kits.filter(isDirtyKit).length;
  $: anyDirty = editable && dirtyCount > 0;
  $: filledCount = kits.filter((k) => (k.venue || '').trim()).length;
  $: progress = kits.length ? Math.round((filledCount / kits.length) * 100) : 0;
  $: canFillRest = editable && filledCount > 0 && filledCount < kits.length;
  $: prevLabel = selectedDate ? fmt(shiftIso(selectedDate, -1), { weekday: 'short' }) : '';
  $: canUsePrev = editable && kits.some((k) => !(k.venue || '').trim() && prevVenues[k.kit_id]);
  $: showSave = editable && formPhase === 'ready' && kits.length > 0;

  // ═══════════════════════════════════════════════════════════
  // SAVE (through the core queue; same op id = idempotency key)
  // ═══════════════════════════════════════════════════════════
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
    if (typeof out === 'object') await discardOp(op.id); // rejected: don't keep retrying
    return out;
  }

  async function cacheDay(day, list) {
    const key = `movement:${ward.id}:${day}`;
    try {
      const row = await Cache.get(key);
      await Cache.set(key, {
        ...(row?.value || {}),
        ok: true,
        kits: list.map((k) => ({
          kit_id: k.kit_id,
          kit_name: k.kit_name,
          serial_no: k.serial_no,
          venue: k.venue,
          has_schedule: !!(k.venue || '').trim(),
        })),
      });
    } catch { /* ignore */ }
  }

  async function saveAll() {
    if (!editable || saving || !anyDirty) return;

    const entries = kits.filter(isDirtyKit).map((k) => ({ kit_id: k.kit_id, venue: k.venue.trim() }));
    if (entries.length === 0) {
      showToast('err', 'Nothing to save.');
      return;
    }

    const payload = {
      ward_id: ward.id,
      fingerprint: $session.fingerprint,
      schedule_date: selectedDate,
      entries,
    };

    saving = true;
    const day = selectedDate;
    const snapshot = kits;
    kits = kits.map((k) => ({ ...k, _original: (k.venue || '').trim() }));

    try {
      const out = await sendOp('movement.save', payload);

      if (typeof out === 'object') {
        kits = snapshot; // put the form back so they can fix it
        showToast('err', out.failed);
        return;
      }

      const n = entries.length;
      await cacheDay(day, kits);
      rememberDay(day, kits.filter((k) => (k.venue || '').trim()).length, kits.length);
      showToast(
        out === 'sent' ? 'ok' : 'queued',
        out === 'sent' ? `${n} venue${n === 1 ? '' : 's'} saved` : 'Saved on this device · will sync when online',
      );
      tick([12, 40, 12]);

      closeTimer = setTimeout(() => {
        const mk = day.slice(0, 7);
        if (mk !== monthKey) {
          const [y, mm] = mk.split('-').map(Number);
          dir = mk > monthKey ? 1 : -1;
          cursor = { y, m: mm - 1 };
        }
        justSaved = day;
        closeForm();
        clearTimeout(popTimer);
        popTimer = setTimeout(() => (justSaved = ''), 2000);
      }, 650);
    } catch (err) {
      kits = snapshot;
      showToast('err', err.message || 'Could not save.');
    } finally {
      saving = false;
    }
  }
</script>

<PageTransition>
  <div class="mp">
    {#if gate !== 'ok'}
      <!-- ═══════════════════ SESSION GATES ═══════════════════ -->
      <div class="gate">
        <button class="icon-btn gate-back" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6L9 12L15 18" /></svg>
        </button>
        <div class="center">
          {#if gate === 'loading'}
            <div class="spinner"></div>
            <p class="center-text">Loading…</p>
          {:else if gate === 'unbound'}
            <div class="tile">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7A4 4 0 0 1 16 7V10" />
              </svg>
            </div>
            <h2 class="center-title">Set up this device first</h2>
            <p class="center-text">Choose your ward on the home screen to continue.</p>
          {:else}
            <div class="tile danger">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
              </svg>
            </div>
            <h2 class="center-title">Something went wrong</h2>
            <p class="center-text">{errorMsg}</p>
          {/if}
        </div>
      </div>
    {:else}
      <div class="viewport">
        <div class="track" class:show-form={view === 'form'}>

          <!-- ═══════════════════ CALENDAR PANEL ═══════════════════ -->
          <section class="panel" inert={view !== 'calendar'} aria-hidden={view !== 'calendar'}>
            <header class="hero">
              <div class="hero-top">
                <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6L9 12L15 18" /></svg>
                </button>
                <div class="hero-meta">
                  <div class="hero-ward">{ward.name}</div>
                  {#if constituency && constituency.name}
                    <div class="hero-sub">{constituency.name} Constituency</div>
                  {:else if $session.constituency}
                    <div class="hero-sub">{$session.constituency.name} Constituency</div>
                  {/if}
                </div>
                <div class="sync-wrap"><SyncBadge /></div>
              </div>

              <button class="next" on:click={() => openDay(tomorrow)}>
                <div class="next-body">
                  <div class="next-label">Tomorrow · {dateShort(tomorrow)}</div>
                  <div class="next-text">{tText}</div>
                  <div class="next-bar"><span style="width: {tPct}%"></span></div>
                </div>
                <span class="next-action">
                  {tAction}
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6L15 12L9 18" /></svg>
                </span>
              </button>
            </header>

            <div class="sheet" role="presentation" on:touchstart|passive={swipeStart} on:touchend|passive={swipeEnd}>
              <div class="sheet-head">
                <div>
                  <h1 class="cal-title">{monthName} <span>{cursor.y}</span></h1>
                  <div class="cal-sub">
                    {#if failed > 0}
                      <span class="warn">{failed} change{failed === 1 ? '' : 's'} couldn't be sent</span>
                    {:else if waiting > 0}
                      <span class="warn">{waiting} waiting to send</span>
                    {:else if plannedDays === 0}
                      Nothing planned yet
                    {:else}
                      {plannedDays} planned · {completeDays} complete
                    {/if}
                  </div>
                </div>
                <div class="cal-nav">
                  {#if !isCurrentMonth}
                    <button class="pill" on:click={jumpToToday}>Today</button>
                  {/if}
                  <button class="icon-btn sm" on:click={() => shiftMonth(-1)} aria-label="Previous month">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6L9 12L15 18" /></svg>
                  </button>
                  <button class="icon-btn sm" on:click={() => shiftMonth(1)} aria-label="Next month">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6L15 12L9 18" /></svg>
                  </button>
                </div>
              </div>

              <div class="weekdays">
                {#each WEEKDAYS as w}<span>{w}</span>{/each}
              </div>

              <div class="mesh-wrap">
                {#key monthKey}
                  <div class="mesh" style="--rows: {rows}" in:fly={{ x: dir * 32, duration: 260, easing: cubicOut }}>
                    {#each cells as c}
                      {#if c === null}
                        <span class="blank"></span>
                      {:else}
                        <button
                          type="button"
                          class="day {c.status} {c.rel}"
                          class:weekend={c.weekend}
                          class:is-today={c.rel === 'today'}
                          class:pop={c.iso === justSaved}
                          on:click={() => openDay(c.iso)}
                          aria-label={`${weekdayLong(c.iso)} ${dateFull(c.iso)}. ${
                            c.status === 'empty' ? 'No venues set' : `${c.filled} of ${c.total} venues set`
                          }`}
                        >
                          <span class="fill" style="height: {c.pct}%"></span>
                          <span class="day-num">{c.day}</span>
                          {#if c.status === 'partial'}
                            <span class="day-count">{c.filled}/{c.total}</span>
                          {:else if c.status === 'complete'}
                            <svg class="day-check" viewBox="0 0 24 24" width="14" height="14" fill="none"
                                 stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12.5L10 17.5L19 7" />
                            </svg>
                          {/if}
                        </button>
                      {/if}
                    {/each}
                  </div>
                {/key}
              </div>

              <div class="legend">
                <span><i class="key k-empty"></i>Not set</span>
                <span><i class="key k-partial"></i>Partly set</span>
                <span><i class="key k-complete"></i>All set</span>
              </div>
            </div>
          </section>

          <!-- ═══════════════════ FORM PANEL ═══════════════════ -->
          <section class="panel" inert={view !== 'form'} aria-hidden={view !== 'form'}>
            <header class="hero form-hero">
              <div class="hero-top">
                <button class="glass-btn" on:click={backToCalendar} aria-label="Back to calendar">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6L9 12L15 18" /></svg>
                </button>
                <div class="hero-meta">
                  <div class="hero-sub solo">{ward.name}</div>
                </div>
                <div class="sync-wrap"><SyncBadge /></div>
              </div>

              {#if selectedDate}
                <h2 class="day-title">{weekdayLong(selectedDate)}</h2>
                <div class="day-line">
                  <span>{dateFull(selectedDate)}</span>
                  <span class="chip {dateRelation}">
                    {dateRelation === 'past' ? 'Read-only' : dateRelation === 'today' ? 'Today' : 'Upcoming'}
                  </span>
                </div>
              {/if}
            </header>

            <div class="sheet form-sheet">
              <div class="fscroll" bind:this={scroller}>
                {#if fromCache}
                  <div class="notice">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="9" /><path d="M12 8V12L15 14" />
                    </svg>
                    <span>Showing saved data. Changes sync when you're back online.</span>
                  </div>
                {/if}

                {#if formPhase === 'loading'}
                  <div class="skeleton">
                    {#each Array(3) as _}<div class="sk"></div>{/each}
                  </div>

                {:else if formPhase === 'error'}
                  <div class="center small">
                    <div class="tile danger">
                      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                           stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
                      </svg>
                    </div>
                    <h2 class="center-title">Could not load kits</h2>
                    <p class="center-text">{formError}</p>
                    <button class="pill retry" on:click={loadKits}>Try again</button>
                  </div>

                {:else if kits.length === 0}
                  <div class="empty">No kits assigned to this ward.</div>

                {:else}
                  <div class="form-head">
                    <div>
                      <div class="form-head-label">Kit venues</div>
                      <div class="form-head-count">{filledCount} of {kits.length} set</div>
                    </div>
                  </div>
                  <div class="progress"><span style="width: {progress}%"></span></div>

                  {#if canUsePrev || canFillRest}
                    <div class="pills">
                      {#if canUsePrev}
                        <button class="pill" on:click={fillFromPrev}>Use {prevLabel}'s venues</button>
                      {/if}
                      {#if canFillRest}
                        <button class="pill" on:click={fillRest}>Fill the rest</button>
                      {/if}
                    </div>
                  {/if}

                  <div class="kits">
                    {#each kits as kit (kit.kit_id)}
                      {@const chips = chipsFor(kit, activeKitId, suggestions, kits, prevVenues, prevLabel)}
                      {@const isSet = !!(kit.venue || '').trim()}
                      <div class="kit" class:filled={isSet} class:readonly={!editable}>
                        <div class="kit-top">
                          <span class="kit-state" class:on={isSet}>
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
                                 stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12.5L10 17.5L19 7" />
                            </svg>
                          </span>
                          <span class="kit-name">{kit.kit_name}</span>
                          {#if kit.pending}<span class="tag-q">Queued</span>{/if}
                          <span class="kit-serial">{kit.serial_no}</span>
                        </div>

                        {#if editable}
                          <label class="field">
                            <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                                 stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M20 10.5C20 15 13 21.5 13 21.5C13 21.5 4 15 4 9.5C4 5.6 7.6 2 11.5 2C15.4 2 20 5.6 20 10.5Z" />
                              <circle cx="11.5" cy="9.5" r="2.5" />
                            </svg>
                            <input
                              type="text"
                              value={kit.venue}
                              on:input={(e) => onVenueInput(kit, e.currentTarget.value)}
                              on:focus={() => onFocusKit(kit)}
                              on:blur={() => onBlurKit(kit)}
                              placeholder="Enter venue"
                              autocomplete="off"
                              autocapitalize="words"
                              spellcheck="false"
                            />
                          </label>

                          {#if chips.length}
                            <div class="schips">
                              {#each chips as c (c.key)}
                                <button
                                  type="button"
                                  class="schip"
                                  class:quick={c.quick}
                                  on:pointerdown|preventDefault
                                  on:click={() => applyChip(kit, c)}
                                >
                                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                                       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                                  </svg>
                                  <span class="s-name">{c.venue}</span>
                                  {#if c.tag}<span class="s-tag">{c.tag}</span>{/if}
                                </button>
                              {/each}
                            </div>
                          {/if}
                        {:else}
                          <div class="field static">
                            <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                                 stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M20 10.5C20 15 13 21.5 13 21.5C13 21.5 4 15 4 9.5C4 5.6 7.6 2 11.5 2C15.4 2 20 5.6 20 10.5Z" />
                              <circle cx="11.5" cy="9.5" r="2.5" />
                            </svg>
                            <span class="static-value" class:none={!kit.venue}>{kit.venue || 'No venue recorded'}</span>
                          </div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>

              {#if showSave}
                <div class="savebar">
                  <button class="cta" on:click={saveAll} disabled={!anyDirty || saving}>
                    {#if saving}
                      Saving…
                    {:else if anyDirty}
                      Save {dirtyCount} venue{dirtyCount === 1 ? '' : 's'}
                    {:else}
                      Save movement plan
                    {/if}
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
                </div>
              {/if}
            </div>
          </section>
        </div>
      </div>

      {#if askDiscard}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <div class="scrim" on:click={() => (askDiscard = false)} role="presentation"></div>
        <div class="ask" role="dialog" aria-modal="true" aria-label="Discard changes?"
             transition:fly={{ y: 40, duration: 240, easing: cubicOut }}>
          <div class="ask-title">Discard changes?</div>
          <p>You have {dirtyCount} venue{dirtyCount === 1 ? '' : 's'} that {dirtyCount === 1 ? 'is' : 'are'} not saved yet.</p>
          <div class="ask-row">
            <button class="ask-btn" on:click={() => (askDiscard = false)}>Keep editing</button>
            <button class="ask-btn red" on:click={closeForm}>Discard</button>
          </div>
        </div>
      {/if}

      {#if toast}
        <div class="toast" role="status" transition:fly={{ y: -10, duration: 220, easing: cubicOut }}>
          <i class="toast-dot {toast.kind}"></i>{toast.text}
        </div>
      {/if}
    {/if}
  </div>
</PageTransition>

<style>
  .mp {
    --acc: #2f6fe0;
    --acc-d: #1f55b8;
    --acc-l: #e7f0ff;
    --g-700: #087451;
    --g-600: #0b9a68;
    --g-500: #18b77d;
    --g-100: #d9f8e9;
    --g-50: #effcf6;

    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --paper: #f6f8fb;

    --amber: #f0a92a;
    --amber-ink: #8f5a00;
    --amber-soft: #fff4dc;
    --red: #e23b3b;
    --red-d: #b23a32;
    --red-soft: #ffe8e8;

    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #08142f;
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

  .viewport { flex: 1; min-height: 0; overflow: hidden; }
  .track { display: flex; width: 200%; height: 100%; transition: transform 0.46s var(--ease); }
  .track.show-form { transform: translateX(-50%); }
  .panel { width: 50%; height: 100%; min-width: 0; display: flex; flex-direction: column; flex-shrink: 0; }

  /* ── Buttons ────────────────────────────────────────── */
  .icon-btn, .glass-btn {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 13px;
    cursor: pointer;
    flex-shrink: 0;
    transition: transform 0.16s var(--ease), background 0.2s var(--ease);
  }
  .icon-btn { border: 1px solid var(--line); background: #fff; color: var(--ink); }
  .icon-btn.sm { width: 34px; height: 34px; border-radius: 12px; }
  .glass-btn {
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
  .icon-btn:active, .glass-btn:active, .pill:active { transform: scale(0.93); }

  .pill {
    border: none;
    background: var(--acc-l);
    color: var(--acc-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 720;
    padding: 9px 14px;
    border-radius: 999px;
    cursor: pointer;
    transition: transform 0.16s var(--ease);
  }
  .pill.retry { margin-top: 16px; }

  .icon-btn:focus-visible, .glass-btn:focus-visible, .pill:focus-visible,
  .day:focus-visible, .next:focus-visible, .cta:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  /* ── Hero ───────────────────────────────────────────── */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 36px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(100, 160, 255, 0.36), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(30, 80, 200, 0.3), transparent 55%),
      linear-gradient(150deg, #08142f 0%, #12306b 58%, #1d4a9c 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; margin-bottom: 14px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-ward {
    font-size: clamp(21px, 6vw, 26px);
    font-weight: 780;
    letter-spacing: -0.05em;
    line-height: 1.05;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hero-sub { margin-top: 4px; font-size: 12px; font-weight: 600; color: rgba(255, 255, 255, 0.72); }
  .hero-sub.solo {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.85);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sync-wrap { display: inline-flex; align-items: center; flex-shrink: 0; }

  .next {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.09);
    color: #fff;
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    transition: transform 0.16s var(--ease), background 0.2s var(--ease);
  }
  .next:active { transform: scale(0.985); background: rgba(255, 255, 255, 0.14); }
  .next-body { flex: 1; min-width: 0; }
  .next-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.02em; color: rgba(255, 255, 255, 0.66); margin-bottom: 2px; }
  .next-text { font-size: 15px; font-weight: 720; letter-spacing: -0.02em; margin-bottom: 8px; }
  .next-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.16); overflow: hidden; }
  .next-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #8dc2ff, #e3f0ff);
    transition: width 0.5s var(--ease);
  }
  .next-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 9px 10px 9px 14px;
    border-radius: 999px;
    background: #fff;
    color: #12306b;
    font-size: 12.5px;
    font-weight: 760;
    flex-shrink: 0;
  }

  /* ── Sheet ──────────────────────────────────────────── */
  .sheet {
    position: relative;
    flex: 1;
    min-height: 0;
    margin-top: -24px;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .sheet-head {
    flex: none;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 16px 12px;
  }
  .cal-title { margin: 0; font-size: clamp(21px, 5.6vw, 25px); font-weight: 780; letter-spacing: -0.055em; line-height: 1.05; }
  .cal-title span { color: var(--ink-3); font-weight: 450; }
  .cal-sub { margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--ink-3); }
  .cal-sub .warn { color: var(--amber-ink); font-weight: 700; }
  .cal-nav { display: flex; align-items: center; gap: 6px; }

  .weekdays {
    flex: none;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    padding: 7px 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    text-align: center;
    font-size: 10.5px;
    font-weight: 750;
    letter-spacing: 0.06em;
    color: var(--ink-3);
  }

  /* ── Calendar grid ──────────────────────────────────── */
  .mesh-wrap { flex: 1; min-height: 0; overflow: hidden; background: var(--line); }
  .mesh {
    height: 100%;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
    gap: 1px;
    background: var(--line);
  }
  .blank { background: #f8fafc; }

  .day {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: space-between;
    min-width: 0;
    min-height: 0;
    padding: 6px 6px 5px;
    border: none;
    border-radius: 0;
    background: #fff;
    color: var(--ink);
    font: inherit;
    overflow: hidden;
    cursor: pointer;
    transition: background 0.15s var(--ease);
  }
  .day:active { background: var(--acc-l); }
  .fill { position: absolute; left: 0; right: 0; bottom: 0; height: 0; transform-origin: bottom; pointer-events: none; }
  .day-num, .day-count, .day-check { position: relative; z-index: 1; }
  .day-num {
    align-self: flex-start;
    min-width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 620;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .day-count { align-self: flex-end; font-size: 9.5px; font-weight: 760; color: var(--amber-ink); }
  .day-check { align-self: flex-end; color: #fff; }

  .day.weekend .day-num { color: var(--ink-3); }
  .day.past.empty .day-num { color: #b8c2d2; font-weight: 450; }

  .day.partial { background: var(--amber-soft); }
  .day.partial .fill { background: linear-gradient(to top, #f2ac2e, #ffd884); opacity: 0.85; }
  .day.partial .day-num { color: var(--amber-ink); font-weight: 760; }

  .day.complete { background: var(--g-600); }
  .day.complete .fill { background: linear-gradient(160deg, var(--g-700), var(--g-500)); }
  .day.complete .day-num { color: #fff; font-weight: 760; }
  .day.complete:active { background: var(--g-700); }

  .day.past.partial, .day.past.complete { filter: saturate(0.8); }

  .day.is-today .day-num { background: var(--ink); color: #fff; font-weight: 760; }
  .day.is-today.complete .day-num { background: #fff; color: var(--g-700); }
  .day.is-today.partial .day-num { background: var(--amber-ink); color: #fff; }

  .day.pop { z-index: 3; animation: cell-pop 0.8s var(--ease) 0.5s both; }
  .day.pop .fill { animation: fill-up 0.9s var(--ease) 0.5s both; }
  @keyframes fill-up { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @keyframes cell-pop {
    0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(11, 154, 104, 0.5); }
    40% { transform: scale(1.09); box-shadow: 0 10px 24px -6px rgba(11, 154, 104, 0.55); }
    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(11, 154, 104, 0); }
  }

  .legend {
    flex: none;
    display: flex;
    justify-content: center;
    gap: 4px 16px;
    padding: 9px 12px calc(9px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: #fff;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3);
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .key { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .k-empty { background: #fff; box-shadow: inset 0 0 0 1px #d5dce8; }
  .k-partial { background: linear-gradient(to top, #f2ac2e 55%, var(--amber-soft) 55%); }
  .k-complete { background: var(--g-600); }

  /* ── Form ───────────────────────────────────────────── */
  .form-hero { padding-bottom: 38px; }
  .day-title { margin: 2px 2px 6px; font-size: clamp(30px, 9vw, 40px); font-weight: 790; letter-spacing: -0.065em; line-height: 0.98; }
  .day-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.78); }
  .chip { padding: 4px 10px; border-radius: 999px; font-size: 10.5px; font-weight: 760; background: rgba(255, 255, 255, 0.16); color: #fff; }
  .chip.today { background: #9ccbff; color: #08142f; }
  .chip.past { background: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.7); }

  .form-sheet { background: var(--paper); }
  .fscroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 18px 14px 20px;
    scroll-padding-bottom: 160px;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 13px;
    margin-bottom: 14px;
    border-radius: 16px;
    background: var(--amber-soft);
    color: var(--amber-ink);
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.4;
  }
  .notice svg { flex-shrink: 0; }

  .form-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 0 2px 9px; }
  .form-head-label { font-size: 16px; font-weight: 780; letter-spacing: -0.03em; }
  .form-head-count { margin-top: 2px; font-size: 12px; font-weight: 600; color: var(--ink-3); }
  .progress { height: 5px; border-radius: 999px; background: #dfe6f0; overflow: hidden; margin: 0 2px 12px; }
  .progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--acc-d), #5b9bff); transition: width 0.4s var(--ease); }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 2px 14px; }

  .kits { display: flex; flex-direction: column; gap: 10px; }
  .kit {
    padding: 13px;
    border-radius: 20px;
    background: #fff;
    border: 1px solid var(--line);
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 12px 24px -20px rgba(14, 31, 63, 0.3);
    transition: border-color 0.2s var(--ease);
  }
  .kit.filled { border-color: #cfe8dd; }
  .kit.readonly { opacity: 0.92; }

  .kit-top { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
  .kit-state {
    width: 21px;
    height: 21px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--paper);
    color: transparent;
    box-shadow: inset 0 0 0 1.5px #d5dce8;
    flex-shrink: 0;
    transition: background 0.2s var(--ease), color 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }
  .kit-state.on { background: var(--g-600); color: #fff; box-shadow: none; }
  .kit-name { flex: 1; min-width: 0; font-size: 14px; font-weight: 740; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag-q { padding: 3px 8px; border-radius: 999px; background: var(--amber-soft); color: var(--amber-ink); font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; flex-shrink: 0; }
  .kit-serial {
    max-width: 40%;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    box-sizing: border-box;
    padding: 13px 13px;
    border: 1.5px solid transparent;
    border-radius: 15px;
    background: var(--paper);
    transition: border-color 0.2s var(--ease), background 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }
  .field:focus-within { border-color: var(--acc); background: #fff; box-shadow: 0 0 0 4px rgba(47, 111, 224, 0.12); }
  .field-icon { color: #8f9bb0; flex-shrink: 0; transition: color 0.2s var(--ease); }
  .field:focus-within .field-icon { color: var(--acc); }
  .field input {
    flex: 1;
    min-width: 0;
    width: 100%;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    -webkit-user-select: text;
    user-select: text;
  }
  .field input::placeholder { color: #9ba7ba; }
  .static-value { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .static-value.none { color: var(--ink-3); font-style: italic; font-weight: 450; }

  /* Suggestions */
  .schips { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 9px; }
  .schip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 9px 13px;
    border: 1px solid #d6e4fb;
    border-radius: 999px;
    background: var(--acc-l);
    color: var(--acc-d);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    animation: rise 0.2s var(--ease) both;
    transition: transform 0.16s var(--ease), background 0.16s var(--ease);
  }
  .schip.quick { background: var(--g-50); border-color: var(--g-100); color: #067552; }
  .schip:active { transform: scale(0.97); }
  .schip > svg { flex-shrink: 0; }
  .s-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-tag {
    padding: 2px 7px;
    border-radius: 6px;
    background: rgba(47, 111, 224, 0.14);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .schip.quick .s-tag { background: rgba(11, 154, 104, 0.16); }
  @keyframes rise { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }

  /* Save bar */
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
    background: linear-gradient(135deg, var(--acc-d), var(--acc));
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 760;
    letter-spacing: -0.012em;
    cursor: pointer;
    box-shadow: 0 14px 26px -14px rgba(31, 85, 184, 0.8);
    transition: transform 0.16s var(--ease);
  }
  .cta:active:not(:disabled) { transform: scale(0.985); }
  .cta:disabled { background: #cbd2de; box-shadow: none; cursor: not-allowed; }
  .hint { margin-top: 8px; text-align: center; font-size: 11.5px; font-weight: 600; color: var(--ink-3); }
  .hint.ready { color: var(--acc-d); font-weight: 750; }

  /* Discard sheet */
  .scrim { position: fixed; inset: 0; z-index: 60; background: rgba(8, 20, 47, 0.5); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
  .ask {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    max-width: 480px;
    margin: 0 auto;
    padding: 22px 18px calc(18px + env(safe-area-inset-bottom));
    border-radius: 28px 28px 0 0;
    background: #fff;
    box-shadow: 0 -24px 60px rgba(8, 20, 47, 0.3);
  }
  .ask-title { font-size: 18px; font-weight: 790; letter-spacing: -0.035em; }
  .ask p { margin: 6px 0 18px; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); }
  .ask-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .ask-btn {
    padding: 14px;
    border: 0;
    border-radius: 16px;
    background: #f1f4f8;
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    font-weight: 740;
    cursor: pointer;
  }
  .ask-btn.red { background: var(--red); color: #fff; }
  .ask-btn:active { transform: scale(0.98); }

  /* Toast */
  .toast {
    position: fixed;
    left: 0;
    right: 0;
    top: calc(14px + env(safe-area-inset-top));
    margin: 0 auto;
    width: max-content;
    max-width: calc(100% - 28px);
    z-index: 70;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 18px;
    border-radius: 999px;
    background: rgba(8, 20, 47, 0.95);
    color: #fff;
    font-size: 12.5px;
    font-weight: 650;
    box-shadow: 0 18px 40px rgba(8, 20, 47, 0.3);
  }
  .toast-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .toast-dot.ok { background: #6ee7b0; box-shadow: 0 0 9px rgba(110, 231, 176, 0.6); }
  .toast-dot.queued { background: #f5c15c; }
  .toast-dot.err { background: #ff8b82; }

  /* Gates / empty / loading */
  .gate { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: calc(12px + env(safe-area-inset-top)) 14px 14px; background: var(--paper); }
  .gate-back { align-self: flex-start; }
  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 28px 60px; text-align: center; }
  .center.small { flex: none; min-height: 28vh; padding-bottom: 30px; }
  .center-title { margin: 16px 0 5px; font-size: 18px; font-weight: 780; letter-spacing: -0.03em; }
  .center-text { max-width: 290px; margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-3); }
  .tile { width: 60px; height: 60px; border-radius: 20px; display: flex; align-items: center; justify-content: center; background: var(--acc-l); color: var(--acc); }
  .tile.danger { background: var(--red-soft); color: var(--red); }
  .spinner { width: 26px; height: 26px; margin-bottom: 11px; border: 2.5px solid #dfe6f0; border-top-color: var(--acc); border-radius: 50%; animation: spin 0.75s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { padding: 36px 20px; border: 1px dashed #cfd6e2; border-radius: 20px; background: rgba(255, 255, 255, 0.7); color: var(--ink-3); font-size: 13px; text-align: center; }

  .skeleton { display: flex; flex-direction: column; gap: 10px; }
  .sk {
    height: 92px;
    border-radius: 20px;
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  @media (prefers-reduced-motion: reduce) {
    .track, .day, .cta, .next, .progress span, .next-bar span, .kit-state, .schip { transition: none; animation: none; }
    .day.pop, .day.pop .fill { animation: none; }
    .sk, .spinner { animation-duration: 2s; }
  }
</style>