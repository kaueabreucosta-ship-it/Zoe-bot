import test from 'node:test';
import assert from 'node:assert/strict';
import { temLink, cargoPrivilegiado, podeMandarLink } from './antilink-core.js';

test('temLink: pega link de verdade', () => {
  for (const t of [
    'olha isso https://exemplo.com/abc',
    'entra no discord.gg/abc123',
    'discord . gg / abc',
    'discord[.]gg/abc',
    'www.site.com',
    'minha loja: loja.com.br/promo',
    'youtu.be/xyz',
    'ｈｔｔｐｓ://exemplo.com', // letras de largura total
    'disc\u200Bord.gg/abc', // caractere invisível no meio
  ]) assert.equal(temLink(t), true, t);
});

test('temLink: não confunde conversa normal com link', () => {
  for (const t of [
    'oi tudo bem?',
    'ex.: isso aqui',
    'fui.kkk',
    'versão 1.5.2 saiu',
    'manda no email joao@gmail.com',
    'foto.png e script.js',
    '',
    null,
  ]) assert.equal(temLink(t), false, String(t));
});

test('cargoPrivilegiado: compara palavra inteira, sem acento e com letra fantasia', () => {
  for (const n of ['Moderador', '⚡ 𝐌𝐨𝐝𝐞𝐫𝐚𝐝𝐨𝐫', 'OWNER', 'Dono', 'Co-Owner', 'Moderação', 'Mod']) assert.equal(cargoPrivilegiado(n), true, n);
  for (const n of ['Membro', 'Modelo', '@everyone', 'Staff', 'VIP', '']) assert.equal(cargoPrivilegiado(n), false, n);
});

test('podeMandarLink: dono, cargo por ID e cargo por nome passam; o resto não', () => {
  const base = { ownerId: '1', guildOwnerId: '2', idsLiberados: ['900'] };
  assert.equal(podeMandarLink({ ...base, userId: '1' }), true);
  assert.equal(podeMandarLink({ ...base, userId: '2' }), true);
  assert.equal(podeMandarLink({ ...base, userId: '3', cargos: [{ id: '900', name: 'Qualquer' }] }), true);
  assert.equal(podeMandarLink({ ...base, userId: '3', cargos: [{ id: '5', name: 'Moderador' }] }), true);
  assert.equal(podeMandarLink({ ...base, userId: '3', cargos: [{ id: '5', name: 'Membro' }, { id: '6', name: '@everyone' }] }), false);
  assert.equal(podeMandarLink({ ...base, userId: '3' }), false);
});
