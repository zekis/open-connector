create table if not exists synapse_workspaces (
  id text primary key,
  updated_at text not null,
  value text not null
);

create index if not exists synapse_workspaces_updated_at_id_idx
  on synapse_workspaces (updated_at desc, id desc);
