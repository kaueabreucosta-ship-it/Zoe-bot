import test from 'node:test';
import assert from 'node:assert/strict';
import { capturar, resumoDe, montarArvore, restaurar } from './backup.js';

test('backup: captura e restauração aditiva', async () => {
const col = (arr) => { const m = new Map(arr.map((x) => [x.id, x])); m.find = (f) => arr.find(f); m.some = (f) => arr.some(f); m.values = () => arr[Symbol.iterator](); return m; };
const bits = (n) => ({ bitfield: BigInt(n) });

const origem = {
  id: 'G1', name: 'Origem', description: null, preferredLocale: 'pt-BR', verificationLevel: 1, explicitContentFilter: 2,
  defaultMessageNotifications: 1, afkTimeout: 300, memberCount: 42, iconURL: () => null,
  roles: { fetch: async () => {}, cache: col([
    { id: 'G1', name: '@everyone', managed: false, position: 0, color: 0, hoist: false, mentionable: false, permissions: bits(1024) },
    { id: 'R1', name: 'Admin', managed: false, position: 5, color: 255, hoist: true, mentionable: false, permissions: bits(8) },
    { id: 'R2', name: 'Membro', managed: false, position: 2, color: 0, hoist: false, mentionable: true, permissions: bits(1024 | 2048) },
    { id: 'R3', name: 'SomeBot', managed: true, position: 3, color: 0, hoist: false, mentionable: false, permissions: bits(8) },
  ]) },
  channels: { fetch: async () => {}, cache: col([
    { id: 'C1', name: 'Geral', type: 4, parentId: null, rawPosition: 0, permissionOverwrites: { cache: col([{ id: 'G1', type: 0, allow: bits(0), deny: bits(1024) }, { id: 'R2', type: 0, allow: bits(1024), deny: bits(0) }, { id: 'U9', type: 1, allow: bits(1), deny: bits(0) }]) } },
    { id: 'C2', name: 'chat', type: 0, parentId: 'C1', rawPosition: 0, topic: 'papo', nsfw: false, rateLimitPerUser: 5, permissionOverwrites: { cache: col([]) } },
    { id: 'C3', name: 'voz', type: 2, parentId: 'C1', rawPosition: 1, bitrate: 128000, userLimit: 10, permissionOverwrites: { cache: col([]) } },
    { id: 'C4', name: 'avisos', type: 5, parentId: null, rawPosition: 1, topic: 'novidades', permissionOverwrites: { cache: col([]) } },
    { id: 'T1', name: 'uma-thread', type: 11, parentId: 'C2', rawPosition: 0 },
  ]) },
  emojis: { fetch: async () => {}, cache: col([{ id: 'E1', name: 'pog', animated: false, imageURL: () => 'https://cdn/pog.png' }]) },
};

const dados = await capturar(origem);
assert.equal(dados.cargos.length, 2, 'sem @everyone e sem cargo de bot');
assert.deepEqual(dados.cargos.map((c) => c.nome), ['Admin', 'Membro'], 'do mais alto pro mais baixo');
assert.equal(dados.canais.length, 4, 'thread fica de fora');
assert.equal(dados.canais[0].permissoes.length, 2, 'overwrite de membro fica de fora');
JSON.stringify(dados); // serializável (BigInt virou string)
assert.deepEqual(resumoDe(dados), { cargos: 2, categorias: 1, canais: 3, emojis: 1, membros: 42 });
assert.ok(montarArvore(dados).includes('GERAL'));

const criados = { roles: [], channels: [], emojis: [] };
let seq = 0;
const BOTBITS = 1024n | 2048n | 16n | 268435456n;
const destRoles = [{ id: 'G2', name: '@everyone', managed: false }, { id: 'X1', name: 'Membro', managed: false }];
const destChannels = [];
const destino = {
  id: 'G2', name: 'Destino', maximumBitrate: 96000,
  members: { me: { permissions: { has: (p) => p !== 8n, bitfield: BOTBITS } } },
  roles: { fetch: async () => {}, cache: col(destRoles), create: async (o) => { const r = { id: `NR${++seq}`, name: o.name, managed: false, opts: o }; destRoles.push(r); criados.roles.push(r); return r; } },
  channels: { fetch: async () => {}, cache: col(destChannels), create: async (o) => {
    if (o.type === 5) throw new Error('Comunidade não habilitada');
    const c = { id: `NC${++seq}`, name: o.name, type: o.type, parentId: o.parent ?? null, opts: o }; destChannels.push(c); criados.channels.push(c); return c; } },
  emojis: { fetch: async () => {}, cache: col([]), create: async (o) => { criados.emojis.push(o); } },
};

const rel = await restaurar(destino, dados, { emojis: true, motivo: 'teste' });
assert.equal(rel.cargosCriados, 1); assert.equal(rel.cargosExistentes, 1, '"Membro" já existia: reaproveita');
assert.equal(criados.roles[0].opts.permissions, 8n & BOTBITS, 'permissões limitadas ao que o bot tem');
assert.equal(rel.categoriasCriadas, 1);
assert.equal(rel.canaisCriados, 3, 'chat, voz e avisos (anúncio caiu pra texto)');
const cat = criados.channels.find((c) => c.name === 'Geral');
const chat = criados.channels.find((c) => c.name === 'chat');
assert.equal(chat.parentId, cat.id, 'canal volta pra categoria nova');
assert.equal(chat.opts.topic, 'papo'); assert.equal(chat.opts.rateLimitPerUser, 5);
assert.equal(criados.channels.find((c) => c.name === 'voz').opts.bitrate, 96000, 'bitrate limitado ao máximo do servidor');
assert.equal(criados.channels.find((c) => c.name === 'avisos').type, 0, 'anúncio → texto');
assert.deepEqual(cat.opts.permissionOverwrites.map((o) => o.id).sort(), ['G2', 'X1'], '@everyone antigo→novo; Membro→existente; membro específico ignorado');
assert.equal(criados.emojis.length, 1);

const rel2 = await restaurar(destino, dados, { emojis: false });
assert.equal(rel2.cargosCriados, 0); assert.equal(rel2.categoriasCriadas + rel2.canaisCriados, 0, 'segunda rodada não duplica nada');

});

