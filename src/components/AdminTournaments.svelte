<script lang="ts">
  /**
   * Admin — Tournaments tab.
   *
   * Per row:
   *   Rename — updates the display name; if the normalised key
   *     changes we clone to a new record and rewrite every match's
   *     `tournament` display-name.
   *   Delete — removes the tournament record. Child matches keep
   *     their tag string but fall to the "Default" bucket in the
   *     lobby (deliberate — no silent match rewrites on delete).
   *   Manage organisers — loads the organiser UID list, allows
   *     adding a new UID or removing an existing one. Gmail→UID
   *     is not supported on Spark tier (no serverless); the
   *     recipient signs in, copies their UID, and shares it.
   */
  import { onMount } from 'svelte';
  import {
    loadAll,
    subscribeStore,
    subscribeTournaments,
    createOrTouchTournament,
    renameTournament,
    updateTournamentMeta,
    deleteTournamentAndMatches,
    deleteTournaments,
    countMatchesByTournamentKey,
    addOrganiser,
    removeOrganiser,
    loadOrganisers,
    assignPlayer,
    unassignPlayer,
    loadAssignedPlayers,
    loadRounds,
    addRound,
    renameRound,
    setRoundState,
    deleteRound,
    countMatchesByRoundKey,
    type Round,
    type Tournament,
  } from '../lib/tournaments';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';
  import {
    loadAll as loadAllPlayers,
    subscribePlayers,
    subscribeStore as subscribePlayersStore,
    type Player,
  } from '../lib/players';
  import { loadAllUsers, type UserRecord } from '../lib/users';
  import AdminBulkBar from './AdminBulkBar.svelte';
  import CountrySelect from './CountrySelect.svelte';
  import { countryName, flagEmoji } from '../lib/countries';

  /**
   * Current-user role gating: super sees every row's actions; a
   * plain organiser sees actions only on rows they organise. Row
   * actions are hidden — not disabled — to keep the row uncluttered.
   * RTDB rules on /tournaments/$key are the actual enforcement; this
   * gate avoids the surprise-permission-denied toast when the user
   * couldn't have succeeded anyway.
   */
  let role = $state<Role | null>(null);
  function canManageTournament(t: Tournament): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    // Own-only auth (v3.3): an organiser can manage tournaments they
    // created. `createdBy` was stamped at creation time by
    // createOrTouchTournament; records without it (legacy anonymous
    // creates) fall through to super-only management.
    if (!role.isOrganiser) return false;
    const myUid = currentUser()?.uid;
    return !!(myUid && t.createdBy === myUid);
  }

  let tick = $state(0);
  let renamingKey = $state<string | null>(null);
  let renameValue = $state('');
  /**
   * Edit-tournament modal state (v3.2). Consolidates rename + change
   * type (open/closed) + change country into a single dialog. Rename
   * is still the underlying operation for name changes; the type +
   * country pair goes through updateTournamentMeta.
   */
  let editingKey = $state<string | null>(null);
  let editingName = $state('');
  let editingType = $state<'open' | 'closed'>('open');
  let editingCountry = $state('');
  let editingOriginal = $state<{ name: string; type: 'open' | 'closed'; country: string } | null>(
    null,
  );
  let deleteConfirmKey = $state<string | null>(null);
  let deleteConfirmText = $state('');
  /** Live count of child matches that will be cascade-deleted when
   *  the confirmation goes through. `null` while the count is
   *  loading (dialog opens optimistically, count populates async).
   *  Displayed in the confirmation copy so the admin knows the
   *  blast radius. */
  let deleteConfirmChildCount = $state<number | null>(null);
  let managingKey = $state<string | null>(null);
  let organiserUids = $state<string[]>([]);
  let organiserLoading = $state(false);
  /** Legacy free-text UID input — kept as an escape hatch when the
   *  target hasn't signed in yet (so they're not in /users). Hidden
   *  behind a toggle; the primary path is the user-picker below. */
  let addUidValue = $state('');
  let addUidRawOpen = $state(false);
  /**
   * Cached /users map: uid → email/displayName. Loaded once on first
   *  Organisers-dialog open per session; refreshed on demand via the
   *  "Reload users" button in the dialog when a newly-signed-in user
   *  should appear. Super-read gated by RTDB rules; empty for
   *  organisers, which is fine because we only reach this code path
   *  from the super-only Roles surface / super's own admin panel.
   */
  let usersMap = $state<Record<string, { uid: string; email: string; displayName?: string }>>({});
  let usersLoading = $state(false);
  let userPickerValue = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  /** Selected tournament keys for bulk delete. */
  let selected = $state<Set<string>>(new Set());
  /** Free-text filter over the tournament list. Matches on name
   *  (case-insensitive) and the slugified key so an admin can find
   *  a record by either the display name or the slug that appears
   *  in the URL / on match records. */
  let query = $state('');
  /** Add-new-tournament dialog state. Kept as a simple string + open
   *  flag; validation happens on save. */
  let addingOpen = $state(false);
  let addingName = $state('');
  let addingType = $state<'open' | 'closed'>('open');
  /** Country code — only meaningful when addingType === 'closed'.
   *  Required in that case; blocks Save. */
  let addingCountry = $state('');

  /** Per-row "Assigned players" dialog state (closed tournaments). */
  let assignOpen = $state(false);
  let assignKey = $state<string | null>(null);
  let assignedIds = $state<Set<string>>(new Set());
  let assignLoading = $state(false);
  let assignSaving = $state(false);
  let assignFilter = $state('');
  /** When true, the assignment dialog hides players whose country
   *  doesn't match the tournament's. Off shows every player (guest
   *  cases). Defaults on for closed tournaments with a country set. */
  let assignFilterByCountry = $state(true);

  /** Bump on the identity-store change, so the assignment dialog's
   *  filtered player list re-renders when a player is added elsewhere. */
  let playersTick = $state(0);

  /**
   * Per-row Rounds modal state (v3.2). Modal lists the tournament's
   * rounds, per-row Rename / Toggle-state / Delete. New rounds append
   * to the bottom of the list with order = max(existing) + 1.
   *
   * `roundsKey` is the currently-open tournament's key; null closes
   * the modal. `rounds` mirrors the tournament's live list from the
   * subscribeStore tick — kept in local state so the modal can render
   * a saving/error banner without also re-fetching on every keystroke.
   */
  let roundsKey = $state<string | null>(null);
  let roundsAddName = $state('');
  let roundsRenamingKey = $state<string | null>(null);
  let roundsRenameValue = $state('');
  let roundsDeletingKey = $state<string | null>(null);
  let roundsDeletingCount = $state<number | null>(null);
  let roundsSaving = $state(false);

  onMount(() => {
    void subscribeTournaments();
    void subscribePlayers();
    const unsub = subscribeStore(() => (tick += 1));
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    const unsubPlayers = subscribePlayersStore(() => (playersTick += 1));
    return () => {
      unsub();
      unsubRole();
      unsubPlayers();
    };
  });

  const list = $derived(() => {
    void tick;
    const all = loadAll();
    // v3.3: organisers see only tournaments they created. Super sees
    // everything. Reads on /tournaments are public in RTDB (so other
    // clients can render the picker + lobby), but the admin list is
    // scoped to "records you can act on" — otherwise the surface is
    // noisy and misleading.
    if (!role || role.isSuper) return all;
    if (!role.isOrganiser) return [];
    const myUid = currentUser()?.uid;
    if (!myUid) return [];
    return all.filter((t) => t.createdBy === myUid);
  });

  /** Search-filtered view of `list()`. Empty query = full list.
   *  Matches name substring OR key substring, both lowercased. */
  const filtered = $derived(() => {
    const all = list();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q),
    );
  });

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 4000);
  }

  function startRename(t: Tournament) {
    renamingKey = t.key;
    renameValue = t.name;
  }
  async function saveRename() {
    if (!renamingKey) return;
    saving = true;
    const outcome = await renameTournament(renamingKey, renameValue);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Tournament renamed');
      renamingKey = null;
    } else {
      flash('err', outcome.error);
    }
  }
  function cancelRename() {
    renamingKey = null;
    renameValue = '';
  }

  /**
   * Open the Edit dialog for a tournament. Snapshots the original
   * values so Save can compute a minimal patch (skip the rename call
   * when the name didn't change; skip updateTournamentMeta when type
   * + country didn't change).
   */
  function startEdit(t: Tournament) {
    editingKey = t.key;
    editingName = t.name;
    editingType = t.type ?? 'open';
    editingCountry = t.country ?? '';
    editingOriginal = {
      name: t.name,
      type: t.type ?? 'open',
      country: t.country ?? '',
    };
  }
  function cancelEdit() {
    editingKey = null;
    editingName = '';
    editingType = 'open';
    editingCountry = '';
    editingOriginal = null;
  }
  async function saveEdit() {
    if (!editingKey || !editingOriginal) return;
    const trimmedName = editingName.trim();
    if (!trimmedName) {
      flash('err', 'Name cannot be blank');
      return;
    }
    // Closed tournaments must have a country per the v3.1 data model.
    if (editingType === 'closed' && !editingCountry) {
      flash('err', 'Closed tournaments must have a country');
      return;
    }
    const nameChanged = trimmedName !== editingOriginal.name;
    const typeChanged = editingType !== editingOriginal.type;
    // Compare against the empty-string sentinel for "no country".
    const countryNext = editingCountry;
    const countryChanged = countryNext !== editingOriginal.country;
    if (!nameChanged && !typeChanged && !countryChanged) {
      // No-op — close the dialog quietly. Prevents a bogus audit
      // entry for a "save with nothing changed" tap.
      cancelEdit();
      return;
    }
    saving = true;
    try {
      // Order matters: rename first (may change the key), THEN meta
      // patch on the resulting record. If we did meta first and the
      // rename produced a new key, the meta write would land under
      // the old key just before it got deleted.
      if (nameChanged) {
        const r = await renameTournament(editingKey, trimmedName);
        if (!r.ok) {
          flash('err', r.error);
          return;
        }
        // Rename may have produced a new key — resolve it from the
        // store so the subsequent meta patch targets the right one.
        const norm = editingName.trim();
        const nextRec = list().find((x) => x.name === norm);
        if (nextRec) editingKey = nextRec.key;
      }
      if (typeChanged || countryChanged) {
        // Open + blank country → clear the country field explicitly
        // (null path) so RTDB drops it. Closed + a country → set.
        const countryPatch =
          editingType === 'open' && !countryNext ? null : countryNext;
        const r = await updateTournamentMeta(editingKey, {
          type: editingType,
          country: countryPatch,
        });
        if (!r.ok) {
          flash('err', r.error);
          return;
        }
      }
      flash('ok', 'Tournament updated');
      cancelEdit();
    } finally {
      saving = false;
    }
  }

  function startDelete(key: string) {
    deleteConfirmKey = key;
    deleteConfirmText = '';
    deleteConfirmChildCount = null;
    // Fetch child count in the background so the dialog can surface
    // the blast radius. Non-blocking — dialog renders immediately;
    // the "N matches" text just appears when the count is in.
    void countMatchesByTournamentKey(key).then((n) => {
      // Guard against a stale response landing after the admin
      // cancelled and opened a different dialog.
      if (deleteConfirmKey === key) deleteConfirmChildCount = n;
    });
  }
  async function confirmDelete() {
    if (!deleteConfirmKey) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;
    saving = true;
    const outcome = await deleteTournamentAndMatches(deleteConfirmKey);
    saving = false;
    if (outcome.ok) {
      const bits = ['Tournament deleted'];
      if (outcome.matchesDeleted > 0) {
        bits.push(
          `${outcome.matchesDeleted} match${outcome.matchesDeleted === 1 ? '' : 'es'} removed`,
        );
      }
      flash('ok', bits.join(' · '));
      deleteConfirmKey = null;
      deleteConfirmChildCount = null;
    } else {
      // Partial failure — surface counts so the admin knows how much
      // landed and how much needs a follow-up.
      const bits: string[] = [];
      if (outcome.matchesDeleted > 0) bits.push(`${outcome.matchesDeleted} matches deleted`);
      if (outcome.matchesFailed > 0) bits.push(`${outcome.matchesFailed} matches skipped`);
      if (!outcome.tournamentDeleted) bits.push('tournament kept');
      const detail = bits.length ? ` — ${bits.join(', ')}` : '';
      flash('err', `${outcome.error ?? 'Delete failed'}${detail}`);
    }
  }

  async function loadUsers() {
    usersLoading = true;
    try {
      const raw = await loadAllUsers();
      // Slim the type — the dialog only needs uid/email/displayName.
      const slim: Record<string, { uid: string; email: string; displayName?: string }> = {};
      for (const [uid, u] of Object.entries(raw)) {
        slim[uid] = {
          uid,
          email: u.email ?? '',
          ...(u.displayName ? { displayName: u.displayName } : {}),
        };
      }
      usersMap = slim;
    } finally {
      usersLoading = false;
    }
  }

  async function startManage(t: Tournament) {
    managingKey = t.key;
    // Load /users map the first time the dialog opens. Cached across
    // subsequent Organisers-dialog opens in the session; refreshable
    // via the Reload users button.
    if (Object.keys(usersMap).length === 0) void loadUsers();
    userPickerValue = '';
    addUidRawOpen = false;
    organiserLoading = true;
    organiserUids = await loadOrganisers(t.key);
    organiserLoading = false;
    addUidValue = '';
  }
  function stopManage() {
    managingKey = null;
    organiserUids = [];
    addUidValue = '';
    userPickerValue = '';
    addUidRawOpen = false;
  }

  /**
   * Add an organiser by user-picker selection. `userPickerValue` is
   * a uid picked from the /users dropdown. Preferred path — no
   * copy-paste of an opaque uid required.
   */
  async function addUidFromPicker() {
    if (!managingKey || !userPickerValue) return;
    const uid = userPickerValue;
    if (organiserUids.includes(uid)) {
      flash('err', 'That user is already an organiser');
      return;
    }
    saving = true;
    const outcome = await addOrganiser(managingKey, uid);
    saving = false;
    if (outcome.ok) {
      organiserUids = [...organiserUids, uid];
      userPickerValue = '';
      flash('ok', 'Organiser added');
    } else {
      flash('err', outcome.error);
    }
  }

  /**
   * Format a uid → friendly label for the picker + organiser-row
   * chips. Prefers displayName, falls back to email, then to a
   * truncated uid slice.
   */
  function labelForUid(uid: string): string {
    const u = usersMap[uid];
    if (!u) return uid.slice(0, 8) + '…';
    if (u.displayName) return `${u.displayName} · ${u.email}`;
    return u.email || uid.slice(0, 8) + '…';
  }

  /** List of uid options for the picker, excluding already-assigned
   *  organisers. Alpha-sorted by display label. */
  const eligibleUsers = $derived(() => {
    const already = new Set(organiserUids);
    return Object.values(usersMap)
      .filter((u) => !already.has(u.uid))
      .sort((a, b) => {
        const la = a.displayName ?? a.email ?? a.uid;
        const lb = b.displayName ?? b.email ?? b.uid;
        return la.localeCompare(lb);
      });
  });

  async function addUid() {
    if (!managingKey || !addUidValue.trim()) return;
    const uid = addUidValue.trim();
    // Firebase Auth uids are opaque strings using [A-Za-z0-9] — no
    // dots, no @, no spaces. Users often paste an email by mistake
    // (the input's placeholder says "Firebase UID" but Firebase's
    // own console shows "Email" as the primary display). Reject
    // early with a helpful hint instead of a cryptic "path must
    // be a non-empty string and can't contain '.', '#', '$', '[',
    // or ']'" error from the SDK.
    if (/[.#$/[\]@\s]/.test(uid) || uid.includes('@')) {
      flash(
        'err',
        'Enter a Firebase UID (not an email). The user signs in and copies their uid from the account menu.',
      );
      return;
    }
    if (uid.length > 64) {
      flash('err', 'UID must be 1-64 characters');
      return;
    }
    saving = true;
    const outcome = await addOrganiser(managingKey, uid);
    saving = false;
    if (outcome.ok) {
      if (!organiserUids.includes(uid)) organiserUids = [...organiserUids, uid];
      addUidValue = '';
      flash('ok', 'Organiser added');
    } else {
      flash('err', outcome.error);
    }
  }
  async function removeUid(uid: string) {
    if (!managingKey) return;
    saving = true;
    const outcome = await removeOrganiser(managingKey, uid);
    saving = false;
    if (outcome.ok) {
      organiserUids = organiserUids.filter((u) => u !== uid);
      flash('ok', 'Organiser removed');
    } else {
      flash('err', outcome.error);
    }
  }

  function toggleSel(key: string) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    // Select-all operates on the currently-visible AND manageable
    // subset. Filter narrows the visible rows; canManageTournament
    // narrows the actionable rows. Both must be true to include.
    const manageable = filtered().filter((t) => canManageTournament(t));
    if (manageable.length > 0 && manageable.every((t) => selected.has(t.key))) {
      selected = new Set();
    } else {
      selected = new Set(manageable.map((t) => t.key));
    }
  }
  function clearSelection() {
    selected = new Set();
  }
  /** Reset the single-delete dialog state without triggering the
   *  delete. Called by the Cancel button and the backdrop-click
   *  handler. Clears the count so it doesn't leak to the next open. */
  function cancelDelete() {
    deleteConfirmKey = null;
    deleteConfirmText = '';
    deleteConfirmChildCount = null;
  }

  async function performBulkDelete() {
    const keys = [...selected];
    if (keys.length === 0) return;
    saving = true;
    const outcome = await deleteTournaments(keys);
    saving = false;
    if (outcome.ok) {
      const bits = [`${outcome.deleted} tournament${outcome.deleted === 1 ? '' : 's'} deleted`];
      if ((outcome.matchesDeleted ?? 0) > 0) {
        bits.push(
          `${outcome.matchesDeleted} match${outcome.matchesDeleted === 1 ? '' : 'es'} removed`,
        );
      }
      flash('ok', bits.join(' · '));
    } else {
      const bits = [`${outcome.deleted} deleted, ${outcome.failed} failed`];
      if ((outcome.matchesDeleted ?? 0) > 0) bits.push(`${outcome.matchesDeleted} matches deleted`);
      if ((outcome.matchesFailed ?? 0) > 0) bits.push(`${outcome.matchesFailed} matches skipped`);
      const detail = outcome.error ? ` — ${outcome.error}` : '';
      flash('err', `${bits.join(', ')}${detail}`);
    }
    selected = new Set();
  }

  const allSelected = $derived(() => {
    void tick;
    // Consistent with toggleSelectAll: "all selected" means every
    // currently-visible AND manageable row is in the selection.
    // Under super this is every filtered row; under organiser it's
    // only the filtered rows they organise.
    const manageable = filtered().filter((t) => canManageTournament(t));
    return manageable.length > 0 && manageable.every((t) => selected.has(t.key));
  });

  function openAdd() {
    addingOpen = true;
    addingName = '';
    addingType = 'open';
    addingCountry = '';
  }
  function closeAdd() {
    addingOpen = false;
    addingName = '';
    addingType = 'open';
    addingCountry = '';
  }
  async function saveAdd() {
    const trimmed = addingName.trim();
    if (!trimmed) return;
    if (addingType === 'closed' && !addingCountry) {
      flash('err', 'Closed tournaments need a country');
      return;
    }
    saving = true;
    // v3.3: createOrTouchTournament is now async and reports RTDB
    // outcomes back to the caller. A rule-denied write is rolled
    // back client-side (the local push is undone) so the admin list
    // never shows a phantom record that vanishes on next page load.
    const outcome = await createOrTouchTournament(trimmed, {
      type: addingType,
      ...(addingType === 'closed' && addingCountry ? { country: addingCountry } : {}),
    });
    saving = false;
    if (!outcome.ok) {
      flash('err', outcome.error);
      return;
    }
    flash('ok', `"${outcome.record.name}" added`);
    closeAdd();
  }

  // ─── Assigned Players dialog (closed tournaments only) ─────────

  async function startAssign(t: Tournament) {
    assignKey = t.key;
    assignFilter = '';
    // Default to country-filtering if the tournament has a country
    // configured; otherwise show all.
    assignFilterByCountry = !!t.country;
    assignOpen = true;
    assignLoading = true;
    try {
      assignedIds = await loadAssignedPlayers(t.key);
    } finally {
      assignLoading = false;
    }
  }
  function stopAssign() {
    assignOpen = false;
    assignKey = null;
    assignedIds = new Set();
    assignFilter = '';
  }
  async function togglePlayerAssignment(playerId: string) {
    if (!assignKey) return;
    assignSaving = true;
    try {
      if (assignedIds.has(playerId)) {
        const r = await unassignPlayer(assignKey, playerId);
        if (r.ok) {
          const next = new Set(assignedIds);
          next.delete(playerId);
          assignedIds = next;
        } else {
          flash('err', r.error);
        }
      } else {
        const r = await assignPlayer(assignKey, playerId);
        if (r.ok) {
          const next = new Set(assignedIds);
          next.add(playerId);
          assignedIds = next;
        } else {
          flash('err', r.error);
        }
      }
    } finally {
      assignSaving = false;
    }
  }

  /** Filtered player list for the assignment dialog. Reads from the
   *  identity store, applies the country filter when toggled on, and
   *  applies the free-text search. */
  const assignCandidates = $derived(() => {
    void playersTick;
    if (!assignKey) return [] as Player[];
    const tournament = list().find((t) => t.key === assignKey);
    const country = tournament?.country;
    const q = assignFilter.trim().toLowerCase();
    return loadAllPlayers()
      .filter((p) => {
        if (assignFilterByCountry && country) {
          if (p.country !== country) return false;
        }
        if (!q) return true;
        return p.canonicalName.toLowerCase().includes(q);
      })
      .slice(0, 200);
  });

  // ─── Rounds modal (v3.2) ────────────────────────────────────────

  /** Rounds for the currently-open modal, live from the store. */
  const currentRounds = $derived<Round[]>(() => {
    void tick;
    if (!roundsKey) return [];
    return loadRounds(roundsKey);
  });

  function startRounds(t: Tournament) {
    roundsKey = t.key;
    roundsAddName = '';
    roundsRenamingKey = null;
    roundsRenameValue = '';
    roundsDeletingKey = null;
    roundsDeletingCount = null;
  }
  function stopRounds() {
    roundsKey = null;
    roundsAddName = '';
    roundsRenamingKey = null;
    roundsRenameValue = '';
    roundsDeletingKey = null;
    roundsDeletingCount = null;
  }

  async function saveAddRound() {
    if (!roundsKey) return;
    const name = roundsAddName.trim();
    if (!name) return;
    roundsSaving = true;
    const outcome = await addRound(roundsKey, name);
    roundsSaving = false;
    if (outcome.ok) {
      roundsAddName = '';
      flash('ok', 'Round added');
    } else {
      flash('err', outcome.error);
    }
  }

  function startRenameRound(r: Round) {
    roundsRenamingKey = r.key;
    roundsRenameValue = r.name;
  }
  function cancelRenameRound() {
    roundsRenamingKey = null;
    roundsRenameValue = '';
  }
  async function saveRenameRound() {
    if (!roundsKey || !roundsRenamingKey) return;
    const name = roundsRenameValue.trim();
    if (!name) return;
    roundsSaving = true;
    const outcome = await renameRound(roundsKey, roundsRenamingKey, name);
    roundsSaving = false;
    if (outcome.ok) {
      roundsRenamingKey = null;
      roundsRenameValue = '';
      flash('ok', 'Round renamed');
    } else {
      flash('err', outcome.error);
    }
  }

  async function toggleRoundState(r: Round) {
    if (!roundsKey) return;
    const next = r.state === 'closed' ? 'open' : 'closed';
    roundsSaving = true;
    const outcome = await setRoundState(roundsKey, r.key, next);
    roundsSaving = false;
    if (!outcome.ok) flash('err', outcome.error);
  }

  async function startDeleteRound(r: Round) {
    if (!roundsKey) return;
    roundsDeletingKey = r.key;
    // Load the child-match count so the confirmation banner shows
    // "N matches are tagged; they will be un-tagged, not deleted".
    roundsDeletingCount = null;
    roundsDeletingCount = await countMatchesByRoundKey(roundsKey, r.key);
  }
  function cancelDeleteRound() {
    roundsDeletingKey = null;
    roundsDeletingCount = null;
  }
  async function confirmDeleteRound() {
    if (!roundsKey || !roundsDeletingKey) return;
    roundsSaving = true;
    const outcome = await deleteRound(roundsKey, roundsDeletingKey);
    roundsSaving = false;
    if (outcome.ok) {
      roundsDeletingKey = null;
      roundsDeletingCount = null;
      flash('ok', 'Round deleted');
    } else {
      flash('err', outcome.error);
    }
  }
