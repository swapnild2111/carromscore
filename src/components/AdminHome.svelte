<script lang="ts">
  /**
   * /admin/ shell. Super-only page — anonymous or non-super users
   * see an "Access denied" screen with a Sign-in / Sign-out button
   * as appropriate. Super-admins see the tab bar and can switch
   * between Players, Tournaments, Live cleanup, and Audit.
   *
   * Client-side gating here is UX only — the RTDB rules are what
   * actually enforce super-only writes. Every helper this page
   * calls goes through the update/delete rule branches that check
   * `root.child('adminRoles').child(auth.uid).val() == 'super'`.
   */
  import { onMount } from 'svelte';
  import { subscribeAuth, type AuthUser } from '../lib/auth';
  import {
    setCurrentUidForRoles,
    subscribeCurrentUserRole,
    type Role,
  } from '../lib/roles';
  import SignInButton from './SignInButton.svelte';
  import AdminPlayers from './AdminPlayers.svelte';
  import AdminTournaments from './AdminTournaments.svelte';
  import AdminLiveCleanup from './AdminLiveCleanup.svelte';
  import AdminHistoryCleanup from './AdminHistoryCleanup.svelte';
  import AdminAuditLog from './AdminAuditLog.svelte';

  type Tab = 'players' | 'tournaments' | 'live' | 'history' | 'audit';

  const base: string = import.meta.env.BASE_URL;
  let user = $state<AuthUser | null>(null);
  let role = $state<Role | null>(null);
  let tab = $state<Tab>('players');
  // roleLoaded tracks whether the /adminRoles subscription has
  // resolved at least once. Without it we'd flash "access denied"
  // for a super-admin during the ~200ms Firebase auth rehydrate.
  let roleLoaded = $state(false);

  onMount(() => {
    const unsubAuth = subscribeAuth((u) => {
      user = u;
      setCurrentUidForRoles(u?.uid ?? null);
      // If we lost the user (sign-out), also reset the role-loaded
      // flag so the loading screen shows again on next sign-in.
      if (!u) roleLoaded = false;
    });
    const unsubRole = subscribeCurrentUserRole((r) => {
      role = r;
      if (r !== null) roleLoaded = true;
    });
    return () => {
      unsubAuth();
      unsubRole();
    };
  });
</script>

<main class="wrap">
  <header class="hdr">
    <a class="back" href={base}>← Home</a>
    <h1>Admin</h1>
    <SignInButton signedInOnly />
  </header>

  {#if !user}
    <!-- Anonymous → sign in first. -->
    <div class="gate">
      <p class="gate-lead">This page is for admins and tournament organisers.</p>
      <p class="gate-sub">Sign in with your Google account to continue.</p>
      <div class="gate-cta">
        <SignInButton signedOutLabel="Sign in with Google" />
      </div>
    </div>
  {:else if !roleLoaded}
    <div class="gate">
      <p class="gate-lead">Loading your role…</p>
    </div>
  {:else if !role?.isSuper}
    <!--
      Signed in but not super. Organisers get their affordances
      inline in the lobby (pencil on their tournament's cards) —
      the /admin/ page itself is super-only for now (Phase 4).
      Show a friendly note explaining that, plus their UID so they
      can share it with the super-admin if they need broader access.
    -->
    <div class="gate">
      <p class="gate-lead">You're signed in — but this page is super-admin only.</p>
      <p class="gate-sub">
        If you're a tournament organiser, edit your event's matches
        from the History tab in the <a href={`${base}live/`}>Live lobby</a>
        — a ✎ pencil appears on cards you can edit.
      </p>
      {#if user.uid}
        <p class="gate-uid" title="Your Firebase UID">
          UID: <code>{user.uid}</code>
        </p>
      {/if}
    </div>
  {:else}
    <!-- Super-admin view: full tab bar. -->
    <div class="tabs" role="tablist" aria-label="Admin sections">
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={tab === 'players'}
        aria-selected={tab === 'players'}
        onclick={() => (tab = 'players')}
      >Players</button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={tab === 'tournaments'}
        aria-selected={tab === 'tournaments'}
        onclick={() => (tab = 'tournaments')}
      >Tournaments</button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={tab === 'live'}
        aria-selected={tab === 'live'}
        onclick={() => (tab = 'live')}
      >Live cleanup</button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={tab === 'history'}
        aria-selected={tab === 'history'}
        onclick={() => (tab = 'history')}
      >History cleanup</button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={tab === 'audit'}
        aria-selected={tab === 'audit'}
        onclick={() => (tab = 'audit')}
      >Audit log</button>
    </div>

    <div class="panel" role="tabpanel">
      {#if tab === 'players'}
        <AdminPlayers />
      {:else if tab === 'tournaments'}
        <AdminTournaments />
      {:else if tab === 'live'}
        <AdminLiveCleanup />
      {:else if tab === 'history'}
        <AdminHistoryCleanup />
      {:else if tab === 'audit'}
        <AdminAuditLog />
      {/if}
    </div>
  {/if}
</main>

<style>
  .wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: 1rem 1rem 3rem;
  }
  .hdr {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .hdr h1 {
    flex: 1;
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .back {
    color: var(--accent, #ffd54a);
    text-decoration: none;
    font-weight: 600;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
  }
  .back:hover { background: rgba(255, 213, 74, 0.1); }

  .gate {
    text-align: center;
    padding: 2.5rem 1.5rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    margin: 2rem auto;
    max-width: 32rem;
  }
  .gate-lead {
    color: var(--fg, #f5f5f5);
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.55rem;
    line-height: 1.4;
  }
  .gate-sub {
    color: var(--muted, #9aa0a6);
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0 0 1rem;
  }
  .gate-sub a {
    color: var(--accent, #ffd54a);
    text-decoration: none;
  }
  .gate-sub a:hover { text-decoration: underline; }
  .gate-cta {
    display: flex;
    justify-content: center;
    margin-top: 0.5rem;
  }
  .gate-uid {
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    margin: 0.75rem 0 0;
  }
  .gate-uid code {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.15rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.85em;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0 0 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 0.35rem;
  }
  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted, #9aa0a6);
    padding: 0.5rem 0.85rem;
    border-radius: 0.5rem 0.5rem 0 0;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .tab:hover {
    color: var(--fg, #f5f5f5);
    background: rgba(255, 255, 255, 0.04);
  }
  .tab-active {
    color: var(--accent, #ffd54a);
    border-color: rgba(255, 213, 74, 0.3);
    background: rgba(255, 213, 74, 0.08);
  }

  .panel {
    padding: 0.75rem 0;
  }
</style>
