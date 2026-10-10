/**
 * Anti-link — CÉREBRO (lógica pura, sem discord.js, sem banco).
 * Separado de propósito: dá pra testar com `npm test` sem Discord nenhum.
 *
 *  - temLink(texto)           -> a mensagem tem link?
 *  - cargoPrivilegiado(nome)  -> esse cargo é de moderador/owner?
 *  - podeMandarLink({...})    -> essa pessoa pode mandar link?
 */

// Domínios "soltos" (sem http) que contam como link. Os de 2 letras mais comuns em typo ("ok.me") ficam de fora.
const TLDS = 'com|net|org|gg|io|xyz|link|app|dev|tv|ly|gl|info|site|online|store|shop|club|top|vip|ru';
const ENCURTADORES = 'youtu\\.be|t\\.me|wa\\.me|bit\\.ly|is\\.gd|cutt\\.ly|tinyurl\\.com';

const REGEXES = [
  /\b(?:https?|ftp):\/\/\S+/i, // http://... https://...
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i, // www.site.com
  /\b(?:discord|dsc)\s*\.\s*gg\b/i, // "discord . gg" com espaço
  new RegExp(`(?<![a-z0-9@.-])(?:${ENCURTADORES})(?![a-z0-9-])`, 'i'),
  // site.com, loja.com.br/x, algo.gg/abc (e-mail não conta: o "@" antes barra)
  new RegExp(`(?<![a-z0-9@.-])(?:[a-z0-9-]+\\.)+(?:${TLDS})(?![a-z0-9-])`, 'i'),
];

/** Limpa truques comuns: letras "fantasia", caracteres invisíveis e "[.]" / "(dot)". */
function limpar(texto) {
  return String(texto || '')
    .normalize('NFKC') // ｈｔｔｐｓ e 𝐡𝐭𝐭𝐩𝐬 viram https
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '') // zero-width e hífen invisível
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\(\s*dot\s*\)|\[\s*dot\s*\]/gi, '.');
}

/** true se o texto tem qualquer link. */
export function temLink(texto) {
  const t = limpar(texto);
  if (!t) return false;
  return REGEXES.some((re) => re.test(t));
}

const PALAVRAS_PRIVILEGIADAS = new Set([
  'moderador', 'moderadores', 'moderadora', 'moderadoras', 'moderacao', 'moderator', 'mod', 'mods',
  'owner', 'dono', 'dona',
]);

/** "⚡ 𝐌𝐨𝐝𝐞𝐫𝐚𝐝𝐨𝐫" -> true, "Co-Owner" -> true, "Modelo" -> false (compara palavra inteira). */
export function cargoPrivilegiado(nome) {
  const palavras = String(nome || '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // tira acentos
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return palavras.some((p) => PALAVRAS_PRIVILEGIADAS.has(p));
}

/**
 * Pode mandar link?
 *  - dono do bot (ownerId) e dono do servidor: sempre
 *  - cargo cujo ID está em idsLiberados (OWNER_ROLE_ID / MOD_ROLE_ID): sempre
 *  - cargo cujo NOME é moderador/owner: sempre
 * @param cargos  [{ id, name }]
 */
export function podeMandarLink({ userId, ownerId, guildOwnerId, cargos = [], idsLiberados = [] }) {
  if (userId && (userId === ownerId || userId === guildOwnerId)) return true;
  return cargos.some((c) => idsLiberados.includes(c.id) || cargoPrivilegiado(c.name));
}
