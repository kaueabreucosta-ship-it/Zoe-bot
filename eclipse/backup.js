/**
 * Backup de servidor — /backup criar | listar | info | restaurar | excluir
 *
 * O que é salvo (no Supabase, tabela `server_backups`, ver backup.sql):
 *   • cargos (nome, cor, permissões, hoist, mencionável, posição)
 *   • categorias e canais (texto, voz, anúncio, palco, fórum, mídia) com tópico, slowmode, NSFW, bitrate,
 *     limite de usuários e as permissões por cargo de cada canal
 *   • emojis (nome + link da imagem)
 *   • dados gerais do servidor (nome, descrição, verificação...) — só pra consulta
 *
 * O que NÃO é salvo: mensagens, membros e os cargos de cada membro, bots/integrações, webhooks, convites,
 * stickers, eventos e permissões específicas de membros num canal.
 *
 * Restauração é ADITIVA e segura: só cria o que ainda não existe (compara por nome), nunca apaga nem altera
 * nada que já está no servidor. Dá pra restaurar um backup num servidor novo (migração).
 *
 * SÓ o dono do bot (OWNER_ID) usa — o comando aparece só para administradores, mas quem não é o dono recebe
 * uma recusa. Apagar/restaurar pede confirmação por botão.
 */
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  OverwriteType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';
import { cortar } from './texto-util.js';

const VERSAO_FORMATO = 1;
const MAX_BACKUPS_POR_SERVIDOR = 10;
const MAX_BYTES_BACKUP = 4_000_000; // limite de segurança do JSON salvo
const MAX_EMOJIS_RESTAURAR = 50;
const FUSO = (process.env.BOT_TZ || 'America/Sao_Paulo').trim();

const TIPOS_TEXTO = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ...(ChannelType.GuildMedia !== undefined ? [ChannelType.GuildMedia] : []),
]);
const TIPOS_VOZ = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
// Canal de anúncios vira texto comum em servidor sem Comunidade; na checagem de "já existe" valem como o mesmo tipo.
const mesmoTipo = (a, b) =>
  a === b || ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(a) && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(b));
const TIPOS_SUPORTADOS = new Set([ChannelType.GuildCategory, ...TIPOS_TEXTO, ...TIPOS_VOZ]);

const ICONE = {
  [ChannelType.GuildText]: '#',
  [ChannelType.GuildVoice]: '🔊',
  [ChannelType.GuildAnnouncement]: '📢',
  [ChannelType.GuildStageVoice]: '🎙️',
  [ChannelType.GuildForum]: '💬',
  ...(ChannelType.GuildMedia !== undefined ? { [ChannelType.GuildMedia]: '🖼️' } : {}),
};

