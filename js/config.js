// ==========================================================================
// Finora — js/config.js
// Public deployment settings. Safe to commit: the Supabase URL and the PUBLISHABLE (or legacy "anon")
// key are meant to be in browser code — your data is protected by Row Level Security + end-to-end
// encryption, not by hiding these.
//
// !!! NEVER put the `secret` / `service_role` key here. It bypasses all security. The app refuses to
//     start sync if it recognises one (see validateSupabaseConfig).
//
// Where to find them: Supabase dashboard -> Project Settings -> API.
// ==========================================================================
export const SUPABASE_CONFIG = {
  url: '',   // e.g. 'https://abcdefghijklmnopqrst.supabase.co'
  key: '',   // e.g. 'sb_publishable_...'  (or the legacy anon JWT 'eyJ...')
};
