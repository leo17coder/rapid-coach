-- Rapid Coach V2, part 2: friends leaderboard.
-- Run once after 001_sync.sql: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- How it works:
-- * Everyone signed in gets a profile with a display name and a private invite code.
-- * Opening a friend's invite link makes the two of you friends (the owner shared the link;
--   the other person chose to open it). Either friend can remove the friendship, and a new
--   invite code makes the old link stop working.
-- * Sharing is opt-in ("share" on the profile, off by default). Only people who share can
--   upload leaderboard stats, and switching sharing off deletes them. That switch is the
--   GDPR consent; share_changed_at records when it was last changed.
-- * Friends see your display name, which site you play on (not your username) and the numbers
--   below. Never your email or your games.

create table if not exists public.profiles (
  user_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name     text check (display_name is null or char_length(btrim(display_name)) between 1 and 30),
  share            boolean not null default false,
  share_changed_at timestamptz,
  invite_code      text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  updated_at       timestamptz not null default now()
);

-- One row per pair of friends, stored with the smaller id first so a pair can't appear twice.
create table if not exists public.friendships (
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists friendships_b on public.friendships (user_b);

-- Numbers worked out in the browser from the person's own games, per account and time control.
create table if not exists public.leaderboard_stats (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account           text not null check (account ~ '^(cc|li):[a-z0-9_-]{1,40}$'),
  tc                text not null check (tc in ('600','rapid','blitz','bullet')),
  games_analysed    integer not null check (games_analysed between 0 and 1000000),
  blunders_per_game real check (blunders_per_game between 0 and 100),
  mistakes_per_game real check (mistakes_per_game between 0 and 100),
  median_time_used  integer check (median_time_used between 0 and 100000),  -- seconds per game
  puzzles_solved    integer not null default 0 check (puzzles_solved between 0 and 1000000),
  rating_now        integer check (rating_now between 0 and 5000),
  rating_base       integer check (rating_base between 0 and 5000),
  base_date         date,
  updated_at        timestamptz not null default now(),
  primary key (user_id, account, tc)
);

-- Profile bookkeeping: updated_at, when sharing changed, and deleting stats when sharing stops.
create or replace function public.rc_profile_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.share then new.share_changed_at := now(); end if;
  elsif new.share is distinct from old.share then
    new.share_changed_at := now();
  end if;
  return new;
end $$;

create or replace function public.rc_profile_unshare() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.share then delete from public.leaderboard_stats where user_id = new.user_id; end if;
  return null;
end $$;

drop trigger if exists rc_touch on public.profiles;
create trigger rc_touch before insert or update on public.profiles for each row execute function public.rc_profile_touch();
drop trigger if exists rc_unshare on public.profiles;
create trigger rc_unshare after update of share on public.profiles for each row execute function public.rc_profile_unshare();
drop trigger if exists rc_touch on public.leaderboard_stats;
create trigger rc_touch before insert or update on public.leaderboard_stats for each row execute function public.rc_touch();

alter table public.profiles          enable row level security;
alter table public.friendships       enable row level security;
alter table public.leaderboard_stats enable row level security;

-- Profiles: your own row only. You may set your name and sharing, not your invite code.
drop policy if exists own_rows on public.profiles;
create policy own_rows on public.profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.profiles from anon, authenticated;
grant select, delete on public.profiles to authenticated;
grant insert (display_name, share), update (display_name, share) on public.profiles to authenticated;

-- Friendships: both people can see and delete their row. Rows are only created by add_friend().
drop policy if exists own_rows on public.friendships;
create policy own_rows on public.friendships for all to authenticated
  using ((select auth.uid()) in (user_a, user_b));
revoke all on public.friendships from anon, authenticated;
grant select, delete on public.friendships to authenticated;

-- Stats: your own rows, and only while you share. Friends read them through friends_leaderboard().
drop policy if exists own_rows on public.leaderboard_stats;
create policy own_rows on public.leaderboard_stats for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.share));
revoke all on public.leaderboard_stats from anon, authenticated;
grant select, insert, update, delete on public.leaderboard_stats to authenticated;

-- Open a friend's invite link. Returns the friend's display name ('' if they haven't set one).
create or replace function public.add_friend(code text) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); other uuid; nm text;
begin
  if me is null then raise exception 'not signed in'; end if;
  select p.user_id, p.display_name into other, nm from public.profiles p where p.invite_code = lower(btrim(code));
  if other is null then raise exception 'invite not found' using errcode = 'P0002'; end if;
  if other = me then raise exception 'own invite' using errcode = 'P0001'; end if;
  insert into public.friendships (user_a, user_b) values (least(me, other), greatest(me, other)) on conflict do nothing;
  return coalesce(nm, '');
end $$;

-- Make a new invite code; the old link stops working. Existing friends stay friends.
create or replace function public.new_invite_code() returns text
language plpgsql security definer set search_path = '' as $$
declare c text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.profiles set invite_code = c where user_id = auth.uid();
  if not found then raise exception 'no profile'; end if;
  return c;
end $$;

-- Your friends: their id (to remove them), display name and whether they share.
create or replace function public.my_friends()
returns table (friend_id uuid, display_name text, sharing boolean, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, p.display_name, coalesce(p.share, false), f.created_at
  from public.friendships f
  cross join lateral (select case when f.user_a = auth.uid() then f.user_b else f.user_a end as id) o
  left join public.profiles p on p.user_id = o.id
  where auth.uid() in (f.user_a, f.user_b)
  order by f.created_at
$$;

-- Leaderboard for one time control: you and your friends who share, one row each
-- (their most recently updated account for that time control).
create or replace function public.friends_leaderboard(p_tc text)
returns table (is_me boolean, display_name text, source text, games_analysed integer,
  blunders_per_game real, mistakes_per_game real, median_time_used integer, puzzles_solved integer,
  rating_now integer, rating_base integer, base_date date, updated_at timestamptz)
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
    s.rating_now, s.rating_base, s.base_date, s.updated_at
  from public.leaderboard_stats s
  join people on people.id = s.user_id
  join public.profiles p on p.user_id = s.user_id and p.share
  where s.tc = p_tc
  order by s.user_id, s.updated_at desc
$$;

do $$
declare f text;
begin
  foreach f in array array['add_friend(text)','new_invite_code()','my_friends()','friends_leaderboard(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.rc_profile_unshare() from public, anon, authenticated;
