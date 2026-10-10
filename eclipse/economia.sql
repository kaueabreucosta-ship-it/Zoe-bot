-- Economia da Zoe (moeda: Zoe Coins, ZC). Rode UMA vez no Supabase: SQL Editor > New query > Run.

create table if not exists economia (
  guild_id        text not null,
  user_id         text not null,
  saldo           bigint not null default 0 check (saldo >= 0),
  ganho_dia       date,
  ganho_hoje      int not null default 0,
  total_ganho     bigint not null default 0,
  total_apostado  bigint not null default 0,
  atualizado_em   timestamptz not null default now(),
  primary key (guild_id, user_id)
);

-- Credita moedas por interação, respeitando o teto diário. Retorna quanto foi creditado.
create or replace function eco_ganhar(p_guild text, p_user text, p_valor int, p_teto int)
returns int language plpgsql as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  prev int; novo int; cred int;
begin
  insert into economia (guild_id, user_id, ganho_dia, ganho_hoje)
  values (p_guild, p_user, hoje, 0) on conflict do nothing;

  select case when ganho_dia = hoje then ganho_hoje else 0 end into prev
  from economia where guild_id = p_guild and user_id = p_user for update;

  novo := least(p_teto, prev + p_valor);
  cred := novo - prev;

  update economia
     set saldo = saldo + cred, ganho_hoje = novo, ganho_dia = hoje,
         total_ganho = total_ganho + cred, atualizado_em = now()
   where guild_id = p_guild and user_id = p_user;
  return cred;
end $$;

-- Aposta atômica: debita a aposta e credita o prêmio de uma vez só.
-- Retorna o novo saldo, ou NULL se não houver saldo suficiente.
create or replace function eco_liquidar(p_guild text, p_user text, p_aposta bigint, p_premio bigint)
returns bigint language plpgsql as $$
declare novo bigint;
begin
  update economia
     set saldo = saldo - p_aposta + p_premio,
         total_apostado = total_apostado + p_aposta,
         atualizado_em = now()
   where guild_id = p_guild and user_id = p_user and saldo >= p_aposta
  returning saldo into novo;
  return novo;
end $$;
