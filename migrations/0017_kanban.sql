create table if not exists kanban_boards (
  id text primary key,
  updated_at text not null,
  value text not null
);

create index if not exists kanban_boards_updated_at_id_idx
  on kanban_boards (updated_at desc, id desc);
