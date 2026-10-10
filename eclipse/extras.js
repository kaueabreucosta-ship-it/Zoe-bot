import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits, ComponentType, MessageFlags
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';

const MOEDA = 'ZC';
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const embed = (title, description, color = CORES.info) => new EmbedBuilder()
  .setTitle(title).setDescription(description).setColor(color).setFooter(rodapePadrao('Eclipse')).setTimestamp();

export function buildExtraCommands() {
  const ticket = new SlashCommandBuilder().setName('ticket').setDescription('Sistema de atendimento por tickets')
    .addSubcommand(s => s.setName('painel').setDescription('Envia o painel para abrir tickets'))
    .addSubcommand(s => s.setName('config').setDescription('Configura categoria e cargo da equipe')
      .addChannelOption(o => o.setName('categoria').setDescription('Categoria dos tickets').addChannelTypes(ChannelType.GuildCategory))
      .addRoleOption(o => o.setName('equipe').setDescription('Cargo da equipe que atende tickets')))
    .addSubcommand(s => s.setName('fechar').setDescription('Fecha o ticket atual'))
    .addSubcommand(s => s.setName('reabrir').setDescription('Reabre o ticket atual'))
    .addSubcommand(s => s.setName('deletar').setDescription('Exclui o ticket atual'))
    .addSubcommand(s => s.setName('adicionar').setDescription('Adiciona alguém ao ticket')
      .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)))
    .addSubcommand(s => s.setName('remover').setDescription('Remove alguém do ticket')
      .addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)))
    .addSubcommand(s => s.setName('renomear').setDescription('Renomeia o ticket')
      .addStringOption(o => o.setName('nome').setDescription('Novo nome').setRequired(true).setMaxLength(80)));

  return [
    new SlashCommandBuilder().setName('ajuda').setDescription('Mostra os comandos da Eclipse'),
    new SlashCommandBuilder().setName('ranking').setDescription('Ranking de ZC'),
    new SlashCommandBuilder().setName('diario').setDescription('Resgata sua recompensa diária'),
    new SlashCommandBuilder().setName('transferir').setDescription('Transfere ZC para outro usuário')
      .addUserOption(o => o.setName('usuario').setDescription('Destinatário').setRequired(true))
      .addIntegerOption(o => o.setName('valor').setDescription('Quantidade de ZC').setRequired(true).setMinValue(1).setMaxValue(1000000)),
    new SlashCommandBuilder().setName('perfil').setDescription('Mostra seu perfil de economia')
      .addUserOption(o => o.setName('usuario').setDescription('Usuário')),
    new SlashCommandBuilder().setName('economia').setDescription('Mostra o painel de economia'),
    ticket,
  ];
}

