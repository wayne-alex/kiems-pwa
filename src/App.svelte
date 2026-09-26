<script>
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  import HomePage from './routes/HomePage.svelte';
  import EntryPage from './routes/EntryPage.svelte';
  import MovementPage from './routes/MovementPage.svelte';
  import BindModal from './components/BindModal.svelte';

  import { session, resolveSession } from './lib/session.js';
  import { initOffline } from './lib/offline.js';

  let route = 'home';
  const goHome = () => (route = 'home');

  $: unbound = $session.status === 'unbound';

  onMount(async () => {
    initOffline();
    await resolveSession();
  });
</script>

<div class="app-shell">
  {#key route}
    <div in:fade={{ duration: 180 }}>
      {#if route === 'home'}
        <HomePage on:navigate={(e) => (route = e.detail)} />
      {:else if route === 'entry'}
        <EntryPage on:back={goHome} />
      {:else}
        <MovementPage on:back={goHome} />
      {/if}
    </div>
  {/key}

  {#if unbound}
    <BindModal on:bound={() => resolveSession()} />
  {/if}
</div>

<style>
  /* unchanged from before */
  .app-shell {
    max-width: 440px;
    margin: 0 auto;
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--paper);
    position: relative;
  }

  @media (min-width: 500px) {
    :global(body) { background: #ECEDE9; padding: 32px 0; }
    .app-shell {
      min-height: calc(100vh - 64px);
      border-radius: 32px;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.05),
        0 30px 80px rgba(0,0,0,.09),
        0 8px 24px rgba(0,0,0,.05);
    }
  }
</style>