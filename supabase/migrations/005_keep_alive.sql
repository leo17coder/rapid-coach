-- Rapid Coach: keep the free Supabase project awake.
-- Run after 001-004: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- Free Supabase projects pause after about a week without activity. The GitHub Actions workflow
-- .github/workflows/keep-supabase-awake.yml calls this function every few days with the public
-- (publishable) key, so the project always sees a real database query.
-- It reads no tables and returns only the database's current time.

create or replace function public.keep_alive() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;

revoke all on function public.keep_alive() from public;
grant execute on function public.keep_alive() to anon, authenticated;
