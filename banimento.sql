-- Permissões por cargo (painel /permissoes da Zoe). Rode UMA vez no Supabase: SQL Editor > New query > Run.
-- A tabela banned_users (ban no site) já existe — ver ban_ip_hardware.sql do dm-control.

create table if not exists cargo_permissoes (
  guild_id   text not null,
  role_id    text not null,
  comando    text not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, role_id, comando)
);

create index if not exists cargo_permissoes_guild_cmd_idx on cargo_permissoes (guild_id, comando);
