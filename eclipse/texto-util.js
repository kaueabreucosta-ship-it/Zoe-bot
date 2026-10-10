// Funções puras de texto usadas pela IA (sem dependências, fáceis de testar).

const ZWSP = '\u200b';

/** Limpa a saída da IA: tira raciocínio vazado, prefixo "Nome:", aberturas robóticas e neutraliza @everyone/@here. */
export function limparTexto(texto, { nomes = [] } = {}) {
  let t = String(texto ?? '');
  // Alguns modelos gratuitos vazam o raciocínio entre tags.
  t = t.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, ''); // tag aberta e nunca fechada
  t = t.trim();
  // "Eclipse: oi" -> "oi"
  for (const nome of nomes) {
    const re = new RegExp(`^\\**\\s*${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\**\\s*[:：]\\s*\\**\\s*`, 'i');
    t = t.replace(re, '');
  }
  // Remove aberturas típicas de IA que soam artificiais
  t = t.replace(/^(claro!?|com certeza!?|ótim[ao] pergunta!?|boa pergunta!?|entendi\.?|ok,? vamos l[áa]\.?|certo\.?)\s*/i, '');
  t = t.replace(/@(everyone|here)/gi, `@${ZWSP}$1`);
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** Fatia o texto em blocos de até `max` caracteres, quebrando em parágrafo/linha/espaço (nunca no meio da palavra). */
export function fatiarTexto(texto, max = 1900) {
  const restoInicial = String(texto ?? '').trim();
  if (!restoInicial) return [];
  const blocos = [];
  let resto = restoInicial;
  let reabrir = ''; // reabre bloco de código cortado no meio

  while (resto.length > 0) {
    let pedaco;
    if (reabrir.length + resto.length <= max) {
      pedaco = resto;
      resto = '';
    } else {
      const limite = max - reabrir.length - 4; // 4 = espaço pra fechar ``` se precisar
      let corte = resto.lastIndexOf('\n\n', limite);
      if (corte < limite * 0.4) corte = resto.lastIndexOf('\n', limite);
      if (corte < limite * 0.4) corte = resto.lastIndexOf(' ', limite);
      if (corte < limite * 0.4) corte = limite;
      pedaco = resto.slice(0, corte);
      resto = resto.slice(corte).replace(/^\s+/, '');
    }

    pedaco = reabrir + pedaco;
    reabrir = '';
    const cercas = (pedaco.match(/```/g) || []).length;
    if (cercas % 2 === 1 && resto.length > 0) {
      pedaco += '\n```';
      reabrir = '```\n';
    }
    blocos.push(pedaco);
  }
  return blocos;
}

/** Quantos tokens de saída vale a pena pedir: mensagem curta = resposta curta (economiza cota + parece mais natural). */
export function escolherMaxTokens(pergunta) {
  const t = String(pergunta ?? '').trim();
  if (/explic|detalh|passo a passo|tutorial|c[oó]digo|script|lista|resum|traduz|como (fazer|funciona|usar)/i.test(t)) return 750;
  // cumprimentos / mensagens muito curtas → resposta bem curta
  if (t.length <= 25 || /^(oi|oii+|ola|olá|eai|e a[ií]|fala|salve|hey|hi|hello|bom dia|boa tarde|boa noite)\b/i.test(t)) return 120;
  if (t.length <= 50 && !/\?/.test(t)) return 200;
  if (t.length <= 120) return 320;
  if (t.length <= 300) return 480;
  return 650;
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cria o detector de "falaram comigo": o nome no começo da frase ("zoe, tudo bem?", "e aí zoe")
 * em qualquer posição da mensagem, além de menções e respostas ao bot.
 */
export function criarGatilhoPorNome(nomes) {
  const lista = nomes.map((n) => String(n).trim()).filter(Boolean);
  if (!lista.length) return () => false;
  const alt = lista.map(escapar).join('|');
  // Aciona em qualquer posição, sem diferenciar maiúsculas/minúsculas,
  // mas não combina com nomes dentro de palavras maiores.
  const nomeEmQualquerLugar = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'iu');
  return (texto) => nomeEmQualquerLugar.test(String(texto ?? ''));
}

/** Corta o texto no limite, sem estourar o prompt. */
export function cortar(texto, max) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Personalidade: funções puras que ajudam a "ler o clima" da conversa.
// ---------------------------------------------------------------------------

const L = '\\p{L}'; // letra unicode (\b do JS não funciona direito com acento)
const palavraInteira = (alt) => `(?<![${L}\\p{N}_])(?:${alt})(?![${L}\\p{N}_])`;

// Assuntos em que NÃO cabe piada nem palavrão: a pessoa pode estar mal de verdade.
const REGEX_SERIO = new RegExp(
  [
    'suic[ií]d', 'quero morrer', 'vou me matar', 'me matar', 'me cortar', 'automutila',
    'n[ãa]o aguento mais', 'n[ãa]o quero mais viver', 'acabar com tudo', 'depress', 'p[âa]nico',
    'faleceu', 'morreu (meu|minha|o|a) ', 'perdi (meu|minha) (pai|m[ãa]e|filh|irm|av[ôo]|amig)',
    'estupr', 'abus(ou|aram|o sexual)', 'viol[êe]ncia dom[ée]stica', 'me bate', 'me batem',
    't[oô] sofrendo', 'to sofrendo', 'estou sofrendo', 'me sinto (muito )?(sozinh|mal|vazi)',
    'ningu[ée]m (se importa|liga) comigo', 'crise de ansiedade', 'ataque de p[âa]nico',
  ].join('|') + `|${palavraInteira('luto')}`,
  'iu',
);

/** A mensagem parece de alguém passando por algo sério (tristeza forte, perda, risco)? */
export function detectarSeriedade(texto) {
  return REGEX_SERIO.test(String(texto ?? ''));
}

const REGEX_PALAVROES = new RegExp(
  palavraInteira('porra|caralho|merda|puta|pqp|fdp|foda|foder|fodido|cacete|bosta|desgra[çc]a|arrombad[oa]|buceta|cu'),
  'giu',
);

/** Quantos palavrões o texto tem (usado pra dar uma folga quando a Zoe já xingou demais). */
export function contarPalavroes(texto) {
  return (String(texto ?? '').match(REGEX_PALAVROES) || []).length;
}

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const palavrasDe = (s) => new Set(semAcento(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/**
 * A pessoa está repetindo (quase) a mesma coisa que já falou? Compara com as falas anteriores dela
 * (`historico` = [{ role, text }]) por sobreposição de palavras. Serve pra "paciência" de verdade,
 * em vez de chamar qualquer pergunta de burra.
 */
export function ehRepeticao(pergunta, historico = []) {
  const atual = palavrasDe(pergunta);
  if (atual.size < 2) return false;
  for (const turno of historico) {
    if (turno?.role !== 'user') continue;
    const antes = palavrasDe(turno.text);
    if (antes.size < 2) continue;
    let comum = 0;
    for (const w of atual) if (antes.has(w)) comum++;
    const uniao = atual.size + antes.size - comum;
    if (uniao > 0 && comum / uniao >= 0.6) return true;
  }
  return false;
}

/** 0-23 → 'madrugada' | 'manha' | 'tarde' | 'noite' */
export function periodoDoDia(hora) {
  const h = ((Number(hora) % 24) + 24) % 24;
  if (h < 6) return 'madrugada';
  if (h < 12) return 'manha';
  if (h < 18) return 'tarde';
  return 'noite';
}

export const HUMORES = [
  'zoeira solta: tudo vira piada, brinca com o que a pessoa acabou de dizer',
  'seca e debochada: resposta curta, ironia fria, cara de quem não tá nem aí (mas ajuda)',
  'animada demais: energia lá em cima, reage exagerado, caos bom',
  'preguiçosa: reclama de sono/preguiça, mas responde mesmo assim',
  'sarcástica de carreira: elogio falso, ironia bem elaborada',
  'parceira de resenha: de boa, tipo amiga que tá junto na bagunça',
];

/** Escolhe um humor de forma estável pro mesmo `seed` (mesma conversa = mesmo humor por um tempo). */
export function escolherHumor(seed) {
  let h = 2166136261;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return HUMORES[h % HUMORES.length];
}
