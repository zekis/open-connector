create table if not exists mobile_pairings (
  id text primary key,
  name text not null,
  code_hash text not null unique,
  created_at text not null,
  expires_at text not null
);

create index if not exists mobile_pairings_expires_at_idx on mobile_pairings (expires_at);

create table if not exists mobile_devices (
  id text primary key,
  pairing_id text not null,
  name text not null,
  token_hash text not null unique,
  user_agent text,
  created_at text not null,
  last_used_at text
);

create index if not exists mobile_devices_created_at_id_idx on mobile_devices (created_at desc, id desc);
