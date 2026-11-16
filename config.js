/* Optional accounts (Supabase). Leave supabaseKey empty to switch accounts off: the app then works exactly as without them.
   The key here is the project's *publishable* (anon) key, which is meant to be public: Row Level Security in
   supabase/migrations/001_sync.sql is what protects the data. Never put the service_role / secret key here. */
window.RC_CONFIG={
  supabaseUrl:"https://ednyucirnrdcsveqlokb.supabase.co",
  supabaseKey:"sb_publishable_hDcv8-hOi6TvLhFUZ5afTw_lKHswbkk"
};
