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
      <section class="prof-section">
        <h2 class="prof-section-title">Identity</h2>
        <label class="prof-field">
          <span>Your name</span>
          <input type="text" bind:value={profile.displayName} maxlength="120" placeholder="e.g. Swapnil Deshpande" disabled={saving} />
        </label>
        <label class="prof-field">
          <span>Organisation / federation</span>
          <input type="text" bind:value={profile.orgName} maxlength="120" placeholder="e.g. Danish Carrom Federation" disabled={saving} />
        </label>
        <label class="prof-field">
          <span>Address</span>
          <textarea bind:value={profile.address} maxlength="300" rows="2" placeholder="Street, City, Country" disabled={saving}></textarea>
        </label>
        <div class="contact-row">
          <label class="prof-field">
            <span>Phone</span>
            <input type="tel" bind:value={profile.phone} maxlength="40" placeholder="+45 …" disabled={saving} />
          </label>
          <label class="prof-field">
            <span>Email</span>
            <input type="email" bind:value={profile.email} maxlength="120" placeholder="organiser@example.com" disabled={saving} />
          </label>
        </div>
        <label class="prof-field">
          <span>Website</span>
          <input type="url" bind:value={profile.website} maxlength="200" placeholder="https://…" disabled={saving} />
        </label>
      </section>

      <section class="prof-section">
        <h2 class="prof-section-title">Socials</h2>
        <div class="socials-grid">
          <label class="prof-field">
            <span>Instagram</span>
            <input type="text" bind:value={profile.instagram} maxlength="60" placeholder="handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span>Facebook</span>
            <input type="text" bind:value={profile.facebook} maxlength="60" placeholder="page or handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span>YouTube</span>
            <input type="text" bind:value={profile.youtube} maxlength="60" placeholder="channel handle" disabled={saving} />
          </label>
          <label class="prof-field">
            <span>X / Twitter</span>
            <input type="text" bind:value={profile.x} maxlength="60" placeholder="handle" disabled={saving} />
          </label>
        </div>
      </section>

      <section class="prof-section">
        <h2 class="prof-section-title">Logo</h2>
        {#if profile.logoUrl}
          <div class="logo-row">
            <img src={profile.logoUrl} alt="Your logo" class="logo-preview" />
            <button type="button" class="btn btn-sm btn-danger" onclick={() => (profile.logoUrl = '')} disabled={saving || logoUploading}>Remove</button>
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
          {logoUploading ? `Reading… ${logoProgress}%` : profile.logoUrl ? 'Replace logo' : 'Upload logo'}
        </label>
        {#if logoUploading}
          <div class="upload-progress-bar" role="progressbar" aria-valuenow={logoProgress} aria-valuemin={0} aria-valuemax={100}>
            <div class="upload-progress-fill" style="width: {logoProgress}%"></div>
          </div>
        {/if}
      </section>

      <div class="prof-actions">
        <button
          type="button"
          class="btn btn-primary"
          onclick={saveProfile}
          disabled={saving || logoUploading || !dirty}
        >{saving ? 'Saving…' : 'Save profile'}</button>
        {#if !dirty && !saving}
          <span class="prof-saved-hint">All changes saved</span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .profile-wrap {
    /* admin-tab-scrollself makes this div the scroll container in
       AdminHome's fixed-height flex column, so the footer stays visible.
       The AdminHome :global(> div) rule forces flex-direction: column on
       this element — use align-items to keep the centered max-width form. */
    max-width: 100%;
    padding: 1rem 1rem 2rem;
    box-sizing: border-box;
    align-items: stretch;
  }
  .profile-form {
    max-width: 36rem;
    margin: 0 auto;
    width: 100%;
  }
  .flash {
    padding: 0.55rem 0.85rem;
    border-radius: 0.45rem;
    font-size: 0.88rem;
    margin-bottom: 1rem;
  }
  .flash-ok { background: rgba(0, 200, 83, 0.15); color: #00c853; border: 1px solid rgba(0,200,83,0.3); }
  .flash-err { background: rgba(239, 83, 80, 0.15); color: #ef5350; border: 1px solid rgba(239,83,80,0.3); }
  .profile-loading { color: var(--muted, #888); text-align: center; padding: 2rem 0; }

  .profile-form { display: flex; flex-direction: column; gap: 1.5rem; }

  .prof-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: #141414;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.6rem;
  }
  .prof-section-title {
    margin: 0 0 0.1rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }
  .prof-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.88rem;
    color: var(--fg, #f5f5f5);
  }
  .prof-field > span { font-size: 0.78rem; color: var(--muted, #888); }
  .prof-hint { font-style: normal; font-size: 0.85em; opacity: 0.7; }
  .prof-field input,
  .prof-field textarea {
    background: #0d0d0d;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 0.4rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.9rem;
    padding: 0.45rem 0.6rem;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .prof-field input:focus,
  .prof-field textarea:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }

  .contact-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 28rem) { .contact-row { grid-template-columns: 1fr; } }

  .socials-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 28rem) { .socials-grid { grid-template-columns: 1fr; } }

  .logo-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .logo-preview {
    max-height: 3.5rem;
    max-width: 8rem;
    object-fit: contain;
    border-radius: 0.3rem;
    background: #222;
    padding: 0.2rem;
  }
  .logo-upload-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 0.85rem;
    border: 1.5px dashed rgba(255,255,255,0.25);
    border-radius: 0.4rem;
    font-size: 0.85rem;
    color: var(--fg, #f5f5f5);
    cursor: pointer;
    position: relative;
    user-select: none;
  }
  .logo-upload-btn:hover { border-color: var(--accent, #ffd54a); }
  .logo-upload-btn.logo-uploading { opacity: 0.6; cursor: wait; }
  .logo-file-input {
    position: absolute;
    width: 1px; height: 1px;
    opacity: 0; overflow: hidden;
    pointer-events: none;
  }
  .upload-progress-bar {
    width: 100%;
    height: 4px;
    background: rgba(255,255,255,0.12);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 0.4rem;
  }
  .upload-progress-fill {
    height: 100%;
    background: var(--accent, #ffd54a);
    border-radius: 2px;
    transition: width 0.15s ease;
  }

  .prof-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .prof-saved-hint {
    font-size: 0.82rem;
    color: var(--muted, #888);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    padding: 0.45rem 1rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
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
  .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  .btn-danger { color: #ef5350; border-color: rgba(239,83,80,0.3); }
  .btn-danger:hover:not(:disabled) { background: rgba(239,83,80,0.12); }
</style>
