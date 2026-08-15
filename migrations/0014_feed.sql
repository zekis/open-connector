create table if not exists feed_threads (
  id text primary key,
  flow_run_id text not null unique,
  updated_at text not null,
  value text not null
);

create index if not exists feed_threads_updated_at_id_idx
  on feed_threads (updated_at desc, id desc);
