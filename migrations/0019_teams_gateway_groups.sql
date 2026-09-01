create table if not exists teams_gateway_groups (
  id text primary key,
  agent_id text not null,
  kind text not null,
  external_id text not null,
  updated_at text not null,
  value text not null,
  unique (agent_id, kind, external_id)
);

create index if not exists teams_gateway_groups_agent_updated_idx
  on teams_gateway_groups (agent_id, updated_at desc, id desc);
