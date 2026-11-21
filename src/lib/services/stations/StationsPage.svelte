<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';

  const dispatch = createEventDispatcher();

  const CACHE_KEY = 'stations:all:v2'; // v2: only complete lists are cached
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const PAGE_LIMIT = 200;
  const MAX_PAGES = 400;
  const RENDER_STEP = 60;

  // ── State ─────────────────────────────────────────────────
  let phase = 'idle'; // idle | loading | error | ready
  let errorMsg = '';
  let stations = [];
  let haystacks = []; // lowercase search text, same order as stations
  let complete = false;
  let syncing = false;
  let syncFailed = false;
  let cachedAt = 0;

  let query = '';
  let qd = ''; // debounced + trimmed query
  let debounceTimer;
  let scope = 'all'; // all | ward | const
  let scopeInit = false;

  let remote = [];
  let remoteFor = '';

  let limit = RENDER_STEP;
  let scrollEl;

  let copiedId = null;
  let copiedTimer;
  let toastMsg = '';
  let toastTimer;

  function flash(msg, ms = 1600) {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastMsg = ''), ms);
  }

  // ── Helpers ───────────────────────────────────────────────
  const lc = (v) => String(v || '').trim().toLowerCase();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fmt = (n) => Number(n).toLocaleString('en-KE');

  function buildHay(s) {
    return [s.name, s.code, s.full_code, s.ward_name, s.constituency_name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function setAll(list) {
    stations = list;
    haystacks = list.map(buildHay);
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 3600) return 'just now';
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  function split(text, re) {
    const t = String(text ?? '');
    if (!re) return [{ t, hit: false }];
    return t
      .split(re)
      .map((x, i) => ({ t: x, hit: i % 2 === 1 }))
      .filter((p) => p.t !== '');
  }

  // ── Data: progressive load of every station ───────────────
  async function loadInitial() {
    errorMsg = '';
    syncFailed = false;
    if (!stations.length) phase = 'loading';

    try {
      const row = await Cache.get(CACHE_KEY);
      if (row?.value?.stations?.length) {
        setAll(row.value.stations);
        complete = !!row.value.complete;
        cachedAt = row.ts || 0;
        phase = 'ready';
        // Fresh and complete: no network needed
        if (complete && Date.now() - cachedAt < CACHE_TTL_MS) return;
      }
    } catch { /* ignore */ }

    await syncAll();
  }

  async function syncAll() {
    if (syncing) return;
    syncing = true;
    syncFailed = false;

    const progressive = stations.length === 0; // show rows as they arrive
    const all = [];

    try {
      for (let p = 1; p <= MAX_PAGES; p++) {
        const res = await apiFetch(`/api/stations/?limit=${PAGE_LIMIT}&page=${p}`);
        if (!res.ok || !Array.isArray(res.stations)) {
          throw new Error(res.error || 'Unexpected response');
        }
        for (const s of res.stations) all.push(s);

        if (progressive && (p === 1 || p % 5 === 0)) {
          setAll(all.slice());
          phase = 'ready';
        }
        if (!res.has_more) break;
      }

      setAll(all);
      complete = true;
      cachedAt = Date.now();
      phase = 'ready';
      try { await Cache.set(CACHE_KEY, { stations: all, complete: true }); } catch { /* ignore */ }
    } catch (err) {
      if (stations.length === 0 && all.length === 0) {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and the station list isn't saved on this device yet."
            : err.message || 'Network error.';
      } else {
        syncFailed = true;
        if (progressive && all.length) {
          setAll(all.slice());
          complete = false;
          phase = 'ready';
        }
      }
    } finally {
      syncing = false;
    }
  }

  // ── Search ────────────────────────────────────────────────
  function onQueryInput(v) {
    query = v;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      qd = query.trim();
      remote = [];
      remoteFor = '';
      scrollEl?.scrollTo({ top: 0 });
    }, 160);
  }

  function clearSearch() {
    clearTimeout(debounceTimer);
    query = '';
    qd = '';
    remote = [];
    remoteFor = '';
    scrollEl?.scrollTo({ top: 0 });
  }

  function setScope(id) {
    scope = id;
    scopeInit = true;
    scrollEl?.scrollTo({ top: 0 });
  }

  // While the full list is still loading, also ask the server
  async function remoteSearch(q) {
    try {
      const res = await apiFetch(`/api/stations/?q=${encodeURIComponent(q)}&limit=200`);
      if (q === qd && res.ok && Array.isArray(res.stations)) {
        remote = res.stations;
        remoteFor = q;
      }
    } catch { /* ignore */ }
  }
  $: if (qd && !complete && qd !== remoteFor) remoteSearch(qd);

  // ── Derived ───────────────────────────────────────────────
  $: wardL = lc($session.ward?.name);
  $: constL = lc($session.constituency?.name);

  $: counts = countScopes(stations, wardL, constL);
  function countScopes(list, w, c) {
    let ward = 0;
    let cons = 0;
    if (!w && !c) return { ward, cons };
    for (const s of list) {
      if (w && lc(s.ward_name) === w) ward++;
      if (c && lc(s.constituency_name) === c) cons++;
    }
    return { ward, cons };
  }

  // Start on "My ward" once we know the VRA has stations there
  $: if (!scopeInit && stations.length) {
    if (counts.ward > 0) {
      scope = 'ward';
      scopeInit = true;
    } else if (complete) {
      scopeInit = true;
    }
  }

  $: chips = [
    { id: 'all', label: 'All', n: stations.length },
    ...(wardL ? [{ id: 'ward', label: 'My ward', n: counts.ward }] : []),
    ...(constL ? [{ id: 'const', label: 'My constituency', n: counts.cons }] : []),
  ];

  $: tokens = qd.toLowerCase().split(/\s+/).filter(Boolean);
  $: hlRe = tokens.length
    ? new RegExp('(' + [...tokens].sort((a, b) => b.length - a.length).map(esc).join('|') + ')', 'ig')
    : null;

  function passScope(s, sc, w, c) {
    if (sc === 'ward') return lc(s.ward_name) === w;
    if (sc === 'const') return lc(s.constituency_name) === c;
    return true;
  }

  function filterStations(list, hay, sc, toks, w, c) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!passScope(s, sc, w, c)) continue;
      if (toks.length) {
        const h = hay[i];
        let ok = true;
        for (const t of toks) {
          if (!h.includes(t)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      out.push(s);
    }
    return out;
  }

  function mergeRemote(local, extra, sc, w, c) {
    const seen = new Set(local.map((s) => s.id));
    const out = [...local];
    for (const s of extra) {
      if (!seen.has(s.id) && passScope(s, sc, w, c)) {
        out.push(s);
        seen.add(s.id);
      }
    }
    return out;
  }

  $: local = filterStations(stations, haystacks, scope, tokens, wardL, constL);
  $: results =
    !complete && qd && remote.length ? mergeRemote(local, remote, scope, wardL, constL) : local;

  // Only draw a window of the results
  $: { qd; scope; limit = RENDER_STEP; }
  $: shown = results.slice(0, limit);

  $: scopeLabel = scope === 'ward' ? 'in your ward' : scope === 'const' ? 'in your constituency' : 'nationwide';

  // Infinite scroll for the window
  function watch(node) {
    const obs = new IntersectionObserver(
      (e) => { if (e[0].isIntersecting) limit += RENDER_STEP; },
      { root: node.closest('.scroll'), rootMargin: '400px' },
    );
    obs.observe(node);
    return { destroy() { obs.disconnect(); } };
  }

  // ── Actions ───────────────────────────────────────────────
  async function copyCode(s) {
    const code = s.full_code || s.code;
    try { await navigator.clipboard.writeText(code); } catch { /* ignore */ }
    try { navigator.vibrate?.(8); } catch { /* ignore */ }
    copiedId = s.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedId = null), 1200);
    flash(`Copied ${code}`, 1300);
  }

  onMount(() => { loadInitial(); });

  onDestroy(() => {
    clearTimeout(debounceTimer);
    clearTimeout(toastTimer);
    clearTimeout(copiedTimer);
  });
