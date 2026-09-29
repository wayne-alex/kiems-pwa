<script>
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { session } from "../lib/session.js";
  import { apiFetch } from "../lib/api.js";
  import { cacheGet, cacheSet, enqueue, drainQueue } from "../lib/offline.js";
  import SyncBadge from "../components/SyncBadge.svelte";
  import PageTransition from "../components/PageTransition.svelte";

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════
  let phase = "idle"; // idle | loading | unbound | error | ready
  let errorMsg = "";
  let fromCache = false;
  let initialLoadDone = false;

  let ward = null;
  let constituency = null;

  let selectedDate = "";
  let dateRelation = "today";

  let kits = [];
  let submitting = false;
  let formError = null;
  let successModal = null;

  // ── Network + queue awareness ─────────────────────────────
  let isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
  let pendingCount = 0;
  let onlineDebounceTimer = null;
  let pendingTick = null;

  function updatePendingCount() {
    try {
      const ops = JSON.parse(localStorage.getItem("iebc:queue:ops") || "[]");
      pendingCount = ops.length;
    } catch {
      pendingCount = 0;
    }
  }

  function setOnline(value) {
    if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer);
    if (value) {
      isOnline = true;
      updatePendingCount();
    } else {
      onlineDebounceTimer = setTimeout(() => {
        isOnline = false;
        updatePendingCount();
      }, 1500);
    }
  }

  onMount(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    isOnline = navigator.onLine;
    updatePendingCount();
    pendingTick = setInterval(updatePendingCount, 3000);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      if (pendingTick) clearInterval(pendingTick);
      if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer);
    };
  });

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const localIso = (d) => isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  const todayIso = () => localIso(new Date());

  const tick = (ms = 10) => {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {}
  };

  function classifyDate(d) {
    const t = todayIso();
    if (d === t) return "today";
    return d < t ? "past" : "future";
  }

  function formatDateLabel(iso) {
    if (!iso) return "Today";
    if (iso === todayIso()) return "Today";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-KE", { day: "numeric", month: "short" });
  }

  function formatDateFull(iso) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString("en-KE", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }

  function openDatePicker() {
    const input = document.getElementById("entry-date-input");
    if (!input) return;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
      } catch (err) {
        input.focus();
        input.click();
      }
    } else {
      input.focus();
      input.click();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SESSION REACTIVITY
  // ═══════════════════════════════════════════════════════════
  $: if ($session.status === "unbound") phase = "unbound";

  $: if ($session.status === "bound" && $session.ward && !ward) {
    ward = $session.ward;
    selectedDate = todayIso();
    phase = "loading";
    loadKits();
  }

  $: if ($session.status === "error") {
    phase = "error";
    errorMsg = $session.error || "Session error.";
  }

  // ═══════════════════════════════════════════════════════════
  // LOAD
  // ═══════════════════════════════════════════════════════════
  async function loadKits() {
    if (!ward) return;
    if (phase !== "loading") phase = phase === "ready" ? "ready" : "loading";
    formError = null;

    const cacheKey = `entry:${ward.id}:${selectedDate}`;
    const cached = cacheGet(cacheKey);

    if (cached && !initialLoadDone) {
      applyKits(cached);
      fromCache = true;
      phase = "ready";
    }

    try {
      const data = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${selectedDate}`,
      );

      if (data.error) {
        if (cached) {
          applyKits(cached);
          fromCache = true;
          phase = "ready";
          initialLoadDone = true;
          return;
        }
        phase = "error";
        errorMsg = data.error;
        initialLoadDone = true;
        return;
      }

      cacheSet(cacheKey, data);
      applyKits(data);
      fromCache = false;
      phase = "ready";
      initialLoadDone = true;
    } catch (err) {
      if (cached) {
        applyKits(cached);
        fromCache = true;
        phase = "ready";
        drainQueue();
        initialLoadDone = true;
      } else {
        phase = "error";
        errorMsg = err.message || "Could not load kits.";
        initialLoadDone = true;
      }
    }
  }

  function applyKits(data) {
    dateRelation = classifyDate(selectedDate);

    const queued = JSON.parse(localStorage.getItem("iebc:queue:ops") || "[]");
    const queuedByKit = new Map();
    for (const op of queued) {
      if (op.kind !== "entry.submit" || op.payload.date !== selectedDate)
        continue;
      for (const e of op.payload.entries) {
        queuedByKit.set(String(e.kit_id), e);
      }
    }

    kits = (data.kits || []).map((k) => {
      const pending = queuedByKit.get(String(k.kit_id));
      const male = pending ? pending.male : k.registered_male || 0;
      const female = pending ? pending.female : k.registered_female || 0;
      const venue = pending ? pending.venue : k.venue || "";
      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue,
        male,
        female,
        _orig_male: k.registered_male || 0,
        _orig_female: k.registered_female || 0,
        _orig_venue: (k.venue || "").trim(),
        has_registration: !!k.has_registration,
        is_venue_mapping: !!k.is_venue_mapping,
      };
    });
  }

  async function changeDate(newDate) {
    if (!newDate || newDate === selectedDate) return;
    selectedDate = newDate;
    initialLoadDone = false;
    phase = "loading";
    await loadKits();
  }

  // ═══════════════════════════════════════════════════════════
  // DERIVED
  // ═══════════════════════════════════════════════════════════
  const isDirty = (k) =>
    (parseInt(k.male) || 0) !== k._orig_male ||
    (parseInt(k.female) || 0) !== k._orig_female ||
    (k.venue || "").trim() !== k._orig_venue;

  $: totalMale = kits.reduce((s, k) => s + (parseInt(k.male) || 0), 0);
  $: totalFemale = kits.reduce((s, k) => s + (parseInt(k.female) || 0), 0);
  $: totalAll = totalMale + totalFemale;
  $: registeredCount = kits.filter((k) => k.has_registration).length;
  $: pendingTotal = kits.length - registeredCount;
  $: entryProgress = kits.length
    ? Math.round((registeredCount / kits.length) * 100)
    : 0;

  $: dirtyKits = kits.filter(isDirty);

  $: canSubmit =
    dateRelation === "today" && dirtyKits.length > 0 && !submitting;
  $: showSubmit =
    phase === "ready" && dateRelation === "today" && kits.length > 0;

  // ═══════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════
  function validateKit(kit) {
    const venue = (kit.venue || "").trim();
    const m = parseInt(kit.male) || 0;
    const f = parseInt(kit.female) || 0;
    if (!venue) return "Venue is required.";
    if (m === 0 && f === 0) return "Enter at least one voter.";
    if (m < 0 || f < 0) return "Counts cannot be negative.";
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // SAVE — single kit
  // ═══════════════════════════════════════════════════════════
  async function saveOne(kit) {
    const err = validateKit(kit);
    if (err) {
      formError = err;
      return;
    }

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
      body.append("fingerprint", payload.fingerprint);
      body.append("date", payload.date);
      body.append("kit_id[]", entry.kit_id);
      body.append("venue[]", entry.venue);
      body.append("registered_male[]", String(entry.male));
      body.append("registered_female[]", String(entry.female));

      const res = await apiFetch("/kiems/submit-entries/", {
        method: "POST",
        body,
      });

      if (!res.ok) {
        formError = res.error || "Could not save.";
        return;
      }

      kit._orig_male = entry.male;
      kit._orig_female = entry.female;
      kit._orig_venue = entry.venue;
      kit.has_registration = entry.male + entry.female > 0;

      kits = [...kits];
      tick([12, 40, 12]);
      successModal = { count: 1, queued: false };
    } catch (e) {
      enqueue("entry.submit", payload);
      updatePendingCount();
      kit._orig_male = entry.male;
      kit._orig_female = entry.female;
      kit._orig_venue = entry.venue;
      kit.has_registration = entry.male + entry.female > 0;
      kits = [...kits];
      tick([12, 40, 12]);
      successModal = { count: 1, queued: true };
    } finally {
      submitting = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SUBMIT — bulk
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
    if (toSubmit.length === 0) {
      formError = "No changes to submit.";
      return;
    }

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

    const settle = () =>
      (kits = kits.map((k) => {
        const m = parseInt(k.male) || 0;
        const f = parseInt(k.female) || 0;
        return {
          ...k,
          _orig_male: m,
          _orig_female: f,
          _orig_venue: (k.venue || "").trim(),
          has_registration: m + f > 0,
        };
      }));

    try {
      const body = new URLSearchParams();
      body.append("fingerprint", payload.fingerprint);
      body.append("date", payload.date);
      payload.entries.forEach((e) => {
        body.append("kit_id[]", e.kit_id);
        body.append("venue[]", e.venue);
        body.append("registered_male[]", String(e.male));
        body.append("registered_female[]", String(e.female));
      });

      const res = await apiFetch("/kiems/submit-entries/", {
        method: "POST",
        body,
      });

      if (!res.ok) {
        formError = res.error || "Could not submit.";
        return;
      }

      settle();
      tick([12, 40, 12]);
      successModal = { count: res.saved || toSubmit.length, queued: false };
    } catch (e) {
      enqueue("entry.submit", payload);
      updatePendingCount();
      settle();
      tick([12, 40, 12]);
      successModal = { count: toSubmit.length, queued: true };
    } finally {
      submitting = false;
    }
  }

  onDestroy(() => {
    if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer);
    if (pendingTick) clearInterval(pendingTick);
  });
</script>

<PageTransition>
  <div class="ep">

    <!-- ═══════════════════ UNBOUND / ERROR ═══════════════════ -->
    {#if phase === "unbound" || phase === "error"}
      <div class="gate">
        <button class="icon-btn gate-back" on:click={() => dispatch("back")} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6 L9 12 L15 18" />
          </svg>
        </button>
        <div class="center">
          {#if phase === "unbound"}
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

    <!-- ═══════════════════ READY ═══════════════════ -->
    {:else if phase === "ready"}
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
            <div class="hero-sub">
              {constituency && constituency.name
                ? `${constituency.name} Constituency`
                : "KIEMS Registration"}
            </div>
          </div>

          <div class="sync-wrap"><SyncBadge /></div>
        </div>

        <div class="hero-row">
          <button
            type="button"
            class="date-chip"
            class:past={dateRelation === "past"}
            class:future={dateRelation === "future"}
            on:click={openDatePicker}
            aria-label="Select date"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
            </svg>
            <span>{formatDateLabel(selectedDate)}</span>
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
                 stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="chev">
              <path d="M6 9 L12 15 L18 9" />
            </svg>
          </button>

          {#if dateRelation === "past"}
            <span class="mode">Read-only</span>
          {:else if dateRelation === "future"}
            <span class="mode">Venue planning</span>
          {/if}
        </div>

        <input
          id="entry-date-input"
          class="date-input-hidden"
          type="date"
          bind:value={selectedDate}
          on:change={() => changeDate(selectedDate)}
          tabindex="-1"
          aria-hidden="true"
        />

        {#if dateRelation !== "future" && kits.length > 0}
          <div class="hero-stats">
            <div class="hero-stat">
              <div class="hero-stat-num">{totalAll}</div>
              <div class="hero-stat-label">total</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num male">{totalMale}</div>
              <div class="hero-stat-label">male</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num female">{totalFemale}</div>
              <div class="hero-stat-label">female</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num">{registeredCount}<span class="hero-stat-sep">/{kits.length}</span></div>
              <div class="hero-stat-label">kits</div>
            </div>
          </div>

          <div class="hero-progress"><span style="width: {entryProgress}%"></span></div>
        {/if}
      </header>

      <div class="sheet">
        <div class="scroll" class:nosave={!showSubmit}>

          <!-- sync banners -->
          {#if !isOnline}
            <div class="notice offline">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 3 L21 21" />
                <path d="M8.5 16.5 A5 5 0 0 1 15 12" />
                <path d="M5 12 A10 10 0 0 1 9 7" />
                <path d="M17 12 A10 10 0 0 0 15.5 9" />
                <circle cx="12" cy="19.5" r="0.6" fill="currentColor" />
              </svg>
              <span>You're offline. Changes save locally and sync when you reconnect.</span>
            </div>
          {:else if pendingCount > 0}
            <div class="notice pending">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3 V12 L16 15" />
                <path d="M21 12 A9 9 0 1 1 12 3" />
              </svg>
              <span>Syncing {pendingCount} pending {pendingCount === 1 ? "change" : "changes"}…</span>
            </div>
          {/if}

          {#if dateRelation === "past"}
            <div class="notice past">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8 V12 L15 14" />
              </svg>
              <span>Past date — read-only record for {formatDateFull(selectedDate)}.</span>
            </div>
          {:else if dateRelation === "future"}
            <div class="notice future">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
              </svg>
              <span>Future date — venue planning only. Counts are entered on election day.</span>
            </div>
          {/if}

          <!-- ── TODAY: editable, grouped ── -->
          {#if kits.length === 0}
            <div class="empty">No kits assigned to this ward.</div>

          {:else if dateRelation === "today"}
            {#each ["pending", "entered"] as group (group)}
              {#if (group === "pending" ? pendingTotal : registeredCount) > 0}
                <div class="section-head" class:spaced={group === "entered" && pendingTotal > 0}>
                  <span class="section-title {group}">
                    <span class={group === "pending" ? "dot-warn" : "dot-ok"}></span>
                    {group === "pending" ? "Pending" : "Registered"}
                  </span>
                  <span class="section-count">{group === "pending" ? pendingTotal : registeredCount}</span>
                </div>

                {#each kits as kit (kit.kit_id)}
                  {#if kit.has_registration === (group === "entered")}
                    {@const err = validateKit(kit)}
                    <div class="kit-card" class:entered={group === "entered"} class:dirty={isDirty(kit)}>
                      <div class="kit-head">
                        <div class="kit-left">
                          <span class="kit-name">{kit.kit_name}</span>
                          <span class="kit-serial">{kit.serial_no}</span>
                        </div>
                        {#if group === "pending"}
                          <span class="kit-state pending"><span class="dot-pending"></span>Pending</span>
                        {:else}
                          <span class="kit-state entered">
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
                                 stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12.5 L10 17.5 L19 7" />
                            </svg>
                            Entered
                          </span>
                        {/if}
                      </div>

                      <label class="field">
                        <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                             stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                          <circle cx="11.5" cy="9.5" r="2.5" />
                        </svg>
                        <input type="text" bind:value={kit.venue} placeholder="Enter venue"
                               autocomplete="off" spellcheck="false" />
                      </label>

                      <div class="count-grid">
                        <label class="count-input male">
                          <span class="count-label">Male</span>
                          <input type="number" min="0" inputmode="numeric" bind:value={kit.male} placeholder="0" />
                        </label>
                        <label class="count-input female">
                          <span class="count-label">Female</span>
                          <input type="number" min="0" inputmode="numeric" bind:value={kit.female} placeholder="0" />
                        </label>
                      </div>

                      <div class="kit-foot">
                        <span class="kit-total">
                          Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b>
                        </span>
                        <button class="save-btn" on:click={() => saveOne(kit)} disabled={submitting || !!err}>
                          {#if group === "pending"}{#if submitting}Saving…{:else}Save{/if}{:else}Update{/if}
                        </button>
                      </div>
                    </div>
                  {/if}
                {/each}
              {/if}
            {/each}

          <!-- ── PAST: read-only ── -->
          {:else if dateRelation === "past"}
            {#each kits as kit (kit.kit_id)}
              <div class="kit-card readonly">
                <div class="kit-head">
                  <div class="kit-left">
                    <span class="kit-name">{kit.kit_name}</span>
                    <span class="kit-serial">{kit.serial_no}</span>
                  </div>
                  <span class="kit-state" class:entered={kit.has_registration} class:pending={!kit.has_registration}>
                    {#if kit.has_registration}
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
                           stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12.5 L10 17.5 L19 7" />
                      </svg>
                      Entered
                    {:else}
                      <span class="dot-pending"></span>No data
                    {/if}
                  </span>
                </div>

                {#if kit.venue}
                  <div class="readonly-row">
                    <span class="readonly-label">Venue</span>
                    <span class="readonly-value">{kit.venue}</span>
                  </div>
                {/if}

                <div class="count-grid">
                  <div class="count-input male static">
                    <span class="count-label">Male</span>
                    <span class="count-value">{kit.male}</span>
                  </div>
                  <div class="count-input female static">
                    <span class="count-label">Female</span>
                    <span class="count-value">{kit.female}</span>
                  </div>
                </div>

                <div class="kit-foot">
                  <span class="kit-total">Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b></span>
                </div>
              </div>
            {/each}

          <!-- ── FUTURE: mapped venues ── -->
          {:else if dateRelation === "future"}
            {#if kits.some((k) => k.venue)}
              {#each kits.filter((k) => k.venue) as kit (kit.kit_id)}
                <div class="kit-card readonly">
                  <div class="kit-head">
                    <div class="kit-left">
                      <span class="kit-name">{kit.kit_name}</span>
                      <span class="kit-serial">{kit.serial_no}</span>
                    </div>
                    <span class="kit-state mapped">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
                           stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                        <circle cx="11.5" cy="9.5" r="2" />
                      </svg>
                      Mapped
                    </span>
                  </div>
                  <div class="readonly-row">
                    <span class="readonly-label">Venue</span>
                    <span class="readonly-value">{kit.venue}</span>
                  </div>
                  <div class="future-note">Voter counts will be entered on election day.</div>
                </div>
              {/each}
            {:else}
              <div class="empty">No venues pre-mapped for this date.</div>
            {/if}
          {/if}
        </div>

        {#if showSubmit}
          <div class="savebar">
            {#if formError}
              <div class="toast err" role="alert">{formError}</div>
            {/if}
            <button class="cta" on:click={submitAll} disabled={!canSubmit}>
              {#if submitting}Submitting…{:else}Submit entries{/if}
            </button>
            <div class="hint" class:ready={dirtyKits.length > 0}>
              {#if dirtyKits.length > 0}
                {dirtyKits.length} kit{dirtyKits.length === 1 ? "" : "s"} ready to submit
              {:else}
                Enter counts to enable submit
              {/if}
            </div>
          </div>
        {/if}
      </div>

    <!-- ═══════════════════ SKELETON ═══════════════════ -->
    {:else}
      <header class="hero hero-skeleton">
        <div class="hero-top">
          <div class="sk sk-btn"></div>
          <div class="hero-meta">
            <div class="sk sk-h1"></div>
            <div class="sk sk-sub"></div>
          </div>
          <div class="sk sk-pill"></div>
        </div>
        <div class="hero-row"><div class="sk sk-chip"></div></div>
        <div class="hero-stats">
          {#each Array(4) as _}
            <div class="hero-stat"><div class="sk sk-stat"></div><div class="sk sk-label"></div></div>
          {/each}
        </div>
        <div class="hero-progress"><span style="width: 0%"></span></div>
      </header>

      <div class="sheet">
        <div class="scroll nosave">
          <div class="section-head">
            <div class="sk sk-sec"></div>
            <div class="sk sk-badge"></div>
          </div>
          {#each Array(3) as _}
            <div class="kit-card skeleton-card">
              <div class="kit-head">
                <div class="kit-left">
                  <div class="sk sk-kitname"></div>
                  <div class="sk sk-kitserial"></div>
                </div>
                <div class="sk sk-status"></div>
              </div>
              <div class="field sk-field"><div class="sk sk-dot"></div><div class="sk sk-venue"></div></div>
              <div class="count-grid">
                <div class="count-input male sk-count"><div class="sk sk-count-lbl"></div><div class="sk sk-count-val"></div></div>
                <div class="count-input female sk-count"><div class="sk sk-count-lbl"></div><div class="sk sk-count-val"></div></div>
              </div>
              <div class="kit-foot"><div class="sk sk-total"></div><div class="sk sk-btn-wide"></div></div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ═══════════════════ SUCCESS MODAL ═══════════════════ -->
    {#if successModal}
      <div class="modal-overlay" on:click={() => (successModal = null)} on:keydown role="presentation">
        <div class="modal-sheet" on:click|stopPropagation on:keydown role="dialog" aria-modal="true">
          <div class="grabber"></div>

          <div class="check-wrap" class:queued={successModal.queued}>
            <svg viewBox="0 0 64 64" class="check-svg">
              {#if successModal.queued}
                <path class="check-circle" d="M20 30 A14 14 0 0 1 44 26 A10 10 0 0 1 46 46 H20 A8 8 0 0 1 20 30 Z"></path>
                <path class="check-mark" d="M26 38 L31 43 L40 33"></path>
              {:else}
                <circle class="check-circle" cx="32" cy="32" r="28"></circle>
                <path class="check-mark" d="M20 33 L28 41 L44 23"></path>
              {/if}
            </svg>
          </div>

          <h3 class="modal-title">{successModal.queued ? "Saved offline" : "Entries submitted"}</h3>
          <p class="modal-subtitle">
            {successModal.count} {successModal.count === 1 ? "entry" : "entries"}
            {successModal.queued ? "will sync when you reconnect" : "recorded"}
            for {formatDateLabel(selectedDate)}.
          </p>

          <div class="modal-actions">
            <button class="modal-btn primary" on:click={() => (successModal = null)}>Done</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</PageTransition>

<style>
  /* ═══════════════════════════════════════════════════════════
     TOKENS — shared with Home + Movement plan
     ═══════════════════════════════════════════════════════════ */
  .ep {
    --g-950: #06271d;
    --g-800: #075b42;
    --g-700: #087451;
    --g-600: #0b9a68;
    --g-500: #18b77d;
    --g-100: #dcf3e7;
    --g-50: #effcf6;

    --ink: #0e2a21;
    --ink-2: #466158;
    --ink-3: #84978f;
    --line: #e3ebe7;
    --paper: #f4f7f6;

    --male: #1e5fa8;
    --male-tint: #e2edfa;
    --female: #b23a32;
    --female-tint: #fbeae8;

    --amber-soft: #fff1cf;
    --amber-ink: #8f5a00;
    --amber: #e6a11a;

    --red: #d0473d;
    --red-soft: #ffebe9;

    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    /* App shell: one screen; only the kit list scrolls */
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

  /* ═══════════════════════════════════════════════════════════
     BUTTONS
     ═══════════════════════════════════════════════════════════ */
  .icon-btn, .glass-btn {
    width: 38px; height: 38px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 13px; cursor: pointer; flex-shrink: 0;
    transition: transform 0.16s var(--ease), background 0.2s var(--ease);
  }
  .icon-btn { border: 1px solid var(--line); background: #fff; color: var(--ink); }
  .glass-btn {
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
  .icon-btn:active, .glass-btn:active { transform: scale(0.92); }

  .icon-btn:focus-visible, .glass-btn:focus-visible, .save-btn:focus-visible,
  .cta:focus-visible, .date-chip:focus-visible, .modal-btn:focus-visible {
    outline: 2px solid var(--g-500); outline-offset: 2px;
  }

  /* ═══════════════════════════════════════════════════════════
     HERO — full-bleed under the status bar
     ═══════════════════════════════════════════════════════════ */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 38px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(67, 231, 166, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(0, 150, 104, 0.26), transparent 55%),
      linear-gradient(150deg, #06271d 0%, #075b42 58%, #087451 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-ward {
    font-size: clamp(21px, 6vw, 27px);
    font-weight: 750; letter-spacing: -0.05em; line-height: 1.05;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .hero-sub { margin-top: 4px; font-size: 12px; color: rgba(255, 255, 255, 0.68); }
  .sync-wrap {
    padding: 3px 6px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.94); flex-shrink: 0;
  }

  .hero-row { display: flex; align-items: center; gap: 10px; }
  .date-chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 8px 12px 8px 11px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.13);
    color: #fff; font: inherit; font-size: 12.5px; font-weight: 700;
    cursor: pointer;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    transition: transform 0.16s var(--ease), background 0.2s var(--ease);
  }
  .date-chip:active { transform: scale(0.96); background: rgba(255, 255, 255, 0.2); }
  .date-chip .chev { color: rgba(255, 255, 255, 0.7); }
  .mode {
    padding: 5px 10px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    font-size: 11px; font-weight: 700; color: rgba(255, 255, 255, 0.85);
  }

  .date-input-hidden {
    position: absolute; width: 1px; height: 1px; opacity: 0;
    pointer-events: none; border: none; padding: 0; margin: 0; left: -9999px;
  }

  .hero-stats {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
    margin-top: 14px; padding: 11px 12px;
    border-radius: 17px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.14);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .hero-stat { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
  .hero-stat-num { font-size: 20px; font-weight: 750; letter-spacing: -0.045em; line-height: 1; }
  .hero-stat-num.male { color: #a9d1ff; }
  .hero-stat-num.female { color: #ffc0b8; }
  .hero-stat-sep { font-size: 14px; font-weight: 550; color: rgba(255, 255, 255, 0.55); margin-left: 1px; }
  .hero-stat-label {
    font-size: 9.5px; font-weight: 650; text-transform: uppercase;
    letter-spacing: 0.08em; color: rgba(255, 255, 255, 0.62);
  }
  .hero-progress { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.14); overflow: hidden; margin-top: 11px; }
  .hero-progress span {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, #72f1ba, #c2ffe0);
    transition: width 0.5s var(--ease);
  }

  /* ═══════════════════════════════════════════════════════════
     SHEET
     ═══════════════════════════════════════════════════════════ */
  .sheet {
    position: relative;
    flex: 1; min-height: 0;
    margin-top: -24px;
    display: flex; flex-direction: column;
    background: var(--paper);
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .scroll {
    flex: 1; min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 18px 14px 20px;
    scroll-padding-bottom: 140px;
  }
  .scroll.nosave { padding-bottom: calc(20px + env(safe-area-inset-bottom)); }

  /* ── notices ─────────────────────────────────────────────── */
  .notice {
    display: flex; align-items: center; gap: 9px;
    padding: 11px 13px; margin-bottom: 12px;
    border-radius: 14px;
    font-size: 12px; font-weight: 550; line-height: 1.4;
  }
  .notice svg { flex-shrink: 0; }
  .notice.past { background: #e8eeeb; color: var(--ink-2); }
  .notice.future { background: var(--male-tint); color: var(--male); }
  .notice.offline { background: var(--red-soft); color: var(--red); }
  .notice.pending { background: var(--amber-soft); color: var(--amber-ink); }

  /* ── section headers ─────────────────────────────────────── */
  .section-head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; margin: 2px 0 10px; }
  .section-head.spaced { margin-top: 22px; }
  .section-title { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 750; letter-spacing: -0.025em; }
  .section-title.pending { color: var(--amber-ink); }
  .section-title.entered { color: var(--g-800); }
  .section-count {
    padding: 3px 10px; border-radius: 999px;
    background: #fff; border: 1px solid var(--line);
    font-size: 11.5px; font-weight: 700; color: var(--ink-2);
  }
  .dot-warn, .dot-ok, .dot-pending { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-warn { background: var(--amber); box-shadow: 0 0 0 3px rgba(230, 161, 26, 0.18); }
  .dot-ok { background: var(--g-600); box-shadow: 0 0 0 3px rgba(11, 154, 104, 0.16); }
  .dot-pending { background: var(--amber); }

  /* ── kit cards ───────────────────────────────────────────── */
  .kit-card {
    padding: 13px;
    margin-bottom: 10px;
    border-radius: 20px;
    background: #fff;
    box-shadow: 0 1px 0 var(--line), 0 12px 26px -22px rgba(7, 43, 31, 0.4);
    transition: box-shadow 0.2s var(--ease);
    overflow: hidden;
  }
  .kit-card.entered { box-shadow: 0 0 0 1.5px var(--g-100), 0 12px 26px -22px rgba(7, 43, 31, 0.4); }
  .kit-card.dirty { box-shadow: 0 0 0 2px var(--g-600), 0 14px 30px -18px rgba(11, 154, 104, 0.5); }
  .kit-card.readonly { opacity: 0.94; }

  .kit-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .kit-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .kit-name {
    font-size: 14px; font-weight: 700; letter-spacing: -0.02em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .kit-serial {
    max-width: 42%; padding: 4px 8px; border-radius: 8px;
    background: var(--paper); color: var(--ink-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
  }
  .kit-state {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 9px; border-radius: 999px;
    font-size: 10px; font-weight: 750; text-transform: uppercase; letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .kit-state.pending { background: var(--amber-soft); color: var(--amber-ink); }
  .kit-state.entered { background: var(--g-100); color: var(--g-800); }
  .kit-state.mapped { background: var(--male-tint); color: var(--male); }

  /* ── fields ──────────────────────────────────────────────── */
  .field {
    display: flex; align-items: center; gap: 9px;
    min-width: 0; box-sizing: border-box;
    padding: 12px; margin-bottom: 8px;
    border: 1.5px solid transparent; border-radius: 13px;
    background: var(--paper);
    transition: border-color 0.2s var(--ease), background 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }
  .field:focus-within {
    border-color: var(--g-600); background: #fff;
    box-shadow: 0 0 0 4px rgba(11, 154, 104, 0.12);
  }
  .field-icon { color: #8ea098; flex-shrink: 0; transition: color 0.2s var(--ease); }
  .field:focus-within .field-icon { color: var(--g-600); }
  .field input {
    flex: 1; min-width: 0; width: 100%;
    padding: 0; border: none; outline: none; background: transparent;
    color: var(--ink); font: inherit; font-size: 16px;
    -webkit-user-select: text; user-select: text;
  }
  .field input::placeholder { color: #9aa9a3; }

  /* ── count boxes: big, thumb-friendly ───────────────────── */
  .count-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-bottom: 11px; }
  .count-input {
    display: flex; flex-direction: column; gap: 2px;
    min-width: 0; box-sizing: border-box;
    padding: 9px 12px 8px;
    border-radius: 14px;
    border: 1.5px solid transparent;
    transition: border-color 0.2s var(--ease), background 0.2s var(--ease), box-shadow 0.2s var(--ease);
  }
  .count-input.male { background: var(--male-tint); }
  .count-input.female { background: var(--female-tint); }
  .count-input.male:focus-within { border-color: var(--male); background: #fff; box-shadow: 0 0 0 4px rgba(30, 95, 168, 0.12); }
  .count-input.female:focus-within { border-color: var(--female); background: #fff; box-shadow: 0 0 0 4px rgba(178, 58, 50, 0.12); }

  .count-label { font-size: 10.5px; font-weight: 750; text-transform: uppercase; letter-spacing: 0.07em; }
  .count-input.male .count-label { color: var(--male); }
  .count-input.female .count-label { color: var(--female); }

  .count-input input {
    width: 100%; min-width: 0; padding: 0;
    border: none; outline: none; background: transparent;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 24px; font-weight: 750; letter-spacing: -0.03em; line-height: 1.15;
    color: var(--ink);
    -moz-appearance: textfield; appearance: textfield;
    -webkit-user-select: text; user-select: text;
  }
  .count-input input::-webkit-outer-spin-button,
  .count-input input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .count-input input::placeholder { color: rgba(14, 42, 33, 0.25); font-weight: 600; }
  .count-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 24px; font-weight: 750; letter-spacing: -0.03em; line-height: 1.15;
  }

  /* ── kit footer ──────────────────────────────────────────── */
  .kit-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .kit-total { font-size: 12.5px; color: var(--ink-3); }
  .kit-total b {
    margin-left: 4px; font-size: 16px; font-weight: 750; color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .save-btn {
    padding: 10px 20px; border: none; border-radius: 12px;
    background: linear-gradient(135deg, var(--g-700), var(--g-600));
    color: #fff; font: inherit; font-size: 13px; font-weight: 750;
    cursor: pointer;
    box-shadow: 0 8px 18px -8px rgba(7, 116, 81, 0.55);
    transition: transform 0.16s var(--ease);
  }
  .save-btn:active:not(:disabled) { transform: scale(0.95); }
  .save-btn:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }

  /* ── read-only ───────────────────────────────────────────── */
  .readonly-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 12px; margin-bottom: 8px;
    background: var(--paper); border-radius: 12px; font-size: 13px;
  }
  .readonly-label { color: var(--ink-3); font-weight: 600; }
  .readonly-value { font-weight: 650; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .future-note { margin-top: 4px; padding-left: 2px; font-size: 12px; color: var(--ink-3); font-style: italic; }

  /* ═══════════════════════════════════════════════════════════
     SAVE BAR — pinned to the sheet bottom
     ═══════════════════════════════════════════════════════════ */
  .savebar {
    flex: none;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    background: rgba(255, 255, 255, 0.96);
    border-top: 1px solid var(--line);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  .cta {
    width: 100%; padding: 15px 16px;
    border: 0; border-radius: 15px;
    background: linear-gradient(135deg, var(--g-700), var(--g-600));
    color: #fff; font: inherit; font-size: 15px; font-weight: 750; letter-spacing: -0.012em;
    cursor: pointer;
    box-shadow: 0 12px 24px -12px rgba(7, 116, 81, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.14);
    transition: transform 0.16s var(--ease);
  }
  .cta:active:not(:disabled) { transform: scale(0.985); }
  .cta:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }
  .hint { margin-top: 8px; text-align: center; font-size: 11.5px; font-weight: 600; color: var(--ink-3); }
  .hint.ready { color: var(--g-800); font-weight: 700; }
  .toast { margin-bottom: 10px; padding: 10px 13px; border-radius: 12px; font-size: 12.5px; font-weight: 600; animation: rise 0.3s var(--ease) both; }
  .toast.err { background: var(--red-soft); color: var(--red); }

  /* ═══════════════════════════════════════════════════════════
     GATES / EMPTY
     ═══════════════════════════════════════════════════════════ */
  .gate {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    padding: calc(12px + env(safe-area-inset-top)) 14px 14px;
    background: var(--paper);
  }
  .gate-back { align-self: flex-start; }
  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 28px 60px; text-align: center; }
  .center-title { margin: 16px 0 5px; font-size: 18px; font-weight: 750; letter-spacing: -0.03em; }
  .center-text { max-width: 290px; margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-3); }
  .tile {
    width: 58px; height: 58px; border-radius: 19px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(145deg, var(--g-100), #c9f4df); color: var(--g-800);
  }
  .tile.danger { background: var(--red-soft); color: var(--red); }
  .empty {
    padding: 36px 20px; border: 1px dashed #d5dfda; border-radius: 18px;
    background: rgba(255, 255, 255, 0.7); color: var(--ink-3); font-size: 13px; text-align: center;
  }

  /* ═══════════════════════════════════════════════════════════
     SKELETON
     ═══════════════════════════════════════════════════════════ */
  .sk {
    display: block; border-radius: 6px;
    background: linear-gradient(90deg, rgba(10, 48, 35, 0.06) 0%, rgba(10, 48, 35, 0.12) 50%, rgba(10, 48, 35, 0.06) 100%);
    background-size: 200% 100%;
    animation: sk-shimmer 1.4s ease-in-out infinite;
  }
  .hero-skeleton .sk {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.24) 50%, rgba(255, 255, 255, 0.1) 100%);
    background-size: 200% 100%;
  }
  .sk-btn { width: 38px; height: 38px; border-radius: 13px; }
  .sk-pill { width: 60px; height: 26px; border-radius: 999px; }
  .sk-h1 { width: 62%; height: 22px; border-radius: 8px; margin-bottom: 8px; }
  .sk-sub { width: 44%; height: 12px; }
  .sk-chip { width: 96px; height: 34px; border-radius: 999px; }
  .sk-stat { width: 70%; height: 20px; }
  .sk-label { width: 50%; height: 9px; border-radius: 4px; }
  .sk-sec { width: 110px; height: 14px; }
  .sk-badge { width: 36px; height: 22px; border-radius: 999px; }
  .sk-kitname { width: 60%; height: 13px; margin-bottom: 6px; }
  .sk-kitserial { width: 68px; height: 16px; }
  .sk-status { width: 70px; height: 22px; border-radius: 999px; }
  .sk-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
  .sk-venue { width: 70%; height: 13px; }
  .sk-count-lbl { width: 34px; height: 10px; }
  .sk-count-val { width: 50%; height: 22px; }
  .sk-total { width: 90px; height: 12px; }
  .sk-btn-wide { width: 82px; height: 36px; border-radius: 12px; }
  .skeleton-card { pointer-events: none; }
  .skeleton-card .count-input.sk-count { height: 62px; }
  @keyframes sk-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* ═══════════════════════════════════════════════════════════
     SUCCESS MODAL
     ═══════════════════════════════════════════════════════════ */
  .modal-overlay {
    position: fixed; inset: 0; z-index: 100;
    display: flex; align-items: flex-end; justify-content: center;
    background: rgba(10, 35, 27, 0.5);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    animation: fadein 0.2s var(--ease) both;
  }
  .modal-sheet {
    width: 100%; max-width: 440px; background: #fff;
    border-radius: 26px 26px 0 0;
    padding: 12px 24px calc(24px + env(safe-area-inset-bottom));
    text-align: center;
    animation: rise 0.35s var(--ease) both;
    box-shadow: 0 -20px 60px rgba(6, 39, 29, 0.25);
  }
  .grabber { width: 36px; height: 4px; border-radius: 3px; background: var(--line); margin: 0 auto 20px; }
  .check-wrap { width: 68px; height: 68px; margin: 0 auto 14px; }
  .check-svg { width: 100%; height: 100%; }
  .check-circle {
    fill: none; stroke: var(--g-600); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 200; stroke-dashoffset: 200; animation: draw-stroke 0.5s var(--ease) forwards;
  }
  .check-mark {
    fill: none; stroke: var(--g-600); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 40; stroke-dashoffset: 40; animation: draw-stroke 0.35s var(--ease) forwards 0.45s;
  }
  .check-wrap.queued .check-circle, .check-wrap.queued .check-mark { stroke: var(--amber); }
  @keyframes draw-stroke { to { stroke-dashoffset: 0; } }

  .modal-title { margin: 0 0 6px; font-size: 18px; font-weight: 750; letter-spacing: -0.025em; }
  .modal-subtitle { margin: 0 0 20px; font-size: 13px; line-height: 1.5; color: var(--ink-2); }
  .modal-actions { display: flex; gap: 8px; }
  .modal-btn {
    flex: 1; padding: 14px; border: none; border-radius: 14px;
    font: inherit; font-size: 14px; font-weight: 750; cursor: pointer;
    transition: transform 0.16s var(--ease);
  }
  .modal-btn.primary {
    background: linear-gradient(135deg, var(--g-700), var(--g-600)); color: #fff;
    box-shadow: 0 10px 22px -10px rgba(7, 116, 81, 0.5);
  }
  .modal-btn:active { transform: scale(0.97); }

  /* ═══════════════════════════════════════════════════════════
     MOTION
     ═══════════════════════════════════════════════════════════ */
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    .modal-sheet, .toast, .sk { animation: none; }
    .cta, .save-btn, .date-chip, .icon-btn, .glass-btn, .hero-progress span { transition: none; }
  }

  @media (max-width: 360px) {
    .hero { padding-left: 12px; padding-right: 12px; }
    .hero-stat-num { font-size: 18px; }
    .count-input input, .count-value { font-size: 21px; }
    .kit-card { padding: 12px; border-radius: 18px; }
  }
</style>