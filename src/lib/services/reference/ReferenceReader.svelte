<script>
  import { createEventDispatcher, tick, onDestroy } from 'svelte';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import { renderMarkdownWithToc } from './markdown.js';
  import { markDocRead } from './referenceState.js';

  const dispatch = createEventDispatcher();

  export let slug = null;
  export let category = 'training'; // used until the guide itself has loaded
  export let nextDoc = null; // { slug, title } or null

  const CACHE_KEY_PREFIX = 'reference:doc:';

  let phase = 'idle'; // idle | loading | error | ready
  let errorMsg = '';
  let doc = null;
  let bodyHtml = '';
  let toc = [];
  let readMins = 0;
  let scroller;
  let progress = 0;
  let solid = false;

  let readMarked = false;
  let readTimer;
  onDestroy(() => clearTimeout(readTimer));

  $: theme = (doc?.category || category) === 'help' ? 'help' : 'training';

  // ── Load ──────────────────────────────────────────────────
  async function load() {
    if (!slug) return;
    phase = 'loading';
    errorMsg = '';

    const cacheKey = CACHE_KEY_PREFIX + slug;
    try {
      const row = await Cache.get(cacheKey);
      if (row?.value) {
        applyDoc(row.value);
        phase = 'ready';
      }
    } catch { /* ignore */ }

    try {
      const res = await apiFetch(`/api/reference/${slug}/`);
      if (res.ok) {
        applyDoc(res);
        phase = 'ready';
        try { await Cache.set(cacheKey, res); } catch { /* ignore */ }
      } else if (phase !== 'ready') {
        phase = 'error';
        errorMsg = res.error || 'Not found.';
      }
    } catch (err) {
      if (phase !== 'ready') {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and this guide isn't saved on this device yet."
            : err.message || 'Network error.';
      }
    }
  }

  async function applyDoc(d) {
    doc = d;
    const r = renderMarkdownWithToc(d.body_markdown || '');
    bodyHtml = r.html;
    toc = r.toc;
    const words = String(d.body_markdown || '').split(/\s+/).filter(Boolean).length;
    readMins = words ? Math.max(1, Math.round(words / 200)) : 0;
    await tick();
    checkShort();
  }

  $: if (slug) load();

  // ── Read tracking ─────────────────────────────────────────
  // Read = scrolled near the end, or a short guide that fits on one screen
  function checkShort() {
    if (readMarked || !scroller) return;
    if (scroller.scrollHeight - scroller.clientHeight < 80) {
      clearTimeout(readTimer);
      readTimer = setTimeout(markRead, 1500);
    }
  }

  async function markRead() {
    if (readMarked || !slug) return;
    readMarked = true;
    await markDocRead(slug);
    dispatch('read', { slug });
  }

  // ── Scroll + actions ──────────────────────────────────────
  function onScroll() {
    if (!scroller) return;
    const y = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    progress = max > 0 ? Math.min(100, (y / max) * 100) : 0;
    solid = y > 130;
    if (progress >= 85) markRead();
  }

  function jump(id) {
    const el = scroller?.querySelector('#' + CSS.escape(id));
    if (!el) return;
    const top =
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 76;
    scroller.scrollTo({ top, behavior: 'smooth' });
  }

  // #section links jump inside the guide
  function onProseClick(e) {
    const a = e.target?.closest?.('a');
    const href = a?.getAttribute('href');
    if (href && href.startsWith('#')) {
      e.preventDefault();
      jump(href.slice(1));
    }
  }

  const back = () => dispatch('back');
</script>

