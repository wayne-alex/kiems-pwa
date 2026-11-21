<script>
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  export let state = 'idle';
  // 'idle' | 'loading' | 'match' | 'drift' | 'big' | 'no-baseline' | 'error'
  export let data = null;      // the server response
  export let error = '';
  export let note = '';        // bindable — user's acknowledgment note
  export let acknowledged = false;
  export let onAcknowledge = () => {};

  $: requiresNote = state === 'drift' || state === 'big';
  $: canProceed =
    state === 'match' ||
    state === 'no-baseline' ||
    (requiresNote && acknowledged && note.trim().length >= 3);

  function labelOf(s) {
    switch (s) {
      case 'loading': return 'Verifying against our records…';
      case 'match': return 'Matches our records';
      case 'drift': return 'Small drift';
      case 'big': return 'Large drift';
      case 'no-baseline': return 'No baseline yet';
      case 'error': return error || 'Verification failed';
      default: return '';
    }
  }
</script>

{#if state !== 'idle'}
  <div class="result {state}" transition:fly={{ y: 8, duration: 220, easing: cubicOut }}>
    <div class="head">
      <div class="badge">
        {#if state === 'loading'}
          <span class="spin"></span>
        {:else if state === 'match'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="3.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.5 L10 17.5 L19 7" />
          </svg>
        {:else if state === 'drift' || state === 'big'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3 L22 20 H2 Z" />
            <path d="M12 10 V14" />
            <circle cx="12" cy="17.2" r="0.7" fill="currentColor" />
          </svg>
        {:else if state === 'no-baseline'}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8 V12 L14.5 13.5" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        {/if}
      </div>
      <div class="label">{labelOf(state)}</div>
    </div>

    {#if state !== 'loading' && data}
      <div class="facts">
        <div class="fact">
          <div class="k">Kit screen</div>
          <div class="v">{data.observed_total ?? '—'}</div>
        </div>
        <div class="fact">
          <div class="k">Our records</div>
          <div class="v">{data.expected_total ?? '—'}</div>
        </div>
        <div class="fact">
          <div class="k">Difference</div>
          <div class="v {data.delta > 0 ? 'up' : data.delta < 0 ? 'down' : ''}">
            {#if data.delta != null}
              {data.delta > 0 ? '+' : ''}{data.delta}
            {:else}
              —
            {/if}
          </div>
        </div>
      </div>

      {#if state === 'drift' || state === 'big'}
        <div class="hint">
          {#if state === 'drift'}
            This is small enough that a typo or a missed day is likely. Verify the kit screen and, if the number is correct, add a short note to proceed.
          {:else}
            This difference is large. Please re-check the kit screen and add a note explaining what you see before proceeding.
          {/if}
        </div>

        <div class="ack">
          <label class="ack-row">
            <input type="checkbox" bind:checked={acknowledged} />
            <span>I checked the kit and this number is correct</span>
          </label>

          {#if acknowledged}
            <textarea
              bind:value={note}
              placeholder="Short note (e.g. 'kit screen replaced after power cut')"
              rows="2"
              maxlength="200"
            ></textarea>
            <div class="chars">{note.length}/200</div>
          {/if}

          <button class="ack-btn" disabled={!canProceed} on:click={onAcknowledge}>
            Proceed with these numbers
          </button>
        </div>
      {:else if state === 'match'}
        <div class="hint">
          The kit screen matches our records. You can continue to the next kit.
        </div>
      {:else if state === 'no-baseline'}
        <div class="hint">
          This is the first verification for this kit today, so there's nothing to compare against yet. Future verifications will use this as a baseline.
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .result {
    margin-top: 12px;
    padding: 14px;
    border-radius: 16px;
    background: #fff;
    border: 1.5px solid var(--line, #e3ebe7);
    transition: border-color 0.2s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .result.loading { border-color: var(--line, #e3ebe7); }
  .result.match { border-color: #b9e8d1; background: #f1fbf6; }
  .result.drift { border-color: #f5d89b; background: #fffbf2; }
  .result.big { border-color: #f2bbb6; background: #fff5f4; }
  .result.no-baseline { border-color: #bfd7f4; background: #f4f9ff; }
  .result.error { border-color: #f2bbb6; background: #fff5f4; }

  .head { display: flex; align-items: center; gap: 10px; }
  .badge {
    width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    background: #fff;
    color: var(--ink-2, #466158);
    box-shadow: inset 0 0 0 1.5px var(--line, #e3ebe7);
  }
  .result.match .badge { color: #0b9a68; box-shadow: inset 0 0 0 1.5px #b9e8d1; }
  .result.drift .badge { color: #8f5a00; box-shadow: inset 0 0 0 1.5px #f5d89b; }
  .result.big .badge, .result.error .badge { color: #b23a32; box-shadow: inset 0 0 0 1.5px #f2bbb6; }
  .result.no-baseline .badge { color: #1e5fa8; box-shadow: inset 0 0 0 1.5px #bfd7f4; }

  .label {
    font-size: 14px; font-weight: 750; letter-spacing: -0.02em;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 12px;
  }
  .fact {
    padding: 10px;
    border-radius: 12px;
    background: #fff;
    border: 1px solid var(--line, #e3ebe7);
    text-align: center;
  }
  .fact .k {
    font-size: 10px;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-3, #84978f);
  }
  .fact .v {
    margin-top: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: var(--ink, #0e2a21);
  }
  .fact .v.up { color: #b23a32; }
  .fact .v.down { color: #1e5fa8; }

  .hint {
    margin-top: 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2, #466158);
  }

  .ack { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .ack-row {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 12.5px; line-height: 1.4; color: var(--ink, #0e2a21);
    cursor: pointer;
  }
  .ack-row input {
    margin-top: 2px; width: 18px; height: 18px; flex-shrink: 0;
    accent-color: #0b9a68;
  }
  textarea {
    width: 100%; box-sizing: border-box;
    padding: 10px 12px;
    border: 1.5px solid var(--line, #e3ebe7);
    border-radius: 12px;
    font: inherit; font-size: 13px;
    resize: vertical;
    background: #fff;
    color: var(--ink, #0e2a21);
  }
  textarea:focus {
    outline: none;
    border-color: #0b9a68;
    box-shadow: 0 0 0 4px rgba(11, 154, 104, 0.12);
  }
  .chars {
    text-align: right;
    font-size: 10.5px;
    color: var(--ink-3, #84978f);
  }
  .ack-btn {
    padding: 12px 14px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, #087451, #0b9a68);
    color: #fff;
    font: inherit; font-size: 13.5px; font-weight: 750;
    cursor: pointer;
    box-shadow: 0 10px 22px -10px rgba(7, 116, 81, 0.5);
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .ack-btn:active:not(:disabled) { transform: scale(0.98); }
  .ack-btn:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }

  .spin {
    width: 12px; height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>