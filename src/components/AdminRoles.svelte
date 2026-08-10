<script lang="ts">
  /**
   * Admin — Roles tab. Super-admin only surface for managing the
   * two role types the app supports:
   *
   *   /adminRoles/{uid} = "super"                     ← full CRUD
   *   /tournaments/{key}/organisers/{uid} = true      ← scoped
   *
   * Only the maintainer's UID is `super`; the panel intentionally
   * does not expose a "promote to super" affordance. The maintainer
   * grants organiser roles by pasting the recipient's Gmail address
   * (or picking from the list of already-signed-in users) and
   * choosing one or more tournaments.
   *
   * Email→UID resolution runs entirely client-side against the
   * /users mirror (each user writes their own record on sign-in).
   * If a recipient hasn't signed in yet, the input surfaces an
   * inline error asking the maintainer to have them sign in first.
   * The alternative (server-side Firebase Admin SDK lookup) needs
   * Cloud Functions, which we don't have on the Spark tier.
   *
   * Every UID visible in the panel (supers + organisers) is
   * decorated with display name + email from the mirror; UIDs that
   * have no mirror entry (edge case — mirror write failed once)
   * fall back to raw UID display.
   */
  import { onMount } from 'svelte';
  import { loadAllAdminRoles, subscribeCurrentUserRole, type Role } from '../lib/roles';
  import {
    loadAll as loadAllTournaments,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
    loadAllOrganisers,
    addOrganiser,
    removeOrganiser,
    type Tournament,
  } from '../lib/tournaments';
  import { loadAllUsers, type UserRecord } from '../lib/users';
  import { currentUser } from '../lib/auth';

  let supers = $state<Record<string, 'super'>>({});
  let organisersByUid = $state<Record<string, Record<string, true>>>({});
  let users = $state<Record<string, UserRecord>>({});
  let loading = $state(true);
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let tournamentTick = $state(0);
  let role = $state<Role | null>(null);

  // Add-organiser form
  let addEmail = $state('');
  let addTournaments = $state<Set<string>>(new Set());

  onMount(() => {
    void subscribeTournaments();
    const unsubStore = subscribeTournamentsStore(() => (tournamentTick += 1));
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    void reload();
    return () => {
      unsubStore();
      unsubRole();
    };
  });

  async function reload() {
    loading = true;
    const [s, o, u] = await Promise.all([
      loadAllAdminRoles(),
      loadAllOrganisers(),
      loadAllUsers(),
    ]);
    supers = s;
    organisersByUid = o;
    users = u;
    loading = false;
  }

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 5000);
  }

  const tournaments = $derived<Tournament[]>(() => {
    void tournamentTick;
    return loadAllTournaments();
  });

  function tournamentName(key: string): string {
    const t = tournaments().find((x) => x.key === key);
    return t?.name ?? key;
  }

  /**
   * Given a UID, return the friendliest label available:
   *   display name (email) if both exist,
   *   just the email if displayName missing,
   *   or the raw UID as a monospace code chip fallback.
   */
  function userLabel(uid: string): { name: string; email: string; hasMirror: boolean } {
    const u = users[uid];
    if (!u) return { name: '', email: '', hasMirror: false };
    return { name: u.displayName ?? '', email: u.email ?? '', hasMirror: true };
  }

  function toggleAddTournament(key: string) {
    if (addTournaments.has(key)) addTournaments.delete(key);
    else addTournaments.add(key);
    addTournaments = new Set(addTournaments);
  }

  /**
   * Find a UID by email. Case-insensitive; trimmed. Returns null if
   * no user with that email has signed in yet.
   */
  function findUidByEmail(email: string): string | null {
    const norm = email.trim().toLowerCase();
    if (!norm) return null;
    for (const [uid, u] of Object.entries(users)) {
      if ((u.email ?? '').toLowerCase() === norm) return uid;
    }
    return null;
  }

  async function assignOrganiser() {
    const email = addEmail.trim();
    if (!email) {
      flash('err', 'Enter an email address');
      return;
    }
    if (addTournaments.size === 0) {
      flash('err', 'Pick at least one tournament');
      return;
    }
    const uid = findUidByEmail(email);
    if (!uid) {
      flash(
        'err',
        `${email} hasn't signed in to Carromscore yet. Ask them to visit /admin/ once, then try again.`,
      );
      return;
    }
    saving = true;
    const keys = [...addTournaments];
    let ok = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const k of keys) {
      const r = await addOrganiser(k, uid);
      if (r.ok) ok += 1;
      else {
        failed += 1;
        if (!firstError) firstError = r.error;
      }
    }
    saving = false;
    if (failed === 0) {
      flash('ok', `Assigned ${email} to ${ok} tournament${ok === 1 ? '' : 's'}`);
      addEmail = '';
      addTournaments = new Set();
      await reload();
    } else {
      flash(
        'err',
        `${ok} assigned, ${failed} failed${firstError ? ` — ${firstError}` : ''}`,
      );
      await reload();
    }
  }

  async function revokeOrganiser(uid: string, key: string) {
    saving = true;
    const r = await removeOrganiser(key, uid);
    saving = false;
    if (r.ok) {
      const lbl = userLabel(uid);
      const who = lbl.name || lbl.email || `${uid.slice(0, 8)}…`;
      flash('ok', `Removed ${who} from ${tournamentName(key)}`);
      await reload();
    } else {
      flash('err', r.error);
    }
  }

  const meUid = $derived(currentUser()?.uid ?? '');
