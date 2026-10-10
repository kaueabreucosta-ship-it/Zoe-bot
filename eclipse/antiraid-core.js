/**
 * Anti-raid — CÉREBRO (lógica pura, sem discord.js, sem banco).
 * Fica separado de propósito: dá pra testar com `npm test` sem Discord nenhum.
 *
 * O que ele responde:
 *  - "isso aqui é uma enxurrada de gente entrando?"  -> avaliarEntrada()
 *  - "essa mensagem de novato parece spam de raid?"  -> analisarMensagemNovato()
 *  - "o que eu faço com esse membro novo?"           -> decidirAcao()
 */

export const PADRAO_ANTIRAID = {
  ativo: true,
  limite: 6, // quantas pessoas entrando...
  janela_seg: 10, // ...nesse tempo (segundos) = raid
  acao: 'timeout', // alertar | timeout | kick | ban (o que fazer com novatos durante o raid)
  duracao_min: 10, // duração do modo raid e do timeout (minutos)
  idade_min_dias: 0, // 0 = desligado. Conta mais nova que isso leva timeout mesmo sem raid
  pausar_convites: true, // durante o raid, pausa convites e DMs do servidor (se o bot tiver permissão)
};

export const ACOES_VALIDAS = ['alertar', 'timeout', 'kick', 'ban'];
export const NOVATO_MINUTOS = 10; // "novato" = entrou há menos disso
export const SINAIS_PARA_RAID = 3; // 3 novatos DIFERENTES mandando spam = raid

const REGEX_CONVITE = /(discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg)\/\S+/i;

/** "kaue123", "kaue_456", "Kaue.789" -> "kaue". Bot de raid adora nome + número. */
export function normalizarNome(nome) {
  return String(nome || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 12);
}

/** Junta os valores padrão com o que o servidor configurou (e conserta valores esquisitos). */
export function mesclarConfig(salvo = {}) {
  const c = { ...PADRAO_ANTIRAID };
  for (const k of Object.keys(PADRAO_ANTIRAID)) {
    if (salvo[k] !== undefined && salvo[k] !== null) c[k] = salvo[k];
  }
  c.limite = Math.min(Math.max(Number(c.limite) || PADRAO_ANTIRAID.limite, 3), 50);
  c.janela_seg = Math.min(Math.max(Number(c.janela_seg) || PADRAO_ANTIRAID.janela_seg, 3), 300);
  c.duracao_min = Math.min(Math.max(Number(c.duracao_min) || PADRAO_ANTIRAID.duracao_min, 1), 1440);
  c.idade_min_dias = Math.min(Math.max(Number(c.idade_min_dias) || 0, 0), 365);
  if (!ACOES_VALIDAS.includes(c.acao)) c.acao = PADRAO_ANTIRAID.acao;
  c.ativo = c.ativo !== false;
  c.pausar_convites = c.pausar_convites !== false;
  return c;
}

/**
 * Registra uma entrada e diz se virou raid.
 * @param historico  array de { id, t, nome } (é modificado: entra a nova e saem as velhas)
 * @returns { gatilho: null | { tipo, quantidade }, janela: [ids de quem entrou na janela] }
 */
export function avaliarEntrada(historico, entrada, cfg, agora = Date.now()) {
  historico.push({ id: entrada.id, t: agora, nome: normalizarNome(entrada.nome) });

  // guarda só o que importa (3x a janela, pro teste de nomes parecidos)
  const corte = agora - cfg.janela_seg * 3 * 1000;
  while (historico.length && historico[0].t < corte) historico.shift();
  while (historico.length > 200) historico.shift();

  const janelaMs = cfg.janela_seg * 1000;
  const naJanela = historico.filter((h) => agora - h.t <= janelaMs);

  // Regra 1: ENXURRADA — gente demais entrando rápido demais
  if (naJanela.length >= cfg.limite) {
    return { gatilho: { tipo: 'enxurrada', quantidade: naJanela.length }, janela: naJanela.map((h) => h.id) };
  }

  // Regra 2: NOMES PARECIDOS — "joao1", "joao2", "joao3"... (limite menor, janela 3x maior)
  const limiteNomes = Math.max(3, Math.ceil(cfg.limite * 0.6));
  const nome = normalizarNome(entrada.nome);
  if (nome.length >= 3) {
    const parecidos = historico.filter((h) => h.nome === nome);
    if (parecidos.length >= limiteNomes) {
      return { gatilho: { tipo: 'nomes_parecidos', quantidade: parecidos.length }, janela: parecidos.map((h) => h.id) };
    }
  }

  return { gatilho: null, janela: [] };
}

/**
 * Mensagem de NOVATO com cara de spam de raid? Devolve o motivo (texto) ou null.
 * Só olha quem entrou há menos de NOVATO_MINUTOS.
 */
export function analisarMensagemNovato({ conteudo = '', mencoesUsuarios = 0, mencionaTodos = false, entrouHaMs }) {
  if (entrouHaMs == null || entrouHaMs > NOVATO_MINUTOS * 60 * 1000) return null;
  if (REGEX_CONVITE.test(conteudo)) return 'convite de outro servidor logo após entrar';
  if (mencionaTodos || /@(everyone|here)/i.test(conteudo)) return '@everyone/@here logo após entrar';
  if (mencoesUsuarios >= 5) return `${mencoesUsuarios} menções numa mensagem logo após entrar`;
  return null;
}

/** Registra um "sinal" (novato que mandou spam). Devolve quantos novatos DIFERENTES sinalizaram na janela. */
export function registrarSinal(sinais, userId, cfg, agora = Date.now()) {
  sinais.push({ id: userId, t: agora });
  const corte = agora - Math.max(cfg.janela_seg, 30) * 1000;
  while (sinais.length && sinais[0].t < corte) sinais.shift();
  while (sinais.length > 100) sinais.shift();
  return new Set(sinais.map((s) => s.id)).size;
}

/** O que fazer com um membro que acabou de entrar? */
export function decidirAcao({ raidAtivo, idadeDias, cfg }) {
  if (raidAtivo) return cfg.acao;
  if (cfg.idade_min_dias > 0 && idadeDias < cfg.idade_min_dias) {
    // fora de raid nunca é kick/ban só por idade da conta: no máximo timeout (reversível)
    return cfg.acao === 'alertar' ? 'alertar' : 'timeout';
  }
  return 'nenhuma';
}
