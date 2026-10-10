-- Anti-raid da Eclipse. Rode UMA vez no Supabase: SQL Editor > New query > Run.
-- (Sem esta tabela o anti-raid funciona com os valores padrão, mas o que você mudar em /antiraid
--  se perde quando o bot reinicia.)

create table if not exists antiraid_config (
  guild_id        text primary key,
  ativo           boolean not null default true,
  limite          int     not null default 6,      -- quantas entradas contam como raid
  janela_seg      int     not null default 10,     -- em quantos segundos
  acao            text    not null default 'timeout' check (acao in ('alertar','timeout','kick','ban')),
  duracao_min     int     not null default 10,     -- minutos de modo raid e de timeout
  idade_min_dias  int     not null default 0,      -- 0 = desligado
  pausar_convites boolean not null default true,
  atualizado_em   timestamptz not null default now()
);
