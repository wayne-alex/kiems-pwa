<script>
  import { createEventDispatcher } from 'svelte';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import { sanitizeHtml } from './sanitizeHtml.js';
  import { markRead } from './readState.js';

  const dispatch = createEventDispatcher();

  export let announcementId = null;

  const CACHE_KEY_PREFIX = 'announcements:detail:';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  let phase = 'idle'; // idle | loading | error | ready
  let errorMsg = '';
  let article = null;
  let bodyHtml = '';
  let scroller;
  let progress = 0;
  let solid = false;
  let readSentFor = null;

  $: readMins = bodyHtml
    ? Math.max(
        1,
        Math.round(bodyHtml.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length / 200),
      )
    : 0;

  // ── Load ──────────────────────────────────────────────────
  async function load() {
    if (!announcementId) return;
    phase = 'loading';
    errorMsg = '';

    const cacheKey = CACHE_KEY_PREFIX + announcementId;
    try {
      const row = await Cache.get(cacheKey);
      if (row?.value) {
        applyArticle(row.value);
        phase = 'ready';
      }
    } catch { /* ignore */ }

    try {
      const res = await apiFetch(`/api/announcements/${announcementId}/`);
      if (res.ok) {
        applyArticle(res);
        phase = 'ready';
        try { await Cache.set(cacheKey, res); } catch { /* ignore */ }
      } else if (phase !== 'ready') {
        phase = 'error';
        errorMsg = res.error || 'Could not load this article.';
      }
    } catch (err) {
      if (phase !== 'ready') {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and this article isn't saved on this device yet."
            : err.message || 'Network error.';
      }
    }
  }

  function applyArticle(a) {
    article = a;
    bodyHtml = sanitizeHtml(a.body_html || '');
    markSeen();
  }

  // Mark as read as soon as it is on screen (works offline too)
  function markSeen() {
    if (readSentFor === announcementId) return;
    readSentFor = announcementId;
    try { markRead(announcementId); } catch { /* ignore */ }
    dispatch('read', { id: announcementId });
  }

  $: if (announcementId) load();

  // ── Scroll ────────────────────────────────────────────────
  function onScroll() {
    if (!scroller) return;
    const y = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    progress = max > 0 ? Math.min(100, (y / max) * 100) : 0;
    solid = y > 150;
  }

  // ── Actions ───────────────────────────────────────────────
  function onBack() {
    dispatch('back');
  }

  function openExternal() {
    if (!article?.external_url) return;
    window.open(article.external_url, '_blank', 'noopener,noreferrer');
  }

  async function share() {
    if (!article?.external_url) return;
    try {
      await navigator.share({ title: article.title, text: article.title, url: article.external_url });
    } catch { /* user cancelled */ }
  }

  // Links inside the article open in a new tab instead of replacing the app
  function onProseClick(e) {
    const a = e.target?.closest?.('a');
    if (!a || !a.href) return;
    if (/^(mailto:|tel:)/i.test(a.href)) return;
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener,noreferrer');
  }

  // ── Format ────────────────────────────────────────────────
  function fmtDate(v) {
    if (!v) return '';
    const s = String(v).slice(0, 10);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : null;
    if (!d || isNaN(d)) return String(v);
    return d.toLocaleDateString('en-KE', {
      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
</script>

<div class="rd">
  <div class="progress" style="width: {progress}%"></div>

  <!-- Floating bar: transparent over the image, solid after you scroll -->
  <div class="bar" class:solid>
    <button class="round" on:click={onBack} aria-label="Back">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 6L9 12L15 18" />
      </svg>
    </button>

    <div class="bar-title" class:show={solid}>
      {#if article}
        <span class="src small" class:ict={!article.is_iebc}>{article.is_iebc ? 'IEBC' : 'ICT'}</span>
        <span class="bar-text">{article.title}</span>
      {/if}
    </div>

    {#if canShare && article?.external_url}
      <button class="round" on:click={share} aria-label="Share">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
             stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 15V3" /><path d="M7.5 7.5L12 3L16.5 7.5" />
          <path d="M5 12V19A2 2 0 0 0 7 21H17A2 2 0 0 0 19 19V12" />
        </svg>
      </button>
    {/if}
  </div>

  <div class="scroll" bind:this={scroller} on:scroll={onScroll}>
    {#if phase === 'error'}
      <div class="state">
        <div class="state-ic">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
          </svg>
        </div>
        <h3>Couldn't open article</h3>
        <p>{errorMsg}</p>
        <button class="btn" on:click={load}>Try again</button>
      </div>

    {:else if article}
      {#if article.image_url}
        <div class="hero-image">
          <img class="hero-bg" src={article.image_url} alt="" aria-hidden="true" />
          <img class="hero-fg" src={article.image_url} alt="" />
        </div>
      {/if}

      <article class="body" class:with-hero={!!article.image_url}>
        <div class="meta">
          <span class="src" class:ict={!article.is_iebc}>{article.is_iebc ? 'IEBC' : 'ICT'}</span>
          <span class="date">{fmtDate(article.published_at)}</span>
          {#if readMins}<span class="sep">·</span><span class="date">{readMins} min read</span>{/if}
        </div>

        <h1 class="headline">{article.title}</h1>

        {#if article.body_excerpt && !bodyHtml}
          <p class="lede">{article.body_excerpt}</p>
        {/if}

        {#if bodyHtml}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <div class="prose" on:click={onProseClick} role="presentation">
            {@html bodyHtml}
          </div>
        {:else}
          <div class="no-body">
            <p>This announcement isn't available in full in the app.</p>
            {#if article.external_url}
              <button class="btn-primary" on:click={openExternal}>
                Read on IEBC website
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 3H21V10" /><path d="M21 3L11 13" />
                  <path d="M20 14V19A2 2 0 0 1 18 21H5A2 2 0 0 1 3 19V6A2 2 0 0 1 5 4H10" />
                </svg>
              </button>
            {/if}
          </div>
        {/if}

        {#if article.external_url && bodyHtml}
          <button class="source" on:click={openExternal}>
            <span class="source-ic">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 3H21V10" /><path d="M21 3L11 13" />
                <path d="M20 14V19A2 2 0 0 1 18 21H5A2 2 0 0 1 3 19V6A2 2 0 0 1 5 4H10" />
              </svg>
            </span>
            <span class="source-text">
              <b>Read the original</b>
              {#if hostOf(article.external_url)}<small>{hostOf(article.external_url)}</small>{/if}
            </span>
          </button>
        {/if}

        <button class="back-link" on:click={onBack}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
          Back to announcements
        </button>
      </article>

    {:else}
      <div class="loading-skel">
        <div class="sk sk-hero"></div>
        <div class="sk sk-meta"></div>
        <div class="sk sk-h1"></div>
        <div class="sk sk-h1 short"></div>
        <div class="sk sk-p"></div>
        <div class="sk sk-p"></div>
        <div class="sk sk-p"></div>
        <div class="sk sk-p short"></div>
      </div>
    {/if}
  </div>
</div>

<style>
  .rd {
    --ink: #0e1f3f;
    --ink-2: #3b4a63;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --teal: #0e9aa7;
    --teal-d: #0b7a85;
    --teal-l: #def6f8;
    --amber: #b36a00;
    --amber-l: #fff2dc;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    position: relative;
    height: 100vh;
    height: 100dvh;
    background: #fff;
    color: var(--ink);
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  }

  .progress {
    position: absolute;
    top: 0;
    left: 0;
    height: 3px;
    z-index: 10;
    background: linear-gradient(90deg, var(--teal), #35d0c4);
    transition: width 0.1s linear;
  }

  /* ── Floating bar ───────────────────────────────────── */
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
    border-bottom: 1px solid transparent;
    transition: background 0.2s var(--ease), border-color 0.2s var(--ease);
  }
  .bar.solid {
    background: rgba(255, 255, 255, 0.92);
    -webkit-backdrop-filter: saturate(140%) blur(14px);
    backdrop-filter: saturate(140%) blur(14px);
    border-bottom-color: var(--line);
  }
  .round {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid rgba(14, 31, 63, 0.08);
    background: rgba(255, 255, 255, 0.92);
    color: var(--ink);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 6px 16px -8px rgba(14, 31, 63, 0.4);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    transition: transform 0.15s var(--ease);
  }
  .round:active { transform: scale(0.92); }

  .bar-title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
  }
  .bar-title.show { opacity: 1; transform: none; }
  .bar-text {
    font-size: 13.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scroll {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding-bottom: calc(40px + env(safe-area-inset-bottom));
  }

  /* ── Hero image ─────────────────────────────────────── */
  .hero-image {
    position: relative;
    width: 100%;
    height: 280px;
    overflow: hidden;
    background: #0a3a42;
  }
  .hero-bg {
    position: absolute;
    inset: -20px;
    width: calc(100% + 40px);
    height: calc(100% + 40px);
    object-fit: cover;
    filter: blur(24px) brightness(0.6);
    transform: scale(1.1);
  }
  .hero-fg {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
  }

  /* ── Article ────────────────────────────────────────── */
  .body {
    position: relative;
    max-width: 680px;
    margin: 0 auto;
    padding: calc(76px + env(safe-area-inset-top)) 22px 0;
  }
  .body.with-hero {
    margin-top: -26px;
    padding-top: 24px;
    background: #fff;
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -14px 30px -18px rgba(0, 0, 0, 0.4);
    z-index: 2;
  }

  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }
  .src {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 6px;
    background: var(--teal-l);
    color: var(--teal-d);
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .src.ict { background: var(--amber-l); color: var(--amber); }
  .src.small { padding: 2px 7px; font-size: 9.5px; flex-shrink: 0; }
  .date { font-size: 12.5px; color: var(--ink-3); font-weight: 600; }
  .sep { color: #c0c8d6; }

  .headline {
    margin: 0 0 22px;
    font-size: clamp(25px, 6.6vw, 31px);
    font-weight: 800;
    letter-spacing: -0.035em;
    line-height: 1.15;
    color: var(--ink);
    text-wrap: balance;
    -webkit-user-select: text;
    user-select: text;
  }

  .lede {
    margin: 0 0 22px;
    padding: 4px 0 4px 14px;
    border-left: 3px solid var(--teal);
    font-size: 17px;
    line-height: 1.55;
    color: var(--ink-2);
    -webkit-user-select: text;
    user-select: text;
  }

  /* ── Prose ──────────────────────────────────────────── */
  .prose {
    font-size: 16.5px;
    line-height: 1.72;
    color: var(--ink-2);
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
    -webkit-touch-callout: default;
  }
  .prose :global(p) { margin: 0 0 1.1em; }

  .prose :global(h2),
  .prose :global(h3),
  .prose :global(h4) {
    margin: 1.7em 0 0.55em;
    color: var(--ink);
    font-weight: 780;
    letter-spacing: -0.025em;
    line-height: 1.25;
  }
  .prose :global(h2) { font-size: 22px; }
  .prose :global(h3) { font-size: 19px; }
  .prose :global(h4) { font-size: 16.5px; }

  .prose :global(strong) { color: var(--ink); font-weight: 750; }

  .prose :global(blockquote) {
    margin: 1.5em 0;
    padding: 14px 16px;
    border-left: 3px solid var(--teal);
    border-radius: 0 14px 14px 0;
    background: #f3fbfc;
    color: var(--ink);
    font-size: 17px;
    line-height: 1.55;
  }
  .prose :global(blockquote p:last-child) { margin-bottom: 0; }

  .prose :global(ul),
  .prose :global(ol) { padding-left: 1.3em; margin: 1em 0 1.2em; }
  .prose :global(li) { margin-bottom: 0.45em; }
  .prose :global(li::marker) { color: var(--teal); font-weight: 700; }

  .prose :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1.5em auto;
    border-radius: 14px;
    box-shadow: 0 12px 26px -16px rgba(14, 31, 63, 0.4);
  }
  .prose :global(figure) { margin: 1.5em 0; }
  .prose :global(figcaption) {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--ink-3);
    text-align: center;
  }

  .prose :global(a) {
    color: var(--teal-d);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: rgba(14, 154, 167, 0.4);
    text-underline-offset: 3px;
  }

  .prose :global(hr) { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }

  .prose :global(table) {
    display: block;
    width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 1.5em 0;
    font-size: 14px;
  }
  .prose :global(th),
  .prose :global(td) {
    padding: 9px 11px;
    border-bottom: 1px solid var(--line);
    text-align: left;
  }
  .prose :global(th) { background: #f6f8fb; color: var(--ink); font-weight: 750; }

  .prose :global(pre),
  .prose :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
  }
  .prose :global(pre) {
    padding: 12px;
    border-radius: 12px;
    background: #0e1f3f;
    color: #cfe9de;
    overflow-x: auto;
  }

  /* ── Footer actions ─────────────────────────────────── */
  .no-body {
    margin: 8px 0 0;
    padding: 22px 18px;
    border-radius: 20px;
    background: #f6f8fb;
    text-align: center;
    color: var(--ink-2);
    font-size: 14px;
    line-height: 1.5;
  }
  .no-body p { margin: 0; }
  .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    padding: 13px 20px;
    border: 0;
    border-radius: 14px;
    background: linear-gradient(135deg, var(--teal-d), var(--teal));
    color: #fff;
    font: inherit;
    font-size: 13.5px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 12px 22px -12px rgba(11, 122, 133, 0.7);
  }

  .source {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 32px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: #fff;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04);
  }
  .source:active { background: #f6f8fb; }
  .source-ic {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--teal-l);
    color: var(--teal-d);
  }
  .source-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .source-text b { font-size: 14px; font-weight: 750; letter-spacing: -0.02em; }
  .source-text small { font-size: 12px; color: var(--ink-3); }

  .back-link {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 14px;
    padding: 14px;
    border: 0;
    border-radius: 16px;
    background: #f6f8fb;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .back-link:active { background: #edf0f5; }

  /* ── States ─────────────────────────────────────────── */
  .state { padding: calc(120px + env(safe-area-inset-top)) 24px 60px; text-align: center; color: var(--ink-2); }
  .state-ic {
    width: 60px;
    height: 60px;
    margin: 0 auto 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffe8e8;
    color: #e23b3b;
  }
  .state h3 { margin: 0 0 6px; font-size: 18px; font-weight: 780; letter-spacing: -0.03em; color: var(--ink); }
  .state p { margin: 0 0 18px; font-size: 13.5px; line-height: 1.5; }
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

  /* ── Skeleton ───────────────────────────────────────── */
  .loading-skel { padding: 0 22px; }
  .sk {
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 6px;
    margin-bottom: 14px;
  }
  .sk-hero { height: 280px; margin: 0 -22px 22px; border-radius: 0; }
  .sk-meta { width: 150px; height: 18px; }
  .sk-h1 { height: 30px; width: 92%; }
  .sk-h1.short { width: 62%; }
  .sk-p { height: 16px; margin-bottom: 10px; }
  .sk-p.short { width: 70%; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  @media (prefers-reduced-motion: reduce) {
    .progress, .bar, .bar-title, .round { transition: none; }
    .sk { animation: none; }
  }
</style>