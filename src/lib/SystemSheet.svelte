<script>
  import { onDestroy } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { OpLog, Meta, Errors } from "$lib/core/db.js";
  import { discardOp, retryOp, subscribeQueue } from "$lib/core/queue.js";
  import { drainQueue } from "$lib/core/sync.js";

  export let open = false;
  export let onClose = () => {};

  let tab = "now"; // now | queue | failed | history | diagnostics
  let snap = { online: true, pending: 0, retrying: 0, gaveup: 0, lastSync: 0, ops: [] };
  let oplog = [];
  let diag = null;
  let busy = false;
  let expandedOp = null;
  let confirmId = null;
  let confirmTimer;
  let copied = false;

  // live clock (only runs while the sheet is open)
  let now = Date.now();
  let clock = null;
  let wasOpen = false;

  // swipe-down to close
  let startY = null;
  let dragY = 0;

  const unsub = subscribeQueue((s) => (snap = s));

  $: syncOpen(open);
  function syncOpen(o) {
    if (o && !wasOpen) {
      tab = "now";
      expandedOp = null;
      confirmId = null;
      now = Date.now();
      clock = setInterval(() => (now = Date.now()), 1000);
    }
    if (!o && wasOpen) {
      clearInterval(clock);
      clock = null;
      dragY = 0;
      startY = null;
    }
    wasOpen = o;
  }

  onDestroy(() => {
    unsub();
    clearInterval(clock);
    clearTimeout(confirmTimer);
  });

  // ── Derived ──────────────────────────────────────────────
  $: queueOps = snap.ops
    .filter((o) => o.state === "queued" || o.state === "retry" || o.state === "sending")
    .sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10) || a.createdAt - b.createdAt);

  $: failedOps = snap.ops.filter((o) => o.state === "gaveup");

  // Same precedence as the header badge: failed > offline > pending > ok
  $: mode =
    snap.gaveup > 0 ? "attention"
    : !snap.online ? "offline"
    : snap.pending > 0 ? "pending"
    : "ok";

  $: headline =
    mode === "attention" ? `${snap.gaveup} change${snap.gaveup === 1 ? "" : "s"} could not be sent`
    : mode === "offline" ? "You are offline"
    : mode === "pending" ? `${snap.pending} change${snap.pending === 1 ? "" : "s"} waiting to send`
    : "Everything is synced";

  $: subline =
    mode === "attention" ? "Open the Failed tab to retry or discard"
    : mode === "offline"
      ? snap.pending > 0
        ? `${snap.pending} saved on this device. They send when you are back online.`
        : "New changes are saved on this device and sent later."
    : mode === "pending" ? (snap.retrying > 0 ? `${snap.retrying} retrying` : "Sending when ready")
    : snap.lastSync ? `Last sync ${fmtRelative(snap.lastSync, now)}` : "No changes waiting";

  $: tabs = [
    { id: "now", label: "Now" },
    { id: "queue", label: "Queue", n: queueOps.length },
    { id: "failed", label: "Failed", n: snap.gaveup, warn: true },
    { id: "history", label: "History" },
    { id: "diagnostics", label: "Diagnostics" },
  ];

  // ── Data loaders ─────────────────────────────────────────
  async function loadHistory() {
    const all = await OpLog.all();
    oplog = all.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 100);
  }

  // `serviceWorker.ready` never resolves in dev (no SW registered), so give up quickly
  async function swReg() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((r) => setTimeout(() => r(null), 800)),
      ]);
    } catch {
      return null;
    }
  }

  async function loadDiagnostics() {
    const reg = await swReg();
    const meta = {
      lastSync: await Meta.get("lastSync", 0),
      swActive: !!navigator.serviceWorker?.controller,
      bgSyncSupported: !!reg?.sync,
      online: navigator.onLine,
      queueCount: snap.pending,
    };
    const errors = await Errors.all();
    diag = { meta, errors: errors.slice(-20).reverse() };
  }

  // ── Actions ──────────────────────────────────────────────
  async function syncNow() {
    busy = true;
    try {
      await drainQueue();
    } finally {
      busy = false;
    }
    if (tab === "history") await loadHistory();
  }

  async function onRetry(id) {
    await retryOp(id);
    syncNow();
  }

  // two-step discard (no native confirm popup)
  async function onDiscard(id) {
    if (confirmId === id) {
      clearTimeout(confirmTimer);
      confirmId = null;
      await discardOp(id);
      return;
    }
    confirmId = id;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => (confirmId = null), 3000);
  }

  function goTab(t) {
    tab = t;
    if (t === "history") loadHistory();
    if (t === "diagnostics") loadDiagnostics();
  }

  async function copyReport() {
    if (!diag) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ ...diag, pending: snap.pending, failed: snap.gaveup, at: new Date().toISOString() }, null, 2),
      );
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch { /* clipboard may be blocked */ }
  }

  // ── Swipe to close ───────────────────────────────────────
  function dragStart(e) { startY = e.touches[0].clientY; }
  function dragMove(e) {
    if (startY === null) return;
    dragY = Math.max(0, e.touches[0].clientY - startY);
  }
  function dragEnd() {
    if (dragY > 90) onClose();
    dragY = 0;
    startY = null;
  }

  // ── Formatting ───────────────────────────────────────────
  function fmtTime(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });
  }

  function fmtRelative(ms, ref = Date.now()) {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((ref - ms) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  const shortId = (id) => (id || "").slice(0, 8);

  const KIND = {
    "entry.submit": { label: "Registration entries", tone: "green" },
    "movement.save": { label: "Movement plan", tone: "blue" },
    "verify.tally": { label: "Tally verify", tone: "teal" },
    "incident.submit": { label: "Incident", tone: "red" },
  };
  const kindLabel = (k) => KIND[k]?.label || k;
  const kindTone = (k) => KIND[k]?.tone || "slate";

  function describe(kind, p = {}) {
    p = p || {};
    switch (kind) {
      case "entry.submit": {
        const n = p.entries?.length || 0;
        return `${n} kit${n === 1 ? "" : "s"}${p.date ? " · " + p.date : ""}`;
      }
      case "movement.save": {
        const n = p.entries?.length || 0;
        return `${n} venue${n === 1 ? "" : "s"}${p.schedule_date ? " · " + p.schedule_date : ""}`;
      }
      case "verify.tally":
        return p.date || "";
      case "incident.submit":
        return [p.kind, p.severity].filter(Boolean).join(" · ");
      default:
        return "";
    }
  }

  function stateLabel(op, ref) {
    if (op.state === "sending") return "Sending";
    if (op.state === "retry") {
      const s = Math.round(((op.nextRetryAt || 0) - ref) / 1000);
      return s > 0 ? `Retry in ${s}s` : "Retrying…";
    }
    return "Waiting";
  }
</script>

<svelte:window on:keydown={(e) => open && e.key === "Escape" && onClose()} />

{#if open}
  <div class="overlay" transition:fade={{ duration: 160 }} on:click={onClose} role="presentation">
    <div
      class="sheet"
      class:dragging={startY !== null}
      style="transform: translateY({dragY}px)"
      transition:fly={{ y: 40, duration: 280, easing: cubicOut }}
      on:click|stopPropagation
      role="dialog"
      aria-modal="true"
      aria-label="Sync and status"
      tabindex="-1"
    >
      <div class="grab" on:touchstart|passive={dragStart} on:touchmove|passive={dragMove} on:touchend={dragEnd}>
        <span></span>
      </div>

      <header class="head">
        <h2>Sync &amp; status</h2>
        <span class="chip {mode}"><i></i>{mode === "ok" ? "Synced" : mode === "pending" ? "Pending" : mode === "offline" ? "Offline" : "Needs attention"}</span>
        <button class="close" on:click={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round"><path d="M6 6L18 18M18 6L6 18" /></svg>
        </button>
      </header>

      <nav class="tabs" role="tablist">
        {#each tabs as t (t.id)}
          <button class="tab" class:on={tab === t.id} role="tab" aria-selected={tab === t.id}
                  on:click={() => goTab(t.id)}>
            {t.label}
            {#if t.n}<span class="count" class:warn={t.warn}>{t.n}</span>{/if}
          </button>
        {/each}
      </nav>

      <div class="body">
        <!-- ═════════ NOW ═════════ -->
        {#if tab === "now"}
          <div class="status {mode}">
            <span class="status-ic">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
                   stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                {#if mode === "ok"}
                  <path d="M5 12.5L10 17.5L19 7" />
                {:else if mode === "pending"}
                  <path d="M20 12A8 8 0 1 1 12 4" /><path d="M20 4V10H14" />
                {:else if mode === "offline"}
                  <path d="M3 3L21 21" /><path d="M8.5 16.5A5 5 0 0 1 15 12" />
                  <path d="M5 12A10 10 0 0 1 9 7" /><path d="M17 12A10 10 0 0 0 15.5 9" />
                {:else}
                  <path d="M12 3L22 20H2Z" /><path d="M12 10V14" /><path d="M12 17.2V17.3" />
                {/if}
              </svg>
            </span>
            <div class="status-text">
              <div class="status-title">{headline}</div>
              <div class="status-sub">{subline}</div>
            </div>
          </div>

          <div class="stats">
            <div class="stat">
              <div class="stat-num">{snap.pending}</div>
              <div class="stat-label">Pending</div>
            </div>
            <div class="stat">
              <div class="stat-num">{snap.retrying}</div>
              <div class="stat-label">Retrying</div>
            </div>
            <div class="stat">
              <div class="stat-num" class:bad={snap.gaveup > 0}>{snap.gaveup}</div>
              <div class="stat-label">Failed</div>
            </div>
          </div>

          <div class="meta">
            <span>Last sync</span>
            <b>{fmtRelative(snap.lastSync, now)}{snap.lastSync ? ` · ${fmtTime(snap.lastSync)}` : ""}</b>
          </div>

          <button class="cta" on:click={syncNow} disabled={busy || !snap.online}>
            {#if busy}<span class="spin"></span>Syncing…{:else}Sync now{/if}
          </button>
          {#if !snap.online}
            <p class="note">Connect to the internet to sync.</p>
          {/if}

        <!-- ═════════ QUEUE ═════════ -->
        {:else if tab === "queue"}
          {#if queueOps.length === 0}
            <div class="empty">
              <span class="empty-ic ok">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                     stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
              </span>
              <p>Nothing queued.</p>
            </div>
          {:else}
            {#each queueOps as op (op.id)}
              <div class="op" class:retry={op.state === "retry"} class:sending={op.state === "sending"}>
                <button type="button" class="op-row" aria-expanded={expandedOp === op.id}
                        on:click={() => (expandedOp = expandedOp === op.id ? null : op.id)}>
                  <span class="op-ic {kindTone(op.kind)}">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 19V5" /><path d="M5 12L12 5L19 12" />
                    </svg>
                  </span>
                  <span class="op-main">
                    <span class="op-kind">{kindLabel(op.kind)}</span>
                    <span class="op-meta">{describe(op.kind, op.payload) || "#" + shortId(op.id)}</span>
                  </span>
                  <span class="pill {op.state}">{stateLabel(op, now)}</span>
                  <svg class="chev" class:open={expandedOp === op.id} viewBox="0 0 24 24" width="16" height="16"
                       fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                </button>

                {#if expandedOp === op.id}
                  <div class="op-detail">
                    <div class="kv">
                      <div><b>ID</b><span class="mono">#{shortId(op.id)}</span></div>
                      <div><b>Attempts</b><span>{op.attempts || 0}</span></div>
                      <div><b>Queued</b><span>{fmtRelative(op.createdAt, now)}</span></div>
                    </div>
                    {#if op.lastError}<div class="op-err">{op.lastError}</div>{/if}
                    <pre class="payload">{JSON.stringify(op.payload, null, 2)}</pre>
                    <div class="op-actions">
                      <button class="mini" on:click={() => onRetry(op.id)}>Retry now</button>
                      <button class="mini danger" on:click={() => onDiscard(op.id)}>
                        {confirmId === op.id ? "Tap again to discard" : "Discard"}
                      </button>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          {/if}

        <!-- ═════════ FAILED ═════════ -->
        {:else if tab === "failed"}
          {#if failedOps.length === 0}
            <div class="empty">
              <span class="empty-ic ok">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                     stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5L10 17.5L19 7" /></svg>
              </span>
              <p>No failed changes.</p>
            </div>
          {:else}
            {#each failedOps as op (op.id)}
              <div class="op failed">
                <div class="op-row static">
                  <span class="op-ic red">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 3L22 20H2Z" /><path d="M12 10V14" /><path d="M12 17.2V17.3" />
                    </svg>
                  </span>
                  <span class="op-main">
                    <span class="op-kind">{kindLabel(op.kind)}</span>
                    <span class="op-meta">{describe(op.kind, op.payload)}{describe(op.kind, op.payload) ? " · " : ""}{op.attempts} attempt{op.attempts === 1 ? "" : "s"}</span>
                  </span>
                </div>
                {#if op.lastError}<div class="op-err">{op.lastError}</div>{/if}
                <div class="op-actions">
                  <button class="mini" on:click={() => onRetry(op.id)}>Retry</button>
                  <button class="mini danger" on:click={() => onDiscard(op.id)}>
                    {confirmId === op.id ? "Tap again to discard" : "Discard"}
                  </button>
                </div>
              </div>
            {/each}
          {/if}

        <!-- ═════════ HISTORY ═════════ -->
        {:else if tab === "history"}
          {#if oplog.length === 0}
            <div class="empty"><p>No history yet.</p></div>
          {:else}
            <div class="list">
              {#each oplog as rec (rec.id)}
                <div class="hist">
                  <span class="hdot {rec.outcome}"></span>
                  <div class="hist-body">
                    <div class="hist-kind">{kindLabel(rec.kind)}</div>
                    <div class="hist-meta">
                      {describe(rec.kind, rec.payloadSummary)}{describe(rec.kind, rec.payloadSummary) ? " · " : ""}{fmtRelative(rec.finishedAt, now)}
                    </div>
                  </div>
                  <span class="pill {rec.outcome}">{rec.outcome === "ok" ? "Sent" : rec.outcome === "discarded" ? "Discarded" : "Failed"}</span>
                </div>
              {/each}
            </div>
          {/if}

        <!-- ═════════ DIAGNOSTICS ═════════ -->
        {:else if tab === "diagnostics"}
          {#if diag}
            <div class="list kvlist">
              <div><b>Online</b><span>{diag.meta.online ? "Yes" : "No"}</span></div>
              <div><b>Last sync</b><span>{fmtRelative(diag.meta.lastSync, now)}</span></div>
              <div><b>Queued</b><span>{diag.meta.queueCount}</span></div>
              <div><b>Service worker</b><span>{diag.meta.swActive ? "Active" : "Not active"}</span></div>
              <div><b>Background sync</b><span>{diag.meta.bgSyncSupported ? "Supported" : "Unsupported"}</span></div>
            </div>

            <div class="sec-head">
              <h4>Recent errors</h4>
              <button class="mini" on:click={copyReport}>{copied ? "Copied" : "Copy report"}</button>
            </div>
            {#if diag.errors.length === 0}
              <div class="empty small"><p>No errors.</p></div>
            {:else}
              {#each diag.errors as err}
                <div class="err">
                  <div class="err-msg">{err.message}</div>
                  <div class="err-meta">{fmtRelative(err.ts, now)} · {JSON.stringify(err.context)}</div>
                </div>
              {/each}
            {/if}
          {:else}
            <div class="empty"><p>Loading…</p></div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 240; /* above the profile sheet (220) */
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(14, 31, 63, 0.45);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .sheet {
    width: 100%;
    max-width: 480px;
    max-height: 88dvh;
    display: flex;
    flex-direction: column;
    background: #f6f8fb;
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -24px 60px rgba(14, 31, 63, 0.3);
    color: #0e1f3f;
    transition: transform 0.22s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .sheet.dragging { transition: none; }

  .grab { padding: 12px 0 8px; display: flex; justify-content: center; flex: none; }
  .grab span { width: 38px; height: 5px; border-radius: 3px; background: #d6dde8; }

  /* ── Header ─────────────────────────────────────────── */
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 18px 12px;
  }
  .head h2 {
    flex: 1;
    margin: 0;
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.035em;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 750;
    background: #e3f6ee;
    color: #067552;
  }
  .chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip.pending { background: #fff2dc; color: #8f5a00; }
  .chip.attention { background: #ffe8e8; color: #b23a32; }
  .chip.offline { background: #e9eef4; color: #4d5d73; }
  .close {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 0;
    background: #e9eef4;
    color: #4d5d73;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .close:active { background: #dde4ed; }

  /* ── Tabs ───────────────────────────────────────────── */
  .tabs {
    flex: none;
    display: flex;
    gap: 6px;
    padding: 0 14px 10px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 13px;
    border: 1px solid #edf0f5;
    border-radius: 999px;
    background: #fff;
    color: #5c6a82;
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.16s, color 0.16s;
  }
  .tab.on { background: #0e1f3f; border-color: #0e1f3f; color: #fff; }
  .count {
    min-width: 18px;
    padding: 2px 6px;
    border-radius: 999px;
    background: #e9eef4;
    color: #4d5d73;
    font-size: 10.5px;
    font-weight: 800;
    line-height: 1.2;
    text-align: center;
  }
  .tab.on .count { background: rgba(255, 255, 255, 0.2); color: #fff; }
  .count.warn { background: #ffe8e8; color: #b23a32; }
  .tab.on .count.warn { background: #e23b3b; color: #fff; }

  .body {
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 16px calc(24px + env(safe-area-inset-bottom));
  }

  /* ── Now ────────────────────────────────────────────── */
  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px;
    border-radius: 22px;
    color: #fff;
    background: linear-gradient(135deg, #0cae7b, #056548);
    box-shadow: 0 18px 30px -20px rgba(5, 101, 72, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }
  .status.pending { background: linear-gradient(135deg, #f0a21a, #c47a00); box-shadow: 0 18px 30px -20px rgba(196, 122, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.25); }
  .status.attention { background: linear-gradient(135deg, #ea5a4f, #b23a32); box-shadow: 0 18px 30px -20px rgba(178, 58, 50, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.25); }
  .status.offline { background: linear-gradient(135deg, #6b7c93, #46566b); box-shadow: 0 18px 30px -20px rgba(70, 86, 107, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.2); }
  .status-ic {
    width: 48px;
    height: 48px;
    border-radius: 16px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.2);
  }
  .status-title { font-size: 16px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.2; }
  .status-sub { margin-top: 4px; font-size: 12.5px; opacity: 0.9; line-height: 1.35; }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 12px;
  }
  .stat {
    padding: 12px 8px;
    border-radius: 16px;
    background: #fff;
    border: 1px solid #edf0f5;
    text-align: center;
  }
  .stat-num { font-size: 22px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .stat-num.bad { color: #e23b3b; }
  .stat-label { margin-top: 5px; font-size: 11px; font-weight: 650; color: #8c97aa; }

  .meta {
    display: flex;
    justify-content: space-between;
    margin-top: 12px;
    padding: 13px 14px;
    border-radius: 16px;
    background: #fff;
    border: 1px solid #edf0f5;
    font-size: 12.5px;
    color: #5c6a82;
  }
  .meta b { color: #0e1f3f; font-weight: 700; }

  .cta {
    width: 100%;
    margin-top: 12px;
    padding: 15px;
    border: 0;
    border-radius: 16px;
    background: linear-gradient(135deg, #087451, #0b9a68);
    color: #fff;
    font: inherit;
    font-size: 14.5px;
    font-weight: 780;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    box-shadow: 0 12px 24px -12px rgba(7, 116, 81, 0.7);
    transition: transform 0.16s cubic-bezier(0.22, 0.8, 0.24, 1);
  }
  .cta:active:not(:disabled) { transform: scale(0.985); }
  .cta:disabled { background: #cbd6d1; box-shadow: none; cursor: not-allowed; }
  .note { margin: 10px 0 0; text-align: center; font-size: 12px; color: #8c97aa; }

  .spin {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Lists ──────────────────────────────────────────── */
  .empty { text-align: center; padding: 34px 10px; color: #8c97aa; font-size: 13px; }
  .empty.small { padding: 16px 10px; }
  .empty p { margin: 0; }
  .empty-ic {
    width: 52px;
    height: 52px;
    margin: 0 auto 12px;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty-ic.ok { background: #e3f6ee; color: #0a9d6e; }

  .op {
    margin-bottom: 10px;
    border-radius: 18px;
    background: #fff;
    border: 1px solid #edf0f5;
    overflow: hidden;
  }
  .op.retry { border-color: #fbe0b0; }
  .op.sending { border-color: #bfe8d6; }
  .op.failed { border-color: #ffcdcd; }

  .op-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 12px;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .op-row.static { cursor: default; }
  .op-row:active:not(.static) { background: #f6f8fb; }
  .op-ic {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #e9eef4;
    color: #4d5d73;
  }
  .op-ic.green { background: #e3f6ee; color: #0a9d6e; }
  .op-ic.blue { background: #e7f0ff; color: #2f6fe0; }
  .op-ic.teal { background: #def6f8; color: #0e9aa7; }
  .op-ic.red { background: #ffe8e8; color: #e23b3b; }

  .op-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .op-kind { font-size: 13.5px; font-weight: 750; letter-spacing: -0.02em; }
  .op-meta {
    font-size: 11.5px;
    color: #8c97aa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev { flex-shrink: 0; color: #8c97aa; transition: transform 0.18s ease; }
  .chev.open { transform: rotate(90deg); }

  .pill {
    flex-shrink: 0;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 750;
    background: #e9eef4;
    color: #4d5d73;
  }
  .pill.retry { background: #fff2dc; color: #8f5a00; }
  .pill.sending { background: #e3f6ee; color: #067552; }
  .pill.ok { background: #e3f6ee; color: #067552; }
  .pill.failed, .pill.discarded { background: #ffe8e8; color: #b23a32; }

  .op-detail { padding: 0 12px 12px; }
  .op-err {
    margin: 0 12px 4px;
    padding: 9px 11px;
    border-radius: 11px;
    background: #fff5f4;
    color: #b23a32;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
    word-break: break-word;
  }
  .op-detail .op-err { margin: 8px 0 0; }
  .payload {
    margin: 10px 0 0;
    padding: 10px;
    border-radius: 12px;
    background: #0e1f3f;
    color: #cfe9de;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    line-height: 1.5;
    overflow: auto;
    max-height: 180px;
  }
  .op-actions { display: flex; gap: 8px; padding: 10px 12px 12px; }
  .op-detail .op-actions { padding: 10px 0 0; }
  .mini {
    padding: 8px 13px;
    border: 0;
    border-radius: 11px;
    background: #fff;
    box-shadow: inset 0 0 0 1px #e3e8ef;
    color: #0e1f3f;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .mini:active { background: #f6f8fb; }
  .mini.danger { color: #b23a32; box-shadow: inset 0 0 0 1px #ffcdcd; }

  .list {
    border-radius: 18px;
    background: #fff;
    border: 1px solid #edf0f5;
    overflow: hidden;
  }
  .hist { display: flex; align-items: center; gap: 11px; padding: 12px 14px; }
  .hist + .hist { border-top: 1px solid #edf0f5; }
  .hdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #b9c2d0; }
  .hdot.ok { background: #0b9a68; }
  .hdot.failed, .hdot.discarded { background: #e23b3b; }
  .hist-body { flex: 1; min-width: 0; }
  .hist-kind { font-size: 13px; font-weight: 700; letter-spacing: -0.02em; }
  .hist-meta {
    margin-top: 2px;
    font-size: 11.5px;
    color: #8c97aa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kv { display: grid; gap: 7px; padding-top: 4px; }
  .kv > div { display: flex; justify-content: space-between; font-size: 12.5px; }
  .kv b { color: #5c6a82; font-weight: 600; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .kvlist > div { display: flex; justify-content: space-between; padding: 13px 14px; font-size: 13px; }
  .kvlist > div + div { border-top: 1px solid #edf0f5; }
  .kvlist b { color: #5c6a82; font-weight: 600; }
  .kvlist span { font-weight: 700; }

  .sec-head { display: flex; align-items: center; justify-content: space-between; margin: 18px 2px 10px; }
  h4 { margin: 0; font-size: 14px; font-weight: 800; letter-spacing: -0.02em; }

  .err {
    padding: 11px 12px;
    margin-bottom: 8px;
    border-radius: 14px;
    background: #fff;
    border: 1px solid #ffcdcd;
  }
  .err-msg { font-size: 12.5px; color: #b23a32; font-weight: 650; line-height: 1.4; word-break: break-word; }
  .err-meta { margin-top: 4px; font-size: 10.5px; color: #8c97aa; word-break: break-all; }

  @media (prefers-reduced-motion: reduce) {
    .sheet, .tab, .cta, .chev { transition: none; }
    .spin { animation-duration: 1.6s; }
  }
</style>