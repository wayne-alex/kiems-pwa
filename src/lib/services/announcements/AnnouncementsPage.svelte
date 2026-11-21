<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';
  import { isRead } from './readState.js';

  const dispatch = createEventDispatcher();

  const PAGE_SIZE = 10;
  const CACHE_KEY = 'announcements:list:v2';
  const STALE_MS = 2 * 60 * 1000;

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread' },
    { id: 'iebc', label: 'IEBC' },
    { id: 'ict', label: 'ICT' },
  ];

  let items = [];
  let page = 0;
  let hasMore = true;
  let phase = 'idle'; // idle | loading | error | ready
  let errorMsg = '';
  let loadingMore = false;
  let moreFailed = false;
  let refreshing = false;
  let busy = false;
  let fromCache = false;
  let lastFetched = 0;

  let filter = 'all'; // all | unread | iebc | ict
  let touched = new Set(); // ids read this session (keeps the list reactive)

  let toastMsg = '';
  let toastTimer;
  function flash(msg, ms = 2000) {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastMsg = ''), ms);
  }
  onDestroy(() => clearTimeout(toastTimer));

  // Called by the wrapper when the reader reports an article as read
  export function markSeen(id) {
    touched = new Set([...touched, id]);
  }

  // ── Derived ───────────────────────────────────────────────
  const isNew = (a, seen) => !isRead(a.id) && !seen.has(a.id);

  function applyFilter(list, f, seen) {
    if (f === 'unread') return list.filter((a) => isNew(a, seen));
    if (f === 'iebc') return list.filter((a) => a.is_iebc);
    if (f === 'ict') return list.filter((a) => !a.is_iebc);
    return list;
  }

  $: visible = applyFilter(items, filter, touched);
  $: unreadCount = items.reduce((n, a) => n + (isNew(a, touched) ? 1 : 0), 0);

  // The newest item gets a big card when it has an image
  $: featured = filter === 'all' && visible[0]?.image_url ? visible[0] : null;
  $: groups = buildGroups(featured ? visible.slice(1) : visible);

  function buildGroups(list) {
    const out = [];
    let cur = null;
    for (const a of list) {
      const label = groupOf(a.published_at);
      if (!cur || cur.label !== label) {
        cur = { label, items: [] };
        out.push(cur);
      }
      cur.items.push(a);
    }
    return out;
  }

  // ── Dates ─────────────────────────────────────────────────
  function dayDiff(iso) {
    const s = String(iso || '').slice(0, 10);
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d)) return null;
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((t - d) / 86400000);
  }

  function groupOf(iso) {
    const n = dayDiff(iso);
    if (n === null) return 'Earlier';
    if (n <= 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n < 7) return 'This week';
    if (n < 30) return 'This month';
    return 'Earlier';
  }

  function relative(iso) {
    const n = dayDiff(iso);
    if (n === null) return '';
    if (n <= 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n < 7) return `${n}d ago`;
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }

  // ── Data ──────────────────────────────────────────────────
  async function fetchPage(p) {
    const wardId = $session.ward?.id;
    const params = new URLSearchParams({ page: String(p), page_size: String(PAGE_SIZE) });
    if (wardId) params.set('ward_id', String(wardId));
    const res = await apiFetch(`/api/announcements/?${params.toString()}`);
    if (!res.ok) throw new Error(res.error || 'Failed to load');
    return res;
  }

  async function loadFirstPage() {
    phase = 'loading';
    errorMsg = '';

    try {
      const row = await Cache.get(CACHE_KEY);
      if (row?.value?.announcements?.length) {
        items = row.value.announcements;
        page = 1;
        hasMore = row.value.has_more ?? true;
        fromCache = true;
        phase = 'ready';
      }
    } catch { /* ignore */ }

    try {
      const res = await fetchPage(1);
      items = res.announcements;
      page = 1;
      hasMore = res.has_more;
      fromCache = false;
      lastFetched = Date.now();
      phase = 'ready';
      try { await Cache.set(CACHE_KEY, res); } catch { /* ignore */ }
    } catch (err) {
      if (phase !== 'ready') {
        phase = 'error';
        errorMsg = navigator.onLine === false
          ? "You're offline and nothing is saved on this device yet."
          : err.message || 'Could not load announcements.';
      }
    }
  }

  // Merge fresh page 1 into the list without losing the pages already loaded
  async function refresh({ silent = false } = {}) {
    if (busy) return;
    busy = true;
    if (!silent) refreshing = true;
    try {
      const res = await fetchPage(1);
      const fresh = new Map(res.announcements.map((a) => [a.id, a]));
      const known = new Set(items.map((a) => a.id));
      const added = res.announcements.filter((a) => !known.has(a.id));
      items = [...added, ...items.map((a) => fresh.get(a.id) || a)];
      if (page === 0) {
        page = 1;
        hasMore = res.has_more;
      }
      fromCache = false;
      lastFetched = Date.now();
      if (phase !== 'ready') phase = 'ready';
      try { await Cache.set(CACHE_KEY, res); } catch { /* ignore */ }
      if (!silent) flash(added.length ? `${added.length} new` : 'Up to date', 1400);
    } catch {
      if (!silent) flash("Couldn't refresh. Check your connection.");
    } finally {
      busy = false;
      refreshing = false;
    }
  }

  async function loadNextPage() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    moreFailed = false;
    try {
      const res = await fetchPage(page + 1);
      const seen = new Set(items.map((a) => a.id));
      const merged = [...items];
      for (const a of res.announcements) {
        if (!seen.has(a.id)) {
          merged.push(a);
          seen.add(a.id);
        }
      }
      items = merged;
      page = res.page ?? page + 1;
      hasMore = res.has_more;
    } catch {
      moreFailed = true;
    } finally {
      loadingMore = false;
    }
  }

  // Infinite scroll. The observer root is the scroll box, so the margin really prefetches.
  function watch(node) {
    const obs = new IntersectionObserver(
      (e) => { if (e[0].isIntersecting && !moreFailed) loadNextPage(); },
      { root: node.closest('.scroll'), rootMargin: '400px' },
    );
    obs.observe(node);
    return { destroy() { obs.disconnect(); } };
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (phase === 'ready' && Date.now() - lastFetched > STALE_MS) refresh({ silent: true });
  }

  // ── Actions ───────────────────────────────────────────────
  function open(a) {
    try { navigator.vibrate?.(6); } catch { /* ignore */ }
    dispatch('open', a);
  }

  async function markAll() {
    const { markAllRead } = await import('./readState.js');
    markAllRead(items.map((a) => a.id));
    touched = new Set([...touched, ...items.map((a) => a.id)]);
  }

  onMount(() => {
    loadFirstPage();
  });
