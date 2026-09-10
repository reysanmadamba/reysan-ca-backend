-- Tim Hortons rebrand: run this once in the Supabase SQL Editor
-- (Project -> SQL Editor -> paste -> Run). Safe to review before running;
-- nothing here touches customers, orders, or chat_logs — only the tenant's
-- identity and its menu catalog.

begin;

-- 1) Rename the tenant itself. Everything else (orders, customers, chat_logs)
--    references tenant_id, not the slug, so this alone doesn't break history.
update tenants
set slug = 'timhortons',
    name = 'Tim Hortons'
where slug = 'jollibee';

-- 2) Replace the menu. Deletes only this tenant's existing menu_items rows —
--    does not touch orders that already reference old items by id (orders
--    store a snapshot of item name/price at confirm-order time, so past
--    orders keep displaying correctly even after their menu_item_id is gone).
delete from menu_items
where tenant_id = (select id from tenants where slug = 'timhortons');

insert into menu_items (tenant_id, category, name, description, price, active, veg)
select id, category, name, description, price, true, veg
from (values
  ('Coffee & Tea', 'Double Double',            'Coffee with two cream, two sugar — our best seller.', 2.09, true),
  ('Coffee & Tea', 'Original Blend Coffee',     'Freshly brewed medium roast coffee.',                  1.99, true),
  ('Coffee & Tea', 'French Vanilla Cappuccino', 'Creamy French vanilla flavoured cappuccino.',          2.99, true),
  ('Coffee & Tea', 'Steeped Tea',               'Freshly steeped orange pekoe tea.',                    1.99, true),
  ('Iced & Specialty', 'Iced Capp',             'Our signature blended iced coffee drink.',             3.49, true),
  ('Iced & Specialty', 'Iced Coffee',           'Chilled coffee over ice.',                             2.79, true),
  ('Donuts', 'Maple Dip',                       'Yeast donut with maple-flavoured icing.',              1.79, true),
  ('Donuts', 'Boston Cream',                    'Donut filled with vanilla cream, chocolate glazed.',   1.79, true),
  ('Donuts', 'Old Fashion Plain',                'Classic old fashion plain donut.',                     1.59, true),
  ('Donuts', 'Honey Cruller',                    'Light, airy cruller with honey glaze.',                1.79, true),
  ('Timbits', 'Timbits 10pc',                   'Box of 10 assorted Timbits.',                          2.99, true),
  ('Timbits', 'Timbits 20pc',                   'Box of 20 assorted Timbits.',                          4.99, true),
  ('Timbits', 'Timbits 40pc',                   'Box of 40 assorted Timbits.',                          8.99, true),
  ('Timbits', 'Timbits 50pc',                   'Box of 50 assorted Timbits.',                         10.99, true),
  ('Breakfast', 'Farmer''s Wrap',               'Egg, cheese, hash brown and sausage in a tortilla wrap.', 5.49, false),
  ('Breakfast', 'Bacon & Egger',                'Bacon, egg and cheese on a biscuit.',                  4.29, false),
  ('Breakfast', 'Hash Browns',                  'Crispy golden hash browns.',                           1.99, true),
  ('Bakery', 'Everything Bagel',                'Toasted everything bagel with your choice of spread.', 2.49, true),
  ('Bakery', 'Cinnamon Raisin Bagel',           'Toasted cinnamon raisin bagel with your choice of spread.', 2.49, true),
  ('Bakery', 'Chocolate Chip Cookie',           'Fresh baked chocolate chip cookie.',                   1.99, true),
  ('Lunch', 'Chili',                            'Hearty beef chili, bowl.',                             4.99, false),
  ('Lunch', 'Turkey Bacon Club',                'Turkey, bacon, lettuce and tomato on toasted bread.',  6.49, false),
  ('Lunch', 'Soup of the Day',                  'Ask about today''s soup selection.',                   3.99, true)
) as v(category, name, description, price, veg)
cross join (select id from tenants where slug = 'timhortons') t;

commit;
