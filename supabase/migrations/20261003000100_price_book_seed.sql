-- Starting prices, taken from the site's original instant-estimate calculator.
-- Must match DEFAULT_PRICE_BOOK in supabase/functions/_shared/pricing.js
-- (tests/pricing.test.mjs checks this). After launch, change prices here or
-- in the table editor; the website and server pick them up within 5 minutes.

insert into public.price_book (key, kind, label, amount_cents, includes, sort) values
  ('room_first',       'room',     'First room',               7900, null, 1),
  ('room_additional',  'room',     'Each additional room',     2000, null, 2),
  ('addon_hall',       'addon',    'Hallway',                  2500, null, 10),
  ('addon_stairs',     'addon',    'Stairs',                   4500, null, 11),
  ('addon_pet',        'addon',    'Pet treatment',            4900, null, 12),
  ('addon_scotchgard', 'addon',    'Scotchgard',               3900, null, 13),
  ('addon_sofa',       'addon',    'Sofa or loveseat',         7900, null, 14),
  ('tile_sqft',        'per_sqft', 'Tile & grout, per sq ft',    75, null, 20),
  ('pkg_essential',    'package',  'Essential',  null, '{"rooms":3,"addons":["addon_hall"],"warranty_days":14}', 30),
  ('pkg_deep',         'package',  'Deep Clean', null, '{"rooms":5,"addons":["addon_hall","addon_stairs","addon_scotchgard"],"warranty_days":14}', 31),
  ('pkg_platinum',     'package',  'Platinum',   null, '{"rooms":8,"addons":["addon_hall","addon_sofa","addon_scotchgard"],"warranty_days":30}', 32);

-- $15 off online bookings. Set ends_on when Richard picks an end date.
insert into public.promo_codes (code, amount_cents, online_only) values ('BLUE15', 1500, true);
