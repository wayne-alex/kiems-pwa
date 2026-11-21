<script>
  import { createEventDispatcher } from 'svelte';
  import FormAManagmentPage from '$lib/services/forms-tracking/TrackFormPage.svelte';

  const dispatch = createEventDispatcher();
</script>

<FormAManagmentPage on:back={() => dispatch('back')} />