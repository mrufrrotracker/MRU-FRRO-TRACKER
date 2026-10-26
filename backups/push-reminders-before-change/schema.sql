-- MRU FRRO Tracker schema. Apply this only in a NEW/dedicated Supabase project.
-- If using an existing project, inspect existing tables and triggers first.

create type public.account_role as enum ('student', 'admin');
create type public.verification_status as enum ('pending', 'verified');

create table public.student_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'Student',
  email text not null,
  role public.account_role not null default 'student',
  verification_status public.verification_status not null default 'verified',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.frro_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  previous_renewal_date date not null,
  next_expiry_date date not null,
  updated_at timestamptz not null default now(),
  constraint frro_dates_order check (previous_renewal_date <= next_expiry_date)
);

create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expiry_date date not null,
  days_before integer not null check (days_before in (60,45,30,21,14,10,7,3,2,1)),
  channel text not null default 'email',
  status text not null default 'sent',
  provider_message_id text,
  error_message text,
  sent_at timestamptz not null default now(),
  unique (user_id, expiry_date, days_before, channel)
);

create index frro_records_expiry_idx on public.frro_records(next_expiry_date);
create index notifications_user_created_idx on public.in_app_notifications(user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger student_profiles_updated_at
before update on public.student_profiles
for each row execute function public.set_updated_at();

create trigger frro_records_updated_at
before update on public.frro_records
for each row execute function public.set_updated_at();

-- SECURITY DEFINER helper avoids recursive RLS queries against student_profiles.
create or replace function public.is_verified_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.student_profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'::public.account_role
      and p.verification_status = 'verified'::public.verification_status
  );
$$;

revoke all on function public.is_verified_admin() from public;
grant execute on function public.is_verified_admin() to authenticated;

-- Automatically create a student profile for each newly created auth account.
-- Registration cannot choose a role; it is always student.
create or replace function public.handle_new_student_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.student_profiles (user_id, full_name, email, role, verification_status)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Student'),
    coalesce(new.email, ''),
    'student'::public.account_role,
    'verified'::public.verification_status
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_student_profile
after insert on auth.users
for each row execute function public.handle_new_student_signup();

alter table public.student_profiles enable row level security;
alter table public.frro_records enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.reminder_log enable row level security;

create policy "profiles read self or admin"
on public.student_profiles for select to authenticated
using (user_id = auth.uid() or public.is_verified_admin());

-- Students cannot insert arbitrary profile rows or change role/status.
-- Profile creation is performed by the SECURITY DEFINER auth trigger.
create policy "profiles update own basic info"
on public.student_profiles for update to authenticated
using (user_id = auth.uid() and role = 'student'::public.account_role)
with check (
  user_id = auth.uid()
  and role = 'student'::public.account_role
  and verification_status = 'verified'::public.verification_status
);

create policy "FRRO records read own or admin"
on public.frro_records for select to authenticated
using (user_id = auth.uid() or public.is_verified_admin());

create policy "students insert own FRRO dates"
on public.frro_records for insert to authenticated
with check (user_id = auth.uid());

create policy "students update own FRRO dates"
on public.frro_records for update to authenticated
using (user_id = auth.uid() or public.is_verified_admin())
with check (user_id = auth.uid() or public.is_verified_admin());

create policy "students delete own FRRO dates"
on public.frro_records for delete to authenticated
using (user_id = auth.uid() or public.is_verified_admin());

create policy "notifications read own or admin"
on public.in_app_notifications for select to authenticated
using (user_id = auth.uid() or public.is_verified_admin());

create policy "users mark own notifications read"
on public.in_app_notifications for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "admins send notifications"
on public.in_app_notifications for insert to authenticated
with check (public.is_verified_admin());

create policy "admins read reminder log"
on public.reminder_log for select to authenticated
using (public.is_verified_admin());

grant select, update on public.student_profiles to authenticated;
grant select, insert, update, delete on public.frro_records to authenticated;
grant select, insert, update on public.in_app_notifications to authenticated;
grant select on public.reminder_log to authenticated;

-- After registering your own account, promote it once using the SQL in README.md.
-- Never put the Supabase service-role key in frontend code.
