create table if not exists teams_gateway_agents (
  id text primary key,
  updated_at text not null,
  value text not null
);

create index if not exists teams_gateway_agents_updated_at_id_idx
  on teams_gateway_agents (updated_at desc, id desc);

create table if not exists teams_gateway_threads (
  id text primary key,
  agent_id text not null,
  chat_id text not null,
  updated_at text not null,
  value text not null,
  unique (agent_id, chat_id)
);

create index if not exists teams_gateway_threads_agent_updated_idx
  on teams_gateway_threads (agent_id, updated_at desc, id desc);

create table if not exists teams_gateway_contacts (
  id text primary key,
  agent_id text not null,
  email text not null,
  updated_at text not null,
  value text not null,
  unique (agent_id, email)
);

create index if not exists teams_gateway_contacts_agent_email_idx
  on teams_gateway_contacts (agent_id, email);
