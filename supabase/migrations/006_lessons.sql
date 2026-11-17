-- Rapid Coach: tailored lessons. Run after 001-005: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- What is stored, per chess account:
-- * lesson_progress: one row per lesson ("l:<lesson id>": steps done, when it was completed), per chapter
--   ("c:<chapter id>": when its placement check was passed, when it was completed) and your chosen level
--   ("lvl", in val). No games, no positions you played.
-- * leaderboard_stats.lessons_completed: how many lessons you have completed, shown to friends only if
--   you share stats (see 002_friends.sql).

create table if not exists public.lesson_progress (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  item       text not null check (item ~ '^((l|c):[a-z0-9-]{1,60}|lvl)$'),
  steps      smallint not null default 0 check (steps between 0 and 200),
  done_at    timestamptz,
  passed_at  timestamptz,
  val        text check (val is null or length(val) <= 20),
  changed_at bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, account, item)
);
create index if not exists lesson_progress_pull on public.lesson_progress (user_id, updated_at);

drop trigger if exists rc_touch on public.lesson_progress;
create trigger rc_touch before insert or update on public.lesson_progress for each row execute function public.rc_touch();
alter table public.lesson_progress enable row level security;
drop policy if exists own_rows on public.lesson_progress;
create policy own_rows on public.lesson_progress for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.lesson_progress from anon;
grant select, insert, update, delete on public.lesson_progress to authenticated;

-- Friends leaderboard: add "lessons completed".
alter table public.leaderboard_stats add column if not exists lessons_completed integer not null default 0
  check (lessons_completed between 0 and 100000);

drop function if exists public.friends_leaderboard(text);
create function public.friends_leaderboard(p_tc text)
returns table (is_me boolean, display_name text, source text, games_analysed integer,
  blunders_per_game real, mistakes_per_game real, median_time_used integer, puzzles_solved integer,
  rating_now integer, rating_base integer, base_date date, openings_learned integer,
  weekly_xp integer, xp_week date, streak integer, lessons_completed integer, updated_at timestamptz)
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
    s.rating_now, s.rating_base, s.base_date, s.openings_learned,
    s.weekly_xp, s.xp_week, s.streak, s.lessons_completed, s.updated_at
  from public.leaderboard_stats s
  join people on people.id = s.user_id
  join public.profiles p on p.user_id = s.user_id and p.share
  where s.tc = p_tc
  order by s.user_id, s.updated_at desc
$$;
revoke all on function public.friends_leaderboard(text) from public, anon;
grant execute on function public.friends_leaderboard(text) to authenticated;
