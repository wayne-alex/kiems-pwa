<script>
  import { onMount, createEventDispatcher, tick } from 'svelte';

  const dispatch = createEventDispatcher();

  /**
   * items        array of kits (any shape)
   * currentIndex bind:currentIndex — the parent can read and set it
   * isDirty      (item) => boolean   unsaved edits on that card
   * isDone       (item) => boolean   already recorded
   * itemKey      (item, i) => unique key
   * onAdvance    (item) => boolean | Promise<boolean>   return false to STAY on the card
   * onFinal      () => void   called after the last card is saved
   * saveLabel    (item, atEnd) => string
   */
  export let items = [];
  export let currentIndex = 0;
  export let isDirty = () => false;
  export let isDone = () => false;
  export let title = '';
  export let itemKey = (it, i) => it?.key ?? it?.kit_id ?? it?.id ?? i;
  export let onAdvance = async () => true;
  export let onFinal = () => {};
  export let saveLabel = (item, atEnd) => (atEnd ? 'Save & finish' : 'Save & next');

  let track;
  let slides = [];
  let advancing = false;
  let swiped = false;
  let raf = 0;

  // Plain object on purpose: NOT reactive, so scrolling never fights the user.
  const st = { idx: 0, ready: false, width: 0 };

  $: total = items.length;
  $: current = items[currentIndex];
  $: atEnd = currentIndex >= total - 1;
  $: doneCount = items.filter((it) => isDone(it)).length;
  $: progress = total ? (doneCount / total) * 100 : 0;
  $: label = current ? saveLabel(current, atEnd) : 'Save';

  // ── Scroll helpers ───────────────────────────────────────
  const reduced = () =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function targetLeft(i) {
    const s = slides[i];
    if (!s || !track) return 0;
    return s.offsetLeft + s.offsetWidth / 2 - track.clientWidth / 2;
  }

  function scrollToIndex(i, smooth = true) {
    if (!track) return;
    track.scrollTo({ left: targetLeft(i), behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  }

  function nearest() {
    const center = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      if (!s) continue;
      const d = Math.abs(s.offsetLeft + s.offsetWidth / 2 - center);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Finger moved the track → update the index (dots, labels)
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!track) return;
      const i = nearest();
      if (i !== st.idx) {
        st.idx = i;
        swiped = true;
        currentIndex = i;
        dispatch('indexchange', { index: i });
      }
    });
  }

  // Parent (or a dot / button) changed the index → move the track
  $: syncFromParent(currentIndex, track);
  function syncFromParent(i, el) {
    if (!el || !st.ready || i === st.idx) return;
    st.idx = i;
    scrollToIndex(i);
  }

  function goTo(i) {
    if (i < 0) return;
    if (i >= total) { onFinal(); return; }
    currentIndex = i;
  }

  async function advance() {
    if (advancing || !current) return;
    advancing = true;
    try {
      const ok = await onAdvance(current);
      if (ok === false) return; // rejected → stay on this card
      await new Promise((r) => setTimeout(r, 160));
      if (atEnd) onFinal();
      else goTo(currentIndex + 1);
    } finally {
      advancing = false;
    }
  }

  onMount(() => {
    st.idx = currentIndex;
    st.ready = true;
    tick().then(() => scrollToIndex(currentIndex, false));

    // Keep the current card centered if the width changes (rotation)
    const ro = new ResizeObserver(() => {
      if (!track || track.clientWidth === st.width) return;
      st.width = track.clientWidth;
      scrollToIndex(st.idx, false);
    });
    ro.observe(track);

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div class="deck">
  {#if title}<div class="deck-title">{title}</div>{/if}

  <div class="deck-top">
    <div class="deck-count"><b>{total ? currentIndex + 1 : 0}</b> / {total}</div>
    <div class="deck-progress" aria-hidden="true"><span style="width: {progress}%"></span></div>
    <div class="deck-done">{doneCount} done</div>
  </div>

  <div class="deck-dots" role="tablist" aria-label="Kits">
    {#each items as it, i (itemKey(it, i))}
      <button
        class="dot"
        class:on={i === currentIndex}
        class:done={isDone(it)}
        class:edit={isDirty(it) && !isDone(it)}
        on:click={() => goTo(i)}
        aria-label="Kit {i + 1} of {total}"
        aria-current={i === currentIndex ? 'true' : 'false'}
      >
        {#if isDone(it) && i !== currentIndex}
          <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor"
               stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.5L10 17.5L19 7" />
          </svg>
        {/if}
      </button>
    {/each}
  </div>

  <div class="track" bind:this={track} on:scroll={onScroll}>
    {#each items as it, i (itemKey(it, i))}
      <div class="slide" class:active={i === currentIndex} bind:this={slides[i]}>
        <div class="card">
          <slot current={it} index={i} {total} active={i === currentIndex} />
        </div>
      </div>
    {:else}
      <div class="slide active">
        <div class="card empty"><p>Nothing to show.</p></div>
      </div>
    {/each}
  </div>

  <div class="deck-actions">
    <button class="nav" on:click={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}
            aria-label="Previous kit">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 6L9 12L15 18" />
      </svg>
    </button>

    <button class="primary" on:click={advance} disabled={advancing || !current}>
      {#if advancing}Saving…{:else}{label}{/if}
    </button>

    <button class="nav" on:click={() => goTo(currentIndex + 1)} disabled={atEnd}
            aria-label="Next kit without saving">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6L15 12L9 18" />
      </svg>
    </button>
  </div>

  <div class="deck-hint">
      {#if total > 1}
    <div class="deck-dots" role="tablist" aria-label="Kits">
      {#each items as it, i (itemKey(it, i))}
        <button
          class="dot"
          class:on={i === currentIndex}
          class:done={isDone(it)}
          class:edit={isDirty(it) && !isDone(it)}
          on:click={() => goTo(i)}
          aria-label="Kit {i + 1} of {total}"
          aria-current={i === currentIndex ? 'true' : 'false'}
        >
          {#if isDone(it) && i !== currentIndex}
            <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor"
                 stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.5L10 17.5L19 7" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
  </div>
</div>

<style>
  .deck {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    min-height: 0;
  }
  .deck-title {
    padding: 0 18px;
    font-size: 11px;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3, #84978f);
  }

  .deck-top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 18px;
  }
  .deck-count { font-size: 12px; color: var(--ink-3, #84978f); font-weight: 650; }
  .deck-count b { color: var(--ink, #0e2a21); font-size: 14px; font-weight: 800; }
  .deck-done { font-size: 12px; font-weight: 700; color: #075b42; }
  .deck-progress {
    flex: 1;
    height: 5px;
    border-radius: 999px;
    background: #e1e9e5;
    overflow: hidden;
  }
  .deck-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #087451, #18b77d);
    transition: width 0.4s cubic-bezier(0.22, 0.8, 0.24, 1);
  }

  .deck-dots {
    display: flex;
    gap: 6px;
    justify-content: center;
    flex-wrap: wrap;
    padding: 0 18px;
  }
  .dot {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1.5px solid #d5dfda;
    background: #fff;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1), background 0.2s, border-color 0.2s;
  }
  .dot:active { transform: scale(0.9); }
  .dot.edit { border-color: #e6a11a; background: #fff1cf; }
  .dot.done { border-color: #0b9a68; background: #0b9a68; }
  .dot.on { border-color: #075b42; background: #075b42; transform: scale(1.2); }

  /* ── Swipe track (native scroll-snap) ──────────────────── */
  .track {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    gap: 10px;
    padding: 2px 5% 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar { display: none; }

  .slide {
    flex: 0 0 90%;
    min-width: 0;
    display: flex;
    scroll-snap-align: center;
    scroll-snap-stop: always;
  }
  .card {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    border-radius: 24px;
    background: #fff;
    box-shadow: 0 1px 0 #e3ebe7, 0 18px 34px -22px rgba(7, 43, 31, 0.45);
    transition: transform 0.25s cubic-bezier(0.22, 0.8, 0.24, 1), opacity 0.25s;
  }
  /* Neighbour cards peek in, dimmed and not tappable */
  .slide:not(.active) .card {
    opacity: 0.55;
    transform: scale(0.965);
    pointer-events: none;
  }
  .card.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #84978f;
  }

  /* ── Actions ───────────────────────────────────────────── */
  .deck-actions {
    display: grid;
    grid-template-columns: 48px 1fr 48px;
    gap: 8px;
    padding: 0 14px;
  }
  .nav {
    border: 1px solid #e3ebe7;
    background: #fff;
    color: #466158;
    border-radius: 16px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .nav:disabled { opacity: 0.35; cursor: not-allowed; }
  .nav:active:not(:disabled) { transform: scale(0.94); }

  .primary {
    border: none;
    background: linear-gradient(135deg, #087451, #0b9a68);
    color: #fff;
    border-radius: 16px;
    font: inherit;
    font-size: 15px;
    font-weight: 780;
    letter-spacing: -0.01em;
    cursor: pointer;
    padding: 16px;
    box-shadow: 0 12px 24px -12px rgba(7, 116, 81, 0.65);
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .primary:active:not(:disabled) { transform: scale(0.98); }
  .primary:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }

  .deck-hint {
    text-align: center;
    font-size: 11px;
    color: #84978f;
    font-weight: 600;
    padding: 0 14px 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .card, .dot, .nav, .primary, .deck-progress span { transition: none; }
  }
</style>