<script>
  import { createEventDispatcher, onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { session } from "../lib/session.js";
  import { apiFetch } from "../lib/api.js";
  import { cacheGet, cacheSet, enqueue, drainQueue } from "../lib/offline.js";
  import SyncBadge from "../components/SyncBadge.svelte";
  import PageTransition from "../components/PageTransition.svelte";

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // DATE HELPERS (local time — Kenya is UTC+3)
  // ═══════════════════════════════════════════════════════════
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const localIso = (d) => isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  const parseIso = (iso) => new Date(iso + "T00:00:00");
  const today = localIso(new Date());
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localIso(d);
  })();

  function classifyDate(iso) {
    if (iso === today) return "today";
    return iso < today ? "past" : "future";
  }

  const fmt = (iso, opts) => parseIso(iso).toLocaleDateString("en-KE", opts);
  const weekdayLong = (iso) => fmt(iso, { weekday: "long" });
  const dateFull = (iso) =>
    fmt(iso, { day: "numeric", month: "long", year: "numeric" });
  const dateShort = (iso) =>
    fmt(iso, { weekday: "short", day: "numeric", month: "short" });

  const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
  const monthKeyOf = (c) => `${c.y}-${pad(c.m + 1)}`;

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════
  let gate = "loading"; // loading | unbound | error | ok
  let errorMsg = "";

  let ward = null;
  let constituency = null;

  let cursor = { y: new Date().getFullYear(), m: new Date().getMonth() };
  let maps = {}; // { 'YYYY-MM': { 'YYYY-MM-DD': { filled, total } } }
  let dir = 1; // month slide direction
  let justSaved = ""; // day that pops after a save

  let view = "calendar"; // calendar | form

  let formPhase = "loading"; // loading | ready | error
  let formError = "";
  let fromCache = false;
  let selectedDate = "";
  let dateRelation = "future";
  let kits = [];
  let saving = false;
  let scroller;

  let toast = null;
  let toastTimer = null;
  let closeTimer = null;
  let popTimer = null;

  // ═══════════════════════════════════════════════════════════
  // SESSION
  // ═══════════════════════════════════════════════════════════
  $: if ($session.status === "unbound") gate = "unbound";

  $: if ($session.status === "bound" && $session.ward && !ward) {
    ward = $session.ward;
    gate = "ok";
    loadMonth();
    if (tomorrow.slice(0, 7) !== monthKeyOf(cursor))
      loadMonth(tomorrow.slice(0, 7));
  }

  $: if ($session.status === "error") {
    gate = "error";
    errorMsg = $session.error || "Session error.";
  }

  // ═══════════════════════════════════════════════════════════
  // PANEL SWITCHING + TOAST + HAPTIC
  // ═══════════════════════════════════════════════════════════
  const tick = (ms = 8) => {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {}
  };

  function go(target) {
    view = target;
  }

  function showToast(kind, text) {
    if (toastTimer) clearTimeout(toastTimer);
    toast = { kind, text };
    toastTimer = setTimeout(() => {
      toast = null;
      toastTimer = null;
    }, 3200);
  }

  // ═══════════════════════════════════════════════════════════
  // CALENDAR
  // ═══════════════════════════════════════════════════════════
  function buildCells(y, m, map) {
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
    const count = new Date(y, m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= count; d++) {
      const iso = isoOf(y, m, d);
      const info = map[iso];
      const filled = info ? info.filled : 0;
      const total = info ? info.total : 0;
      let status = "empty";
      if (filled > 0)
        status = total && filled >= total ? "complete" : "partial";
      const pct = status === "complete" ? 100 : total ? Math.round((filled / total) * 100) : 0;
      out.push({
        iso,
        day: d,
        filled,
        total,
        status,
        pct,
        weekend: (lead + d - 1) % 7 >= 5,
        rel: classifyDate(iso),
      });
    }
    while (out.length % 7) out.push(null); // complete the last row
    return out;
  }

  $: monthKey = monthKeyOf(cursor);
  $: monthMap = maps[monthKey] || {};
  $: cells = buildCells(cursor.y, cursor.m, monthMap);
  $: rows = cells.length / 7;
  $: monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-KE", {
    month: "long",
  });
  $: plannedDays = cells.filter((c) => c && c.status !== "empty").length;
  $: completeDays = cells.filter((c) => c && c.status === "complete").length;
  $: isCurrentMonth =
    cursor.y === new Date().getFullYear() && cursor.m === new Date().getMonth();

  // Tomorrow card
  $: tomorrowInfo = (maps[tomorrow.slice(0, 7)] || {})[tomorrow];
  $: tFilled = tomorrowInfo ? tomorrowInfo.filled : 0;
  $: tTotal = tomorrowInfo ? tomorrowInfo.total : 0;
  $: tPct = tTotal ? Math.round((tFilled / tTotal) * 100) : 0;
  $: tText =
    tFilled === 0
      ? "No venues set yet"
      : tTotal && tFilled >= tTotal
        ? `All ${tTotal} kits set`
        : `${tFilled} of ${tTotal} kits set`;
  $: tAction =
    tFilled === 0
      ? "Plan"
      : tTotal && tFilled >= tTotal
        ? "Review"
        : "Continue";

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

  // Swipe left/right on the calendar to change month
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
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6)
      shiftMonth(dx < 0 ? 1 : -1);
  }

  async function loadMonth(mk = monthKeyOf(cursor)) {
    if (!ward) return;
    const cacheKey = `movement:month:${ward.id}:${mk}`;
    const [y, mm] = mk.split("-").map(Number);
    const m = mm - 1;

    try {
      const data = await apiFetch(
        `/movement/summary/?ward_id=${encodeURIComponent(ward.id)}&month=${mk}`,
      );
      if (data && data.ok && data.days) {
        maps = { ...maps, [mk]: data.days };
        cacheSet(cacheKey, data.days);
        return;
      }
    } catch (err) {
      /* fall through to local cache */
    }

    const local = { ...(cacheGet(cacheKey) || {}) };
    const count = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= count; d++) {
      const iso = isoOf(y, m, d);
      const cached = cacheGet(`movement:${ward.id}:${iso}`);
      if (cached && Array.isArray(cached.kits)) {
        local[iso] = {
          filled: cached.kits.filter((k) => (k.venue || "").trim()).length,
          total: cached.kits.length,
        };
      }
    }
    maps = { ...maps, [mk]: local };
  }

  function rememberDay(iso, filled, total) {
    const mk = iso.slice(0, 7);
    const next = { ...(maps[mk] || {}), [iso]: { filled, total } };
    maps = { ...maps, [mk]: next };
    if (ward) cacheSet(`movement:month:${ward.id}:${mk}`, next);
  }

  // ═══════════════════════════════════════════════════════════
  // OPEN A DAY → FORM
  // ═══════════════════════════════════════════════════════════
  async function openDay(iso) {
    tick(10);
    selectedDate = iso;
    dateRelation = classifyDate(iso);
    kits = [];
    formPhase = "loading";
    formError = "";
    if (scroller) scroller.scrollTop = 0;
    go("form");
    await loadKits();
  }

  function backToCalendar() {
    if (anyDirty && !confirm("Discard unsaved changes?")) return;
    go("calendar");
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD KITS — network first, cache fallback
  // ═══════════════════════════════════════════════════════════
  async function loadKits() {
    if (!ward || !selectedDate) return;
    fromCache = false;
    const day = selectedDate;
    const cacheKey = `movement:${ward.id}:${day}`;

    try {
      const data = await apiFetch(
        `/movement/kits/?ward_id=${encodeURIComponent(ward.id)}&date=${day}`,
      );
      if (day !== selectedDate) return; // stale response guard

      if (!data.ok) {
        const cached = cacheGet(cacheKey);
        if (cached) {
          applyKits(cached);
          fromCache = true;
          formPhase = "ready";
          return;
        }
        formPhase = "error";
        formError = data.error || "Could not load kits.";
        return;
      }

      cacheSet(cacheKey, data);
      applyKits(data);
      formPhase = "ready";
    } catch (err) {
      if (day !== selectedDate) return;
      const cached = cacheGet(cacheKey);
      if (cached) {
        applyKits(cached);
        fromCache = true;
        formPhase = "ready";
        drainQueue();
      } else {
        formPhase = "error";
        formError = err.message || "Failed to load.";
      }
    }
  }

  function applyKits(data) {
    constituency = { id: data.constituency_id, name: data.constituency_name };

    if (data.is_past) dateRelation = "past";
    else if (data.is_today) dateRelation = "today";
    else dateRelation = "future";

    const queued = JSON.parse(localStorage.getItem("iebc:queue:ops") || "[]");
    const queuedByKit = new Map();
    for (const op of queued) {
      if (op.kind !== "movement.save") continue;
      if (op.payload.schedule_date !== selectedDate) continue;
      if (op.payload.ward_id !== ward.id) continue;
      for (const e of op.payload.entries)
        queuedByKit.set(String(e.kit_id), e.venue);
    }

    kits = (data.kits || []).map((k) => {
      const pendingVenue = queuedByKit.get(String(k.kit_id));
      const venue = pendingVenue !== undefined ? pendingVenue : k.venue || "";
      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue,
        _original: (k.venue || "").trim(),
        has_schedule: !!k.has_schedule,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DERIVED (form)
  // ═══════════════════════════════════════════════════════════
  $: editable = dateRelation !== "past";
  $: anyDirty =
    editable && kits.some((k) => (k.venue || "").trim() !== k._original);
  $: filledCount = kits.filter((k) => (k.venue || "").trim()).length;
  $: progress = kits.length ? Math.round((filledCount / kits.length) * 100) : 0;
  $: canFillRest = editable && filledCount > 0 && filledCount < kits.length;
  $: showSave = editable && formPhase === "ready" && kits.length > 0;

  function fillRest() {
    const source = kits.find((k) => (k.venue || "").trim());
    if (!source) return;
    const v = source.venue.trim();
    kits = kits.map((k) => ((k.venue || "").trim() ? k : { ...k, venue: v }));
  }

  // ═══════════════════════════════════════════════════════════
  // SAVE
  // ═══════════════════════════════════════════════════════════
  async function saveAll() {
    if (!editable || saving) return;

    const entries = kits
      .filter((k) => (k.venue || "").trim() && k.venue.trim() !== k._original)
      .map((k) => ({ kit_id: k.kit_id, venue: k.venue.trim() }));

    if (entries.length === 0) {
      showToast("err", "Nothing to save.");
      return;
    }

    const payload = {
      ward_id: ward.id,
      fingerprint: $session.fingerprint,
      schedule_date: selectedDate,
      entries,
    };

    saving = true;
    const snapshotKits = kits;
    kits = kits.map((k) => ({ ...k, _original: (k.venue || "").trim() }));

    let outcome = null;

    try {
      const res = await apiFetch("/movement/save/", {
        method: "POST",
        json: payload,
      });

      if (!res.ok) {
        kits = snapshotKits;
        showToast("err", res.error || "Could not save.");
        return;
      }

      const saved = (res.created || 0) + (res.updated || 0);
      outcome = {
        kind: "ok",
        text: `${saved} venue${saved === 1 ? "" : "s"} saved`,
      };

      const cacheKey = `movement:${ward.id}:${selectedDate}`;
      const cached = cacheGet(cacheKey) || {};
      cacheSet(cacheKey, {
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
      enqueue("movement.save", payload);
      outcome = {
        kind: "queued",
        text: "Saved offline — will sync when online",
      };
    } finally {
      saving = false;
    }

    if (outcome) {
      const day = selectedDate;
      rememberDay(
        day,
        kits.filter((k) => (k.venue || "").trim()).length,
        kits.length,
      );
      showToast(outcome.kind, outcome.text);
      tick([12, 40, 12]);

      closeTimer = setTimeout(() => {
        // make sure the saved day is in view, then let it pop
        const mk = day.slice(0, 7);
        if (mk !== monthKey) {
          const [y, mm] = mk.split("-").map(Number);
          dir = mk > monthKey ? 1 : -1;
          cursor = { y, m: mm - 1 };
        }
        justSaved = day;
        go("calendar");
        if (popTimer) clearTimeout(popTimer);
        popTimer = setTimeout(() => (justSaved = ""), 2000);
      }, 650);
    }
  }

  onDestroy(() => {
    if (toastTimer) clearTimeout(toastTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (popTimer) clearTimeout(popTimer);
  });
</script>

<PageTransition>
  <div class="mp">
    {#if gate !== "ok"}
      <!-- ═══════════════════ SESSION GATES ═══════════════════ -->
      <div class="gate">
        <button class="icon-btn gate-back" on:click={() => dispatch("back")} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6 L9 12 L15 18" />
          </svg>
        </button>
        <div class="center">
          {#if gate === "loading"}
            <div class="spinner"></div>
            <p class="center-text">Loading…</p>
          {:else if gate === "unbound"}
            <div class="tile">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="10" width="16" height="11" rx="2" />
                <path d="M8 10 V7 A4 4 0 0 1 16 7 V10" />
              </svg>
            </div>
            <h2 class="center-title">Set up this device</h2>
            <p class="center-text">Choose your ward to continue. You only do this once.</p>
          {:else}
            <div class="tile danger">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8 V13" />
                <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
              </svg>
            </div>
            <h2 class="center-title">Something went wrong</h2>
            <p class="center-text">{errorMsg}</p>
          {/if}
        </div>
      </div>
    {:else}
      <div class="viewport">
        <div class="track" class:show-form={view === "form"}>

          <!-- ═══════════════════ CALENDAR PANEL ═══════════════════ -->
          <section class="panel" inert={view !== "calendar"} aria-hidden={view !== "calendar"}>

            <header class="hero">
              <div class="hero-top">
                <button class="glass-btn" on:click={() => dispatch("back")} aria-label="Back">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 6 L9 12 L15 18" />
                  </svg>
                </button>
                <div class="hero-meta">
                  <div class="hero-ward">{ward.name}</div>
                  {#if constituency && constituency.name}
                    <div class="hero-sub">{constituency.name} Constituency</div>
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
                       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6 L15 12 L9 18" />
                  </svg>
                </span>
              </button>
            </header>

            <!-- Calendar sheet fills the rest of the screen -->
            <div class="sheet" on:touchstart|passive={swipeStart} on:touchend|passive={swipeEnd}>
              <div class="sheet-head">
                <div>
                  <h1 class="cal-title">{monthName} <span>{cursor.y}</span></h1>
                  <div class="cal-sub">
                    {#if plannedDays === 0}
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
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M15 6 L9 12 L15 18" />
                    </svg>
                  </button>
                  <button class="icon-btn sm" on:click={() => shiftMonth(1)} aria-label="Next month">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M9 6 L15 12 L9 18" />
                    </svg>
                  </button>
                </div>
              </div>

              <div class="weekdays">
                {#each WEEKDAYS as w}<span>{w}</span>{/each}
              </div>

              <div class="mesh-wrap">
                {#key monthKey}
                  <div
                    class="mesh"
                    style="--rows: {rows}"
                    in:fly={{ x: dir * 32, duration: 260, easing: cubicOut }}
                  >
                    {#each cells as c}
                      {#if c === null}
                        <span class="blank"></span>
                      {:else}
                        <button
                          type="button"
                          class="day {c.status} {c.rel}"
                          class:weekend={c.weekend}
                          class:is-today={c.rel === "today"}
                          class:pop={c.iso === justSaved}
                          on:click={() => openDay(c.iso)}
                          aria-label={`${weekdayLong(c.iso)} ${dateFull(c.iso)}. ${
                            c.status === "empty" ? "No venues set" : `${c.filled} of ${c.total} venues set`
                          }`}
                        >
                          <span class="fill" style="height: {c.pct}%"></span>
                          <span class="day-num">{c.day}</span>
                          {#if c.status === "partial"}
                            <span class="day-count">{c.filled}/{c.total}</span>
                          {:else if c.status === "complete"}
                            <svg class="day-check" viewBox="0 0 24 24" width="14" height="14" fill="none"
                                 stroke="currentColor" stroke-width="3.2"
                                 stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12.5 L10 17.5 L19 7" />
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
          <section class="panel" inert={view !== "form"} aria-hidden={view !== "form"}>

            <header class="hero form-hero">
              <div class="hero-top">
                <button class="glass-btn" on:click={backToCalendar} aria-label="Back to calendar">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 6 L9 12 L15 18" />
                  </svg>
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
                    {dateRelation === "past" ? "Read-only" : dateRelation === "today" ? "Today" : "Upcoming"}
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
                      <circle cx="12" cy="12" r="9" /><path d="M12 8 V12 L15 14" />
                    </svg>
                    <span>Offline — showing saved data. Changes sync when you're back online.</span>
                  </div>
                {/if}

                {#if formPhase === "loading"}
                  <div class="center small">
                    <div class="spinner"></div>
                    <p class="center-text">Loading kits…</p>
                  </div>
                {:else if formPhase === "error"}
                  <div class="center small">
                    <div class="tile danger">
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9" /><path d="M12 8 V13" />
                        <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
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
                    {#if canFillRest}
                      <button class="pill" on:click={fillRest}>Fill the rest</button>
                    {/if}
                  </div>
                  <div class="progress"><span style="width: {progress}%"></span></div>

                  <div class="kits">
                    {#each kits as kit (kit.kit_id)}
                      <div class="kit" class:filled={kit.venue.trim()} class:readonly={!editable}>
                        <div class="kit-top">
                          <span class="kit-state" class:on={kit.venue.trim()}>
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
                                 stroke="currentColor" stroke-width="3.4"
                                 stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12.5 L10 17.5 L19 7" />
                            </svg>
                          </span>
                          <span class="kit-name">{kit.kit_name}</span>
                          <span class="kit-serial">{kit.serial_no}</span>
                        </div>

                        {#if editable}
                          <label class="field">
                            <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                                 stroke="currentColor" stroke-width="1.9"
                                 stroke-linecap="round" stroke-linejoin="round">
                              <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                              <circle cx="11.5" cy="9.5" r="2.5" />
                            </svg>
                            <input
                              type="text"
                              bind:value={kit.venue}
                              placeholder="Enter venue"
                              autocomplete="off"
                              spellcheck="false"
                            />
                          </label>
                        {:else}
                          <div class="field static">
                            <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                                 stroke="currentColor" stroke-width="1.9"
                                 stroke-linecap="round" stroke-linejoin="round">
                              <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                              <circle cx="11.5" cy="9.5" r="2.5" />
                            </svg>
                            <span class="static-value" class:none={!kit.venue}>
                              {kit.venue || "No venue recorded"}
                            </span>
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
                </div>
              {/if}
            </div>
          </section>
        </div>
      </div>

      {#if toast}
        <div class="toast" role="status">
          <i class="toast-dot {toast.kind}"></i>{toast.text}
        </div>
      {/if}
    {/if}
  </div>
</PageTransition>

<style>
  /* ═══════════════════════════════════════════════════════════
     TOKENS
     ═══════════════════════════════════════════════════════════ */
  .mp {
    --g-950: #06271d;
    --g-800: #075b42;
    --g-700: #087451;
    --g-600: #0b9a68;
    --g-500: #18b77d;
    --g-100: #d9f8e9;
    --g-50: #effcf6;

    --ink: #0b241c;
    --ink-2: #466158;
    --ink-3: #84978f;
    --line: #e4ece8;
    --paper: #f4f7f6;
    --card: #ffffff;

    --amber: #f0a92a;
    --amber-ink: #7d4e00;
    --amber-soft: #fff6df;

    --red: #d0473d;
    --red-soft: #ffebe9;

    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    /* App shell: exactly one screen tall, nothing scrolls except the kit list */
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--g-950);
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

  .viewport {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .track {
    display: flex;
    width: 200%;
    height: 100%;
    transition: transform 0.46s var(--ease);
  }
  .track.show-form { transform: translateX(-50%); }

  .panel {
    width: 50%;
    height: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  /* ═══════════════════════════════════════════════════════════
     BUTTONS
     ═══════════════════════════════════════════════════════════ */
  .icon-btn, .glass-btn {
    width: 38px; height: 38px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 13px;
    cursor: pointer; flex-shrink: 0;
    transition: transform 0.16s var(--ease), background 0.2s var(--ease);
  }
  .icon-btn {
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
  }
  .icon-btn.sm { width: 34px; height: 34px; border-radius: 12px; }
  .glass-btn {
    border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.1);
    color: #fff;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .icon-btn:active, .glass-btn:active, .pill:active { transform: scale(.92); }

  .pill {
    border: none;
    background: var(--g-100);
    color: var(--g-800);
    font: inherit; font-size: 12px; font-weight: 700;
    padding: 8px 13px; border-radius: 999px;
    cursor: pointer;
    transition: transform .16s var(--ease);
  }
  .pill.retry { margin-top: 16px; }

  .icon-btn:focus-visible, .glass-btn:focus-visible, .pill:focus-visible,
  .day:focus-visible, .next:focus-visible, .cta:focus-visible {
    outline: 2px solid var(--g-500);
    outline-offset: 2px;
  }

  /* ═══════════════════════════════════════════════════════════
     HERO — full-bleed, sits under the status bar
     ═══════════════════════════════════════════════════════════ */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 36px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(67,231,166,.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(0,150,104,.26), transparent 55%),
      linear-gradient(150deg, #06271d 0%, #075b42 58%, #087451 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; margin-bottom: 14px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-ward {
    font-size: clamp(21px, 6vw, 27px);
    font-weight: 750; letter-spacing: -0.05em; line-height: 1.05;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .hero-sub { margin-top: 4px; font-size: 12px; color: rgba(255,255,255,.68); }
  .hero-sub.solo { margin: 0; font-size: 13px; font-weight: 650; color: rgba(255,255,255,.8);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sync-wrap {
    padding: 3px 6px; border-radius: 999px;
    background: rgba(255,255,255,.94);
    flex-shrink: 0;
  }

  .next {
    width: 100%;
    display: flex; align-items: center; gap: 12px;
    padding: 12px 12px 12px 14px;
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 18px;
    background: rgba(255,255,255,.09);
    color: #fff; font: inherit; text-align: left;
    cursor: pointer;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    transition: transform .16s var(--ease), background .2s var(--ease);
  }
  .next:active { transform: scale(.985); background: rgba(255,255,255,.14); }
  .next-body { flex: 1; min-width: 0; }
  .next-label { font-size: 10.5px; font-weight: 650; letter-spacing: .02em; color: rgba(255,255,255,.62); margin-bottom: 2px; }
  .next-text { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 8px; }
  .next-bar { height: 4px; border-radius: 999px; background: rgba(255,255,255,.15); overflow: hidden; }
  .next-bar span {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, #72f1ba, #c2ffe0);
    transition: width .5s var(--ease);
  }
  .next-action {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 9px 10px 9px 14px; border-radius: 999px;
    background: #fff; color: var(--g-950);
    font-size: 12.5px; font-weight: 750; flex-shrink: 0;
  }

  /* ═══════════════════════════════════════════════════════════
     SHEET — white surface that fills the remaining screen
     ═══════════════════════════════════════════════════════════ */
  .sheet {
    position: relative;
    flex: 1; min-height: 0;
    margin-top: -24px;
    display: flex; flex-direction: column;
    background: #fff;
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0,0,0,.35);
    overflow: hidden;
  }

  .sheet-head {
    flex: none;
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
    padding: 16px 16px 12px;
  }
  .cal-title {
    margin: 0;
    font-size: clamp(21px, 5.6vw, 25px);
    font-weight: 760; letter-spacing: -0.055em; line-height: 1.05;
  }
  .cal-title span { color: var(--ink-3); font-weight: 450; }
  .cal-sub { margin-top: 3px; font-size: 11.5px; font-weight: 550; color: var(--ink-3); }
  .cal-nav { display: flex; align-items: center; gap: 6px; }

  .weekdays {
    flex: none;
    display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
    padding: 7px 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    text-align: center;
    font-size: 10.5px; font-weight: 750; letter-spacing: .06em;
    color: var(--ink-3);
  }

  /* ═══════════════════════════════════════════════════════════
     MESH — one continuous grid, hairlines between cells
     ═══════════════════════════════════════════════════════════ */
  .mesh-wrap { flex: 1; min-height: 0; overflow: hidden; background: var(--line); }

  .mesh {
    height: 100%;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
    gap: 1px;               /* the gap shows the line colour = the mesh */
    background: var(--line);
  }

  .blank { background: #f8faf9; }

  .day {
    position: relative;
    display: flex; flex-direction: column; align-items: stretch;
    justify-content: space-between;
    min-width: 0; min-height: 0;
    padding: 6px 6px 5px;
    border: none; border-radius: 0;
    background: #fff;
    color: var(--ink);
    font: inherit;
    overflow: hidden;
    cursor: pointer;
    transition: background .15s var(--ease);
  }
  .day:active { background: var(--g-50); }

  /* liquid fill rising from the bottom of the cell = progress */
  .fill {
    position: absolute; left: 0; right: 0; bottom: 0;
    height: 0;
    transform-origin: bottom;
    pointer-events: none;
  }

  .day-num, .day-count, .day-check { position: relative; z-index: 1; }

  .day-num {
    align-self: flex-start;
    min-width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0 4px;
    border-radius: 999px;
    font-size: 13px; font-weight: 600; letter-spacing: -0.02em; line-height: 1;
  }
  .day-count {
    align-self: flex-end;
    font-size: 9.5px; font-weight: 750; letter-spacing: 0;
    color: var(--amber-ink);
  }
  .day-check { align-self: flex-end; color: #fff; }

  /* empty */
  .day.weekend .day-num { color: var(--ink-3); }
  .day.past.empty .day-num { color: #b7c4bf; font-weight: 450; }

  /* partial — amber wash + amber liquid */
  .day.partial { background: var(--amber-soft); }
  .day.partial .fill { background: linear-gradient(to top, #f2ac2e, #ffd884); opacity: .85; }
  .day.partial .day-num { color: var(--amber-ink); font-weight: 750; }

  /* complete — full emerald */
  .day.complete { background: var(--g-600); }
  .day.complete .fill { background: linear-gradient(160deg, var(--g-700), var(--g-500)); }
  .day.complete .day-num { color: #fff; font-weight: 750; }
  .day.complete:active { background: var(--g-700); }

  .day.past.partial, .day.past.complete { filter: saturate(.8); }

  /* today */
  .day.is-today .day-num { background: var(--ink); color: #fff; font-weight: 750; }
  .day.is-today.complete .day-num { background: #fff; color: var(--g-700); }
  .day.is-today.partial .day-num { background: var(--amber-ink); color: #fff; }

  /* saved-day celebration: liquid rises again + cell pulses */
  .day.pop { z-index: 3; animation: cell-pop .8s var(--ease) .5s both; }
  .day.pop .fill { animation: fill-up .9s var(--ease) .5s both; }
  @keyframes fill-up {
    from { transform: scaleY(0); }
    to   { transform: scaleY(1); }
  }
  @keyframes cell-pop {
    0%   { transform: scale(1); box-shadow: 0 0 0 0 rgba(11,154,104,.5); }
    40%  { transform: scale(1.09); box-shadow: 0 0 0 6px rgba(11,154,104,.0), 0 10px 24px -6px rgba(11,154,104,.55); }
    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(11,154,104,0); }
  }

  .legend {
    flex: none;
    display: flex; justify-content: center; gap: 4px 16px;
    padding: 9px 12px calc(9px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    background: #fff;
    font-size: 10.5px; font-weight: 600; color: var(--ink-3);
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .key { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .k-empty { background: #fff; box-shadow: inset 0 0 0 1px #d5dfda; }
  .k-partial { background: linear-gradient(to top, #f2ac2e 55%, var(--amber-soft) 55%); }
  .k-complete { background: var(--g-600); }

  /* ═══════════════════════════════════════════════════════════
     FORM
     ═══════════════════════════════════════════════════════════ */
  .form-hero { padding-bottom: 38px; }
  .day-title {
    margin: 2px 2px 6px;
    font-size: clamp(30px, 9vw, 40px);
    font-weight: 780; letter-spacing: -0.065em; line-height: .98;
  }
  .day-line {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
    margin-left: 2px;
    font-size: 13px; font-weight: 550; color: rgba(255,255,255,.75);
  }
  .chip {
    padding: 4px 10px; border-radius: 999px;
    font-size: 10.5px; font-weight: 750;
    background: rgba(255,255,255,.14); color: #fff;
  }
  .chip.today { background: #7bf0bd; color: var(--g-950); }
  .chip.past { background: rgba(255,255,255,.1); color: rgba(255,255,255,.7); }

  .form-sheet { background: var(--paper); }
  .fscroll {
    flex: 1; min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 18px 14px 20px;
    scroll-padding-bottom: 120px;
  }

  .notice {
    display: flex; align-items: center; gap: 9px;
    padding: 10px 12px; margin-bottom: 14px;
    border-radius: 14px;
    background: var(--amber-soft); color: var(--amber-ink);
    font-size: 12px; font-weight: 550; line-height: 1.4;
  }
  .notice svg { flex-shrink: 0; }

  .form-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 0 2px 9px; }
  .form-head-label { font-size: 16px; font-weight: 750; letter-spacing: -0.03em; }
  .form-head-count { margin-top: 2px; font-size: 12px; font-weight: 550; color: var(--ink-3); }
  .progress { height: 5px; border-radius: 999px; background: #e1e9e5; overflow: hidden; margin: 0 2px 14px; }
  .progress span {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, var(--g-700), var(--g-500));
    transition: width .4s var(--ease);
  }

  .kits { display: flex; flex-direction: column; gap: 9px; }
  .kit {
    padding: 12px;
    border-radius: 18px;
    background: #fff;
    box-shadow: 0 1px 0 var(--line), 0 10px 24px -20px rgba(7,43,31,.4);
    transition: box-shadow .2s var(--ease);
  }
  .kit.filled { box-shadow: 0 0 0 1.5px var(--g-100), 0 10px 24px -20px rgba(7,43,31,.4); }
  .kit.readonly { opacity: .9; }

  .kit-top { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
  .kit-state {
    width: 21px; height: 21px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--paper); color: transparent;
    box-shadow: inset 0 0 0 1.5px #d9e3de;
    flex-shrink: 0;
    transition: background .2s var(--ease), color .2s var(--ease), box-shadow .2s var(--ease);
  }
  .kit-state.on { background: var(--g-600); color: #fff; box-shadow: none; }
  .kit-name {
    flex: 1; min-width: 0;
    font-size: 14px; font-weight: 700; letter-spacing: -0.02em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .kit-serial {
    max-width: 42%;
    padding: 4px 8px; border-radius: 8px;
    background: var(--paper); color: var(--ink-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
  }

  .field {
    display: flex; align-items: center; gap: 9px;
    min-width: 0; box-sizing: border-box;
    padding: 12px;
    border: 1.5px solid transparent;
    border-radius: 13px;
    background: var(--paper);
    transition: border-color .2s var(--ease), background .2s var(--ease), box-shadow .2s var(--ease);
  }
  .field:focus-within {
    border-color: var(--g-600);
    background: #fff;
    box-shadow: 0 0 0 4px rgba(11,154,104,.12);
  }
  .field-icon { color: #8ea098; flex-shrink: 0; transition: color .2s var(--ease); }
  .field:focus-within .field-icon { color: var(--g-600); }
  .field input {
    flex: 1; min-width: 0; width: 100%;
    padding: 0; border: none; outline: none; background: transparent;
    color: var(--ink); font: inherit; font-size: 16px;
    -webkit-user-select: text; user-select: text;
  }
  .field input::placeholder { color: #9aa9a3; }
  .static-value { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 550; color: var(--ink-2);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .static-value.none { color: var(--ink-3); font-style: italic; font-weight: 450; }

  /* save bar is pinned to the bottom of the sheet, list scrolls behind it */
  .savebar {
    flex: none;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    background: rgba(255,255,255,.96);
    border-top: 1px solid var(--line);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .cta {
    width: 100%; padding: 15px 16px;
    border: 0; border-radius: 15px;
    background: linear-gradient(135deg, var(--g-700), var(--g-600));
    color: #fff;
    font: inherit; font-size: 15px; font-weight: 750; letter-spacing: -0.012em;
    cursor: pointer;
    box-shadow: 0 12px 24px -12px rgba(7,116,81,.7), inset 0 1px 0 rgba(255,255,255,.14);
    transition: transform .16s var(--ease);
  }
  .cta:active:not(:disabled) { transform: scale(.985); }
  .cta:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }
  .hint { margin-top: 8px; text-align: center; font-size: 11.5px; font-weight: 550; color: var(--ink-3); }
  .hint.ready { color: var(--g-800); font-weight: 700; }

  /* ═══════════════════════════════════════════════════════════
     TOAST
     ═══════════════════════════════════════════════════════════ */
  .toast {
    position: fixed; left: 50%; z-index: 50;
    top: calc(14px + env(safe-area-inset-top));
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 9px;
    max-width: min(calc(100% - 28px), 420px);
    padding: 12px 18px; border-radius: 999px;
    background: rgba(10,35,27,.95); color: #fff;
    font-size: 12.5px; font-weight: 650;
    box-shadow: 0 18px 40px rgba(6,29,21,.3);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    animation: toast-in .32s var(--ease) both;
  }
  .toast-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .toast-dot.ok { background: #6ee7b0; box-shadow: 0 0 9px rgba(110,231,176,.6); }
  .toast-dot.queued { background: #f5c15c; }
  .toast-dot.err { background: #ff8b82; }
  @keyframes toast-in {
    from { opacity: 0; transform: translate(-50%, -12px) scale(.96); }
    to   { opacity: 1; transform: translate(-50%, 0) scale(1); }
  }

  /* ═══════════════════════════════════════════════════════════
     GATES / EMPTY / LOADING
     ═══════════════════════════════════════════════════════════ */
  .gate {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column;
    padding: calc(12px + env(safe-area-inset-top)) 14px 14px;
    background: var(--paper);
  }
  .gate-back { align-self: flex-start; }
  .center {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px 28px 60px; text-align: center;
  }
  .center.small { flex: none; min-height: 28vh; padding-bottom: 30px; }
  .center-title { margin: 16px 0 5px; font-size: 18px; font-weight: 750; letter-spacing: -0.03em; }
  .center-text { max-width: 290px; margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-3); }
  .tile {
    width: 58px; height: 58px; border-radius: 19px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(145deg, var(--g-100), #c9f4df); color: var(--g-800);
  }
  .tile.danger { background: var(--red-soft); color: var(--red); }
  .spinner {
    width: 26px; height: 26px; margin-bottom: 11px;
    border: 2.5px solid #dfe9e4; border-top-color: var(--g-600);
    border-radius: 50%; animation: spin .75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty {
    padding: 36px 20px; border: 1px dashed #d5dfda; border-radius: 18px;
    background: rgba(255,255,255,.7); color: var(--ink-3); font-size: 13px; text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .track, .day, .cta, .next, .progress span, .next-bar span, .toast, .kit-state { transition: none; animation: none; }
    .day.pop, .day.pop .fill { animation: none; }
  }
</style>