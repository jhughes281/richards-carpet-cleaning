-- More services, all priced on site for now (no price_book rows).
-- Must match SERVICES in supabase/functions/_shared/validate.js
-- (tests/backend.test.mjs checks this).

alter table public.quote_requests drop constraint quote_requests_service_check;
alter table public.quote_requests add constraint quote_requests_service_check
  check (service in ('carpet', 'upholstery', 'tile', 'pet', 'commercial',
                     'rug', 'mattress', 'water', 'repair', 'auto', 'leather'));
