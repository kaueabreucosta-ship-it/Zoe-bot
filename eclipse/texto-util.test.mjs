import test from 'node:test';
import assert from 'node:assert/strict';
import {
  limparTexto, fatiarTexto, escolherMaxTokens, criarGatilhoPorNome, cortar,
  detectarSeriedade, contarPalavroes, ehRepeticao, periodoDoDia, escolherHumor, HUMORES,
} from './texto-util.js';

test('limparTexto remove raciocínio vazado, prefixo e @everyone', () => {
  assert.equal(limparTexto('<think>hmm</think>Oi!'), 'Oi!');
  assert.equal(limparTexto('<think>nunca fecha'), '');
  assert.equal(limparTexto('Eclipse: fala tu', { nomes: ['Eclipse'] }), 'fala tu');
  assert.equal(limparTexto('**Zoe:** oi', { nomes: ['Zoe'] }), 'oi');
  assert.ok(!/@everyone/.test(limparTexto('oi @everyone e @here')));
  assert.equal(limparTexto('a\n\n\n\nb'), 'a\n\nb');
});

test('fatiarTexto respeita limite e não corta palavra', () => {
  const texto = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(' ');
  const blocos = fatiarTexto(texto, 500);
  assert.ok(blocos.length > 1);
  for (const b of blocos) assert.ok(b.length <= 500, `bloco com ${b.length}`);
  assert.equal(blocos.join(' ').replace(/\s+/g, ' '), texto);
  assert.deepEqual(fatiarTexto(''), []);
  assert.deepEqual(fatiarTexto('oi'), ['oi']);
});

test('fatiarTexto fecha e reabre bloco de código cortado', () => {
  const codigo = '```js\n' + Array.from({ length: 200 }, (_, i) => `linha${i}();`).join('\n') + '\n```';
  const blocos = fatiarTexto(codigo, 400);
  assert.ok(blocos.length > 1);
  for (const b of blocos) {
    assert.ok(b.length <= 400);
    assert.equal((b.match(/```/g) || []).length % 2, 0, 'cerca desbalanceada');
  }
});

test('escolherMaxTokens', () => {
  assert.equal(escolherMaxTokens('oi'), 120);
  assert.equal(escolherMaxTokens('me explica como funciona isso'), 750);
  assert.equal(escolherMaxTokens('qual a diferença entre cachorro e gato?'), 320);
  assert.equal(escolherMaxTokens('x'.repeat(300)), 480);
});

test('criarGatilhoPorNome', () => {
  const g = criarGatilhoPorNome(['zoe', 'eclipse']);
  assert.ok(g('zoe, tudo bem?'));
  assert.ok(g('e aí Zoe'));
  assert.ok(g('Eclipse me ajuda'));
  assert.ok(g('valeu zoe'));
  assert.ok(g('a eclipse solar de ontem foi muito bonita')); // nome em qualquer posição
  assert.ok(!g('zoeira total'));
  assert.ok(!g('nada a ver'));
  assert.ok(!criarGatilhoPorNome([])('zoe'));
});

test('cortar', () => {
  assert.equal(cortar('a   b\n c', 50), 'a b c');
  assert.equal(cortar('abcdefghij', 5), 'abcd…');
});

test('detectarSeriedade pega assunto pesado e ignora papo normal', () => {
  assert.ok(detectarSeriedade('tô pensando em me matar'));
  assert.ok(detectarSeriedade('Perdi minha mãe semana passada'));
  assert.ok(detectarSeriedade('estou de luto'));
  assert.ok(detectarSeriedade('não aguento mais isso tudo'));
  assert.ok(!detectarSeriedade('esse boss me matou umas 10 vezes kkk')); // "matou" não é "me matar"
  assert.ok(!detectarSeriedade('qual o melhor jogo de luta?'));
  assert.ok(!detectarSeriedade('oi zoe'));
});

test('contarPalavroes', () => {
  assert.equal(contarPalavroes('porra, que merda é essa'), 2);
  assert.equal(contarPalavroes('Puta que pariu'), 1);
  assert.equal(contarPalavroes('computador culto'), 0); // "cu" dentro de palavra não conta
  assert.equal(contarPalavroes(''), 0);
});

test('ehRepeticao', () => {
  const hist = [
    { role: 'user', text: 'como eu entro no servidor de verificação?' },
    { role: 'assistant', text: 'pelo site, ué' },
  ];
  assert.ok(ehRepeticao('como entro no servidor de verificação', hist));
  assert.ok(!ehRepeticao('qual a capital da França?', hist));
  assert.ok(!ehRepeticao('oi', hist));
  assert.ok(!ehRepeticao('como eu entro no servidor de verificação?', []));
});

test('periodoDoDia', () => {
  assert.equal(periodoDoDia(3), 'madrugada');
  assert.equal(periodoDoDia(9), 'manha');
  assert.equal(periodoDoDia(15), 'tarde');
  assert.equal(periodoDoDia(22), 'noite');
  assert.equal(periodoDoDia(24), 'madrugada');
});

test('escolherHumor é estável e válido', () => {
  const a = escolherHumor('guild:canal:user:1');
  assert.equal(a, escolherHumor('guild:canal:user:1'));
  assert.ok(HUMORES.includes(a));
  const variados = new Set(Array.from({ length: 60 }, (_, i) => escolherHumor(`seed-${i}`)));
  assert.ok(variados.size >= 3, 'deveria variar entre seeds');
});