</script>

<section class="tourns">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <AdminBulkBar
    count={selected.size}
    itemLabel="tournament"
    saving={saving}
    onConfirmDelete={performBulkDelete}
    onClearSelection={clearSelection}
  />

  <div class="topbar">
    <button
      type="button"
      class="btn btn-primary"
      onclick={openAdd}
      disabled={saving}
    >+ Add tournament</button>
  </div>

  <div class="controls">
    <input
      type="search"
      placeholder="Search tournaments…"
      bind:value={query}
      aria-label="Search tournaments"
    />
    <span class="count">{filtered().length}</span>
  </div>

  {#if filtered().length === 0}
    <p class="empty">
      {query ? 'No tournaments match that search.' : 'No tournaments yet.'}
    </p>
  {:else}
    <div class="select-hdr">
      <label class="sel-all">
        <input
          type="checkbox"
          checked={allSelected()}
          onchange={toggleSelectAll}
          aria-label={allSelected() ? 'Deselect all' : 'Select all'}
        />
        Select all
      </label>
    </div>
    <ul class="list">
      {#each filtered() as t (t.key)}
        <li class="row" class:row-selected={selected.has(t.key)}>
          {#if canManageTournament(t)}
            <label class="row-check">
              <input
                type="checkbox"
                checked={selected.has(t.key)}
                onchange={() => toggleSel(t.key)}
                aria-label={`Select ${t.name}`}
              />
            </label>
          {:else}
            <!-- Placeholder keeps the row grid aligned when the checkbox
                 is hidden for tournaments the organiser doesn't manage. -->
            <span class="row-check row-check-spacer" aria-hidden="true"></span>
          {/if}
            <div class="row-name">
              <div class="row-name-text">{t.name}</div>
              <div class="row-name-meta">
                {#if t.type === 'closed'}
                  <span class="chip chip-closed" title="Closed tournament — country-scoped">
                    CLOSED
                  </span>
                {/if}
                {#if t.country}
                  <span class="chip chip-country" title={countryName(t.country)}>
                    {flagEmoji(t.country)} {countryName(t.country)}
                  </span>
                {/if}
                <span class="chip">key: <code>{t.key}</code></span>
                <span class="chip">last active {new Date(t.lastActive).toLocaleDateString()}</span>
              </div>
            </div>
            {#if canManageTournament(t)}
              <div class="row-actions">
                <button type="button" class="btn btn-primary" onclick={() => startEdit(t)}>Edit</button>
                <button
                  type="button"
                  class="btn btn-danger"
                  onclick={() => startDelete(t.key)}
                >Delete</button>
              </div>
            {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <!--
    Edit tournament dialog (v3.2). Consolidates rename + type/state
    + country changes into one modal. Save applies rename first
    (may change the record key) then the meta patch on the resulting
    key. Open/Closed radio group is same shape as the add-tournament
    dialog so the pattern stays consistent.
  -->
  {#if editingKey}
    {@const editingTournament = list().find((t) => t.key === editingKey) ?? null}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelEdit(); }}>
      <div class="dialog-card dialog-card-wide">
        <h3>Edit tournament</h3>

        <!--
          v3.3: absorb the standalone Rounds and Players affordances
          into the Edit dialog as launch buttons. Each opens the
          existing modal on top of this one — nested dialogs are fine
          per the existing pattern (see Delete confirmation inside
          Rounds modal). Cancel here still closes both.
        -->
        <div class="edit-section-nav">
          <button
            type="button"
            class="btn"
            onclick={() => editingTournament && startRounds(editingTournament)}
            disabled={saving || !editingTournament}
          >Rounds{editingTournament?.rounds && editingTournament.rounds.length > 0 ? ` (${editingTournament.rounds.length})` : ''}</button>
          {#if editingType === 'closed' && editingTournament}
            <button
              type="button"
              class="btn"
              onclick={() => startAssign(editingTournament)}
              disabled={saving}
            >Assigned players</button>
          {/if}
        </div>

        <label class="edit-field">
          <span>Name</span>
          <input
            type="text"
            bind:value={editingName}
            aria-label="Tournament name"
            maxlength="60"
            disabled={saving}
          />
        </label>
        <fieldset class="add-type">
          <legend>Access</legend>
          <label>
            <input
              type="radio"
              name="edit-type"
              value="open"
              checked={editingType === 'open'}
              onchange={() => (editingType = 'open')}
              disabled={saving}
            />
            <span>Open — any player, any umpire</span>
          </label>
          <label>
            <input
              type="radio"
              name="edit-type"
              value="closed"
              checked={editingType === 'closed'}
              onchange={() => (editingType = 'closed')}
              disabled={saving}
            />
            <span>Closed — country-scoped, assigned roster</span>
          </label>
        </fieldset>
        <label class="edit-field">
          <span>
            Country
            {#if editingType === 'closed'}<em class="hint-inline">(required)</em>{:else}<em class="hint-inline">(optional)</em>{/if}
          </span>
          <CountrySelect
            bind:value={editingCountry}
            required={editingType === 'closed'}
            ariaLabel="Tournament country"
          />
        </label>
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={cancelEdit} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={saveEdit}
            disabled={saving || !editingName.trim() || (editingType === 'closed' && !editingCountry)}
          >{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if deleteConfirmKey}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}>
      <div class="dialog-card">
        <h3>Delete tournament?</h3>
        <p>
          {#if deleteConfirmChildCount === null}
            Counting matches…
          {:else if deleteConfirmChildCount === 0}
            The tournament record will be removed. No matches are tagged under it.
          {:else}
            This will delete the tournament record <strong>and
            {deleteConfirmChildCount} tagged match{deleteConfirmChildCount === 1 ? '' : 'es'}</strong>.
            Matches you're not authorised to delete (e.g. from other
            organisers) will be skipped and left in place.
          {/if}
        </p>
        <p>Type <strong>DELETE</strong> to confirm.</p>
        <input type="text" bind:value={deleteConfirmText} placeholder="DELETE" aria-label="Type DELETE" />
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={cancelDelete} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-danger"
            onclick={confirmDelete}
            disabled={saving || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
          >{saving ? 'Deleting…' : 'Confirm delete'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if managingKey}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) stopManage(); }}>
      <div class="dialog-card dialog-card-wide">
        <h3>Manage organisers</h3>
        <p>
          Organisers can edit any match tagged to this tournament.
          Pick from the signed-in users list below. If the person
          hasn't signed in yet, ask them to open the site and sign in
          once — they'll appear in the dropdown.
        </p>
        {#if organiserLoading}
          <p class="empty">Loading…</p>
        {:else}
          <ul class="uid-list">
            {#each organiserUids as uid (uid)}
              <li class="uid-row">
                <span class="uid-label">{labelForUid(uid)}</span>
                <button
                  type="button"
                  class="btn btn-danger btn-sm"
                  onclick={() => removeUid(uid)}
                  disabled={saving}
                >Remove</button>
              </li>
            {/each}
            {#if organiserUids.length === 0}
              <li class="empty">No organisers yet.</li>
            {/if}
          </ul>
        {/if}

        <div class="uid-add">
          <select
            class="user-picker"
            bind:value={userPickerValue}
            aria-label="Pick a signed-in user"
            disabled={usersLoading || saving}
          >
            <option value="">
              {#if usersLoading}Loading users…{:else}Select a signed-in user…{/if}
            </option>
            {#each eligibleUsers() as u (u.uid)}
              <option value={u.uid}>
                {u.displayName ? `${u.displayName} · ${u.email}` : u.email || u.uid}
              </option>
            {/each}
          </select>
          <button
            type="button"
            class="btn btn-primary"
            onclick={addUidFromPicker}
            disabled={saving || !userPickerValue}
          >Add</button>
        </div>

        <button
          type="button"
          class="user-picker-reload"
          onclick={loadUsers}
          disabled={usersLoading || saving}
        >
          {usersLoading ? 'Loading users…' : '↻ Reload users list'}
        </button>

        <!--
          Escape hatch: paste a raw UID. Hidden behind a toggle so it
          doesn't distract from the primary picker path. Useful when
          the target has signed in but they're not showing in the
          dropdown yet (rare — /users may briefly lag before their
          record propagates), or for pre-onboarding an organiser
          whose account will exist shortly.
        -->
        <button
          type="button"
          class="user-picker-toggle-raw"
          onclick={() => (addUidRawOpen = !addUidRawOpen)}
        >
          {addUidRawOpen ? '▾' : '▸'} Add by UID (advanced)
        </button>
        {#if addUidRawOpen}
          <div class="uid-add">
            <input
              type="text"
              bind:value={addUidValue}
              placeholder="Firebase UID"
              aria-label="Firebase UID"
              maxlength="64"
            />
            <button
              type="button"
              class="btn"
              onclick={addUid}
              disabled={saving || !addUidValue.trim()}
            >Add</button>
          </div>
        {/if}

        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopManage} disabled={saving}>Close</button>
        </div>
      </div>
    </div>
  {/if}

  {#if addingOpen}
    <!--
      Add-tournament dialog. Free-text name (max 60 chars); the
      tournament's key is derived server-side by normalizeKey().
      Doesn't require a match to be tagged — an organiser can be
      pre-assigned to an empty tournament and matches can start
      flowing in later via the setup screen.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-tourn-title"
      onclick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}
    >
      <div class="dialog-card dialog-card-wide">
        <h3 id="add-tourn-title">Add tournament</h3>
        <p>
          Tournaments are the top-level bucket for grouping matches.
          Choose <strong>open</strong> for casual events (any player,
          any umpire) or <strong>closed</strong> for a
          country-scoped event with an explicit assigned-player roster.
        </p>
        <input
          type="text"
          bind:value={addingName}
          placeholder="Tournament name"
          aria-label="Tournament name"
          maxlength="60"
        />
        <fieldset class="add-type">
          <legend>Type</legend>
          <label class="add-type-row">
            <input
              type="radio"
              name="add-tournament-type"
              value="open"
              bind:group={addingType}
            />
            <span>
              <strong>Open</strong>
              — casual event, no roster gating.
            </span>
          </label>
          <label class="add-type-row">
            <input
              type="radio"
              name="add-tournament-type"
              value="closed"
              bind:group={addingType}
            />
            <span>
              <strong>Closed</strong>
              — country-scoped, players assigned explicitly.
            </span>
          </label>
        </fieldset>
        {#if addingType === 'closed'}
          <label class="add-country-label">
            <span>Country</span>
            <CountrySelect
              bind:value={addingCountry}
              required
              ariaLabel="Tournament country"
            />
          </label>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={closeAdd} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={saveAdd}
            disabled={saving || !addingName.trim() || (addingType === 'closed' && !addingCountry)}
          >{saving ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if assignOpen && assignKey}
    <!--
      Assigned Players dialog. Shows the identity-store roster, filtered
      by the tournament's country (toggle-off to see all), with a
      checkbox per row for assign/unassign. Reuses the shared /players
      subscription established by AdminPlayers, so the list is live-
      updated when someone adds a player in another tab.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-title"
      onclick={(e) => { if (e.target === e.currentTarget) stopAssign(); }}
    >
      <div class="dialog-card dialog-card-wide">
        <h3 id="assign-title">Assigned players</h3>
        {#await Promise.resolve(list().find((t) => t.key === assignKey)) then tournament}
          {#if tournament}
            <p>
              <strong>{tournament.name}</strong>
              {#if tournament.country}
                · {flagEmoji(tournament.country)} {countryName(tournament.country)}
              {/if}
              · {assignedIds.size} assigned
            </p>
          {/if}
        {/await}
        <div class="assign-controls">
          <input
            type="search"
            class="assign-search"
            bind:value={assignFilter}
            placeholder="Search players…"
            aria-label="Search players"
          />
          <label class="assign-country-filter">
            <input type="checkbox" bind:checked={assignFilterByCountry} />
            Match country only
          </label>
        </div>
        {#if assignLoading}
          <p class="empty">Loading assigned players…</p>
        {:else if assignCandidates().length === 0}
          <p class="empty">
            No matching players. Add players from the Players tab first.
          </p>
        {:else}
          <ul class="assign-list">
            {#each assignCandidates() as p (p.id)}
              <li class="assign-row">
                <label>
                  <input
                    type="checkbox"
                    checked={assignedIds.has(p.id)}
                    disabled={assignSaving}
                    onchange={() => togglePlayerAssignment(p.id)}
                  />
                  <span class="assign-name">{p.canonicalName}</span>
                  {#if p.country}
                    <span class="assign-country" title={countryName(p.country)}>
                      {flagEmoji(p.country)} {countryName(p.country)}
                    </span>
                  {/if}
                </label>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopAssign} disabled={assignSaving}>Done</button>
        </div>
      </div>
    </div>
  {/if}

  <!--
    Rounds modal (v3.2). Nested dialog: the round-delete confirmation
    layers on top of this one. Both are simple `.dialog` overlays so
    the topmost card visually stacks; the outer stopRounds handler
    stays gated on the delete confirmation being closed.
  -->
  {#if roundsKey}
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      onclick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (roundsDeletingKey) return; // don't close outer while confirm is up
        stopRounds();
      }}
    >
      <div class="dialog-card">
        <h3>Rounds</h3>
        <p class="dialog-help">
          Give this tournament its rounds — Round of 16, Quarter-finals,
          Semi-finals, Final. Umpires pick one at match setup. Close a
          round when you're done seeding matches into it so the picker
          stops suggesting it.
        </p>

        <!-- Add-round row -->
        <div class="add-round-row">
          <input
            type="text"
            bind:value={roundsAddName}
            placeholder="Round of 16, Quarter-finals, …"
            aria-label="New round name"
            maxlength="60"
            disabled={roundsSaving}
            onkeydown={(e) => {
              if (e.key === 'Enter' && roundsAddName.trim() && !roundsSaving) {
                e.preventDefault();
                void saveAddRound();
              }
            }}
          />
          <button
            type="button"
            class="btn btn-primary"
            onclick={saveAddRound}
            disabled={roundsSaving || !roundsAddName.trim()}
          >Add</button>
        </div>

        {#if currentRounds().length === 0}
          <p class="empty">No rounds yet. Add the first one above.</p>
        {:else}
          <ul class="round-list">
            {#each currentRounds() as r (r.key)}
              <li class="round-row" class:round-closed={r.state === 'closed'}>
                {#if roundsRenamingKey === r.key}
                  <div class="row-edit">
                    <input
                      type="text"
                      bind:value={roundsRenameValue}
                      aria-label="New round name"
                      maxlength="60"
                      disabled={roundsSaving}
                    />
                    <button
                      type="button"
                      class="btn btn-primary"
                      onclick={saveRenameRound}
                      disabled={roundsSaving || !roundsRenameValue.trim()}
                    >Save</button>
                    <button
                      type="button"
                      class="btn"
                      onclick={cancelRenameRound}
                      disabled={roundsSaving}
                    >Cancel</button>
                  </div>
                {:else}
                  <div class="round-name">
                    <div class="round-name-text">{r.name}</div>
                    <div class="round-name-meta">
                      <span class="chip">order {r.order}</span>
                      <span class="chip">key: <code>{r.key}</code></span>
                      {#if r.state === 'closed'}
                        <span class="chip chip-closed" title="Closed — not offered to umpires">
                          CLOSED
                        </span>
                      {/if}
                    </div>
                  </div>
                  <div class="round-actions">
                    <button
                      type="button"
                      class="btn"
                      onclick={() => startRenameRound(r)}
                      disabled={roundsSaving}
                    >Rename</button>
                    <button
                      type="button"
                      class="btn"
                      onclick={() => toggleRoundState(r)}
                      disabled={roundsSaving}
                    >{r.state === 'closed' ? 'Reopen' : 'Close'}</button>
                    <button
                      type="button"
                      class="btn btn-danger"
                      onclick={() => startDeleteRound(r)}
                      disabled={roundsSaving}
                    >Delete</button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopRounds} disabled={roundsSaving}>Done</button>
        </div>
      </div>
    </div>

    <!-- Nested round-delete confirmation -->
    {#if roundsDeletingKey}
      <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelDeleteRound(); }}>
        <div class="dialog-card">
          <h3>Delete round?</h3>
          <p>
            {#if roundsDeletingCount === null}
              Counting matches…
            {:else if roundsDeletingCount === 0}
              The round record will be removed. No matches are tagged under it.
            {:else}
              The round record will be removed.
              <strong>{roundsDeletingCount} match{roundsDeletingCount === 1 ? '' : 'es'}</strong>
              currently tagged with this round will lose the round tag but
              stay in the tournament — they'll appear under an
              <em>Unassigned</em> sub-group in History.
            {/if}
          </p>
          <div class="dialog-actions">
            <button type="button" class="btn" onclick={cancelDeleteRound} disabled={roundsSaving}>Cancel</button>
            <button
              type="button"
              class="btn btn-danger"
              onclick={confirmDeleteRound}
              disabled={roundsSaving}
            >{roundsSaving ? 'Deleting…' : 'Delete round'}</button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .tourns { display: flex; flex-direction: column; gap: 0.75rem; }

  .banner {
    padding: 0.5rem 0.75rem;
    background: rgba(76, 175, 80, 0.12);
    border: 1px solid rgba(76, 175, 80, 0.4);
    color: #66bb6a;
    border-radius: 0.5rem;
    font-size: 0.85rem;
  }
  .banner-err {
    background: rgba(239, 83, 80, 0.12);
    border-color: rgba(239, 83, 80, 0.4);
    color: #ef8985;
  }

  .empty { color: var(--muted); text-align: center; padding: 1.5rem; }

  /* Create-record button lives up top so it stays visible when the
     list is long and the bulk-action bar is sticky above. */
  .topbar {
    display: flex;
    justify-content: flex-end;
    padding: 0 0.25rem;
  }

  /* Search bar — same treatment as AdminPlayers / AdminHistoryCleanup. */
  .controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  .controls input {
    flex: 1;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .controls input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .count {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.15rem 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 999px;
  }

  /* Bulk-select header + row checkbox, matching AdminLiveCleanup. */
  .select-hdr {
    display: flex;
    justify-content: flex-start;
    padding: 0.25rem 0.5rem;
  }
  .sel-all {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .sel-all input {
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .row-check {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem;
    cursor: pointer;
  }
  .row-check input {
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .row-selected {
    background: rgba(255, 213, 74, 0.06) !important;
    border-color: rgba(255, 213, 74, 0.4) !important;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    transition: background 0.12s, border-color 0.12s;
  }
  .row-name { flex: 1; min-width: 0; }
  .row-name-text {
    color: var(--fg);
    font-weight: 600;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-name-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  /* Country chip — subtle accent tint, matches AdminPlayers row treatment. */
  .chip-country {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.3);
  }
  /* Closed-tournament chip — reads as identifying metadata alongside
     the country pill; a stronger accent that says "this tournament
     has roster gating." */
  .chip-closed {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }
  /* Radio group for open/closed on the add-tournament dialog. */
  fieldset.add-type {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.45rem;
    padding: 0.5rem 0.7rem;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  fieldset.add-type legend {
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 0.35rem;
  }
  .add-type-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--fg);
    cursor: pointer;
  }
  .add-type-row input[type="radio"] {
    accent-color: var(--accent, #ffd54a);
    margin-top: 0.2rem;
  }
  /* Edit-dialog rows share the label-above / input-below shape used
     by the add dialog. Kept as a separate class so the vertical
     rhythm reads cleanly inside the wider Edit modal. */
  /* Section-launch row inside the Edit dialog (v3.3). Groups the
     buttons that open sibling modals — Rounds, Assigned players —
     so the Edit dialog itself covers Details only. Border keeps the
     buttons visually separate from the field stack below. */
  .edit-section-nav {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin: 0.25rem 0 0.75rem;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
  }

  .edit-field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.35rem 0;
  }
  .edit-field > span {
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .edit-field input[type="text"] {
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.4rem;
    padding: 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .edit-field input[type="text"]:focus-visible {
    outline: 2px solid var(--accent, #ffd54a);
    outline-offset: 0;
    border-color: var(--accent, #ffd54a);
  }

  .add-country-label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  /* Assigned Players dialog */
  .assign-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .assign-search {
    flex: 1;
    min-width: 12rem;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
  }
  .assign-country-filter {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--muted);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .assign-list {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0;
    max-height: 55vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .assign-row label {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    cursor: pointer;
    color: var(--fg);
    font-size: 0.9rem;
  }
  .assign-row label:hover { background: rgba(255, 255, 255, 0.04); }
  .assign-row input[type="checkbox"] {
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .assign-name { flex: 1; }
  .assign-country {
    color: var(--muted);
    font-size: 0.75rem;
  }

  /* ─── Rounds modal (v3.2) ────────────────────────────────────── */
  .add-round-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin: 0.35rem 0 0.75rem;
  }
  .add-round-row input[type="text"] {
    flex: 1;
  }
  .round-list {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0;
    max-height: 55vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .round-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.45rem;
    background: rgba(255, 255, 255, 0.02);
  }
  /* Closed rounds render dimmed so the umpire's picker mental model
     — "these are the rounds still accepting matches" — is mirrored
     in the admin list itself. */
  .round-row.round-closed {
    opacity: 0.6;
  }
  .round-name { flex: 1; min-width: 0; }
  .round-name-text {
    color: var(--fg);
    font-weight: 600;
    line-height: 1.1;
  }
  .round-name-meta {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
  }
  .round-actions {
    display: flex;
    gap: 0.3rem;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .empty {
    color: var(--muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 1rem;
  }

  .row-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .row-edit {
    flex: 1;
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }
  .row-edit input {
    flex: 1;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.9rem;
  }

  .btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg);
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent);
    color: #0b0b0b;
    border-color: var(--accent);
  }
  .btn-primary:hover:not(:disabled) { background: #ffe07a; }
  .btn-danger {
    background: rgba(239, 83, 80, 0.14);
    color: var(--danger);
    border-color: rgba(239, 83, 80, 0.4);
  }
  .btn-danger:hover:not(:disabled) { background: rgba(239, 83, 80, 0.22); }
  .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }

  .dialog {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .dialog-card {
    background: #141414;
    border: 1px solid rgba(239, 83, 80, 0.4);
    border-radius: 0.75rem;
    padding: 1rem;
    max-width: 28rem;
    width: 100%;
  }
  .dialog-card-wide {
    max-width: 32rem;
    border-color: rgba(255, 213, 74, 0.4);
  }
  .dialog-card h3 {
    margin: 0 0 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.9rem;
  }
  .dialog-card:not(.dialog-card-wide) h3 { color: var(--danger); }
  .dialog-card-wide h3 { color: var(--accent); }
  .dialog-card p {
    margin: 0.5rem 0;
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .dialog-card input[type="text"] {
    width: 100%;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    margin: 0.25rem 0 0.75rem;
  }
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }

  .uid-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .uid-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 0.4rem;
  }
  .uid-row code {
    flex: 1;
    font-size: 0.75rem;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Friendly label (displayName · email) shown per organiser row —
     replaces the raw uid code once we can resolve it via /users. */
  .uid-label {
    flex: 1;
    font-size: 0.85rem;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .uid-add {
    display: flex;
    gap: 0.35rem;
    margin: 0.75rem 0 0.25rem;
    /* min-width: 0 lets the flex-1 picker actually shrink when a long
       option string would otherwise blow the row wider than the dialog
       card. Without this the select's intrinsic width (widest option's
       text) pushes the Add button outside the modal. */
    align-items: center;
    min-width: 0;
  }
  .uid-add input {
    flex: 1;
    margin: 0;
    min-width: 0;
  }
  .user-picker {
    flex: 1;
    /* Cap the picker at 100% of the row and force overflow to ellipsis
       inside the closed <select>. The open dropdown still shows the
       full text — this only clips the collapsed representation. */
    min-width: 0;
    max-width: 100%;
    width: 0;   /* let flex-1 alone drive width, ignoring intrinsic content */
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.45rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .user-picker:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .user-picker-reload,
  .user-picker-toggle-raw {
    background: transparent;
    border: 0;
    padding: 0.25rem 0;
    color: var(--muted);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
  }
  .user-picker-reload:hover,
  .user-picker-toggle-raw:hover {
    color: var(--fg);
  }
  .user-picker-toggle-raw {
    margin-top: 0.35rem;
  }
</style>
