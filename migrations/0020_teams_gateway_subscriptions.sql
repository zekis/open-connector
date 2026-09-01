create table if not exists teams_gateway_subscriptions (
  id text primary key,
  subscription_id text not null unique,
  agent_id text not null,
  expires_at text not null,
  updated_at text not null,
  value text not null
);

create index if not exists teams_gateway_subscriptions_agent_expiry_idx
  on teams_gateway_subscriptions (agent_id, expires_at, id);
