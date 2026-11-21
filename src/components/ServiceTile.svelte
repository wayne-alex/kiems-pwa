<script>
  import { createEventDispatcher } from 'svelte';

  export let service;
  export let icons = {};
  export let isComplete = () => false;
  export let subOf = () => '';
  export let showHints = false;

  const dispatch = createEventDispatcher();

  $: done = !!(service.stats && service.stats.total > 0 && isComplete(service.stats));
  $: pending = !!(service.live && service.stats && service.stats.total && !done);
  $: hint = service.hint ?? subOf(service);
  $: showSub = !service.live || !!service.stats || showHints;

  function onClick(e) {
    dispatch('open', { service, el: e.currentTarget });
  }
</script>

<button
  class="tile {service.tone}"
  class:soon={!service.live}
  class:done
  on:click={onClick}
  aria-label={service.live ? `${service.label}${hint ? ' — ' + hint : ''}` : `${service.label}, coming soon`}
  data-card={service.id}
>
  <span class="ic">
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
         stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {#each icons[service.icon] || [] as d}<path {d} />{/each}
    </svg>

    {#if service.badge}
      <span class="badge">{service.badge}</span>
    {:else if done}
      <span class="tick" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="#fff"
             stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12.5L10 17.5L19 7" />
        </svg>
      </span>
    {:else if pending}
      <i class="flag" aria-hidden="true"></i>
    {/if}
  </span>

  <span class="label">{service.label}</span>
  {#if showSub}
    <span class="hint" class:ok={done}>{hint}</span>
  {/if}
</button>

<style>
  .tile {
    --t: var(--green, #0a9d6e);
    --tl: var(--green-l, #e3f6ee);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 7px;
    padding: 8px 2px 6px;
    border: 0;
    background: transparent;
    cursor: pointer;
    min-width: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .tile.blue   { --t: var(--blue, #2f6fe0);   --tl: var(--blue-l, #e7f0ff); }
  .tile.purple { --t: var(--purple, #6a4cd8); --tl: var(--purple-l, #eeeaff); }
  .tile.red    { --t: var(--red, #e23b3b);    --tl: var(--red-l, #ffe8e8); }
  .tile.amber  { --t: var(--amber, #ef9400);  --tl: var(--amber-l, #fff2dc); }
  .tile.teal   { --t: var(--teal, #0e9aa7);   --tl: var(--teal-l, #def6f8); }
  .tile.pink   { --t: var(--pink, #d6397f);   --tl: var(--pink-l, #ffe6f1); }
  .tile.slate  { --t: var(--slate, #4d5d73);  --tl: var(--slate-l, #e9eef4); }

  .tile:focus-visible { outline: 2px solid var(--t); outline-offset: 2px; border-radius: 18px; }

  .ic {
    position: relative;
    width: 54px;
    height: 54px;
    border-radius: 19px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--t);
    background:
      linear-gradient(150deg, rgba(255, 255, 255, 0.75) 0%, rgba(255, 255, 255, 0) 60%),
      var(--tl);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.9),
      0 10px 16px -12px var(--t);
    transition: transform 0.18s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .tile:active .ic { transform: scale(0.9); }
  .tile.soon .ic { opacity: 0.55; filter: grayscale(0.4); }

  .flag {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ff5a2a;
    border: 2.5px solid #fff;
  }
  .tick {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: #12b67f;
    border: 2px solid #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .badge {
    position: absolute;
    top: -5px;
    right: -7px;
    min-width: 18px;
    padding: 3px 5px;
    border-radius: 999px;
    background: var(--navy, #0e1f3f);
    color: #fff;
    font-size: 9.5px;
    font-weight: 800;
    line-height: 1;
    text-align: center;
    border: 2px solid #fff;
  }

  .label {
    max-width: 100%;
    font-size: 12px;
    font-weight: 750;
    letter-spacing: -0.015em;
    line-height: 1.2;
    color: var(--navy, #0e1f3f);
    text-align: center;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding: 0 2px;
  }
  .tile.soon .label { color: var(--ink-2, #5c6a82); }

  .hint {
    margin-top: -2px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--slate-l, #e9eef4);
    font-size: 10.5px;
    font-weight: 700;
    color: var(--ink-2, #5c6a82);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint.ok { background: var(--green-l, #e3f6ee); color: var(--green-d, #067552); }

  @media (prefers-reduced-motion: reduce) {
    .ic { transition: none; }
  }
</style>