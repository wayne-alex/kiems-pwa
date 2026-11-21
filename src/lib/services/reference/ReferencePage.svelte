<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';
  import ReferenceReader from './ReferenceReader.svelte';
  import { getReadSet } from './referenceState.js';

  const dispatch = createEventDispatcher();

  export let category = 'training'; // training | help
  export let title = 'Training';

  const DOC_KEY = 'reference:doc:'; // same key the reader uses

  let phase = 'idle'; // idle | loading | error | ready
  let errorMsg = '';
  let docs = [];
  let fromCache = false;

  let openSlug = null;
  let readSet = new Set();
  let query = '';

  let cachedCount = 0;
  let prefetching = false;

  const manifestKey = () => `reference:manifest:${category}`;

  $: theme = category === 'help' ? 'help' : 'training';

  // ── Load ──────────────────────────────────────────────────
  async function load() {
    errorMsg = '';
    if (!docs.length) phase = 'loading';

    // Saved copy first. It is used even when old, so the page works offline.
    try {
      const row = await Cache.get(manifestKey());
      if (row?.value?.docs?.length) {
        docs = row.value.docs;
        fromCache = true;
        phase = 'ready';
      }
    } catch { /* ignore */ }

    try {
      const res = await apiFetch(`/api/reference/?category=${category}`);
      if (res.ok) {
        docs = res.docs || [];
        fromCache = false;
        phase = 'ready';
        try { await Cache.set(manifestKey(), res); } catch { /* ignore */ }
      } else if (phase !== 'ready') {
        phase = 'error';
        errorMsg = res.error || 'Could not load content.';
      }
    } catch (err) {
      if (phase !== 'ready') {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and nothing is saved on this device yet."
            : err.message || 'Network error.';
      }
    }

    await countCached();
    prefetchAll();
  }

  async function countCached() {
    let n = 0;
    for (const d of docs) {
      try {
        const row = await Cache.get(DOC_KEY + d.slug);
        if (row?.value) n++;
      } catch { /* ignore */ }
    }
    cachedCount = n;
  }

  // Save every guide so it can be read without internet
  async function prefetchAll() {
    if (prefetching || fromCache || !navigator.onLine || !docs.length) return;
    prefetching = true;
    let ok = 0;
    try {
      for (const d of docs) {
        const key = DOC_KEY + d.slug;
        let have = false;
        try { have = !!(await Cache.get(key))?.value; } catch { /* ignore */ }
        if (!have) {
          const res = await apiFetch(`/api/reference/${d.slug}/`);
          if (!res.ok) continue;
          try { await Cache.set(key, res); } catch { /* ignore */ }
        }
        ok++;
        cachedCount = ok;
      }
    } catch { /* stopped: offline or server error */ }
    prefetching = false;
  }

  // ── Derived ───────────────────────────────────────────────
  $: readCount = docs.filter((d) => readSet.has(d.slug)).length;
  $: nextUnread = docs.find((d) => !readSet.has(d.slug)) || null;

  $: tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  $: shown = tokens.length
    ? docs.filter((d) => {
        const hay = `${d.title} ${d.summary || ''}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
    : docs;
  $: showSearch = docs.length >= 6;

  $: openIdx = docs.findIndex((d) => d.slug === openSlug);
  $: nextDoc = openIdx >= 0 && openIdx < docs.length - 1 ? docs[openIdx + 1] : null;

  // ── Actions ───────────────────────────────────────────────
  function open(doc) {
    if (!doc) return;
    try { navigator.vibrate?.(5); } catch { /* ignore */ }
    openSlug = doc.slug;
  }

  function closeReader() {
    openSlug = null;
  }

  function onRead(e) {
    readSet = new Set([...readSet, e.detail.slug]);
  }

  function onNext(e) {
    openSlug = e.detail.slug;
  }

  onMount(() => {
    load();
    getReadSet().then((s) => (readSet = s));
  });
</script>

<PageTransition>
  <div class="rf {theme}">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">{title}</div>
          <div class="hero-sub">
            {#if docs.length === 0}
              {phase === 'error' ? 'Not available' : phase === 'ready' ? 'No guides yet' : 'Loading…'}
            {:else if category === 'training'}
              {readCount} of {docs.length} read{#if fromCache} · saved copy{/if}
            {:else}
              {docs.length} guide{docs.length === 1 ? '' : 's'}{#if fromCache} · saved copy{/if}
            {/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>

      {#if showSearch}
        <div class="search">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" />
          </svg>
          <input
            type="text"
            bind:value={query}
            placeholder="Search guides…"
            inputmode="search"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
          />
          {#if query}
            <button class="search-clear" on:click={() => (query = '')} aria-label="Clear search">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="2.6" stroke-linecap="round"><path d="M6 6L18 18M18 6L6 18" /></svg>
            </button>
          {/if}
        </div>
      {/if}
    </header>

    <div class="sheet">
      <div class="scroll">
        {#if phase === 'error'}
          <div class="state">
            <div class="state-ic err">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
              </svg>
            </div>
            <h3>Couldn't load content</h3>
            <p>{errorMsg}</p>
            <button class="btn" on:click={load}>Try again</button>
          </div>

        {:else if phase !== 'ready' && docs.length === 0}
          <div class="skeleton">
            {#each Array(4) as _}
              <div class="sk-row">
                <div class="sk sk-icon"></div>
                <div class="sk-body">
                  <div class="sk sk-l1"></div>
                  <div class="sk sk-l2"></div>
                </div>
              </div>
            {/each}
          </div>

        {:else if docs.length === 0}
          <div class="state">
            <div class="state-ic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5V5A2 2 0 0 1 6 3H20V17H6A2 2 0 0 0 4 19.5Z" />
                <path d="M4 19.5A2 2 0 0 0 6 21.5H20V17" />
              </svg>
            </div>
            <h3>No guides yet</h3>
            <p>Check back soon. New guides will show up here.</p>
          </div>

        {:else}
          {#if category === 'training' && !query}
            <section class="progress">
              <div class="p-top">
                <div>
                  <div class="p-label">Your progress</div>
                  <div class="p-num">{readCount}<span>/{docs.length}</span></div>
                </div>
                {#if readCount === docs.length}
                  <span class="all-done">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                         stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                    All done
                  </span>
                {:else if nextUnread}
                  <button class="continue" on:click={() => open(nextUnread)}>
                    {readCount === 0 ? 'Start' : 'Continue'}
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                    </svg>
                  </button>
                {/if}
              </div>

              {#if docs.length <= 24}
                <div class="segs" aria-hidden="true">
                  {#each docs as d (d.slug)}<i class:on={readSet.has(d.slug)}></i>{/each}
                </div>
              {/if}

              {#if nextUnread && readCount < docs.length}
                <div class="p-next">Next: <b>{nextUnread.title}</b></div>
              {/if}
            </section>
          {/if}

          {#if shown.length === 0}
            <div class="state small">
              <h3>No matches</h3>
              <p>Nothing found for “{query.trim()}”.</p>
            </div>
          {:else}
            <div class="list">
              {#each shown as doc, i (doc.slug)}
                {@const done = readSet.has(doc.slug)}
                <button class="row" on:click={() => open(doc)}>
                  {#if category === 'training'}
                    <span class="num" class:done>
                      {#if done}
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                             stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                      {:else}
                        {docs.indexOf(doc) + 1}
                      {/if}
                    </span>
                  {:else}
                    <span class="ico tone-{i % 5}">
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
                           stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 3A9 9 0 1 0 12 21A9 9 0 1 0 12 3Z" />
                        <path d="M9.5 9.5A2.5 2.5 0 1 1 12 12V13.5" /><path d="M12 17V17.1" />
                      </svg>
                    </span>
                  {/if}
                  <span class="r-body">
                    <span class="r-title">{doc.title}</span>
                    {#if doc.summary}<span class="r-sum">{doc.summary}</span>{/if}
                  </span>
                  <svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                </button>
              {/each}
            </div>
          {/if}

          <div class="offline" class:ok={cachedCount >= docs.length}>
            {#if cachedCount >= docs.length}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
              Available offline
            {:else if prefetching}
              <span class="spinner"></span> Saving for offline… {cachedCount}/{docs.length}
            {:else}
              {cachedCount}/{docs.length} saved for offline
              {#if !fromCache}<button class="link" on:click={prefetchAll}>Save all</button>{/if}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</PageTransition>

<!-- Reader slides over the list, so the list keeps its scroll position -->
{#if openSlug}
  <div class="layer" transition:fly={{ x: 48, duration: 260, easing: cubicOut, opacity: 0.2 }}>
    {#key openSlug}
      <ReferenceReader
        slug={openSlug}
        {category}
        {nextDoc}
        on:back={closeReader}
        on:read={onRead}
        on:next={onNext}
      />
    {/key}
  </div>
{/if}

<style>
  .rf {
    --bg: #f6f8fb;
    --card: #fff;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --slate-l: #e9eef4;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
  .rf.training {
    --acc: #6a4cd8;
    --acc-d: #4f36b5;
    --acc-l: #eeeaff;
    background: #17103a;
  }
  .rf.help {
    --acc: #2f6fe0;
    --acc-d: #1f55b8;
    --acc-l: #e7f0ff;
    background: #0b1b3d;
  }

  /* ── Hero ───────────────────────────────────────────── */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 38px;
    color: #fff;
  }
  .training .hero {
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(150, 120, 255, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(80, 50, 190, 0.3), transparent 55%),
      linear-gradient(150deg, #120b30 0%, #2f2170 58%, #4a35a8 100%);
  }
  .help .hero {
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(90, 160, 255, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(20, 70, 170, 0.3), transparent 55%),
      linear-gradient(150deg, #081532 0%, #12306b 58%, #1d4a9c 100%);
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

  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.14);
    color: rgba(255, 255, 255, 0.9);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  .search:focus-within { background: rgba(255, 255, 255, 0.2); border-color: rgba(255, 255, 255, 0.4); }
  .search svg { color: rgba(255, 255, 255, 0.65); flex-shrink: 0; }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: #fff;
    font: inherit;
    font-size: 16px;
    -webkit-user-select: text;
    user-select: text;
  }
  .search input::placeholder { color: rgba(255, 255, 255, 0.55); }
  .search-clear {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

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
    padding: 16px 14px calc(24px + env(safe-area-inset-bottom));
  }

  /* ── Training progress ──────────────────────────────── */
  .progress {
    margin-bottom: 16px;
    padding: 16px 16px 14px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 30px -18px rgba(14, 31, 63, 0.2);
  }
  .p-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
  .p-label { font-size: 11px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
  .p-num { margin-top: 5px; font-size: 32px; font-weight: 800; letter-spacing: -0.05em; line-height: 1; }
  .p-num span { font-size: 18px; font-weight: 650; color: var(--ink-3); margin-left: 1px; }
  .continue {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 11px 16px;
    border: 0;
    border-radius: 14px;
    background: linear-gradient(135deg, var(--acc-d), var(--acc));
    color: #fff;
    font: inherit;
    font-size: 13.5px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 12px 22px -12px var(--acc);
    transition: transform 0.16s var(--ease);
  }
  .continue:active { transform: scale(0.96); }
  .all-done {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 13px;
    border-radius: 999px;
    background: #e3f6ee;
    color: #067552;
    font-size: 12.5px;
    font-weight: 750;
  }
  .segs { display: flex; gap: 4px; margin-top: 14px; }
  .segs i { flex: 1; height: 7px; border-radius: 999px; background: var(--slate-l); transition: background 0.4s var(--ease); }
  .segs i.on { background: var(--acc); }
  .p-next { margin-top: 12px; font-size: 12.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-next b { color: var(--ink); font-weight: 700; }

  /* ── Rows ───────────────────────────────────────────── */
  .list { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px 12px 12px 12px;
    border: 1px solid var(--line);
    border-radius: 20px;
    background: var(--card);
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 26px -22px rgba(14, 31, 63, 0.25);
    transition: transform 0.14s var(--ease), background 0.16s var(--ease);
  }
  .row:active { transform: scale(0.99); background: #fafbfd; }

  .num,
  .ico {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .num {
    background: var(--acc-l);
    color: var(--acc-d);
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  .num.done { background: #e3f6ee; color: #067552; }

  .tone-0 { background: #eeeaff; color: #6a4cd8; }
  .tone-1 { background: #e7f0ff; color: #2f6fe0; }
  .tone-2 { background: #def6f8; color: #0e9aa7; }
  .tone-3 { background: #fff2dc; color: #d98a00; }
  .tone-4 { background: #ffe6f1; color: #d6397f; }

  .r-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .r-title {
    font-size: 15px;
    font-weight: 720;
    letter-spacing: -0.02em;
    line-height: 1.27;
    color: var(--ink);
  }
  .r-sum {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ink-3);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .chev { flex-shrink: 0; color: #c0c8d6; }

  /* ── Offline status ─────────────────────────────────── */
  .offline {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 18px;
    font-size: 11.5px;
    font-weight: 650;
    color: var(--ink-3);
  }
  .offline.ok { color: #067552; }
  .link {
    padding: 4px 2px;
    border: 0;
    background: none;
    color: var(--acc-d);
    font: inherit;
    font-size: 11.5px;
    font-weight: 750;
    cursor: pointer;
  }
  .spinner {
    width: 11px;
    height: 11px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── States ─────────────────────────────────────────── */
  .state { padding: 54px 20px; text-align: center; color: var(--ink-2); }
  .state.small { padding: 34px 20px; }
  .state-ic {
    width: 60px;
    height: 60px;
    margin: 0 auto 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--acc-l);
    color: var(--acc);
  }
  .state-ic.err { background: #ffe8e8; color: #e23b3b; }
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

  /* ── Skeleton ───────────────────────────────────────── */
  .skeleton { display: flex; flex-direction: column; gap: 8px; }
  .sk-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 20px;
  }
  .sk {
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 6px;
  }
  .sk-icon { width: 44px; height: 44px; border-radius: 15px; flex-shrink: 0; }
  .sk-body { flex: 1; display: flex; flex-direction: column; gap: 9px; }
  .sk-l1 { height: 14px; width: 68%; }
  .sk-l2 { height: 11px; width: 90%; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .layer { position: fixed; inset: 0; z-index: 60; background: #fff; }

  @media (prefers-reduced-motion: reduce) {
    .row, .continue, .segs i { transition: none; }
    .sk, .spinner { animation-duration: 2s; }
  }
</style>