<script lang="ts">
  /**
   * Compact sign-in pill. Two visual states:
   *   - Signed out → "Sign in" pill; tap opens the Google popup.
   *   - Signed in  → avatar + display name pill; tap opens a menu
   *     with role badge + Sign out.
   *
   * Props:
   *   signedInOnly — when true, renders NOTHING while signed out.
   *     Used on /live/ so casual visitors aren't prompted to sign
   *     in there. Sign-in lives exclusively on the home footer's
   *     "Admin" link.
   *
   * Also owns the auth ↔ roles wiring: subscribes to `auth` and
   * pushes the current uid into `roles` so admin controls light up
   * as soon as auth resolves. Bootstrap self-promotion fires on
   * first sign-in.
   */
  import { onMount } from 'svelte';
  import { signIn, signOut, subscribeAuth, type AuthUser } from '../lib/auth';
  import {
    bootstrapSuperIfNeeded,
    setCurrentUidForRoles,
    subscribeCurrentUserRole,
    type Role,
  } from '../lib/roles';
  import { upsertOwnUserMirror } from '../lib/users';
  import { subscribeConnectivity } from '../lib/connectivity';

  interface Props {
    signedInOnly?: boolean;
    /** Text on the signed-out pill. Defaults to "Sign in". Home
     *  footer overrides to "Admin" so the affordance reads as an
     *  admin entry point on first paint, not a sign-in prompt. */
    signedOutLabel?: string;
    /** When true, the account dropdown opens upward (menu sits ABOVE
     *  the pill). Used on the home footer, which is at the bottom of
     *  the viewport — a downward menu would clip below the fold.
     *  Default false: menu drops downward as usual (lobby header). */
    dropUp?: boolean;
  }
  const {
    signedInOnly = false,
    signedOutLabel = 'Sign in',
    dropUp = false,
  }: Props = $props();

  /** Resolved at component load; used to build the /admin/ link.
   *  Kept module-level (not reactive) — the base URL doesn't change
   *  during a session and Astro inlines it at build time. */
  const adminBase: string = import.meta.env.BASE_URL;

  let user = $state<AuthUser | null>(null);
  let role = $state<Role | null>(null);
  let menuOpen = $state(false);
  /**
   * Mirrors connectivity's `online` flag. Google sign-in's popup
   * requires internet to complete the OAuth round-trip; hanging
   * offline is worse than showing the button as disabled with a
   * clear tooltip. Drives the signed-out pill's disabled state.
   * Signed-in dropdown items still work offline — Sign out just
   * clears local auth state.
   */
  let online = $state(true);

  /**
   * Svelte action: fires a callback when a click happens outside the
   * element the action is attached to, or when Escape is pressed.
   * Used to close the account dropdown without a full-screen
   * backdrop overlay.
   */
  function onOutsideClick(node: HTMLElement, callback: () => void) {
    function onDoc(e: MouseEvent) {
      if (!node.contains(e.target as Node)) callback();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') callback();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return {
      destroy() {
        document.removeEventListener('mousedown', onDoc);
        document.removeEventListener('keydown', onKey);
      },
    };
  }

  function onDropdownKey(e: KeyboardEvent) {
    if (e.key === 'Escape') menuOpen = false;
  }

  onMount(() => {
    const unsubAuth = subscribeAuth((u) => {
      user = u;
      setCurrentUidForRoles(u?.uid ?? null);
      // Try the bootstrap door on every sign-in. It's cheap (one RTDB
      // read gated by an env var match) and idempotent — the rule
      // itself refuses once a super already exists.
      if (u?.uid) void bootstrapSuperIfNeeded(u.uid);
      // Mirror the auth user into /users/{uid} so the admin panel
      // can render display names + emails alongside UIDs, and so
      // the maintainer can invite by email (email→UID resolution
      // is done client-side by scanning /users for a match).
      if (u) void upsertOwnUserMirror(u);
    });
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    const unsubConn = subscribeConnectivity((state) => {
      online = state.online;
    });
    return () => {
      unsubAuth();
      unsubRole();
      unsubConn();
    };
  });

  function onSignIn() {
    void signIn();
  }
  function onSignOut() {
    menuOpen = false;
    void signOut();
  }

</script>

