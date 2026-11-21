<script>
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";

  import HomePage from "./routes/HomePage.svelte";
  import EntryPage from "./routes/EntryPage.svelte";
  import MovementPage from "./routes/MovementPage.svelte";
  import FormAManagementPage from "./routes/FormAManagementPage.svelte";
  import VoterLookupPage from "./routes/VoterLookupPage.svelte";
  import ReportsPage from "./routes/ReportsPage.svelte";
  import AnnouncementsPage from "./routes/AnnouncementsPage.svelte";
  import IncidentsPage from "./routes/IncidentsPage.svelte";
  import TrainingPage from "./routes/TrainingPage.svelte";
  import HelpPage from "./routes/HelpPage.svelte";
  import StationsPage from "./routes/StationsPage.svelte";

  import ProfileSheet from "./components/ProfileSheet.svelte";
  import SystemSheet from "./lib/SystemSheet.svelte";
  import {
    profileSheetOpen,
    systemSheetOpen,
    closeProfile,
    closeSystem,
  } from "./lib/core/ui.js";

  import BindModal from "./components/BindModal.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";

  import { session, restoreSession, resolveSession } from "./lib/session.js";
  import { migrateLegacyStorage } from "./lib/core/migrate.js";
  import { initSync } from "./lib/core/sync.js";
  import { registerSW, registerPeriodicDrain } from "./lib/core/sw-register.js";
  import { apiFetch } from "./lib/api.js";
  import { captureCardRect } from "./lib/transition.js";

  // ───────────────────────────────────────────────────────────
  // ROUTING
  // ───────────────────────────────────────────────────────────
  const ROUTES = [
    "home",
    "entry",
    "movement",
    "form-a",
    "voter-lookup",
    "reports",
    "announcements",
    "incidents",
    "training",
    "help",
    "stations",
  ];

  const PATH_TO_ROUTE = {
    "/": "home",
    "/entry": "entry",
    "/movement": "movement",
    "/form-a": "form-a",
    "/voter-lookup": "voter-lookup",
    "/reports": "reports",
    "/announcements": "announcements",
    "/incidents": "incidents",
    "/training": "training",
    "/help": "help",
    "/stations": "stations",
  };

  const ROUTE_ACCENT = {
    entry: "green",
    movement: "blue",
    "form-a": "amber",
    "voter-lookup": "purple",
    reports: "amber",
    announcements: "teal",
    incidents: "red",
    training: "slate",
    help: "slate",
    stations: "pink",
  };

  let route = "home";
  let booted = false;

  $: unbound = $session.status === "unbound";

  function backToHome(fromRoute) {
    const card = document.querySelector(`[data-card="${fromRoute}"]`);
    if (card) {
      captureCardRect(card, ROUTE_ACCENT[fromRoute] || "green");
    }
    route = "home";
    syncUrl("home", false);
  }

  function goRoute(next) {
    if (!ROUTES.includes(next)) return;
    route = next;
    syncUrl(next, true);
  }

  /** Keep the URL in sync so the OS back button + notification deep links work. */
  function syncUrl(r, push = true) {
    const path = r === "home" ? "/" : `/${r}`;
    if (push) history.pushState({ route: r }, "", path);
    else history.replaceState({ route: r }, "", path);
  }

  function routeFromLocation() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    return PATH_TO_ROUTE[path] || "home";
  }

  function onPopState() {
    route = routeFromLocation();
  }

  // ───────────────────────────────────────────────────────────
  // BOOT
  // ───────────────────────────────────────────────────────────
  onMount(() => {
    let cancelled = false;

    (async () => {
      // 1. Register the service worker FIRST so background sync is armed
      //    even if the rest of boot is slow.
      await registerSW();
      registerPeriodicDrain().catch(() => {});

      // 2. One-shot migration: legacy localStorage → IndexedDB.
      //    Safe to call repeatedly; guarded by a flag in Meta.
      await migrateLegacyStorage();

      // 3. Restore session from IDB cache (synchronous paint, no network).
      const restored = await restoreSession();

      // 4. Start the sync engine (leader election, drain loop, listeners).
      initSync();

      // 5. Seed CSRF + background session refresh against the server.
      (async () => {
        apiFetch("/api/csrf/").catch((err) => {
          console.warn("[boot] CSRF seed failed:", err);
        });
        await resolveSession({ silent: restored });
      })();

      if (cancelled) return;

      // 6. Wire the browser back button to our routes.
      window.addEventListener("popstate", onPopState);
      // Seed the URL to match current route without pushing a new entry.
      syncUrl(route, false);

      // 7. Notification clicks deep-link into the app via SW → page message.
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (evt) => {
          const m = evt.data || {};
          if (m.type === "NAVIGATE" && typeof m.url === "string") {
            const clean = m.url.replace(/\/+$/, "") || "/";
            const target = PATH_TO_ROUTE[clean] || "home";
            goRoute(target);
          }
        });
      }

      booted = true;
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPopState);
    };
  });
