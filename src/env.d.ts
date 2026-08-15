/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Firebase Web API key. Public identifier per Firebase's own
   * security model — see the comment block in src/lib/firebase.ts.
   * Required at build time; firebase.ts throws if missing. Sourced
   * from `.env` locally and from the `PUBLIC_FIREBASE_API_KEY`
   * GitHub Actions repo secret in CI. See .env.example.
   */
  readonly PUBLIC_FIREBASE_API_KEY: string;

  /**
   * Firebase UID that's allowed to self-promote to super-admin the
   * first time /adminRoles is empty. Guards the client-side call to
   * bootstrapSuperIfNeeded(); the RTDB rule at /adminRoles/$uid still
   * requires the map to be empty for the write to succeed. Optional —
   * omitting it disables the self-promotion path (seed via Firebase
   * console instead). See .env.example.
   */
  readonly PUBLIC_BOOTSTRAP_SUPER_UID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
