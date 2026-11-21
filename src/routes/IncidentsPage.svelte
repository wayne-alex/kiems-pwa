<script>
  import { createEventDispatcher } from 'svelte';
  import IncidentsForm from '$lib/services/incidents/IncidentsPage.svelte';

  const dispatch = createEventDispatcher();
</script>

<IncidentsForm on:back={() => dispatch('back')} />