</script>

<div class="app-shell">
  <UpdateBanner />

  {#if !booted}
    <!-- First-frame skeleton: prevents a white flash while the SW + IDB
         migration settle. Kept minimal — the hero paint on Home will
         replace it in ~50-150ms on subsequent boots. -->
    <div class="boot">
      <div class="boot-mark"></div>
    </div>
  {:else}
    {#key route}
      <div in:fade={{ duration: 160 }}>
        {#if route === "home"}
          <HomePage on:navigate={(e) => goRoute(e.detail)} />
        {:else if route === "entry"}
          <EntryPage on:back={() => backToHome("entry")} />
        {:else if route === "movement"}
          <MovementPage on:back={() => backToHome("movement")} />
        {:else if route === "form-a"}
          <FormAManagementPage on:back={() => backToHome("form-a")} />
        {:else if route === "voter-lookup"}
          <VoterLookupPage on:back={() => backToHome("voter-lookup")} />
        {:else if route === "reports"}
          <ReportsPage
            on:back={() => backToHome("reports")}
            on:navigate={(e) => goRoute(e.detail)}
          />
        {:else if route === "announcements"}
          <AnnouncementsPage on:back={() => backToHome("announcements")} />
        {:else if route === "incidents"}
          <IncidentsPage on:back={() => backToHome("incidents")} />
        {:else if route === "training"}
          <TrainingPage on:back={() => backToHome("training")} />
        {:else if route === "help"}
          <HelpPage on:back={() => backToHome("help")} />
        {:else if route === "stations"}
          <StationsPage on:back={() => backToHome("stations")} />
        {/if}
      </div>
    {/key}
  {/if}

  {#if unbound}
    <BindModal on:bound={() => resolveSession()} />
  {/if}
  <ProfileSheet bind:open={$profileSheetOpen} onClose={closeProfile} />
  <SystemSheet bind:open={$systemSheetOpen} onClose={closeSystem} />
</div>

<style>
  .app-shell {
    max-width: 440px;
    margin: 0 auto;
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--paper, #f4f7f6);
    position: relative;
  }

  /* Boot skeleton — a soft pulsing dot in the brand color.
     Fades away as soon as routes render. */
  .boot {
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #06271d;
  }
  .boot-mark {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: linear-gradient(135deg, #0b9a68, #18b77d);
    box-shadow: 0 12px 30px rgba(11, 154, 104, 0.35);
    animation: boot-pulse 1.2s ease-in-out infinite;
  }
  @keyframes boot-pulse {
    0%,
    100% {
      transform: scale(0.9);
      opacity: 0.65;
    }
    50% {
      transform: scale(1);
      opacity: 1;
    }
  }

  @media (min-width: 500px) {
    :global(body) {
      background: #ecede9;
      padding: 32px 0;
    }
    .app-shell {
      min-height: calc(100vh - 64px);
      border-radius: 32px;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.05),
        0 30px 80px rgba(0, 0, 0, 0.09),
        0 8px 24px rgba(0, 0, 0, 0.05);
    }
  }
</style>