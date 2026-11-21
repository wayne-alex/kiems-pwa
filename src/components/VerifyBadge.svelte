<script>
  export let state = 'idle'; // 'idle' | 'loading' | 'match' | 'drift' | 'big' | 'no-baseline' | 'error'
  export let data = null;    // {delta, expected_total, ...}
  export let error = '';

  function label() {
    if (state === 'loading') return 'Verifying…';
    if (state === 'match') return 'Matches our records';
    if (state === 'drift') {
      const d = data?.delta ?? 0;
      return `${d > 0 ? '+' : ''}${d} vs expected`;
    }
    if (state === 'big') {
      const d = data?.delta ?? 0;
      return `Big drift: ${d > 0 ? '+' : ''}${d}`;
    }
    if (state === 'no-baseline') return 'No baseline yet';
    if (state === 'error') return error || 'Verify failed';
    return '';
  }
</script>

{#if state !== 'idle'}
  <div class="verify {state}" role="status">
    {#if state === 'loading'}
      <span class="spin"></span>
    {:else if state === 'match'}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
           stroke="currentColor" stroke-width="3.4"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12.5 L10 17.5 L19 7" />
      </svg>
    {:else if state === 'drift' || state === 'big'}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8 V13" />
        <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
      </svg>
    {:else if state === 'no-baseline'}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8 V12 L14.5 13.5" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 6 L18 18 M18 6 L6 18" />
      </svg>
    {/if}
    <span>{label()}</span>
  </div>
{/if}

<style>
  .verify {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  .verify.loading {
    background: #f4f7f6;
    color: #84978f;
  }
  .verify.match {
    background: #dcf3e7;
    color: #075b42;
  }
  .verify.drift {
    background: #fff1cf;
    color: #8f5a00;
  }
  .verify.big {
    background: #ffebe9;
    color: #b23a32;
  }
  .verify.no-baseline {
    background: #e2edfa;
    color: #1e5fa8;
  }
  .verify.error {
    background: #ffebe9;
    color: #b23a32;
  }
  .spin {
    width: 10px;
    height: 10px;
    border: 1.8px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>