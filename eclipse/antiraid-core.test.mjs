// Rode com: npm test   (usa o test runner do próprio Node, não precisa instalar nada)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarNome, mesclarConfig, avaliarEntrada, analisarMensagemNovato,
  registrarSinal, decidirAcao, PADRAO_ANTIRAID,
} from './antiraid-core.js';

const cfg = mesclarConfig({});
const T0 = 1_000_000_000_000;

test('normalizarNome tira número e símbolo', () => {
  assert.equal(normalizarNome('Kaue_123'), 'kaue');
  assert.equal(normalizarNome('joao.456'), 'joao');
  assert.equal(normalizarNome(''), '');
  assert.equal(normalizarNome(null), '');
});

test('5 entradas em 10s NÃO é raid (limite 6)', () => {
  const h = [];
  let r;
  for (let i = 0; i < 5; i++) r = avaliarEntrada(h, { id: `u${i}`, nome: `pessoa${'abcde'[i]}x${i}` }, cfg, T0 + i * 1000);
  assert.equal(r.gatilho, null);
});

test('6 entradas em 10s É raid e devolve os 6 ids', () => {
  const h = [];
  let r;
  for (let i = 0; i < 6; i++) r = avaliarEntrada(h, { id: `u${i}`, nome: `zzz${i}` + 'abcdef'[i] }, cfg, T0 + i * 1000);
  assert.equal(r.gatilho.tipo, 'enxurrada');
  assert.equal(r.janela.length, 6);
});

test('6 entradas espalhadas em 60s NÃO é raid (servidor movimentado normal)', () => {
  const h = [];
  let r;
  for (let i = 0; i < 6; i++) r = avaliarEntrada(h, { id: `u${i}`, nome: `nome${'abcdef'[i]}${'ghijkl'[i]}` }, cfg, T0 + i * 12_000);
  assert.equal(r.gatilho, null);
});

test('nomes parecidos (joao1, joao2...) disparam mesmo devagar', () => {
  const h = [];
  let r;
  for (let i = 0; i < 4; i++) r = avaliarEntrada(h, { id: `u${i}`, nome: `joao${i}${i}` }, cfg, T0 + i * 6_000);
  assert.equal(r.gatilho?.tipo, 'nomes_parecidos');
  assert.equal(r.janela.length, 4);
});

test('nomes diferentes devagar não disparam', () => {
  const h = [];
  const nomes = ['maria', 'pedro', 'lucas', 'ana', 'bruno'];
  let r;
  nomes.forEach((n, i) => (r = avaliarEntrada(h, { id: `u${i}`, nome: n }, cfg, T0 + i * 6_000)));
  assert.equal(r.gatilho, null);
});

test('histórico velho é podado (não cresce pra sempre)', () => {
  const h = [];
  for (let i = 0; i < 300; i++) avaliarEntrada(h, { id: `u${i}`, nome: `x${i}` }, cfg, T0 + i * 60_000);
  assert.ok(h.length <= 5, `histórico ficou com ${h.length}`);
});

test('mensagem de novato: convite, @everyone e muitas menções', () => {
  const min = 60_000;
  assert.match(analisarMensagemNovato({ conteudo: 'entra aqui discord.gg/abc123', entrouHaMs: 2 * min }), /convite/);
  assert.match(analisarMensagemNovato({ conteudo: 'https://discord.com/invite/xyz', entrouHaMs: 1 * min }), /convite/);
  assert.match(analisarMensagemNovato({ conteudo: '@everyone olha', entrouHaMs: min }), /everyone/);
  assert.match(analisarMensagemNovato({ conteudo: 'oi', mencoesUsuarios: 6, entrouHaMs: min }), /menções/);
});

test('mensagem normal ou de membro antigo NÃO é barrada', () => {
  const min = 60_000;
  assert.equal(analisarMensagemNovato({ conteudo: 'oi gente, tudo bem?', entrouHaMs: min }), null);
  assert.equal(analisarMensagemNovato({ conteudo: 'discord.gg/abc', entrouHaMs: 30 * min }), null);
  assert.equal(analisarMensagemNovato({ conteudo: 'oi', mencoesUsuarios: 2, entrouHaMs: min }), null);
  assert.equal(analisarMensagemNovato({ conteudo: 'discord.gg/abc' }), null); // sem entrouHaMs
});

test('sinais: o MESMO novato repetindo não conta como 3', () => {
  const s = [];
  assert.equal(registrarSinal(s, 'a', cfg, T0), 1);
  assert.equal(registrarSinal(s, 'a', cfg, T0 + 1000), 1);
  assert.equal(registrarSinal(s, 'b', cfg, T0 + 2000), 2);
  assert.equal(registrarSinal(s, 'c', cfg, T0 + 3000), 3);
});

test('decidirAcao: raid usa a ação configurada; sem raid só idade e só timeout', () => {
  const c1 = mesclarConfig({ acao: 'ban' });
  assert.equal(decidirAcao({ raidAtivo: true, idadeDias: 100, cfg: c1 }), 'ban');
  assert.equal(decidirAcao({ raidAtivo: false, idadeDias: 0.1, cfg: c1 }), 'nenhuma'); // idade desligada
  const c2 = mesclarConfig({ acao: 'ban', idade_min_dias: 3 });
  assert.equal(decidirAcao({ raidAtivo: false, idadeDias: 1, cfg: c2 }), 'timeout'); // nunca ban só por idade
  assert.equal(decidirAcao({ raidAtivo: false, idadeDias: 10, cfg: c2 }), 'nenhuma');
  const c3 = mesclarConfig({ acao: 'alertar', idade_min_dias: 3 });
  assert.equal(decidirAcao({ raidAtivo: false, idadeDias: 1, cfg: c3 }), 'alertar');
});

test('mesclarConfig conserta valores malucos', () => {
  const c = mesclarConfig({ limite: 9999, janela_seg: -5, acao: 'explodir', duracao_min: 0, idade_min_dias: -3 });
  assert.equal(c.limite, 50);
  assert.equal(c.janela_seg, 3);
  assert.equal(c.acao, PADRAO_ANTIRAID.acao);
  assert.ok(c.duracao_min >= 1);
  assert.equal(c.idade_min_dias, 0);
});
