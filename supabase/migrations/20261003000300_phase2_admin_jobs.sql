-- Phase 2: Richard's inbox. Admin login, jobs, line items, crews and trucks.
--
-- Access model: a signed-in user is an admin only if their auth user id is in
-- public.admins. Every table gets one policy: admins can do everything,
-- nobody else can see anything. The public site still only talks to the
-- edge functions.

-- ---------- admins ----------

create table public.admins (
  user_id    uuid primary key references auth.users on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

-- security definer so policies can call it without recursing into admins' own RLS.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- crews and trucks ----------

create table public.crews (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+1\d{10}$'),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.units (
  id              uuid primary key default gen_random_uuid(),
  unit_no         text not null unique,      -- what's painted on the truck
  description     text,                      -- e.g. "Blue Kohler truck-mount"
  last_service_on date,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ---------- jobs ----------

create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  quote_id       uuid unique references public.quote_requests on delete restrict,
  customer_id    uuid not null references public.customers on delete restrict,
  address_id     uuid references public.addresses on delete set null,
  crew_id        uuid references public.crews on delete set null,
  unit_id        uuid references public.units on delete set null,
  scheduled_date date not null,
  time_window    text not null check (time_window in ('morning', 'midday', 'afternoon', 'evening')),
  status         text not null default 'scheduled'
                 check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  warranty_days  integer not null default 14 check (warranty_days between 0 and 365),
  completed_at   timestamptz,
  warranty_until date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint completed_has_dates check (status <> 'completed' or (completed_at is not null and warranty_until is not null))
);
create index on public.jobs (scheduled_date, time_window);
create trigger touch before update on public.jobs for each row execute function public.touch_updated_at();

-- The firm price, line by line. Starts as a copy of the online estimate;
-- any change Richard makes on site carries a reason.
create table public.job_items (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs on delete cascade,
  price_key     text,                 -- price_book key, 'rooms', 'promo', or null for custom
  label         text not null,
  qty           integer not null default 1 check (qty > 0),
  unit_cents    integer not null,
  adjust_reason text,
  from_estimate boolean not null default false,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  -- "is not distinct from": a plain = would let NULL price_key through.
  constraint only_promo_negative check (unit_cents >= 0 or price_key is not distinct from 'promo')
);
create index on public.job_items (job_id, sort);

-- One row per job with everything the Today and Week screens show.
create view public.job_board with (security_invoker = true) as
select j.id, j.status, j.scheduled_date, j.time_window, j.warranty_until, j.notes,
       j.crew_id, cr.name as crew_name, j.unit_id, u.unit_no,
       c.name as customer_name, c.phone_e164, a.line1, a.zip, a.access_notes,
       q.service, q.id as quote_id,
       coalesce((select sum(i.qty * i.unit_cents) from public.job_items i where i.job_id = j.id), 0)::integer as firm_total_cents
from public.jobs j
join public.customers c on c.id = j.customer_id
left join public.addresses a on a.id = j.address_id
left join public.crews cr on cr.id = j.crew_id
left join public.units u on u.id = j.unit_id
left join public.quote_requests q on q.id = j.quote_id;

-- ---------- actions ----------

-- Turn a lead into a scheduled job. Copies the estimate into job_items so
-- the firm price starts from exactly what the customer was shown.
create function public.book_quote(p_quote_id uuid, p_date date, p_window text, p_crew uuid default null, p_unit uuid default null)
returns uuid language plpgsql as $$
declare
  q        public.quote_requests;
  v_job    uuid;
  v_days   integer;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select * into q from public.quote_requests where id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if q.status in ('booked', 'completed') then raise exception 'quote is already %', q.status; end if;

  select coalesce((pb.includes->>'warranty_days')::int, 14) into v_days
  from public.price_book pb where pb.key = q.package_key;
  v_days := coalesce(v_days, 14);

  insert into public.jobs (quote_id, customer_id, address_id, crew_id, unit_id, scheduled_date, time_window, warranty_days)
  values (q.id, q.customer_id, q.address_id, p_crew, p_unit, p_date, p_window, v_days)
  returning id into v_job;

  insert into public.job_items (job_id, price_key, label, qty, unit_cents, from_estimate, sort)
  select v_job, l->>'key', l->>'label', 1, (l->>'total_cents')::int, true, ord::int
  from jsonb_array_elements(coalesce(q.price_lines, '[]'::jsonb)) with ordinality as t(l, ord);

  if coalesce(q.est_discount_cents, 0) > 0 then
    insert into public.job_items (job_id, price_key, label, qty, unit_cents, from_estimate, sort)
    values (v_job, 'promo', 'Online discount (' || q.promo_code || ')', 1, -q.est_discount_cents, true, 999);
  end if;

  update public.quote_requests set status = 'booked' where id = q.id;
  return v_job;
end $$;

-- Close out a job: stamps completion and starts the re-clean guarantee clock.
create function public.complete_job(p_job_id uuid, p_tz text default 'America/Chicago')
returns date language plpgsql as $$
declare
  j       public.jobs;
  v_until date;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select * into j from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if j.status = 'cancelled' then raise exception 'job is cancelled'; end if;

  v_until := (now() at time zone p_tz)::date + j.warranty_days;
  update public.jobs
     set status = 'completed', completed_at = coalesce(completed_at, now()), warranty_until = v_until
   where id = j.id;
  if j.quote_id is not null then
    update public.quote_requests set status = 'completed' where id = j.quote_id;
  end if;
  return v_until;
end $$;

revoke execute on function public.book_quote(uuid, date, text, uuid, uuid) from public, anon;
revoke execute on function public.complete_job(uuid, text) from public, anon;
grant execute on function public.book_quote(uuid, date, text, uuid, uuid) to authenticated;
grant execute on function public.complete_job(uuid, text) to authenticated;

-- ---------- row level security ----------

alter table public.admins    enable row level security;
alter table public.crews     enable row level security;
alter table public.units     enable row level security;
alter table public.jobs      enable row level security;
alter table public.job_items enable row level security;

create policy admins_read_self on public.admins for select to authenticated using (user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['price_book', 'promo_codes', 'service_zips', 'customers', 'addresses',
                           'quote_requests', 'messages', 'crews', 'units', 'jobs', 'job_items']
  loop
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

grant select on public.lead_inbox to authenticated;
grant select on public.job_board to authenticated;
