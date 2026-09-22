-- Standalone posts have no Flow run. Preserve existing encrypted thread values.
create table feed_threads_with_posts (
  id text primary key,
  flow_run_id text unique,
  updated_at text not null,
  value text not null
);

insert into feed_threads_with_posts (id, flow_run_id, updated_at, value)
  select id, flow_run_id, updated_at, value from feed_threads;

drop table feed_threads;
alter table feed_threads_with_posts rename to feed_threads;

create index feed_threads_updated_at_id_idx
  on feed_threads (updated_at desc, id desc);
