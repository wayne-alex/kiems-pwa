<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { session } from '../lib/session.js';
  import SyncBadge from '../components/SyncBadge.svelte';

  const dispatch = createEventDispatcher();

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }
  function getTodayLabel() {
    return new Date().toLocaleDateString('en-KE', {
      weekday: 'long', day: 'numeric', month: 'short',
    });
  }

  let greeting = getGreeting();
  let today = getTodayLabel();
  let mounted = false;

  onMount(() => {
    mounted = true;
    const iv = setInterval(() => {
      greeting = getGreeting();
      today = getTodayLabel();
    }, 60_000);
    return () => clearInterval(iv);
  });

  const services = [
    {
      id: 'entry',
      title: 'Registration',
      subtitle: 'Daily voter counts per kit',
      meta: 'Today',
      accent: 'green',
    },
    {
      id: 'movement',
      title: 'Movement plan',
      subtitle: "Tomorrow's venues",
      meta: 'Tomorrow',
      accent: 'blue',
    },
  ];

  function open(id) { dispatch('navigate', id); }
</script>

<div class="page" class:ready={mounted}>

  <!-- ══════════════ HEADER ══════════════ -->
  <header class="head">
    <div class="head-row">
      <div class="brand">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
            <path d="M12 2.5 L4.5 6 V12 C4.5 16.5 8 20.5 12 21.5 C16 20.5 19.5 16.5 19.5 12 V6 Z"
                  fill="#fff" fill-opacity="0.15" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M9 12.2 L11.2 14.4 L15.2 9.6"
                  stroke="#fff" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <span class="brand-text">IEBC Field</span>
      </div>

      <div class="header-actions">
        <SyncBadge />
        <div class="device">
          <span class="dot"
                class:on={$session.status === 'bound'}
                class:err={$session.status === 'unbound'}></span>
          <span class="device-id">
            {#if $session.fingerprint}
              {$session.fingerprint.slice(0, 6).toUpperCase()}
            {:else}
              ···
            {/if}
          </span>
        </div>
      </div>
    </div>

    <h1 class="greet">{greeting}.</h1>
    <p class="date">{today}</p>

    {#if $session.status === 'bound' && $session.ward}
      <div class="identity">
        <span class="identity-label">Signed in as</span>
        <span class="identity-value">{$session.vra?.name || 'VRA'}</span>
        <span class="identity-sep">·</span>
        <span class="identity-ward">{$session.ward.name}</span>
        {#if $session.constituency}
          <span class="identity-sep">·</span>
          <span class="identity-const">{$session.constituency.name}</span>
        {/if}
      </div>
    {/if}
  </header>

  <!-- ══════════════ SERVICES ══════════════ -->
  <section class="services" aria-label="Services">
    {#each services as svc, i (svc.id)}
      <button
        class="svc {svc.accent}"
        style="--i:{i}"
        on:click={() => open(svc.id)}
      >
        <div class="svc-top">
          <span class="svc-icon" aria-hidden="true">
            {#if svc.id === 'entry'}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                   stroke="currentColor" stroke-width="1.9"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 3.5 H15 L19 7.5 V20.5 A1 1 0 0 1 18 21.5 H7 A1 1 0 0 1 6 20.5 V4.5 A1 1 0 0 1 7 3.5 Z"/>
                <path d="M15 3.5 V7.5 H19"/>
                <path d="M9.5 14 L11.5 16 L15 12"/>
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                   stroke="currentColor" stroke-width="1.9"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z"/>
                <circle cx="11.5" cy="9.5" r="2.5"/>
              </svg>
            {/if}
          </span>

          <span class="svc-meta">{svc.meta}</span>

          <span class="svc-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12 H19 M13 6 L19 12 L13 18"/>
            </svg>
          </span>
        </div>

        <div class="svc-body">
          <h2 class="svc-title">{svc.title}</h2>
          <p class="svc-sub">{svc.subtitle}</p>
        </div>

        <div class="svc-accent" aria-hidden="true"></div>
      </button>
    {/each}
  </section>

  <footer class="foot">
    <span>KIEMS · v0.1</span>
  </footer>
</div>

<style>
  .page {
    min-height: 100vh;
    min-height: 100dvh;
    padding: 22px 22px calc(20px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
  }

  /* ═══════════════════════════════════════
     HEADER
     ═══════════════════════════════════════ */
  .head {
    margin-bottom: 32px;
    animation: rise .5s var(--ease) both;
  }
  .head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    gap: 12px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .brand-mark {
    width: 26px; height: 26px;
    border-radius: 8px;
    background: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: var(--shadow-1);
  }
  .brand-text {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--ink);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .device {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px 5px 8px;
    background: var(--surface);
    border-radius: 999px;
    box-shadow: var(--shadow-1);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    color: var(--ink-2);
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--ink-4);
    transition: background .3s var(--ease), box-shadow .3s var(--ease);
  }
  .dot.on {
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34,197,94,.15);
  }
  .dot.err {
    background: var(--warn);
    box-shadow: 0 0 0 3px rgba(154,107,0,.15);
  }
  .device-id { color: var(--ink); }

  .greet {
    font-size: 30px;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.035em;
    color: var(--ink);
    margin-bottom: 6px;
  }
  .date {
    font-size: 13.5px;
    color: var(--ink-3);
    letter-spacing: -0.005em;
    margin: 0;
  }

  .identity {
    margin-top: 16px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    background: var(--surface);
    border-radius: 999px;
    box-shadow: var(--shadow-1);
    font-size: 12px;
    flex-wrap: wrap;
  }
  .identity-label {
    color: var(--ink-3);
    font-weight: 500;
    font-size: 11px;
  }
  .identity-value {
    color: var(--ink);
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .identity-sep {
    color: var(--ink-4);
    font-size: 11px;
  }
  .identity-ward {
    color: var(--accent);
    font-weight: 600;
  }
  .identity-const {
    color: var(--ink-2);
    font-weight: 500;
  }

  /* ═══════════════════════════════════════
     SERVICES
     ═══════════════════════════════════════ */
  .services {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
  }
  .svc {
    position: relative;
    display: block;
    width: 100%;
    text-align: left;
    padding: 20px 20px 22px;
    border: none;
    border-radius: var(--r-xl);
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
    overflow: hidden;
    box-shadow: var(--shadow-1);
    transition:
      transform .35s var(--ease),
      box-shadow .35s var(--ease);
    animation: rise .55s var(--ease) both;
    animation-delay: calc(.08s + var(--i) * .06s);
  }
  .svc:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-2);
  }
  .svc:active {
    transform: scale(.985);
    box-shadow: var(--shadow-1);
  }
  .svc-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 26px;
  }
  .svc-icon {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--ink);
    background: var(--paper-2);
    transition: background .35s var(--ease), color .35s var(--ease);
  }
  .svc:hover .svc-icon {
    background: var(--ink);
    color: #fff;
  }
  .svc-meta {
    margin-left: auto;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
  }
  .svc-arrow {
    width: 26px; height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--paper-2);
    color: var(--ink-2);
    flex-shrink: 0;
    transition: transform .35s var(--ease), background .35s var(--ease), color .35s var(--ease);
  }
  .svc:hover .svc-arrow {
    transform: translateX(2px);
    background: var(--ink);
    color: #fff;
  }
  .svc-body {
    position: relative;
    z-index: 1;
  }
  .svc-title {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.15;
    color: var(--ink);
    margin-bottom: 4px;
  }
  .svc-sub {
    font-size: 13px;
    color: var(--ink-3);
    margin: 0;
    letter-spacing: -0.005em;
  }
  .svc-accent {
    position: absolute;
    inset: auto -40px -60px auto;
    width: 180px;
    height: 180px;
    border-radius: 50%;
    opacity: 0;
    transition: opacity .5s var(--ease);
    pointer-events: none;
  }
  .svc.green .svc-accent {
    background: radial-gradient(closest-side, var(--accent-glow), transparent);
  }
  .svc.blue .svc-accent {
    background: radial-gradient(closest-side, rgba(30,95,168,.18), transparent);
  }
  .svc:hover .svc-accent { opacity: 1; }
  .svc.green .svc-meta { color: var(--accent); }
  .svc.blue  .svc-meta { color: var(--blue); }

  /* ═══════════════════════════════════════
     FOOTER
     ═══════════════════════════════════════ */
  .foot {
    margin-top: auto;
    text-align: center;
    font-size: 10.5px;
    font-family: var(--font-mono);
    color: var(--ink-4);
    letter-spacing: 0.04em;
    padding-top: 20px;
  }
</style>