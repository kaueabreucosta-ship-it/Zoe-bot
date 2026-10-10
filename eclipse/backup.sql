-- Backups de servidor (comando /backup). Rode UMA vez no Supabase: SQL Editor > New query > Run.
-- É seguro rodar de novo (tudo "if not exists").

create table if not exists server_backups (
  id          bigint generated always as identity primary key,
  guild_id    text not null,                 -- servidor de origem
  guild_nome  text,
  nome        text not null,                 -- nome do backup (dado por quem criou)
  criado_por  text not null,                 -- id do Discord de quem criou
  criado_em   timestamptz not null default now(),
  versao      int  not null default 1,       -- versão do formato do JSON em "dados"
  resumo      jsonb not null default '{}',   -- contagens (cargos, canais, emojis...) pra listar sem baixar tudo
  dados       jsonb not null                 -- estrutura completa: cargos, categorias, canais, permissões, emojis
);

create index if not exists server_backups_guild_idx on server_backups (guild_id, id desc);

-- Só o bot (chave service_role) mexe nessa tabela. Com RLS ligado e SEM nenhuma policy,
-- as chaves anon/authenticated (usadas em sites) ficam bloqueadas.
alter table server_backups enable row level security;
