// Regras puras do cassino (sem dependências), fáceis de testar e ajustar.
import { randomInt } from 'crypto';

// Peso (soma 100) e multiplicador da trinca de cada símbolo.
export const SIMBOLOS = [
  { s: '🍒', peso: 40, trinca: 4 },
  { s: '🍋', peso: 30, trinca: 6 },
  { s: '🔔', peso: 18, trinca: 12 },
  { s: '💎', peso: 9, trinca: 30 },
  { s: '7️⃣', peso: 3, trinca: 100 },
];

function sortearSimbolo() {
  let n = randomInt(100);
  for (const x of SIMBOLOS) {
    if (n < x.peso) return x;
    n -= x.peso;
  }
  return SIMBOLOS[0];
}

export const girarRolos = () => [sortearSimbolo(), sortearSimbolo(), sortearSimbolo()];

// Multiplicador do prêmio: 0 = perdeu, 1 = recupera a aposta.
// Trinca paga o valor do símbolo; par paga 1x (exceto par de 🍋, que não paga).
export function multiplicadorSlots(rolos) {
  const [a, b, c] = rolos;
  const igualTres = a.s === b.s && b.s === c.s;
  if (igualTres) return a.trinca;
  const emPar = [a, b, c].find((x) => [a, b, c].filter((y) => y.s === x.s).length === 2);
  if (emPar && emPar.s !== '🍋') return 1;
  return 0;
}

// Cara ou coroa: acerto devolve 1,9x (a casa fica com 5% de vantagem).
export const MULT_MOEDA = 1.9;
export const premioMoeda = (aposta) => Math.floor(aposta * MULT_MOEDA);

// ===== Botão "girar de novo" =====
// Cada clique sobe o nível (2x, 3x, ...): o prêmio é multiplicado pelo nível,
// mas a chance de o giro pagar cai pra 1/nível. Assim o prêmio cresce e ganhar fica mais difícil,
// mantendo a mesma vantagem da casa em todos os níveis.
export const NIVEL_MAX = 10;
export const chancePremio = (nivel) => 1 / nivel;

export function girarRolosNivel(nivel = 1) {
  let rolos = girarRolos();
  const segura = nivel <= 1 || randomInt(10000) < Math.floor(10000 * chancePremio(nivel));
  if (!segura) {
    // Giro "azarado": sorteia de novo até não pagar nada.
    for (let i = 0; i < 200 && multiplicadorSlots(rolos) > 0; i++) rolos = girarRolos();
  }
  return rolos;
}

// ===== Tigrinho =====
// Aposta X: perdeu = perde X; ganhou = recebe 2X de volta (lucro de X, ou seja, a aposta dobra).
// 45% de chance de ganhar x 2 = 90% de retorno: a casa fica com 10% a longo prazo.
export const TIGRINHO_CHANCE = 0.45;
export const TIGRINHO_MULT = 2;
export const SIMBOLOS_TIGRINHO = ['🐯', '🍒', '🔔', '💎', '7️⃣', '🍀'];

// O resultado (ganhou ou não) é sorteado primeiro e os rolos mostram exatamente isso:
// ganhou = trinca de símbolos iguais; perdeu = nunca uma trinca.
export function girarTigrinho() {
  const ganhou = randomInt(10000) < Math.floor(10000 * TIGRINHO_CHANCE);
  const sym = () => SIMBOLOS_TIGRINHO[randomInt(SIMBOLOS_TIGRINHO.length)];
  if (ganhou) {
    const s = sym();
    return { ganhou, rolos: [s, s, s] };
  }
  let r;
  do r = [sym(), sym(), sym()];
  while (r[0] === r[1] && r[1] === r[2]);
  return { ganhou, rolos: r };
}