{#if !user}
  {#if !signedInOnly}
    <button
      type="button"
      class="signin-pill"
      class:signin-offline={!online}
      onclick={onSignIn}
      disabled={!online}
      aria-label={online
        ? `${signedOutLabel} — Sign in with Google`
        : `${signedOutLabel} — connect to the internet to sign in`}
      title={online ? undefined : 'Connect to the internet to sign in'}
    >
      <span class="g" aria-hidden="true">G</span>
      <span>{signedOutLabel}</span>
    </button>
  {/if}
{:else}
  <!--
    Signed-in avatar pill + inline dropdown. The dropdown is a
    sibling anchored via a shared `.user-pill-wrap` positioner so
    the menu sits directly under the pill (no full-screen backdrop
    popup — testers found that heavy for a two-item menu). Outside
    click / Escape closes.
  -->
  <div class="user-pill-wrap" use:onOutsideClick={() => (menuOpen = false)}>
    <button
      type="button"
      class="user-pill"
      onclick={() => (menuOpen = !menuOpen)}
      aria-label="Account menu"
      aria-expanded={menuOpen}
      aria-haspopup="menu"
    >
      {#if user.photoURL}
        <img class="avatar" src={user.photoURL} alt="" width="20" height="20" />
      {:else}
        <span class="avatar avatar-fallback" aria-hidden="true">
          {(user.displayName || user.email || '?').charAt(0).toUpperCase()}
        </span>
      {/if}
      <span class="user-name">{user.displayName || user.email}</span>
      <!--
        Chevron points toward the direction the menu will open, so
        the affordance is honest before it opens: ▾ when the menu
        drops below, ▴ when it opens upward (footer variant). On
        open, both rotate 180° to invert. Keeps hint + reality in
        sync.
      -->
      <span
        class="chev"
        class:chev-open={menuOpen}
        aria-hidden="true"
      >{dropUp ? '▴' : '▾'}</span>
    </button>

    {#if menuOpen}
      <div
        class="dropdown"
        class:dropdown-up={dropUp}
        role="menu"
        onkeydown={onDropdownKey}
      >
        <div class="dropdown-hdr">
          <div class="dropdown-name">
            {user.displayName || 'Signed in'}
            {#if role?.isSuper}<span class="role-badge role-super">SUPER</span>{/if}
            {#if role && !role.isSuper && role.organiserOf.size > 0}
              <span class="role-badge role-organiser">ORGANISER · {role.organiserOf.size}</span>
            {/if}
          </div>
          {#if user.email}<div class="dropdown-email">{user.email}</div>{/if}
        </div>
        {#if role?.isSuper}
          <!--
            Super-admin gets a link to the global /admin/ page.
            Anchor uses import.meta.env.BASE_URL so it resolves relative
            to whatever base path this build was deployed under.
          -->
          <a
            class="dropdown-item"
            href={`${adminBase}admin/`}
            role="menuitem"
            onclick={() => (menuOpen = false)}
          >Open admin panel ⇗</a>
        {/if}
        <button type="button" class="dropdown-item dropdown-item-danger" onclick={onSignOut} role="menuitem">
          Sign out
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Sign-in pill — outlined chip with the Google G. Kept compact so
     it doesn't compete with the header title. */
  .signin-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.7rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: var(--fg, #f5f5f5);
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    -webkit-tap-highlight-color: transparent;
  }
  .signin-pill:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.28);
  }
  /* Offline: no Google popup can complete without internet. Grey
     the pill out with a "not-allowed" cursor so the umpire knows
     it's disabled on purpose. Tooltip explains why. */
  .signin-pill:disabled,
  .signin-offline {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .signin-pill:disabled:hover,
  .signin-offline:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.16);
  }
  .g {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.05rem;
    height: 1.05rem;
    background: #fff;
    color: #4285f4;
    border-radius: 999px;
    font-weight: 800;
    font-size: 0.75rem;
    line-height: 1;
  }

  /* Signed-in pill mirrors the layout but leads with the avatar and
     adds a chevron for the menu affordance. */
  .user-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.55rem 0.2rem 0.25rem;
    background: rgba(255, 213, 74, 0.1);
    border: 1px solid rgba(255, 213, 74, 0.3);
    color: var(--accent, #ffd54a);
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    max-width: 12rem;
    transition: background 0.12s, border-color 0.12s;
    -webkit-tap-highlight-color: transparent;
  }
  .user-pill:hover {
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.44);
  }
  .avatar {
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 213, 74, 0.24);
    color: var(--accent, #ffd54a);
    font-weight: 700;
    font-size: 0.78rem;
    flex-shrink: 0;
    object-fit: cover;
  }
  .avatar-fallback {
    /* Inherits .avatar sizing — extra hook if we ever want a different
       treatment for initial-letter avatars. */
  }
  .user-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .chev {
    font-size: 0.65rem;
    opacity: 0.7;
    transition: transform 0.14s;
  }
  .chev-open {
    transform: rotate(180deg);
  }

  /* Positioner + dropdown. `.user-pill-wrap` is relative-positioned
     so the dropdown can absolute-position underneath the pill.
     Anchored right (not left) so the pill's rightmost edge stays
     the reference — a long user name shifts the pill left, and we
     want the dropdown to still fit inside the viewport. */
  .user-pill-wrap {
    position: relative;
    display: inline-flex;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 250;
    min-width: 12rem;
    max-width: 18rem;
    background: #141414;
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.65rem;
    padding: 0.5rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  /* Upward variant: dropdown sits ABOVE the pill instead of below.
     Used on the home footer where the pill is close to the viewport
     bottom — a downward menu would clip. `bottom` anchors from the
     pill's top edge; shadow flips so it still reads as elevated. */
  .dropdown.dropdown-up {
    top: auto;
    bottom: calc(100% + 0.4rem);
    box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.5);
  }
  .dropdown-hdr {
    padding: 0.35rem 0.5rem 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 0.3rem;
  }
  .dropdown-name {
    color: var(--fg, #f5f5f5);
    font-weight: 700;
    font-size: 0.88rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  /* Role indicator — quick visual proof that /adminRoles read fired.
     'SUPER' for the maintainer; 'ORGANISER · N' for tournament
     organisers (N = number of events they organise). Absent for
     signed-in-but-no-role users. */
  .role-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 800;
  }
  .role-super {
    background: rgba(255, 213, 74, 0.18);
    color: var(--accent, #ffd54a);
    border: 1px solid rgba(255, 213, 74, 0.5);
  }
  .role-organiser {
    background: rgba(79, 195, 247, 0.18);
    color: var(--side-a, #4fc3f7);
    border: 1px solid rgba(79, 195, 247, 0.5);
  }
  .dropdown-email {
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
    margin-top: 0.15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dropdown-item {
    display: block;
    width: 100%;
    padding: 0.5rem 0.55rem;
    background: transparent;
    border: none;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: left;
    border-radius: 0.4rem;
    cursor: pointer;
    transition: background 0.1s;
    /* Strip the default anchor underline for the "Open admin panel"
       link. Menu items are styled as pills, not typographic links. */
    text-decoration: none;
  }
  .dropdown-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .dropdown-item-danger {
    color: var(--danger, #ef5350);
  }
  .dropdown-item-danger:hover {
    background: rgba(239, 83, 80, 0.1);
  }
</style>
