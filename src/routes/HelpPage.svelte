<script>
  import { createEventDispatcher } from 'svelte';
  import ReferencePage from '$lib/services/reference/ReferencePage.svelte';

  const dispatch = createEventDispatcher();
</script>

<ReferencePage category="help" title="Help" on:back={() => dispatch('back')} />