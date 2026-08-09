/// <reference types="astro/client" />

interface ImportMetaEnv {
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
