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
  import {
    loadAllAdminRoles,
    loadAllOrganiserRoles,
    addOrganiserRole,
    removeOrganiserRole,
  } from '../lib/roles';
  // v3.3: dropped the tournament chip picker for organiser onboarding.
  // Tournaments store no longer needed here — the Organisers section
  // just lists uids from /organiserRoles.
  import { loadAllUsers, type UserRecord } from '../lib/users';
  import { currentUser } from '../lib/auth';

  let supers = $state<Record<string, 'super'>>({});
  let organiserUids = $state<Set<string>>(new Set());
  let users = $state<Record<string, UserRecord>>({});
  let loading = $state(true);
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);

  // Onboard-organiser form
  let addEmail = $state('');
  let addDropdownOpen = $state(false);
  let addHighlight = $state(-1);

  const addSuggestions = $derived.by(() => {
    const q = addEmail.trim().toLowerCase();
    const already = organiserUids;
    return Object.values(users)
      .filter((u) => {
        if (already.has(u.uid ?? '')) return false;
        if (!u.email) return false; // can't onboard without an email
        if (!q) return true;
        return (
          (u.displayName ?? '').toLowerCase().includes(q) ||
          (u.email ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.displayName ?? a.email ?? '').localeCompare(b.displayName ?? b.email ?? ''));
  });

  function pickSuggestion(u: UserRecord) {
    addEmail = u.email ?? '';
    addDropdownOpen = false;
    addHighlight = -1;
  }

  function onAddKeydown(e: KeyboardEvent) {
    const open = addDropdownOpen && addSuggestions.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { addDropdownOpen = true; addHighlight = 0; }
      else addHighlight = Math.min(addHighlight + 1, addSuggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      addHighlight = Math.max(addHighlight - 1, 0);
    } else if (e.key === 'Enter' && open && addHighlight >= 0) {
      e.preventDefault();
      const u = addSuggestions[addHighlight];
      if (u) pickSuggestion(u);
    } else if (e.key === 'Escape') {
      addDropdownOpen = false;
    } else {
      if (open) addHighlight = 0;
    }
  }
  // Per-row revoke confirmation state — reveals a "Confirm" button
  // inline for the uid the super is about to revoke.
  let confirmingRevokeUid = $state<string | null>(null);

  onMount(() => {
    void reload();
  });

  async function reload() {
    loading = true;
    const [s, o, u] = await Promise.all([
      loadAllAdminRoles(),
      loadAllOrganiserRoles(),
      loadAllUsers(),
    ]);
    supers = s;
    organiserUids = o;
    users = u;
    loading = false;
  }

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 5000);
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

  /**
   * v3.3: onboard someone as a global organiser. The chip picker
   * for tournaments is gone — an organiser creates their own
   * tournaments once onboarded. Idempotent: rewriting a uid that's
   * already in /organiserRoles is a no-op.
   */
  async function onboardOrganiser() {
    const email = addEmail.trim();
    if (!email) {
      flash('err', 'Enter or select an email address');
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
    if (organiserUids.has(uid)) {
      flash('err', `${email} is already an organiser`);
      return;
    }
    saving = true;
    const r = await addOrganiserRole(uid);
    saving = false;
    if (r.ok) {
      flash('ok', `Onboarded ${email} as organiser`);
      addEmail = '';
      await reload();
    } else {
      flash('err', r.error);
    }
  }

  function startRevoke(uid: string) {
    confirmingRevokeUid = uid;
  }
  function cancelRevoke() {
    confirmingRevokeUid = null;
  }
  async function confirmRevoke(uid: string) {
    saving = true;
    const r = await removeOrganiserRole(uid);
    saving = false;
    if (r.ok) {
      const lbl = userLabel(uid);
      const who = lbl.name || lbl.email || `${uid.slice(0, 8)}…`;
      flash('ok', `Revoked ${who} — their existing tournaments become super-only`);
      confirmingRevokeUid = null;
      await reload();
    } else {
      flash('err', r.error);
    }
  }

  const meUid = $derived(currentUser()?.uid ?? '');
</script>

<section class="roles admin-tab-scrollself">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <!-- Super-admins -->
  <div class="section-block">
    <div class="section-head">
      <div class="section-head-left">
        <span class="section-icon section-icon-super">
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M9.664 1.319a.75.75 0 01.672 0 41.059 41.059 0 018.198 5.424.75.75 0 01-.254 1.285 31.372 31.372 0 00-7.86 3.83.75.75 0 01-.84 0 31.508 31.508 0 00-2.08-1.287V9.48a31.525 31.525 0 00-2.485.576 41.272 41.272 0 00-.395-5.043A41.073 41.073 0 019.664 1.32zm-4.251 9.04a31.268 31.268 0 01-1.62 1.428A31.532 31.532 0 012.149 12.5a.75.75 0 00-.568 1.37 33.094 33.094 0 013.076 1.484c.5.304.98.608 1.442.912v-.003a32.014 32.014 0 011.1.748 32.14 32.14 0 001.05-.748v.003a32.014 32.014 0 011.442-.912 33.26 33.26 0 013.076-1.484.75.75 0 00-.569-1.37 31.532 31.532 0 01-1.779-.822A31.268 31.268 0 0110 12.44a31.268 31.268 0 01-1.62-1.428 31.268 31.268 0 01-2.967-1.652z" clip-rule="evenodd"/></svg>
        </span>
        <h3 class="section-title">Super-admins</h3>
        {#if !loading}
          <span class="section-count">{Object.keys(supers).length}</span>
        {/if}
      </div>
    </div>

    {#if loading}
      <p class="empty">Loading…</p>
    {:else if Object.keys(supers).length === 0}
      <p class="empty">No super-admins recorded.</p>
    {:else}
      <ul class="person-list">
        {#each Object.keys(supers) as uid (uid)}
          {@const lbl = userLabel(uid)}
          <li class="person-row">
            <div class="person-avatar person-avatar-super">
              {(lbl.name || lbl.email || uid).charAt(0).toUpperCase()}
            </div>
            <div class="person-info">
              {#if lbl.name}
                <span class="person-name">{lbl.name}</span>
              {/if}
              {#if lbl.email}
                <span class="person-email">{lbl.email}</span>
              {:else if !lbl.hasMirror}
                <code class="uid">{uid}</code>
              {/if}
            </div>
            <div class="person-badges">
              {#if uid === meUid}<span class="chip chip-you">You</span>{/if}
              <span class="badge badge-super">Super</span>
            </div>
          </li>
        {/each}
      </ul>
      <p class="note">
        Super role is uneditable from this UI — edit <code>/adminRoles</code> in Firebase console directly.
      </p>
    {/if}
  </div>

  <!-- Organisers -->
  <div class="section-block">
    <div class="section-head">
      <div class="section-head-left">
        <span class="section-icon section-icon-org">
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.516 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.655zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.516 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.654zM18 8a2 2 0 11-4 0 2 2 0 014 0zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z"/></svg>
        </span>
        <h3 class="section-title">Organisers</h3>
        {#if !loading}
          <span class="section-count">{organiserUids.size}</span>
        {/if}
      </div>
    </div>

    <!-- Onboard form -->
    <div class="onboard-form">
      <div class="onboard-form-inner">
        <label class="onboard-label" for="onboard-input">
          <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
          Add organiser
        </label>
        <div class="user-combo">
          <input
            id="onboard-input"
            type="text"
            bind:value={addEmail}
            placeholder="Search by name or email…"
            aria-label="Recipient name or email"
            aria-expanded={addDropdownOpen && addSuggestions.length > 0}
            aria-autocomplete="list"
            role="combobox"
            maxlength="128"
            autocomplete="off"
            oninput={() => { addDropdownOpen = !!addEmail.trim(); addHighlight = 0; }}
            onfocus={() => { if (addEmail.trim()) { addDropdownOpen = true; addHighlight = -1; } }}
            onblur={() => setTimeout(() => { addDropdownOpen = false; }, 200)}
            onkeydown={onAddKeydown}
          />
          {#if addDropdownOpen && addSuggestions.length > 0}
            <ul class="user-suggest" role="listbox">
              {#each addSuggestions as u, i (u.uid ?? u.email)}
                <li role="option" aria-selected={i === addHighlight}>
                  <button
                    type="button"
                    class:suggest-active={i === addHighlight}
                    onmouseenter={() => (addHighlight = i)}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => pickSuggestion(u)}
                  >
                    <div class="suggest-avatar">{(u.displayName || u.email || '?').charAt(0).toUpperCase()}</div>
                    <div class="suggest-text">
                      {#if u.displayName}<span class="u-name">{u.displayName}</span>{/if}
                      <span class="u-email">{u.email}</span>
                    </div>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if addDropdownOpen && addEmail.trim() && addSuggestions.length === 0}
            <div class="user-suggest user-suggest-empty">
              No signed-in user found — have them visit /admin/ once first
            </div>
          {/if}
        </div>
        <button
          type="button"
          class="btn btn-primary"
          onclick={onboardOrganiser}
          disabled={saving || !addEmail.trim()}
        >
          {#if saving}
            Onboarding…
          {:else}
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v2.5h-2.5a.75.75 0 000 1.5h2.5v2.5a.75.75 0 001.5 0v-2.5h2.5a.75.75 0 000-1.5h-2.5v-2.5z" clip-rule="evenodd"/></svg>
            Onboard as organiser
          {/if}
        </button>
      </div>
    </div>

    {#if loading}
      <p class="empty">Loading…</p>
    {:else if organiserUids.size === 0}
      <p class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"/></svg>
        No organisers onboarded yet
      </p>
    {:else}
      <ul class="person-list">
        {#each [...organiserUids] as uid (uid)}
          {@const lbl = userLabel(uid)}
          <li class="person-row" class:person-row-confirming={confirmingRevokeUid === uid}>
            <div class="person-avatar person-avatar-org">
              {(lbl.name || lbl.email || uid).charAt(0).toUpperCase()}
            </div>
            <div class="person-info">
              {#if lbl.name}
                <span class="person-name">{lbl.name}</span>
              {/if}
              {#if lbl.email}
                <span class="person-email">{lbl.email}</span>
              {:else if !lbl.hasMirror}
                <code class="uid">{uid}</code>
              {/if}
            </div>
            <div class="person-right">
              <span class="badge badge-organiser">Organiser</span>
              {#if confirmingRevokeUid === uid}
                <div class="revoke-confirm">
                  <span class="revoke-question">Revoke access?</span>
                  <button type="button" class="btn btn-danger-sm" onclick={() => confirmRevoke(uid)} disabled={saving}>
                    {saving ? '…' : 'Confirm'}
                  </button>
                  <button type="button" class="btn btn-ghost-sm" onclick={cancelRevoke} disabled={saving}>Cancel</button>
                </div>
              {:else}
                <button type="button" class="btn-revoke" onclick={() => startRevoke(uid)} disabled={saving}>
                  Revoke
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .roles {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding-bottom: 1.5rem;
  }

  /* Flash banner */
  .banner {
    padding: 0.55rem 0.85rem;
    background: rgba(76, 175, 80, 0.12);
    border: 1px solid rgba(76, 175, 80, 0.35);
    color: #66bb6a;
    border-radius: 0.5rem;
    font-size: 0.85rem;
  }
  .banner-err {
    background: rgba(239, 83, 80, 0.12);
    border-color: rgba(239, 83, 80, 0.35);
    color: #ef8985;
  }

  /* Section card */
  .section-block {
    display: flex;
    flex-direction: column;
    gap: 0;
    background: #141414;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.75rem;
  }

  /* Section header row */
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem 0.65rem;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    border-radius: 0.75rem 0.75rem 0 0;
  }
  .section-head-left {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .section-icon {
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 0.4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .section-icon-super {
    background: rgba(255,213,74,0.12);
    color: var(--accent, #ffd54a);
  }
  .section-icon-org {
    background: rgba(79,195,247,0.12);
    color: var(--side-a, #4fc3f7);
  }
  .section-title {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--fg, #f5f5f5);
    letter-spacing: 0.01em;
  }
  .section-count {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--muted, #888);
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 999px;
    padding: 0.05rem 0.45rem;
    font-variant-numeric: tabular-nums;
  }

  /* Person list */
  .person-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-radius: 0 0 0.75rem 0.75rem;
    overflow: hidden;
  }
  .person-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    transition: background 0.1s;
  }
  .person-row:last-child { border-bottom: none; }
  .person-row:hover { background: rgba(255,255,255,0.02); }
  .person-row-confirming { background: rgba(239,83,80,0.04); }

  /* Avatar circle with initial */
  .person-avatar {
    width: 2.2rem;
    height: 2.2rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
    font-weight: 700;
    flex-shrink: 0;
    letter-spacing: 0;
  }
  .person-avatar-super {
    background: rgba(255,213,74,0.15);
    color: var(--accent, #ffd54a);
    border: 1.5px solid rgba(255,213,74,0.25);
  }
  .person-avatar-org {
    background: rgba(79,195,247,0.12);
    color: var(--side-a, #4fc3f7);
    border: 1.5px solid rgba(79,195,247,0.2);
  }

  .person-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .person-name {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--fg, #f5f5f5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .person-email {
    font-size: 0.75rem;
    color: var(--muted, #888);
    overflow-wrap: anywhere;
  }

  .person-badges {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .person-right {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .badge {
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    font-weight: 700;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .badge-super {
    color: var(--accent, #ffd54a);
    background: rgba(255,213,74,0.12);
    border: 1px solid rgba(255,213,74,0.3);
  }
  .badge-organiser {
    color: var(--side-a, #4fc3f7);
    background: rgba(79,195,247,0.1);
    border: 1px solid rgba(79,195,247,0.3);
  }

  .chip-you {
    font-size: 0.68rem;
    font-weight: 700;
    color: var(--accent, #ffd54a);
    background: rgba(255,213,74,0.1);
    border: 1px solid rgba(255,213,74,0.3);
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .uid {
    font-size: 0.72rem;
    font-family: monospace;
    background: rgba(255,255,255,0.04);
    padding: 0.1rem 0.35rem;
    border-radius: 0.3rem;
    overflow-wrap: anywhere;
    color: var(--muted, #888);
  }

  /* Note below super list */
  .note {
    color: var(--muted, #888);
    font-size: 0.75rem;
    line-height: 1.5;
    margin: 0;
    padding: 0.6rem 1rem;
    background: rgba(255,213,74,0.04);
    border-top: 1px solid rgba(255,213,74,0.12);
    border-radius: 0 0 0.75rem 0.75rem;
  }
  .note code {
    font-family: monospace;
    background: rgba(255,255,255,0.05);
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.9em;
  }

  /* Onboard form */
  .onboard-form {
    padding: 0.85rem 1rem;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    background: rgba(79,195,247,0.025);
  }
  .onboard-form-inner {
    display: flex;
    gap: 0.6rem;
    align-items: flex-end;
  }
  .onboard-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--side-a, #4fc3f7);
    margin-bottom: 0.3rem;
  }
  .user-combo {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .user-combo input {
    width: 100%;
    background: #0d0d0d;
    color: var(--fg, #f5f5f5);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.45rem;
    padding: 0.5rem 0.7rem;
    font: inherit;
    font-size: 0.88rem;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .user-combo input:focus {
    outline: none;
    border-color: var(--side-a, #4fc3f7);
    background: #111;
  }

  .user-suggest {
    position: absolute;
    top: calc(100% + 0.3rem);
    left: 0;
    right: 0;
    margin: 0;
    padding: 0.3rem;
    list-style: none;
    background: #161616;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.55rem;
    max-height: 14rem;
    overflow-y: auto;
    z-index: 20;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .user-suggest li { list-style: none; }
  .user-suggest button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: transparent;
    border: 0;
    border-radius: 0.35rem;
    color: var(--fg, #f5f5f5);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .user-suggest button:hover,
  .user-suggest button.suggest-active {
    background: rgba(79,195,247,0.08);
    outline: none;
  }
  .suggest-avatar {
    width: 1.7rem;
    height: 1.7rem;
    border-radius: 50%;
    background: rgba(79,195,247,0.12);
    color: var(--side-a, #4fc3f7);
    font-size: 0.78rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .suggest-text { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
  .u-name { font-size: 0.85rem; font-weight: 600; }
  .u-email { font-size: 0.73rem; color: var(--muted, #888); }
  .user-suggest-empty {
    padding: 0.65rem 0.75rem;
    font-size: 0.8rem;
    color: var(--muted, #888);
    font-style: italic;
  }

  /* Empty state */
  .empty { color: var(--muted, #888); text-align: center; padding: 1.25rem; margin: 0; font-size: 0.85rem; }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.75rem 1rem;
    color: var(--muted, #888);
    font-size: 0.82rem;
    text-align: center;
    margin: 0;
  }
  .empty-state svg { opacity: 0.3; }

  /* Revoke inline confirm */
  .revoke-confirm {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .revoke-question {
    font-size: 0.78rem;
    color: #ef8985;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    color: var(--fg, #f5f5f5);
    border-radius: 0.45rem;
    padding: 0.5rem 1rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-primary {
    background: var(--side-a, #4fc3f7);
    color: #0a0a0a;
    border-color: transparent;
    font-weight: 700;
    white-space: nowrap;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }

  .btn-revoke {
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    background: none;
    border: 1px solid rgba(239,83,80,0.3);
    color: #ef8985;
    border-radius: 0.35rem;
    padding: 0.25rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-revoke:hover:not(:disabled) { background: rgba(239,83,80,0.1); }
  .btn-revoke:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-danger-sm {
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    background: rgba(239,83,80,0.14);
    border: 1px solid rgba(239,83,80,0.4);
    color: #ef5350;
    border-radius: 0.35rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .btn-danger-sm:hover:not(:disabled) { background: rgba(239,83,80,0.22); }
  .btn-danger-sm:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost-sm {
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--muted, #888);
    border-radius: 0.35rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .btn-ghost-sm:hover:not(:disabled) { background: rgba(255,255,255,0.05); }
  .btn-ghost-sm:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
