<script>
  import { createEventDispatcher } from 'svelte';
  import TodayReportPage from '$lib/services/reports/TodayReportPage.svelte';

  const dispatch = createEventDispatcher();
</script>

<TodayReportPage
  on:back={() => dispatch('back')}
  on:navigate={(e) => dispatch('navigate', e.detail)}
/>