<script lang="ts">
  /**
   * /admin/ shell. Two role bands can enter:
   *
   *   - Super-admin — sees every tab (Roles, Players, Tournaments,
   *     Live, History, Audit).
   *   - Organiser (any /tournaments/{key}/organisers/{uid} = true) —
   *     sees Players, Tournaments, Live, History. Roles and Audit
   *     are super-only.
   *
   * Anyone else (anonymous, or signed-in with no role) sees an
   * "access denied" gate with their UID for the super-admin to grant.
   *
   * Client-side gating here is UX only — the RTDB rules on each
   * write path are the actual enforcement. Every helper this page
   * calls is either super-only (Roles, Audit) or gated per-record
   * on tournament organiser membership (Live delete, History delete,
   * Match edit), or unauthorised (organisers cannot delete /players/
   * or /tournaments/ that aren't theirs).
   */
  import { onMount } from 'svelte';
  import { subscribeAuth, type AuthUser } from '../lib/auth';
  import {
    setCurrentUidForRoles,
    subscribeCurrentUserRole,
    type Role,
  } from '../lib/roles';
  import SignInButton from './SignInButton.svelte';
  // FeedbackPopup removed — v3.4.8 merged the admin footer's
  // separate "Feedback" link into the "Help" entry, which points
  // at /help/ where the popup now lives.
  import { APP_VERSION, releaseUrl } from '../lib/version';
  import AdminPlayers from './AdminPlayers.svelte';
  import AdminTournaments from './AdminTournaments.svelte';
  import AdminLiveCleanup from './AdminLiveCleanup.svelte';
  import AdminHistoryCleanup from './AdminHistoryCleanup.svelte';
  import AdminAuditLog from './AdminAuditLog.svelte';
  import AdminRoles from './AdminRoles.svelte';
  import { logScreen } from '../lib/analytics';

  type Tab = 'players' | 'tournaments' | 'live' | 'history' | 'roles' | 'audit';

  const base: string = import.meta.env.BASE_URL;
  let user = $state<AuthUser | null>(null);
  let role = $state<Role | null>(null);
  let tab = $state<Tab>('roles');
  // roleLoaded tracks whether the /adminRoles subscription has
  // resolved at least once. Without it we'd flash "access denied"
  // for a super-admin during the ~200ms Firebase auth rehydrate.
  let roleLoaded = $state(false);

  /**
   * True when the signed-in user has ANY admin-plane access —
   * super-admin, or organiser of at least one tournament. The gate
   * uses this to decide whether to render the tab bar at all.
   * Individual tabs then check `role.isSuper` for super-only tabs.
   */
  const hasAdminAccess = $derived(!!(role && (role.isSuper || role.isOrganiser)));

  /**
   * Which tabs to render. Super-admin gets everything; organisers
   * get Players / Tournaments / Live / History but NOT Roles or
   * Audit — those are super-only surfaces (identity grants and
   * append-only audit trail).
   */
  const visibleTabs = $derived<Tab[]>(
    role?.isSuper
      ? ['roles', 'players', 'tournaments', 'live', 'history', 'audit']
      : ['players', 'tournaments', 'live', 'history'],
  );

  onMount(() => {
    // v3.4: log screen_view for the admin surface (no-op without consent).
    void logScreen('admin');
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

  /**
   * When the role resolves, land on the sensible default tab for
   * that role. Super-admins see Roles first (identity/access is the
   * most-frequent admin task). Organisers see Tournaments — the
   * likely reason they signed in was to manage their event.
   *
   * Fired at most once per session — `subscribeCurrentUserRole`
   * emits an EMPTY placeholder role immediately on subscribe (so
   * subscribers don't stall), then streams the real role afterwards
   * from /adminRoles and per-tournament organisers reads. Auto-
   * landing on the placeholder would misroute super-admins to the
   * organiser default; landing only once, after either the super
   * flag is true OR the organiser set has some entry, avoids the
   * placeholder race.
   *
   * Also fires if a role change makes the current tab invalid
   * (e.g. super revocation while sitting on the Audit tab).
   */
  let landed = $state(false);
  $effect(() => {
    if (!roleLoaded || !role) return;
    const hasResolvedRole = role.isSuper || role.isOrganiser;
    if (!landed && hasResolvedRole) {
      tab = role.isSuper ? 'roles' : 'tournaments';
      landed = true;
      return;
    }
    // Post-landing safety: if the tab becomes invalid because role
    // changed (super revoked, organiser removed), fall back.
    if (landed && !visibleTabs.includes(tab)) {
      tab = role.isSuper ? 'roles' : 'tournaments';
    }
  });
</script>

<main class="wrap">
  <header class="hdr">
    <a class="back" href={base}>← Home</a>
    <h1>Admin</h1>
    <!--
      Header used to carry a signed-in avatar chip. Moved to the
      new footer below (2026-08-11) so admin, home, and lobby all
      share the same auth-entry layout. Duplicate avatar in header
      + footer was confusing.
    -->
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
  {:else if !hasAdminAccess}
    <!--
      Signed in but no admin-plane access (not super, not organiser
      of any tournament). Show their UID so they can share it with a
      super-admin who'll grant them a role. Fall-through affordance:
      any signed-in user can still edit their OWN matches via the
      pencil in the lobby History tab — that permission comes from
      /matches/$id createdBy, not from an admin role.
    -->
    <div class="gate">
      <p class="gate-lead">You're signed in — but you don't have admin access yet.</p>
      <p class="gate-sub">
        Ask a super-admin to add you as an organiser for your tournament,
        or if you just want to fix your own matches, use the ✎ pencil in
        the <a href={`${base}live/`}>Live lobby</a>'s History tab.
      </p>
      {#if user.uid}
        <p class="gate-uid" title="Your Firebase UID">
          UID: <code>{user.uid}</code>
        </p>
      {/if}
    </div>
  {:else}
    <!--
      Admin view: tab bar filtered by role.
      Super-admin: all six tabs. Order is identity/access first
      (Roles), then curated data (Players, Tournaments), then
      cleanup (Live, History), then the audit trail.
      Organiser: four tabs (Players, Tournaments, Live, History) —
      Roles and Audit are super-only surfaces (identity grants + the
      append-only audit trail).

      $effect above lands the user on the sensible default tab for
      their role (Roles for super, Tournaments for organiser).
    -->
    <div class="tabs" role="tablist" aria-label="Admin sections">
      {#if visibleTabs.includes('roles')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'roles'}
          aria-selected={tab === 'roles'}
          onclick={() => (tab = 'roles')}
        >Roles</button>
      {/if}
      {#if visibleTabs.includes('players')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'players'}
          aria-selected={tab === 'players'}
          onclick={() => (tab = 'players')}
        >Players</button>
      {/if}
      {#if visibleTabs.includes('tournaments')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'tournaments'}
          aria-selected={tab === 'tournaments'}
          onclick={() => (tab = 'tournaments')}
        >Tournaments</button>
      {/if}
      {#if visibleTabs.includes('live')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'live'}
          aria-selected={tab === 'live'}
          onclick={() => (tab = 'live')}
        >Live matches</button>
      {/if}
      {#if visibleTabs.includes('history')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'history'}
          aria-selected={tab === 'history'}
          onclick={() => (tab = 'history')}
        >History cleanup</button>
      {/if}
      {#if visibleTabs.includes('audit')}
        <button
          type="button"
          role="tab"
          class="tab"
          class:tab-active={tab === 'audit'}
          aria-selected={tab === 'audit'}
          onclick={() => (tab = 'audit')}
        >Audit log</button>
      {/if}
    </div>

    <div class="panel" role="tabpanel">
      {#if tab === 'players' && visibleTabs.includes('players')}
        <AdminPlayers />
      {:else if tab === 'tournaments' && visibleTabs.includes('tournaments')}
        <AdminTournaments />
      {:else if tab === 'live' && visibleTabs.includes('live')}
        <AdminLiveCleanup />
      {:else if tab === 'history' && visibleTabs.includes('history')}
        <AdminHistoryCleanup />
      {:else if tab === 'roles' && visibleTabs.includes('roles')}
        <AdminRoles />
      {:else if tab === 'audit' && visibleTabs.includes('audit')}
        <AdminAuditLog />
      {/if}
    </div>
  {/if}

  <!--
    Admin footer. Same shape as the home + lobby footers so every
    screen in the app reads as one product. Row 1: Help ⇗ · Donate
    ❤ · Admin (signed-in avatar or sign-in link). Row 2: version
    pill (links to that release's notes on GitHub) + copyright.
    CSS below is copied verbatim from LiveLobby / home —
    component-scoped styles can't be shared, so a change here
    should be mirrored to the other two.
    v3.4.8: "How to use" + "Feedback" merged into one Help entry.
  -->
  <div class="foot-block">
    <div class="foot-links">
      <a
        href={`${base}help/`}
        class="foot-link"
        aria-label="Help — how to use Carromscore + send feedback"
      >Help ⇗</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <a
        href="https://ko-fi.com/carromscore"
        target="_blank"
        rel="noopener noreferrer"
        class="foot-link foot-link-support"
        aria-label="Donate to Carromscore on Ko-fi"
      >Donate ❤</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <SignInButton dropUp />
    </div>
    <p class="foot-meta">
      <a
        class="foot-ver"
        href={releaseUrl()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Carromscore v${APP_VERSION} release notes on GitHub`}
      >v{APP_VERSION}</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      © 2026 Swapnil Deshpande
    </p>
  </div>
</main>

<style>
  /* Flex column with an EXPLICIT height (not min-height) so
     .panel > .list can scroll internally instead of pushing the
     whole page taller. `html, body` in BaseLayout use `min-height:
     100dvh` which allows body to grow past the viewport when child
     content is large — a fine default for page-flow surfaces (home,
     score, lobby) but wrong for admin, where we want the tab bar
     and toolbar pinned while the list scrolls.

     Height derives from the viewport minus the offline banner (set
     as --offline-banner-h on body[data-offline="true"] by BaseLayout).
     Fallback 0px when the banner isn't shown. */
  .wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: 1rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    height: calc(100dvh - var(--offline-banner-h, 0px));
    /* Belt-and-braces: prevent horizontal creep from long slugs / long
       tournament names widening the flex container. */
    overflow: hidden;
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

  /* Flex-column so each tab component can become its own vertical
     stack of banner → toolbar → scrollable list. `flex: 1` claims all
     remaining vertical space; `min-height: 0` is critical — without it
     the flex child inherits `min-height: auto` and overflows instead
     of scrolling internally. */
  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0.75rem 0 0;
  }
  /* Each tab component's root element sits in .panel. Same flex-column
     dance so its .list can scroll independently.

     :global because Svelte's component-scoped selectors don't reach
     into child components; this rule targets the section-like root
     rendered by AdminPlayers / AdminTournaments / etc. */
  .panel :global(> section),
  .panel :global(> div) {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* Default per-tab pattern: the tab's <ul class="list"> is the
     scroll container, sitting under a sticky toolbar. Padding-right
     leaves room for the scrollbar so it doesn't overlap row content. */
  .panel :global(.list) {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding-right: 0.25rem;
    padding-bottom: 0.5rem;
  }
  /* Rows inside the scrolling list must NOT shrink — every tab's
     .list uses display: flex; flex-direction: column, which makes
     each <li> a flex child, and flex children default to shrinking
     when the parent is `flex: 1`. Without this override, rows
     collapse into hairlines (audit rows have small content and were
     the first to expose it). */
  .panel :global(.list > *) {
    flex-shrink: 0;
  }
  /* Opt-out pattern: some tabs (Roles) render multiple nested lists
     inside sub-panels, so scrolling only the single <ul.list> would
     confine scroll to a tiny inner viewport. Those tabs mark their
     root <section> with `admin-tab-scrollself` — the section itself
     becomes the scroll container, and its internal lists fall back
     to natural height (flex: none, no overflow of their own). */
  .panel :global(> .admin-tab-scrollself) {
    overflow-y: auto;
    min-height: 0;
    padding-right: 0.25rem;
    padding-bottom: 0.5rem;
  }
  .panel :global(> .admin-tab-scrollself .list) {
    flex: none;
    overflow-y: visible;
    min-height: auto;
    padding-right: 0;
    padding-bottom: 0;
  }

  /* Footer — copied verbatim from LiveLobby + MatchSetup so every
     screen shares the same look. Component-scoped Svelte CSS can't
     be shared across three files without a base stylesheet; a change
     here should be mirrored to both other places. */
  .foot-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    margin: 1.5rem 0 0.75rem;
  }
  .foot-links {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .foot-meta {
    text-align: center;
    color: var(--muted);
    font-size: 0.72rem;
    margin: 0;
    letter-spacing: 0.02em;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .foot-sep { opacity: 0.4; }
  .foot-ver {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 999px;
    color: var(--accent);
    font-family: inherit;
    font-weight: 700;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    line-height: 1;
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  }
  .foot-ver:hover {
    background: rgba(255, 213, 74, 0.22);
    border-color: rgba(255, 213, 74, 0.55);
  }
  .foot-link {
    color: var(--fg);
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 600;
    transition: color 0.15s, background 0.15s;
  }
  .foot-link:hover {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.08);
  }
  /* Support link — golden accent, not red. */
  .foot-link-support {
    color: var(--accent);
  }
  .foot-link-support:hover {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.14);
  }
</style>
