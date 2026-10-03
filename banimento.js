/**
 * Banimento integrado (Discord + site) e painel de permissões por cargo.
 *
 * - /banir     → bane no servidor do Discord E grava na tabela `banned_users` (a mesma que o
 *                crimson-site e o dm-control leem). Opcionalmente bane também por IP e/ou hardware.
 * - /desbanir  → remove do Discord e do site.
 * - /banidos   → lista os banidos do site.
 * - /permissoes → painel (só Administrador / dono) pra escolher quais comandos cada cargo pode usar.
 *
 * Requer o SQL banimento.sql (tabela cargo_permissoes) rodado uma vez no Supabase.
 */
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';

// Comandos que o dono pode liberar para cargos pelo painel.
export const COMANDOS_CONTROLAVEIS = [
  { nome: 'banir', desc: 'Banir membro (Discord + site)' },
  { nome: 'desbanir', desc: 'Desbanir (Discord + site)' },
  { nome: 'banidos', desc: 'Ver a lista de banidos do site' },
  { nome: 'nuke', desc: 'Clonar e apagar o canal' },
  { nome: 'moderacao', desc: 'Moderação por IA e auto-mod' },
  { nome: 'contexto', desc: 'Memória de conversas por canal' },
];

export function buildBanCommands() {
  return [
    new SlashCommandBuilder()
      .setName('banir')
      .setDescription('Bane no Discord e no site (opcionalmente por IP e hardware)')
      .addUserOption((o) => o.setName('usuario').setDescription('Quem banir').setRequired(true))
      .addStringOption((o) => o.setName('motivo').setDescription('Motivo do ban').setMaxLength(300))
      .addBooleanOption((o) => o.setName('ip').setDescription('Banir também pelo IP da última verificação no site'))
      .addBooleanOption((o) => o.setName('hardware').setDescription('Banir também pelo hardware (fingerprint) da última verificação')),
    new SlashCommandBuilder()
      .setName('desbanir')
      .setDescription('Remove o ban do Discord e do site')
      .addStringOption((o) => o.setName('id').setDescription('ID do usuário').setRequired(true)),
    new SlashCommandBuilder().setName('banidos').setDescription('Lista os banidos do site'),
    new SlashCommandBuilder()
      .setName('permissoes')
      .setDescription('Painel: escolha quais comandos cada cargo pode usar')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];
}

