create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role text not null default 'learner' check (role in ('learner', 'instructor', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_default_learner_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120),
    'learner'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists create_profile_after_auth_user_insert on auth.users;
create trigger create_profile_after_auth_user_insert
after insert on auth.users
for each row execute function public.create_default_learner_profile();
revoke all on function public.create_default_learner_profile() from public, anon, authenticated;

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  title text not null,
  description text not null default '',
  category text not null default '',
  level text not null default 'beginner',
  duration_minutes integer not null default 0 check (duration_minutes >= 0),
  lesson_count integer not null default 0 check (lesson_count >= 0),
  accent text not null default '#4f46e5',
  icon text not null default 'book-open',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.course_instructors (
  course_id uuid not null references public.courses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (course_id, user_id)
);

create table if not exists public.course_enrollments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  enrolled_at timestamptz not null default now(),
  unique (user_id, course_id)
);

create table if not exists public.course_progress (
  user_id uuid not null,
  course_id uuid not null,
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  minutes_spent integer not null default 0 check (minutes_spent >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id),
  foreign key (user_id, course_id)
    references public.course_enrollments (user_id, course_id) on delete cascade
);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  course_id uuid not null,
  issued_at timestamptz not null default now(),
  unique (user_id, course_id),
  foreign key (user_id, course_id)
    references public.course_enrollments (user_id, course_id) on delete cascade
);

create table if not exists public.classroom_messages (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete restrict,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists classroom_messages_course_created_idx
  on public.classroom_messages (course_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

create table if not exists public.app_sessions (
  session_hash char(64) primary key check (session_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  refresh_lock_id uuid,
  refresh_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.api_schema_metadata (
  schema_version integer primary key,
  applied_at timestamptz not null default now()
);
insert into public.api_schema_metadata (schema_version) values (1) on conflict do nothing;

create index if not exists course_enrollments_user_status_idx
  on public.course_enrollments (user_id, status);
create index if not exists course_progress_user_idx
  on public.course_progress (user_id);
create index if not exists app_sessions_user_idx
  on public.app_sessions (user_id);
create index if not exists app_sessions_expiry_idx
  on public.app_sessions (expires_at);

alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.course_instructors enable row level security;
alter table public.course_enrollments enable row level security;
alter table public.course_progress enable row level security;
alter table public.certificates enable row level security;
alter table public.classroom_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.app_sessions enable row level security;
alter table public.api_schema_metadata enable row level security;

-- There are intentionally no anon/authenticated policies. The API's service role is server-only.
revoke all on table
  public.profiles,
  public.courses,
  public.course_instructors,
  public.course_enrollments,
  public.course_progress,
  public.certificates,
  public.classroom_messages,
  public.notifications,
  public.app_sessions,
  public.api_schema_metadata
from public, anon, authenticated;
grant usage on schema public to service_role;
grant all on table
  public.profiles,
  public.courses,
  public.course_instructors,
  public.course_enrollments,
  public.course_progress,
  public.certificates,
  public.classroom_messages,
  public.notifications,
  public.app_sessions,
  public.api_schema_metadata
to service_role;

create or replace function public.claim_app_session_refresh(
  p_session_hash text,
  p_lock_id uuid,
  p_lease_seconds integer default 15
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.app_sessions
  set refresh_lock_id = p_lock_id,
      refresh_lock_until = clock_timestamp() + make_interval(secs => greatest(5, least(p_lease_seconds, 60)))
  where session_hash = p_session_hash
    and revoked_at is null
    and expires_at > clock_timestamp()
    and (refresh_lock_until is null or refresh_lock_until <= clock_timestamp());

  return found;
end;
$$;

create or replace function public.release_app_session_refresh(
  p_session_hash text,
  p_lock_id uuid
) returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.app_sessions
  set refresh_lock_id = null,
      refresh_lock_until = null
  where session_hash = p_session_hash
    and refresh_lock_id = p_lock_id;
$$;

create or replace function public.can_user_join_course(
  p_user_id uuid,
  p_course_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.courses course
    where course.id = p_course_id
      and (
        (
          course.owner_id = p_user_id
          and exists (
            select 1 from public.profiles owner_profile
            where owner_profile.id = p_user_id
              and owner_profile.role in ('instructor', 'admin')
          )
        )
        or exists (
          select 1
          from public.course_instructors instructor
          join public.profiles instructor_profile on instructor_profile.id = instructor.user_id
          where instructor.course_id = course.id
            and instructor.user_id = p_user_id
            and instructor_profile.role in ('instructor', 'admin')
        )
        or exists (
          select 1 from public.course_enrollments enrollment
          where enrollment.course_id = course.id
            and enrollment.user_id = p_user_id
            and enrollment.status in ('active', 'completed')
        )
      )
  );
$$;

create or replace function public.create_classroom_message_if_member(
  p_user_id uuid,
  p_course_id uuid,
  p_body text
) returns public.classroom_messages
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  created_message public.classroom_messages;
begin
  if char_length(trim(p_body)) < 1 or char_length(trim(p_body)) > 4000 then
    raise exception 'invalid classroom message body' using errcode = '22023';
  end if;

  if not public.can_user_join_course(p_user_id, p_course_id) then
    return null;
  end if;

  insert into public.classroom_messages (course_id, sender_id, body)
  values (p_course_id, p_user_id, trim(p_body))
  returning * into created_message;

  return created_message;
end;
$$;

revoke all on function public.claim_app_session_refresh(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_app_session_refresh(text, uuid) from public, anon, authenticated;
revoke all on function public.can_user_join_course(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_classroom_message_if_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_app_session_refresh(text, uuid, integer) to service_role;
grant execute on function public.release_app_session_refresh(text, uuid) to service_role;
grant execute on function public.can_user_join_course(uuid, uuid) to service_role;
grant execute on function public.create_classroom_message_if_member(uuid, uuid, text) to service_role;
