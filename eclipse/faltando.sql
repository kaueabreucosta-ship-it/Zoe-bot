-- Tabelas e funções que o CÓDIGO usa mas que NÃO vinham nos .sql do zip.
-- Se o seu Supabase é novo/limpo, rode isto UMA vez: SQL Editor > New query > Run.
-- É seguro rodar de novo: tudo é "if not exists" (as funções só são criadas se ainda não existirem).
-- Pré-requisito: já ter rodado o economia.sql (tabela `economia`).

-- ===== Configuração por servidor (index.js: getGuildConfig) =====
create table if not exists guild_config (
  guild_id                      text primary key,
  logs_canal_id                 text,
  moderacao_canal_id            text,
  moderacao_ativo               boolean not null default true,
  moderacao_mute_minutos        int     not null default 30,
  automod_antispam_ativo        boolean not null default true,
  automod_antispam_limite       int     not null default 5,
  automod_antispam_janela_seg   int     not null default 5,
  automod_anticaps_ativo        boolean not null default true,
  automod_anticaps_porcentagem  int     not null default 70,
  automod_anticaps_minimo       int     not null default 10,
  automod_antiflood_ativo       boolean not null default true,
  automod_antiflood_repeticoes  int     not null default 3,
  contexto_ativo                boolean not null default true,
  contexto_limite               int     not null default 50
);

-- ===== Histórico de mensagens da moderação (moderation.js) =====
create table if not exists mensagens_log (
  id         bigint generated always as identity primary key,
  guild_id   text not null,
  channel_id text not null,
  message_id text not null,
  autor_id   text not null,
  autor_tag  text,
  conteudo   text,
  anexos     jsonb not null default '[]',
  criado_em  timestamptz not null default now()
);
create index if not exists mensagens_log_autor_idx on mensagens_log (guild_id, autor_id, criado_em desc);
create index if not exists mensagens_log_data_idx on mensagens_log (criado_em);
-- DICA: essa tabela cresce pra sempre. Apague o que passou de 30 dias de vez em quando:
--   delete from mensagens_log where criado_em < now() - interval '30 days';

-- ===== Diário e tickets (extras.js) =====
create table if not exists daily_rewards (
  guild_id   text not null,
  user_id    text not null,
  claimed_at timestamptz not null default now(),
  streak     int not null default 0,
  primary key (guild_id, user_id)
);

create table if not exists ticket_config (
  guild_id      text primary key,
  category_id   text,
  staff_role_id text,
  updated_at    timestamptz not null default now()
);

create table if not exists tickets (
  id         bigint generated always as identity primary key,
  guild_id   text not null,
  channel_id text not null unique,
  user_id    text not null,
  status     text not null default 'open',
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index if not exists tickets_user_idx on tickets (guild_id, user_id, status);

-- ===== Funções da economia usadas por /diario e /transferir (só cria se ainda não existir) =====
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'eco_premiar') then
    execute $f$
      create function eco_premiar(p_guild text, p_user text, p_valor int)
      returns bigint language plpgsql as $b$
      declare novo bigint;
      begin
        if p_valor <= 0 then return null; end if;
        insert into economia (guild_id, user_id, saldo, total_ganho)
        values (p_guild, p_user, p_valor, p_valor)
        on conflict (guild_id, user_id) do update
          set saldo = economia.saldo + excluded.saldo,
              total_ganho = economia.total_ganho + excluded.saldo,
              atualizado_em = now()
        returning saldo into novo;
        return novo;
      end $b$;
    $f$;
  end if;

  if not exists (select 1 from pg_proc where proname = 'eco_transferir') then
    execute $f$
      create function eco_transferir(p_guild text, p_from text, p_to text, p_valor bigint)
      returns bigint language plpgsql as $b$
      declare novo bigint;
      begin
        if p_valor <= 0 or p_from = p_to then return null; end if;
        -- tira de quem manda (só se tiver saldo) e dá pra quem recebe, tudo na mesma transação
        update economia set saldo = saldo - p_valor, atualizado_em = now()
         where guild_id = p_guild and user_id = p_from and saldo >= p_valor
        returning saldo into novo;
        if novo is null then return null; end if;
        insert into economia (guild_id, user_id, saldo)
        values (p_guild, p_to, p_valor)
        on conflict (guild_id, user_id) do update
          set saldo = economia.saldo + p_valor, atualizado_em = now();
        return novo;
      end $b$;
    $f$;
  end if;
end $$;

-- ===== OPCIONAL (segurança): trancar as tabelas do bot =====
-- Só rode se a SUPABASE_KEY do bot for a chave "service_role" (ela ignora o RLS).
-- Se for a chave "anon", NÃO rode: o bot perderia acesso. Dica: o bot nunca deve usar a anon.
-- alter table economia          enable row level security;
-- alter table daily_rewards     enable row level security;
-- alter table tickets           enable row level security;
-- alter table ticket_config     enable row level security;
-- alter table cargo_permissoes  enable row level security;
-- alter table guild_config      enable row level security;
-- alter table mensagens_log     enable row level security;
-- alter table antiraid_config   enable row level security;
-- revoke execute on all functions in schema public from anon, authenticated;
