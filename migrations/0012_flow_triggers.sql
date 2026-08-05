create table if not exists flow_trigger_states (
  id text primary key,
  updated_at text not null,
  value text not null
);