</script>

<PageTransition>
  <div class="sp">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Stations</div>
          <div class="hero-sub">
            {#if stations.length === 0}
              {phase === 'error' ? 'Not available' : 'Loading…'}
            {:else if syncing && !complete}
              Loading… {fmt(stations.length)} so far
            {:else}
              {fmt(results.length)} {results.length === 1 ? 'station' : 'stations'} {scopeLabel}
            {/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>

      <div class="search">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" />
        </svg>
        <input
          type="text"
          value={query}
          on:input={(e) => onQueryInput(e.currentTarget.value)}
          placeholder="Search name, code or ward…"
          inputmode="search"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        {#if query}
          <button class="search-clear" on:click={clearSearch} aria-label="Clear search">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                 stroke-width="2.6" stroke-linecap="round"><path d="M6 6L18 18M18 6L6 18" /></svg>
          </button>
        {/if}
      </div>

      {#if chips.length > 1}
        <div class="chips" role="tablist" aria-label="Station scope">
          {#each chips as c (c.id)}
            <button class="pill" class:on={scope === c.id} role="tab" aria-selected={scope === c.id}
                    on:click={() => setScope(c.id)}>
              {c.label}
              {#if c.n}<span class="pill-count">{fmt(c.n)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </header>

    <div class="sheet">
      <div class="scroll" bind:this={scrollEl}>
        {#if phase === 'error'}
          <div class="state">
            <div class="state-ic err">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
              </svg>
            </div>
            <h3>Couldn't load stations</h3>
            <p>{errorMsg}</p>
            <button class="btn" on:click={loadInitial}>Try again</button>
          </div>

        {:else if stations.length === 0}
          <div class="skeleton">
            {#each Array(7) as _}
              <div class="sk-row">
                <div class="sk sk-pin"></div>
                <div class="sk-body">
                  <div class="sk sk-l1"></div>
                  <div class="sk sk-l2"></div>
                </div>
              </div>
            {/each}
          </div>

        {:else}
          {#if syncing && !complete}
            <div class="banner">
              <span class="spinner"></span>
              Loading the full list… {fmt(stations.length)} stations so far
            </div>
          {:else if syncFailed && !complete}
            <div class="banner warn">
              <span>Only part of the list loaded ({fmt(stations.length)} stations).</span>
              <button class="link" on:click={syncAll}>Retry</button>
            </div>
          {/if}

          {#if results.length === 0}
            <div class="state">
              <div class="state-ic">
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                     stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z" />
                  <circle cx="12" cy="9.5" r="2" />
                </svg>
              </div>
              <h3>{qd ? 'No matches' : 'No stations here'}</h3>
              <p>
                {#if qd}
                  Nothing found for “{qd}”{scope !== 'all' ? ' in this area' : ''}.
                {:else}
                  There are no stations in this area.
                {/if}
                {#if !complete}<br />The full list is still loading, so results may be incomplete.{/if}
              </p>
              {#if scope !== 'all'}
                <button class="btn" on:click={() => setScope('all')}>Search all stations</button>
              {/if}
            </div>
          {:else}
            <div class="list">
              {#each shown as s (s.id)}
                {@const code = s.full_code || s.code}
                <button class="station" on:click={() => copyCode(s)} aria-label="Copy code {code}">
                  <span class="pin">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                         stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z" />
                      <circle cx="12" cy="9.5" r="2.2" />
                    </svg>
                  </span>
                  <span class="st-main">
                    <span class="st-name">
                      {#each split(s.name, hlRe) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}
                    </span>
                    <span class="st-meta">
                      <span class="code">{#each split(code, hlRe) as p}{#if p.hit}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>
                      {#if s.ward_name && scope !== 'ward'}<span class="tag ward">{s.ward_name}</span>{/if}
                      {#if s.constituency_name && scope === 'all'}<span class="tag">{s.constituency_name}</span>{/if}
                    </span>
                  </span>
                  <span class="copy" class:done={copiedId === s.id} aria-hidden="true">
                    {#if copiedId === s.id}
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                           stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                    {:else}
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V5A2 2 0 0 1 7 3H15" />
                      </svg>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>

            {#if shown.length < results.length}
              {#key limit}
                <div class="sentinel" use:watch>
                  <div class="more"><span class="spinner"></span>Loading more…</div>
                </div>
              {/key}
            {:else}
              <div class="foot">
                {fmt(results.length)} {results.length === 1 ? 'station' : 'stations'}{#if qd} for “{qd}”{/if}
              </div>
            {/if}
          {/if}

          {#if complete}
            <div class="update">
              {#if syncing}
                <span class="spinner"></span> Updating list…
              {:else}
                Updated {ago(cachedAt)} ·
                <button class="link" on:click={syncAll}>Update now</button>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    {#if toastMsg}
      <div class="toast" role="status" transition:fly={{ y: 10, duration: 200, easing: cubicOut }}>
        {toastMsg}
      </div>
    {/if}
  </div>
</PageTransition>

<style>
  .sp {
    --bg: #f6f8fb;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --pink: #d6397f;
    --pink-d: #a82a63;
    --pink-l: #ffe6f1;
    --slate-l: #e9eef4;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1e0a14;
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
      radial-gradient(110% 120% at 100% -10%, rgba(240, 130, 170, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(140, 20, 70, 0.3), transparent 55%),
      linear-gradient(150deg, #1a0610 0%, #4a1028 58%, #6c1838 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; margin-bottom: 14px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-title { font-size: clamp(21px, 6vw, 26px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.05; }
  .hero-sub {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.14);
    color: rgba(255, 255, 255, 0.9);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    transition: background 0.2s var(--ease), border-color 0.2s var(--ease);
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

  .chips { display: flex; gap: 6px; margin-top: 12px; overflow-x: auto; scrollbar-width: none; }
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
    color: rgba(255, 255, 255, 0.9);
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .pill.on { background: #fff; color: #4a1028; border-color: #fff; }
  .pill-count {
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    font-size: 10.5px;
    font-weight: 800;
    text-align: center;
  }
  .pill.on .pill-count { background: var(--pink); color: #fff; }

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

  .banner {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 12px;
    padding: 10px 13px;
    border-radius: 14px;
    background: var(--pink-l);
    color: var(--pink-d);
    font-size: 12.5px;
    font-weight: 650;
  }
  .banner.warn { background: #fff2dc; color: #8f5a00; justify-content: space-between; }
  .link {
    padding: 4px 2px;
    border: 0;
    background: none;
    color: var(--pink-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
  }
  .banner.warn .link { color: #8f5a00; }

  /* ── Rows ───────────────────────────────────────────── */
  .list { display: flex; flex-direction: column; gap: 8px; }
  .station {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 11px 12px 11px 11px;
    border: 1px solid var(--line);
    border-radius: 20px;
    background: #fff;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 26px -22px rgba(14, 31, 63, 0.25);
    transition: transform 0.14s var(--ease), background 0.16s var(--ease);
  }
  .station:active { transform: scale(0.99); background: #fafbfd; }

  .pin {
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, var(--pink-l), #fff3f8);
    color: var(--pink);
  }
  .st-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .st-name {
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.27;
    color: var(--ink);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .st-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .code {
    padding: 2px 7px;
    border-radius: 6px;
    background: var(--slate-l);
    color: #4d5d73;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    font-weight: 600;
  }
  .tag {
    padding: 2px 7px;
    border-radius: 6px;
    background: var(--slate-l);
    color: var(--ink-2);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .tag.ward { background: var(--pink-l); color: var(--pink-d); }
  mark { padding: 0 1px; border-radius: 3px; background: #ffd7e8; color: inherit; }

  .copy {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f1f4f8;
    color: var(--ink-2);
    transition: background 0.16s, color 0.16s;
  }
  .copy.done { background: #e3f6ee; color: #067552; }

  /* ── Footer bits ────────────────────────────────────── */
  .sentinel { padding: 18px 8px 4px; text-align: center; }
  .more {
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
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .foot { padding: 20px 8px 4px; text-align: center; font-size: 12px; font-weight: 600; color: var(--ink-3); }
  .update {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 8px 4px;
    font-size: 11.5px;
    color: var(--ink-3);
  }

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
    background: var(--pink-l);
    color: var(--pink);
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
    padding: 11px;
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
  .sk-pin { width: 42px; height: 42px; border-radius: 14px; flex-shrink: 0; }
  .sk-body { flex: 1; display: flex; flex-direction: column; gap: 9px; }
  .sk-l1 { height: 13px; width: 72%; }
  .sk-l2 { height: 11px; width: 44%; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

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
    .station, .pill, .search { transition: none; }
    .sk, .spinner { animation-duration: 2s; }
  }
</style>