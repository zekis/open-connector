create table if not exists flows (
  id text primary key,
  status text not null,
  created_at text not null,
  updated_at text not null,
  value text not null,
  check (status in ('active', 'paused'))
);

create index if not exists flows_updated_at_id_idx on flows (updated_at desc, id desc);

create table if not exists flow_runs (
  id text primary key,
  flow_id text not null,
  status text not null,
  started_at text not null,
  updated_at text not null,
  value text not null,
  check (status in ('running', 'waiting_for_approval', 'completed', 'failed', 'cancelled'))
);

create index if not exists flow_runs_flow_started_at_id_idx
  on flow_runs (flow_id, started_at desc, id desc);
create index if not exists flow_runs_status_started_at_id_idx
  on flow_runs (status, started_at desc, id desc);

create table if not exists flow_steps (
  id text primary key,
  run_id text not null,
  sequence integer not null,
  status text not null,
  started_at text not null,
  value text not null,
  unique (run_id, sequence),
  check (status in ('pending', 'completed', 'failed', 'denied'))
);

create index if not exists flow_steps_run_sequence_idx on flow_steps (run_id, sequence);

create table if not exists flow_approvals (
  id text primary key,
  flow_id text not null,
  run_id text not null,
  step_id text not null unique,
  status text not null,
  requested_at text not null,
  value text not null,
  check (status in ('pending', 'approved', 'denied'))
);

create index if not exists flow_approvals_status_requested_at_id_idx
  on flow_approvals (status, requested_at desc, id desc);
create index if not exists flow_approvals_run_requested_at_id_idx
  on flow_approvals (run_id, requested_at, id);
