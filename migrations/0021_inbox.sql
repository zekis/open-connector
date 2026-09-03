create table if not exists inbox_conversations (
  id text primary key,
  updated_at text not null,
  value text not null
);

create index if not exists idx_inbox_conversations_updated
  on inbox_conversations (updated_at desc, id desc);
