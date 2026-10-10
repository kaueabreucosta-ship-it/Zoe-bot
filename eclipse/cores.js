/**
 * Paleta de cores e helpers visuais padrão do bot.
 * Centraliza CORES e um rodapé padrão pra manter a identidade visual
 * consistente em TODOS os módulos.
 *
 * Regra: nenhum arquivo deve ter hex de cor "solto" num .setColor(...) —
 * sempre importar CORES daqui.
 *
 * Tema: preto + roxo.
 */

// Paleta base (use estes nomes se precisar de uma cor nova)
export const ROXO = {
  principal: '#8A2BE2', // roxo vivo (identidade)
  claro: '#B57BFF', // destaque / sucesso
  suave: '#D4B5FF', // textos e detalhes claros
  escuro: '#4B1B7A', // barras discretas
  profundo: '#1B0B2E', // quase preto com fundo roxo
  preto: '#0B0714', // fundo
};

export const CORES = {
  // estados gerais
  sucesso: ROXO.claro, // confirmar/sucesso: roxo claro
  alerta: '#E5395B', // rosa-avermelhado: chama atenção sem sair do tema
  erro: '#E5395B', // alias de 'alerta' — mantido pra clareza semântica
  aviso: '#FF6FA5', // rosa claro, pra diferenciar de erro/alerta
  info: ROXO.profundo, // neutro "de marca" pra embeds informativos
  neutro: ROXO.preto,

  // identidade / destaque
  master: ROXO.principal, // comandos exclusivos do Owner / IA
  destaque: ROXO.suave,

  // moderação (alertas e resoluções)
  moderacaoAlerta: '#E5395B',
  moderacaoBan: '#9B1B4B', // vinho: ação mais grave (ban)
  moderacaoMute: '#FF6FA5',
  moderacaoOk: ROXO.claro,

  // sistemas específicos
  ticket: ROXO.escuro,
  ticketFechado: '#E5395B',
  xp: ROXO.suave,
  sorteio: ROXO.principal,
  lockdown: '#9B1B4B',
  antidiv: '#E5395B',
};

// Nome exibido nos rodapés e usado pela IA. Troque com BOT_NOME no ambiente (ex.: BOT_NOME=Zoe).
export const MARCA = {
  nome: (process.env.BOT_NOME || 'Eclipse').trim() || 'Eclipse',
  emoji: '🤖',
};

/** Rodapé padrão: "<Nome>" ou "<Nome> • <contexto>" */
export function rodapePadrao(contexto) {
  return { text: contexto ? `${MARCA.nome} • ${contexto}` : MARCA.nome };
}