export function createBanSystem({ client, db, ownerId, getGuildConfig, verifyGuildId }) {
  const negar = (i) =>
    i.reply({ content: '🚫 Você não tem permissão para usar este comando.', flags: MessageFlags.Ephemeral });

  const ehAdmin = (i) =>
    !!(i.memberPermissions?.has(PermissionFlagsBits.Administrator) || (ownerId && i.user.id === ownerId));

  function idsDosCargos(i) {
    const r = i.member?.roles;
    if (!r) return [];
    return Array.isArray(r) ? r : [...r.cache.keys()];
  }

  async function temConcessao(i, comando) {
    const roleIds = idsDosCargos(i);
    if (!i.guild || !roleIds.length) return false;
    const { data, error } = await db
      .from('cargo_permissoes')
      .select('role_id')
      .eq('guild_id', i.guild.id)
      .eq('comando', comando)
      .in('role_id', roleIds)
      .limit(1);
    if (error) {
      console.error('Erro ao ler cargo_permissoes:', error.message);
      return false;
    }
    return !!(data && data.length);
  }

  const podeUsar = async (i, comando) => ehAdmin(i) || (await temConcessao(i, comando));

  // ---------- Ban no site (mesma lógica do painel do dm-control) ----------
  async function banirNoSite({ discordId, username, reason, banIp = false, banDevice = false }) {
    let ip_hash = null;
    let device_hash = null;
    if (banIp || banDevice) {
      const { data: alvo } = await db
        .from('members')
        .select('ip_hash, device_hash')
        .eq('discord_id', discordId)
        .maybeSingle();
      if (banIp) ip_hash = alvo?.ip_hash || null;
      if (banDevice) device_hash = alvo?.device_hash || null;
    }

    const { error } = await db.from('banned_users').upsert(
      {
        discord_id: discordId,
        username: username ? String(username).slice(0, 100) : null,
        reason: reason ? String(reason).slice(0, 300) : null,
        ban_ip: !!banIp,
        ban_device: !!banDevice,
        ip_hash,
        device_hash,
      },
      { onConflict: 'discord_id' }
    );
    if (error) return { ok: false, error: error.message, ipHash: false, deviceHash: false };

    // Banido também sai do envio de DM em massa
    await db.from('members').update({ excluded: true }).eq('discord_id', discordId);
    return { ok: true, ipHash: !!ip_hash, deviceHash: !!device_hash };
  }

  async function desbanirNoSite(discordId) {
    const { error } = await db.from('banned_users').delete().eq('discord_id', discordId);
    return { ok: !error, error: error?.message };
  }

  // ---------- Log de banimentos (canal de logs, ou o canal da moderação) ----------
  async function enviarLog(guild, { titulo, cor, alvo, motivo, por, detalhes }) {
    try {
      const cfg = getGuildConfig ? await getGuildConfig(guild.id) : null;
      const canalId = cfg?.logs_canal_id || cfg?.moderacao_canal_id;
      if (!canalId) return;
      const canal = await guild.channels.fetch(canalId).catch(() => null);
      if (!canal?.isTextBased()) return;
      const e = new EmbedBuilder()
        .setColor(cor)
        .setTitle(titulo)
        .setDescription(`<@${alvo.id}> · \`${alvo.id}\`${alvo.username ? ` · ${alvo.username}` : ''}`)
        .addFields({ name: 'Motivo', value: String(motivo || 'Sem motivo informado').slice(0, 300) }, { name: 'Por', value: por || 'desconhecido', inline: true })
        .setFooter(rodapePadrao('log de banimento'))
        .setTimestamp();
      if (detalhes) e.addFields({ name: 'Detalhes', value: detalhes.slice(0, 300), inline: true });
      await canal.send({ embeds: [e] });
    } catch (err) {
      console.error('Erro ao enviar log de banimento:', err.message);
    }
  }

  // ---------- Ban/unban pedido pelo dashboard (dm-control) via API do bot ----------
  async function banirViaApi({ guildId, discordId, motivo, por }) {
    if (ownerId && discordId === ownerId) return { ok: false, error: 'Esse usuário é protegido.' };
    if (discordId === client.user.id) return { ok: false, error: 'Não posso banir a mim mesma.' };
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return { ok: false, error: 'Servidor não encontrado.' };
    try {
      await guild.bans.create(discordId, { reason: `${motivo || 'Sem motivo'} — ${por || 'dashboard'}`.slice(0, 512) });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    await enviarLog(guild, { titulo: '🔨 Banido pelo dashboard', cor: CORES.moderacaoBan, alvo: { id: discordId }, motivo, por: por || 'dashboard' });
    return { ok: true };
  }

  async function desbanirViaApi({ guildId, discordId, por }) {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return { ok: false, error: 'Servidor não encontrado.' };
    try {
      await guild.bans.remove(discordId, `Desbanido por ${por || 'dashboard'}`);
    } catch (err) {
      if (err.code === 10026) return { ok: true, naoEstavaBanido: true };
      return { ok: false, error: err.message };
    }
    await enviarLog(guild, { titulo: '♻️ Desbanido pelo dashboard', cor: CORES.sucesso, alvo: { id: discordId }, motivo: 'Desban', por: por || 'dashboard' });
    return { ok: true };
  }

  // ---------- Sincronização: ban/desban feito direto no Discord também vale no site ----------
  const valeSincronizar = (guildId) => !verifyGuildId || guildId === verifyGuildId;

  client.on('guildBanAdd', async (ban) => {
    try {
      if (!valeSincronizar(ban.guild.id)) return;
      const id = ban.user.id;
      const { data: existe } = await db.from('banned_users').select('discord_id').eq('discord_id', id).maybeSingle();
      if (existe) return; // já veio de /banir, do painel ou do botão da moderação
      let motivo = ban.reason;
      if (motivo === undefined || motivo === null) motivo = (await ban.fetch().catch(() => null))?.reason;
      const r = await banirNoSite({
        discordId: id,
        username: ban.user.username,
        reason: motivo ? `Ban pelo Discord: ${motivo}` : 'Ban direto pelo Discord',
      });
      if (!r.ok) return console.error('Sync de ban (Discord → site) falhou:', r.error);
      await enviarLog(ban.guild, { titulo: '🔄 Ban do Discord sincronizado com o site', cor: CORES.moderacaoBan, alvo: ban.user, motivo, por: 'Discord' });
    } catch (err) {
      console.error('Erro no guildBanAdd:', err.message);
    }
  });

  client.on('guildBanRemove', async (ban) => {
    try {
      if (!valeSincronizar(ban.guild.id)) return;
      const { data: existe } = await db.from('banned_users').select('discord_id').eq('discord_id', ban.user.id).maybeSingle();
      if (!existe) return;
      const r = await desbanirNoSite(ban.user.id);
      if (!r.ok) return console.error('Sync de desban (Discord → site) falhou:', r.error);
      await enviarLog(ban.guild, { titulo: '🔄 Desban do Discord sincronizado com o site', cor: CORES.sucesso, alvo: ban.user, motivo: 'Desban', por: 'Discord' });
    } catch (err) {
      console.error('Erro no guildBanRemove:', err.message);
    }
  });

  // ---------- Comandos ----------
  async function banir(i) {
    if (!(await podeUsar(i, 'banir'))) return negar(i);
    const alvo = i.options.getUser('usuario', true);
    const motivo = i.options.getString('motivo') || 'Sem motivo informado';
    const banIp = !!i.options.getBoolean('ip');
    const banHw = !!i.options.getBoolean('hardware');

    if (alvo.id === i.user.id) return i.reply({ content: '❌ Você não pode banir a si mesmo.', flags: MessageFlags.Ephemeral });
    if (alvo.id === client.user.id || (ownerId && alvo.id === ownerId))
      return i.reply({ content: '❌ Esse usuário não pode ser banido.', flags: MessageFlags.Ephemeral });

    const membro = await i.guild.members.fetch(alvo.id).catch(() => null);
    if (membro && !membro.bannable)
      return i.reply({
        content: '❌ Não consigo banir esse membro (cargo igual/acima do meu, ou é o dono do servidor).',
        flags: MessageFlags.Ephemeral,
      });
    if (membro && !ehAdmin(i) && i.member.roles?.highest && membro.roles.highest.comparePositionTo(i.member.roles.highest) >= 0)
      return i.reply({ content: '❌ Esse membro tem cargo igual ou acima do seu.', flags: MessageFlags.Ephemeral });

    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const site = await banirNoSite({ discordId: alvo.id, username: alvo.username, reason: motivo, banIp, banDevice: banHw });

    let discordOk = true;
    let discordErro = '';
    await i.guild.bans
      .create(alvo.id, { reason: `${motivo} — por ${i.user.tag}`.slice(0, 512) })
      .catch((err) => {
        discordOk = false;
        discordErro = err.message;
      });

    const linhas = [
      `**Discord:** ${discordOk ? '✅ banido' : `❌ falhou (${discordErro})`}`,
      `**Site (ID):** ${site.ok ? '✅ banido' : `❌ falhou (${site.error})`}`,
    ];
    if (site.ok && banIp) linhas.push(`**Site (IP):** ${site.ipHash ? '✅ banido' : '⚠️ sem IP registrado — a pessoa nunca verificou no site, só o ID foi banido'}`);
    if (site.ok && banHw) linhas.push(`**Site (hardware):** ${site.deviceHash ? '✅ banido' : '⚠️ sem hardware registrado — a pessoa nunca verificou no site, só o ID foi banido'}`);

    const detalhesLog = [banIp ? `IP: ${site.ipHash ? 'sim' : 'sem registro'}` : null, banHw ? `hardware: ${site.deviceHash ? 'sim' : 'sem registro'}` : null].filter(Boolean).join(' · ');
    if (discordOk || site.ok) await enviarLog(i.guild, { titulo: '🔨 Banimento', cor: CORES.moderacaoBan, alvo, motivo, por: i.user.tag, detalhes: detalhesLog || undefined });

    const e = new EmbedBuilder()
      .setColor(site.ok && discordOk ? CORES.moderacaoBan : CORES.alerta)
      .setTitle(`🔨 ${alvo.username} (${alvo.id})`)
      .setDescription(linhas.join('\n'))
      .addFields({ name: 'Motivo', value: motivo.slice(0, 300) })
      .setFooter(rodapePadrao('banimento'));
    return i.editReply({ embeds: [e] });
  }

  async function desbanir(i) {
    if (!(await podeUsar(i, 'desbanir'))) return negar(i);
    const id = i.options.getString('id', true).trim();
    if (!/^\d{5,25}$/.test(id)) return i.reply({ content: '❌ ID inválido.', flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const site = await desbanirNoSite(id);
    let discordMsg = '✅ desbanido';
    await i.guild.bans.remove(id, `Desbanido por ${i.user.tag}`).catch((err) => {
      discordMsg = err.code === 10026 ? 'ℹ️ não estava banido no Discord' : `❌ falhou (${err.message})`;
    });

    if (site.ok) await enviarLog(i.guild, { titulo: '♻️ Desbanimento', cor: CORES.sucesso, alvo: { id }, motivo: 'Desban', por: i.user.tag });
    return i.editReply(`**Discord:** ${discordMsg}\n**Site:** ${site.ok ? '✅ removido da lista' : `❌ falhou (${site.error})`}`);
  }

  async function banidos(i) {
    if (!(await podeUsar(i, 'banidos'))) return negar(i);
    const { data, error } = await db
      .from('banned_users')
      .select('discord_id, username, reason, banned_at, ban_ip, ban_device')
      .order('banned_at', { ascending: false })
      .limit(25);
    if (error) return i.reply({ content: `❌ Erro ao buscar banidos: ${error.message}`, flags: MessageFlags.Ephemeral });
    if (!data.length) return i.reply({ content: 'Nenhum banido no site.', flags: MessageFlags.Ephemeral });

    const linhas = data.map((b) => {
      const tags = `${b.ban_ip ? ' `IP`' : ''}${b.ban_device ? ' `HW`' : ''}`;
      const data_ = b.banned_at ? `<t:${Math.floor(new Date(b.banned_at).getTime() / 1000)}:d>` : '';
      return `• <@${b.discord_id}> (${b.username || b.discord_id})${tags} — ${(b.reason || 'sem motivo').slice(0, 60)} ${data_}`;
    });
    const e = new EmbedBuilder()
      .setColor(CORES.info)
      .setTitle('🔨 Banidos do site (últimos 25)')
      .setDescription(linhas.join('\n').slice(0, 4000))
      .setFooter(rodapePadrao('banimento'));
    return i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }

  // ---------- Painel de permissões por cargo ----------
  async function permissoesDoCargo(guildId, roleId) {
    const { data, error } = await db.from('cargo_permissoes').select('comando').eq('guild_id', guildId).eq('role_id', roleId);
    if (error) throw new Error(error.message);
    return new Set((data || []).map((r) => r.comando));
  }

  function montarPainel(roleId, concedidos) {
    const e = new EmbedBuilder()
      .setColor(CORES.master)
      .setTitle('🛡️ Permissões por cargo')
      .setFooter(rodapePadrao('Administrador e dono sempre têm acesso a tudo'));

    const rowCargo = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('perm|cargo').setPlaceholder('Escolha um cargo').setMinValues(1).setMaxValues(1)
    );
    const rowResumo = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('perm|resumo').setLabel('📋 Ver resumo de todos os cargos').setStyle(ButtonStyle.Secondary)
    );
    if (!roleId) {
      e.setDescription('Escolha um cargo abaixo para definir quais comandos ele pode usar.');
      return { embeds: [e], components: [rowCargo, rowResumo] };
    }

    e.setDescription(
      `Cargo: <@&${roleId}>\nMarque os comandos que esse cargo pode usar. O que ficar desmarcado fica bloqueado para ele ` +
        '(continua valendo a permissão normal do Discord nos comandos que já tinham uma).'
    );
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`perm|cmds|${roleId}`)
      .setPlaceholder('Comandos liberados')
      .setMinValues(0)
      .setMaxValues(COMANDOS_CONTROLAVEIS.length)
      .addOptions(
        COMANDOS_CONTROLAVEIS.map((c) => ({
          label: `/${c.nome}`,
          description: c.desc,
          value: c.nome,
          default: concedidos.has(c.nome),
        }))
      );
    return { embeds: [e], components: [rowCargo, new ActionRowBuilder().addComponents(menu), rowResumo] };
  }

  async function abrirPainel(i) {
    if (!ehAdmin(i)) return negar(i);
    return i.reply({ ...montarPainel(null, new Set()), flags: MessageFlags.Ephemeral });
  }

  async function handleComponent(i) {
    if (!ehAdmin(i)) return negar(i);
    try {
      if (i.isButton() && i.customId === 'perm|resumo') {
        const { data, error } = await db.from('cargo_permissoes').select('role_id, comando').eq('guild_id', i.guild.id);
        if (error) throw new Error(error.message);
        const porCargo = new Map();
        for (const r of data || []) porCargo.set(r.role_id, [...(porCargo.get(r.role_id) || []), r.comando]);
        const linhas = [...porCargo.entries()].map(([role, cmds]) => `<@&${role}> → ${cmds.sort().map((c) => `\`/${c}\``).join(' ')}`);
        const e = new EmbedBuilder()
          .setColor(CORES.info)
          .setTitle('📋 Resumo das permissões')
          .setDescription(linhas.length ? linhas.join('\n').slice(0, 4000) : 'Nenhum cargo recebeu comandos ainda. Só administradores e o dono usam os comandos controlados.')
          .setFooter(rodapePadrao('Administrador e dono sempre têm acesso a tudo'));
        return i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      }
      if (i.isRoleSelectMenu() && i.customId === 'perm|cargo') {
        const roleId = i.values[0];
        const concedidos = await permissoesDoCargo(i.guild.id, roleId);
        return i.update(montarPainel(roleId, concedidos));
      }
      if (i.isStringSelectMenu() && i.customId.startsWith('perm|cmds|')) {
        const roleId = i.customId.split('|')[2];
        const validos = new Set(COMANDOS_CONTROLAVEIS.map((c) => c.nome));
        const escolhidos = i.values.filter((v) => validos.has(v));

        const del = await db.from('cargo_permissoes').delete().eq('guild_id', i.guild.id).eq('role_id', roleId);
        if (del.error) throw new Error(del.error.message);
        if (escolhidos.length) {
          const ins = await db
            .from('cargo_permissoes')
            .insert(escolhidos.map((comando) => ({ guild_id: i.guild.id, role_id: roleId, comando })));
          if (ins.error) throw new Error(ins.error.message);
        }
        return i.update(montarPainel(roleId, new Set(escolhidos)));
      }
    } catch (err) {
      console.error('Erro no painel de permissões:', err.message);
      const msg = { content: `❌ Erro ao salvar (rodou o banimento.sql no Supabase?): ${err.message}`, flags: MessageFlags.Ephemeral };
      return i.replied || i.deferred ? i.followUp(msg) : i.reply(msg);
    }
  }

  async function handleCommand(i) {
    switch (i.commandName) {
      case 'banir': return banir(i);
      case 'desbanir': return desbanir(i);
      case 'banidos': return banidos(i);
      case 'permissoes': return abrirPainel(i);
    }
  }

  return { handleCommand, handleComponent, podeUsar, temConcessao, banirNoSite, banirViaApi, desbanirViaApi };
}
