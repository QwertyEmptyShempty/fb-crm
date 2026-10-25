// Схема БД. Применяется при каждом старте (идемпотентно).
export const SCHEMA = /* sql */ `
create table if not exists pixels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pixel_id text not null unique,
  capi_token text,
  test_event_code text,
  created_at timestamptz not null default now()
);

create table if not exists bots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token text not null,
  username text,
  tg_id bigint not null unique,
  webhook_secret text not null,
  created_at timestamptz not null default now()
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  chat_id bigint not null unique,
  title text,
  username text,
  created_at timestamptz not null default now()
);
alter table channels add column if not exists bot_id uuid references bots(id) on delete cascade;

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active',
  pixel_id uuid references pixels(id) on delete set null,
  channel_id uuid references channels(id) on delete set null,
  landing jsonb not null default '{}',
  welcome jsonb not null default '[]',
  auto_approve boolean not null default true,
  event_map jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table offers add column if not exists domain text;
alter table offers add column if not exists landing_type text not null default 'default';
alter table offers add column if not exists landing_html text;
create unique index if not exists offers_domain_uq on offers (lower(domain)) where domain is not null;

create table if not exists landing_assets (
  offer_id uuid not null references offers(id) on delete cascade,
  path text not null,
  content_type text not null,
  data bytea not null,
  primary key (offer_id, path)
);

create table if not exists visits (
  id uuid primary key,
  offer_id uuid not null references offers(id) on delete cascade,
  fbclid text,
  fbp text,
  fbc text,
  ip text,
  user_agent text,
  referrer text,
  url text,
  utm jsonb not null default '{}',
  params jsonb not null default '{}',
  invite_link text,
  clicked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists visits_invite_link_uq on visits(invite_link) where invite_link is not null;
create index if not exists visits_offer_created on visits(offer_id, created_at);

create table if not exists subscribers (
  id bigserial primary key,
  offer_id uuid not null references offers(id) on delete cascade,
  visit_id uuid references visits(id) on delete set null,
  tg_user_id bigint not null,
  username text,
  first_name text,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  joined_at timestamptz,
  left_at timestamptz,
  unique (offer_id, tg_user_id)
);
create index if not exists subscribers_user on subscribers(tg_user_id);

create table if not exists events (
  id bigserial primary key,
  offer_id uuid references offers(id) on delete cascade,
  visit_id uuid references visits(id) on delete set null,
  type text not null,
  tg_user_id bigint,
  meta jsonb not null default '{}',
  capi jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_offer_type_created on events(offer_id, type, created_at);
create index if not exists events_visit on events(visit_id);

create table if not exists scheduled_messages (
  id bigserial primary key,
  subscriber_id bigint references subscribers(id) on delete cascade,
  tg_user_id bigint not null,
  step jsonb not null,
  run_at timestamptz not null,
  sent_at timestamptz,
  attempts int not null default 0,
  error text
);
alter table scheduled_messages add column if not exists bot_id uuid references bots(id) on delete cascade;
create index if not exists scheduled_due on scheduled_messages(run_at) where sent_at is null;
`;
