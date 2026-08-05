create table if not exists connection_action_permissions (
  id text primary key,
  connection_id text not null,
  action_id text not null,
  updated_at text not null,
  value text not null
);

create unique index if not exists connection_action_permissions_connection_action_idx
  on connection_action_permissions (connection_id, action_id);

create table if not exists action_approvals (
  id text primary key,
  status text not null,
  request_hash text not null,
  requested_at text not null,
  value text not null
);

create index if not exists action_approvals_status_requested_idx
  on action_approvals (status, requested_at desc, id desc);

create index if not exists action_approvals_hash_status_requested_idx
  on action_approvals (request_hash, status, requested_at desc, id desc);
