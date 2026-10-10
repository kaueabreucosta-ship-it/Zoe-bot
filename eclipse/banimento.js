/**
 * Banimento integrado (Discord + site) e painel de permissões por cargo.
 *
 * - /banir     → bane no servidor do Discord E grava na tabela `banned_users` (a mesma que o
 *                crimson-site e o dm-control leem). Opcionalmente bane também por IP e/ou hardware.
 * - /desbanir  → remove do Discord e do site.
 * - /banidos   → lista os banidos do site.
 * - /permissoes → painel (SÓ O OWNER) pra escolher quais comandos cada cargo pode usar.
 *                Com 1 cargo escolhido, cada clique já salva na hora.
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

// Comandos controlados por cargo (menos /permissoes, que é só do OWNER).
// Um comando controlado só pode ser executado por cargos liberados, administradores ou OWNER.
// A visibilidade no menu do Discord é separada; este portão também impede a execução caso alguém tente invocá-lo.
export const COMANDOS_CONTROLAVEIS = [
  { nome: 'banir', desc: 'Banir membro (Discord + site)', publico: false },
  { nome: 'desbanir', desc: 'Desbanir (Discord + site)', publico: false },
  { nome: 'banidos', desc: 'Ver a lista de banidos do site', publico: false },
  { nome: 'cargos', desc: 'Painel de cargos e acesso por canal', publico: false },
  { nome: 'backup', desc: 'Backup e restauração do servidor', publico: false },
  { nome: 'antiraid', desc: 'Anti-raid (modo raid, configuração)', publico: false },
  { nome: 'moderacao', desc: 'Moderação por IA e auto-mod', publico: false },
  { nome: 'contexto', desc: 'Memória de conversas por canal', publico: false },
  { nome: 'nuke', desc: 'Clonar e apagar o canal', publico: false },
  { nome: 'ticket', desc: 'Tickets (painel e configuração)', publico: false },
  { nome: 'iastatus', desc: 'Saúde dos provedores de IA', publico: false },
  { nome: 'ajuda', desc: 'Lista de comandos', publico: true },
  { nome: 'perguntar', desc: 'Perguntar algo pra IA', publico: true },
  { nome: 'perfil', desc: 'Perfil do membro', publico: true },
  { nome: 'ranking', desc: 'Ranking do servidor', publico: true },
  { nome: 'diario', desc: 'Recompensa diária', publico: true },
  { nome: 'saldo', desc: 'Ver saldo', publico: true },
  { nome: 'transferir', desc: 'Transferir dinheiro', publico: true },
  { nome: 'economia', desc: 'Economia do servidor', publico: true },
  { nome: 'cassino', desc: 'Cassino', publico: true },
  { nome: 'tigrinho', desc: 'Jogo do tigrinho', publico: true },
  { nome: 'briga', desc: 'Batalha / briga entre membros', publico: true },
  { nome: 'larp', desc: 'Larp', publico: true },
  { nome: 'discussao', desc: 'Discussão', publico: true },
];
const PUBLICOS = new Set(COMANDOS_CONTROLAVEIS.filter((c) => c.publico).map((c) => c.nome));
// customId de botões/menus → comando dono (pra a liberação valer também dentro do painel)
const PREFIXO_COMANDO = { 'cargo|': 'cargos', 'backup|': 'backup', 'antiraid|': 'antiraid' };

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
      .setDescription('Só OWNER: escolha quais comandos cada cargo pode usar'),
  ];
}

export function createBanSystem({ client, db, ownerId, ownerRoleId = '', getGuildConfig, verifyGuildId }) {
  const negar = (i) =>
    i.reply({ content: '🚫 Só o **OWNER** pode usar este comando.', flags: MessageFlags.Ephemeral });

  // OWNER = dono da bot (OWNER_ID), dono do servidor ou quem tem o cargo OWNER (OWNER_ROLE_ID).
  const ehOwner = (i) => {
    if (ownerId && i.user.id === ownerId) return true;
    if (i.guild?.ownerId && i.user.id === i.guild.ownerId) return true;
    if (ownerRoleId) {
      const r = i.member?.roles;
      const ids = !r ? [] : Array.isArray(r) ? r : [...r.cache.keys()];
      if (ids.includes(ownerRoleId)) return true;
    }
    return false;
  };

  const ehAdmin = (i) =>
    !!(i.memberPermissions?.has(PermissionFlagsBits.Administrator) || (ownerId && i.user.id === ownerId));

  function idsDosCargos(i) {
    const r = i.member?.roles;
    if (!r) return [];
    return Array.isArray(r) ? r : [...r.cache.keys()];
  }

  // Quem pode o quê, com cache curto (evita consultar o banco a cada comando).
  const cacheConcessoes = new Map();
  async function cargosLiberados(guildId, comando) {
    const chave = `${guildId}:${comando}`;
    const c = cacheConcessoes.get(chave);
    if (c && c.ate > Date.now()) return c.roles;
    const { data, error } = await db.from('cargo_permissoes').select('role_id').eq('guild_id', guildId).eq('comando', comando);
    if (error) {
      console.error('Erro ao ler cargo_permissoes:', error.message);
      return c?.roles ?? new Set();
    }
    const roles = new Set((data || []).map((r) => r.role_id));
    cacheConcessoes.set(chave, { roles, ate: Date.now() + 15_000 });
    return roles;
  }

  async function temConcessao(i, comando) {
    const roleIds = idsDosCargos(i);
    if (!i.guild || !roleIds.length) return false;
    const liberados = await cargosLiberados(i.guild.id, comando);
    return roleIds.some((r) => liberados.has(r));
  }

  /**
   * Portão central: valida a autorização de execução mesmo quando o comando estiver oculto
   * no menu nativo do Discord. Todo comando listado em COMANDOS_CONTROLAVEIS exige cargo
   * explicitamente liberado, salvo Administrador/OWNER. /permissoes continua exclusivo do OWNER.
   * Devolve false quando bloqueou (e já respondeu).
   */
  async function gate(i) {
    if (!i.guild) return true;
    let comando = null;
    if (i.isChatInputCommand()) comando = i.commandName;
    else if (i.customId) {
      const pref = Object.keys(PREFIXO_COMANDO).find((p) => i.customId.startsWith(p));
      if (pref) comando = PREFIXO_COMANDO[pref];
    }
    if (!comando || comando === 'permissoes') return true;

    const concedido = await temConcessao(i, comando);
    i.zoeConcedido = concedido;

    if (i.isChatInputCommand() && COMANDOS_VALIDOS.has(comando) && !concedido && !ehAdmin(i) && !ehOwner(i)) {
      const liberados = await cargosLiberados(i.guild.id, comando);
      const detalhe = liberados.size
        ? ` Cargos autorizados: ${[...liberados].map((r) => `<@&${r}>`).join(' ')}.`
        : ' Nenhum cargo foi autorizado ainda.';
      await i.reply({
        content: `🚫 Você não tem permissão para executar /${comando}.${detalhe}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return false;
    }
    return true;
  }

  const podeUsar = async (i, comando) => ehAdmin(i) || (await temConcessao(i, comando));

  // CORREÇÃO: a tabela banned_users é GLOBAL (o site lê ela). Antes, qualquer servidor onde o bot estivesse podia
  // banir/desbanir/listar no site inteiro. Agora o lado "site" só vale no servidor de verificação.
  const valeNoSite = (guildId) => !verifyGuildId || guildId === verifyGuildId;

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

    const noSite = valeNoSite(i.guild.id);
    const site = noSite
      ? await banirNoSite({ discordId: alvo.id, username: alvo.username, reason: motivo, banIp, banDevice: banHw })
      : { ok: false, ignorado: true };

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
      `**Site (ID):** ${site.ignorado ? 'ℹ️ não aplicado (este não é o servidor de verificação)' : site.ok ? '✅ banido' : `❌ falhou (${site.error})`}`,
    ];
    if (site.ok && banIp) linhas.push(`**Site (IP):** ${site.ipHash ? '✅ banido' : '⚠️ sem IP registrado — a pessoa nunca verificou no site, só o ID foi banido'}`);
    if (site.ok && banHw) linhas.push(`**Site (hardware):** ${site.deviceHash ? '✅ banido' : '⚠️ sem hardware registrado — a pessoa nunca verificou no site, só o ID foi banido'}`);

    const detalhesLog = [banIp ? `IP: ${site.ipHash ? 'sim' : 'sem registro'}` : null, banHw ? `hardware: ${site.deviceHash ? 'sim' : 'sem registro'}` : null].filter(Boolean).join(' · ');
    if (discordOk || site.ok) await enviarLog(i.guild, { titulo: '🔨 Banimento', cor: CORES.moderacaoBan, alvo, motivo, por: i.user.tag, detalhes: detalhesLog || undefined });

    const e = new EmbedBuilder()
      .setColor((site.ok || site.ignorado) && discordOk ? CORES.moderacaoBan : CORES.alerta)
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

    const site = valeNoSite(i.guild.id) ? await desbanirNoSite(id) : { ok: true, ignorado: true };
    let discordMsg = '✅ desbanido';
    await i.guild.bans.remove(id, `Desbanido por ${i.user.tag}`).catch((err) => {
      discordMsg = err.code === 10026 ? 'ℹ️ não estava banido no Discord' : `❌ falhou (${err.message})`;
    });

    if (site.ok) await enviarLog(i.guild, { titulo: '♻️ Desbanimento', cor: CORES.sucesso, alvo: { id }, motivo: 'Desban', por: i.user.tag });
    return i.editReply(`**Discord:** ${discordMsg}\n**Site:** ${site.ignorado ? 'ℹ️ não aplicado (este não é o servidor de verificação)' : site.ok ? '✅ removido da lista' : `❌ falhou (${site.error})`}`);
  }

  async function banidos(i) {
    if (!(await podeUsar(i, 'banidos'))) return negar(i);
    if (!valeNoSite(i.guild.id)) return i.reply({ content: 'ℹ️ A lista de banidos do site só aparece no servidor de verificação.', flags: MessageFlags.Ephemeral });
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

  // ---------- Painel de permissões por cargo: VÁRIOS cargos × VÁRIOS comandos de uma vez ----------
  async function permissoesDoCargo(guildId, roleId) {
    const { data, error } = await db.from('cargo_permissoes').select('comando').eq('guild_id', guildId).eq('role_id', roleId);
    if (error) throw new Error(error.message);
    return new Set((data || []).map((r) => r.comando));
  }

  const MODOS = {
    add: { rotulo: '➕ Adicionar', desc: 'dá esses comandos aos cargos (mantém o que já tinham)' },
    rem: { rotulo: '➖ Remover', desc: 'tira esses comandos dos cargos' },
    set: { rotulo: '♻️ Substituir', desc: 'deixa os cargos com SÓ esses comandos' },
  };
  const COMANDOS_VALIDOS = new Set(COMANDOS_CONTROLAVEIS.map((c) => c.nome));

  // Estado do painel de cada admin (cargos/comandos escolhidos). Fica em memória por 30 min:
  // não cabe nos customIds (100 caracteres) e some sozinho se o bot reiniciar.
  const SESSAO_TTL_MS = 30 * 60_000;
  const sessoes = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of sessoes) if (v.ate < agora) sessoes.delete(k);
  }, 60_000).unref();

  function sessaoDe(i, { nova = false } = {}) {
    const chave = `${i.guild.id}:${i.user.id}`;
    let s = sessoes.get(chave);
    if (nova || !s || s.ate < Date.now()) s = { roles: [], cmds: [], modo: 'add', aviso: '' };
    s.ate = Date.now() + SESSAO_TTL_MS;
    sessoes.set(chave, s);
    return s;
  }

  function montarPainel(s) {
    const cargos = s.roles.length ? s.roles.map((r) => `<@&${r}>`).join(' ') : '*nenhum ainda*';
    const cmds = s.cmds.length ? s.cmds.map((c) => `\`/${c}\``).join(' ') : '*nenhum ainda*';
    const e = new EmbedBuilder()
      .setColor(CORES.master)
      .setTitle('🛡️ Permissões por cargo')
      .setDescription(
        [
          '🔐 Os comandos controlados exigem cargo autorizado. Administradores e OWNER continuam com acesso.',
          s.roles.length === 1
            ? '⚡ **Modo rápido:** com 1 cargo, cada clique nos comandos **já salva na hora**.'
            : '**1.** Escolha o(s) **cargo(s)**\n**2.** Marque os **comandos**\n**3.** Se escolheu vários cargos, use o **modo** e toque em **Aplicar**. Com 1 cargo só, salva sozinho.',
          `**Cargos (${s.roles.length}):** ${cargos}`,
          `**Comandos (${s.cmds.length}):** ${cmds}`,
          `**Modo:** ${MODOS[s.modo].rotulo} — ${MODOS[s.modo].desc}`,
          s.aviso,
        ].filter(Boolean).join('\n\n').slice(0, 4000)
      )
      .setFooter(rodapePadrao('Só o OWNER abre este painel · Administrador e dono sempre têm acesso a tudo'));

    const menuCargos = new RoleSelectMenuBuilder()
      .setCustomId('perm|cargos')
      .setPlaceholder('1) Escolha 1 ou mais cargos (até 25)')
      .setMinValues(1)
      .setMaxValues(25);
    if (s.roles.length) menuCargos.setDefaultRoles(...s.roles);

    const menuCmds = new StringSelectMenuBuilder()
      .setCustomId('perm|cmds')
      .setPlaceholder(s.roles.length === 1 ? '2) Marque os comandos (salva na hora)' : '2) Marque 1 ou mais comandos')
      .setMinValues(0)
      .setMaxValues(COMANDOS_CONTROLAVEIS.length)
      .addOptions(
        COMANDOS_CONTROLAVEIS.map((c) => ({ label: `/${c.nome}`, description: `${c.publico ? '🌐' : '🔒'} ${c.desc}`.slice(0, 100), value: c.nome, default: s.cmds.includes(c.nome) }))
      );

    const linhaModos = new ActionRowBuilder().addComponents(
      ...Object.entries(MODOS).map(([k, m]) =>
        new ButtonBuilder().setCustomId(`perm|modo|${k}`).setLabel(m.rotulo).setStyle(s.modo === k ? ButtonStyle.Primary : ButtonStyle.Secondary)
      )
    );
    const linhaAcoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('perm|aplicar').setLabel('✅ Aplicar').setStyle(ButtonStyle.Success).setDisabled(s.roles.length === 1),
      new ButtonBuilder().setCustomId('perm|todos').setLabel('☑️ Todos').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('perm|nenhum').setLabel('⬜ Nenhum').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('perm|resumo').setLabel('📋 Resumo').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('perm|limpar').setLabel('🧹 Limpar').setStyle(ButtonStyle.Secondary)
    );
    return {
      embeds: [e],
      components: [new ActionRowBuilder().addComponents(menuCargos), new ActionRowBuilder().addComponents(menuCmds), linhaModos, linhaAcoes],
    };
  }

  async function abrirPainel(i) {
    if (!ehOwner(i)) return negar(i);
    return i.reply({ ...montarPainel(sessaoDe(i, { nova: true })), flags: MessageFlags.Ephemeral });
  }

  // Modo rápido: com 1 cargo escolhido, os comandos marcados viram exatamente a lista dele (salva na hora).
  async function salvarRapido(i, s) {
    const guildId = i.guild.id;
    cacheConcessoes.clear();
    const role = s.roles[0];
    const del = await db.from('cargo_permissoes').delete().eq('guild_id', guildId).eq('role_id', role);
    if (del.error) throw new Error(del.error.message);
    if (s.cmds.length) {
      const linhas = s.cmds.map((comando) => ({ guild_id: guildId, role_id: role, comando }));
      const ins = await db.from('cargo_permissoes').upsert(linhas, { onConflict: 'guild_id,role_id,comando', ignoreDuplicates: true });
      if (ins.error) throw new Error(ins.error.message);
    }
    s.modo = 'set';
    s.aviso = `✅ **Salvo:** <@&${role}> ${s.cmds.length ? `pode usar ${s.cmds.map((c) => `\`/${c}\``).join(' ')}` : 'não tem nenhum comando liberado'}.`;
    const pub = s.cmds.filter((c) => PUBLICOS.has(c));
    if (pub.length) s.aviso += `\n🔐 Esses comandos agora só podem ser executados pelos cargos liberados e pela administração: ${pub.map((c) => `\`/${c}\``).join(' ')}.`;
    if (role === guildId && s.cmds.length) s.aviso += '\n⚠️ **@everyone** está nessa lista: todo mundo do servidor pode usar esses comandos.';
  }

  async function aplicar(i, s) {
    const guildId = i.guild.id;
    cacheConcessoes.clear();
    if (!s.roles.length) {
      s.aviso = '⚠️ Escolha pelo menos um cargo.';
      return i.update(montarPainel(s));
    }
    if (s.modo !== 'set' && !s.cmds.length) {
      s.aviso = '⚠️ Escolha pelo menos um comando.';
      return i.update(montarPainel(s));
    }

    if (s.modo === 'rem') {
      const r = await db.from('cargo_permissoes').delete().eq('guild_id', guildId).in('role_id', s.roles).in('comando', s.cmds);
      if (r.error) throw new Error(r.error.message);
    } else {
      if (s.modo === 'set') {
        const r = await db.from('cargo_permissoes').delete().eq('guild_id', guildId).in('role_id', s.roles);
        if (r.error) throw new Error(r.error.message);
      }
      if (s.cmds.length) {
        const linhas = s.roles.flatMap((role) => s.cmds.map((comando) => ({ guild_id: guildId, role_id: role, comando })));
        const r = await db.from('cargo_permissoes').upsert(linhas, { onConflict: 'guild_id,role_id,comando', ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message);
      }
    }

    const alvo = `${s.roles.length} cargo(s) × ${s.cmds.length} comando(s)`;
    s.aviso = `✅ **Aplicado** (${MODOS[s.modo].rotulo}): ${alvo}.`;
    const pubs = s.modo === 'rem' ? [] : s.cmds.filter((c) => PUBLICOS.has(c));
    if (pubs.length) s.aviso += `\n🔐 Esses comandos agora só podem ser executados pelos cargos liberados e pela administração: ${pubs.map((c) => `\`/${c}\``).join(' ')}.`;
    if (s.modo !== 'rem' && s.roles.includes(guildId)) s.aviso += '\n⚠️ **@everyone** está nessa lista: todo mundo do servidor passa a poder usar esses comandos.';
    return i.update(montarPainel(s));
  }

  async function handleComponent(i) {
    if (!ehOwner(i)) return negar(i);
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

      const s = sessaoDe(i);
      if (i.isRoleSelectMenu() && i.customId === 'perm|cargos') {
        s.roles = i.values.filter((id) => i.guild.roles.cache.has(id));
        s.aviso = '';
        if (s.roles.length === 1) {
          // Um cargo só: já mostra o que ele tem hoje (e o modo vira "substituir", pra editar direto).
          s.cmds = [...(await permissoesDoCargo(i.guild.id, s.roles[0]))].filter((c) => COMANDOS_VALIDOS.has(c));
          s.modo = 'set';
        }
        return i.update(montarPainel(s));
      }
      if (i.isStringSelectMenu() && i.customId === 'perm|cmds') {
        s.cmds = i.values.filter((v) => COMANDOS_VALIDOS.has(v));
        s.aviso = '';
        if (s.roles.length === 1) await salvarRapido(i, s);
        return i.update(montarPainel(s));
      }
      if (i.isButton() && (i.customId === 'perm|todos' || i.customId === 'perm|nenhum')) {
        s.cmds = i.customId === 'perm|todos' ? COMANDOS_CONTROLAVEIS.map((c) => c.nome) : [];
        s.aviso = '';
        if (s.roles.length === 1) await salvarRapido(i, s);
        return i.update(montarPainel(s));
      }
      if (i.isButton() && i.customId.startsWith('perm|modo|')) {
        const modo = i.customId.split('|')[2];
        if (MODOS[modo]) s.modo = modo;
        s.aviso = '';
        return i.update(montarPainel(s));
      }
      if (i.isButton() && i.customId === 'perm|limpar') {
        s.roles = [];
        s.cmds = [];
        s.aviso = '';
        return i.update(montarPainel(s));
      }
      if (i.isButton() && i.customId === 'perm|aplicar') return await aplicar(i, s);

      // Painel antigo (aberto antes de atualizar o bot): só redesenha no formato novo.
      return i.update(montarPainel(s));
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

  return { handleCommand, handleComponent, gate, podeUsar, temConcessao, banirNoSite, banirViaApi, desbanirViaApi };
}
