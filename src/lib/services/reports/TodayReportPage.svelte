<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { tweened } from 'svelte/motion';

  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';
  import Sparkline from '$lib/../components/Sparkline.svelte';

  const dispatch = createEventDispatcher();

  const STALE_MS = 60 * 1000;

  // ── State ─────────────────────────────────────────────────
  let phase = 'idle'; // idle | loading | error | ready
  let data = null;
  let errorMsg = '';
  let fromCache = false;
  let updatedAt = 0;
  let refreshing = false;
  let selIdx = null; // selected day in the chart (null = today)

  let now = Date.now();
  const clock = setInterval(() => (now = Date.now()), 30000);

  let toastMsg = '';
  let toastTimer;
  function flash(msg, ms = 1800) {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastMsg = ''), ms);
  }

  onDestroy(() => {
    clearInterval(clock);
    clearTimeout(toastTimer);
  });

  const tick = (ms = 10) => {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  };

  function todayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function cacheKey() {
    if (!$session.ward) return null;
    return `stats:day:${$session.ward.id}:${todayIso()}`;
  }

  // ── Load ──────────────────────────────────────────────────
  async function load({ manual = false } = {}) {
    if (!$session.fingerprint) {
      phase = 'error';
      errorMsg = 'This device is not set up yet.';
      return;
    }
    if (manual) refreshing = true;

    const key = cacheKey();
    if (key && !data) {
      try {
        const row = await Cache.get(key);
        if (row?.value?.today) {
          data = row.value;
          updatedAt = row.ts || 0;
          fromCache = true;
          phase = 'ready';
        }
      } catch { /* ignore */ }
    }

    if (phase !== 'ready') phase = 'loading';

    try {
      const res = await apiFetch(
        `/api/stats/day/?fingerprint=${encodeURIComponent($session.fingerprint)}`,
      );
      if (res.ok && res.today) {
        data = res;
        updatedAt = Date.now();
        fromCache = false;
        phase = 'ready';
        if (key) {
          try { await Cache.set(key, res); } catch { /* ignore */ }
        }
        if (manual) flash('Updated', 1200);
      } else if (phase !== 'ready') {
        phase = 'error';
        errorMsg = res.error || 'Could not load report.';
      } else if (manual) {
        flash("Couldn't refresh. Showing saved data.");
      }
    } catch (err) {
      if (phase !== 'ready') {
        phase = 'error';
        errorMsg =
          navigator.onLine === false
            ? "You're offline and there is no saved report yet."
            : err.message || 'Network error.';
      } else if (manual) {
        flash("Couldn't refresh. Showing saved data.");
      }
    } finally {
      refreshing = false;
    }
  }

  $: if ($session.status === 'bound' && $session.ward && phase === 'idle') {
    phase = 'loading';
    load();
  }

  $: if ($session.status === 'unbound' && phase !== 'ready') {
    phase = 'error';
    errorMsg = 'Set up this device first, then your reports will appear here.';
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (phase === 'ready' && Date.now() - updatedAt > STALE_MS) load();
  }

  // ── Derived ───────────────────────────────────────────────
  $: today = data?.today || null;
  $: yesterday = data?.yesterday || null;
  $: series = Array.isArray(data?.last_7_days) ? data.last_7_days : [];

  // count-up for the big number
  const shown = tweened(0, { duration: 800, easing: cubicOut });
  $: shown.set(today?.total ?? 0);

  $: malePct = today && today.total > 0 ? Math.round((today.male / today.total) * 100) : 0;
  $: femalePct = today && today.total > 0 ? 100 - malePct : 0;

  $: yTotal = yesterday?.total ?? 0;
  $: deltaPct =
    typeof yesterday?.delta_pct === 'number'
      ? yesterday.delta_pct
      : today && yTotal > 0
        ? ((today.total - yTotal) / yTotal) * 100
        : null;
  $: deltaDir = deltaPct === null ? 'flat' : deltaPct > 0.2 ? 'up' : deltaPct < -0.2 ? 'down' : 'flat';
  $: deltaText = deltaPct === null ? '' : `${Math.abs(Math.round(deltaPct * 10) / 10)}%`;

  $: kitsTotal = today?.kits_total ?? 0;
  $: kitsDone = today?.kits_recorded ?? 0;
  $: pending = Math.max(0, kitsTotal - kitsDone);
  $: progressPct = kitsTotal > 0 ? Math.round((kitsDone / kitsTotal) * 100) : 0;

  // chart: selected day + change from the day before
  $: selI = series.length ? Math.min(selIdx ?? series.length - 1, series.length - 1) : -1;
  $: selDay = selI >= 0 ? series[selI] : null;
  $: prevDay = selI > 0 ? series[selI - 1] : null;
  $: selDelta =
    selDay && prevDay && prevDay.total > 0
      ? Math.round(((selDay.total - prevDay.total) / prevDay.total) * 1000) / 10
      : null;

  $: total7 = series.reduce((s, d) => s + (d.total || 0), 0);
  $: avg7 = series.length ? Math.round(total7 / series.length) : 0;
  $: best = series.reduce((b, d) => (!b || d.total > b.total ? d : b), null);

  // ── Actions ───────────────────────────────────────────────
  function goEntry() {
    tick();
    dispatch('navigate', 'entry');
  }

  function summaryText() {
    const ward = $session.ward?.name || 'Ward';
    const lines = [
      'KIEMS daily report',
      `${ward}${$session.constituency ? ', ' + $session.constituency.name : ''}`,
      formatFullDate(data?.date || todayIso()),
      '',
      `Registered today: ${fmt(today.total)} (M ${fmt(today.male)} · F ${fmt(today.female)})`,
      `Kits recorded: ${kitsDone}/${kitsTotal}${pending ? ` (${pending} pending)` : ''}`,
    ];
    if (yTotal > 0) lines.push(`Yesterday: ${fmt(yTotal)}`);
    return lines.join('\n');
  }

  async function share() {
    if (!today) return;
    const text = summaryText();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      flash('Summary copied');
    } catch {
      flash("Couldn't share");
    }
  }

  // ── Formatting ────────────────────────────────────────────
  function fmt(n) {
    return Number(n ?? 0).toLocaleString('en-KE');
  }

  function formatFullDate(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function dayLabel(iso) {
    if (!iso) return '';
    const s = String(iso).slice(0, 10);
    if (s === todayIso()) return 'Today';
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d)) return s;
    return d.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function weekday(iso) {
    const d = new Date(String(iso || '').slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-KE', { weekday: 'long' });
  }

  function ago(ts, ref) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((ref - ts) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
</script>

<svelte:document on:visibilitychange={onVisible} />

<PageTransition>
  <div class="rp">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Reports</div>
          <div class="hero-sub">
            {$session.ward?.name || 'Your ward'}{#if $session.constituency} · {$session.constituency.name}{/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>

      <div class="hero-row">
        <div class="hero-when">
          <div class="hero-date">{formatFullDate(data?.date || todayIso())}</div>
          {#if updatedAt}
            <div class="hero-updated">{fromCache ? 'Saved data · ' : ''}Updated {ago(updatedAt, now)}</div>
          {/if}
        </div>
        <div class="hero-actions">
          <button class="glass-btn small" class:spin={refreshing} on:click={() => load({ manual: true })}
                  disabled={refreshing || phase === 'idle'} aria-label="Refresh report">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 12A8 8 0 1 1 12 4" /><path d="M20 4V10H14" />
            </svg>
          </button>
          {#if today}
            <button class="glass-btn small" on:click={share} aria-label="Share summary">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 15V3" /><path d="M7.5 7.5L12 3L16.5 7.5" />
                <path d="M5 12V19A2 2 0 0 0 7 21H17A2 2 0 0 0 19 19V12" />
              </svg>
            </button>
          {/if}
        </div>
      </div>
    </header>

    <div class="sheet">
      <div class="scroll">
        {#if phase === 'error'}
          <div class="state">
            <div class="state-ic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
              </svg>
            </div>
            <h3>Couldn't load report</h3>
            <p>{errorMsg}</p>
            {#if $session.status !== 'unbound'}
              <button class="btn" on:click={() => { phase = 'loading'; load(); }}>Try again</button>
            {/if}
          </div>

        {:else if today}
          <!-- Summary -->
          <section class="card summary">
            <div class="sum-top">
              <div>
                <div class="sum-label">Registered today</div>
                <div class="sum-num">{fmt(Math.round($shown))}</div>
              </div>
              {#if deltaPct !== null}
                <span class="chip {deltaDir}">
                  {#if deltaDir === 'up'}
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                         stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15L12 9L18 15" /></svg>
                  {:else if deltaDir === 'down'}
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                         stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9L12 15L18 9" /></svg>
                  {/if}
                  {deltaDir === 'flat' ? 'Same as yesterday' : `${deltaText} vs yesterday`}
                </span>
              {:else}
                <span class="chip flat">No baseline yet</span>
              {/if}
            </div>

            <div class="g-bar" class:empty={today.total === 0}>
              <span class="m" style="width: {malePct}%"></span>
              <span class="f" style="width: {femalePct}%"></span>
            </div>

            <div class="g-legend">
              <div class="g male">
                <i></i>
                <span class="g-name">Male</span>
                <b>{fmt(today.male)}</b>
                <em>{today.total > 0 ? malePct + '%' : '–'}</em>
              </div>
              <div class="g female">
                <i></i>
                <span class="g-name">Female</span>
                <b>{fmt(today.female)}</b>
                <em>{today.total > 0 ? femalePct + '%' : '–'}</em>
              </div>
            </div>
          </section>

          <!-- Kits -->
          <section class="card kits">
            <div class="kits-top">
              <div>
                <div class="sum-label">Kits recorded</div>
                <div class="kits-num">{kitsDone}<span>/{kitsTotal}</span></div>
              </div>
              {#if kitsTotal > 0}
                <span class="pct">{progressPct}%</span>
              {/if}
            </div>

            {#if kitsTotal === 0}
              <p class="muted">No kits are assigned to this ward.</p>
            {:else}
              {#if kitsTotal <= 24}
                <div class="segs" role="img" aria-label="{kitsDone} of {kitsTotal} kits recorded">
                  {#each Array(kitsTotal) as _, i}<i class:on={i < kitsDone}></i>{/each}
                </div>
              {:else}
                <div class="seg-bar"><span style="width: {progressPct}%"></span></div>
              {/if}

              {#if pending > 0}
                <button class="cta" on:click={goEntry}>
                  Record {pending} pending kit{pending === 1 ? '' : 's'}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                       stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                  </svg>
                </button>
              {:else}
                <div class="all-done">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                       stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                  All kits recorded
                </div>
              {/if}
            {/if}
          </section>

          <!-- Last 7 days -->
          {#if series.length > 0 && selDay}
            <section class="card chart">
              <div class="chart-head">
                <div>
                  <div class="sum-label">{dayLabel(selDay.date)}</div>
                  <div class="chart-num">{fmt(selDay.total)}</div>
                </div>
                <div class="chart-side">
                  {#if selDelta !== null}
                    <span class="chip small {selDelta > 0 ? 'up' : selDelta < 0 ? 'down' : 'flat'}">
                      {selDelta > 0 ? '+' : ''}{selDelta}% vs day before
                    </span>
                  {/if}
                  <span class="chart-sub">{fmt(total7)} in {series.length} days</span>
                </div>
              </div>

              <Sparkline
                variant="bars"
                bind:selected={selIdx}
                values={series.map((d) => d.total)}
                labels={series.map((d) => d.date)}
                height={156}
                color="#ef9400"
              />
              <div class="chart-hint">Tap a bar to see that day</div>
            </section>

            <!-- Insights -->
            <section class="insights">
              <div class="tile">
                <div class="t-label">Daily average</div>
                <div class="t-num">{fmt(avg7)}</div>
                <div class="t-sub">last {series.length} days</div>
              </div>
              <div class="tile">
                <div class="t-label">Best day</div>
                <div class="t-num">{best ? fmt(best.total) : '–'}</div>
                <div class="t-sub">{best ? weekday(best.date) : ''}</div>
              </div>
              <div class="tile">
                <div class="t-label">Yesterday</div>
                <div class="t-num">{yTotal > 0 ? fmt(yTotal) : '–'}</div>
                <div class="t-sub">{yTotal > 0 ? 'registered' : 'no data'}</div>
              </div>
            </section>
          {/if}

        {:else}
          <div class="skeleton">
            <div class="sk sk-sum"></div>
            <div class="sk sk-kits"></div>
            <div class="sk sk-chart"></div>
          </div>
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
  .rp {
    --bg: #f6f8fb;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --green: #0a9d6e;
    --green-d: #067552;
    --green-l: #e3f6ee;
    --amber: #ef9400;
    --amber-d: #b36a00;
    --amber-l: #fff2dc;
    --red: #e23b3b;
    --red-l: #ffe8e8;
    --male: #1e5fa8;
    --male-l: #e2edfa;
    --female: #b23a32;
    --female-l: #fbeae8;
    --slate-l: #e9eef4;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);
    --shadow: 0 1px 2px rgba(14, 31, 63, 0.04), 0 14px 30px -18px rgba(14, 31, 63, 0.2);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #2a1c02;
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
    padding: calc(12px + env(safe-area-inset-top)) 14px 40px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(255, 196, 60, 0.34), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(180, 110, 0, 0.26), transparent 55%),
      linear-gradient(150deg, #2a1c02 0%, #5f3a04 58%, #8a5406 100%);
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

  .hero-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .hero-when { min-width: 0; }
  .hero-date { font-size: 13.5px; font-weight: 700; color: rgba(255, 255, 255, 0.92); }
  .hero-updated { margin-top: 3px; font-size: 11.5px; font-weight: 600; color: rgba(255, 255, 255, 0.62); }
  .hero-actions { display: flex; gap: 8px; flex-shrink: 0; }

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
  .glass-btn:disabled { opacity: 0.6; }
  .glass-btn.small { width: 36px; height: 36px; border-radius: 12px; }
  .glass-btn.spin svg { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

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
    padding: 18px 14px calc(24px + env(safe-area-inset-bottom));
  }

  .card {
    padding: 18px 18px 16px;
    margin-bottom: 12px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: var(--shadow);
  }
  .sum-label {
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
  }

  /* ── Summary ────────────────────────────────────────── */
  .sum-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .sum-num {
    margin-top: 6px;
    font-size: 54px;
    font-weight: 800;
    letter-spacing: -0.055em;
    line-height: 1;
    color: var(--ink);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 750;
    white-space: nowrap;
    background: var(--slate-l);
    color: #4d5d73;
  }
  .chip.small { padding: 4px 9px; font-size: 11px; }
  .chip.up { background: var(--green-l); color: var(--green-d); }
  .chip.down { background: var(--red-l); color: #b23a32; }

  .g-bar {
    display: flex;
    height: 10px;
    margin-top: 18px;
    border-radius: 999px;
    background: var(--slate-l);
    overflow: hidden;
  }
  .g-bar .m { background: #4f93e6; transition: width 0.7s var(--ease); }
  .g-bar .f { background: #ec7d73; transition: width 0.7s var(--ease); }
  .g-bar .m + .f { margin-left: 2px; }

  .g-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  .g {
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: 'dot name pct' 'dot num pct';
    column-gap: 8px;
    align-items: center;
    padding: 10px 12px;
    border-radius: 16px;
  }
  .g.male { background: var(--male-l); color: var(--male); }
  .g.female { background: var(--female-l); color: var(--female); }
  .g i { grid-area: dot; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .g-name { grid-area: name; font-size: 10.5px; font-weight: 750; letter-spacing: 0.07em; text-transform: uppercase; }
  .g b { grid-area: num; font-size: 20px; font-weight: 800; letter-spacing: -0.04em; color: var(--ink); line-height: 1.15; }
  .g em { grid-area: pct; font-style: normal; font-size: 12px; font-weight: 750; opacity: 0.85; }

  /* ── Kits ───────────────────────────────────────────── */
  .kits-top { display: flex; align-items: flex-end; justify-content: space-between; }
  .kits-num { margin-top: 6px; font-size: 32px; font-weight: 800; letter-spacing: -0.05em; line-height: 1; }
  .kits-num span { font-size: 18px; font-weight: 650; color: var(--ink-3); margin-left: 1px; }
  .pct { font-size: 14px; font-weight: 800; color: var(--green-d); }

  .segs { display: flex; gap: 4px; margin-top: 16px; }
  .segs i { flex: 1; height: 8px; border-radius: 999px; background: var(--slate-l); transition: background 0.4s var(--ease); }
  .segs i.on { background: var(--green); }
  .seg-bar { height: 8px; margin-top: 16px; border-radius: 999px; background: var(--slate-l); overflow: hidden; }
  .seg-bar span { display: block; height: 100%; border-radius: inherit; background: var(--green); transition: width 0.7s var(--ease); }
  .muted { margin: 12px 0 0; font-size: 13px; color: var(--ink-3); }

  .cta {
    width: 100%;
    margin-top: 16px;
    padding: 14px 16px;
    border: 0;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: linear-gradient(135deg, #087451, #0b9a68);
    color: #fff;
    font: inherit;
    font-size: 14px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 12px 24px -12px rgba(7, 116, 81, 0.7);
    transition: transform 0.16s var(--ease);
  }
  .cta:active { transform: scale(0.985); }
  .all-done {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 16px;
    padding: 9px 14px;
    border-radius: 999px;
    background: var(--green-l);
    color: var(--green-d);
    font-size: 13px;
    font-weight: 750;
  }

  /* ── Chart ──────────────────────────────────────────── */
  .chart-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .chart-num { margin-top: 5px; font-size: 32px; font-weight: 800; letter-spacing: -0.05em; line-height: 1; }
  .chart-side { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
  .chart-sub { font-size: 11.5px; font-weight: 650; color: var(--ink-3); }
  .chart-hint { margin-top: 8px; text-align: center; font-size: 11px; font-weight: 600; color: var(--ink-3); }

  /* ── Insights ───────────────────────────────────────── */
  .insights { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 4px; }
  .tile {
    padding: 13px 12px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 20px;
    box-shadow: var(--shadow);
    min-width: 0;
  }
  .t-label { font-size: 10px; font-weight: 750; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); }
  .t-num { margin-top: 7px; font-size: 21px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .t-sub { margin-top: 5px; font-size: 11px; font-weight: 600; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
    background: var(--red-l);
    color: var(--red);
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

  /* ── Skeleton ───────────────────────────────────────── */
  .skeleton { display: flex; flex-direction: column; gap: 12px; }
  .sk {
    border-radius: 24px;
    background: linear-gradient(90deg, rgba(14, 31, 63, 0.05) 0%, rgba(14, 31, 63, 0.1) 50%, rgba(14, 31, 63, 0.05) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .sk-sum { height: 190px; }
  .sk-kits { height: 140px; }
  .sk-chart { height: 250px; }
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
    background: var(--ink);
    color: #fff;
    font-size: 13px;
    font-weight: 650;
    box-shadow: 0 14px 28px -10px rgba(0, 0, 0, 0.45);
  }

  @media (prefers-reduced-motion: reduce) {
    .cta, .g-bar .m, .g-bar .f, .segs i, .seg-bar span { transition: none; }
    .sk, .glass-btn.spin svg { animation-duration: 2s; }
  }
</style>