import { executeOp } from './ops.js';
import {
  getQueueSorted, markSuccess, markFailure, snapshot,
  subscribeQueue,
} from './queue.js';
import { Errors } from './db.js';

// ── Leader election across tabs ──────────────────────────────
// Only one tab drains at a time. Others wait and reflect state.
const CHANNEL_NAME = 'iebc:sync';
const TAB_ID = Math.random().toString(36).slice(2);

let channel = null;
let isLeader = false;
let leaderHeartbeat = null;
let leaderLastSeen = 0;

function initChannel() {
  if (typeof BroadcastChannel === 'undefined') {
    // No BC → assume we're leader
    isLeader = true;
    return;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);

  channel.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'leader-claim') {
      if (!isLeader && msg.tabId !== TAB_ID) {
        leaderLastSeen = Date.now();
      }
    } else if (msg.type === 'leader-heartbeat') {
      if (msg.tabId !== TAB_ID) leaderLastSeen = Date.now();
    } else if (msg.type === 'leader-resign') {
      if (!isLeader) tryClaimLeadership();
    } else if (msg.type === 'drain-request') {
      if (isLeader) drainQueue();
    }
  };

  // Try to claim leadership after a short delay
  setTimeout(tryClaimLeadership, 200);
}

function tryClaimLeadership() {
  if (isLeader) return;
  // If we heard a heartbeat in the last 3s, someone else is leader.
  if (Date.now() - leaderLastSeen < 3000) return;
  isLeader = true;
  channel?.postMessage({ type: 'leader-claim', tabId: TAB_ID });
  leaderHeartbeat = setInterval(() => {
    channel?.postMessage({ type: 'leader-heartbeat', tabId: TAB_ID });
  }, 2000);
}

function resignLeadership() {
  if (!isLeader) return;
  isLeader = false;
  if (leaderHeartbeat) clearInterval(leaderHeartbeat);
  leaderHeartbeat = null;
  channel?.postMessage({ type: 'leader-resign', tabId: TAB_ID });
}

// ── State ────────────────────────────────────────────────────
let draining = false;
const drainListeners = new Set();

export function subscribeSync(fn) {
  drainListeners.add(fn);
  fn({ draining, ...(lastSnapshot || {}) });
  return () => drainListeners.delete(fn);
}

let lastSnapshot = null;
function publish() {
  snapshot().then((s) => {
    lastSnapshot = s;
    drainListeners.forEach((fn) => fn({ draining, ...s }));
  });
}

// Queue mutations also trigger a publish
subscribeQueue(() => publish());

// ── Drain ────────────────────────────────────────────────────

export async function drainQueue() {
  if (draining) return { sent: 0, failed: 0, stillQueued: (await snapshot()).pending };
  if (!navigator.onLine) {
    return { sent: 0, failed: 0, stillQueued: (await snapshot()).pending };
  }

  if (!isLeader) {
    // Ask the leader to drain on our behalf
    channel?.postMessage({ type: 'drain-request' });
    return { sent: 0, failed: 0, stillQueued: (await snapshot()).pending };
  }

  draining = true;
  publish();

  const startedAt = Date.now();
  let sent = 0;
  let failed = 0;

  try {
    const ops = await getQueueSorted();

    for (const op of ops) {
      // skip ops that are backed off and not ready yet
      if (op.state === 'retry' && op.nextRetryAt > Date.now()) continue;
      if (op.state === 'gaveup') continue;

      // Mark sending (visible in System sheet)
      await Queue.putSafe?.({ ...op, state: 'sending' });

      let verdict;
      try {
        verdict = await executeOp(op);
      } catch (e) {
        verdict = { ok: false, error: e.message, transient: true };
      }

      if (verdict.ok) {
        await markSuccess(op, verdict);
        sent++;
      } else {
        await markFailure(op, verdict.error || 'Unknown error', {
          transient: !!verdict.transient,
        });
        failed++;
        if (verdict.auth) {
          // Auth expired — stop draining, surface to user
          break;
        }
      }
    }
  } catch (e) {
    await Errors.log(e, { where: 'drainQueue' });
  } finally {
    draining = false;
    publish();
  }

  // Post telemetry best-effort
  try {
    const end = await snapshot();
    fetch(apiUrl('/api/sync/event/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCookie('csrftoken') || '',
      },
      credentials: 'include',
      body: JSON.stringify({
        sent,
        failed,
        still_queued: end.pending,
        duration_ms: Date.now() - startedAt,
        app_version: 'v2-dev',
      }),
    }).catch(() => {});
  } catch { /* ignore */ }

  return { sent, failed, stillQueued: (await snapshot()).pending };
}

// Small helper because Queue doesn't have putSafe — guard it
// (kept here to avoid another file)
import { Queue } from './db.js';
Queue.putSafe = async (op) => {
  if (op.state === 'sending') op.state = 'queued'; // cosmetic only
  return Queue.put(op);
};

// ── Service worker bridge ────────────────────────────────────

export function registerBackgroundSyncTag() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => {
    if ('sync' in reg) {
      reg.sync.register('drain-queue').catch((e) => {
        // Some browsers disallow sync without user gesture; harmless.
        console.debug('[sync] BG sync register failed:', e?.message);
      });
    }
  });
}

export function askServiceWorkerToDrain() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage({ type: 'drain-queue' });
  });
}

// ── Lifecycle ────────────────────────────────────────────────

let _initialized = false;

export function initSync() {
  if (_initialized) return;
  _initialized = true;

  initChannel();

  window.addEventListener('online', () => {
    publish();
    registerBackgroundSyncTag();
    drainQueue();
  });

  window.addEventListener('offline', publish);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') drainQueue();
  });

  window.addEventListener('beforeunload', resignLeadership);

  // Periodic sweep (catches retry ops whose nextRetryAt has passed)
  setInterval(() => {
    if (navigator.onLine) drainQueue();
  }, 30_000);

  // First drain at boot
  drainQueue();
}

// ── Helpers ──────────────────────────────────────────────────

function getCookie(name) {
  const m = document.cookie.split('; ').find((r) => r.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}