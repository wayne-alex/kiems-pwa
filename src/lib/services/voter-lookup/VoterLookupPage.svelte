<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';

  const dispatch = createEventDispatcher();

  const PORTAL_URL = 'https://verify.iebc.or.ke/';
  const PORTAL_HOST = 'verify.iebc.or.ke';

  const STEPS = [
    { title: 'Open the portal', text: 'Tap the button below. It opens in your browser.' },
    { title: 'Enter the voter’s details', text: 'Type their ID number and year of birth.' },
    { title: 'Solve the captcha', text: 'Then tap Submit to see the result.' },
    { title: 'Come back here', text: 'Switch back to the app when you are done.' },
  ];

  let online = typeof navigator === 'undefined' ? true : navigator.onLine;

  let toast = '';
  let toastTimer;
  function flash(msg, ms = 2200) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), ms);
  }
  onDestroy(() => clearTimeout(toastTimer));

  const tick = (ms = 8) => {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  };

  // The button is a real link, so the browser opens it. We only add a buzz,
  // and stop the tap when there is no internet.
  function onOpen(e) {
    if (!online) {
      e.preventDefault();
      flash("You're offline. Connect to the internet first.");
      return;
    }
    tick();
  }

  async function copyLink() {
    tick(6);
    try {
      await navigator.clipboard.writeText(PORTAL_URL);
      flash('Link copied');
    } catch {
      flash("Couldn't copy. Open the portal and copy it from there.");
    }
  }
</script>

<svelte:window on:online={() => (online = true)} on:offline={() => (online = false)} />

<PageTransition>
  <div class="vp">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Voter lookup</div>
          <div class="hero-sub">Check a voter on the IEBC portal</div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>
    </header>

    <div class="sheet">
      <div class="scroll">
        {#if !online}
          <div class="offline" role="status">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3L21 21" /><path d="M8.5 16.5A5 5 0 0 1 15 12" />
              <path d="M5 12A10 10 0 0 1 9 7" /><path d="M12 19.5V19.6" />
            </svg>
            You're offline. Connect to the internet to check a voter.
          </div>
        {/if}

        <section class="card intro">
          <div class="intro-icon">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
                 stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" />
            </svg>
          </div>
          <h2>Check a voter</h2>
          <p>
            IEBC does the checking. You type the voter's ID number and year of birth
            on the official portal.
          </p>

          <a
            class="cta"
            class:off={!online}
            href={PORTAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            on:click={onOpen}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 3H21V10" /><path d="M21 3L11 13" />
              <path d="M20 14V19A2 2 0 0 1 18 21H5A2 2 0 0 1 3 19V6A2 2 0 0 1 5 4H10" />
            </svg>
            Open IEBC portal
          </a>

          <div class="host">{PORTAL_HOST}</div>

          <button class="copy" on:click={copyLink}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V5A2 2 0 0 1 7 3H15" />
            </svg>
            Copy link
          </button>
        </section>

        <section class="card steps">
          <div class="label">How it works</div>
          <ol>
            {#each STEPS as s}
              <li>
                <div class="s-title">{s.title}</div>
                <div class="s-text">{s.text}</div>
              </li>
            {/each}
          </ol>
        </section>

        <div class="privacy">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z" />
            <path d="M8.5 12L11 14.5L15.5 9.5" />
          </svg>
          <span>The voter's details are typed on the IEBC website only. Nothing is saved in this app.</span>
        </div>
      </div>
    </div>

    {#if toast}
      <div class="toast" role="status" transition:fly={{ y: 10, duration: 200, easing: cubicOut }}>
        {toast}
      </div>
    {/if}
  </div>
</PageTransition>

<style>
  .vp {
    --bg: #f6f8fb;
    --card: #fff;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --acc: #6a4cd8;
    --acc-d: #4f36b5;
    --acc-l: #eeeaff;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #17103a;
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
      radial-gradient(110% 120% at 100% -10%, rgba(160, 133, 255, 0.36), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(107, 76, 216, 0.3), transparent 55%),
      linear-gradient(150deg, #120b30 0%, #2f2170 58%, #4a35a8 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-title { font-size: clamp(21px, 6vw, 26px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.05; }
  .hero-sub { margin-top: 4px; font-size: 12px; font-weight: 600; color: rgba(255, 255, 255, 0.72); }
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
    padding: 20px 14px calc(24px + env(safe-area-inset-bottom));
  }

  .offline {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 14px;
    padding: 11px 13px;
    border-radius: 16px;
    background: #fff2dc;
    color: #8f5a00;
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.4;
  }
  .offline svg { flex-shrink: 0; }

  .card {
    margin-bottom: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 30px -18px rgba(14, 31, 63, 0.2);
  }

  /* ── Intro + button ─────────────────────────────────── */
  .intro { padding: 26px 20px 20px; text-align: center; }
  .intro-icon {
    width: 66px;
    height: 66px;
    margin: 0 auto 16px;
    border-radius: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, #e9e2ff, #d6cbff);
    color: var(--acc);
    box-shadow: 0 14px 26px -16px rgba(106, 76, 216, 0.6);
  }
  .intro h2 { margin: 0 0 8px; font-size: 21px; font-weight: 800; letter-spacing: -0.04em; }
  .intro p { margin: 0 auto 22px; max-width: 320px; font-size: 13.5px; line-height: 1.55; color: var(--ink-2); }

  .cta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 16px 18px;
    border-radius: 18px;
    background: linear-gradient(135deg, var(--acc-d), var(--acc));
    color: #fff;
    font-size: 15.5px;
    font-weight: 760;
    letter-spacing: -0.01em;
    text-decoration: none;
    box-shadow: 0 14px 26px -14px rgba(79, 54, 181, 0.8);
    transition: transform 0.16s var(--ease);
  }
  .cta:active { transform: scale(0.985); }
  .cta.off { background: #cbd2de; box-shadow: none; }

  .host {
    margin-top: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  .copy {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 14px;
    padding: 10px 16px;
    border: 0;
    border-radius: 999px;
    background: #f1f4f8;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.14s var(--ease), background 0.16s var(--ease);
  }
  .copy:active { transform: scale(0.96); background: #e6ebf2; }

  /* ── Steps ──────────────────────────────────────────── */
  .steps { padding: 18px 18px 8px; }
  .label {
    margin-bottom: 14px;
    font-size: 11px;
    font-weight: 780;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .steps ol { list-style: none; counter-reset: step; margin: 0; padding: 0; }
  .steps li {
    counter-increment: step;
    position: relative;
    padding: 0 0 18px 42px;
  }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--acc-l);
    color: var(--acc-d);
    font-size: 13px;
    font-weight: 800;
  }
  /* line between steps */
  .steps li:not(:last-child)::after {
    content: '';
    position: absolute;
    left: 13px;
    top: 32px;
    bottom: 4px;
    width: 2px;
    border-radius: 2px;
    background: var(--line);
  }
  .s-title { font-size: 14.5px; font-weight: 740; letter-spacing: -0.02em; line-height: 1.3; padding-top: 3px; }
  .s-text { margin-top: 3px; font-size: 13px; line-height: 1.5; color: var(--ink-2); }

  /* ── Privacy note ───────────────────────────────────── */
  .privacy {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 4px 8px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink-3);
  }
  .privacy svg { flex-shrink: 0; margin-top: 1px; color: #0a9d6e; }

  /* ── Toast ──────────────────────────────────────────── */
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
    text-align: center;
    box-shadow: 0 14px 28px -10px rgba(0, 0, 0, 0.45);
  }

  @media (prefers-reduced-motion: reduce) {
    .cta, .copy { transition: none; }
  }
</style>