// ---------------------------------------------------------------------------
// Captura (servidor → JSON)
// ---------------------------------------------------------------------------
export async function capturar(guild) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);

  const cargos = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed) // sem @everyone e sem cargos de bot/integração
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      nome: r.name,
      cor: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissoes: r.permissions.bitfield.toString(),
      posicao: r.position,
    }));

  const canais = [...guild.channels.cache.values()]
    .filter((c) => TIPOS_SUPORTADOS.has(c.type))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({
      id: c.id,
      nome: c.name,
      tipo: c.type,
      pai: c.parentId ?? null,
      posicao: c.rawPosition,
      topico: c.topic ?? null,
      nsfw: Boolean(c.nsfw),
      slowmode: c.rateLimitPerUser ?? 0,
      bitrate: c.bitrate ?? null,
      limiteUsuarios: c.userLimit ?? 0,
      // só overwrites de CARGO (inclui @everyone); os de membros específicos não vão pro backup
      permissoes: [...(c.permissionOverwrites?.cache?.values() ?? [])]
        .filter((o) => o.type === OverwriteType.Role)
        .map((o) => ({ id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
    }));

  const emojis = [...guild.emojis.cache.values()]
    .filter((e) => e.name)
    .map((e) => ({ nome: e.name, animado: Boolean(e.animated), url: e.imageURL() }));

  return {
    versao: VERSAO_FORMATO,
    servidor: {
      id: guild.id,
      nome: guild.name,
      descricao: guild.description ?? null,
      idioma: guild.preferredLocale ?? null,
      nivelVerificacao: guild.verificationLevel,
      filtroConteudo: guild.explicitContentFilter,
      notificacoesPadrao: guild.defaultMessageNotifications,
      afkTimeout: guild.afkTimeout ?? null,
      iconeUrl: guild.iconURL({ size: 512 }) ?? null,
      membros: guild.memberCount,
    },
    cargos,
    canais,
    emojis,
  };
}

export function resumoDe(dados) {
  const categorias = dados.canais.filter((c) => c.tipo === ChannelType.GuildCategory).length;
  return {
    cargos: dados.cargos.length,
    categorias,
    canais: dados.canais.length - categorias,
    emojis: dados.emojis.length,
    membros: dados.servidor?.membros ?? null,
  };
}

/** Árvore de categorias/canais em texto (pro /backup info). */
export function montarArvore(dados, max = 1700) {
  const seguro = (n) => String(n).replace(/`/g, "'");
  const icone = (c) => ICONE[c.tipo] ?? '#';
  const filhos = (paiId) => dados.canais.filter((c) => c.tipo !== ChannelType.GuildCategory && (c.pai ?? null) === paiId);

  const linhas = filhos(null).map((c) => `${icone(c)} ${seguro(c.nome)}`);
  for (const cat of dados.canais.filter((c) => c.tipo === ChannelType.GuildCategory)) {
    linhas.push(`📁 ${seguro(cat.nome).toUpperCase()}`);
    for (const c of filhos(cat.id)) linhas.push(`   ${icone(c)} ${seguro(c.nome)}`);
  }

  let texto = '';
  let cortou = false;
  for (const l of linhas) {
    if (texto.length + l.length + 1 > max) {
      cortou = true;
      break;
    }
    texto += `${l}\n`;
  }
  return `${texto}${cortou ? '…' : ''}`.trim() || '(sem canais)';
}

// ---------------------------------------------------------------------------
// Restauração (JSON → servidor), aditiva
// ---------------------------------------------------------------------------
export async function restaurar(guild, dados, { emojis = false, motivo = 'Restauração de backup', progresso = async () => {} } = {}) {
  const rel = {
    cargosCriados: 0, cargosExistentes: 0,
    categoriasCriadas: 0, canaisCriados: 0, canaisExistentes: 0,
    emojisCriados: 0, emojisExistentes: 0,
    nFalhas: 0, falhas: [],
  };
  const falhar = (oque, err) => {
    rel.nFalhas++;
    if (rel.falhas.length < 12) rel.falhas.push(`${oque}: ${cortar(err?.message ?? String(err), 90)}`);
  };

  // O bot não consegue dar a um cargo/canal permissões que ele mesmo não tem (a não ser que seja Administrador).
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const mascara = me.permissions.has(PermissionFlagsBits.Administrator) ? null : me.permissions.bitfield;
  const lim = (v) => (mascara === null ? BigInt(v) : BigInt(v) & mascara);

  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);

  const qtdEmojis = emojis ? Math.min(dados.emojis.length, MAX_EMOJIS_RESTAURAR) : 0;
  const total = dados.cargos.length + dados.canais.length + qtdEmojis;
  let feito = 0;
  const passo = async (etapa) => {
    feito++;
    if (feito % 8 === 0) await progresso(`⏳ Restaurando ${etapa}… (${feito}/${total})`);
  };

  // ---- Cargos (do mais alto pro mais baixo: cada cargo novo nasce embaixo dos anteriores, mantendo a ordem) ----
  const mapaCargos = new Map([[dados.servidor?.id, guild.id]]); // @everyone antigo → @everyone daqui
  for (const r of dados.cargos) {
    const existente = guild.roles.cache.find((x) => !x.managed && x.id !== guild.id && x.name === r.nome);
    if (existente) {
      mapaCargos.set(r.id, existente.id);
      rel.cargosExistentes++;
    } else {
      try {
        const novo = await guild.roles.create({
          name: r.nome,
          color: r.cor,
          hoist: r.hoist,
          mentionable: r.mentionable,
          permissions: lim(r.permissoes),
          reason: motivo,
        });
        mapaCargos.set(r.id, novo.id);
        rel.cargosCriados++;
      } catch (err) {
        falhar(`cargo "${r.nome}"`, err);
      }
    }
    await passo('cargos');
  }

  // ---- Categorias primeiro, depois os canais ----
  const mapaCanais = new Map();
  const ordenados = [
    ...dados.canais.filter((c) => c.tipo === ChannelType.GuildCategory),
    ...dados.canais.filter((c) => c.tipo !== ChannelType.GuildCategory),
  ];
  for (const c of ordenados) {
    const eCategoria = c.tipo === ChannelType.GuildCategory;
    const paiNovo = c.pai ? (mapaCanais.get(c.pai) ?? null) : null;
    const existente = guild.channels.cache.find((x) => x.name === c.nome && mesmoTipo(x.type, c.tipo) && (x.parentId ?? null) === paiNovo);

    if (existente) {
      mapaCanais.set(c.id, existente.id);
      rel.canaisExistentes++;
    } else {
      const permissionOverwrites = (c.permissoes || [])
        .map((o) => {
          const id = mapaCargos.get(o.id);
          return id ? { id, type: OverwriteType.Role, allow: lim(o.allow), deny: lim(o.deny) } : null;
        })
        .filter(Boolean);

      const opcoes = { name: c.nome, type: c.tipo, permissionOverwrites, reason: motivo };
      if (paiNovo) opcoes.parent = paiNovo;
      if (TIPOS_TEXTO.has(c.tipo)) {
        if (c.topico) opcoes.topic = c.topico;
        opcoes.nsfw = Boolean(c.nsfw);
        opcoes.rateLimitPerUser = c.slowmode || 0;
      }
      if (TIPOS_VOZ.has(c.tipo)) {
        if (c.bitrate) opcoes.bitrate = Math.min(c.bitrate, guild.maximumBitrate ?? c.bitrate);
        if (c.tipo === ChannelType.GuildVoice) opcoes.userLimit = c.limiteUsuarios || 0;
      }

      try {
        let novo;
        try {
          novo = await guild.channels.create(opcoes);
        } catch (err) {
          // Canal de anúncios exige servidor Comunidade; sem isso, vira canal de texto comum.
          if (c.tipo !== ChannelType.GuildAnnouncement) throw err;
          novo = await guild.channels.create({ ...opcoes, type: ChannelType.GuildText });
        }
        mapaCanais.set(c.id, novo.id);
        if (eCategoria) rel.categoriasCriadas++;
        else rel.canaisCriados++;
      } catch (err) {
        falhar(`${eCategoria ? 'categoria' : 'canal'} "${c.nome}"`, err);
      }
    }
    await passo('canais');
  }

  // ---- Emojis (opcional) ----
  if (emojis) {
    let falhasSeguidas = 0;
    for (const e of dados.emojis.slice(0, MAX_EMOJIS_RESTAURAR)) {
      if (guild.emojis.cache.some((x) => x.name === e.nome)) {
        rel.emojisExistentes++;
      } else {
        try {
          await guild.emojis.create({ attachment: e.url, name: e.nome, reason: motivo });
          rel.emojisCriados++;
          falhasSeguidas = 0;
        } catch (err) {
          falhar(`emoji "${e.nome}"`, err);
          if (++falhasSeguidas >= 3) {
            falhar('emojis', new Error('3 falhas seguidas (limite de emojis do servidor?) — parei por aqui'));
            break;
          }
        }
      }
      await passo('emojis');
    }
  }

  return rel;
}

// ---------------------------------------------------------------------------
// Slash command + sistema
// ---------------------------------------------------------------------------
export function buildBackupCommands() {
  const idOpcao = (o) => o.setName('id').setDescription('ID do backup (veja em /backup listar)').setRequired(true).setMinValue(1);
  return new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Backup da estrutura do servidor no Supabase (cargos, canais, emojis)')
    .addSubcommand((s) =>
      s.setName('criar').setDescription('Cria um backup deste servidor')
        .addStringOption((o) => o.setName('nome').setDescription('Nome do backup (opcional)').setMaxLength(60)))
    .addSubcommand((s) => s.setName('listar').setDescription('Lista os backups deste servidor'))
    .addSubcommand((s) =>
      s.setName('info').setDescription('Mostra o que tem dentro de um backup').addIntegerOption(idOpcao))
    .addSubcommand((s) =>
      s.setName('restaurar').setDescription('Recria cargos e canais do backup que ainda não existem aqui (não apaga nada)')
        .addIntegerOption(idOpcao)
        .addBooleanOption((o) => o.setName('emojis').setDescription('Restaurar os emojis também? (padrão: não)')))
    .addSubcommand((s) =>
      s.setName('excluir').setDescription('Apaga um backup').addIntegerOption(idOpcao));
}

export function createBackupSystem({ db, ownerId }) {
  const EFEMERO = MessageFlags.Ephemeral;
  const ocupados = new Set(); // servidores com backup/restauração rodando agora

  const ehDono = (i) => Boolean(ownerId && i.user.id === ownerId);
  // Dono do bot OU cargo liberado pelo OWNER em /permissoes (só vale para o servidor atual).
  const podeBackup = (i) => ehDono(i) || Boolean(i.zoeConcedido);
  const embed = (titulo, desc, cor = CORES.master) =>
    new EmbedBuilder().setColor(cor).setTitle(titulo).setDescription(desc).setFooter(rodapePadrao('backup'));

  const quando = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
  const agoraBR = () => {
    try {
      return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: FUSO }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }
  };

  const erroBanco = (err) =>
    err?.code === 'PGRST205' || err?.code === '42P01' || /server_backups/i.test(err?.message || '')
      ? '❌ A tabela `server_backups` ainda não existe no Supabase. Rode o arquivo **backup.sql** (SQL Editor → New query → Run) e tente de novo.'
      : `❌ Erro no banco de dados: ${cortar(err?.message, 150)}`;

  async function buscar(id, { comDados = false } = {}) {
    const colunas = `id, guild_id, guild_nome, nome, criado_por, criado_em, versao, resumo${comDados ? ', dados' : ''}`;
    const { data, error } = await db.from('server_backups').select(colunas).eq('id', id).maybeSingle();
    return { backup: data, error };
  }

  // Ver/apagar: só backups deste servidor (ou qualquer um, se for o dono do bot).
  const doServidor = (i, b) => Boolean(b) && (b.guild_id === i.guildId || ehDono(i));
  // Restaurar: também vale em outro servidor se foi VOCÊ quem criou o backup (migração pra servidor novo).
  const podeRestaurar = (i, b) => Boolean(b) && (b.guild_id === i.guildId || b.criado_por === i.user.id || ehDono(i));

  const linhaConfirmar = (acao, id, userId, extra, rotuloSim) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`backup|sim|${acao}|${id}|${userId}|${extra}`).setLabel(rotuloSim).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`backup|nao|${acao}|${id}|${userId}|`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    );

  // ---------- /backup criar ----------
  async function criar(i) {
    if (ocupados.has(i.guildId)) {
      return i.reply({ content: '⏳ Já tem um backup/restauração rodando neste servidor. Espera terminar.', flags: EFEMERO });
    }
    ocupados.add(i.guildId);
    try {
      await i.deferReply({ flags: EFEMERO });

      const { count, error: erroContagem } = await db
        .from('server_backups').select('id', { count: 'exact', head: true }).eq('guild_id', i.guildId);
      if (erroContagem) return i.editReply({ content: erroBanco(erroContagem) });
      if ((count ?? 0) >= MAX_BACKUPS_POR_SERVIDOR) {
        return i.editReply({ content: `❌ Limite de **${MAX_BACKUPS_POR_SERVIDOR} backups** por servidor. Apague algum com \`/backup excluir\` e tente de novo.` });
      }

      const dados = await capturar(i.guild);
      const bytes = Buffer.byteLength(JSON.stringify(dados));
      if (bytes > MAX_BYTES_BACKUP) {
        return i.editReply({ content: '❌ Esse servidor é grande demais pro backup (passou de ~4 MB de dados).' });
      }

      const nome = (i.options.getString('nome') || `Backup ${agoraBR()}`).trim().slice(0, 60);
      const resumo = { ...resumoDe(dados), kb: Math.ceil(bytes / 1024) };
      const { data, error } = await db.from('server_backups')
        .insert({ guild_id: i.guildId, guild_nome: i.guild.name, nome, criado_por: i.user.id, versao: VERSAO_FORMATO, resumo, dados })
        .select('id')
        .single();
      if (error) return i.editReply({ content: erroBanco(error) });

      console.log(`💾 Backup #${data.id} criado em "${i.guild.name}" por ${i.user.tag} (${resumo.kb} KB).`);
      const e = embed('💾 Backup criado', `**${nome}** · ID **#${data.id}**\nPra restaurar depois: \`/backup restaurar id:${data.id}\``, CORES.sucesso)
        .addFields(
          { name: 'Cargos', value: String(resumo.cargos), inline: true },
          { name: 'Categorias', value: String(resumo.categorias), inline: true },
          { name: 'Canais', value: String(resumo.canais), inline: true },
          { name: 'Emojis', value: String(resumo.emojis), inline: true },
          { name: 'Tamanho', value: `${resumo.kb} KB`, inline: true },
        );
      return i.editReply({ embeds: [e] });
    } finally {
      ocupados.delete(i.guildId);
    }
  }

  // ---------- /backup listar ----------
  async function listar(i) {
    await i.deferReply({ flags: EFEMERO });
    const { data, error } = await db.from('server_backups')
      .select('id, nome, criado_por, criado_em, resumo')
      .eq('guild_id', i.guildId)
      .order('id', { ascending: false })
      .limit(MAX_BACKUPS_POR_SERVIDOR);
    if (error) return i.editReply({ content: erroBanco(error) });
    if (!data?.length) return i.editReply({ content: 'Nenhum backup ainda. Crie um com `/backup criar`.' });

    const linhas = data.map((b) => {
      const r = b.resumo || {};
      return `**#${b.id}** · ${cortar(b.nome, 40)} · ${quando(b.criado_em)}\n   ${r.cargos ?? 0} cargos · ${r.categorias ?? 0} categorias · ${r.canais ?? 0} canais · ${r.emojis ?? 0} emojis · por <@${b.criado_por}>`;
    });
    return i.editReply({ embeds: [embed('💾 Backups deste servidor', linhas.join('\n\n').slice(0, 3900))] });
  }

  // ---------- /backup info ----------
  async function info(i) {
    await i.deferReply({ flags: EFEMERO });
    const id = i.options.getInteger('id', true);
    const { backup, error } = await buscar(id, { comDados: true });
    if (error) return i.editReply({ content: erroBanco(error) });
    if (!doServidor(i, backup)) return i.editReply({ content: '❌ Não achei esse backup neste servidor.' });

    const dados = backup.dados;
    const r = backup.resumo || {};
    const nomesCargos = dados.cargos.map((c) => c.nome.replace(/`/g, "'")).join(', ');
    const e = embed(`💾 Backup #${backup.id} · ${cortar(backup.nome, 60)}`, `\`\`\`\n${montarArvore(dados)}\n\`\`\``)
      .addFields(
        { name: 'Origem', value: `${cortar(backup.guild_nome || dados.servidor?.nome || '?', 60)}\n${quando(backup.criado_em)} por <@${backup.criado_por}>`, inline: true },
        { name: 'Conteúdo', value: `${r.cargos ?? 0} cargos\n${r.categorias ?? 0} categorias\n${r.canais ?? 0} canais\n${r.emojis ?? 0} emojis`, inline: true },
        { name: 'Cargos', value: cortar(nomesCargos || '(nenhum)', 1000) },
      );
    return i.editReply({ embeds: [e] });
  }

  // ---------- /backup restaurar (pede confirmação) ----------
  async function pedirRestauracao(i) {
    await i.deferReply({ flags: EFEMERO });
    const id = i.options.getInteger('id', true);
    const comEmojis = i.options.getBoolean('emojis') ?? false;
    const { backup, error } = await buscar(id);
    if (error) return i.editReply({ content: erroBanco(error) });
    if (!podeRestaurar(i, backup)) return i.editReply({ content: '❌ Não achei esse backup (ou ele é de outro servidor e foi criado por outra pessoa).' });

    const me = i.guild.members.me;
    const faltam = [];
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) faltam.push('Gerenciar Cargos');
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) faltam.push('Gerenciar Canais');
    const permEmoji = PermissionFlagsBits.ManageGuildExpressions ?? PermissionFlagsBits.ManageEmojisAndStickers;
    if (comEmojis && permEmoji && !me.permissions.has(permEmoji)) faltam.push('Gerenciar Expressões');
    if (faltam.length) return i.editReply({ content: `❌ Eu preciso destas permissões aqui: **${faltam.join(', ')}**.` });

    const r = backup.resumo || {};
    const texto = [
      `⚠️ **Restaurar o backup #${backup.id}** ("${cortar(backup.nome, 40)}") **neste servidor**?`,
      `• Cria os cargos, categorias e canais do backup que **ainda não existem** aqui (compara por nome): até ${r.cargos ?? 0} cargos e ${(r.categorias ?? 0) + (r.canais ?? 0)} categorias/canais${comEmojis ? ` e ${Math.min(r.emojis ?? 0, MAX_EMOJIS_RESTAURAR)} emojis` : ''}.`,
      '• **Não apaga nem altera** nada que já existe.',
      '• Não restaura mensagens, membros, cargos dos membros, bots, nome/ícone do servidor.',
      '• Em servidor grande leva alguns minutos.',
    ].join('\n');
    return i.editReply({ content: texto, components: [linhaConfirmar('restaurar', backup.id, i.user.id, comEmojis ? 'e' : '', 'Restaurar')] });
  }

  // ---------- /backup excluir (pede confirmação) ----------
  async function pedirExclusao(i) {
    await i.deferReply({ flags: EFEMERO });
    const id = i.options.getInteger('id', true);
    const { backup, error } = await buscar(id);
    if (error) return i.editReply({ content: erroBanco(error) });
    if (!doServidor(i, backup)) return i.editReply({ content: '❌ Não achei esse backup neste servidor.' });
    return i.editReply({
      content: `🗑️ Apagar o backup **#${backup.id}** ("${cortar(backup.nome, 40)}")? Isso não dá pra desfazer.`,
      components: [linhaConfirmar('excluir', backup.id, i.user.id, '', 'Apagar')],
    });
  }

  function embedRelatorio(id, nome, rel) {
    const e = embed(`✅ Backup #${id} restaurado`, `**${cortar(nome, 60)}**`, rel.nFalhas ? CORES.aviso : CORES.sucesso)
      .addFields(
        { name: 'Cargos', value: `+${rel.cargosCriados} criados\n${rel.cargosExistentes} já existiam`, inline: true },
        { name: 'Categorias e canais', value: `+${rel.categoriasCriadas + rel.canaisCriados} criados\n${rel.canaisExistentes} já existiam`, inline: true },
      );
    if (rel.emojisCriados || rel.emojisExistentes) {
      e.addFields({ name: 'Emojis', value: `+${rel.emojisCriados} criados\n${rel.emojisExistentes} já existiam`, inline: true });
    }
    if (rel.nFalhas) {
      const extra = rel.nFalhas > rel.falhas.length ? `\n… e mais ${rel.nFalhas - rel.falhas.length}` : '';
      e.addFields({ name: `⚠️ ${rel.nFalhas} falha(s)`, value: cortar(rel.falhas.join('\n') + extra, 1000).replace(/…$/, '…') });
    }
    return e;
  }

  // ---------- botões (confirmar / cancelar) ----------
  async function handleButton(i) {
    const [, resposta, acao, idTxt, userId, extra] = i.customId.split('|');
    if (i.user.id !== userId) return i.reply({ content: '🚫 Esse botão não é seu.', flags: EFEMERO });
    if (!i.guild || !podeBackup(i)) return i.reply({ content: '🚫 Só o dono do bot (ou um cargo liberado pelo OWNER) pode usar o /backup.', flags: EFEMERO });
    if (resposta === 'nao') return i.update({ content: '✖️ Cancelado.', components: [], embeds: [] });

    const id = Number(idTxt);
    if (!Number.isInteger(id)) return i.update({ content: '❌ Botão inválido.', components: [], embeds: [] });

    try {
      if (acao === 'excluir') {
        const { backup, error } = await buscar(id);
        if (error) return i.update({ content: erroBanco(error), components: [], embeds: [] });
        if (!doServidor(i, backup)) return i.update({ content: '❌ Backup não encontrado.', components: [], embeds: [] });
        const { error: erroDel } = await db.from('server_backups').delete().eq('id', id);
        if (erroDel) return i.update({ content: erroBanco(erroDel), components: [], embeds: [] });
        console.log(`🗑️ Backup #${id} apagado por ${i.user.tag}.`);
        return i.update({ content: `🗑️ Backup **#${id}** apagado.`, components: [], embeds: [] });
      }

      if (acao === 'restaurar') {
        if (ocupados.has(i.guildId)) return i.reply({ content: '⏳ Já tem um backup/restauração rodando neste servidor.', flags: EFEMERO });
        ocupados.add(i.guildId);
        try {
          await i.update({ content: '⏳ Preparando a restauração…', components: [], embeds: [] });
          const { backup, error } = await buscar(id, { comDados: true });
          if (error) return i.editReply({ content: erroBanco(error) });
          if (!podeRestaurar(i, backup)) return i.editReply({ content: '❌ Backup não encontrado.' });
          if ((backup.versao ?? 1) > VERSAO_FORMATO) return i.editReply({ content: '❌ Esse backup é de uma versão mais nova do que este bot entende.' });

          const progresso = (txt) => i.editReply({ content: txt }).catch(() => {});
          const rel = await restaurar(i.guild, backup.dados, {
            emojis: extra === 'e',
            motivo: `Restauração do backup #${id} por ${i.user.tag}`,
            progresso,
          });
          console.log(`♻️ Backup #${id} restaurado em "${i.guild.name}" por ${i.user.tag}: +${rel.cargosCriados} cargos, +${rel.categoriasCriadas + rel.canaisCriados} canais, ${rel.nFalhas} falha(s).`);

          const relatorio = embedRelatorio(id, backup.nome, rel);
          // O token da interação vale 15 min; se a restauração demorar mais, o relatório vai pro canal.
          return await i.editReply({ content: '', embeds: [relatorio] }).catch(() =>
            i.channel?.send({ content: `<@${i.user.id}>`, embeds: [relatorio], allowedMentions: { users: [i.user.id] } }).catch(() => {}));
        } finally {
          ocupados.delete(i.guildId);
        }
      }
    } catch (err) {
      console.error('Erro no botão do /backup:', err);
      const msg = { content: `❌ Deu erro: ${cortar(err.message, 200)}`, components: [], embeds: [] };
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
      else await i.update(msg).catch(() => {});
    }
    return undefined;
  }

  // ---------- entrada do slash command ----------
  async function handleCommand(i) {
    try {
      if (!i.guild) return await i.reply({ content: 'Esse comando só funciona dentro de um servidor.', flags: EFEMERO });
      if (!podeBackup(i)) return await i.reply({ content: '🚫 Só o **dono do bot** (ou um cargo liberado pelo OWNER) pode usar o /backup.', flags: EFEMERO });
      switch (i.options.getSubcommand()) {
        case 'criar': return await criar(i);
        case 'listar': return await listar(i);
        case 'info': return await info(i);
        case 'restaurar': return await pedirRestauracao(i);
        case 'excluir': return await pedirExclusao(i);
        default: return undefined;
      }
    } catch (err) {
      console.error('Erro no /backup:', err);
      const msg = { content: `❌ Deu erro no backup: ${cortar(err.message, 200)}` };
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
      else await i.reply({ ...msg, flags: EFEMERO }).catch(() => {});
      return undefined;
    }
  }

  return { handleCommand, handleButton };
}
