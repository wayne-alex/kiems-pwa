<script>
  import { createEventDispatcher, onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  import { session } from "$lib/session.js";
  import {
    enqueue,
    drainQueue,
    retryOp,
    subscribeQueue,
    Cache,
    Queue,
    apiFetch,
  } from "$lib/core/index.js";
  import { getStations } from "$lib/services/stations/stationsCache.js";
  import SyncBadge from "$lib/../components/SyncBadge.svelte";
  import PageTransition from "$lib/../components/PageTransition.svelte";
  import FocusDeck from "$lib/../components/FocusDeck.svelte";
  import CountStepper from "$lib/../components/CountStepper.svelte";

  const dispatch = createEventDispatcher();

  const ZERO_MSG = "Enter at least one voter, or record 0 for today.";

  // What the VRA sees on each kit
  const STATUS = {
    notsent: { label: "Not sent yet", cls: "pending" },
    changed: { label: "Changes not sent", cls: "pending" },
    sending: { label: "Sending…", cls: "sending" },
    offline: { label: "Saved · waiting for signal", cls: "pending" },
    sent: { label: "Sent", cls: "entered" },
    failed: { label: "Couldn't send", cls: "failed" },
  };
  // These belong in the "Sent" group. Everything else is "Not sent yet".
  const SENT_GROUP = new Set(["sent", "sending", "offline", "changed"]);

  // ── State ─────────────────────────────────────────────────
  let phase = "idle"; // idle | loading | unbound | error | ready
  let errorMsg = "";
  let fromCache = false;
  let initialLoadDone = false;
  let indexPlaced = false;

  let ward = null;
  let constituency = null;

  let selectedDate = "";
  let dateRelation = "today";

  let kits = [];
  let submitting = false;
  let formError = null;

  let mode = "list"; // 'focus' | 'list'
  let currentIndex = 0;
  let editingVenueFor = null;

  // Sent kits the VRA chose to edit
  let unlocked = new Set();
  // Kits being sent right now (blocks double taps)
  let savingIds = new Set();
  // 'all' or a kit id: waiting for a 2nd tap to confirm a resend
  let armed = null;
  let armTimer;

  let online = typeof navigator === "undefined" ? true : navigator.onLine;

  // venues planned in the Movement page: kit_id -> venue
  let planVenues = new Map();

  // station suggestions
  let index = [];
  let wardIndex = [];
  let activeKitId = null;
  let suggestions = [];
  let suggestTimer;
  let blurTimer;

  // queue (for status tags, waiting/failed notes, auto refresh)
  let snap = { ops: [], online: true };
  let lastLive = 0;
  let refreshTimer;

  const unsub = subscribeQueue((s) => {
    snap = s;
    const live = s.ops.filter(
      (o) =>
        o.kind === "entry.submit" && o.state !== "done" && o.state !== "gaveup",
    ).length;
    if (live < lastLive) {
      // something was delivered: reload the real numbers
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadKits({ quiet: true }), 500);
    }
    lastLive = live;
  });

  // small top toast
  let toastMsg = "";
  let toastTimer;
  function flash(msg, ms = 1500) {
    toastMsg = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastMsg = ""), ms);
  }

  onDestroy(() => {
    unsub();
    clearTimeout(toastTimer);
    clearTimeout(refreshTimer);
    clearTimeout(suggestTimer);
    clearTimeout(blurTimer);
    clearTimeout(armTimer);
  });

  // ── Date helpers ──────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const localIso = (d) => isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  const todayIso = () => localIso(new Date());

  const tick = (ms = 10) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* ignore */
    }
  };

  function classifyDate(d) {
    const t = todayIso();
    if (d === t) return "today";
    return d < t ? "past" : "future";
  }

  function formatDateLabel(iso) {
    if (!iso) return "Today";
    if (iso === todayIso()) return "Today";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-KE", { day: "numeric", month: "short" });
  }

  function formatDateFull(iso) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString("en-KE", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }

  function openDatePicker() {
    const input = document.getElementById("entry-date-input");
    if (!input) return;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
      } catch {
        input.focus();
        input.click();
      }
    } else {
      input.focus();
      input.click();
    }
  }

  // ── Session reactivity ────────────────────────────────────
  $: if ($session.status === "unbound") phase = "unbound";

  $: if ($session.status === "bound" && $session.ward && !ward) {
    ward = $session.ward;
    constituency = $session.constituency;
    selectedDate = todayIso();
    phase = "loading";
    loadStations();
    loadKits();
  }

  $: if ($session.status === "error") {
    phase = "error";
    errorMsg = $session.error || "Session error.";
  }

  // ── Venue plan (from the Movement page) ───────────────────
  function addPlan(map, data) {
    for (const k of data?.kits || []) {
      const id = k.kit_id ?? k.id; // change here if /movement/kits/ uses another id field
      const v = (k.venue || "").trim();
      if (id != null && v) map.set(String(id), v);
    }
  }

  async function readPlanCache() {
    const map = new Map();
    try {
      const row = await Cache.get(`movement:${ward.id}:${selectedDate}`);
      addPlan(map, row?.value);
    } catch {
      /* ignore */
    }
    return map;
  }

  async function readPlanServer() {
    const map = new Map();
    try {
      const data = await apiFetch(
        `/movement/kits/?ward_id=${encodeURIComponent(ward.id)}&date=${selectedDate}`,
      );
      addPlan(map, data);
    } catch {
      /* offline: cache stands */
    }
    return map;
  }

  // Fill venues for kits that have none. Never overwrites what the VRA typed.
  function mergePlan(map) {
    if (!map.size) return;
    planVenues = new Map([...planVenues, ...map]);
    kits = kits.map((k) => {
      if ((k.venue || "").trim() || k._orig_venue) return k;
      const v = planVenues.get(String(k.kit_id));
      return v ? { ...k, venue: v, _orig_venue: v, venue_from_plan: true } : k;
    });
  }

  // ── Station suggestions (shared list, own ward first) ─────
  function buildIndex(list) {
    const wl = String($session.ward?.name || "").toLowerCase();
    index = list.map((s) => ({
      s,
      n: String(s.name || "").toLowerCase(),
      w: String(s.ward_name || "").toLowerCase(),
    }));
    wardIndex = wl ? index.filter((i) => i.w === wl) : [];
  }

  async function loadStations() {
    try {
      const list = await getStations({ onProgress: buildIndex });
      buildIndex(list);
    } catch {
      /* suggestions just stay empty */
    }
  }

  function scan(arr, toks, limit) {
    const hits = [];
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      let ok = true;
      for (const t of toks) {
        if (!it.n.includes(t) && !it.w.includes(t)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let score = 0;
      if (it.n.startsWith(toks[0])) score += 3;
      else if (it.n.includes(" " + toks[0])) score += 2;
      hits.push({ s: it.s, score });
      if (hits.length >= limit) break;
    }
    hits.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
    return hits.map((h) => h.s);
  }

  function searchStations(q, limit = 3) {
    const toks = String(q || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!toks.length || String(q).trim().length < 2) return [];
    const out = scan(wardIndex, toks, 60);
    if (out.length < limit) {
      const seen = new Set(out.map((s) => s.id));
      for (const s of scan(index, toks, 200)) {
        if (!seen.has(s.id)) out.push(s);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  function chipsFor(kit, activeId, sugg, all) {
    if (activeId !== kit.kit_id) return [];
    const v = (kit.venue || "").trim();
    const out = [];
    if (v.length >= 2) {
      for (const s of sugg) {
        if (s.name.toLowerCase() !== v.toLowerCase()) {
          out.push({ key: "s" + s.id, venue: s.name, tag: s.ward_name || "" });
        }
      }
    } else if (!v) {
      const seen = new Set();
      for (const k of all) {
        const ov = (k.venue || "").trim();
        if (k.kit_id === kit.kit_id || !ov || seen.has(ov.toLowerCase()))
          continue;
        seen.add(ov.toLowerCase());
        out.push({
          key: "k" + k.kit_id,
          venue: ov,
          tag: `Same as ${k.kit_name}`,
          quick: true,
        });
        if (out.length >= 2) break;
      }
    }
    return out.slice(0, 3);
  }

  function onVenueType(kit, value) {
    activeKitId = kit.kit_id;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(
      () => (suggestions = searchStations(value)),
      140,
    );
  }

  function onVenueFocus(kit) {
    clearTimeout(blurTimer);
    activeKitId = kit.kit_id;
    suggestions =
      (kit.venue || "").trim().length >= 2 ? searchStations(kit.venue) : [];
  }

  function onVenueBlur(kit) {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      finishVenueEdit(kit);
      if (activeKitId === kit.kit_id) {
        activeKitId = null;
        suggestions = [];
      }
    }, 170);
  }

  function applyChip(kit, chip) {
    setVenue(kit, chip.venue);
    editingVenueFor = null;
    activeKitId = null;
    suggestions = [];
    tick(5);
  }

  // ── Queue helpers ─────────────────────────────────────────
  // Entries saved on this device but not sent yet
  async function queuedEntries() {
    const map = new Map();
    try {
      const ops = await Queue.all();
      ops.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const op of ops) {
        if (op.kind !== "entry.submit") continue;
        if (op.state === "done" || op.state === "gaveup") continue;
        if (op.payload?.date !== selectedDate) continue;
        if (op.payload?.fingerprint !== $session.fingerprint) continue;
        for (const e of op.payload.entries || []) {
          map.set(String(e.kit_id), {
            venue: e.venue || "",
            male: e.male || 0,
            female: e.female || 0,
          });
        }
      }
    } catch {
      /* ignore */
    }
    return map;
  }

  $: entryOps = snap.ops.filter((o) => o.kind === "entry.submit");
  $: liveOps = entryOps.filter(
    (o) => o.state !== "done" && o.state !== "gaveup",
  );
  $: failedOps = entryOps.filter((o) => o.state === "gaveup");
  $: failedCount = failedOps.length;
  $: queuedKitIds = new Set(
    liveOps
      .filter((o) => o.payload?.date === selectedDate)
      .flatMap((o) => (o.payload?.entries || []).map((e) => String(e.kit_id))),
  );
  $: failedByKit = groupFailed(failedOps, selectedDate);

  function groupFailed(ops, day) {
    const m = new Map();
    for (const o of ops) {
      if (o.payload?.date !== day) continue;
      for (const e of o.payload?.entries || []) {
        const k = String(e.kit_id);
        m.set(k, [...(m.get(k) || []), o.id]);
      }
    }
    return m;
  }

  // One honest status per kit
  function statusOf(kit, queued, failed, isOnline) {
    const id = String(kit.kit_id);
    if (isDirty(kit)) return isRecorded(kit) ? "changed" : "notsent";
    if (failed.has(id)) return "failed";
    if (queued.has(id)) return isOnline ? "sending" : "offline";
    return isRecorded(kit) ? "sent" : "notsent";
  }

  $: statusMap = new Map(
    kits.map((k) => [
      String(k.kit_id),
      statusOf(k, queuedKitIds, failedByKit, online),
    ]),
  );
  $: unsentCount = kits.filter(
    (k) => !SENT_GROUP.has(statusMap.get(String(k.kit_id))),
  ).length;
  $: sentCount = kits.length - unsentCount;

  // Keep the saved kit list (read by Home) in step with what was just saved
  async function patchCache(list) {
    if (!ward) return;
    const key = `entry:${ward.id}:${selectedDate}`;
    try {
      const row = await Cache.get(key);
      const base = row?.value || {};
      const byId = new Map(list.map((k) => [String(k.kit_id), k]));
      const baseKits = Array.isArray(base.kits)
        ? base.kits
        : list.map((k) => ({
            kit_id: k.kit_id,
            kit_name: k.kit_name,
            serial_no: k.serial_no,
          }));
      await Cache.set(key, {
        ...base,
        kits: baseKits.map((bk) => {
          const k = byId.get(String(bk.kit_id));
          if (!k || !k._saved) return bk;
          return {
            ...bk,
            venue: k._orig_venue,
            registered_male: k._orig_male,
            registered_female: k._orig_female,
            has_registration: isRecorded(k),
          };
        }),
      });
    } catch {
      /* ignore */
    }
  }

  // ── Load ──────────────────────────────────────────────────
  async function loadKits({ quiet = false } = {}) {
    if (!ward) return;
    if (!quiet && phase !== "ready") phase = "loading";
    formError = null;

    const day = selectedDate;
    const cacheKey = `entry:${ward.id}:${day}`;

    let cached = null;
    try {
      cached = await Cache.get(cacheKey);
    } catch {
      /* ignore */
    }

    if (!quiet) {
      planVenues = await readPlanCache();
      readPlanServer().then(mergePlan); // fills in when the network answers
    }

    if (!quiet && cached && !initialLoadDone) {
      await applyKits(cached.value);
      if (day !== selectedDate) return;
      fromCache = true;
      phase = "ready";
    }

    try {
      const data = await apiFetch(
        `/kiems/kits-with-entries/?fingerprint=${encodeURIComponent($session.fingerprint)}&date=${day}`,
      );
      if (day !== selectedDate) return;

      if (data.error) {
        if (quiet) return;
        if (cached) {
          await applyKits(cached.value);
          fromCache = true;
          phase = "ready";
          initialLoadDone = true;
          return;
        }
        phase = "error";
        errorMsg = data.error;
        initialLoadDone = true;
        return;
      }

      try {
        await Cache.set(cacheKey, data);
      } catch {
        /* ignore */
      }
      await applyKits(data);
      if (day !== selectedDate) return;
      fromCache = false;
      phase = "ready";
      initialLoadDone = true;
    } catch (err) {
      if (quiet || day !== selectedDate) return;
      if (cached) {
        if (!kits.length) await applyKits(cached.value);
        fromCache = true;
        phase = "ready";
        drainQueue();
        initialLoadDone = true;
      } else {
        phase = "error";
        errorMsg =
          navigator.onLine === false
            ? "You're offline and this day isn't saved on this device yet."
            : err.message || "Could not load kits.";
        initialLoadDone = true;
      }
    }
  }

  async function applyKits(data) {
    dateRelation = classifyDate(selectedDate);

    const queued = await queuedEntries();
    const local = new Map(kits.map((k) => [String(k.kit_id), k]));

    kits = (data.kits || []).map((k) => {
      const id = String(k.kit_id);
      const q = queued.get(id);
      const prev = local.get(id);

      const serverVenue = (k.venue || "").trim();
      const planned = planVenues.get(id) || "";
      const baseVenue = serverVenue || planned;

      // what counts as "saved": a queued entry wins over the server copy
      const m0 = q ? q.male : k.registered_male || 0;
      const f0 = q ? q.female : k.registered_female || 0;
      const v0 = (q ? q.venue : baseVenue) || "";
      const recorded = !!k.has_registration || (q ? q.male + q.female > 0 : false);

      // keep what the VRA is typing right now
      const keepEdit = !!prev && isDirty(prev);

      return {
        kit_id: k.kit_id,
        kit_name: k.kit_name,
        serial_no: k.serial_no,
        venue: keepEdit ? prev.venue : v0,
        male: keepEdit ? prev.male : m0,
        female: keepEdit ? prev.female : f0,
        _orig_male: m0,
        _orig_female: f0,
        _orig_venue: v0.trim(),
        has_registration: recorded,
        is_venue_mapping: !!k.is_venue_mapping,
        venue_from_plan:
          !recorded && !q && !!v0 && (v0 === planned || !!k.is_venue_mapping),
        _saved: !!q || !!prev?._saved,
      };
    });

    if (!indexPlaced) {
      // start on the first kit that still needs counts
      const p = kits.findIndex((k) => !isRecorded(k));
      currentIndex = p >= 0 ? p : 0;
      indexPlaced = true;
    } else {
      currentIndex = Math.min(currentIndex, Math.max(0, kits.length - 1));
    }
  }

  async function changeDate(newDate) {
    if (!newDate || newDate === selectedDate) return;
    selectedDate = newDate;
    initialLoadDone = false;
    indexPlaced = false;
    currentIndex = 0;
    editingVenueFor = null;
    activeKitId = null;
    suggestions = [];
    planVenues = new Map();
    unlocked = new Set();
    disarm();
    kits = []; // never carry one day's edits into another day
    phase = "loading";
    await loadKits();
  }

  // ── Derived ───────────────────────────────────────────────
  const isDirty = (k) =>
    (parseInt(k.male) || 0) !== k._orig_male ||
    (parseInt(k.female) || 0) !== k._orig_female ||
    (k.venue || "").trim() !== k._orig_venue;

  const isRecorded = (k) => !!(k.has_registration || k._saved);

  $: totalMale = kits.reduce((s, k) => s + (parseInt(k.male) || 0), 0);
  $: totalFemale = kits.reduce((s, k) => s + (parseInt(k.female) || 0), 0);
  $: totalAll = totalMale + totalFemale;
  $: registeredCount = kits.filter(isRecorded).length;
  $: entryProgress = kits.length
    ? Math.round((registeredCount / kits.length) * 100)
    : 0;

  $: dirtyKits = kits.filter(isDirty);
  $: updateCount = dirtyKits.filter(isRecorded).length; // already sent, edited
  $: newCount = dirtyKits.length - updateCount;
  $: canSubmit =
    dateRelation === "today" && dirtyKits.length > 0 && !submitting;
  $: showSubmit =
    phase === "ready" && dateRelation === "today" && kits.length > 0;

  // ── Editing helpers ───────────────────────────────────────
  function setCount(kit, field, v) {
    kit[field] = v;
    kit._confirm_zero = false;
    kits = kits; // tell Svelte the list changed
  }

  function setVenue(kit, v) {
    kit.venue = v;
    kit.venue_from_plan =
      v.trim() !== "" && v.trim() === planVenues.get(String(kit.kit_id));
    kits = kits;
  }

  function finishVenueEdit(kit) {
    if (!(kit.venue || "").trim() && kit._orig_venue)
      setVenue(kit, kit._orig_venue);
    if (editingVenueFor === kit.kit_id) editingVenueFor = null;
  }

  function focusIf(node, on) {
    if (on) node.focus();
  }

  function unlockKit(kit) {
    unlocked = new Set([...unlocked, String(kit.kit_id)]);
    tick(6);
  }

  function relockKits(ids) {
    const drop = new Set(ids.map(String));
    unlocked = new Set([...unlocked].filter((id) => !drop.has(id)));
  }

  // Resending an entry that was already sent needs a second tap
  function arm(key) {
    armed = key;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = null), 3000);
    tick(6);
  }
  function disarm() {
    armed = null;
    clearTimeout(armTimer);
  }

  async function retryKit(kit) {
    const ids = failedByKit.get(String(kit.kit_id)) || [];
    for (const id of ids) {
      try {
        await retryOp(id);
      } catch {
        /* ignore */
      }
    }
    drainQueue();
    tick(8);
    flash("Retrying…", 1200);
  }

  // ── Validation ────────────────────────────────────────────
  function validateKit(kit, { allowZero = false } = {}) {
    const venue = (kit.venue || "").trim();
    const m = parseInt(kit.male) || 0;
    const f = parseInt(kit.female) || 0;
    if (!venue) return "Set the venue first.";
    if (m < 0 || f < 0) return "Counts cannot be negative.";
    if (m === 0 && f === 0 && !allowZero && !kit._confirm_zero) return ZERO_MSG;
    return null;
  }

  // ── Send one kit via the queue ────────────────────────────
  async function saveKit(kit, opts = {}) {
    const id = String(kit.kit_id);
    if (savingIds.has(id)) return false; // already sending
    if (!isDirty(kit) && isRecorded(kit)) return true; // nothing new: never resend

    const err = validateKit(kit, opts);
    if (err) {
      formError = err;
      return false;
    }
    formError = null;

    savingIds = new Set([...savingIds, id]);
    try {
      const entry = {
        kit_id: kit.kit_id,
        venue: kit.venue.trim(),
        male: parseInt(kit.male) || 0,
        female: parseInt(kit.female) || 0,
      };

      await enqueue("entry.submit", {
        fingerprint: $session.fingerprint,
        date: selectedDate,
        entries: [entry],
      });
      drainQueue(); // send now instead of waiting for the 30s sweep

      kit._orig_male = entry.male;
      kit._orig_female = entry.female;
      kit._orig_venue = entry.venue;
      kit.has_registration = entry.male + entry.female > 0;
      kit._saved = true;
      kit._confirm_zero = false;
      relockKits([id]);
      kits = kits;
      patchCache(kits);

      tick([12, 40, 12]);
      return true;
    } catch (e) {
      formError = e?.message || "Could not send.";
      return false;
    } finally {
      savingIds = new Set([...savingIds].filter((x) => x !== id));
    }
  }

  // List mode: the button on a kit card
  async function sendKit(kit) {
    const id = String(kit.kit_id);
    if (savingIds.has(id) || submitting) return;
    const isUpdate = isRecorded(kit);
    if (isUpdate && armed !== id) {
      arm(id); // 1st tap: ask to confirm
      return;
    }
    disarm();
    const ok = await saveKit(kit);
    if (ok) {
      flash(
        isUpdate
          ? "Updated · sending"
          : navigator.onLine
            ? "Sent"
            : "Saved on this device",
        1300,
      );
    } else if (formError) {
      flash(formError, 2200);
    }
  }

  // Focus deck: the main button
  async function handleAdvance(kit) {
    if (!isDirty(kit) && isRecorded(kit)) return true; // nothing new, just move on
    const ok = await saveKit(kit, { allowZero: true }); // the button label says "Record 0"
    if (!ok) {
      flash(formError || "Could not send.", 2200);
      return false; // stay on this card
    }
    flash(navigator.onLine ? "Sent" : "Saved on this device", 1200);
    return true;
  }

  function handleFinal() {
    if (dirtyKits.length > 0) {
      submitAll({ confirmed: true });
      return;
    }
    const pending = kits.filter((k) => !isRecorded(k));
    if (pending.length > 0) {
      currentIndex = kits.indexOf(pending[0]);
      flash(
        `${pending.length} kit${pending.length === 1 ? "" : "s"} still not sent`,
        2000,
      );
      return;
    }
    dispatch("back");
  }

  function saveLabelFor(k, atEnd) {
    if (isRecorded(k)) {
      if (!isDirty(k)) return atEnd ? "Finish" : "Next kit";
      return atEnd ? "Update & finish" : "Update & next";
    }
    const zero = !(parseInt(k.male) || 0) && !(parseInt(k.female) || 0);
    if (zero) return atEnd ? "Record 0 & finish" : "Record 0 & next";
    return atEnd ? "Send & finish" : "Send & next";
  }

  // ── Bulk send (list mode) ─────────────────────────────────
  async function submitAll({ confirmed = false } = {}) {
    formError = null;

    const toSubmit = dirtyKits.filter((k) => {
      const err = validateKit(k);
      if (err) {
        formError = `${k.kit_name}: ${err}`;
        return false;
      }
      return true;
    });

    if (formError) return;
    if (toSubmit.length === 0) {
      formError = "No changes to send.";
      return;
    }

    // Updating entries that were already sent notifies ICT again: confirm first
    if (toSubmit.some(isRecorded) && !confirmed && armed !== "all") {
      arm("all");
      return;
    }
    disarm();

    submitting = true;

    const payload = {
      fingerprint: $session.fingerprint,
      date: selectedDate,
      entries: toSubmit.map((k) => ({
        kit_id: k.kit_id,
        venue: k.venue.trim(),
        male: parseInt(k.male) || 0,
        female: parseInt(k.female) || 0,
      })),
    };

    try {
      await enqueue("entry.submit", payload);
      drainQueue();

      // Only the kits that were really sent become "saved"
      const ids = new Set(toSubmit.map((k) => String(k.kit_id)));
      kits = kits.map((k) => {
        if (!ids.has(String(k.kit_id))) return k;
        const m = parseInt(k.male) || 0;
        const f = parseInt(k.female) || 0;
        return {
          ...k,
          _orig_male: m,
          _orig_female: f,
          _orig_venue: (k.venue || "").trim(),
          has_registration: m + f > 0,
          _saved: true,
          _confirm_zero: false,
        };
      });
      relockKits([...ids]);
      patchCache(kits);
      tick([12, 40, 12]);
      flash(
        `Sent ${toSubmit.length} ${toSubmit.length === 1 ? "entry" : "entries"}${navigator.onLine ? "" : " · will send when online"}`,
      );
    } catch (e) {
      formError = e.message || "Could not send.";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:window
  on:online={() => (online = true)}
  on:offline={() => (online = false)}
/>

<PageTransition>
  <div class="ep">
    <!-- ═══════════════════ GATES ═══════════════════ -->
    {#if phase === "unbound" || phase === "error"}
      <div class="gate">
        <button
          class="icon-btn gate-back"
          on:click={() => dispatch("back")}
          aria-label="Back"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6 L9 12 L15 18" />
          </svg>
        </button>
        <div class="center">
          {#if phase === "unbound"}
            <div class="tile">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="4" y="10" width="16" height="11" rx="2" />
                <path d="M8 10 V7 A4 4 0 0 1 16 7 V10" />
              </svg>
            </div>
            <h2 class="center-title">Set up this device</h2>
            <p class="center-text">Choose your ward to continue. You only do this once.</p>
          {:else}
            <div class="tile danger">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8 V13" />
                <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
              </svg>
            </div>
            <h2 class="center-title">Something went wrong</h2>
            <p class="center-text">{errorMsg}</p>
          {/if}
        </div>
      </div>

      <!-- ═══════════════════ READY ═══════════════════ -->
    {:else if phase === "ready"}
      <header class="hero">
        <div class="hero-top">
          <button class="glass-btn" on:click={() => dispatch("back")} aria-label="Back">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 6 L9 12 L15 18" />
            </svg>
          </button>

          <div class="hero-meta">
            <div class="hero-ward">{ward.name}</div>
            <div class="hero-sub">
              {constituency?.name ? `${constituency.name} Constituency` : "KIEMS Registration"}
            </div>
          </div>

          <div class="sync-wrap"><SyncBadge /></div>
        </div>

        <div class="hero-row">
          <button
            type="button"
            class="date-chip"
            class:past={dateRelation === "past"}
            class:future={dateRelation === "future"}
            on:click={openDatePicker}
            aria-label="Select date"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
            </svg>
            <span>{formatDateLabel(selectedDate)}</span>
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
                 stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="chev">
              <path d="M6 9 L12 15 L18 9" />
            </svg>
          </button>

          {#if dateRelation === "past"}
            <span class="mode">Read-only</span>
          {:else if dateRelation === "future"}
            <span class="mode">Venue planning</span>
          {/if}

          <div class="mode-toggle">
            <button class:on={mode === "focus"} on:click={() => (mode = "focus")}>Focus</button>
            <button class:on={mode === "list"} on:click={() => (mode = "list")}>List</button>
          </div>
        </div>

        <!-- value= (not bind:) so changeDate() really sees the new date -->
        <input
          id="entry-date-input"
          class="date-input-hidden"
          type="date"
          value={selectedDate}
          on:change={(e) => changeDate(e.currentTarget.value)}
          tabindex="-1"
          aria-hidden="true"
        />

        {#if dateRelation !== "future" && kits.length > 0}
          <div class="hero-stats">
            <div class="hero-stat">
              <div class="hero-stat-num">{totalAll}</div>
              <div class="hero-stat-label">total</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num male">{totalMale}</div>
              <div class="hero-stat-label">male</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num female">{totalFemale}</div>
              <div class="hero-stat-label">female</div>
            </div>
            <div class="hero-stat">
              <div class="hero-stat-num">
                {registeredCount}<span class="hero-stat-sep">/{kits.length}</span>
              </div>
              <div class="hero-stat-label">kits</div>
            </div>
          </div>
          <div class="hero-progress"><span style="width: {entryProgress}%"></span></div>
        {/if}
      </header>

      <div class="sheet">
        {#if failedCount > 0}
          <div class="sync-note bad">
            {failedCount} entr{failedCount === 1 ? "y" : "ies"} couldn't be sent. Tap Retry on the kit, or the sync badge.
          </div>
        {:else if liveOps.length > 0}
          <div class="sync-note">
            {liveOps.length} entr{liveOps.length === 1 ? "y is" : "ies are"} waiting to send.
          </div>
        {/if}

        <!-- FOCUS MODE -->
        {#if mode === "focus" && dateRelation === "today"}
          <div class="focus-wrap">
            {#if kits.length === 0}
              <div class="empty" style="margin: 0 14px">No kits assigned to this ward.</div>
            {:else}
              <FocusDeck
                items={kits}
                bind:currentIndex
                {isDirty}
                isDone={isRecorded}
                onAdvance={handleAdvance}
                onFinal={handleFinal}
                saveLabel={saveLabelFor}
                let:current
              >
                <div class="fc">
                  <div class="fc-head">
                    <div class="fc-name">{current.kit_name}</div>
                    {#each [statusMap.get(String(current.kit_id))] as st}
                      {#if st === "sent"}
                        <span class="fc-chip done">Sent</span>
                      {:else if st === "sending"}
                        <span class="fc-chip queued">Sending…</span>
                      {:else if st === "offline"}
                        <span class="fc-chip queued">Waiting for signal</span>
                      {:else if st === "failed"}
                        <span class="fc-chip failed">Couldn't send</span>
                      {:else if st === "changed"}
                        <span class="fc-chip edit">Changes not sent</span>
                      {/if}
                    {/each}
                    <div class="fc-serial">{current.serial_no}</div>
                  </div>

                  <!-- Venue: carried from the movement plan, tap to change -->
                  {#if editingVenueFor === current.kit_id || !current._orig_venue}
                    <label class="field">
                      <svg class="field-icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
                           stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                        <circle cx="11.5" cy="9.5" r="2.5" />
                      </svg>
                      <input
                        type="text"
                        value={current.venue}
                        on:input={(e) => {
                          setVenue(current, e.currentTarget.value);
                          onVenueType(current, e.currentTarget.value);
                        }}
                        on:focus={() => onVenueFocus(current)}
                        on:blur={() => onVenueBlur(current)}
                        on:keydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        use:focusIf={editingVenueFor === current.kit_id}
                        placeholder="Enter venue"
                        autocomplete="off"
                        autocapitalize="words"
                        spellcheck="false"
                      />
                    </label>

                    {#each [chipsFor(current, activeKitId, suggestions, kits)] as chips}
                      {#if chips.length}
                        <div class="schips">
                          {#each chips as c (c.key)}
                            <button
                              type="button"
                              class="schip"
                              class:quick={c.quick}
                              on:pointerdown|preventDefault
                              on:click={() => applyChip(current, c)}
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                                   stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                              </svg>
                              <span class="s-name">{c.venue}</span>
                              {#if c.tag}<span class="s-tag">{c.tag}</span>{/if}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    {/each}
                  {:else}
                    <button class="venue" on:click={() => (editingVenueFor = current.kit_id)}>
                      <span class="venue-ic">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M20 10.5 C20 15 13 21.5 13 21.5 C13 21.5 4 15 4 9.5 C4 5.6 7.6 2 11.5 2 C15.4 2 20 5.6 20 10.5 Z" />
                          <circle cx="11.5" cy="9.5" r="2.5" />
                        </svg>
                      </span>
                      <span class="venue-main">
                        <span class="venue-name">{current.venue}</span>
                        {#if current.venue_from_plan}
                          <span class="venue-src">From movement plan</span>
                        {/if}
                      </span>
                      <span class="venue-change">Change</span>
                    </button>
                  {/if}

                  <div class="fc-counts">
                    <CountStepper
                      value={current.male}
                      label="Male"
                      tone="male"
                      on:change={(e) => setCount(current, "male", e.detail)}
                    />
                    <CountStepper
                      value={current.female}
                      label="Female"
                      tone="female"
                      on:change={(e) => setCount(current, "female", e.detail)}
                    />
                  </div>

                  <div class="fc-total">
                    <span>Total registered</span>
                    <b>{(parseInt(current.male) || 0) + (parseInt(current.female) || 0)}</b>
                  </div>
                </div>
              </FocusDeck>
            {/if}
          </div>

          <!-- LIST MODE -->
        {:else}
          <div class="scroll" class:nosave={!showSubmit}>
            {#if dateRelation === "past"}
              <div class="notice past">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8 V12 L15 14" />
                </svg>
                <span>Past date — read-only record for {formatDateFull(selectedDate)}.</span>
              </div>
            {:else if dateRelation === "future"}
              <div class="notice future">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10 H21 M8 3 V7 M16 3 V7" />
                </svg>
                <span>Future date — counts are entered on election day.</span>
              </div>
              <button class="plan-link" on:click={() => dispatch("navigate", "movement")}>
                Plan venues for this day in Movement
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                </svg>
              </button>
            {/if}

            {#if kits.length === 0}
              <div class="empty">No kits assigned to this ward.</div>
            {:else if dateRelation === "today"}
              {#each ["pending", "entered"] as group (group)}
                {#if (group === "pending" ? unsentCount : sentCount) > 0}
                  <div class="section-head" class:spaced={group === "entered" && unsentCount > 0}>
                    <span class="section-title {group}">
                      <span class={group === "pending" ? "dot-warn" : "dot-ok"}></span>
                      {group === "pending" ? "Not sent yet" : "Sent"}
                    </span>
                    <span class="section-count">{group === "pending" ? unsentCount : sentCount}</span>
                  </div>

                  {#each kits as kit (kit.kit_id)}
                    {@const id = String(kit.kit_id)}
                    {@const st = statusMap.get(id) || "notsent"}
                    {#if SENT_GROUP.has(st) === (group === "entered")}
                      {@const meta = STATUS[st] || STATUS.notsent}
                      {@const locked = isRecorded(kit) && !isDirty(kit) && !unlocked.has(id)}
                      {@const err = validateKit(kit)}
                      {@const noChange = isRecorded(kit) && !isDirty(kit)}
                      <div class="kit-card" class:entered={group === "entered"} class:dirty={isDirty(kit)} class:locked>
                        <div class="kit-head">
                          <div class="kit-left">
                            <span class="kit-name">{kit.kit_name}</span>
                            <span class="kit-serial">{kit.serial_no}</span>
                          </div>
                          <span class="kit-state {meta.cls}">
                            {#if st === "sending"}
                              <span class="mini-spin"></span>
                            {:else if st === "sent"}
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
                                   stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M5 12.5L10 17.5L19 7" />
                              </svg>
                            {:else}
                              <span class="dot-pending"></span>
                            {/if}
                            {meta.label}
                          </span>
                        </div>

                        {#if !locked && isRecorded(kit)}
                          <div class="kit-warn">
                            This entry was already sent. Updating it notifies ICT again.
                          </div>
                        {/if}

                        <label class="field" class:locked>
                          <input
                            type="text"
                            bind:value={kit.venue}
                            readonly={locked}
                            on:input={(e) => onVenueType(kit, e.currentTarget.value)}
                            on:focus={() => { if (!locked) onVenueFocus(kit); }}
                            on:blur={() => { if (!locked) onVenueBlur(kit); }}
                            placeholder="Enter venue"
                            autocomplete="off"
                            autocapitalize="words"
                            spellcheck="false"
                          />
                        </label>

                        {#if !locked}
                          {#each [chipsFor(kit, activeKitId, suggestions, kits)] as chips}
                            {#if chips.length}
                              <div class="schips">
                                {#each chips as c (c.key)}
                                  <button
                                    type="button"
                                    class="schip"
                                    class:quick={c.quick}
                                    on:pointerdown|preventDefault
                                    on:click={() => applyChip(kit, c)}
                                  >
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                                         stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                      <path d="M5 12H19" /><path d="M13 6L19 12L13 18" />
                                    </svg>
                                    <span class="s-name">{c.venue}</span>
                                    {#if c.tag}<span class="s-tag">{c.tag}</span>{/if}
                                  </button>
                                {/each}
                              </div>
                            {/if}
                          {/each}
                        {/if}

                        <div class="count-grid">
                          <label class="count-input male" class:locked>
                            <span class="count-label">Male</span>
                            <input type="number" min="0" inputmode="numeric" bind:value={kit.male}
                                   readonly={locked} placeholder="0" />
                          </label>
                          <label class="count-input female" class:locked>
                            <span class="count-label">Female</span>
                            <input type="number" min="0" inputmode="numeric" bind:value={kit.female}
                                   readonly={locked} placeholder="0" />
                          </label>
                        </div>

                        <div class="kit-foot">
                          <span class="kit-total">
                            Total <b>{(parseInt(kit.male) || 0) + (parseInt(kit.female) || 0)}</b>
                          </span>

                          <div class="kit-actions">
                            {#if locked}
                              {#if st === "failed"}
                                <button class="edit-btn" on:click={() => unlockKit(kit)}>Edit</button>
                                <button class="save-btn danger" on:click={() => retryKit(kit)}>Retry</button>
                              {:else if st === "sending"}
                                <span class="sending-note"><span class="mini-spin"></span>Sending to ICT…</span>
                              {:else}
                                <button class="edit-btn" on:click={() => unlockKit(kit)}>Edit</button>
                              {/if}
                            {:else}
                              <button
                                class="save-btn"
                                class:confirm={armed === id}
                                on:click={() => sendKit(kit)}
                                disabled={submitting || savingIds.has(id) || !!err || noChange}
                              >
                                {#if savingIds.has(id)}
                                  Sending…
                                {:else if noChange}
                                  No changes
                                {:else if isRecorded(kit)}
                                  {armed === id ? "Tap again to resend" : "Update & resend"}
                                {:else}
                                  Send
                                {/if}
                              </button>
                            {/if}
                          </div>
                        </div>
                      </div>
                    {/if}
                  {/each}
                {/if}
              {/each}
            {:else}
              {#each kits as kit (kit.kit_id)}
                <div class="kit-card readonly">
                  <div class="kit-head">
                    <div class="kit-left">
                      <span class="kit-name">{kit.kit_name}</span>
                      <span class="kit-serial">{kit.serial_no}</span>
                    </div>
                  </div>
                  {#if kit.venue}
                    <div class="readonly-row">
                      <span class="readonly-label">Venue</span>
                      <span class="readonly-value">{kit.venue}</span>
                    </div>
                  {/if}
                  <div class="count-grid">
                    <div class="count-input male static">
                      <span class="count-label">Male</span>
                      <span class="count-value">{kit.male}</span>
                    </div>
                    <div class="count-input female static">
                      <span class="count-label">Female</span>
                      <span class="count-value">{kit.female}</span>
                    </div>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          {#if showSubmit}
            <div class="savebar">
              {#if formError}
                <div class="toast err" role="alert">{formError}</div>
              {/if}
              <button
                class="cta"
                class:confirm={armed === "all"}
                on:click={() => submitAll()}
                disabled={!canSubmit}
              >
                {#if submitting}
                  Sending…
                {:else if armed === "all"}
                  Tap again to resend
                {:else if updateCount > 0}
                  Send & update entries
                {:else}
                  Send entries
                {/if}
              </button>
              <div class="hint" class:ready={dirtyKits.length > 0 && updateCount === 0} class:warn={updateCount > 0}>
                {#if updateCount > 0}
                  {updateCount} already sent · ICT will be notified again{#if newCount > 0} · {newCount} new{/if}
                {:else if dirtyKits.length > 0}
                  {dirtyKits.length} kit{dirtyKits.length === 1 ? "" : "s"} ready to send
                {:else}
                  Enter counts to enable sending
                {/if}
              </div>
            </div>
          {/if}
        {/if}
      </div>

      <!-- ═══════════════════ SKELETON ═══════════════════ -->
    {:else}
      <header class="hero hero-skeleton">
        <div class="hero-top">
          <div class="sk sk-btn"></div>
          <div class="hero-meta">
            <div class="sk sk-h1"></div>
            <div class="sk sk-sub"></div>
          </div>
          <div class="sk sk-pill"></div>
        </div>
      </header>
      <div class="sheet">
        <div class="scroll nosave">
          {#each Array(2) as _}
            <div class="kit-card skeleton-card">
              <div class="sk sk-kitname"></div>
              <div class="sk sk-venue" style="margin-top: 12px"></div>
              <div class="sk sk-count-val" style="margin-top: 16px"></div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ═══════════════════ TOAST ═══════════════════ -->
    {#if toastMsg}
      <div class="success-toast" role="status" transition:fly={{ y: -10, duration: 200, easing: cubicOut }}>
        <span class="st-dot"></span>
        {toastMsg}
      </div>
    {/if}
  </div>
</PageTransition>

<style>
  .ep {
    --g-950: #06271d;
    --g-800: #075b42;
    --g-700: #087451;
    --g-600: #0b9a68;
    --g-500: #18b77d;
    --g-100: #dcf3e7;
    --g-50: #effcf6;
    --ink: #0e2a21;
    --ink-2: #466158;
    --ink-3: #84978f;
    --line: #e3ebe7;
    --paper: #f4f7f6;
    --male: #1e5fa8;
    --male-tint: #e2edfa;
    --female: #b23a32;
    --female-tint: #fbeae8;
    --amber-soft: #fff1cf;
    --amber-ink: #8f5a00;
    --amber: #e6a11a;
    --red: #d0473d;
    --red-soft: #ffebe9;
    --ease: cubic-bezier(0.22, 0.8, 0.24, 1);

    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--g-950);
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

  /* ── Hero ───────────────────────────────────────────────── */
  .hero {
    position: relative;
    flex: none;
    padding: calc(12px + env(safe-area-inset-top)) 14px 38px;
    color: #fff;
    background: radial-gradient(
        110% 120% at 100% -10%,
        rgba(67, 231, 166, 0.34),
        transparent 50%
      ),
      radial-gradient(
        80% 100% at -10% 110%,
        rgba(0, 150, 104, 0.26),
        transparent 55%
      ),
      linear-gradient(150deg, #06271d 0%, #075b42 58%, #087451 100%);
  }
  .hero-top {
    display: flex;
    align-items: center;
    gap: 11px;
    margin-bottom: 12px;
  }
  .hero-meta {
    flex: 1;
    min-width: 0;
  }
  .hero-ward {
    font-size: clamp(21px, 6vw, 27px);
    font-weight: 750;
    letter-spacing: -0.05em;
    line-height: 1.05;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hero-sub {
    margin-top: 4px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.68);
  }
  .sync-wrap {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .hero-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .date-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px 8px 11px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.13);
    color: #fff;
    font: inherit;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  .date-chip:active {
    transform: scale(0.96);
  }
  .date-chip .chev {
    color: rgba(255, 255, 255, 0.7);
  }
  .mode {
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    font-size: 11px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.85);
  }

  .mode-toggle {
    display: inline-flex;
    margin-left: auto;
    padding: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.18);
  }
  .mode-toggle button {
    padding: 6px 12px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    font: inherit;
    font-size: 11.5px;
    font-weight: 750;
    cursor: pointer;
    transition:
      background 0.18s var(--ease),
      color 0.18s var(--ease);
  }
  .mode-toggle button.on {
    background: #fff;
    color: var(--g-950);
  }

  .date-input-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    border: none;
    padding: 0;
    margin: 0;
    left: -9999px;
  }

  .hero-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin-top: 14px;
    padding: 11px 12px;
    border-radius: 17px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .hero-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .hero-stat-num {
    font-size: 20px;
    font-weight: 750;
    letter-spacing: -0.045em;
    line-height: 1;
  }
  .hero-stat-num.male {
    color: #a9d1ff;
  }
  .hero-stat-num.female {
    color: #ffc0b8;
  }
  .hero-stat-sep {
    font-size: 14px;
    font-weight: 550;
    color: rgba(255, 255, 255, 0.55);
  }
  .hero-stat-label {
    font-size: 9.5px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.62);
  }
  .hero-progress {
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    overflow: hidden;
    margin-top: 11px;
  }
  .hero-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #72f1ba, #c2ffe0);
    transition: width 0.5s var(--ease);
  }

  /* ── Sheet ──────────────────────────────────────────────── */
  .sheet {
    position: relative;
    flex: 1;
    min-height: 0;
    margin-top: -24px;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 28px 28px 0 0;
    box-shadow: 0 -12px 30px -16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  /* ── Shared text field (focus venue + list mode) ───────── */
  .field {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px;
    border: 1.5px solid transparent;
    border-radius: 13px;
    background: var(--paper);
    transition:
      border-color 0.2s var(--ease),
      background 0.2s var(--ease),
      box-shadow 0.2s var(--ease);
  }
  .field:focus-within {
    border-color: var(--g-600);
    background: #fff;
    box-shadow: 0 0 0 4px rgba(11, 154, 104, 0.12);
  }
  .field-icon {
    color: #8ea098;
    flex-shrink: 0;
  }
  .field input {
    flex: 1;
    min-width: 0;
    width: 100%;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    -webkit-user-select: text;
    user-select: text;
  }
  .field input::placeholder {
    color: #9aa9a3;
  }

  /* ── Focus mode ─────────────────────────────────────────── */
  .focus-wrap {
    flex: 1;
    min-height: 0;
    padding: 14px 0 calc(8px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
  }

  .fc {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    min-width: 0;
    min-height: 100%;
  }
  .fc-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fc-name {
    flex: 1;
    min-width: 0;
    font-size: 20px;
    font-weight: 780;
    letter-spacing: -0.03em;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fc-serial {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3);
    padding: 3px 8px;
    border-radius: 8px;
    background: var(--paper);
    flex-shrink: 0;
  }
  .fc-chip {
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 750;
    flex-shrink: 0;
  }
  .fc-chip.done {
    background: var(--g-100);
    color: var(--g-800);
  }
  .fc-chip.edit {
    background: var(--amber-soft);
    color: var(--amber-ink);
  }

  /* Venue pill (carried from the movement plan) */
  .venue {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1.5px solid var(--line);
    border-radius: 16px;
    background: #fff;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .venue:active {
    background: var(--paper);
  }
  .venue-ic {
    width: 34px;
    height: 34px;
    border-radius: 11px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--g-50);
    color: var(--g-700);
  }
  .venue-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .venue-name {
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .venue-src {
    font-size: 11px;
    font-weight: 650;
    color: var(--g-700);
  }
  .venue-change {
    font-size: 12px;
    font-weight: 750;
    color: var(--g-700);
    flex-shrink: 0;
  }

  /* Steppers stack, one per row, so the numbers have room */
  .fc-counts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .fc-total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 2px 4px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--ink-3);
  }
  .fc-total b {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 22px;
    font-weight: 780;
    letter-spacing: -0.03em;
    color: var(--ink);
  }

  /* ── List mode ──────────────────────────────────────────── */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 18px 14px 20px;
    scroll-padding-bottom: 140px;
  }
  .scroll.nosave {
    padding-bottom: calc(20px + env(safe-area-inset-bottom));
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 13px;
    margin-bottom: 12px;
    border-radius: 14px;
    font-size: 12px;
    font-weight: 550;
    line-height: 1.4;
  }
  .notice svg {
    flex-shrink: 0;
  }
  .notice.past {
    background: #e8eeeb;
    color: var(--ink-2);
  }
  .notice.future {
    background: var(--male-tint);
    color: var(--male);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    margin: 2px 0 10px;
  }
  .section-head.spaced {
    margin-top: 22px;
  }
  .section-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 750;
    letter-spacing: -0.025em;
  }
  .section-title.pending {
    color: var(--amber-ink);
  }
  .section-title.entered {
    color: var(--g-800);
  }
  .section-count {
    padding: 3px 10px;
    border-radius: 999px;
    background: #fff;
    border: 1px solid var(--line);
    font-size: 11.5px;
    font-weight: 700;
    color: var(--ink-2);
  }
  .dot-warn,
  .dot-ok,
  .dot-pending {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-warn {
    background: var(--amber);
    box-shadow: 0 0 0 3px rgba(230, 161, 26, 0.18);
  }
  .dot-ok {
    background: var(--g-600);
    box-shadow: 0 0 0 3px rgba(11, 154, 104, 0.16);
  }
  .dot-pending {
    background: var(--amber);
  }

  .kit-card {
    padding: 13px;
    margin-bottom: 10px;
    border-radius: 20px;
    background: #fff;
    box-shadow:
      0 1px 0 var(--line),
      0 12px 26px -22px rgba(7, 43, 31, 0.4);
  }
  .kit-card.entered {
    box-shadow:
      0 0 0 1.5px var(--g-100),
      0 12px 26px -22px rgba(7, 43, 31, 0.4);
  }
  .kit-card.dirty {
    box-shadow:
      0 0 0 2px var(--g-600),
      0 14px 30px -18px rgba(11, 154, 104, 0.5);
  }
  .kit-card.readonly {
    opacity: 0.94;
  }

  .kit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .kit-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .kit-name {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .kit-serial {
    max-width: 42%;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .kit-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .kit-state.pending {
    background: var(--amber-soft);
    color: var(--amber-ink);
  }
  .kit-state.entered {
    background: var(--g-100);
    color: var(--g-800);
  }

  .count-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    margin: 10px 0 11px;
  }
  .count-input {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 12px 8px;
    border-radius: 14px;
    border: 1.5px solid transparent;
  }
  .count-input.male {
    background: var(--male-tint);
  }
  .count-input.female {
    background: var(--female-tint);
  }
  .count-input.male:focus-within {
    border-color: var(--male);
    background: #fff;
  }
  .count-input.female:focus-within {
    border-color: var(--female);
    background: #fff;
  }
  .count-label {
    font-size: 10.5px;
    font-weight: 750;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .count-input.male .count-label {
    color: var(--male);
  }
  .count-input.female .count-label {
    color: var(--female);
  }
  .count-input input {
    width: 100%;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 24px;
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1.15;
    color: var(--ink);
    -moz-appearance: textfield;
    appearance: textfield;
    -webkit-user-select: text;
    user-select: text;
  }
  .count-input input::-webkit-outer-spin-button,
  .count-input input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .count-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 24px;
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }

  .kit-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .kit-total {
    font-size: 12.5px;
    color: var(--ink-3);
  }
  .kit-total b {
    margin-left: 4px;
    font-size: 16px;
    font-weight: 750;
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .save-btn {
    padding: 10px 20px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--g-700), var(--g-600));
    color: #fff;
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 8px 18px -8px rgba(7, 116, 81, 0.55);
  }
  .save-btn:disabled {
    background: #cbd6d1;
    box-shadow: none;
    cursor: not-allowed;
  }

  .readonly-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    background: var(--paper);
    border-radius: 12px;
    font-size: 13px;
  }
  .readonly-label {
    color: var(--ink-3);
    font-weight: 600;
  }
  .readonly-value {
    font-weight: 650;
    text-align: right;
  }

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
    border-radius: 15px;
    background: linear-gradient(135deg, var(--g-700), var(--g-600));
    color: #fff;
    font: inherit;
    font-size: 15px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 12px 24px -12px rgba(7, 116, 81, 0.7);
  }
  .cta:disabled {
    background: #cbd6d1;
    box-shadow: none;
    cursor: not-allowed;
  }
  .hint {
    margin-top: 8px;
    text-align: center;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-3);
  }
  .hint.ready {
    color: var(--g-800);
    font-weight: 700;
  }
  .toast {
    margin-bottom: 10px;
    padding: 10px 13px;
    border-radius: 12px;
    font-size: 12.5px;
    font-weight: 600;
  }
  .toast.err {
    background: var(--red-soft);
    color: var(--red);
  }

  /* ── Gates ─────────────────────────────────────────────── */
  .gate {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: calc(12px + env(safe-area-inset-top)) 14px 14px;
    background: var(--paper);
  }
  .gate-back {
    align-self: flex-start;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px 28px 60px;
    text-align: center;
  }
  .center-title {
    margin: 16px 0 5px;
    font-size: 18px;
    font-weight: 750;
    letter-spacing: -0.03em;
  }
  .center-text {
    max-width: 290px;
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink-3);
  }
  .tile {
    width: 58px;
    height: 58px;
    border-radius: 19px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, var(--g-100), #c9f4df);
    color: var(--g-800);
  }
  .tile.danger {
    background: var(--red-soft);
    color: var(--red);
  }
  .empty {
    padding: 36px 20px;
    border: 1px dashed #d5dfda;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.7);
    color: var(--ink-3);
    font-size: 13px;
    text-align: center;
  }

  /* ── Skeleton ─────────────────────────────────────────── */
  .sk {
    display: block;
    border-radius: 6px;
    background: linear-gradient(
      90deg,
      rgba(10, 48, 35, 0.06) 0%,
      rgba(10, 48, 35, 0.12) 50%,
      rgba(10, 48, 35, 0.06) 100%
    );
    background-size: 200% 100%;
    animation: sk-shimmer 1.4s ease-in-out infinite;
  }
  .hero-skeleton .sk {
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.1) 0%,
      rgba(255, 255, 255, 0.24) 50%,
      rgba(255, 255, 255, 0.1) 100%
    );
    background-size: 200% 100%;
  }
  .sk-btn {
    width: 38px;
    height: 38px;
    border-radius: 13px;
  }
  .sk-pill {
    width: 60px;
    height: 26px;
    border-radius: 999px;
  }
  .sk-h1 {
    width: 62%;
    height: 22px;
    border-radius: 8px;
    margin-bottom: 8px;
  }
  .sk-sub {
    width: 44%;
    height: 12px;
  }
  .sk-kitname {
    width: 60%;
    height: 18px;
    margin-bottom: 6px;
  }
  .sk-venue {
    width: 80%;
    height: 14px;
  }
  .sk-count-val {
    width: 50%;
    height: 30px;
  }
  .skeleton-card {
    pointer-events: none;
  }
  @keyframes sk-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  /* ── Toast ─────────────────────────────────────────────── */
  .success-toast {
    position: fixed;
    top: calc(14px + env(safe-area-inset-top));
    left: 0;
    right: 0;
    margin: 0 auto;
    width: max-content;
    max-width: calc(100% - 32px);
    z-index: 250;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: #06271d;
    color: #d1fae5;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 700;
    box-shadow: 0 14px 30px rgba(6, 29, 21, 0.4);
  }
  .st-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #7bf0bd;
    box-shadow: 0 0 0 3px rgba(123, 240, 189, 0.22);
  }

  .icon-btn,
  .glass-btn {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn {
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
  }
  .glass-btn {
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
    .fc-chip.queued {
    background: var(--amber-soft);
    color: var(--amber-ink);
  }

  .sync-note {
    flex: none;
    margin: 14px 14px 0;
    padding: 10px 13px;
    border-radius: 14px;
    background: var(--amber-soft);
    color: var(--amber-ink);
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.4;
  }
  .sync-note.bad {
    background: var(--red-soft);
    color: var(--red);
  }
  .sync-note + .focus-wrap {
    padding-top: 10px;
  }

  .schips {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-top: 2px;
  }
  .schip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 9px 13px;
    border: 1px solid var(--g-100);
    border-radius: 999px;
    background: var(--g-50);
    color: var(--g-800);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    animation: chip-rise 0.2s var(--ease) both;
    transition: transform 0.16s var(--ease), background 0.16s var(--ease);
  }
  .schip.quick {
    background: #eef4ff;
    border-color: #d6e4fb;
    color: #1f55b8;
  }
  .schip:active {
    transform: scale(0.97);
  }
  .schip > svg {
    flex-shrink: 0;
  }
  .s-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-tag {
    padding: 2px 7px;
    border-radius: 6px;
    background: rgba(11, 154, 104, 0.16);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .schip.quick .s-tag {
    background: rgba(47, 111, 224, 0.14);
  }
  @keyframes chip-rise {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .plan-link {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding: 13px 15px;
    border: 0;
    border-radius: 16px;
    background: #eef4ff;
    color: #1f55b8;
    font: inherit;
    font-size: 13.5px;
    font-weight: 740;
    cursor: pointer;
  }
  .plan-link:active {
    background: #e1ecff;
  }
    /* ── Sent / sending / failed states ───────────────────── */
  .kit-state.sending { background: #e7f0ff; color: #1f55b8; }
  .kit-state.failed { background: var(--red-soft); color: var(--red); }
  .fc-chip.failed { background: var(--red-soft); color: var(--red); }

  .mini-spin {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: mini-spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes mini-spin { to { transform: rotate(360deg); } }

  /* Locked (already sent) cards */
  .kit-card.locked { background: #fbfdfc; }
  .field.locked { background: #f1f5f3; }
  .field.locked:focus-within {
    border-color: transparent;
    background: #f1f5f3;
    box-shadow: none;
  }
  .count-input.locked { opacity: 0.88; }
  .count-input.locked:focus-within { border-color: transparent; }
  .count-input.male.locked:focus-within { background: var(--male-tint); }
  .count-input.female.locked:focus-within { background: var(--female-tint); }

  .kit-warn {
    margin: -2px 0 10px;
    padding: 9px 12px;
    border-radius: 12px;
    background: var(--amber-soft);
    color: var(--amber-ink);
    font-size: 12px;
    font-weight: 650;
    line-height: 1.4;
  }

  .kit-actions { display: flex; align-items: center; gap: 8px; }
  .edit-btn {
    padding: 10px 16px;
    border: 1.5px solid var(--line);
    border-radius: 12px;
    background: #fff;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    cursor: pointer;
  }
  .edit-btn:active { background: var(--paper); }

  .save-btn.confirm {
    background: linear-gradient(135deg, #b36a00, #ef9400);
    box-shadow: 0 8px 18px -8px rgba(239, 148, 0, 0.6);
  }
  .save-btn.danger {
    background: linear-gradient(135deg, #e23b3b, #b0202f);
    box-shadow: 0 8px 18px -8px rgba(226, 59, 59, 0.55);
  }

  .sending-note {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    font-weight: 700;
    color: #1f55b8;
  }

  .cta.confirm {
    background: linear-gradient(135deg, #b36a00, #ef9400);
    box-shadow: 0 12px 24px -12px rgba(239, 148, 0, 0.7);
  }
  .hint.warn { color: var(--amber-ink); font-weight: 700; }

  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
    }
    .hero-progress span,
    .mode-toggle button,
    .field {
      transition: none;
    }
  }
</style>
