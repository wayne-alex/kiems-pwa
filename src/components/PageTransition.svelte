<script>
  import { onMount } from 'svelte';
  import { sourceCard, clearSourceCard } from '../lib/transition.js';

  /**
   * Wraps page content and, if a source card was captured on the last
   * navigation, animates the page in from that card's screen position
   * — like the card grew to fill the viewport.
   *
   * Also exposes a reverse "shrink back" animation on demand (for back nav).
   */

  let ref;
  let rect = null;
  let phase = 'init';   // 'init' | 'morphing' | 'settled'

  onMount(() => {
    // Read the source once and clear it, so a second mount doesn't retrigger
    let captured = null;
    const unsubscribe = sourceCard.subscribe((v) => { captured = v; });
    unsubscribe();

    if (!captured || !ref) {
      // No source — just settle in place
      phase = 'settled';
      return;
    }

    rect = captured;
    phase = 'morphing';

    // Next frame, kick off the transition to the "settled" position
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        phase = 'settled';
        // Clear after the transition would have finished
        setTimeout(() => {
          rect = null;
          clearSourceCard();
        }, 500);
      });
    });
  });

  $: isMorphing = phase === 'morphing' && rect;

  $: style = isMorphing
    ? `top: ${rect.top}px;
       left: ${rect.left}px;
       width: ${rect.width}px;
       height: ${rect.height}px;
       border-radius: ${rect.radius}px;`
    : '';
</script>

<div
  bind:this={ref}
  class="page-transition"
  class:morphing={isMorphing}
  class:settled={phase === 'settled'}
  style={style}
>
  <slot />
</div>

<style>
  .page-transition {
    /* The "settled" state is the normal full-page position */
    position: relative;
    width: 100%;
    min-height: 100vh;
    min-height: 100dvh;
  }

  /* When morphing, we pin the wrapper to the source rect coordinates
     so it visually starts as the card and grows into a full page. */
  .page-transition.morphing {
    position: fixed;
    z-index: 20;
    overflow: hidden;
    background: var(--paper, #f2f6f4);
    /* These transitions run when we flip from morphing → settled */
    transition:
      top .42s cubic-bezier(.22, .8, .24, 1),
      left .42s cubic-bezier(.22, .8, .24, 1),
      width .42s cubic-bezier(.22, .8, .24, 1),
      height .42s cubic-bezier(.22, .8, .24, 1),
      border-radius .42s cubic-bezier(.22, .8, .24, 1);
  }

  .page-transition.settled {
    position: relative;
    top: 0;
    left: 0;
    width: 100%;
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    border-radius: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .page-transition.morphing {
      transition: none;
    }
  }
</style>