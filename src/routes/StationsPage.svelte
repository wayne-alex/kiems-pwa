<script>
  import { createEventDispatcher } from 'svelte';
  import StationsService from '$lib/services/stations/StationsPage.svelte';

  const dispatch = createEventDispatcher();
</script>

<StationsService on:back={() => dispatch('back')} />