export function createExtraSystem({ db, client }) {
  async function getSaldo(guildId, userId) {
    const { data } = await db.from('economia').select('saldo,total_ganho,total_apostado').eq('guild_id', guildId).eq('user_id', userId).maybeSingle();
    return data || { saldo: 0, total_ganho: 0, total_apostado: 0 };
  }

  async function ajuda(i) {
    const e = embed('🤖 Eclipse · Central de comandos', 'Tudo organizado por categoria. Toque num comando digitando `/` no chat.')
      .setThumbnail(i.client.user.displayAvatarURL({ size: 256 }));
    e.addFields(
      { name: '💰 Economia', value: '`/saldo` · `/perfil` · `/ranking` · `/diario` · `/transferir` · `/economia`' },
      { name: '🎰 Cassino', value: '`/tigrinho` aposte e dobre · `/cassino slots` · `/cassino moeda`' },
      { name: '🎭 Diversão', value: '`/larp` · `/briga` · `/discussao`' },
      { name: '🎫 Tickets', value: '`/ticket painel` · `fechar` · `reabrir` · `adicionar` · `remover` · `renomear` · `deletar`' },
      { name: '🔨 Banimento', value: '`/banir` · `/desbanir` · `/banidos` · `/permissoes` (admin)' },
      { name: '🛡️ Moderação', value: '`/moderacao` · `/antiraid` · `/nuke`' },
      { name: '💾 Backup', value: '`/backup criar` · `listar` · `info` · `restaurar` · `excluir` (só o dono do bot)' },
      { name: '🧠 IA', value: '`/perguntar` (aceita imagem) · mencione o bot · chame pelo nome · `/iastatus` (admin)' },
      { name: '⚙️ Utilidades', value: '`/cargos` (editar vários cargos e canais de uma vez, admin) · `/contexto` · `/recrutamento` (quando disponível)' }
    );
    return i.reply({ embeds: [e] });
  }

  async function ranking(i) {
    const { data, error } = await db.from('economia').select('user_id,saldo').eq('guild_id', i.guild.id).order('saldo', { ascending: false }).limit(10);
    if (error) return i.reply({ content: '❌ Não consegui carregar o ranking.', flags: MessageFlags.Ephemeral });
    const medalhas = ['🥇', '🥈', '🥉'];
    const linhas = (data || []).map((r, n) => `${medalhas[n] || `**${n + 1}.**`} <@${r.user_id}> · **${fmt(r.saldo)} ${MOEDA}**`);
    const e = embed('🏆 Ranking de ZC', linhas.length ? linhas.join('\n') : 'Ainda não há ninguém no ranking.', CORES.destaque);
    if (i.guild.iconURL()) e.setThumbnail(i.guild.iconURL({ size: 256 }));
    return i.reply({ embeds: [e] });
  }

  // CORREÇÃO: o /diario lia a data, pagava e SÓ DEPOIS gravava a data. Dois comandos quase juntos (clique duplo,
  // lag) passavam os dois pela checagem e a pessoa resgatava 2x. Agora cada usuário só roda um /diario por vez.
  const emDiario = new Set();
  async function diario(i) {
    const chaveDiario = `${i.guild.id}:${i.user.id}`;
    if (emDiario.has(chaveDiario)) return i.reply({ content: '⏳ Calma, estou processando seu diário.', flags: MessageFlags.Ephemeral });
    emDiario.add(chaveDiario);
    try {
      return await diarioSeguro(i);
    } finally {
      emDiario.delete(chaveDiario);
    }
  }

  async function diarioSeguro(i) {
    const { data: atual } = await db.from('daily_rewards').select('claimed_at,streak').eq('guild_id', i.guild.id).eq('user_id', i.user.id).maybeSingle();
    const agora = Date.now();
    const ultima = atual?.claimed_at ? new Date(atual.claimed_at).getTime() : 0;
    if (ultima && agora - ultima < 24 * 60 * 60 * 1000) {
      const horas = Math.ceil((24 * 60 * 60 * 1000 - (agora - ultima)) / 3600000);
      return i.reply({ content: `⏳ Seu diário já foi resgatado. Volte em aproximadamente **${horas}h**.`, flags: MessageFlags.Ephemeral });
    }
    const streak = ultima && agora - ultima <= 48 * 60 * 60 * 1000 ? Number(atual.streak || 0) + 1 : 1;
    const premio = Math.min(10 + streak * 5, 100);
    const { error: premioError } = await db.rpc('eco_premiar', { p_guild: i.guild.id, p_user: i.user.id, p_valor: premio });
    if (premioError) return i.reply({ content: '❌ Não consegui registrar sua recompensa.', flags: MessageFlags.Ephemeral });
    const { error } = await db.from('daily_rewards').upsert({ guild_id: i.guild.id, user_id: i.user.id, claimed_at: new Date().toISOString(), streak }, { onConflict: 'guild_id,user_id' });
    if (error) console.error('Erro diário:', error.message);
    const chama = '🔥'.repeat(Math.min(streak, 7));
    const e = embed('🎁 Recompensa diária', `# +${fmt(premio)} ${MOEDA}\n${chama} Sequência de **${streak} dia(s)**\n*Volte amanhã: o prêmio sobe a cada dia seguido (até 100 ${MOEDA}).*`, CORES.sucesso)
      .setAuthor({ name: i.member?.displayName || i.user.username, iconURL: i.user.displayAvatarURL({ size: 64 }) });
    return i.reply({ embeds: [e] });
  }

  async function transferir(i) {
    const alvo = i.options.getUser('usuario');
    const valor = i.options.getInteger('valor');
    if (alvo.bot || alvo.id === i.user.id) return i.reply({ content: '🚫 Escolha outro usuário real.', flags: MessageFlags.Ephemeral });
    const novoSaldo = await db.rpc('eco_transferir', { p_guild: i.guild.id, p_from: i.user.id, p_to: alvo.id, p_valor: valor });
    if (novoSaldo.error || novoSaldo.data === null) return i.reply({ content: `❌ Saldo insuficiente para transferir **${fmt(valor)} ${MOEDA}**.`, flags: MessageFlags.Ephemeral });
    const e = embed('💸 Transferência concluída', `# ${fmt(valor)} ${MOEDA}\n${i.user} ➜ ${alvo}`, CORES.sucesso)
      .setThumbnail(alvo.displayAvatarURL({ size: 256 }))
      .addFields({ name: '💰 Seu saldo agora', value: `${fmt(novoSaldo.data)} ${MOEDA}`, inline: true });
    return i.reply({ embeds: [e] });
  }

  async function perfil(i) {
    const user = i.options.getUser('usuario') || i.user;
    const s = await getSaldo(i.guild.id, user.id);
    const e = embed(`👤 Perfil · ${user.username}`, `# ${fmt(s.saldo)} ${MOEDA}`);
    e.setThumbnail(user.displayAvatarURL({ size: 256 }));
    e.addFields(
      { name: '📈 Total ganho', value: `${fmt(s.total_ganho)} ${MOEDA}`, inline: true },
      { name: '🎰 Total apostado', value: `${fmt(s.total_apostado)} ${MOEDA}`, inline: true }
    );
    return i.reply({ embeds: [e] });
  }

  async function economia(i) {
    const e = embed('💰 Economia da Eclipse', 'Junte **ZC** conversando, resgate o bônus diário e arrisque no cassino.')
      .addFields(
        { name: '📥 Como ganhar', value: 'Converse no servidor (mensagens de verdade) · `/diario` · vitórias no cassino', inline: false },
        { name: '🎰 Como gastar', value: '`/tigrinho` perdeu, perde a aposta; ganhou, **dobra** · `/cassino slots` · `/cassino moeda`', inline: false },
        { name: '👛 Carteira', value: '`/saldo` · `/perfil` · `/ranking` · `/transferir`', inline: false }
      );
    return i.reply({ embeds: [e] });
  }

  async function ticketConfig(i) {
    if (!i.zoeConcedido && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({ content: '🚫 Você precisa de **Gerenciar Servidor**.', flags: MessageFlags.Ephemeral });
    const categoria = i.options.getChannel('categoria');
    const equipe = i.options.getRole('equipe');
    const patch = { guild_id: i.guild.id, updated_at: new Date().toISOString() };
    if (categoria) patch.category_id = categoria.id;
    if (equipe) patch.staff_role_id = equipe.id;
    await db.from('ticket_config').upsert(patch, { onConflict: 'guild_id' });
    return i.reply({ embeds: [embed('⚙️ Tickets configurados', `Categoria: ${categoria ? categoria : 'mantida'}\nEquipe: ${equipe ? equipe : 'mantida'}`, CORES.sucesso)], flags: MessageFlags.Ephemeral });
  }

  async function ticketPainel(i) {
    if (!i.zoeConcedido && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({ content: '🚫 Você precisa de **Gerenciar Servidor**.', flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket|abrir').setLabel('🎫 Abrir ticket').setStyle(ButtonStyle.Danger));
    return i.reply({ embeds: [embed('🎫 Atendimento', 'Precisa de ajuda? Clique no botão abaixo para abrir seu ticket privado.')], components: [row] });
  }

  // CORREÇÃO: abrir ticket não tinha try/catch (sem permissão do bot = "interação falhou" sem explicação), não
  // impedia clique duplo (2 canais) e não tinha cooldown (raid enchendo o servidor de canais).
  const abrindoTicket = new Set();
  const ultimoTicket = new Map();
  async function abrirTicket(i) {
    const chave = `${i.guild.id}:${i.user.id}`;
    if (abrindoTicket.has(chave)) return i.reply({ content: '⏳ Já estou criando seu ticket.', flags: MessageFlags.Ephemeral });
    const espera = 60_000 - (Date.now() - (ultimoTicket.get(chave) || 0));
    if (espera > 0) return i.reply({ content: `⏳ Espere ${Math.ceil(espera / 1000)}s pra abrir outro ticket.`, flags: MessageFlags.Ephemeral });
    abrindoTicket.add(chave);
    try {
      const r = await abrirTicketSeguro(i);
      ultimoTicket.set(chave, Date.now());
      if (ultimoTicket.size > 2000) ultimoTicket.clear();
      return r;
    } catch (err) {
      console.error('Erro ao abrir ticket:', err.message);
      const msg = { content: '❌ Não consegui criar o ticket. Avise a staff (o bot precisa de **Gerenciar Canais**).', flags: MessageFlags.Ephemeral };
      return i.replied || i.deferred ? i.followUp(msg).catch(() => {}) : i.reply(msg).catch(() => {});
    } finally {
      abrindoTicket.delete(chave);
    }
  }

  async function abrirTicketSeguro(i) {
    const { data: cfg } = await db.from('ticket_config').select('*').eq('guild_id', i.guild.id).maybeSingle();
    const { data: existente } = await db.from('tickets').select('*').eq('guild_id', i.guild.id).eq('user_id', i.user.id).eq('status', 'open').maybeSingle();
    if (existente) return i.reply({ content: `🎫 Você já tem um ticket aberto: <#${existente.channel_id}>`, flags: MessageFlags.Ephemeral });
    const overwrites = [
      { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    if (cfg?.staff_role_id) overwrites.push({ id: cfg.staff_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const ch = await i.guild.channels.create({ name: `ticket-${i.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || i.user.id.slice(-6)}`, type: ChannelType.GuildText, parent: cfg?.category_id || undefined, permissionOverwrites: overwrites, reason: `Ticket aberto por ${i.user.tag}` });
    await db.from('tickets').insert({ guild_id: i.guild.id, channel_id: ch.id, user_id: i.user.id, status: 'open' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket|fechar').setLabel('🔒 Fechar').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket|deletar').setLabel('🗑️ Excluir').setStyle(ButtonStyle.Danger)
    );
    await ch.send({ content: `${i.user}`, embeds: [embed('🎫 Ticket aberto', 'Explique seu problema com o máximo de detalhes. A equipe poderá atender aqui.')], components: [row] });
    return i.reply({ content: `✅ Ticket criado: ${ch}`, flags: MessageFlags.Ephemeral });
  }

  async function ticketAtual(i) { return (await db.from('tickets').select('*').eq('channel_id', i.channel.id).maybeSingle()).data; }
  async function fechar(i, reabrir = false) {
    const t = await ticketAtual(i); if (!t) return i.reply({ content: '🚫 Este canal não é um ticket.', flags: MessageFlags.Ephemeral });
    const pode = i.user.id === t.user_id || i.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
    if (!pode) return i.reply({ content: '🚫 Você não pode alterar este ticket.', flags: MessageFlags.Ephemeral });
    if (reabrir) {
      await i.channel.permissionOverwrites.edit(t.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await db.from('tickets').update({ status: 'open', closed_at: null }).eq('channel_id', i.channel.id);
      return i.reply({ embeds: [embed('🔓 Ticket reaberto', 'O atendimento foi reaberto.', CORES.sucesso)] });
    }
    await i.channel.permissionOverwrites.edit(t.user_id, { SendMessages: false });
    await db.from('tickets').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('channel_id', i.channel.id);
    return i.reply({ embeds: [embed('🔒 Ticket fechado', 'O ticket foi fechado. Um responsável pode reabri-lo.', CORES.ticketFechado)] });
  }

  async function deletar(i) {
    const t = await ticketAtual(i); if (!t) return i.reply({ content: '🚫 Este canal não é um ticket.', flags: MessageFlags.Ephemeral });
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageChannels) && i.user.id !== t.user_id) return i.reply({ content: '🚫 Você não pode excluir este ticket.', flags: MessageFlags.Ephemeral });
    await i.reply({ content: '🗑️ Excluindo ticket...', flags: MessageFlags.Ephemeral });
    await db.from('tickets').delete().eq('channel_id', i.channel.id);
    return i.channel.delete(`Ticket excluído por ${i.user.tag}`);
  }

  async function handleCommand(i) {
    if (i.commandName === 'ajuda') return ajuda(i);
    if (i.commandName === 'ranking') return ranking(i);
    if (i.commandName === 'diario') return diario(i);
    if (i.commandName === 'transferir') return transferir(i);
    if (i.commandName === 'perfil') return perfil(i);
    if (i.commandName === 'economia') return economia(i);
    if (i.commandName !== 'ticket') return;
    const sub = i.options.getSubcommand();
    if (sub === 'painel') return ticketPainel(i);
    if (sub === 'config') return ticketConfig(i);
    if (sub === 'fechar') return fechar(i);
    if (sub === 'reabrir') return fechar(i, true);
    if (sub === 'deletar') return deletar(i);
    const t = await ticketAtual(i); if (!t) return i.reply({ content: '🚫 Use este comando dentro de um ticket.', flags: MessageFlags.Ephemeral });
    // CORREÇÃO DE SEGURANÇA: antes qualquer um que enxergasse o ticket podia adicionar/remover gente e renomear.
    // Adicionar: dono do ticket ou staff. Remover/renomear: só quem tem Gerenciar Canais.
    const ehStaff = !!i.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
    if (sub === 'adicionar' && !ehStaff && i.user.id !== t.user_id) return i.reply({ content: '🚫 Só o dono do ticket ou a staff podem adicionar pessoas.', flags: MessageFlags.Ephemeral });
    if ((sub === 'remover' || sub === 'renomear') && !ehStaff) return i.reply({ content: '🚫 Precisa de **Gerenciar Canais**.', flags: MessageFlags.Ephemeral });
    if (sub === 'adicionar') {
      const u = i.options.getUser('usuario'); await i.channel.permissionOverwrites.edit(u.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return i.reply(`✅ ${u} foi adicionado ao ticket.`);
    }
    if (sub === 'remover') {
      const u = i.options.getUser('usuario'); await i.channel.permissionOverwrites.delete(u.id).catch(() => {}); return i.reply(`✅ ${u} foi removido do ticket.`);
    }
    if (sub === 'renomear') {
      const nome = i.options.getString('nome').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90); await i.channel.setName(nome); return i.reply(`✏️ Ticket renomeado para **${nome}**.`);
    }
  }

  async function handleInteraction(i) {
    if (!i.isButton() || !i.customId.startsWith('ticket|')) return false;
    if (i.customId === 'ticket|abrir') return abrirTicket(i);
    if (i.customId === 'ticket|fechar') return fechar(i);
    if (i.customId === 'ticket|deletar') return deletar(i);
    return false;
  }
  return { handleCommand, handleInteraction };
}
