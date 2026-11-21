<script>
  import { createEventDispatcher, onDestroy } from 'svelte';

  export let value = 0;
  export let label = '';
  export let tone = 'male';
  export let min = 0;
  export let max = 99999;
  export let step = 1;
  export let quick = [];
  export let compact = false;   // ← new

  const dispatch = createEventDispatcher();

  let inputEl = null;
  let typing = false;
  let draft = '';
  let holdTimer = null;
  let holdInterval = null;
  let held = false;
  let blurTimer = null;

  $: n = Number.isFinite(+value) ? +value : 0;

  function buzz(ms = 8) {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  }

  function clamp(v) {
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, Math.round(v)));
  }

  function set(v) {
    const next = clamp(v);
    if (next === n) return;
    value = next;
    dispatch('change', next);
    buzz();
  }

  const inc = () => set(n + step);
  const dec = () => set(n - step);

  function press(fn) {
    if (typing) commitType();
    clearHold();
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      fn();
      holdInterval = setInterval(fn, 70);
    }, 380);
  }

  function release(fn) {
    const wasHeld = held;
    clearHold();
    held = false;
    if (!wasHeld) fn();
  }

  function abort() { clearHold(); }

  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
  }

  function keyClick(e, fn) {
    if (e.detail === 0) fn();
  }

  function startType() {
    if (typing) return;
    typing = true;
    draft = String(n);
    setTimeout(() => {
      inputEl?.focus();
      inputEl?.select();
    }, 20);
  }

  function commitType() {
    if (!typing) return;
    const v = parseInt(draft, 10);
    if (Number.isFinite(v)) set(v);
    typing = false;
    draft = '';
  }

  function cancelType() {
    typing = false;
    draft = '';
  }

  function onBlur() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(commitType, 120);
  }

  onDestroy(() => {
    clearHold();
    clearTimeout(blurTimer);
  });
</script>

<div class="stepper {tone}" class:compact>
  <div class="top">
    <div class="label">{label}</div>
    {#if quick.length && !compact}
      <div class="quick">
        {#each quick as q}
          <button type="button" class="chip" on:click={() => set(n + q)} aria-label="Add {q} {label}">
            +{q}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="body">
    <button
      type="button"
      class="pad"
      disabled={n <= min}
      on:pointerdown={() => press(dec)}
      on:pointerup={() => release(dec)}
      on:pointerleave={abort}
      on:pointercancel={abort}
      on:click={(e) => keyClick(e, dec)}
      on:contextmenu|preventDefault
      aria-label="Decrease {label}"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="2.8" stroke-linecap="round">
        <path d="M6 12H18" />
      </svg>
    </button>

    <div
      class="num"
      role="button"
      tabindex="0"
      on:click={startType}
      on:keydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startType(); }
      }}
    >
      {#if typing}
        <input
          bind:this={inputEl}
          bind:value={draft}
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="off"
          on:blur={onBlur}
          on:keydown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitType(); }
            if (e.key === 'Escape') { e.preventDefault(); cancelType(); }
          }}
          aria-label="{label} count"
        />
      {:else}
        {n}
      {/if}
    </div>

    <button
      type="button"
      class="pad plus"
      disabled={n >= max}
      on:pointerdown={() => press(inc)}
      on:pointerup={() => release(inc)}
      on:pointerleave={abort}
      on:pointercancel={abort}
      on:click={(e) => keyClick(e, inc)}
      on:contextmenu|preventDefault
      aria-label="Increase {label}"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="2.8" stroke-linecap="round">
        <path d="M12 6V18M6 12H18" />
      </svg>
    </button>
  </div>
</div>

<style>
  .stepper {
    --tint: #e2edfa;
    --ink: #1e5fa8;
    --soft: rgba(30, 95, 168, 0.14);
    min-width: 0;
    overflow: hidden;
    border-radius: 18px;
    background: var(--tint);
    padding: 8px 10px 10px;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .stepper.female { --tint: #fbeae8; --ink: #b23a32; --soft: rgba(178, 58, 50, 0.14); }
  .stepper.neutral { --tint: #eef4f1; --ink: #466158; --soft: rgba(70, 97, 88, 0.14); }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .label {
    font-size: 11px;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink);
  }
  .quick { display: flex; gap: 6px; }
  .chip {
    padding: 4px 10px;
    border: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.75);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    font-weight: 750;
    cursor: pointer;
    touch-action: manipulation;
    transition: transform 0.14s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .chip:active { transform: scale(0.92); background: #fff; }

  .body {
    display: grid;
    grid-template-columns: 50px minmax(0, 1fr) 50px;
    gap: 8px;
    align-items: center;
  }
  .pad {
    width: 50px;
    height: 50px;
    border-radius: 15px;
    border: none;
    background: #fff;
    color: var(--ink);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    touch-action: manipulation;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04), 0 8px 16px -10px var(--ink);
    transition: transform 0.12s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .pad.plus { background: var(--ink); color: #fff; }
  .pad:active:not(:disabled) { transform: scale(0.92); }
  .pad:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; }
  .pad:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

  .num {
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 34px;
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1;
    color: #0b241c;
    text-align: center;
    cursor: text;
    padding: 4px 0;
    border-radius: 10px;
    overflow: hidden;
  }
  .num:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
  .num input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    font: inherit;
    text-align: center;
    color: inherit;
    padding: 0;
    -webkit-user-select: text;
    user-select: text;
  }

  @media (max-width: 360px) {
    .body { grid-template-columns: 46px minmax(0, 1fr) 46px; }
    .pad { width: 46px; height: 46px; }
    .num { font-size: 30px; }
  }
</style>