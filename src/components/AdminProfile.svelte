<script lang="ts">
  /**
   * Organiser profile editor. Stores profile data under
   * /organiserProfiles/{uid} in RTDB. Data is read back when
   * rendering print covers/reports so the organiser doesn't need
   * to re-enter their name/logo on every tournament.
   *
   * Fields:
   *   displayName   — shown as "Organised by …" on print covers
   *   orgName       — organisation / federation name
   *   address       — free text, multi-line
   *   phone         — phone number
   *   email         — email address
   *   website       — URL
   *   instagram / facebook / youtube / x — social handles (no @)
   *   logoUrl       — base64 data URL (≤ 2 MB image)
   *
   * RTDB path: /organiserProfiles/{uid}
   * Rules: uid can read+write their own record; super can read all.
   */
  import { onMount } from 'svelte';
  import { currentUser } from '../lib/auth';

  type Profile = {
    displayName: string;
    orgName: string;
    address: string;
    phone: string;
    email: string;
    website: string;
    instagram: string;
    facebook: string;
    youtube: string;
    x: string;
    logoUrl: string;
  };

  const EMPTY: Profile = {
    displayName: '',
    orgName: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    instagram: '',
    facebook: '',
    youtube: '',
    x: '',
    logoUrl: '',
  };

  let profile = $state<Profile>({ ...EMPTY });
  let saved = $state<Profile>({ ...EMPTY });
  let loading = $state(true);
  let saving = $state(false);
  let logoUploading = $state(false);
  let logoProgress = $state(0);
  let flashMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function flash(kind: 'ok' | 'err', text: string) {
    if (flashTimer) clearTimeout(flashTimer);
    flashMsg = { kind, text };
    flashTimer = setTimeout(() => (flashMsg = null), 3500);
  }

  const uid = $derived(currentUser()?.uid ?? null);

  const dirty = $derived(
    uid !== null &&
    !loading &&
    JSON.stringify(profile) !== JSON.stringify(saved),
  );

  onMount(() => {
    if (!uid) { loading = false; return; }
    void loadProfile();
  });

  async function loadProfile() {
    if (!uid) return;
    loading = true;
    try {
      const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
        import('../lib/firebase'),
        import('firebase/database'),
      ]);
      const db = getDatabase(firebaseApp());
      const snap = await get(ref(db, `organiserProfiles/${uid}`));
      if (snap.exists()) {
        const v = snap.val() as Partial<Profile>;
        const p: Profile = { ...EMPTY };
        for (const key of Object.keys(EMPTY) as (keyof Profile)[]) {
          if (typeof v[key] === 'string') p[key] = v[key] as string;
        }
        profile = { ...p };
        saved = { ...p };
      }
    } catch (err) {
      flash('err', `Load failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loading = false;
    }
  }

  async function saveProfile() {
    if (!uid) return;
    saving = true;
    try {
      const [{ firebaseApp }, { getDatabase, ref, set }] = await Promise.all([
        import('../lib/firebase'),
        import('firebase/database'),
      ]);
      const db = getDatabase(firebaseApp());
      // Write only non-empty fields; omit blanks to keep the node clean
      const payload: Partial<Profile> = {};
      for (const key of Object.keys(profile) as (keyof Profile)[]) {
        const v = profile[key].trim();
        if (v) payload[key] = v;
      }
      await set(ref(db, `organiserProfiles/${uid}`), payload);
      saved = { ...profile };
      flash('ok', 'Profile saved');
    } catch (err) {
      flash('err', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      saving = false;
    }
  }

  function handleLogoFile(file: File) {
    if (file.size > 2 * 1024 * 1024) { flash('err', 'Logo must be under 2 MB'); return; }
    if (!file.type.startsWith('image/')) { flash('err', 'Only image files are accepted'); return; }
    logoUploading = true;
    logoProgress = 0;
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) logoProgress = Math.round((e.loaded / e.total) * 100);
    };
    reader.onload = () => {
      profile.logoUrl = reader.result as string;
      logoUploading = false;
      logoProgress = 0;
    };
    reader.onerror = () => {
      flash('err', 'Could not read the image file');
      logoUploading = false;
      logoProgress = 0;
    };
    reader.readAsDataURL(file);
  }
</script>

<div class="profile-wrap admin-tab-scrollself">
  {#if flashMsg}
    <div class="flash flash-{flashMsg.kind}" role="status">{flashMsg.text}</div>
  {/if}

  {#if loading}
    <p class="profile-loading">Loading…</p>
  {:else}
    <div class="profile-form">

      <!-- Identity header: logo + name/org side by side -->
      <section class="prof-section prof-identity-header">
        <div class="prof-logo-slot">
          {#if profile.logoUrl}
            <img src={profile.logoUrl} alt="Organisation logo" class="logo-avatar" />
          {:else}
            <div class="logo-avatar logo-avatar-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28">
                <rect x="3" y="3" width="18" height="18" rx="3"/>
                <path d="M3 9h18M9 21V9"/>
              </svg>
            </div>
          {/if}
          <label class="logo-upload-btn" class:logo-uploading={logoUploading}>
            <input
              type="file"
              accept="image/*"
              class="logo-file-input"
              disabled={saving || logoUploading}
              onchange={(e) => {
                const f = (e.currentTarget as HTMLInputElement).files?.[0];
                if (f) handleLogoFile(f);
                (e.currentTarget as HTMLInputElement).value = '';
              }}
            />
            {#if logoUploading}
              <span>{logoProgress}%</span>
            {:else if profile.logoUrl}
              <span>Replace</span>
            {:else}
              <span>Upload logo</span>
            {/if}
          </label>
          {#if profile.logoUrl}
            <button type="button" class="logo-remove-btn" onclick={() => (profile.logoUrl = '')} disabled={saving || logoUploading}>Remove</button>
          {/if}
          {#if logoUploading}
            <div class="upload-progress-bar" role="progressbar" aria-valuenow={logoProgress} aria-valuemin={0} aria-valuemax={100}>
              <div class="upload-progress-fill" style="width: {logoProgress}%"></div>
            </div>
          {/if}
        </div>
        <div class="prof-identity-fields">
          <h2 class="prof-section-title">Identity</h2>
          <label class="prof-field">
            <span>Your name</span>
            <input type="text" bind:value={profile.displayName} maxlength="120" placeholder="e.g. Swapnil Deshpande" disabled={saving} />
          </label>
          <label class="prof-field">
            <span>Organisation / federation</span>
            <input type="text" bind:value={profile.orgName} maxlength="120" placeholder="e.g. Danish Carrom Federation" disabled={saving} />
          </label>
        </div>
      </section>

      <!-- Contact details -->
      <section class="prof-section">
        <h2 class="prof-section-title">Contact</h2>
        <div class="contact-row">
          <label class="prof-field">
            <span>Phone</span>
            <div class="input-icon-wrap">
              <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
              <input type="tel" bind:value={profile.phone} maxlength="40" placeholder="+45 …" disabled={saving} />
            </div>
          </label>
          <label class="prof-field">
            <span>Email</span>
            <div class="input-icon-wrap">
              <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884zM18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/></svg>
              <input type="email" bind:value={profile.email} maxlength="120" placeholder="organiser@example.com" disabled={saving} />
            </div>
          </label>
        </div>
        <label class="prof-field">
          <span>Website</span>
          <div class="input-icon-wrap">
            <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16A8 8 0 0010 2zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.559-.499-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.559.499.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.498-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clip-rule="evenodd"/></svg>
            <input type="url" bind:value={profile.website} maxlength="200" placeholder="https://…" disabled={saving} />
          </div>
        </label>
        <label class="prof-field">
          <span>Address</span>
          <textarea bind:value={profile.address} maxlength="300" rows="2" placeholder="Street, City, Country" disabled={saving}></textarea>
        </label>
      </section>

      <!-- Socials with platform icons -->
      <section class="prof-section">
        <h2 class="prof-section-title">Socials</h2>
        <div class="socials-grid">
          <label class="prof-field">
            <span class="social-label">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
              Instagram
            </span>
            <input type="text" bind:value={profile.instagram} maxlength="60" placeholder="handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span class="social-label">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
              Facebook
            </span>
            <input type="text" bind:value={profile.facebook} maxlength="60" placeholder="page or handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span class="social-label">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              YouTube
            </span>
            <input type="text" bind:value={profile.youtube} maxlength="60" placeholder="channel handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span class="social-label">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              X / Twitter
            </span>
            <input type="text" bind:value={profile.x} maxlength="60" placeholder="handle" disabled={saving} />
          </label>
        </div>
      </section>

      <!-- Sticky save bar -->
      <div class="prof-actions">
        <button
          type="button"
          class="btn btn-primary"
          onclick={saveProfile}
          disabled={saving || logoUploading || !dirty}
        >{saving ? 'Saving…' : 'Save profile'}</button>
        {#if !dirty && !saving}
          <span class="prof-saved-hint">✓ All changes saved</span>
        {:else if dirty}
          <span class="prof-unsaved-hint">Unsaved changes</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .profile-wrap {
    max-width: 100%;
    padding: 1rem 1rem 2rem;
    box-sizing: border-box;
    align-items: stretch;
  }
  .profile-form {
    max-width: 36rem;
    margin: 0 auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .flash {
    padding: 0.55rem 0.85rem;
    border-radius: 0.45rem;
    font-size: 0.88rem;
    margin-bottom: 0.5rem;
  }
  .flash-ok { background: rgba(0, 200, 83, 0.15); color: #00c853; border: 1px solid rgba(0,200,83,0.3); }
  .flash-err { background: rgba(239, 83, 80, 0.15); color: #ef5350; border: 1px solid rgba(239,83,80,0.3); }
  .profile-loading { color: var(--muted, #888); text-align: center; padding: 2rem 0; }

  /* Sections */
  .prof-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.1rem 1.1rem 1.1rem;
    background: #141414;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.75rem;
  }
  .prof-section-title {
    margin: 0 0 0.25rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }

  /* Identity header: logo left, fields right */
  .prof-identity-header {
    flex-direction: row;
    align-items: flex-start;
    gap: 1.25rem;
  }
  .prof-logo-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.45rem;
    flex-shrink: 0;
    width: 5.5rem;
  }
  .logo-avatar {
    width: 5rem;
    height: 5rem;
    object-fit: contain;
    border-radius: 0.6rem;
    background: #1e1e1e;
    border: 1px solid rgba(255,255,255,0.1);
    padding: 0.3rem;
    box-sizing: border-box;
  }
  .logo-avatar-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.2);
  }
  .logo-upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 0.3rem 0;
    border: 1.5px dashed rgba(255,255,255,0.2);
    border-radius: 0.4rem;
    font-size: 0.72rem;
    font: inherit;
    font-size: 0.72rem;
    color: var(--muted, #888);
    cursor: pointer;
    position: relative;
    user-select: none;
    text-align: center;
  }
  .logo-upload-btn:hover { border-color: var(--accent, #ffd54a); color: var(--accent, #ffd54a); }
  .logo-upload-btn.logo-uploading { opacity: 0.6; cursor: wait; }
  .logo-file-input {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0; overflow: hidden;
    pointer-events: none;
  }
  .logo-remove-btn {
    background: none;
    border: none;
    font: inherit;
    font-size: 0.72rem;
    color: #ef5350;
    cursor: pointer;
    padding: 0;
    opacity: 0.8;
  }
  .logo-remove-btn:hover { opacity: 1; }
  .logo-remove-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .upload-progress-bar {
    width: 100%;
    height: 3px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  .upload-progress-fill {
    height: 100%;
    background: var(--accent, #ffd54a);
    border-radius: 2px;
    transition: width 0.15s ease;
  }

  .prof-identity-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  /* Fields */
  .prof-field {
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    font-size: 0.88rem;
    color: var(--fg, #f5f5f5);
  }
  .prof-field > span,
  .social-label {
    font-size: 0.75rem;
    color: var(--muted, #888);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .prof-field input,
  .prof-field textarea {
    background: #0d0d0d;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.88rem;
    padding: 0.48rem 0.65rem;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    transition: border-color 0.15s;
  }
  .prof-field input:focus,
  .prof-field textarea:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
    background: #111;
  }

  /* Input with icon prefix */
  .input-icon-wrap {
    position: relative;
  }
  .input-icon-wrap .input-icon {
    position: absolute;
    left: 0.55rem;
    top: 50%;
    transform: translateY(-50%);
    color: rgba(255,255,255,0.3);
    pointer-events: none;
  }
  .input-icon-wrap input {
    padding-left: 2rem !important;
  }

  .contact-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 28rem) {
    .contact-row { grid-template-columns: 1fr; }
    .prof-identity-header { flex-direction: column; align-items: center; }
    .prof-logo-slot { width: 100%; flex-direction: row; flex-wrap: wrap; justify-content: center; }
    .logo-avatar { width: 4rem; height: 4rem; }
    .prof-identity-fields { width: 100%; }
  }

  .socials-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 28rem) { .socials-grid { grid-template-columns: 1fr; } }

  /* Save bar */
  .prof-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0 0.5rem;
  }
  .prof-saved-hint {
    font-size: 0.82rem;
    color: #00c853;
    opacity: 0.85;
  }
  .prof-unsaved-hint {
    font-size: 0.82rem;
    color: var(--muted, #888);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 1.2rem;
    border: 1px solid transparent;
    border-radius: 0.45rem;
    font: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    background: rgba(255,255,255,0.08);
    color: var(--fg, #f5f5f5);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent, #ffd54a);
    color: #000;
    border-color: transparent;
  }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
</style>
