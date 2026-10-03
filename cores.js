/**
 * Paleta de cores e helpers visuais padrão do Zoe.
 * Centraliza CORES e um rodapé/timestamp padrão pra manter a identidade visual
 * consistente em TODOS os módulos (index.js, moderation.js,
 * tickets.js, embeds.js, context.js, lockdown.js, antidivulgacao.js).
 *
 * Regra: nenhum arquivo deve ter hex de cor "solto" num .setColor(...) —
 * sempre importar CORES daqui.
 *
 * Tema: preto / branco / vermelho.
 */
export const CORES = {
  // estados gerais
  sucesso: '#FFFFFF', // branco puro pra confirmar/sucesso — contraste forte com o resto
  alerta: '#E01E2B',
  erro: '#E01E2B', // alias de 'alerta' (mesmo vermelho) — mantido pra clareza semântica em código de erro/falha
  aviso: '#FF4655', // vermelho mais claro, pra diferenciar de erro/alerta sem sair do tema
  info: '#1A1A1A', // quase preto — cor neutra "de marca" pra embeds informativos
  neutro: '#0D0D0D',

  // identidade / destaque
  master: '#E01E2B', // comandos exclusivos do Owner / IA
  destaque: '#FFFFFF',

  // moderação (alertas e resoluções)
  moderacaoAlerta: '#E01E2B',
  moderacaoBan: '#8C1017', // vermelho escuro/sangue pra ação mais grave (ban)
  moderacaoMute: '#FF4655',
  moderacaoOk: '#FFFFFF',

  // sistemas específicos
  ticket: '#1A1A1A',
  ticketFechado: '#E01E2B',
  xp: '#FFFFFF',
  sorteio: '#E01E2B',
  lockdown: '#8C1017',
  antidiv: '#E01E2B',
};

export const MARCA = {
  nome: 'Zoe',
  emoji: '🤖',
};

/** Rodapé padrão: "Zoe" ou "Zoe • <contexto>" */
export function rodapePadrao(contexto) {
  return { text: contexto ? `${MARCA.nome} • ${contexto}` : MARCA.nome };
}

