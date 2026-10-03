-- Richard's Carpet Cleaning: phase 1 schema (stop losing leads).
--
-- Access model: row level security is ON for every table and there are NO
-- policies for the anon or authenticated roles. The public website never
-- touches tables directly; it only calls the edge functions, which use the
-- service role. Richard reads leads in the Supabase table editor until the
-- phase 2 admin app adds login-based policies.

create extension if not exists citext;

-- Prices. The only place they live. See supabase/functions/_shared/pricing.js.
create table public.price_book (
  key          text primary key,
  kind         text not null check (kind in ('room', 'addon', 'per_sqft', 'package')),
  label        text not null,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  includes     jsonb,          -- packages only: {"rooms":3,"addons":["addon_hall"],"warranty_days":14}
  sort         integer not null default 0,
  active       boolean not null default true,
  updated_at   timestamptz not null default now(),
  constraint priced_unless_package check (kind = 'package' or amount_cents is not null),
  constraint package_has_includes check (kind <> 'package' or includes is not null)
);

create table public.promo_codes (
  code         citext primary key,
  amount_cents integer not null check (amount_cents > 0),
  online_only  boolean not null default true,
  starts_on    date,
  ends_on      date,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- If this table is empty, every ZIP is treated as "unknown" and accepted.
create table public.service_zips (
  zip              text primary key check (zip ~ '^\d{5}$'),
  zone             text,
  same_day         boolean not null default false,
  travel_fee_cents integer not null default 0
);

create table public.customers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone_e164        text not null unique check (phone_e164 ~ '^\+1\d{10}$'),
  email             citext,
  kind              text not null default 'residential' check (kind in ('residential', 'commercial')),
  -- Proof of consent to be contacted (TCPA): when, and which wording.
  sms_consent_at    timestamptz,
  consent_text_ver  text,
  sms_opted_out_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.addresses (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers on delete cascade,
  line1           text not null,
  zip             text not null,
  in_service_area boolean,       -- null = no service_zips configured yet
  access_notes    text,
  created_at      timestamptz not null default now()
);
create index on public.addresses (customer_id);

create table public.quote_requests (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers on delete cascade,
  address_id         uuid references public.addresses on delete set null,
  status             text not null default 'new'
                     check (status in ('new', 'contacted', 'quoted', 'booked', 'completed', 'lost', 'cancelled')),
  service            text not null check (service in ('carpet', 'upholstery', 'tile', 'pet', 'commercial')),
  package_key        text,
  rooms              integer not null default 0 check (rooms between 0 and 8),
  addons             text[] not null default '{}',
  preferred_date     date not null,
  notes              text,
  promo_code         citext,
  -- Server-computed estimate, frozen at request time so later price
  -- changes never rewrite what the customer was told.
  est_subtotal_cents integer,
  est_discount_cents integer,
  est_total_cents    integer,
  price_lines        jsonb,
  price_book_version text,
  ip_hash            text,
  utm                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on public.quote_requests (status, created_at desc);
create index on public.quote_requests (ip_hash, created_at desc);

create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers on delete set null,
  quote_id    uuid references public.quote_requests on delete set null,
  channel     text not null check (channel in ('sms', 'email')),
  direction   text not null check (direction in ('out', 'in')),
  to_addr     text,
  from_addr   text,
  body        text,
  status      text not null,     -- sent | failed | received
  provider_id text,
  error       text,
  created_at  timestamptz not null default now()
);
create index on public.messages (customer_id, created_at desc);

-- Lead inbox for the table editor: newest first, everything on one row.
create view public.lead_inbox with (security_invoker = true) as
select q.created_at, q.status, c.name, c.phone_e164, c.email, a.line1, a.zip, a.in_service_area,
       q.service, q.rooms, q.addons, q.package_key, q.preferred_date,
       (q.est_total_cents / 100.0)::numeric(10,2) as est_total_usd, q.promo_code, q.notes, q.id as quote_id
from public.quote_requests q
join public.customers c on c.id = q.customer_id
left join public.addresses a on a.id = q.address_id
order by q.created_at desc;

-- Keep updated_at honest.
create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger touch before update on public.price_book     for each row execute function public.touch_updated_at();
create trigger touch before update on public.customers      for each row execute function public.touch_updated_at();
create trigger touch before update on public.quote_requests for each row execute function public.touch_updated_at();

-- Lock everything down. No policies = no access for anon/authenticated.
alter table public.price_book     enable row level security;
alter table public.promo_codes    enable row level security;
alter table public.service_zips   enable row level security;
alter table public.customers      enable row level security;
alter table public.addresses      enable row level security;
alter table public.quote_requests enable row level security;
alter table public.messages       enable row level security;
revoke all on public.lead_inbox from anon, authenticated;

-- Save customer + address + quote in one transaction. Called only by the
-- submit-quote edge function (service role); nobody else may execute it.
create function public.save_quote(p_customer jsonb, p_address jsonb, p_quote jsonb)
returns table (quote_id uuid, customer_id uuid)
language plpgsql as $$
#variable_conflict use_column
declare
  v_customer uuid;
  v_address  uuid;
  v_quote    uuid;
begin
  insert into public.customers (name, phone_e164, email, sms_consent_at, consent_text_ver)
  values (p_customer->>'name', p_customer->>'phone_e164', nullif(p_customer->>'email', ''),
          (p_customer->>'consented_at')::timestamptz, p_customer->>'consent_text_ver')
  on conflict (phone_e164) do update
    set name             = excluded.name,
        email            = coalesce(excluded.email, public.customers.email),
        sms_consent_at   = excluded.sms_consent_at,
        consent_text_ver = excluded.consent_text_ver
  returning id into v_customer;

  insert into public.addresses (customer_id, line1, zip, in_service_area)
  values (v_customer, p_address->>'line1', p_address->>'zip', (p_address->>'in_service_area')::boolean)
  returning id into v_address;

  insert into public.quote_requests (
    customer_id, address_id, service, package_key, rooms, addons, preferred_date, notes, promo_code,
    est_subtotal_cents, est_discount_cents, est_total_cents, price_lines, price_book_version, ip_hash, utm)
  values (
    v_customer, v_address, p_quote->>'service', p_quote->>'package_key', (p_quote->>'rooms')::int,
    coalesce(array(select jsonb_array_elements_text(p_quote->'addons')), '{}'),
    (p_quote->>'preferred_date')::date, p_quote->>'notes', p_quote->>'promo_code',
    (p_quote->>'est_subtotal_cents')::int, (p_quote->>'est_discount_cents')::int, (p_quote->>'est_total_cents')::int,
    p_quote->'price_lines', p_quote->>'price_book_version', p_quote->>'ip_hash', p_quote->'utm')
  returning id into v_quote;

  return query select v_quote, v_customer;
end $$;
revoke execute on function public.save_quote(jsonb, jsonb, jsonb) from public, anon, authenticated;
