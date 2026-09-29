<script>
  import { createEventDispatcher, onMount } from "svelte";
  import { session } from "../lib/session.js";
  import { apiFetch } from "../lib/api.js";
  import { cacheGet } from "../lib/offline.js";
  import SyncBadge from "../components/SyncBadge.svelte";
  import { captureCardRect } from "../lib/transition.js";
  import PageTransition from "../components/PageTransition.svelte";

  const dispatch = createEventDispatcher();

  // ═══════════════════════════════════════════════════════════
  // TIME
  // ═══════════════════════════════════════════════════════════
  function getGreeting() {
    const h = new Date().getHours();
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 21) return "Good evening";
    return "Good night";
  }

  function getDateLabel() {
    return new Date().toLocaleDateString("en-KE", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }

  let greeting = getGreeting();
  let dateLabel = getDateLabel();
  let mounted = false;

  onMount(() => {
    mounted = true;
    const iv = setInterval(() => {
      greeting = getGreeting();
      dateLabel = getDateLabel();
    }, 60_000);
    return () => clearInterval(iv);
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

  let entryStats = null; // { done, total }
  let movementStats = null; // { done, total }

  $: bound = $session.status === "bound" && $session.ward;

  $: if (bound && $session.fingerprint && entryStats === null) {
    loadEntryStats();
  }
  $: if (bound && $session.ward && movementStats === null) {
    loadMovementStats();
  }

  async function loadEntryStats() {
    const cacheKey = `entry:${$session.ward.id}:${today}`;
    const cached = cacheGet(cacheKey);
    if (cached && Array.isArray(cached.kits)) {
      entryStats = summarize(cached.kits, (k) => !!k.has_registration);
    }

    try {
      const data = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${today}`,
      );
      if (data && Array.isArray(data.kits)) {
        entryStats = summarize(data.kits, (k) => !!k.has_registration);
      }
    } catch (err) {
      /* cached value stands */
    }
  }

  async function loadMovementStats() {
    const cacheKey = `movement:${$session.ward.id}:${tomorrow}`;
    const cached = cacheGet(cacheKey);
    if (cached && Array.isArray(cached.kits)) {
      movementStats = summarize(cached.kits, (k) => (k.venue || "").trim());
    }

    try {
      const data = await apiFetch(
        `/movement/kits/?ward_id=${encodeURIComponent($session.ward.id)}&date=${tomorrow}`,
      );
      if (data && Array.isArray(data.kits)) {
        movementStats = summarize(data.kits, (k) => (k.venue || "").trim());
      }
    } catch (err) {
      /* cached value stands */
    }
  }

  function summarize(items, isDone) {
    const total = items.length;
    const done = items.filter(isDone).length;
    return { done, total };
  }

  const pctOf = (s) => (s && s.total ? Math.round((s.done / s.total) * 100) : 0);
  const isComplete = (s) => !!(s && s.total > 0 && s.done >= s.total);

  // ═══════════════════════════════════════════════════════════
  // SERVICES + NEXT UP
  // ═══════════════════════════════════════════════════════════
  $: services = [
    {
      id: "entry",
      title: "Registration",
      subtitle: "Daily voter counts per kit",
      meta: "Today",
      accent: "green",
      stats: entryStats,
      icon: "clipboard",
    },
    {
      id: "movement",
      title: "Movement",
      subtitle: "Plan kit venues by day",
      meta: "Tomorrow",
      accent: "blue",
      stats: movementStats,
      icon: "calendar",
    },
  ];

  // The one thing that needs attention right now
  $: nextUp = (() => {
    if (!bound) return null;
    if (entryStats && entryStats.total > 0 && !isComplete(entryStats)) {
      return {
        id: "entry",
        accent: "green",
        label: "Today · Registration",
        text: `${entryStats.done} of ${entryStats.total} kits recorded`,
        action: entryStats.done === 0 ? "Start" : "Continue",
        pct: pctOf(entryStats),
      };
    }
    if (movementStats && movementStats.total > 0 && !isComplete(movementStats)) {
      return {
        id: "movement",
        accent: "blue",
        label: "Tomorrow · Movement",
        text: `${movementStats.done} of ${movementStats.total} venues set`,
        action: movementStats.done === 0 ? "Plan" : "Continue",
        pct: pctOf(movementStats),
      };
    }
    if (isComplete(entryStats) && isComplete(movementStats)) {
      return {
        id: null,
        accent: "green",
        label: "Status",
        text: "You're all caught up",
        action: "",
        pct: 100,
      };
    }
    return null;
  })();

  const tick = (ms = 10) => {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {}
  };

  function open(id, accent, ev) {
    tick();
    // Capture the tapped card's rect so the destination can fly in from it
    captureCardRect(ev.currentTarget, accent);
    dispatch("navigate", id);
  }

  // ═══════════════════════════════════════════════════════════
  // SESSION
  // ═══════════════════════════════════════════════════════════
  $: vraName = ($session.vra && $session.vra.name) || "VRA";
  $: wardName = $session.ward ? $session.ward.name : "";
  $: constituencyName = $session.constituency ? $session.constituency.name : "";
  $: fingerprintShort = $session.fingerprint
    ? $session.fingerprint.slice(0, 6).toUpperCase()
    : "···";
  $: initial = vraName.trim().charAt(0).toUpperCase() || "V";
</script>

<PageTransition>
  <div class="home" class:ready={mounted}>

    <!-- ═══════════════════════════════════════════════════════
         HERO — full-bleed, under the status bar
         ═══════════════════════════════════════════════════════ -->
    <header class="hero">
      <div class="hero-top">
        <div class="who">
          <span class="avatar">{initial}</span>
          <div class="who-text">
            {#if bound}
              <div class="who-name">{vraName}</div>
              <div class="who-sub">
                {wardName}{#if constituencyName} · {constituencyName}{/if}
              </div>
            {:else if $session.status === "unbound"}
              <div class="who-name">Not set up</div>
              <div class="who-sub">No ward on this device</div>
            {:else}
              <div class="who-name">IEBC Field</div>
              <div class="who-sub">Loading…</div>
            {/if}
          </div>
        </div>

        <div class="hero-badges">
          <div class="sync-wrap"><SyncBadge /></div>
          <div class="device" title="Device ID">
            <span class="dot" class:on={$session.status === "bound"}
                  class:warn={$session.status === "unbound"}></span>
            <span class="device-id">{fingerprintShort}</span>
          </div>
        </div>
      </div>

      <h1 class="greet">{greeting}.</h1>
      <p class="date">{dateLabel}</p>

      {#if nextUp}
        {#if nextUp.id}
          <button class="next {nextUp.accent}" on:click={(e) => open(nextUp.id, nextUp.accent, e)}>
            <div class="next-body">
              <div class="next-label">{nextUp.label}</div>
              <div class="next-text">{nextUp.text}</div>
              <div class="next-bar"><span style="width: {nextUp.pct}%"></span></div>
            </div>
            <span class="next-action">
              {nextUp.action}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6 L15 12 L9 18" />
              </svg>
            </span>
          </button>
        {:else}
          <div class="next done">
            <span class="done-tick">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.5 L10 17.5 L19 7" />
              </svg>
            </span>
            <div class="next-body">
              <div class="next-text tight">{nextUp.text}</div>
              <div class="next-label">Registration and movement plan are complete</div>
            </div>
          </div>
        {/if}
      {:else if $session.status === "unbound"}
        <div class="next warnbox">
          <div class="next-body">
            <div class="next-text tight">Device not set up</div>
            <div class="next-label">Choose your ward to start working.</div>
          </div>
        </div>
      {/if}
    </header>

    <!-- ═══════════════════════════════════════════════════════
         SHEET — services
         ═══════════════════════════════════════════════════════ -->
    <div class="sheet">
      <div class="sheet-body">
        <div class="section-head">
          <h2 class="section-title">Your work</h2>
        </div>

        <section class="services" aria-label="Your work">
          {#each services as svc, i (svc.id)}
            <button
              class="service {svc.accent}"
              style="--i:{i}"
              on:click={(e) => open(svc.id, svc.accent, e)}
              data-card={svc.id}
              aria-label={svc.title}
            >
              <div class="service-top">
                <div class="service-icon" aria-hidden="true">
                  {#if svc.icon === "clipboard"}
                    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
                         stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M7 3.5 H15 L19 7.5 V20.5 A1 1 0 0 1 18 21.5 H7 A1 1 0 0 1 6 20.5 V4.5 A1 1 0 0 1 7 3.5 Z" />
                      <path d="M15 3.5 V7.5 H19" />
                      <path d="M9.5 14 L11.5 16 L15 12" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
                         stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="5" width="18" height="16" rx="3" />
                      <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
                      <path d="M9 15 L11 17 L15 13" />
                    </svg>
                  {/if}
                </div>

                <!-- progress ring -->
                <div class="ring" aria-hidden="true">
                  <svg viewBox="0 0 44 44" width="44" height="44">
                    <circle class="ring-track" cx="22" cy="22" r="18" fill="none" stroke-width="4" />
                    <circle
                      class="ring-fill"
                      cx="22" cy="22" r="18" fill="none" stroke-width="4"
                      stroke-linecap="round"
                      pathLength="100"
                      stroke-dasharray="{pctOf(svc.stats)} 100"
                    />
                  </svg>
                  <span class="ring-text">
                    {#if isComplete(svc.stats)}
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                           stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 12.5 L10 17.5 L19 7" />
                      </svg>
                    {:else if svc.stats && svc.stats.total > 0}
                      {svc.stats.done}/{svc.stats.total}
                    {:else}
                      ·
                    {/if}
                  </span>
                </div>
              </div>

              <div class="service-body">
                <h3 class="service-title">{svc.title}</h3>
                <p class="service-sub">{svc.subtitle}</p>
              </div>

              <div class="service-foot">
                <span class="service-meta">{svc.meta}</span>
                <span class="service-status" class:ok={isComplete(svc.stats)}>
                  {#if svc.stats && svc.stats.total > 0}
                    {#if isComplete(svc.stats)}All done
                    {:else if svc.stats.done === 0}Not started
                    {:else}In progress{/if}
                  {:else if svc.stats}
                    No kits
                  {:else}
                    Loading
                  {/if}
                </span>
              </div>
            </button>
          {/each}
        </section>

        <footer class="foot">KIEMS · v0.1</footer>
      </div>
    </div>
  </div>
</PageTransition>

<style>
  /* ═══════════════════════════════════════════════════════════
     TOKENS — same as Movement plan
     ═══════════════════════════════════════════════════════════ */
  .home {
    --g-950: #06271d;
    --g-800: #075b42;
    --g-700: #087451;
    --g-600: #0b9a68;
    --g-500: #18b77d;
    --g-100: #dcf3e7;
    --g-50: #effcf6;

    --b-700: #174b86;
    --b-600: #1e5fa8;
    --b-500: #3d84d6;
    --b-100: #e2edfa;

    --ink: #0e2a21;
    --ink-2: #466158;
    --ink-3: #84978f;
    --line: #e3ebe7;
    --paper: #f4f7f6;

    --amber-soft: #fff1cf;
    --amber-ink: #8f5a00;

    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    /* App shell: exactly one screen */
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
     HERO
     ═══════════════════════════════════════════════════════════ */
  .hero {
    position: relative;
    flex: none;
    padding: calc(14px + env(safe-area-inset-top)) 16px 44px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(67, 231, 166, 0.36), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(0, 150, 104, 0.28), transparent 55%),
      linear-gradient(150deg, #06271d 0%, #075b42 58%, #087451 100%);
    animation: fade 0.5s var(--ease) both;
  }

  .hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 26px;
  }

  .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .avatar {
    width: 38px; height: 38px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: #fff; color: var(--g-950);
    font-size: 15px; font-weight: 750;
    flex-shrink: 0;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.18);
  }
  .who-text { min-width: 0; }
  .who-name {
    font-size: 14px; font-weight: 700; letter-spacing: -0.02em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .who-sub {
    margin-top: 1px;
    font-size: 11.5px; color: rgba(255, 255, 255, 0.68);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .hero-badges { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .sync-wrap {
    display: inline-flex; align-items: center;
    padding: 2px 5px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.94);
  }
  .device {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px 6px 8px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.16);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px; font-weight: 500; letter-spacing: 0.03em;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255, 255, 255, 0.4); }
  .dot.on { background: #6ee7b0; box-shadow: 0 0 0 3px rgba(110, 231, 176, 0.25); }
  .dot.warn { background: #f5b942; box-shadow: 0 0 0 3px rgba(245, 185, 66, 0.25); }

  .greet {
    margin: 0 0 6px;
    font-size: clamp(32px, 9.5vw, 40px);
    font-weight: 700; letter-spacing: -0.055em; line-height: 1;
  }
  .date { margin: 0 0 20px; font-size: 14px; color: rgba(255, 255, 255, 0.7); }

  /* ── Next up card ───────────────────────────────────────── */
  .next {
    width: 100%;
    display: flex; align-items: center; gap: 12px;
    padding: 13px 12px 13px 15px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 19px;
    background: rgba(255, 255, 255, 0.1);
    color: #fff; font: inherit; text-align: left;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  button.next { cursor: pointer; transition: transform 0.16s var(--ease), background 0.2s var(--ease); }
  button.next:active { transform: scale(0.985); background: rgba(255, 255, 255, 0.15); }
  button.next:focus-visible { outline: 2px solid #7bf0bd; outline-offset: 2px; }

  .next-body { flex: 1; min-width: 0; }
  .next-label { font-size: 11px; font-weight: 600; letter-spacing: 0.01em; color: rgba(255, 255, 255, 0.64); margin-bottom: 2px; }
  .next-text { font-size: 15.5px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 9px; }
  .next-text.tight { margin-bottom: 2px; }
  .next-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.16); overflow: hidden; }
  .next-bar span {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, #72f1ba, #c2ffe0);
    transition: width 0.5s var(--ease);
  }
  .next.blue .next-bar span { background: linear-gradient(90deg, #7db8ff, #cfe4ff); }
  .next-action {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 10px 11px 10px 15px; border-radius: 999px;
    background: #fff; color: var(--g-950);
    font-size: 13px; font-weight: 750; flex-shrink: 0;
  }
  .next.blue .next-action { color: var(--b-700); }

  .next.done .next-label { margin: 0; }
  .done-tick {
    width: 32px; height: 32px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: #7bf0bd; color: var(--g-950); flex-shrink: 0;
  }
  .next.warnbox { background: rgba(245, 185, 66, 0.18); border-color: rgba(245, 185, 66, 0.36); }

  /* ═══════════════════════════════════════════════════════════
     SHEET
     ═══════════════════════════════════════════════════════════ */
  .sheet {
    position: relative;
    flex: 1; min-height: 0;
    margin-top: -26px;
    display: flex; flex-direction: column;
    background: var(--paper);
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    animation: sheet-up 0.6s var(--ease) both;
  }
  .sheet-body {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 20px 14px calc(16px + env(safe-area-inset-bottom));
  }

  .section-head { padding: 0 4px; margin-bottom: 12px; }
  .section-title { margin: 0; font-size: 17px; font-weight: 750; letter-spacing: -0.035em; }

  /* ── Service tiles ──────────────────────────────────────── */
  .services { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

  .service {
    display: flex; flex-direction: column; gap: 14px;
    width: 100%;
    padding: 14px 14px 13px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: #fff;
    color: var(--ink); font: inherit; text-align: left;
    cursor: pointer;
    box-shadow: 0 1px 0 var(--line), 0 14px 28px -22px rgba(7, 43, 31, 0.35);
    transition: transform 0.18s var(--ease);
    opacity: 0;
    animation: rise 0.55s var(--ease) forwards;
    animation-delay: calc(0.2s + var(--i) * 0.08s);
  }
  .service:active { transform: scale(0.97); }
  .service:focus-visible { outline: 2px solid var(--g-600); outline-offset: 3px; }

  .service-top { display: flex; align-items: flex-start; justify-content: space-between; }

  .service-icon {
    width: 44px; height: 44px; border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
  }
  .service.green .service-icon { background: var(--g-100); color: var(--g-800); }
  .service.blue .service-icon { background: var(--b-100); color: var(--b-700); }

  /* ring */
  .ring { position: relative; width: 44px; height: 44px; flex-shrink: 0; }
  .ring svg { transform: rotate(-90deg); display: block; }
  .ring-track { stroke: #e9efec; }
  .ring-fill { transition: stroke-dasharray 0.8s var(--ease) 0.3s; }
  .service.green .ring-fill { stroke: var(--g-600); }
  .service.blue .ring-fill { stroke: var(--b-600); }
  .ring-text {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 10.5px; font-weight: 750; letter-spacing: -0.02em; color: var(--ink);
  }
  .service.green .ring-text svg { color: var(--g-600); transform: none; }
  .service.blue .ring-text svg { color: var(--b-600); transform: none; }

  .service-title { margin: 0; font-size: 16.5px; font-weight: 750; letter-spacing: -0.035em; line-height: 1.1; }
  .service-sub { margin: 4px 0 0; font-size: 12px; font-weight: 500; line-height: 1.35; color: var(--ink-3); }

  .service-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: auto; padding-top: 11px;
    border-top: 1px solid var(--line);
  }
  .service-meta {
    padding: 4px 9px; border-radius: 999px;
    font-size: 10.5px; font-weight: 750;
  }
  .service.green .service-meta { background: var(--g-100); color: var(--g-800); }
  .service.blue .service-meta { background: var(--b-100); color: var(--b-700); }
  .service-status { font-size: 11px; font-weight: 650; color: var(--ink-3); }
  .service-status.ok { color: var(--g-700); }

  .foot {
    margin-top: auto; padding-top: 22px;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px; letter-spacing: 0.05em; color: var(--ink-3); opacity: 0.75;
  }

  /* ═══════════════════════════════════════════════════════════
     MOTION
     ═══════════════════════════════════════════════════════════ */
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes sheet-up { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  @media (prefers-reduced-motion: reduce) {
    .hero, .sheet { animation: none; }
    .service { animation: none; opacity: 1; }
    .service, .ring-fill, .next-bar span { transition: none; }
  }

  @media (max-width: 360px) {
    .service { padding: 12px; gap: 12px; border-radius: 20px; }
    .service-icon { width: 38px; height: 38px; border-radius: 12px; }
    .service-title { font-size: 15px; }
    .hero { padding-left: 13px; padding-right: 13px; }
  }
</style>