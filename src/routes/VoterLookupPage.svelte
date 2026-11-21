<script>
  import { createEventDispatcher } from 'svelte';
  import VoterLookupScreen from '$lib/services/voter-lookup/VoterLookupPage.svelte';

  const dispatch = createEventDispatcher();
</script>

<VoterLookupScreen on:back={() => dispatch('back')} />