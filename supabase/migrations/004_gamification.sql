-- Rapid Coach: Home tab gamification (XP, daily goal, streaks, badges, records).
-- Run after 001-003: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- What is stored, one row per chess account:
-- * days:     training counts per local date, e.g. {"2026-11-16": {"pz": 4, "op": 6, "rv": 1, "g": 1}}
--             (puzzles solved, opening positions right, games reviewed, daily goal met, ...).
--             XP, streak, streak freezes, level and weekly challenges are worked out from this.
-- * badges:   badge id -> when it was earned (ms)
-- * records:  personal records (best week XP, longest streak, best blunder rate)
-- * settings: daily goal intensity and whether streaks/XP are hidden
-- * reviewed: ids of games already counted as reviewed (so a game earns XP once)
-- Leaderboard (only if you share stats, see 002_friends.sql): XP this week and current streak.

create table if not exists public.gamification (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account    text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  days       jsonb not null default '{}' check (jsonb_typeof(days) = 'object'),
  badges     jsonb not null default '{}' check (jsonb_typeof(badges) = 'object'),
  records    jsonb not null default '{}' check (jsonb_typeof(records) = 'object'),
  settings   jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  reviewed   jsonb not null default '{}' check (jsonb_typeof(reviewed) = 'object'),
  changed_at bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, account),
  check (pg_column_size(days) + pg_column_size(badges) + pg_column_size(records)
       + pg_column_size(settings) + pg_column_size(reviewed) <= 500000)
);

drop trigger if exists rc_touch on public.gamification;
create trigger rc_touch before insert or update on public.gamification for each row execute function public.rc_touch();
alter table public.gamification enable row level security;
drop policy if exists own_rows on public.gamification;
create policy own_rows on public.gamification for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.gamification from anon;
grant select, insert, update, delete on public.gamification to authenticated;

-- Leaderboard: XP this week (xp_week = the Monday it counts for) and current streak.
alter table public.leaderboard_stats add column if not exists weekly_xp integer not null default 0 check (weekly_xp between 0 and 1000000);
alter table public.leaderboard_stats add column if not exists xp_week date;
alter table public.leaderboard_stats add column if not exists streak integer not null default 0 check (streak between 0 and 100000);

drop function if exists public.friends_leaderboard(text);
create function public.friends_leaderboard(p_tc text)
returns table (is_me boolean, display_name text, source text, games_analysed integer,
  blunders_per_game real, mistakes_per_game real, median_time_used integer, puzzles_solved integer,
  rating_now integer, rating_base integer, base_date date, openings_learned integer,
  weekly_xp integer, xp_week date, streak integer, updated_at timestamptz)
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
    s.weekly_xp, s.xp_week, s.streak, s.updated_at
  from public.leaderboard_stats s
  join people on people.id = s.user_id
  join public.profiles p on p.user_id = s.user_id and p.share
  where s.tc = p_tc
  order by s.user_id, s.updated_at desc
$$;
revoke all on function public.friends_leaderboard(text) from public, anon;
grant execute on function public.friends_leaderboard(text) to authenticated;