</script>

<svelte:window on:online={() => refresh({ silent: true })} />
<svelte:document on:visibilitychange={onVisible} />

<PageTransition>
  <div class="ap">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6 L9 12 L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Announcements</div>
          <div class="hero-sub">
            {#if phase === 'loading' && items.length === 0}
              Loading…
            {:else if unreadCount > 0}
              {unreadCount} unread
            {:else if items.length > 0}
              You're all caught up
            {:else}
              Nothing yet
            {/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>

      <div class="filters">
        <div class="chips" role="tablist" aria-label="Filter announcements">
          {#each FILTERS as f (f.id)}
            <button
              class="pill"
              class:on={filter === f.id}
              role="tab"
              aria-selected={filter === f.id}
              on:click={() => (filter = f.id)}
            >
              {f.label}
              {#if f.id === 'unread' && unreadCount > 0}
                <span class="pill-count">{unreadCount}</span>
              {/if}
            </button>
          {/each}
        </div>
        <button class="glass-btn small" class:spin={refreshing} on:click={() => refresh()}
                disabled={refreshing} aria-label="Refresh announcements">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 12A8 8 0 1 1 12 4" /><path d="M20 4V10H14" />
          </svg>
        </button>
      </div>
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
            <h3>Couldn't load announcements</h3>
            <p>{errorMsg}</p>
            <button class="btn" on:click={loadFirstPage}>Try again</button>
          </div>

        {:else if phase !== 'ready' && items.length === 0}
          <div class="skeleton">
            <div class="sk sk-feature"></div>
            {#each Array(3) as _}
              <div class="sk-row">
                <div class="sk sk-img"></div>
                <div class="sk-body">
                  <div class="sk sk-line s1"></div>
                  <div class="sk sk-line s2"></div>
                  <div class="sk sk-line s3"></div>
                </div>
              </div>
            {/each}
          </div>

        {:else if visible.length === 0 && !hasMore}
          <div class="state">
            <div class="state-ic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 11V13A2 2 0 0 0 5 15H7L12 20V4L7 9H5A2 2 0 0 0 3 11Z" />
                <path d="M15.5 8.5A5 5 0 0 1 15.5 15.5" />
              </svg>
            </div>
            <h3>
              {filter === 'unread' ? 'No unread announcements'
                : filter === 'all' ? 'Nothing yet'
                : `No ${filter.toUpperCase()} announcements`}
            </h3>
            <p>{filter === 'unread' ? 'Everything is read.' : 'Check back soon.'}</p>
          </div>

        {:else}
          {#if unreadCount > 0}
            <div class="toolbar">
              <span>{unreadCount} unread</span>
              <button class="link" on:click={markAll}>Mark all as read</button>
            </div>
          {/if}

          {#if featured}
            <button class="feature" class:unread={isNew(featured, touched)} on:click={() => open(featured)}>
              <img src={featured.image_url} alt="" loading="eager" decoding="async" />
              <div class="feature-shade"></div>
              <div class="feature-body">
                <div class="feature-top">
                  <span class="src on-dark">{featured.is_iebc ? 'IEBC' : 'ICT'}</span>
                  <span class="feature-date">{relative(featured.published_at)}</span>
                  {#if isNew(featured, touched)}<span class="new-pill">New</span>{/if}
                </div>
                <div class="feature-title">{featured.title}</div>
              </div>
            </button>
          {/if}

          {#each groups as g (g.label)}
            <div class="group-head">{g.label}</div>
            <div class="group">
              {#each g.items as a (a.id)}
                {@const fresh = isNew(a, touched)}
                <button class="row" class:unread={fresh} on:click={() => open(a)}>
                  <div class="thumb" class:ict={!a.is_iebc}>
                    {#if a.image_url}
                      <img src={a.image_url} alt="" loading="lazy" decoding="async"
                           on:error={(e) => (e.currentTarget.style.display = 'none')} />
                    {:else}
                      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 11V13A2 2 0 0 0 5 15H7L12 20V4L7 9H5A2 2 0 0 0 3 11Z" />
                        <path d="M15.5 8.5A5 5 0 0 1 15.5 15.5" />
                      </svg>
                    {/if}
                  </div>
                  <div class="row-body">
                    <div class="row-top">
                      <span class="src" class:ict={!a.is_iebc}>{a.is_iebc ? 'IEBC' : 'ICT'}</span>
                      <span class="date">{relative(a.published_at)}</span>
                      {#if fresh}<i class="dot" aria-label="New"></i>{/if}
                    </div>
                    <div class="title">{a.title}</div>
                  </div>
                  <svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                       stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                </button>
              {/each}
            </div>
          {/each}

          {#if hasMore}
            {#key page}
              <div class="sentinel" use:watch>
                {#if moreFailed}
                  <button class="btn small" on:click={loadNextPage}>Couldn't load more · Retry</button>
                {:else}
                  <div class="loading-row"><span class="spinner"></span>Loading more…</div>
                {/if}
              </div>
            {/key}
          {:else if items.length > 0}
            <div class="end-row">That's everything · {items.length} announcement{items.length === 1 ? '' : 's'}</div>
          {/if}
        {/if}
      </div>

      {#if fromCache && items.length > 0}
        <div class="footnote">Showing saved announcements · refresh for the latest</div>
      {/if}
    </div>

    {#if toastMsg}
      <div class="toast" role="status" transition:fly={{ y: 10, duration: 200, easing: cubicOut }}>
        {toastMsg}
      </div>
    {/if}
  </div>
</PageTransition>

<style>
  .ap {
    --bg: #f6f8fb;
    --card: #ffffff;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --teal: #0e9aa7;
    --teal-d: #0b7a85;
    --teal-l: #def6f8;
    --amber: #b36a00;
    --amber-l: #fff2dc;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #03171a;
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
      radial-gradient(110% 120% at 100% -10%, rgba(20, 190, 190, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(0, 100, 110, 0.3), transparent 55%),
      linear-gradient(150deg, #03171a 0%, #0a3a42 58%, #0c4a54 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; margin-bottom: 14px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-title {
    font-size: clamp(21px, 6vw, 26px);
    font-weight: 780;
    letter-spacing: -0.045em;
    line-height: 1.05;
  }
  .hero-sub { margin-top: 4px; font-size: 12px; color: rgba(255, 255, 255, 0.72); font-weight: 600; }
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
  .glass-btn.small { width: 34px; height: 34px; border-radius: 12px; }
  .glass-btn.spin svg { animation: spin 0.8s linear infinite; }

  .filters { display: flex; align-items: center; gap: 8px; }
  .chips {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .chips::-webkit-scrollbar { display: none; }
  .pill {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.88);
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .pill.on { background: #fff; color: #0a3a42; border-color: #fff; }
  .pill-count {
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    font-size: 10.5px;
    font-weight: 800;
    text-align: center;
  }
  .pill.on .pill-count { background: var(--teal); color: #fff; }

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

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 4px 12px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--ink-2);
  }
  .link {
    padding: 4px 2px;
    border: 0;
    background: none;
    color: var(--teal-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
  }

  /* ── Featured card ──────────────────────────────────── */
  .feature {
    position: relative;
    display: block;
    width: 100%;
    height: 214px;
    padding: 0;
    border: 0;
    border-radius: 24px;
    overflow: hidden;
    color: #fff;
    text-align: left;
    font: inherit;
    cursor: pointer;
    background: #0a3a42;
    box-shadow: 0 18px 30px -20px rgba(3, 23, 26, 0.7);
    transition: transform 0.16s var(--ease);
  }
  .feature:active { transform: scale(0.985); }
  .feature img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .feature-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(3, 20, 24, 0.92) 0%, rgba(3, 20, 24, 0.4) 55%, rgba(3, 20, 24, 0.05) 100%);
  }
  .feature-body {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 16px;
  }
  .feature-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .feature-date { font-size: 11.5px; font-weight: 650; color: rgba(255, 255, 255, 0.8); }
  .feature-title {
    font-size: 19px;
    font-weight: 780;
    letter-spacing: -0.03em;
    line-height: 1.22;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .new-pill {
    margin-left: auto;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--teal);
    color: #fff;
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* ── Groups + rows ──────────────────────────────────── */
  .group-head {
    margin: 20px 4px 10px;
    font-size: 11px;
    font-weight: 780;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .feature + .group-head { margin-top: 18px; }
  .toolbar + .group-head { margin-top: 4px; }
  .group { display: flex; flex-direction: column; gap: 8px; }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 12px 10px 10px;
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

  .thumb {
    width: 72px;
    height: 72px;
    flex-shrink: 0;
    border-radius: 15px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, var(--teal-l), #f0fbfc);
    color: var(--teal);
  }
  .thumb.ict { background: linear-gradient(145deg, var(--amber-l), #fff9ee); color: #d98a00; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .row-top { display: flex; align-items: center; gap: 7px; }
  .src {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 5px;
    background: var(--teal-l);
    color: var(--teal-d);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.07em;
  }
  .src.ict { background: var(--amber-l); color: var(--amber); }
  .src.on-dark { background: rgba(255, 255, 255, 0.2); color: #fff; }
  .date { font-size: 11.5px; font-weight: 600; color: var(--ink-3); }
  .dot {
    margin-left: auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--teal);
    box-shadow: 0 0 0 3px rgba(14, 154, 167, 0.18);
  }

  .title {
    font-size: 14.5px;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.3;
    color: var(--ink);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .row.unread .title { font-weight: 780; }
  .chev { flex-shrink: 0; color: #c0c8d6; }

  /* ── Load more ──────────────────────────────────────── */
  .sentinel { padding: 18px 8px 4px; text-align: center; }
  .loading-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 999px;
    background: #fff;
    border: 1px solid var(--line);
    color: var(--ink-2);
    font-size: 12px;
    font-weight: 650;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .end-row { padding: 22px 8px 6px; text-align: center; font-size: 12px; color: var(--ink-3); font-weight: 600; }

  /* ── States ─────────────────────────────────────────── */
  .state { padding: 54px 20px; text-align: center; color: var(--ink-2); }
  .state-ic {
    width: 60px;
    height: 60px;
    margin: 0 auto 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--teal-l);
    color: var(--teal);
  }
  .state-ic.err { background: #ffe8e8; color: #e23b3b; }
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
  .btn.small { padding: 9px 14px; font-size: 12px; border-radius: 12px; }

  /* ── Skeleton ───────────────────────────────────────── */
  .skeleton { display: flex; flex-direction: column; gap: 8px; }
  .sk {
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 6px;
  }
  .sk-feature { height: 214px; border-radius: 24px; margin-bottom: 10px; }
  .sk-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 20px;
  }
  .sk-img { width: 72px; height: 72px; border-radius: 15px; flex-shrink: 0; }
  .sk-body { flex: 1; display: flex; flex-direction: column; gap: 9px; }
  .sk-line { height: 12px; }
  .sk-line.s1 { width: 30%; }
  .sk-line.s2 { width: 92%; }
  .sk-line.s3 { width: 64%; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .footnote {
    flex: none;
    padding: 9px 14px calc(9px + env(safe-area-inset-bottom));
    text-align: center;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-3);
    border-top: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.94);
  }

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
    background: #0e1f3f;
    color: #fff;
    font-size: 13px;
    font-weight: 650;
    box-shadow: 0 14px 28px -10px rgba(0, 0, 0, 0.45);
  }

  @media (prefers-reduced-motion: reduce) {
    .row, .feature, .pill { transition: none; }
    .sk, .spinner, .glass-btn.spin svg { animation-duration: 2s; }
  }
</style>