<script>
  import { createEventDispatcher } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import ListView from '$lib/services/announcements/AnnouncementsPage.svelte';
  import ReaderView from '$lib/services/announcements/AnnouncementReader.svelte';

  const dispatch = createEventDispatcher();

  let currentId = null;
  let list;

  function openArticle(e) {
    currentId = e.detail.id;
  }

  function closeReader() {
    currentId = null;
  }

  // reader tells us an article was read, so the list can clear its "New" dot
  function onRead(e) {
    list?.markSeen(e.detail.id);
  }
</script>

<!-- The list stays mounted underneath, so scroll position and loaded pages are kept -->
<ListView bind:this={list} on:back={() => dispatch('back')} on:open={openArticle} />

{#if currentId}
  <div class="layer" transition:fly={{ x: 48, duration: 260, easing: cubicOut, opacity: 0.2 }}>
    <ReaderView announcementId={currentId} on:back={closeReader} on:read={onRead} />
  </div>
{/if}

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: #fff;
  }
</style>