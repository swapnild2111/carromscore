<script lang="ts">
  /**
   * Compact sign-in pill. Two visual states:
   *   - Signed out → "Sign in" pill; tap opens the Google popup.
   *   - Signed in  → avatar + display name pill; tap opens a menu
   *     with "Sign out" and a "Show UID" affordance so organisers
   *     can copy their UID to share with the super-admin.
   *
   * Mounted only where admins operate (lobby header, per plan). NOT
   * mounted on the home page — that would prompt casual users. The
   * home page uses a discreet "Admin" text link in its footer instead.
   *
   * Owns the auth ↔ roles wiring: subscribes to `auth` and pushes the
   * current uid into `roles` so admin controls throughout the app
   * light up as soon as auth resolves. Also runs the one-time
   * bootstrap self-promotion check on first sign-in.
   */
  import { onMount } from 'svelte';
  import { signIn, signOut, subscribeAuth, type AuthUser } from '../lib/auth';
  import {
    bootstrapSuperIfNeeded,
    setCurrentUidForRoles,
    subscribeCurrentUserRole,
    type Role,
  } from '../lib/roles';

  let user = $state<AuthUser | null>(null);
  let role = $state<Role | null>(null);
  let menuOpen = $state(false);
  let uidCopied = $state(false);

  onMount(() => {
    const unsubAuth = subscribeAuth((u) => {
      user = u;
      setCurrentUidForRoles(u?.uid ?? null);
      // Try the bootstrap door on every sign-in. It's cheap (one RTDB
      // read gated by an env var match) and idempotent — the rule
      // itself refuses once a super already exists.
      if (u?.uid) void bootstrapSuperIfNeeded(u.uid);
    });
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    return () => {
      unsubAuth();
      unsubRole();
    };
  });

  function onSignIn() {
    void signIn();
  }
  function onSignOut() {
    menuOpen = false;
    void signOut();
  }
  async function copyUid() {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      uidCopied = true;
      window.setTimeout(() => {
        uidCopied = false;
      }, 1500);
    } catch {
      // Clipboard denied. Users can long-press to select+copy manually.
    }
  }

  function closeMenu(e: MouseEvent) {
    if (e.target === e.currentTarget) menuOpen = false;
  }
</script>

{#if !user}
  <button
    type="button"
    class="signin-pill"
    onclick={onSignIn}
    aria-label="Sign in with Google"
  >
    <span class="g" aria-hidden="true">G</span>
    <span>Sign in</span>
  </button>
{:else}
  <button
    type="button"
    class="user-pill"
    onclick={() => (menuOpen = !menuOpen)}
    aria-label="Account menu"
    aria-expanded={menuOpen}
  >
    {#if user.photoURL}
      <img class="avatar" src={user.photoURL} alt="" width="20" height="20" />
    {:else}
      <span class="avatar avatar-fallback" aria-hidden="true">
        {(user.displayName || user.email || '?').charAt(0).toUpperCase()}
      </span>
    {/if}
    <span class="user-name">{user.displayName || user.email}</span>
    <span class="chev" aria-hidden="true">▾</span>
  </button>

  {#if menuOpen}
    <div class="menu-backdrop" onclick={closeMenu} role="presentation">
      <div class="menu" role="menu">
        <div class="menu-hdr">
          <div class="menu-name">
            {user.displayName || 'Signed in'}
            {#if role?.isSuper}<span class="role-badge role-super">SUPER</span>{/if}
            {#if role && !role.isSuper && role.organiserOf.size > 0}
              <span class="role-badge role-organiser">ORGANISER · {role.organiserOf.size}</span>
            {/if}
          </div>
          {#if user.email}<div class="menu-email">{user.email}</div>{/if}
        </div>
        <button type="button" class="menu-item" onclick={copyUid} role="menuitem">
          {uidCopied ? '✓ UID copied' : 'Copy UID'}
        </button>
        <button type="button" class="menu-item menu-item-danger" onclick={onSignOut} role="menuitem">
          Sign out
        </button>
      </div>
    </div>
  {/if}
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
  .signin-pill:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.28);
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
  }

  /* Menu overlay — fixed so it always centres over the viewport
     regardless of where the pill was tapped from. */
  .menu-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 4rem 1rem 1rem;
    z-index: 250;
  }
  .menu {
    background: #141414;
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.75rem;
    padding: 0.6rem;
    min-width: 15rem;
    max-width: 22rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  .menu-hdr {
    padding: 0.4rem 0.55rem 0.7rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 0.35rem;
  }
  .menu-name {
    color: var(--fg, #f5f5f5);
    font-weight: 700;
    font-size: 0.9rem;
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
    font-size: 0.65rem;
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
  .menu-email {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    margin-top: 0.15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-item {
    display: block;
    width: 100%;
    padding: 0.55rem 0.6rem;
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
  }
  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .menu-item-danger {
    color: var(--danger, #ef5350);
  }
  .menu-item-danger:hover {
    background: rgba(239, 83, 80, 0.1);
  }
</style>