</script>

<section class="roles">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <div class="lead">
    <p>
      Two role types: <strong>super-admin</strong> (full CRUD, seeded
      to the maintainer only) and <strong>organiser</strong> (edit
      matches tagged to specific tournaments). RTDB rules enforce
      access; this tab is the maintainer's UI for granting organiser
      access to teammates.
    </p>
    <p class="lead-sub">
      To grant access: the recipient signs in with Google at
      <code>/carromscore/</code> once (via Admin in the footer).
      Then enter their Gmail address below.
    </p>
  </div>

  <h3 class="section-hdr">Super-admins</h3>
  {#if loading}
    <p class="empty">Loading…</p>
  {:else if Object.keys(supers).length === 0}
    <p class="empty">No super-admins recorded.</p>
  {:else}
    <ul class="list">
      {#each Object.keys(supers) as uid (uid)}
        {@const lbl = userLabel(uid)}
        <li class="row">
          <div class="row-name">
            <div class="row-title">
              {#if lbl.name}
                <span class="who-name">{lbl.name}</span>
              {/if}
              {#if lbl.email}
                <span class="who-email">{lbl.email}</span>
              {:else if !lbl.hasMirror}
                <code class="uid">{uid}</code>
              {/if}
              {#if uid === meUid}<span class="chip chip-you">You</span>{/if}
            </div>
          </div>
          <span class="badge badge-super">SUPER</span>
        </li>
      {/each}
    </ul>
    <p class="note">
      Super role is intentionally uneditable from this UI — only the
      maintainer holds it. To change, edit <code>/adminRoles</code>
      in the Firebase console directly.
    </p>
  {/if}

  <h3 class="section-hdr">Organisers</h3>
  <div class="add-form">
    <label class="add-uid">
      <span>Gmail address</span>
      <input
        type="email"
        bind:value={addEmail}
        placeholder="name@gmail.com"
        aria-label="Recipient email"
        maxlength="128"
      />
    </label>
    <div class="add-tournaments">
      <span class="add-tournaments-lbl">Tournaments</span>
      {#if tournaments().length === 0}
        <p class="empty empty-inline">
          No tournaments yet. Add one on the Tournaments tab first.
        </p>
      {:else}
        <div class="tournament-picker">
          {#each tournaments() as t (t.key)}
            <label class="chip-pick" class:chip-pick-on={addTournaments.has(t.key)}>
              <input
                type="checkbox"
                checked={addTournaments.has(t.key)}
                onchange={() => toggleAddTournament(t.key)}
              />
              {t.name}
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <button
      type="button"
      class="btn btn-primary"
      onclick={assignOrganiser}
      disabled={saving || !addEmail.trim() || addTournaments.size === 0}
    >{saving ? 'Assigning…' : 'Assign organiser'}</button>
  </div>

  {#if loading}
    <p class="empty">Loading…</p>
  {:else if Object.keys(organisersByUid).length === 0}
    <p class="empty">No organisers assigned yet.</p>
  {:else}
    <ul class="list">
      {#each Object.entries(organisersByUid) as [uid, keys] (uid)}
        {@const lbl = userLabel(uid)}
        <li class="row row-org">
          <div class="row-name">
            <div class="row-title">
              {#if lbl.name}
                <span class="who-name">{lbl.name}</span>
              {/if}
              {#if lbl.email}
                <span class="who-email">{lbl.email}</span>
              {:else if !lbl.hasMirror}
                <code class="uid">{uid}</code>
              {/if}
              <span class="chip">{Object.keys(keys).length} tournament{Object.keys(keys).length === 1 ? '' : 's'}</span>
            </div>
            <div class="org-tags">
              {#each Object.keys(keys) as k (k)}
                <span class="tag">
                  {tournamentName(k)}
                  <button
                    type="button"
                    class="tag-x"
                    onclick={() => revokeOrganiser(uid, k)}
                    disabled={saving}
                    aria-label={`Remove from ${tournamentName(k)}`}
                  >✕</button>
                </span>
              {/each}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .roles { display: flex; flex-direction: column; gap: 0.75rem; }

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

  .lead p {
    margin: 0 0 0.4rem;
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.55;
  }
  .lead p strong { color: var(--fg); }
  .lead p code {
    background: rgba(255, 255, 255, 0.04);
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.85em;
  }
  .lead-sub { color: var(--muted); font-size: 0.8rem !important; }

  .section-hdr {
    margin: 0.75rem 0 0.35rem;
    color: var(--fg);
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .empty { color: var(--muted); text-align: center; padding: 1rem; margin: 0; }
  .empty-inline { text-align: left; padding: 0; font-size: 0.8rem; }

  .note {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
    margin: 0.35rem 0 0;
    padding: 0.4rem 0.6rem;
    background: rgba(255, 213, 74, 0.05);
    border-left: 2px solid rgba(255, 213, 74, 0.4);
    border-radius: 0 0.3rem 0.3rem 0;
  }
  .note code {
    font-family: monospace;
    background: rgba(255, 255, 255, 0.04);
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.9em;
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
    padding: 0.55rem 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
  }
  .row-org { align-items: flex-start; }
  .row-name { flex: 1; min-width: 0; }
  .row-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .who-name {
    color: var(--fg);
    font-weight: 700;
    font-size: 0.9rem;
  }
  .who-email {
    color: var(--muted);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .uid {
    color: var(--fg);
    font-size: 0.72rem;
    font-family: monospace;
    background: rgba(255, 255, 255, 0.04);
    padding: 0.1rem 0.35rem;
    border-radius: 0.3rem;
    overflow-wrap: anywhere;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  .chip-you {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.1);
    border-color: rgba(255, 213, 74, 0.3);
    font-weight: 700;
  }
  .badge {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    font-weight: 800;
    text-transform: uppercase;
  }
  .badge-super {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.4);
  }

  .org-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.15rem 0.15rem 0.5rem;
    background: rgba(79, 195, 247, 0.08);
    color: var(--side-a);
    border: 1px solid rgba(79, 195, 247, 0.3);
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .tag-x {
    background: transparent;
    border: none;
    color: var(--danger);
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0 0.3rem;
    border-radius: 999px;
    line-height: 1;
  }
  .tag-x:hover:not(:disabled) {
    background: rgba(239, 83, 80, 0.14);
  }
  .tag-x:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Add-organiser form: email + tournament picker + Assign button.
     Kept in a single panel so the maintainer sees it as one atomic
     action rather than three separate steps. */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem;
    background: rgba(79, 195, 247, 0.04);
    border: 1px solid rgba(79, 195, 247, 0.2);
    border-radius: 0.55rem;
  }
  .add-uid {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .add-uid span {
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .add-uid input {
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .add-uid input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add-tournaments {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .add-tournaments-lbl {
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .tournament-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  /* Picker chip toggles on/off — cyan when on, muted when off. */
  .chip-pick {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .chip-pick input {
    /* Hide the checkbox — chip appearance IS the checked state. */
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .chip-pick-on {
    background: rgba(79, 195, 247, 0.14);
    color: var(--side-a);
    border-color: rgba(79, 195, 247, 0.5);
  }

  .btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg);
    border-radius: 0.4rem;
    padding: 0.5rem 0.9rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    align-self: flex-start;
  }
  .btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent);
    color: #0b0b0b;
    border-color: var(--accent);
  }
  .btn-primary:hover:not(:disabled) { background: #ffe07a; }
</style>
