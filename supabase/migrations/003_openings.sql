-- Rapid Coach: opening trainer. Run after 001_sync.sql and 002_friends.sql:
-- SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- What is stored:
-- * opening_progress: spaced-repetition progress per position you have drilled, and the move
--   you pinned as your repertoire move there. "pos" is the position (the first four fields of
--   its FEN: pieces, side to move, castling, en passant). No games, no opponents.
-- * opening_practice: when you first practised an opening, so the app can compare your score
--   before and after.
-- * leaderboard_stats.openings_learned: how many opening positions you have learned, shown to
--   friends only if you share stats (see 002_friends.sql).
-- "account" is "<source>:<username>" as in 001_sync.sql.

create table if not exists public.opening_progress (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  pos        text not null check (length(pos) <= 100 and pos ~ '^[1-8pnbrqkPNBRQK/]+ [wb] [KQkq-]+ [a-h1-8-]+$'),
  streak     smallint not null default 0 check (streak between 0 and 1000),
  due        timestamptz,                                   -- next review; null = not drilled yet
  correct    integer not null default 0 check (correct between 0 and 1000000),
  misses     integer not null default 0 check (misses between 0 and 1000000),
  pinned     text check (pinned ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),  -- your repertoire move (UCI)
  changed_at bigint not null default 0,                     -- device time of the last change (ms); newest wins
  updated_at timestamptz not null default now(),
  primary key (user_id, account, pos)
);

create table if not exists public.opening_practice (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  opening    text not null check (length(opening) <= 80 and opening ~ '^[wb]\|'),  -- "<colour>|<opening family>"
  started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, account, opening)
);

create index if not exists opening_progress_pull on public.opening_progress (user_id, updated_at);

do $$
declare t text;
begin
  foreach t in array array['opening_progress','opening_practice'] loop
    execute format('drop trigger if exists rc_touch on public.%I', t);
    execute format('create trigger rc_touch before insert or update on public.%I for each row execute function public.rc_touch()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Friends leaderboard: add "opening lines learned".
alter table public.leaderboard_stats add column if not exists openings_learned integer not null default 0
  check (openings_learned between 0 and 1000000);

-- The function's result columns change, so it has to be dropped and created again.
drop function if exists public.friends_leaderboard(text);
create function public.friends_leaderboard(p_tc text)
returns table (is_me boolean, display_name text, source text, games_analysed integer,
  blunders_per_game real, mistakes_per_game real, median_time_used integer, puzzles_solved integer,
  rating_now integer, rating_base integer, base_date date, openings_learned integer, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with people as (
    select auth.uid() as id where auth.uid() is not null
    union
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end
    from public.friendships f where auth.uid() in (f.user_a, f.user_b)
  )
  select distinct on (s.user_id)
    s.user_id = auth.uid(), p.display_name, split_part(s.account, ':', 1), s.games_analysed,
    s.blunders_per_game, s.mistakes_per_game, s.median_time_used, s.puzzles_solved,
    s.rating_now, s.rating_base, s.base_date, s.openings_learned, s.updated_at
  from public.leaderboard_stats s
  join people on people.id = s.user_id
  join public.profiles p on p.user_id = s.user_id and p.share
  where s.tc = p_tc
  order by s.user_id, s.updated_at desc
$$;
revoke all on function public.friends_leaderboard(text) from public, anon;
grant execute on function public.friends_leaderboard(text) to authenticated;
