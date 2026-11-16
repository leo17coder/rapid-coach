-- Rapid Coach V2, part 1: optional accounts that sync across devices.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement checks whether its object already exists.
--
-- What is stored (and nothing else): which chess accounts a person reviews,
-- engine analyses of their games, puzzle progress and baselines.
-- Games themselves are NOT stored: they can be fetched again from chess.com or
-- Lichess, and they contain opponents' usernames.
--
-- "account" is "<source>:<username>", e.g. "cc:magnuscarlsen" or "li:thibault",
-- the same prefix the app uses for its localStorage keys.

-- updated_at is always set by the database, so devices with wrong clocks can't break sync.
create or replace function public.rc_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- Chess accounts this person reviews, so a new device can open the right one.
create table if not exists public.linked_accounts (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  tc         text not null check (tc in ('600','rapid','blitz','bullet')),
  updated_at timestamptz not null default now(),
  primary key (user_id, account, tc)
);

-- Stockfish analysis of one game: eval per position (centipawns, white's view,
-- mate = +-10000) and the best move per ply in UCI notation.
create table if not exists public.analyses (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_id    text not null check (game_id ~ '^(cc|li)-' and length(game_id) <= 200),
  depth      smallint not null check (depth between 1 and 40),
  ev         smallint[] not null check (cardinality(ev) <= 1200),
  best       text[] not null check (cardinality(best) <= 1200),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

-- One row per puzzle tried. puzzle_id is "<game_id>:<ply>".
create table if not exists public.puzzle_progress (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  puzzle_id  text not null check (length(puzzle_id) <= 220),
  seen       boolean not null default false,
  ok         boolean not null default false,
  fail       smallint not null default 0 check (fail between 0 and 10000),
  updated_at timestamptz not null default now(),
  primary key (user_id, account, puzzle_id)
);

-- The starting point progress is measured against, per account and time control.
create table if not exists public.baselines (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  tc         text not null check (tc in ('600','rapid','blitz','bullet')),
  stats      jsonb not null check (pg_column_size(stats) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (user_id, account, tc)
);

-- Pulls ask for "rows changed since X", so index updated_at.
create index if not exists analyses_pull        on public.analyses        (user_id, updated_at);
create index if not exists puzzle_progress_pull on public.puzzle_progress (user_id, updated_at);

do $$
declare t text;
begin
  foreach t in array array['linked_accounts','analyses','puzzle_progress','baselines'] loop
    execute format('drop trigger if exists rc_touch on public.%I', t);
    execute format('create trigger rc_touch before insert or update on public.%I for each row execute function public.rc_touch()', t);

    -- Row Level Security: each person can only see and change their own rows.
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);

    -- Signed-out visitors (the anon role) get no access at all.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- "Delete my account": removes the auth user; on delete cascade removes every row above.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
