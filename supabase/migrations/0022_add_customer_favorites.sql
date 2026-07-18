-- Lets staff mark frequently-used customers as favourites so they're pinned
-- to the top of the searchable customer picker when creating jobs, quotes,
-- and invoices, instead of hunting through the full alphabetical list every
-- time for the same handful of repeat customers.
alter table customers add column if not exists is_favorite boolean not null default false;

create index if not exists customers_is_favorite_idx on customers(is_favorite) where is_favorite = true;
