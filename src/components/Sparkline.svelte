<script>
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();

  /**
   * values:     array of numbers
   * labels:     array of "YYYY-MM-DD" strings (same length)
   * height:     total chart height in px (labels included)
   * color:      main colour
   * variant:    'line' (default) | 'bars'
   * selected:   bind:selected. null means the last point
   * selectable: tap a day to select it
   */
  export let values = [];
  export let labels = [];
  export let height = 110;
  export let color = '#0b9a68';
  export let fill = true;
  export let showDots = true;
  export let variant = 'line';
  export let selected = null;
  export let selectable = true;

  const uid = 'sg' + Math.random().toString(36).slice(2, 8);
  const VAL_H = 18; // value label above a bar
  const LBL_H = 24; // day label row
  const W = 300; // line viewBox width
  const PAD_T = 14;
  const PAD_B = 6;

  $: n = values.length;
  $: safe = values.map((v) => (Number.isFinite(+v) ? +v : 0));
  $: max = Math.max(1, ...safe);
  $: sel =
    n === 0 ? -1
    : selected === null || selected === undefined ? n - 1
    : Math.max(0, Math.min(selected, n - 1));

  // ── Bars ──────────────────────────────────────────────────
  $: area = Math.max(24, height - VAL_H - LBL_H);
  const barH = (v, mx, ar) => (v <= 0 ? 4 : Math.max(8, (v / mx) * ar));

  // ── Line ──────────────────────────────────────────────────
  $: LH = Math.max(40, height - LBL_H);
  $: pts = safe.map((v, i) => ({
    x: ((i + 0.5) / Math.max(n, 1)) * W, // column centres, so dots line up with labels
    y: PAD_T + (1 - v / max) * (LH - PAD_T - PAD_B),
    v,
  }));

  const clampY = (y) => Math.max(PAD_T - 2, Math.min(LH - PAD_B, y));

  function smooth(p) {
    if (p.length === 0) return '';
    if (p.length === 1) return `M ${p[0].x} ${p[0].y}`;
    let d = `M ${p[0].x} ${p[0].y}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i];
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = p[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
      d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
    }
    return d;
  }

  $: linePath = smooth(pts);
  $: areaPath =
    pts.length > 1
      ? `${linePath} L ${pts[pts.length - 1].x} ${LH - PAD_B} L ${pts[0].x} ${LH - PAD_B} Z`
      : '';
  $: selPt = sel >= 0 ? pts[sel] : null;

  // ── Helpers ───────────────────────────────────────────────
  function localIso() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fmt(v) {
    if (v >= 100000) return (v / 1000).toFixed(0) + 'k';
    return Number(v).toLocaleString('en-KE');
  }

  function shortDay(iso, i, count) {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return String(iso).slice(0, 3);
    if (i === count - 1 && String(iso).slice(0, 10) === localIso()) return 'Today';
    return d.toLocaleDateString('en-KE', { weekday: 'short' }).slice(0, 3);
  }

  function pick(i) {
    if (!selectable) return;
    selected = i;
    try { navigator.vibrate?.(6); } catch { /* ignore */ }
    dispatch('select', { index: i, value: safe[i], label: labels[i] });
  }

  const ariaFor = (i) => `${labels[i] || i + 1}: ${safe[i]}`;
</script>

{#if variant === 'bars'}
  <div class="bars" style="height:{height}px; --c:{color}" role="group" aria-label="Daily totals">
    {#each safe as v, i}
      <button
        class="col"
        class:sel={i === sel}
        class:last={i === n - 1}
        style="--i:{i}"
        on:click={() => pick(i)}
        disabled={!selectable}
        aria-label={ariaFor(i)}
        aria-pressed={i === sel}
      >
        <span class="val" style="height:{VAL_H}px">{v > 0 ? fmt(v) : ''}</span>
        <span class="bar" class:zero={v === 0} style="height:{barH(v, max, area)}px"></span>
        <span class="lbl" style="height:{LBL_H}px">{shortDay(labels[i], i, n)}</span>
      </button>
    {/each}
  </div>
{:else}
  <div class="spark" style="--c:{color}">
    <div class="line">
      <svg viewBox="0 0 {W} {LH}" role="img" aria-label="Daily totals">
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.24" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>

        {#each [0, 0.5, 1] as t}
          <line x1="0" x2={W} y1={PAD_T + (1 - t) * (LH - PAD_T - PAD_B)} y2={PAD_T + (1 - t) * (LH - PAD_T - PAD_B)}
                stroke="rgba(14,31,63,0.07)" stroke-width="1" stroke-dasharray="3 4" />
        {/each}

        {#if selPt && n > 1}
          <line x1={selPt.x} x2={selPt.x} y1={PAD_T} y2={LH - PAD_B}
                stroke={color} stroke-opacity="0.25" stroke-width="1.5" />
        {/if}

        {#if fill && pts.length > 1}
          <path d={areaPath} fill="url(#{uid})" />
        {/if}
        {#if pts.length > 1}
          <path d={linePath} fill="none" stroke={color} stroke-width="2.4"
                stroke-linejoin="round" stroke-linecap="round" />
        {/if}

        {#if showDots}
          {#each pts as p, i}
            {#if i === sel}
              <circle cx={p.x} cy={p.y} r="9" fill={color} fill-opacity="0.16" />
            {/if}
            <circle cx={p.x} cy={p.y} r={i === sel ? 4.6 : 2.8} fill="#fff" stroke={color}
                    stroke-width={i === sel ? 2.8 : 2} />
          {/each}
        {/if}
      </svg>

      {#if selPt}
        <div class="bubble" style="left:{Math.max(12, Math.min(88, (selPt.x / W) * 100))}%; top:{(selPt.y / LH) * 100}%">
          {fmt(selPt.v)}
        </div>
      {/if}

      {#if selectable}
        <div class="hits">
          {#each safe as _, i}
            <button class="hit" on:click={() => pick(i)} aria-label={ariaFor(i)} aria-pressed={i === sel}></button>
          {/each}
        </div>
      {/if}
    </div>

    {#if labels.length > 0}
      <div class="labels" style="grid-template-columns: repeat({n}, 1fr)">
        {#each labels as iso, i}
          <span class="label" class:sel={i === sel} class:last={i === n - 1}>{shortDay(iso, i, n)}</span>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Bars ───────────────────────────────────────────── */
  .bars {
    position: relative;
    display: flex;
    gap: 6px;
    width: 100%;
  }
  .bars::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 24px;
    height: 1px;
    background: #edf0f5;
    pointer-events: none;
  }
  .col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .col:disabled { cursor: default; }
  .val {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 3px;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--ink-3, #8c97aa);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .col.sel .val { color: var(--ink, #0e1f3f); font-weight: 800; }

  .bar {
    width: 100%;
    max-width: 34px;
    border-radius: 10px 10px 4px 4px;
    background: var(--c);
    opacity: 0.3;
    transform-origin: bottom;
    animation: grow 0.6s cubic-bezier(0.22, 0.8, 0.24, 1) both;
    animation-delay: calc(var(--i) * 45ms);
    transition: opacity 0.18s ease, box-shadow 0.18s ease;
  }
  .col.last .bar { opacity: 0.55; }
  .col.sel .bar { opacity: 1; box-shadow: 0 10px 18px -10px var(--c); }
  .bar.zero { opacity: 0.18; border-radius: 3px; }
  .col:active .bar { opacity: 0.8; }

  .lbl {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 2px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3, #8c97aa);
  }
  .col.sel .lbl { color: var(--ink, #0e1f3f); font-weight: 800; }

  @keyframes grow {
    from { transform: scaleY(0.05); opacity: 0; }
  }

  /* ── Line ───────────────────────────────────────────── */
  .spark { position: relative; width: 100%; }
  .line { position: relative; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }

  .bubble {
    position: absolute;
    transform: translate(-50%, -150%);
    padding: 3px 8px;
    border-radius: 8px;
    background: var(--ink, #0e1f3f);
    color: #fff;
    font-size: 11px;
    font-weight: 750;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    pointer-events: none;
    white-space: nowrap;
  }
  .hits { position: absolute; inset: 0; display: flex; }
  .hit {
    flex: 1;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .labels { display: grid; margin-top: 2px; }
  .label {
    text-align: center;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--ink-3, #8c97aa);
  }
  .label.sel { color: var(--ink, #0e1f3f); font-weight: 800; }

  @media (prefers-reduced-motion: reduce) {
    .bar { animation: none; transition: none; }
  }
</style>