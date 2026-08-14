-- Hoist the Tiranga — complete, rerunnable Supabase setup / upgrade script.
-- Run this entire file in Supabase SQL Editor. It preserves existing flags.

begin;

create table if not exists public.flags (
  id             bigint generated always as identity primary key,
  first_name     text not null,
  gender         text not null default 'unspecified'
                 check (gender in ('male', 'female', 'unspecified')),
  x_position     numeric(7,2) not null check (x_position between 0 and 612),
  y_position     numeric(7,2) not null check (y_position between 0 and 696),
  browser_hash   text not null,
  submission_id  uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  is_removed     boolean not null default false,
  removed_at     timestamptz,
  constraint first_name_len check (char_length(first_name) between 1 and 40)
);

-- Upgrade an installation made from an earlier project ZIP without data loss.
alter table public.flags add column if not exists submission_id uuid;
alter table public.flags add column if not exists updated_at timestamptz not null default now();

create index if not exists flags_browser_hash_idx on public.flags (browser_hash);
create index if not exists flags_created_idx on public.flags (created_at desc);
create index if not exists flags_updated_idx on public.flags (updated_at desc);
create index if not exists flags_active_idx on public.flags (id) where is_removed = false;
create unique index if not exists flags_submission_once_idx
  on public.flags (browser_hash, submission_id)
  where submission_id is not null;

create or replace function public.set_flag_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists flags_set_updated_at on public.flags;
create trigger flags_set_updated_at
before update on public.flags
for each row execute function public.set_flag_updated_at();

-- The base table is private. Anonymous users cannot read hashes, moderation
-- fields, removed rows, or write directly.
alter table public.flags enable row level security;
revoke all on table public.flags from public, anon, authenticated;
revoke all on sequence public.flags_id_seq from public, anon, authenticated;

do $$
declare policy_record record;
begin
  for policy_record in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'flags'
  loop
    execute format('drop policy if exists %I on public.flags', policy_record.policyname);
  end loop;
end;
$$;

-- Safe public projection. This intentionally exposes only active flags and the
-- six fields the map needs. It is a fixed security-definer view over a fully
-- locked base table; callers cannot alter its filter or selected columns.
drop view if exists public.public_flags;
create view public.public_flags
with (security_barrier = true, security_invoker = false)
as
select id, first_name, gender, x_position, y_position, created_at
from public.flags
where is_removed = false;

revoke all on public.public_flags from public;
grant select on public.public_flags to anon, authenticated;

-- Admin login rate-limit audit table. It is service-role only.
create table if not exists public.admin_login_attempts (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  ok         boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists admin_attempts_idx
  on public.admin_login_attempts (ip_hash, created_at desc);

alter table public.admin_login_attempts enable row level security;
revoke all on table public.admin_login_attempts from public, anon, authenticated;
revoke all on sequence public.admin_login_attempts_id_seq from public, anon, authenticated;

do $$
declare policy_record record;
begin
  for policy_record in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'admin_login_attempts'
  loop
    execute format('drop policy if exists %I on public.admin_login_attempts', policy_record.policyname);
  end loop;
end;
$$;

-- One atomic server-side transaction for quota enforcement + insertion.
-- Advisory locking serializes simultaneous requests from the same browser, so
-- concurrent taps cannot exceed five. Removed flags deliberately still count.
create or replace function public.hoist_flag(
  p_first_name text,
  p_gender text,
  p_x numeric,
  p_y numeric,
  p_browser_hash text,
  p_submission_id uuid
)
returns table (
  flag_id bigint,
  first_name text,
  gender text,
  x_position numeric,
  y_position numeric,
  created_at timestamptz,
  active_count bigint,
  was_existing boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_count integer;
  latest_created_at timestamptz;
  active_total bigint;
  flag_row public.flags%rowtype;
begin
  if p_first_name is null or char_length(p_first_name) not between 2 and 20 then
    raise exception using errcode = 'P0001', message = 'BAD_NAME';
  end if;
  if p_gender not in ('male', 'female', 'unspecified') then
    raise exception using errcode = 'P0001', message = 'BAD_GENDER';
  end if;
  if p_x is null or p_y is null or p_x not between 0 and 612 or p_y not between 0 and 696 then
    raise exception using errcode = 'P0001', message = 'BAD_PLACE';
  end if;
  if p_browser_hash is null or p_browser_hash !~ '^[a-f0-9]{64}$' or p_submission_id is null then
    raise exception using errcode = 'P0001', message = 'BAD_REQUEST';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_browser_hash, 0));

  -- Idempotent retry: a timed-out HTTP response can be retried without making
  -- a duplicate Tiranga or consuming another quota slot.
  select f.* into flag_row
  from public.flags f
  where f.browser_hash = p_browser_hash and f.submission_id = p_submission_id
  limit 1;

  if found then
    select count(*) into active_total from public.flags where is_removed = false;
    return query select flag_row.id, flag_row.first_name, flag_row.gender,
      flag_row.x_position, flag_row.y_position, flag_row.created_at,
      active_total, true;
    return;
  end if;

  select count(*), max(f.created_at)
  into existing_count, latest_created_at
  from public.flags f
  where f.browser_hash = p_browser_hash;

  if existing_count >= 5 then
    raise exception using errcode = 'P0001', message = 'FLAG_LIMIT';
  end if;
  if latest_created_at is not null and latest_created_at > now() - interval '4 seconds' then
    raise exception using errcode = 'P0001', message = 'FLAG_COOLDOWN';
  end if;

  insert into public.flags (
    first_name, gender, x_position, y_position, browser_hash, submission_id
  ) values (
    p_first_name, p_gender, round(p_x, 2), round(p_y, 2), p_browser_hash, p_submission_id
  ) returning * into flag_row;

  select count(*) into active_total from public.flags where is_removed = false;
  return query select flag_row.id, flag_row.first_name, flag_row.gender,
    flag_row.x_position, flag_row.y_position, flag_row.created_at,
    active_total, false;
end;
$$;

revoke all on function public.set_flag_updated_at() from public, anon, authenticated;
revoke all on function public.hoist_flag(text, text, numeric, numeric, text, uuid)
  from public, anon, authenticated;
grant execute on function public.hoist_flag(text, text, numeric, numeric, text, uuid)
  to service_role;

comment on table public.flags is 'Shared Tirangas; browser_hash and moderation fields are never exposed publicly.';
comment on view public.public_flags is 'Read-only active Tirangas with safe public fields only.';

commit;
