<script>
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  export let percent = 0;
  export let size = 72;
  export let stroke = 7;
  export let label = '';
  export let sublabel = '';

  const uid = 'hr' + Math.random().toString(36).slice(2, 8);
  const p = tweened(0, { duration: 900, easing: cubicOut });

  $: p.set(Math.max(0, Math.min(100, percent)));
  $: r = (size - stroke) / 2;
  $: c = 2 * Math.PI * r;
  $: dash = ($p / 100) * c;
</script>

<div class="ring" style="width:{size}px;height:{size}px">
  <svg viewBox="0 0 {size} {size}" width={size} height={size} aria-hidden="true">
    <defs>
      <linearGradient id={uid} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#d6ffec" />
        <stop offset="1" stop-color="#6ff0b8" />
      </linearGradient>
    </defs>
    <circle cx={size / 2} cy={size / 2} r={r - stroke / 2 - 1} fill="rgba(255,255,255,0.08)" />
    <circle cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="rgba(255,255,255,0.2)" stroke-width={stroke} />
    {#if $p > 0.5}
      <circle
        class="arc"
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="url(#{uid})" stroke-width={stroke}
        stroke-linecap="round"
        transform="rotate(-90 {size / 2} {size / 2})"
        stroke-dasharray="{dash} {c}"
      />
    {/if}
  </svg>

  {#if label}
    <div class="center">
      <div class="lbl">{label}</div>
      {#if sublabel}<div class="sub">{sublabel}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .ring { position: relative; flex-shrink: 0; }
  svg { display: block; }
  .arc { filter: drop-shadow(0 0 5px rgba(111, 240, 184, 0.65)); }
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .lbl { font-size: 16px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .sub {
    margin-top: 3px;
    font-size: 8.5px;
    font-weight: 700;
    opacity: 0.8;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>