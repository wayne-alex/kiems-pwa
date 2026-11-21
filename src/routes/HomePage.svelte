<script>
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { session } from "../lib/session.js";
  import { apiFetch } from "../lib/api.js";
  import { Cache } from "../lib/core/db.js";
  import SyncBadge from "../components/SyncBadge.svelte";
  import { captureCardRect } from "../lib/transition.js";
  import PageTransition from "../components/PageTransition.svelte";
  import ServiceTile from "../components/ServiceTile.svelte";
  import HeroRing from "../components/HeroRing.svelte";
  import { formAService } from "$lib/services/forms-tracking/index.js";
  import { voterLookupService } from "$lib/services/voter-lookup/index.js";
  import { reportsService } from "$lib/services/reports/index.js";
  import { announcementsService } from "$lib/services/announcements/index.js";
  import { incidentsService } from "$lib/services/incidents/index.js";
  import {
    trainingService,
    helpService,
  } from "$lib/services/reference/index.js";
  import { stationsService } from "$lib/services/stations/index.js";
  import { profileSheetOpen } from "$lib/core/ui.js";

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // TIME
  // ═══════════════════════════════════════════════════════════
  function getGreeting() {
    const h = new Date().getHours();
    if (h < 4) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 21) return "Good evening";
    return "Good night";
  }
  let greeting = getGreeting();
  let iv;
  let toastTimer;
  let latestAnnouncement = null;
  let announcementLoaded = false;

  // ═══════════════════════════════════════════════════════════
  // STICKY-BAR SCROLL STATE
  // ═══════════════════════════════════════════════════════════
  let scrollEl;
  let scrolled = false;
  let showBarWard = false;

  function onScroll() {
    if (!scrollEl) return;
    const y = scrollEl.scrollTop;
    scrolled = y > 4;
    showBarWard = y > 90;
  }

  // ═══════════════════════════════════════════════════════════
  // PROFILE
  // ═══════════════════════════════════════════════════════════
  function openProfile() {
    try {
      navigator.vibrate?.(6);
    } catch {
      /* ignore */
    }
    profileSheetOpen.set(true);
  }

  onMount(() => {
    iv = setInterval(() => (greeting = getGreeting()), 60_000);
    onScroll();
  });
  onDestroy(() => {
    clearInterval(iv);
    clearTimeout(toastTimer);
  });

  // ═══════════════════════════════════════════════════════════
  // LIVE STATS
  // ═══════════════════════════════════════════════════════════
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const today = (() => {
    const d = new Date();
    return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  })();
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  })();

  let entryStats = null;
  let movementStats = null;

  $: bound = $session.status === "bound" && $session.ward;

  $: if (bound && $session.fingerprint && entryStats === null) loadEntryStats();
  $: if (bound && $session.ward && movementStats === null) loadMovementStats();
  $: if (bound && !announcementLoaded) {
    announcementLoaded = true;
    loadLatestAnnouncement();
  }

  async function loadLatestAnnouncement() {
    try {
      const wardId = $session.ward?.id;
      const params = new URLSearchParams({ page_size: "1" });
      if (wardId) params.set("ward_id", String(wardId));
      const res = await apiFetch(`/api/announcements/?${params.toString()}`);
      if (res.ok && res.announcements?.length) {
        latestAnnouncement = res.announcements[0];
      }
    } catch {
      announcementLoaded = false;
    }
  }

  async function loadEntryStats() {
    const cacheKey = `entry:${$session.ward.id}:${today}`;
    try {
      const row = await Cache.get(cacheKey);
      if (row?.value && Array.isArray(row.value.kits)) {
        entryStats = summarize(row.value.kits, (k) => !!k.has_registration);
      }
    } catch {
      /* ignore */
    }

    try {
      const data = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${today}`,
      );
      if (data && Array.isArray(data.kits)) {
        entryStats = summarize(data.kits, (k) => !!k.has_registration);
      }
    } catch {
      /* cached stands */
    }
  }

  async function loadMovementStats() {
    const cacheKey = `movement:${$session.ward.id}:${tomorrow}`;
    try {
      const row = await Cache.get(cacheKey);
      if (row?.value && Array.isArray(row.value.kits)) {
        movementStats = summarize(row.value.kits, (k) =>
          (k.venue || "").trim(),
        );
      }
    } catch {
      /* ignore */
    }

    try {
      const data = await apiFetch(
        `/movement/kits/?ward_id=${encodeURIComponent($session.ward.id)}&date=${tomorrow}`,
      );
      if (data && Array.isArray(data.kits)) {
        movementStats = summarize(data.kits, (k) => (k.venue || "").trim());
      }
    } catch {
      /* cached stands */
    }
  }

  function summarize(items, isDone) {
    const total = items.length;
    const done = items.filter(isDone).length;
    return { done, total };
  }

  const pctOf = (s) =>
    s && s.total ? Math.round((s.done / s.total) * 100) : 0;
  const isComplete = (s) => !!(s && s.total > 0 && s.done >= s.total);

  function statusOf(s) {
    if (!s) return { key: "loading", label: "Loading" };
    if (!s.total) return { key: "none", label: "No kits" };
    if (isComplete(s)) return { key: "done", label: "Completed" };
    if (s.done === 0) return { key: "open", label: "Open" };
    return { key: "pending", label: "Pending" };
  }

  $: loaded = entryStats !== null || movementStats !== null;
  $: openTasks =
    Math.max(0, (entryStats?.total || 0) - (entryStats?.done || 0)) +
    Math.max(0, (movementStats?.total || 0) - (movementStats?.done || 0));
  $: totalAll = (entryStats?.total || 0) + (movementStats?.total || 0);
  $: doneAll = (entryStats?.done || 0) + (movementStats?.done || 0);
  $: overall = totalAll ? Math.round((doneAll / totalAll) * 100) : 0;
  $: allDone = isComplete(entryStats) && isComplete(movementStats);

  // ═══════════════════════════════════════════════════════════
  // ICONS
  // ═══════════════════════════════════════════════════════════
  const ICONS = {
    clipboard: [
      "M7 3.5H15L19 7.5V20.5A1 1 0 0 1 18 21.5H7A1 1 0 0 1 6 20.5V4.5A1 1 0 0 1 7 3.5Z",
      "M15 3.5V7.5H19",
      "M9.5 14L11.5 16L15 12",
    ],
    calendar: [
      "M5 5H19A2 2 0 0 1 21 7V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V7A2 2 0 0 1 5 5Z",
      "M3 10H21",
      "M8 3V7",
      "M16 3V7",
      "M9 15L11 17L15 13",
    ],
    box: ["M21 8L12 3L3 8L12 13Z", "M3 8V16L12 21L21 16V8", "M12 13V21"],
    alert: ["M12 3L22 20H2Z", "M12 10V14", "M12 17.2V17.3"],
    chart: ["M4 20V11", "M10 20V5", "M16 20V14", "M2.5 20.5H21.5"],
    search: ["M11 4A7 7 0 1 0 11 18A7 7 0 1 0 11 4Z", "M16.5 16.5L21 21"],
    pin: [
      "M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z",
      "M12 7.5A2.2 2.2 0 1 0 12 11.9A2.2 2.2 0 1 0 12 7.5Z",
    ],
    clock: ["M12 3A9 9 0 1 0 12 21A9 9 0 1 0 12 3Z", "M12 7V12L15.5 14"],
    book: [
      "M4 19.5V5A2 2 0 0 1 6 3H20V17H6A2 2 0 0 0 4 19.5Z",
      "M4 19.5A2 2 0 0 0 6 21.5H20V17",
    ],
    folder: [
      "M3 6A1 1 0 0 1 4 5H9L11 7H20A1 1 0 0 1 21 8V18A1 1 0 0 1 20 19H4A1 1 0 0 1 3 18Z",
    ],
    chat: [
      "M4 5H20A1 1 0 0 1 21 6V16A1 1 0 0 1 20 17H10L5 21V17H4A1 1 0 0 1 3 16V6A1 1 0 0 1 4 5Z",
    ],
    help: [
      "M12 3A9 9 0 1 0 12 21A9 9 0 1 0 12 3Z",
      "M9.5 9.5A2.5 2.5 0 1 1 12 12V13.5",
      "M12 17V17.1",
    ],
    shield: [
      "M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z",
      "M8.5 12L11 14.5L15.5 9.5",
    ],
    check: ["M5 12.5L10 17.5L19 7"],
    arrow: ["M5 12H19", "M13 6L19 12L13 18"],
    chevron: ["M9 6L15 12L9 18"],
    megaphone: [
      "M3 11V13A2 2 0 0 0 5 15H7L12 20V4L7 9H5A2 2 0 0 0 3 11Z",
      "M15.5 8.5A5 5 0 0 1 15.5 15.5",
    ],
    fileText: [
      "M7 3.5H15L19 7.5V20.5A1 1 0 0 1 18 21.5H7A1 1 0 0 1 6 20.5V4.5A1 1 0 0 1 7 3.5Z",
      "M15 3.5V7.5H19",
      "M9 12H16",
      "M9 15.5H16",
      "M9 8.5H12",
    ],
  };
  const icons = ICONS;

  // ═══════════════════════════════════════════════════════════
  // SERVICES  — single source of truth
  // ═══════════════════════════════════════════════════════════
  $: SERVICES = [
    {
      id: "entry",
      label: "Registration",
      icon: "clipboard",
      tone: "green",
      live: true,
      stats: entryStats,
    },
    {
      id: "movement",
      label: "Movement",
      icon: "calendar",
      tone: "blue",
      live: true,
      stats: movementStats,
    },
    { ...formAService, live: true },
    { ...voterLookupService, live: true },
    { ...reportsService, live: true },
    { ...announcementsService, live: true },
    { ...incidentsService, live: true },
    { ...stationsService, live: true },
    { ...trainingService, live: true },
    { ...helpService, live: true },
  ];

  $: soonCount = SERVICES.filter((s) => !s.live).length;

  function subOf(s) {
    if (!s.live) return s.hint ?? "Coming soon";
    if (!s.stats) return "Loading…";
    if (!s.stats.total) return "No kits";
    return isComplete(s.stats)
      ? "All done"
      : `${s.stats.done} of ${s.stats.total}`;
  }

  // ═══════════════════════════════════════════════════════════
  // TASKS  (only actionable today)
  // ═══════════════════════════════════════════════════════════
  $: tasks = [
    {
      id: "entry",
      icon: "clipboard",
      tone: "green",
      title: "Daily registration",
      sub:
        entryStats && entryStats.total
          ? `Today · ${entryStats.done} of ${entryStats.total} kits`
          : "Today · Voter counts per kit",
      st: statusOf(entryStats),
    },
    {
      id: "movement",
      icon: "calendar",
      tone: "blue",
      title: "Kit movement plan",
      sub:
        movementStats && movementStats.total
          ? `Tomorrow · ${movementStats.done} of ${movementStats.total} venues`
          : "Tomorrow · Venue per kit",
      st: statusOf(movementStats),
    },
  ];
  $: activeTasks = tasks.filter(
    (t) => t.st.key !== "done" && t.st.key !== "none",
  );

  // ═══════════════════════════════════════════════════════════
  // CTA + NAV
  // ═══════════════════════════════════════════════════════════
  $: cta = (() => {
    if (!bound) return null;
    if (entryStats && entryStats.total > 0 && !isComplete(entryStats)) {
      return {
        id: "entry",
        label:
          entryStats.done === 0
            ? "Start registration"
            : "Continue registration",
      };
    }
    if (
      movementStats &&
      movementStats.total > 0 &&
      !isComplete(movementStats)
    ) {
      return {
        id: "movement",
        label: movementStats.done === 0 ? "Plan movement" : "Continue movement",
      };
    }
    return null;
  })();

  const tickHaptic = (ms = 10) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* ignore */
    }
  };

  let toast = "";
  function soon(label) {
    tickHaptic(6);
    toast = `${label} is coming soon`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 1900);
  }

  // `el` is the real DOM element that was tapped (used for the
  // card → page transition).
  function open(id, tone, el) {
    tickHaptic();
    if (el) captureCardRect(el, tone === "blue" ? "blue" : "green");
    dispatch("navigate", id);
  }

  function openService(s, el) {
    if (!s) return;
    if (!s.live) return soon(s.label);
    open(s.id, s.tone, el);
  }

  function openTask(t, e) {
    open(t.id, t.tone, e.currentTarget);
  }

  // ═══════════════════════════════════════════════════════════
  // SESSION HELPERS
  // ═══════════════════════════════════════════════════════════
  $: vraName = $session.vra?.name || "VRA";
  $: wardName = $session.ward?.name || "";
  $: constituencyName = $session.constituency?.name || "";
  $: fingerprintShort = $session.fingerprint
    ? $session.fingerprint.slice(0, 6).toUpperCase()
    : "···";
  $: initial = vraName.trim().charAt(0).toUpperCase() || "V";
  $: firstName = vraName.trim().split(/\s+/)[0];
</script>

<PageTransition>
  <div class="home">
    <!-- ═════════════════ STICKY BAR ═════════════════ -->
    <header class="bar" class:scrolled>
      <div class="brand">
        <svg class="logo" viewBox="0 0 48 52" aria-hidden="true">
          <defs>
            <linearGradient id="kl" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#12b67f" />
              <stop offset="1" stop-color="#067552" />
            </linearGradient>
          </defs>
          <path
            d="M24 2L44 9V25C44 37 35.5 46 24 50C12.5 46 4 37 4 25V9Z"
            fill="url(#kl)"
          />
          <path
            d="M15.5 25.5L21.5 31.5L33 19"
            fill="none"
            stroke="#fff"
            stroke-width="4.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div class="brand-text">
          <div class="brand-name">KIEMS<span> Field</span></div>
          {#if showBarWard && wardName}
            <div class="brand-loc">
              {wardName}{#if constituencyName}
                · {constituencyName}{/if}
            </div>
          {:else}
            <div class="brand-tag">Register <i></i> Plan <i></i> Report</div>
          {/if}
        </div>
      </div>

      <div class="right">
        <div class="sync-wrap"><SyncBadge /></div>
        <button class="avatar" on:click={openProfile} aria-label="Open profile">
          {initial}
          <i
            class="pip"
            class:on={$session.status === "bound"}
            class:warn={$session.status === "unbound"}
          ></i>
        </button>
      </div>
    </header>

    <!-- ═════════════════ SCROLLING CONTENT ═════════════════ -->
    <div class="scroll" bind:this={scrollEl} on:scroll={onScroll}>
      <!-- Greeting -->
      <section class="greet r" style="--d:0">
        <h1>
          {greeting}{#if bound}, {firstName}{/if}
          <span class="wave" aria-hidden="true">👋</span>
        </h1>
        <p>
          {#if bound}
            {wardName}{#if constituencyName}, {constituencyName}{/if}
          {:else if $session.status === "unbound"}
            No ward on this device yet
          {:else}
            Getting things ready…
          {/if}
        </p>
      </section>

      <!-- Hero -->
      <section class="hero r" style="--d:1" aria-label="Today at a glance">
        {#if bound}
          <div class="hero-head">
            <div>
              <div class="hero-title">Work smart today</div>
              <div class="hero-stats">
                <div class="hs">
                  <div class="hs-num">{loaded ? openTasks : "·"}</div>
                  <div class="hs-label">Open tasks</div>
                </div>
                <div class="hs-div"></div>
                <div class="hs">
                  <div class="hs-num">
                    {loaded ? (entryStats ? entryStats.done : 0) : "·"}
                  </div>
                  <div class="hs-label">Recorded today</div>
                </div>
              </div>
            </div>
            <HeroRing
              percent={overall}
              label={`${overall}%`}
              sublabel="overall"
            />
          </div>

          {#if cta}
            <button
              class="hero-cta"
              on:click={(e) =>
                open(
                  cta.id,
                  cta.id === "entry" ? "green" : "blue",
                  e.currentTarget,
                )}
            >
              <span>{cta.label}</span>
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                {#each ICONS.arrow as d}<path {d} />{/each}
              </svg>
            </button>
          {:else if allDone}
            <div class="hero-ok">
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="3.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                {#each ICONS.check as d}<path {d} />{/each}
              </svg>
              You're all caught up
            </div>
          {/if}
        {:else if $session.status === "unbound"}
          <div class="hero-title">Device not set up</div>
          <p class="hero-note">Choose your ward to start working.</p>
        {:else}
          <div class="hero-title">Loading…</div>
        {/if}
      </section>

      <!-- Announcements banner -->
      <section class="notice r" style="--d:2" aria-label="Announcements">
        <span class="notice-ic teal">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {#each ICONS.megaphone as d}<path {d} />{/each}
          </svg>
        </span>
        <div class="notice-body">
          {#if latestAnnouncement}
            <div class="notice-title">{latestAnnouncement.title}</div>
            <div class="notice-sub">
              <span class="notice-src" class:ict={!latestAnnouncement.is_iebc}>
                {latestAnnouncement.is_iebc ? "IEBC" : "ICT"}
              </span>
              Latest announcement
            </div>
          {:else}
            <div class="notice-title">Announcements</div>
            <div class="notice-sub">No new announcements.</div>
          {/if}
        </div>
        <button
          class="notice-link"
          on:click={(e) =>
            openService(
              SERVICES.find((s) => s.id === "announcements"),
              e.currentTarget,
            )}
        >
          {latestAnnouncement ? "Read" : "View"}
        </button>
      </section>

      <!-- Services grid -->
      <section class="block r" style="--d:3">
        <div class="head">
          <h2><span class="accent green"></span>Services</h2>
          {#if soonCount > 0}
            <span class="count">{soonCount} coming soon</span>
          {/if}
        </div>
        <div class="grid">
          {#each SERVICES as s (s.id)}
            <ServiceTile
              service={s}
              {icons}
              {isComplete}
              {subOf}
              on:open={(e) => openService(e.detail.service, e.detail.el)}
            />
          {/each}
        </div>
      </section>

      <!-- Your tasks -->
      {#if bound && activeTasks.length > 0}
        <section class="block r" style="--d:4">
          <div class="head">
            <h2><span class="accent blue"></span>Your tasks</h2>
          </div>
          <div class="panel">
            {#each activeTasks as t (t.id)}
              <button class="row" on:click={(e) => openTask(t, e)}>
                <span class="ic sq {t.tone}">
                  <svg
                    viewBox="0 0 24 24"
                    width="21"
                    height="21"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    {#each ICONS[t.icon] as d}<path {d} />{/each}
                  </svg>
                </span>
                <span class="row-main">
                  <span class="row-title">{t.title}</span>
                  <span class="row-sub">{t.sub}</span>
                </span>
                <span class="pill {t.st.key}">{t.st.label}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Overview -->
      {#if bound}
        <section class="block r" style="--d:5">
          <div class="head">
            <h2><span class="accent teal"></span>Overview</h2>
          </div>
          <div class="panel metrics">
            <div class="metric">
              <span class="ic green">
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  {#each ICONS.shield as d}<path {d} />{/each}
                </svg>
              </span>
              <div class="m-val g">
                {loaded ? overall : "–"}{#if loaded}<small>%</small>{/if}
              </div>
              <div class="m-label">Completion</div>
              <div class="m-bar g"><span style="width:{overall}%"></span></div>
            </div>
            <div class="metric">
              <span class="ic purple">
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  {#each ICONS.clipboard as d}<path {d} />{/each}
                </svg>
              </span>
              <div class="m-val">
                {entryStats ? `${entryStats.done}/${entryStats.total}` : "–"}
              </div>
              <div class="m-label">Kits today</div>
              <div class="m-bar p">
                <span style="width:{pctOf(entryStats)}%"></span>
              </div>
            </div>
            <div class="metric">
              <span class="ic teal">
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  {#each ICONS.pin as d}<path {d} />{/each}
                </svg>
              </span>
              <div class="m-val">
                {movementStats
                  ? `${movementStats.done}/${movementStats.total}`
                  : "–"}
              </div>
              <div class="m-label">Venues set</div>
              <div class="m-bar t">
                <span style="width:{pctOf(movementStats)}%"></span>
              </div>
            </div>
            <div class="metric">
              <span class="ic amber">
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  {#each ICONS.alert as d}<path {d} />{/each}
                </svg>
              </span>
              <div class="m-val">{loaded ? openTasks : "–"}</div>
              <div class="m-label">Open tasks</div>
              <div class="m-bar a">
                <span
                  style="width:{totalAll
                    ? Math.round((openTasks / totalAll) * 100)
                    : 0}%"
                ></span>
              </div>
            </div>
          </div>
        </section>
      {/if}

      <footer class="foot">KIEMS v0.2 · Device {fingerprintShort}</footer>
    </div>

    {#if toast}
      <div class="toast" role="status">{toast}</div>
    {/if}
  </div>
</PageTransition>

<style>
  .home {
    --bg: #f6f8fb;
    --card: #ffffff;
    --navy: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --green: #0a9d6e;
    --green-d: #067552;
    --green-l: #e3f6ee;
    --blue: #2f6fe0;
    --blue-l: #e7f0ff;
    --purple: #6a4cd8;
    --purple-l: #eeeaff;
    --red: #e23b3b;
    --red-l: #ffe8e8;
    --amber: #ef9400;
    --amber-l: #fff2dc;
    --teal: #0e9aa7;
    --teal-l: #def6f8;
    --pink: #d6397f;
    --pink-l: #ffe6f1;
    --slate: #4d5d73;
    --slate-l: #e9eef4;

    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);
    --shadow: 0 1px 2px rgba(14, 31, 63, 0.04),
      0 14px 30px -18px rgba(14, 31, 63, 0.2);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    color: var(--navy);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    overscroll-behavior: none;
  }
  button {
    font: inherit;
    color: inherit;
  }

  /* ── Sticky bar ──────────────────────────────────────── */
  .bar {
    flex: none;
    position: relative;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
    background: rgba(246, 248, 251, 0.94);
    -webkit-backdrop-filter: saturate(140%) blur(14px);
    backdrop-filter: saturate(140%) blur(14px);
    border-bottom: 1px solid transparent;
    transition:
      border-color 0.2s var(--ease),
      box-shadow 0.2s var(--ease);
  }
  .bar.scrolled {
    border-bottom-color: var(--line);
    box-shadow: 0 8px 20px -18px rgba(14, 31, 63, 0.35);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .logo {
    width: 34px;
    height: 37px;
    flex-shrink: 0;
    filter: drop-shadow(0 6px 8px rgba(6, 117, 82, 0.25));
  }
  .brand-text {
    min-width: 0;
  }
  .brand-name {
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
    color: var(--navy);
    white-space: nowrap;
  }
  .brand-name span {
    color: var(--green);
  }
  .brand-tag {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .brand-tag i {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--green);
  }
  .brand-loc {
    margin-top: 4px;
    font-size: 11px;
    font-weight: 650;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    animation: fadein 0.22s var(--ease);
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .sync-wrap {
    display: inline-flex;
    align-items: center;
  }
  .avatar {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    cursor: pointer;
    background: linear-gradient(145deg, #12b67f, #067552);
    color: #fff;
    font-size: 15px;
    font-weight: 800;
    box-shadow:
      0 0 0 3px #fff,
      0 8px 16px -6px rgba(6, 117, 82, 0.55);
    transition: transform 0.16s var(--ease);
  }
  .avatar:active {
    transform: scale(0.94);
  }
  .pip {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #b9c2d0;
    border: 2px solid #fff;
  }
  .pip.on {
    background: #22c55e;
  }
  .pip.warn {
    background: #f5a524;
  }

  /* ── Scroll area ────────────────────────────────────── */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 14px 18px calc(28px + env(safe-area-inset-bottom));
    scrollbar-width: none;
  }
  .scroll::-webkit-scrollbar {
    display: none;
  }

  /* ── Entrance ──────────────────────────────────────── */
  .r {
    animation: rise 0.55s var(--ease) both;
    animation-delay: calc(var(--d) * 65ms);
  }

  /* ── Greeting ──────────────────────────────────────── */
  .greet {
    margin: 4px 2px 16px;
  }
  .greet h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.035em;
    line-height: 1.15;
  }
  .wave {
    display: inline-block;
    transform-origin: 70% 80%;
    animation: wave 2.4s ease-in-out 0.9s 1;
  }
  .greet p {
    margin: 5px 0 0;
    font-size: 13.5px;
    color: var(--ink-2);
  }

  /* ── Hero ──────────────────────────────────────────── */
  .hero {
    position: relative;
    overflow: hidden;
    padding: 18px 20px 18px;
    border-radius: 24px;
    color: #fff;
    background: radial-gradient(
        90% 120% at 100% 0%,
        rgba(255, 255, 255, 0.2),
        transparent 55%
      ),
      linear-gradient(135deg, #0cae7b 0%, #079067 45%, #056548 100%);
    box-shadow:
      0 22px 38px -22px rgba(5, 101, 72, 0.75),
      inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }

  .hero-head {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  .hero-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
    opacity: 0.95;
  }
  .hero-stats {
    display: flex;
    align-items: stretch;
    gap: 20px;
  }
  .hs-num {
    font-size: 40px;
    font-weight: 800;
    letter-spacing: -0.05em;
    line-height: 1;
    min-height: 40px;
    transition: opacity 0.2s var(--ease);
  }
  .hs-label {
    margin-top: 5px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.88);
    font-weight: 500;
    white-space: nowrap;
  }
  .hs-div {
    width: 1px;
    background: rgba(255, 255, 255, 0.24);
  }

  .hero-cta {
    position: relative;
    margin-top: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 13px 16px;
    border: 0;
    border-radius: 14px;
    background: #fff;
    color: var(--green-d);
    font-size: 14px;
    font-weight: 750;
    letter-spacing: -0.01em;
    cursor: pointer;
    box-shadow: 0 10px 20px -10px rgba(0, 0, 0, 0.35);
    transition: transform 0.15s var(--ease);
  }
  .hero-cta:active {
    transform: scale(0.985);
  }
  .hero-cta:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 3px;
  }
  .hero-ok {
    position: relative;
    margin-top: 16px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    font-size: 13px;
    font-weight: 700;
  }
  .hero-note {
    position: relative;
    margin: 0;
    font-size: 13.5px;
    color: rgba(255, 255, 255, 0.88);
  }

  /* ── Announcements notice ──────────────────────────── */
  .notice {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 18px;
    background: var(--card);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  .notice-ic {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .notice-ic.teal {
    background: var(--teal-l);
    color: var(--teal);
  }
  .notice-body {
    flex: 1;
    min-width: 0;
  }
  .notice-title {
    font-size: 13.5px;
    font-weight: 750;
    letter-spacing: -0.02em;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .notice-sub {
    margin-top: 3px;
    font-size: 12px;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notice-link {
    border: 0;
    background: none;
    color: var(--teal);
    font-size: 12.5px;
    font-weight: 750;
    padding: 6px 4px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .notice-src {
    display: inline-block;
    margin-right: 4px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--teal-l);
    color: var(--teal);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }
  .notice-src.ict {
    background: var(--amber-l);
    color: var(--amber);
  }

  /* ── Blocks ───────────────────────────────────────── */
  .block {
    margin-top: 22px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 2px 12px;
  }
  .head h2 {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .accent {
    width: 3px;
    height: 14px;
    border-radius: 2px;
  }
  .accent.green {
    background: var(--green);
  }
  .accent.blue {
    background: var(--blue);
  }
  .accent.teal {
    background: var(--teal);
  }
  .count {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-3);
  }

  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    box-shadow: var(--shadow);
  }

  /* ── Services grid ─────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px 0;
    padding: 14px 6px 10px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    box-shadow: var(--shadow);
  }

  /* ── Tasks ─────────────────────────────────────────── */
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 14px;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s var(--ease);
  }
  .row + .row {
    border-top: 1px solid var(--line);
  }
  .row:first-child {
    border-radius: 22px 22px 0 0;
  }
  .row:last-child {
    border-radius: 0 0 22px 22px;
  }
  .row:only-child {
    border-radius: 22px;
  }
  .row:active {
    background: var(--bg);
  }
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .row-title {
    font-size: 14.5px;
    font-weight: 750;
    letter-spacing: -0.02em;
  }
  .row-sub {
    font-size: 12.5px;
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ic.sq {
    width: 44px;
    height: 44px;
    border-radius: 14px;
  }
  .ic {
    position: relative;
    flex-shrink: 0;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ic.green {
    background: var(--green-l);
    color: var(--green);
  }
  .ic.blue {
    background: var(--blue-l);
    color: var(--blue);
  }
  .ic.purple {
    background: var(--purple-l);
    color: var(--purple);
  }
  .ic.red {
    background: var(--red-l);
    color: var(--red);
  }
  .ic.amber {
    background: var(--amber-l);
    color: var(--amber);
  }
  .ic.teal {
    background: var(--teal-l);
    color: var(--teal);
  }
  .ic.pink {
    background: var(--pink-l);
    color: var(--pink);
  }
  .ic.slate {
    background: var(--slate-l);
    color: var(--slate);
  }

  .pill {
    flex-shrink: 0;
    padding: 7px 13px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 700;
    background: var(--slate-l);
    color: var(--slate);
  }
  .pill.done {
    background: var(--green-l);
    color: var(--green);
  }
  .pill.pending {
    background: var(--amber-l);
    color: var(--amber);
  }
  .pill.open {
    background: var(--red-l);
    color: var(--red);
  }

  /* ── Overview metrics ──────────────────────────────── */
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 16px 0 14px;
  }
  .metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 6px;
    min-width: 0;
  }
  .metric + .metric {
    border-left: 1px solid var(--line);
  }
  .metric .ic {
    width: 44px;
    height: 44px;
    margin-bottom: 9px;
  }
  .m-val {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
    white-space: nowrap;
  }
  .m-val.g {
    color: var(--green);
  }
  .m-val small {
    font-size: 12px;
    margin-left: 1px;
    font-weight: 700;
  }
  .m-label {
    margin: 6px 0 10px;
    font-size: 11px;
    color: var(--ink-2);
    text-align: center;
    line-height: 1.2;
  }
  .m-bar {
    width: 80%;
    height: 4px;
    border-radius: 999px;
    background: var(--line);
    overflow: hidden;
  }
  .m-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    transition: width 0.7s var(--ease);
  }
  .m-bar.g span {
    background: var(--green);
  }
  .m-bar.p span {
    background: var(--purple);
  }
  .m-bar.t span {
    background: var(--teal);
  }
  .m-bar.a span {
    background: var(--amber);
  }

  .foot {
    margin-top: 26px;
    text-align: center;
    font-size: 11px;
    color: var(--ink-3);
  }

  /* ── Toast ─────────────────────────────────────────── */
  .toast {
    position: fixed;
    left: 50%;
    z-index: 30;
    bottom: calc(24px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    padding: 12px 18px;
    border-radius: 999px;
    background: var(--navy);
    color: #fff;
    font-size: 13px;
    font-weight: 650;
    white-space: nowrap;
    box-shadow: 0 14px 28px -10px rgba(0, 0, 0, 0.45);
    animation: toast-in 0.25s var(--ease) both;
  }

  /* ── Motion ────────────────────────────────────────── */
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @keyframes fadein {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes wave {
    0%,
    60%,
    100% {
      transform: rotate(0);
    }
    10%,
    30% {
      transform: rotate(16deg);
    }
    20%,
    40% {
      transform: rotate(-10deg);
    }
    50% {
      transform: rotate(8deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .r,
    .wave,
    .toast,
    .brand-loc {
      animation: none;
    }
    .hero-cta,
    .avatar,
    .m-bar span,
    .row,
    .hs-num {
      transition: none;
    }
  }

  @media (max-width: 360px) {
    .scroll {
      padding-left: 14px;
      padding-right: 14px;
    }
    .grid {
      gap: 6px 0;
    }
    .hs-num {
      font-size: 34px;
    }
    .m-val {
      font-size: 16px;
    }
    .brand-tag {
      display: none;
    }
  }
</style>
