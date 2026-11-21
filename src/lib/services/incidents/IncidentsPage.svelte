<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import { session } from '$lib/session.js';
  import { apiFetch } from '$lib/core/net.js';
  import { Cache } from '$lib/core/db.js';
  import { enqueue, subscribeQueue } from '$lib/core/queue.js';
  import { drainQueue } from '$lib/core/sync.js';
  import SyncBadge from '$lib/../components/SyncBadge.svelte';
  import PageTransition from '$lib/../components/PageTransition.svelte';
  import { compressImage } from './photo.js';
  import { getPosition } from './geo.js';

  const dispatch = createEventDispatcher();

  const KINDS = [
    { id: 'KIT_FAULT', label: 'Kit fault', hint: 'Broken or malfunctioning kit',
      icon: ['M12 3L22 20H2Z', 'M12 10V14', 'M12 17.2V17.3'] },
    { id: 'KIT_MISSING', label: 'Kit missing', hint: 'Kit not at its station',
      icon: ['M21 8L12 3L3 8L12 13Z', 'M3 8V16L12 21L21 16V8', 'M12 13V21'] },
    { id: 'SECURITY', label: 'Security', hint: 'Safety concern at the station',
      icon: ['M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z'] },
    { id: 'NETWORK', label: 'Network', hint: 'Signal or connectivity problem',
      icon: ['M2 9A15 15 0 0 1 22 9', 'M5.5 12.5A10 10 0 0 1 18.5 12.5', 'M9 16A5 5 0 0 1 15 16', 'M12 19.5V19.6'] },
    { id: 'SUPPLIES', label: 'Supplies', hint: 'Missing forms or materials',
      icon: ['M7 3.5H15L19 7.5V20.5A1 1 0 0 1 18 21.5H7A1 1 0 0 1 6 20.5V4.5A1 1 0 0 1 7 3.5Z', 'M15 3.5V7.5H19', 'M9 13H16', 'M9 17H14'] },
    { id: 'OTHER', label: 'Other', hint: 'Anything else',
      icon: ['M6 12V12.1', 'M12 12V12.1', 'M18 12V12.1'] },
  ];

  const SEVERITIES = [
    { id: 'LOW', label: 'Low', hint: 'Just so you know' },
    { id: 'MEDIUM', label: 'Medium', hint: 'Needs attention today' },
    { id: 'HIGH', label: 'High', hint: 'Blocking work' },
  ];

  // Tap-to-fill phrases (edit freely)
  const QUICK = {
    KIT_FAULT: ["Won't switch on", 'Fingerprint scanner not working', 'Screen is damaged', "Battery won't charge"],
    KIT_MISSING: ['Not delivered to the station', 'Taken away without notice', 'Cannot find the kit'],
    SECURITY: ['Threats or intimidation', 'Unauthorised people at the station', 'Theft or loss of equipment', 'Station is not safe to work in'],
    NETWORK: ['No signal at the station', 'Signal is very weak', 'Data bundle has finished', 'Sync keeps failing'],
    SUPPLIES: ['Forms have run out', 'Printer paper has run out', 'Stationery is missing', 'Charger or power bank is missing'],
    OTHER: [],
  };

  // ── Form state ────────────────────────────────────────────
  let kind = null;
  let severity = 'MEDIUM';
  let kitId = '';
  let description = '';

  let photoPreviewUrl = null;
  let photoCompressed = null; // { blob, ext, size }
  let photoBusy = false;
  let cameraInput;
  let galleryInput;

  let gps = null;
  let gpsState = 'loading'; // loading | ok | none

  let kits = [];
  let kitsLoading = false;

  // ── Page state ────────────────────────────────────────────
  let phase = 'idle'; // idle | submitting | done | error
  let errorMsg = '';
  let summary = null;

  // queue (for delivery status + waiting banner)
  let snap = { ops: [], online: true };
  const unsub = subscribeQueue((s) => (snap = s));

  let sentOpId = null;
  let delivered = false;
  let opSeen = false;

  const tick = (ms = 10) => {
    try { navigator.vibrate?.(ms); } catch { /* ignore */ }
  };

  const pad = (n) => String(n).padStart(2, '0');
  const localIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // ── Derived ───────────────────────────────────────────────
  $: needsSetup = $session.status === 'unbound';
  $: kindObj = KINDS.find((k) => k.id === kind) || null;
  $: sevObj = SEVERITIES.find((s) => s.id === severity) || SEVERITIES[1];

  $: descOk = description.trim().length >= 3;
  $: ready = !!$session.ward?.id && !!$session.fingerprint;
  $: valid = !!kind && descOk && ready;
  $: missing = [!kind && 'what happened', !descOk && 'a short description'].filter(Boolean);

  $: quick = kind ? (QUICK[kind] || []).filter((q) => !description.includes(q)) : [];

  $: kitOptions = kits.map((k) => ({
    id: String(k.kit_id),
    label: `${k.kit_name} · ${k.serial_no}`,
  }));
  $: kitRecommended = kind === 'KIT_FAULT' || kind === 'KIT_MISSING';

  // incidents still waiting to send
  $: waiting = snap.ops.filter((o) => o.kind === 'incident.submit' && o.state !== 'done');
  $: waitingFailed = waiting.filter((o) => o.state === 'gaveup').length;

  // delivery status of the one just submitted
  $: myOp = sentOpId ? snap.ops.find((o) => o.id === sentOpId) : null;
  $: if (myOp) opSeen = true;
  $: if (sentOpId && opSeen && !myOp) delivered = true;
  $: delivery = !sentOpId
    ? ''
    : delivered ? 'sent'
    : myOp?.state === 'gaveup' ? 'failed'
    : !snap.online ? 'offline'
    : myOp?.state === 'retry' ? 'retrying'
    : 'sending';

  // ── Data ──────────────────────────────────────────────────
  async function loadKits() {
    if (!$session.ward?.id || !$session.fingerprint) return;
    kitsLoading = true;
    const today = localIso();
    try {
      const row = await Cache.get(`entry:${$session.ward.id}:${today}`);
      if (row?.value?.kits) kits = row.value.kits;
    } catch { /* ignore */ }
    try {
      const res = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${today}`,
      );
      if (Array.isArray(res.kits)) kits = res.kits;
    } catch { /* ignore */ }
    kitsLoading = false;
  }

  async function fetchGps() {
    gpsState = 'loading';
    try {
      const g = await Promise.race([
        getPosition(),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ]);
      gps = g || null;
      gpsState = g ? 'ok' : 'none';
    } catch {
      gps = null;
      gpsState = 'none';
    }
  }

  // ── Photo ─────────────────────────────────────────────────
  const extOf = (f) =>
    (String(f.name || '').split('.').pop() || String(f.type || '').split('/')[1] || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 5) || 'jpg';

  async function onPhotoPicked(ev) {
    const input = ev.currentTarget;
    const file = input.files?.[0];
    input.value = ''; // lets the same file be picked again later
    if (!file) return;

    photoCompressed = null;
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(file);

    photoBusy = true;
    try {
      photoCompressed = await compressImage(file);
    } catch (err) {
      console.warn('[incident] compression failed, using original:', err);
      photoCompressed = { blob: file, ext: extOf(file), size: file.size };
    } finally {
      photoBusy = false;
    }
  }

  function removePhoto() {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = null;
    photoCompressed = null;
    photoBusy = false;
  }

  // ── Form helpers ──────────────────────────────────────────
  function pickKind(id) {
    kind = id;
    tick(5);
  }

  function addQuick(text) {
    const d = description.trim();
    const next = d ? `${d}${/[.!?]$/.test(d) ? ' ' : '. '}${text}` : text;
    description = next.slice(0, 1000);
    tick(5);
  }

  // ── Submit ────────────────────────────────────────────────
  async function submit() {
    if (!valid || phase === 'submitting' || photoBusy) return;
    phase = 'submitting';
    errorMsg = '';
    tick(8);

    // Use the location if it is ready. Wait at most 2.5s for it, never block the report.
    if (!gps) {
      const g = await Promise.race([
        getPosition().catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (g) {
        gps = g;
        gpsState = 'ok';
      }
    }

    const payload = {
      fingerprint: $session.fingerprint,
      kind,
      severity,
      ward_id: $session.ward.id,
      kit_id: kitId || undefined,
      description: description.trim(),
      lat: gps?.lat,
      lng: gps?.lng,
      accuracy: gps?.accuracy,
      photo: photoCompressed?.blob,
      photo_name: photoCompressed ? `incident.${photoCompressed.ext}` : undefined,
    };

    try {
      const op = await enqueue('incident.submit', payload);
      sentOpId = op.id;
      delivered = false;
      opSeen = false;
      summary = {
        kind: kindObj?.label,
        severity: sevObj.label,
        sev: severity.toLowerCase(),
        photo: !!photoCompressed,
        gps: !!gps,
      };
      tick([12, 40, 12]);
      phase = 'done';

      drainQueue()
        .then((r) => {
          if (r && r.sent > 0 && r.stillQueued === 0) delivered = true;
        })
        .catch(() => {});
    } catch (err) {
      phase = 'error';
      errorMsg = err.message || 'Could not save incident.';
    }
  }

  function reset() {
    kind = null;
    severity = 'MEDIUM';
    kitId = '';
    description = '';
    removePhoto();
    sentOpId = null;
    delivered = false;
    opSeen = false;
    summary = null;
    errorMsg = '';
    phase = 'idle';
    fetchGps();
  }

  onMount(() => {
    loadKits();
    fetchGps(); // start early so it is ready when they tap Report
  });

  onDestroy(() => {
    unsub();
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  });
</script>

<PageTransition>
  <div class="ip">
    <header class="hero">
      <div class="hero-top">
        <button class="glass-btn" on:click={() => dispatch('back')} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <div class="hero-meta">
          <div class="hero-title">Report an incident</div>
          <div class="hero-sub">
            {$session.ward?.name || 'Your ward'}{#if $session.constituency} · {$session.constituency.name}{/if}
          </div>
        </div>
        <div class="sync-wrap"><SyncBadge /></div>
      </div>
    </header>

    <div class="sheet">
      {#if needsSetup}
        <div class="scroll">
          <div class="state">
            <div class="state-ic">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7A4 4 0 0 1 16 7V10" />
              </svg>
            </div>
            <h3>Set up this device first</h3>
            <p>Choose your ward on the home screen, then you can report incidents.</p>
            <button class="btn" on:click={() => dispatch('back')}>Back to home</button>
          </div>
        </div>

      {:else if phase === 'done'}
        <div class="scroll">
          <div class="success" in:fly={{ y: -10, duration: 220, easing: cubicOut }}>
            <div class="tick">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
                   stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.5L10 17.5L19 7" />
              </svg>
            </div>
            <h2>Incident reported</h2>

            <div class="delivery {delivery}">
              {#if delivery === 'sending'}
                <span class="spinner"></span> Sending to ICT…
              {:else if delivery === 'sent'}
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
                Sent to ICT
              {:else if delivery === 'offline'}
                Saved on this device. It will send when you're back online.
              {:else if delivery === 'retrying'}
                Couldn't send yet. Retrying automatically.
              {:else if delivery === 'failed'}
                Couldn't send. Tap the sync badge at the top to retry.
              {/if}
            </div>

            {#if summary}
              <div class="sum">
                <span class="sum-chip">{summary.kind}</span>
                <span class="sum-chip sev-{summary.sev}">{summary.severity}</span>
                {#if summary.photo}<span class="sum-chip">Photo</span>{/if}
                {#if summary.gps}<span class="sum-chip">Location</span>{/if}
              </div>
            {/if}

            <button class="cta solid" on:click={() => dispatch('back')}>Done</button>
            <button class="ghost" on:click={reset}>Report another</button>
          </div>
        </div>

      {:else}
        <div class="scroll">
          {#if waiting.length > 0}
            <div class="waiting" class:bad={waitingFailed > 0}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7V12L15 14" />
              </svg>
              {#if waitingFailed > 0}
                {waitingFailed} earlier incident{waitingFailed === 1 ? '' : 's'} couldn't be sent. Tap the sync badge to retry.
              {:else}
                {waiting.length} earlier incident{waiting.length === 1 ? ' is' : 's are'} waiting to send.
              {/if}
            </div>
          {/if}

          <!-- What happened -->
          <div class="label">What happened?</div>
          <div class="kinds" role="radiogroup" aria-label="Incident type">
            {#each KINDS as k (k.id)}
              <button
                class="kind"
                class:on={kind === k.id}
                role="radio"
                aria-checked={kind === k.id}
                on:click={() => pickKind(k.id)}
              >
                <span class="kind-ic">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                       stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                    {#each k.icon as d}<path {d} />{/each}
                  </svg>
                </span>
                <span class="kind-label">{k.label}</span>
              </button>
            {/each}
          </div>
          {#if kindObj}
            <div class="kind-hint">{kindObj.hint}</div>
          {/if}

          <!-- How serious -->
          <div class="label">How serious?</div>
          <div class="sevs" role="radiogroup" aria-label="Severity">
            {#each SEVERITIES as s (s.id)}
              <button
                class="sev {s.id.toLowerCase()}"
                class:on={severity === s.id}
                role="radio"
                aria-checked={severity === s.id}
                on:click={() => { severity = s.id; tick(5); }}
              >
                <span class="sev-dot"></span>
                <span class="sev-label">{s.label}</span>
                <span class="sev-hint">{s.hint}</span>
              </button>
            {/each}
          </div>

          <!-- Kit -->
          <div class="label">
            Which kit? <span class="opt">{kitRecommended ? '(recommended)' : '(optional)'}</span>
          </div>
          <label class="select">
            <svg class="lead" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                 stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 8L12 3L3 8L12 13Z" /><path d="M3 8V16L12 21L21 16V8" /><path d="M12 13V21" />
            </svg>
            <select bind:value={kitId} disabled={kitsLoading && kits.length === 0}>
              <option value="">{kitsLoading && kits.length === 0 ? 'Loading kits…' : 'No specific kit'}</option>
              {#each kitOptions as k (k.id)}
                <option value={k.id}>{k.label}</option>
              {/each}
            </select>
            <svg class="caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9L12 15L18 9" /></svg>
          </label>

          <!-- Describe -->
          <div class="label">Describe it</div>
          {#if quick.length}
            <div class="quick">
              {#each quick as q (q)}
                <button class="q" on:click={() => addQuick(q)}>+ {q}</button>
              {/each}
            </div>
          {/if}
          <label class="area">
            <textarea
              bind:value={description}
              placeholder="What happened? Where? Anything ICT needs to know."
              rows="4"
              maxlength="1000"
              autocapitalize="sentences"
            ></textarea>
            {#if description.length > 0}
              <span class="count" class:warn={description.length > 900}>{description.length}/1000</span>
            {/if}
          </label>

          <!-- Photo -->
          <div class="label">Photo <span class="opt">(optional)</span></div>
          <input bind:this={cameraInput} type="file" accept="image/*" capture="environment"
                 class="file-input" on:change={onPhotoPicked} />
          <input bind:this={galleryInput} type="file" accept="image/*"
                 class="file-input" on:change={onPhotoPicked} />

          {#if photoPreviewUrl}
            <div class="photo">
              <img src={photoPreviewUrl} alt="Attached to this incident" />
              <div class="photo-status">
                {#if photoBusy}Compressing…{:else if photoCompressed}{Math.round(photoCompressed.size / 1024)} KB{/if}
              </div>
              <button class="photo-x" on:click={removePhoto} aria-label="Remove photo">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="2.4" stroke-linecap="round"><path d="M6 6L18 18M18 6L6 18" /></svg>
              </button>
            </div>
          {:else}
            <div class="photo-btns">
              <button class="pbtn" on:click={() => cameraInput.click()}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 8H6L8 5H16L18 8H21A1 1 0 0 1 22 9V19A1 1 0 0 1 21 20H3A1 1 0 0 1 2 19V9A1 1 0 0 1 3 8Z" />
                  <circle cx="12" cy="14" r="4" />
                </svg>
                Take photo
              </button>
              <button class="pbtn" on:click={() => galleryInput.click()}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <circle cx="9" cy="10" r="1.8" /><path d="M21 16L15.5 11L6 20" />
                </svg>
                From gallery
              </button>
            </div>
          {/if}

          <!-- Location -->
          <div class="gps {gpsState}">
            {#if gpsState === 'loading'}
              <span class="spinner"></span> Getting your location…
            {:else if gpsState === 'ok' && gps}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2" />
              </svg>
              Location captured (±{Math.round(gps.accuracy || 0)} m)
            {:else}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8V13" /><path d="M12 16.5V16.6" />
              </svg>
              No location. You can still report.
              <button class="retry" on:click={fetchGps}>Retry</button>
            {/if}
          </div>

          {#if phase === 'error'}
            <div class="error" role="alert">{errorMsg}</div>
          {/if}
        </div>

        <div class="savebar">
          <button class="cta" disabled={!valid || phase === 'submitting' || photoBusy} on:click={submit}>
            {#if phase === 'submitting'}
              Saving…
            {:else if photoBusy}
              Preparing photo…
            {:else}
              Report incident
            {/if}
          </button>
          <div class="hint" class:ask={!valid && missing.length > 0}>
            {#if !valid && missing.length > 0}
              Add {missing.join(' and ')}
            {:else}
              Incidents are sent before other reports, so ICT sees them first.
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</PageTransition>

<style>
  .ip {
    --bg: #f6f8fb;
    --card: #fff;
    --ink: #0e1f3f;
    --ink-2: #5c6a82;
    --ink-3: #8c97aa;
    --line: #edf0f5;
    --red: #e23b3b;
    --red-d: #b23a32;
    --red-l: #ffe8e8;
    --green: #0a9d6e;
    --green-l: #e3f6ee;
    --amber: #ef9400;
    --amber-l: #fff2dc;
    --slate-l: #e9eef4;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1a0608;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    overscroll-behavior: none;
  }

  /* ── Hero ───────────────────────────────────────────── */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 38px;
    color: #fff;
    background:
      radial-gradient(110% 120% at 100% -10%, rgba(255, 120, 120, 0.36), transparent 50%),
      radial-gradient(80% 100% at -10% 110%, rgba(140, 20, 40, 0.32), transparent 55%),
      linear-gradient(150deg, #1e0509 0%, #4a0a15 58%, #6c1420 100%);
  }
  .hero-top { display: flex; align-items: center; gap: 11px; }
  .hero-meta { flex: 1; min-width: 0; }
  .hero-title { font-size: clamp(21px, 6vw, 26px); font-weight: 780; letter-spacing: -0.045em; line-height: 1.05; }
  .hero-sub {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.72);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sync-wrap { display: inline-flex; align-items: center; flex-shrink: 0; }
  .glass-btn {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 13px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    cursor: pointer;
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
  .glass-btn:active { transform: scale(0.94); }

  /* ── Sheet ──────────────────────────────────────────── */
  .sheet {
    position: relative;
    flex: 1;
    min-height: 0;
    margin-top: -24px;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
  }

  .label {
    margin: 22px 2px 10px;
    font-size: 11px;
    font-weight: 780;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .scroll > .label:first-child,
  .waiting + .label { margin-top: 2px; }
  .opt { font-size: 10px; font-weight: 650; letter-spacing: 0.02em; text-transform: none; color: var(--ink-3); }

  .waiting {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 18px;
    padding: 11px 13px;
    border-radius: 16px;
    background: var(--amber-l);
    color: #8f5a00;
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.4;
  }
  .waiting svg { flex-shrink: 0; }
  .waiting.bad { background: var(--red-l); color: var(--red-d); }

  /* ── Kinds ──────────────────────────────────────────── */
  .kinds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .kind {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 14px 6px 12px;
    border: 1.5px solid var(--line);
    border-radius: 20px;
    background: var(--card);
    font: inherit;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(14, 31, 63, 0.04);
    transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.14s var(--ease);
  }
  .kind:active { transform: scale(0.97); }
  .kind-ic {
    width: 44px;
    height: 44px;
    border-radius: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--slate-l);
    color: #4d5d73;
    transition: background 0.16s var(--ease), color 0.16s var(--ease);
  }
  .kind-label { font-size: 12.5px; font-weight: 720; letter-spacing: -0.015em; color: var(--ink); }
  .kind.on { border-color: var(--red); background: #fff6f6; }
  .kind.on .kind-ic { background: var(--red); color: #fff; }
  .kind-hint { margin: 10px 4px 0; font-size: 12.5px; font-weight: 600; color: var(--red-d); }

  /* ── Severity ───────────────────────────────────────── */
  .sevs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .sev {
    --c: #8c97aa;
    --cl: #e9eef4;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 12px 6px;
    border: 1.5px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    font: inherit;
    cursor: pointer;
    transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.14s var(--ease);
  }
  .sev:active { transform: scale(0.97); }
  .sev.low { --c: var(--green); --cl: var(--green-l); }
  .sev.medium { --c: var(--amber); --cl: var(--amber-l); }
  .sev.high { --c: var(--red); --cl: var(--red-l); }
  .sev-dot { width: 10px; height: 10px; margin-bottom: 4px; border-radius: 50%; background: var(--c); }
  .sev-label { font-size: 13px; font-weight: 750; color: var(--ink); }
  .sev-hint { font-size: 10.5px; line-height: 1.25; text-align: center; color: var(--ink-3); }
  .sev.on { border-color: var(--c); background: var(--cl); }
  .sev.on .sev-dot { box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); }

  /* ── Fields ─────────────────────────────────────────── */
  .select {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border: 1.5px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease);
  }
  .select:focus-within { border-color: var(--red); box-shadow: 0 0 0 4px rgba(226, 59, 59, 0.1); }
  .select .lead { color: var(--ink-3); flex-shrink: 0; }
  .select .caret { color: var(--ink-3); flex-shrink: 0; pointer-events: none; }
  .select select {
    flex: 1;
    min-width: 0;
    padding: 15px 0;
    border: 0;
    outline: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    color: var(--ink);
    font: inherit;
    font-size: 14.5px;
    font-weight: 600;
  }

  .quick { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
  .q {
    padding: 8px 12px;
    border: 0;
    border-radius: 999px;
    background: var(--slate-l);
    color: #34445c;
    font: inherit;
    font-size: 12.5px;
    font-weight: 650;
    cursor: pointer;
    transition: transform 0.14s var(--ease), background 0.16s var(--ease);
  }
  .q:active { transform: scale(0.96); background: #dde4ed; }

  .area {
    position: relative;
    display: block;
    border: 1.5px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease);
  }
  .area:focus-within { border-color: var(--red); box-shadow: 0 0 0 4px rgba(226, 59, 59, 0.1); }
  .area textarea {
    display: block;
    width: 100%;
    min-height: 104px;
    padding: 14px 14px 26px;
    border: 0;
    outline: 0;
    border-radius: 18px;
    background: transparent;
    resize: vertical;
    color: var(--ink);
    font: inherit;
    font-size: 15.5px;
    line-height: 1.5;
    -webkit-user-select: text;
    user-select: text;
  }
  .area textarea::placeholder { color: #a3adbd; }
  .count { position: absolute; right: 12px; bottom: 8px; font-size: 10.5px; font-weight: 650; color: var(--ink-3); pointer-events: none; }
  .count.warn { color: var(--red-d); }

  /* ── Photo ──────────────────────────────────────────── */
  .file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    left: -9999px;
  }
  .photo-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pbtn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 18px 10px;
    border: 1.5px dashed #cfd6e2;
    border-radius: 20px;
    background: var(--card);
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.16s var(--ease), transform 0.14s var(--ease);
  }
  .pbtn:active { background: #f1f4f8; transform: scale(0.98); }

  .photo {
    position: relative;
    border-radius: 20px;
    overflow: hidden;
    background: var(--slate-l);
    box-shadow: 0 12px 24px -16px rgba(14, 31, 63, 0.4);
  }
  .photo img { display: block; width: 100%; max-height: 300px; object-fit: cover; }
  .photo-status {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(14, 31, 63, 0.7);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .photo-status:empty { display: none; }
  .photo-x {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: rgba(14, 31, 63, 0.7);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }

  /* ── Location ───────────────────────────────────────── */
  .gps {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 16px;
    padding: 10px 13px;
    border-radius: 14px;
    background: var(--slate-l);
    color: var(--ink-2);
    font-size: 12.5px;
    font-weight: 650;
  }
  .gps.ok { background: var(--green-l); color: #067552; }
  .gps svg { flex-shrink: 0; }
  .retry {
    margin-left: auto;
    padding: 4px 8px;
    border: 0;
    background: none;
    color: var(--red-d);
    font: inherit;
    font-size: 12.5px;
    font-weight: 750;
    cursor: pointer;
  }

  .error {
    margin-top: 14px;
    padding: 11px 13px;
    border-radius: 14px;
    background: var(--red-l);
    color: var(--red-d);
    font-size: 12.5px;
    font-weight: 650;
  }

  /* ── Save bar ───────────────────────────────────────── */
  .savebar {
    flex: none;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    background: rgba(255, 255, 255, 0.96);
    border-top: 1px solid var(--line);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  .cta {
    width: 100%;
    padding: 15px 16px;
    border: 0;
    border-radius: 16px;
    background: linear-gradient(135deg, #e23b3b, #b0202f);
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 760;
    letter-spacing: -0.01em;
    cursor: pointer;
    box-shadow: 0 14px 26px -14px rgba(226, 59, 59, 0.7);
    transition: transform 0.15s var(--ease);
  }
  .cta:active:not(:disabled) { transform: scale(0.985); }
  .cta:disabled { background: #cbd2de; box-shadow: none; cursor: not-allowed; }
  .cta.solid { background: linear-gradient(135deg, #087451, #0b9a68); box-shadow: 0 14px 26px -14px rgba(7, 116, 81, 0.7); }
  .hint { margin-top: 8px; text-align: center; font-size: 11.5px; font-weight: 600; color: var(--ink-3); }
  .hint.ask { color: var(--red-d); font-weight: 700; }

  /* ── Success ────────────────────────────────────────── */
  .success { padding: 34px 6px 10px; text-align: center; }
  .tick {
    width: 72px;
    height: 72px;
    margin: 0 auto 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--green-l);
    color: #067552;
  }
  .success h2 { margin: 0 0 14px; font-size: 22px; font-weight: 800; letter-spacing: -0.04em; }
  .delivery {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    max-width: 320px;
    margin: 0 auto;
    padding: 12px 16px;
    border-radius: 16px;
    background: var(--slate-l);
    color: #34445c;
    font-size: 13.5px;
    font-weight: 650;
    line-height: 1.4;
  }
  .delivery.sent { background: var(--green-l); color: #067552; }
  .delivery.offline, .delivery.retrying { background: var(--amber-l); color: #8f5a00; }
  .delivery.failed { background: var(--red-l); color: var(--red-d); }

  .sum { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin: 18px 0 26px; }
  .sum-chip {
    padding: 6px 11px;
    border-radius: 999px;
    background: #fff;
    border: 1px solid var(--line);
    font-size: 12px;
    font-weight: 700;
    color: var(--ink-2);
  }
  .sum-chip.sev-low { background: var(--green-l); border-color: transparent; color: #067552; }
  .sum-chip.sev-medium { background: var(--amber-l); border-color: transparent; color: #8f5a00; }
  .sum-chip.sev-high { background: var(--red-l); border-color: transparent; color: var(--red-d); }

  .success .cta { max-width: 340px; margin: 0 auto; display: block; }
  .ghost {
    display: block;
    width: 100%;
    max-width: 340px;
    margin: 10px auto 0;
    padding: 14px;
    border: 0;
    border-radius: 16px;
    background: #fff;
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--ink-2);
    font: inherit;
    font-size: 14px;
    font-weight: 720;
    cursor: pointer;
  }
  .ghost:active { background: #f6f8fb; }

  /* ── State ──────────────────────────────────────────── */
  .state { padding: 54px 20px; text-align: center; color: var(--ink-2); }
  .state-ic {
    width: 60px;
    height: 60px;
    margin: 0 auto 16px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--red-l);
    color: var(--red);
  }
  .state h3 { margin: 0 0 6px; font-size: 18px; font-weight: 780; letter-spacing: -0.03em; color: var(--ink); }
  .state p { margin: 0 0 18px; font-size: 13.5px; line-height: 1.55; }
  .btn {
    padding: 12px 20px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: #fff;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    cursor: pointer;
  }

  .spinner {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .kind, .sev, .select, .area, .cta, .q, .pbtn { transition: none; }
    .spinner { animation-duration: 1.6s; }
  }
</style>