<script>
  import { createEventDispatcher } from 'svelte';
  import ReferencePage from '$lib/services/reference/ReferencePage.svelte';

  const dispatch = createEventDispatcher();
</script>

<ReferencePage category="training" title="Training" on:back={() => dispatch('back')} />