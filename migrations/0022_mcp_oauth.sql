alter table runtime_tokens add column audience text;
alter table runtime_tokens add column scopes text not null default '[]';
alter table runtime_tokens add column expires_at text;

create table if not exists mcp_oauth_clients (
  id text primary key,
  name text not null,
  redirect_uris text not null,
  grant_types text not null,
  created_at text not null
);

create table if not exists mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scopes text not null,
  created_at text not null,
  expires_at text not null
);

create index if not exists mcp_oauth_codes_expiry on mcp_oauth_codes (expires_at);

create table if not exists mcp_oauth_refresh_tokens (
  token_hash text primary key,
  client_id text not null,
  runtime_token_id text not null,
  resource text not null,
  scopes text not null,
  created_at text not null,
  expires_at text not null
);

create index if not exists mcp_oauth_refresh_tokens_expiry on mcp_oauth_refresh_tokens (expires_at);