<div class="rrd {theme}">
  <div class="progress" style="width: {progress}%"></div>

  <div class="bar" class:solid>
    <button class="round" on:click={back} aria-label="Back">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 6L9 12L15 18" />
      </svg>
    </button>
    <div class="bar-title" class:show={solid}>{doc?.title || ''}</div>
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
        <h3>Couldn't open guide</h3>
        <p>{errorMsg}</p>
        <button class="btn" on:click={load}>Try again</button>
      </div>

    {:else if doc}
      <header class="top">
        <div class="eyebrow">
          <span class="badge">{(doc.category || category) === 'help' ? 'Help' : 'Training'}</span>
          {#if readMins}<span class="meta">{readMins} min read</span>{/if}
          {#if doc.updated}<span class="meta">· Updated {doc.updated}</span>{/if}
        </div>
        <h1>{doc.title}</h1>
        {#if doc.summary}<p class="summary">{doc.summary}</p>{/if}
      </header>

      <div class="content">
        {#if toc.length >= 3}
          <nav class="toc" aria-label="On this page">
            <div class="toc-label">On this page</div>
            <div class="toc-chips">
              {#each toc as t (t.id)}
                <button class="chip" on:click={() => jump(t.id)}>{t.text}</button>
              {/each}
            </div>
          </nav>
        {/if}

        {#if bodyHtml}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <article class="prose" on:click={onProseClick} role="presentation">
            {@html bodyHtml}
          </article>
        {:else}
          <p class="empty">This guide has no content yet.</p>
        {/if}

        {#if nextDoc}
          <button class="next" on:click={() => dispatch('next', { slug: nextDoc.slug })}>
            <span class="next-text">
              <small>Next guide</small>
              <b>{nextDoc.title}</b>
            </span>
            <span class="next-arrow">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
              </svg>
            </span>
          </button>
        {/if}

        <button class="back-link" on:click={back}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
          Back to list
        </button>
      </div>

    {:else}
      <div class="loading-skel">
        <div class="sk sk-top"></div>
        <div class="sk sk-p"></div>
        <div class="sk sk-p"></div>
        <div class="sk sk-p short"></div>
      </div>
    {/if}
  </div>
</div>

<style>
  .rrd {
    --ink: #0e1f3f;
    --ink-2: #3b4a63;
    --ink-3: #8c97aa;
    --line: #edf0f5;
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
  .rrd.training {
    --acc: #6a4cd8;
    --acc-d: #4f36b5;
    --acc-l: #eeeaff;
    --g1: #120b30;
    --g2: #2f2170;
    --g3: #4a35a8;
    --glow: rgba(150, 120, 255, 0.4);
  }
  .rrd.help {
    --acc: #2f6fe0;
    --acc-d: #1f55b8;
    --acc-l: #e7f0ff;
    --g1: #081532;
    --g2: #12306b;
    --g3: #1d4a9c;
    --glow: rgba(90, 160, 255, 0.4);
  }

  .progress {
    position: absolute;
    top: 0;
    left: 0;
    height: 3px;
    z-index: 10;
    background: linear-gradient(90deg, var(--acc), #35d0c4);
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
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    transition: transform 0.15s var(--ease), background 0.2s var(--ease), color 0.2s var(--ease);
  }
  .round:active { transform: scale(0.92); }
  .bar.solid .round { background: #f1f4f8; color: var(--ink); border-color: var(--line); }

  .bar-title {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 750;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
  }
  .bar-title.show { opacity: 1; transform: none; }

  .scroll {
    position: relative;
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding-bottom: calc(40px + env(safe-area-inset-bottom));
  }

  /* ── Header ─────────────────────────────────────────── */
  .top {
    padding: calc(76px + env(safe-area-inset-top)) 22px 46px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, var(--glow), transparent 55%),
      linear-gradient(150deg, var(--g1) 0%, var(--g2) 58%, var(--g3) 100%);
  }
  .eyebrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .badge {
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.2);
    font-size: 10.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .meta { font-size: 12px; font-weight: 600; color: rgba(255, 255, 255, 0.75); }
  h1 {
    margin: 0;
    font-size: clamp(25px, 6.8vw, 31px);
    font-weight: 800;
    letter-spacing: -0.035em;
    line-height: 1.15;
    text-wrap: balance;
    -webkit-user-select: text;
    user-select: text;
  }
  .summary { margin: 12px 0 0; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.82); }

  .content {
    position: relative;
    max-width: 680px;
    margin: -24px auto 0;
    padding: 24px 22px 0;
    background: #fff;
    border-radius: 28px 28px 0 0;
  }

  /* ── On this page ───────────────────────────────────── */
  .toc { margin-bottom: 22px; }
  .toc-label { margin-bottom: 9px; font-size: 11px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
  .toc-chips { display: flex; gap: 7px; margin: 0 -22px; padding: 0 22px; overflow-x: auto; scrollbar-width: none; }
  .toc-chips::-webkit-scrollbar { display: none; }
  .chip {
    flex-shrink: 0;
    max-width: 240px;
    padding: 8px 13px;
    border: 0;
    border-radius: 999px;
    background: var(--acc-l);
    color: var(--acc-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:active { transform: scale(0.96); }

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
  .prose :global(strong) { color: var(--ink); font-weight: 750; }
  .prose :global(a) {
    color: var(--acc-d);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--acc) 40%, transparent);
    text-underline-offset: 3px;
  }

  .prose :global(h2),
  .prose :global(h3),
  .prose :global(h4) {
    margin: 1.8em 0 0.55em;
    color: var(--ink);
    font-weight: 780;
    letter-spacing: -0.025em;
    line-height: 1.25;
    scroll-margin-top: 76px;
  }
  .prose :global(h2) { font-size: 22px; padding-left: 12px; border-left: 4px solid var(--acc); }
  .prose :global(h3) { font-size: 18.5px; }
  .prose :global(h4) { font-size: 16.5px; }
  .prose :global(h2:first-child) { margin-top: 0.4em; }

  /* Bullets */
  .prose :global(ul) { list-style: none; padding: 0; margin: 0.9em 0 1.2em; }
  .prose :global(ul > li) { position: relative; padding-left: 22px; margin-bottom: 0.5em; }
  .prose :global(ul > li::before) {
    content: '';
    position: absolute;
    left: 5px;
    top: 0.72em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--acc);
  }

  /* Numbered steps become step cards */
  .prose :global(ol) {
    list-style: none;
    counter-reset: step;
    padding: 0;
    margin: 1.1em 0 1.3em;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .prose :global(ol > li) {
    counter-increment: step;
    position: relative;
    margin: 0;
    padding: 13px 14px 13px 54px;
    background: #f6f8fb;
    border: 1px solid var(--line);
    border-radius: 18px;
  }
  .prose :global(ol > li::before) {
    content: counter(step);
    position: absolute;
    left: 13px;
    top: 12px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--acc);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
  }
  /* Lists inside a step stay simple */
  .prose :global(li ul),
  .prose :global(li ol) { margin: 0.6em 0 0.2em; gap: 6px; }
  .prose :global(li ol > li) { background: transparent; border: 0; padding: 0 0 0 26px; border-radius: 0; }
  .prose :global(li ol > li::before) {
    left: 0;
    top: 0.2em;
    width: 20px;
    height: 20px;
    font-size: 11px;
    background: var(--acc-l);
    color: var(--acc-d);
  }

  /* Task lists */
  .prose :global(li.task) { padding-left: 30px; }
  .prose :global(li.task::before) { display: none; }
  .prose :global(li.task .box) {
    position: absolute;
    left: 0;
    top: 0.28em;
    width: 19px;
    height: 19px;
    border: 2px solid #c0c8d6;
    border-radius: 6px;
    background: #fff;
  }
  .prose :global(li.task.done .box) { background: var(--acc); border-color: var(--acc); }
  .prose :global(li.task.done .box::after) {
    content: '';
    position: absolute;
    left: 5px;
    top: 1px;
    width: 5px;
    height: 10px;
    border: solid #fff;
    border-width: 0 2.5px 2.5px 0;
    transform: rotate(45deg);
  }

  /* Quotes + callouts */
  .prose :global(blockquote) {
    margin: 1.4em 0;
    padding: 12px 16px;
    border-left: 3px solid var(--acc);
    border-radius: 0 14px 14px 0;
    background: var(--acc-l);
    color: var(--ink);
  }
  .prose :global(blockquote > :last-child) { margin-bottom: 0; }

  .prose :global(.callout) {
    --c: #2f6fe0;
    --cl: #e7f0ff;
    margin: 1.4em 0;
    padding: 14px 16px;
    border-radius: 18px;
    background: var(--cl);
    border: 1px solid color-mix(in srgb, var(--c) 18%, transparent);
  }
  .prose :global(.callout.tip) { --c: #0a9d6e; --cl: #e3f6ee; }
  .prose :global(.callout.warn) { --c: #d98a00; --cl: #fff2dc; }
  .prose :global(.callout.danger) { --c: #e23b3b; --cl: #ffe8e8; }
  .prose :global(.callout-title) {
    margin-bottom: 6px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--c);
  }
  .prose :global(.callout-body) { color: var(--ink); font-size: 15.5px; line-height: 1.6; }
  .prose :global(.callout-body > :last-child) { margin-bottom: 0; }

  /* Code, rules, tables, images */
  .prose :global(code) {
    padding: 2px 6px;
    border-radius: 6px;
    background: #f1f4f8;
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
  }
  .prose :global(pre) {
    margin: 1.3em 0;
    padding: 14px;
    border-radius: 14px;
    background: #0e1f3f;
    color: #d6e4ff;
    overflow-x: auto;
    line-height: 1.55;
  }
  .prose :global(pre code) { padding: 0; background: none; color: inherit; font-size: 13px; }
  .prose :global(hr) { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }

  .prose :global(.table-wrap) { margin: 1.4em 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; }
  .prose :global(table) { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 320px; }
  .prose :global(th),
  .prose :global(td) { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  .prose :global(th) { background: #f6f8fb; color: var(--ink); font-weight: 750; }
  .prose :global(tr:last-child td) { border-bottom: 0; }

  .prose :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1.4em auto;
    border-radius: 14px;
    box-shadow: 0 12px 26px -16px rgba(14, 31, 63, 0.4);
  }
  .prose :global(figure) { margin: 1.4em 0; }
  .prose :global(figcaption) { margin-top: 8px; font-size: 12.5px; color: var(--ink-3); text-align: center; }

  .empty { padding: 30px 0; text-align: center; color: var(--ink-3); font-size: 14px; }

  /* ── Next + back ────────────────────────────────────── */
  .next {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 32px;
    padding: 14px 14px 14px 16px;
    border: 0;
    border-radius: 20px;
    background: linear-gradient(135deg, var(--acc-d), var(--acc));
    color: #fff;
    text-align: left;
    font: inherit;
    cursor: pointer;
    box-shadow: 0 14px 26px -14px var(--acc);
    transition: transform 0.16s var(--ease);
  }
  .next:active { transform: scale(0.985); }
  .next-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .next-text small { font-size: 11px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }
  .next-text b { font-size: 15.5px; font-weight: 750; letter-spacing: -0.02em; line-height: 1.25; }
  .next-arrow {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.2);
  }

  .back-link {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 12px;
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

  /* ── States + skeleton ──────────────────────────────── */
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

  .loading-skel { padding: 0 22px; }
  .sk {
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 6px;
    margin-bottom: 14px;
  }
  .sk-top { height: 220px; margin: 0 -22px 24px; border-radius: 0 0 28px 28px; }
  .sk-p { height: 16px; margin-bottom: 10px; }
  .sk-p.short { width: 70%; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  @media (prefers-reduced-motion: reduce) {
    .progress, .bar, .bar-title, .round, .next { transition: none; }
    .sk { animation-duration: 2s; }
  }
</style>