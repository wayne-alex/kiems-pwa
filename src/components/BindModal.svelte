<script>
  import { apiUrl } from "../lib/config.js";
  import { createEventDispatcher } from "svelte";
  import { session, bindToWard, sessionValue } from "../lib/session.js";
  import { fetchWards } from "../lib/wards.js";

  const dispatch = createEventDispatcher();

  // Constituencies are pre-rendered by Django if you want, but
  // easier: fetch them once via /api/constituencies/ — see note at bottom.
  // For now we accept an empty list and require the user to pick ward directly.
  // (We'll add a real constituency fetch below.)

  let constituencies = [];
  let wards = [];
  let selectedConstituency = "";
  let selectedWard = "";
  let loadingConstituencies = true;
  let loadingWards = false;
  let binding = false;
  let errorMsg = "";

   onMount(async () => {
    try {
      const res = await fetch(apiUrl('/api/constituencies/'), {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        constituencies = data.constituencies || [];
      }
    } catch {
      constituencies = [];
    } finally {
      loadingConstituencies = false;
    }
  });

  async function onConstituencyChange() {
    selectedWard = "";
    wards = [];
    if (!selectedConstituency) return;
    loadingWards = true;
    try {
      wards = await fetchWards(selectedConstituency);
    } catch (e) {
      errorMsg = e.message;
    } finally {
      loadingWards = false;
    }
  }

  async function onBind() {
    if (!selectedWard) {
      errorMsg = "Please select a ward.";
      return;
    }
    binding = true;
    errorMsg = "";
    try {
      const s = sessionValue();
      await bindToWard({
        wardId: selectedWard,
        constituencyId: selectedConstituency,
        fingerprint: s.fingerprint,
      });
      dispatch("bound");
    } catch (e) {
      errorMsg = e.message || "Could not bind.";
    } finally {
      binding = false;
    }
  }

  import { onMount } from "svelte";
</script>

<div class="overlay">
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="bind-title"
  >
    <div class="grabber"></div>

    <div class="badge">
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M12 2.5 L4.5 6 V12 C4.5 16.5 8 20.5 12 21.5 C16 20.5 19.5 16.5 19.5 12 V6 Z"
        />
        <path d="M9 12.2 L11.2 14.4 L15.2 9.6" />
      </svg>
    </div>

    <h2 id="bind-title" class="title">Set up this device</h2>
    <p class="subtitle">
      Pick your constituency and ward to link this device. You only do this once
      — every subsequent launch picks up automatically.
    </p>

    <div class="field">
      <label for="constituency">Constituency</label>
      <select
        id="constituency"
        bind:value={selectedConstituency}
        on:change={onConstituencyChange}
        disabled={loadingConstituencies || binding}
      >
        <option value="">
          {loadingConstituencies ? "Loading…" : "Select constituency"}
        </option>
        {#each constituencies as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </div>

    <div class="field">
      <label for="ward">Ward</label>
      <select
        id="ward"
        bind:value={selectedWard}
        disabled={!selectedConstituency || loadingWards || binding}
      >
        <option value="">
          {loadingWards
            ? "Loading…"
            : selectedConstituency
              ? "Select ward"
              : "Select constituency first"}
        </option>
        {#each wards as w (w.id)}
          <option value={w.id}>{w.name}</option>
        {/each}
      </select>
    </div>

    {#if errorMsg}
      <div class="err">{errorMsg}</div>
    {/if}

    <button class="cta" on:click={onBind} disabled={!selectedWard || binding}>
      {binding ? "Binding…" : "Continue"}
    </button>

    <p class="tiny">If your ward isn't listed, contact your ICT officer.</p>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(10, 10, 10, 0.5);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    animation: fadein 0.2s var(--ease) both;
  }
  .sheet {
    width: 100%;
    max-width: 440px;
    background: var(--surface);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    padding: 12px 24px calc(24px + env(safe-area-inset-bottom));
    animation: rise 0.35s var(--ease) both;
    text-align: left;
  }
  .grabber {
    width: 36px;
    height: 4px;
    border-radius: 3px;
    background: var(--hairline-2);
    margin: 0 auto 20px;
  }

  .badge {
    width: 44px;
    height: 44px;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
    margin-bottom: 14px;
  }
  .title {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.025em;
    color: var(--ink);
    margin: 0 0 6px;
  }
  .subtitle {
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.5;
    margin: 0 0 20px;
  }

  .field {
    margin-bottom: 14px;
  }
  .field label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-3);
    margin-bottom: 6px;
  }
  .field select {
    width: 100%;
    padding: 12px 14px;
    border: 1.5px solid var(--hairline-2);
    border-radius: 12px;
    background: var(--surface);
    font-size: 14px;
    font-family: inherit;
    color: var(--ink);
    appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%),
      linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50%;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    transition: border-color 0.2s var(--ease);
  }
  .field select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .field select:disabled {
    background-color: var(--paper-2);
    color: var(--ink-3);
    cursor: not-allowed;
  }

  .err {
    background: #fbe8e6;
    color: var(--danger);
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 12.5px;
    margin-bottom: 12px;
  }

  .cta {
    width: 100%;
    padding: 15px;
    border: none;
    border-radius: 14px;
    background: var(--ink);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition:
      transform 0.2s var(--ease),
      opacity 0.2s var(--ease);
    margin-bottom: 12px;
  }
  .cta:active:not(:disabled) {
    transform: scale(0.98);
  }
  .cta:disabled {
    background: var(--ink-4);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .tiny {
    font-size: 11px;
    color: var(--ink-3);
    text-align: center;
    margin: 0;
  }

  @media (min-width: 500px) {
    .overlay {
      align-items: center;
    }
    .sheet {
      border-radius: var(--r-xl);
      max-width: 400px;
      padding: 24px 24px 20px;
    }
  }
</style>
