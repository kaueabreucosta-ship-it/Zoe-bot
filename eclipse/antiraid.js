/**
 * Anti-raid da Eclipse (liga/desliga e ajusta com /antiraid).
 *
 * Raid = muita gente entrando de uma vez pra zoar o servidor (spam, convites, @everyone).
 *
 * Como funciona, em português claro:
 *  1. Toda vez que alguém entra, o bot anota (id, hora, nome) numa listinha.
 *  2. Se entrar gente demais rápido (padrão: 6 em 10s) OU várias contas com nome parecido
 *     (joao1, joao2, joao3...) => liga o MODO RAID.
 *  3. No modo raid: pausa convites/DMs do servidor (se tiver permissão), pune quem entrou
 *     (padrão: timeout 10 min) e avisa a staff com botões.
 *  4. Novato (entrou há < 10 min) que manda convite de outro servidor / @everyone / 5+ menções
 *     tem a mensagem apagada e leva timeout. 3 novatos diferentes fazendo isso = modo raid.
 *  5. O modo raid acaba sozinho depois do tempo (ou no botão "Encerrar").
 *
 * Config salva na tabela `antiraid_config` (antiraid.sql). Sem a tabela ele funciona com os
 * padrões, só que mudanças feitas em /antiraid se perdem quando o bot reinicia.
 *
 * Permissões do bot: Moderar Membros (timeout), Expulsar, Banir, Gerenciar Servidor (pausar
 * convites), Gerenciar Mensagens. Intent "Server Members" ligada no Developer Portal.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';
import {
  PADRAO_ANTIRAID,
  ACOES_VALIDAS,
  NOVATO_MINUTOS,
  SINAIS_PARA_RAID,
  mesclarConfig,
  avaliarEntrada,
  analisarMensagemNovato,
  registrarSinal,
  decidirAcao,
} from './antiraid-core.js';

const MAX_SUSPEITOS = 500;
const MAX_PAUSA_MS = 23 * 60 * 60 * 1000; // o Discord só aceita pausar convites/DMs por até 24h

export function buildAntiRaidCommands() {
  return new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Proteção contra raid (entrada em massa de contas)')
    .addSubcommand((s) => s.setName('status').setDescription('Mostra a configuração e se há um raid acontecendo'))
    .addSubcommand((s) =>
      s
        .setName('ligar')
        .setDescription('Botão de pânico: liga o modo raid agora (novatos passam a ser punidos)')
    )
    .addSubcommand((s) => s.setName('desligar').setDescription('Encerra o modo raid (reabre convites e DMs)'))
    .addSubcommand((s) => s.setName('expulsar_suspeitos').setDescription('Expulsa os suspeitos marcados pelo anti-raid (poupa quem já recebeu cargo)'))
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Ajusta o anti-raid')
        .addBooleanOption((o) => o.setName('ativo').setDescription('Liga/desliga a proteção inteira'))
        .addIntegerOption((o) => o.setName('limite').setDescription('Quantas entradas contam como raid (3-50)').setMinValue(3).setMaxValue(50))
        .addIntegerOption((o) => o.setName('janela').setDescription('Em quantos segundos (3-300)').setMinValue(3).setMaxValue(300))
        .addStringOption((o) =>
          o
            .setName('acao')
            .setDescription('O que fazer com os novatos durante o raid')
            .addChoices(
              { name: 'Só alertar (teste, não pune ninguém)', value: 'alertar' },
              { name: 'Timeout (reversível, recomendado)', value: 'timeout' },
              { name: 'Expulsar', value: 'kick' },
              { name: 'Banir', value: 'ban' }
            )
        )
        .addIntegerOption((o) => o.setName('duracao').setDescription('Minutos de modo raid e de timeout (1-1440)').setMinValue(1).setMaxValue(1440))
        .addIntegerOption((o) => o.setName('idade_minima').setDescription('Contas mais novas que X dias levam timeout mesmo sem raid (0 = desligado)').setMinValue(0).setMaxValue(365))
        .addBooleanOption((o) => o.setName('pausar_convites').setDescription('Pausar convites e DMs do servidor durante o raid'))
    );
}

export function createAntiRaidSystem({ client, db, ownerId, getGuildConfig }) {
  const configs = new Map(); // guildId -> { data, expira }
  const sobrescritas = new Map(); // guildId -> config completa (quando o banco falhou)
  const historicos = new Map(); // guildId -> [{ id, t, nome }]
  const sinais = new Map(); // guildId -> [{ id, t }]
  const raids = new Map(); // guildId -> estado do raid
  const suspeitos = new Map(); // guildId -> Set(userId)
  let avisouTabela = false;

  // ---------- Config ----------
  async function getCfg(guildId) {
    const c = configs.get(guildId);
    if (c && c.expira > Date.now()) return c.data;

    let salvo = {};
    const { data, error } = await db.from('antiraid_config').select('*').eq('guild_id', guildId).maybeSingle();
    if (error) {
      if (!avisouTabela) {
        console.warn(`⚠️ Anti-raid: não consegui ler a tabela antiraid_config (${error.message}). Usando os padrões — rode o antiraid.sql no Supabase.`);
        avisouTabela = true;
      }
    } else if (data) {
      salvo = data;
    }
    const mesclado = mesclarConfig({ ...salvo, ...(sobrescritas.get(guildId) || {}) });
    configs.set(guildId, { data: mesclado, expira: Date.now() + 30_000 });
    return mesclado;
  }

  async function setCfg(guildId, campos) {
    const atual = await getCfg(guildId);
    const novo = mesclarConfig({ ...atual, ...campos });
    const linha = { guild_id: guildId, atualizado_em: new Date().toISOString() };
    for (const k of Object.keys(PADRAO_ANTIRAID)) linha[k] = novo[k];

    const { error } = await db.from('antiraid_config').upsert(linha, { onConflict: 'guild_id' });
    configs.set(guildId, { data: novo, expira: Date.now() + 30_000 });
    if (error) {
      sobrescritas.set(guildId, novo);
      console.error('Anti-raid: erro ao salvar config:', error.message);
      return { persistiu: false, cfg: novo };
    }
    sobrescritas.delete(guildId);
    return { persistiu: true, cfg: novo };
  }

  // ---------- Utilidades ----------
  const podeGerir = (i) =>
    !!(i.zoeConcedido || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || (ownerId && i.user.id === ownerId));

  const negar = (i) => i.reply({ content: '🚫 Você precisa de **Gerenciar Servidor** (ou de uma permissão dada em /permissoes).', flags: MessageFlags.Ephemeral });

  function marcarSuspeito(guildId, userId) {
    const set = suspeitos.get(guildId) || new Set();
    set.add(userId);
    while (set.size > MAX_SUSPEITOS) set.delete(set.values().next().value);
    suspeitos.set(guildId, set);
  }

  function botoesRaid() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('antiraid|encerrar').setLabel('Encerrar modo raid').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId('antiraid|expulsar').setLabel('Expulsar suspeitos').setStyle(ButtonStyle.Danger).setEmoji('🧹')
    );
  }

  async function enviarLog(guild, embed, components) {
    try {
      const gc = await getGuildConfig(guild.id);
      const canalId = gc?.logs_canal_id || gc?.moderacao_canal_id;
      if (!canalId) {
        console.warn(`⚠️ Anti-raid: ${guild.name} não tem canal de logs/moderação. Use /moderacao canal pra eu conseguir avisar a staff.`);
        return;
      }
      const canal = await guild.channels.fetch(canalId).catch(() => null);
      if (!canal?.isTextBased()) return;
      await canal.send({ embeds: [embed], ...(components ? { components: [components] } : {}) });
    } catch (err) {
      console.error('Anti-raid: erro ao enviar log:', err.message);
    }
  }

  async function pausarConvites(guild, ms) {
    const ate = new Date(Date.now() + Math.min(ms, MAX_PAUSA_MS));
    try {
      if (typeof guild.setIncidentActions === 'function') {
        await guild.setIncidentActions({ invitesDisabledUntil: ate, dmsDisabledUntil: ate });
        return true;
      }
      if (typeof guild.disableInvites === 'function') {
        await guild.disableInvites(true);
        return true;
      }
    } catch (err) {
      console.error('Anti-raid: não consegui pausar convites (falta Gerenciar Servidor?):', err.message);
    }
    return false;
  }

  async function retomarConvites(guild) {
    try {
      if (typeof guild.setIncidentActions === 'function') {
        await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: null });
      } else if (typeof guild.disableInvites === 'function') {
        await guild.disableInvites(false);
      }
    } catch (err) {
      console.error('Anti-raid: não consegui reabrir convites:', err.message);
    }
  }

  async function aplicarAcao(member, acao, cfg, motivo) {
    const razao = `Anti-raid: ${motivo}`.slice(0, 450);
    try {
      if (acao === 'alertar' || acao === 'nenhuma') return { ok: true };
      if (acao === 'timeout') {
        if (!member.moderatable) return { ok: false, erro: 'sem permissão pra dar timeout nesse membro' };
        await member.timeout(cfg.duracao_min * 60 * 1000, razao);
        return { ok: true };
      }
      if (acao === 'kick') {
        if (!member.kickable) return { ok: false, erro: 'não consigo expulsar esse membro' };
        await member.kick(razao);
        return { ok: true };
      }
      if (acao === 'ban') {
        if (!member.bannable) return { ok: false, erro: 'não consigo banir esse membro' };
        await member.ban({ reason: razao, deleteMessageSeconds: 3600 });
        return { ok: true };
      }
      return { ok: false, erro: `ação desconhecida: ${acao}` };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  }

  function descreverGatilho(g, cfg) {
    if (g.tipo === 'enxurrada') return `${g.quantidade} pessoas entraram em até ${cfg.janela_seg}s`;
    if (g.tipo === 'nomes_parecidos') return `${g.quantidade} contas com nome parecido entraram`;
    if (g.tipo === 'spam_novatos') return `${g.quantidade} novatos diferentes mandaram spam`;
    return g.motivo || 'ativado manualmente';
  }

  // ---------- Modo raid ----------
  function estenderRaid(guild, estado, cfg) {
    estado.ate = Date.now() + cfg.duracao_min * 60 * 1000;
    clearTimeout(estado.timer);
    estado.timer = setTimeout(() => encerrarRaid(guild, 'tempo esgotado').catch((e) => console.error('Anti-raid (encerrar):', e.message)), estado.ate - Date.now());
  }

  async function ativarRaid(guild, gatilho, ids, cfg) {
    let estado = raids.get(guild.id);
    if (estado) {
      estenderRaid(guild, estado, cfg);
      return estado;
    }

    estado = { inicio: Date.now(), ate: 0, timer: null, tratados: new Set(), motivo: descreverGatilho(gatilho, cfg), punidos: 0, falhas: 0, spamBloqueado: 0 };
    raids.set(guild.id, estado); // registra JÁ, pra entradas simultâneas não ativarem 2x
    estenderRaid(guild, estado, cfg);
    console.log(`🚨 Anti-raid: modo raid LIGADO em ${guild.name} (${estado.motivo}).`);

    const pausou = cfg.pausar_convites ? await pausarConvites(guild, cfg.duracao_min * 60 * 1000) : false;

    const erros = new Set();
    for (const id of ids) {
      if (estado.tratados.has(id)) continue;
      estado.tratados.add(id);
      const m = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
      if (!m || m.user.bot) continue;
      const r = await aplicarAcao(m, cfg.acao, cfg, estado.motivo);
      marcarSuspeito(guild.id, id);
      if (r.ok) estado.punidos++;
      else {
        estado.falhas++;
        if (r.erro) erros.add(r.erro);
      }
    }

    const acaoTxt = { alertar: 'só alertar', timeout: `timeout de ${cfg.duracao_min} min`, kick: 'expulsar', ban: 'banir' }[cfg.acao];
    const embed = new EmbedBuilder()
      .setColor(CORES.lockdown)
      .setTitle('🚨 MODO RAID LIGADO')
      .setDescription(`**Motivo:** ${estado.motivo}\nNovatos que entrarem agora vão receber: **${acaoTxt}**.`)
      .addFields(
        { name: '⏱️ Termina', value: `<t:${Math.floor(estado.ate / 1000)}:R> (renova se continuarem entrando)`, inline: true },
        { name: '🔒 Convites e DMs', value: !cfg.pausar_convites ? 'não mexi (desligado)' : pausou ? 'pausados' : '⚠️ não consegui pausar (falta **Gerenciar Servidor**?)', inline: true },
        { name: '👥 Já tratados', value: `${estado.punidos} ok${estado.falhas ? ` · ${estado.falhas} falharam` : ''}`, inline: true }
      )
      .setFooter(rodapePadrao('Anti-raid'))
      .setTimestamp();
    if (erros.size) embed.addFields({ name: '⚠️ Falhas', value: [...erros].join('\n').slice(0, 500) });
    await enviarLog(guild, embed, botoesRaid());
    return estado;
  }

  async function encerrarRaid(guild, por) {
    const estado = raids.get(guild.id);
    if (!estado) return false;
    clearTimeout(estado.timer);
    raids.delete(guild.id);
    const cfg = await getCfg(guild.id);
    if (cfg.pausar_convites) await retomarConvites(guild);
    console.log(`✅ Anti-raid: modo raid ENCERRADO em ${guild.name} (${por}).`);

    const minutos = Math.max(1, Math.round((Date.now() - estado.inicio) / 60000));
    const embed = new EmbedBuilder()
      .setColor(CORES.sucesso)
      .setTitle('✅ Modo raid encerrado')
      .setDescription(`Encerrado por: **${por}**.`)
      .addFields(
        { name: '⏱️ Durou', value: `~${minutos} min`, inline: true },
        { name: '👥 Tratados', value: `${estado.punidos}`, inline: true },
        { name: '🗑️ Spams barrados', value: `${estado.spamBloqueado}`, inline: true }
      )
      .setFooter(rodapePadrao('Anti-raid'))
      .setTimestamp();
    const sobrou = suspeitos.get(guild.id)?.size || 0;
    if (sobrou) embed.addFields({ name: '🧹 Suspeitos marcados', value: `${sobrou} — use **/antiraid expulsar_suspeitos** pra limpar.` });
    await enviarLog(guild, embed);
    return true;
  }

  async function expulsarSuspeitos(guild, por) {
    const set = suspeitos.get(guild.id);
    if (!set || !set.size) return { expulsos: 0, poupados: 0, falhas: 0, total: 0 };
    let expulsos = 0;
    let poupados = 0;
    let falhas = 0;
    const total = set.size;
    for (const id of [...set]) {
      const m = guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null));
      if (!m) continue; // já saiu/foi banido
      // quem já recebeu algum cargo foi aprovado por alguém da staff: poupa
      if (m.roles.cache.size > 1) {
        poupados++;
        continue;
      }
      if (!m.kickable) {
        falhas++;
        continue;
      }
      await m.kick(`Anti-raid: limpeza de suspeitos por ${por}`.slice(0, 450)).then(() => expulsos++).catch(() => falhas++);
    }
    suspeitos.delete(guild.id);
    return { expulsos, poupados, falhas, total };
  }

  // ---------- Evento: alguém entrou ----------
  async function aoEntrar(member) {
    if (member.user.bot) return;
    const { guild } = member;
    const cfg = await getCfg(guild.id);
    if (!cfg.ativo) return;

    const agora = Date.now();
    const hist = historicos.get(guild.id) || [];
    historicos.set(guild.id, hist);
    const { gatilho, janela } = avaliarEntrada(hist, { id: member.id, nome: member.user.username }, cfg, agora);
    if (gatilho) await ativarRaid(guild, gatilho, janela, cfg);

    const estado = raids.get(guild.id);
    const idadeDias = (agora - member.user.createdTimestamp) / 86_400_000;
    const acao = decidirAcao({ raidAtivo: !!estado, idadeDias, cfg });
    if (acao === 'nenhuma') return;

    if (estado) {
      estenderRaid(guild, estado, cfg); // entrou gente nova no meio do raid: o raid continua
      if (estado.tratados.has(member.id)) return;
      estado.tratados.add(member.id);
      const r = await aplicarAcao(member, acao, cfg, estado.motivo);
      marcarSuspeito(guild.id, member.id);
      if (r.ok) estado.punidos++;
      else estado.falhas++;
      return;
    }

    // Conta nova demais (fora de raid): ação leve + um aviso
    const motivo = `conta com ${idadeDias.toFixed(1)} dia(s) (mínimo ${cfg.idade_min_dias})`;
    const r = await aplicarAcao(member, acao, cfg, motivo);
    marcarSuspeito(guild.id, member.id);
    const embed = new EmbedBuilder()
      .setColor(CORES.aviso)
      .setTitle('🆕 Conta muito nova')
      .setDescription(`${member} (\`${member.id}\`) — ${motivo}.\nAção: **${acao === 'alertar' ? 'só alerta' : `timeout de ${cfg.duracao_min} min`}**${r.ok ? '' : ` (falhou: ${r.erro})`}.`)
      .setFooter(rodapePadrao('Anti-raid'))
      .setTimestamp();
    await enviarLog(guild, embed);
  }

  client.on(Events.GuildMemberAdd, (member) => {
    aoEntrar(member).catch((err) => console.error('Anti-raid (entrada):', err.message));
  });

  // ---------- Evento: mensagem de novato ----------
  /** Retorna true se a mensagem foi barrada (aí o index.js para de processar ela). */
  async function handleMessage(message) {
    if (!message.guild || message.author.bot || message.webhookId) return false;
    const membro = message.member;
    if (!membro?.joinedTimestamp) return false;
    const entrouHaMs = Date.now() - membro.joinedTimestamp;
    if (entrouHaMs > NOVATO_MINUTOS * 60 * 1000) return false; // maioria das mensagens sai aqui, de graça
    if (membro.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

    const cfg = await getCfg(message.guild.id);
    if (!cfg.ativo) return false;

    const motivo = analisarMensagemNovato({
      conteudo: message.content || '',
      mencoesUsuarios: message.mentions.users.size,
      mencionaTodos: message.mentions.everyone,
      entrouHaMs,
    });
    if (!motivo) return false;

    const guild = message.guild;
    if (cfg.acao === 'alertar') {
      // modo teste: só avisa, não apaga nem pune
      const embed = new EmbedBuilder()
        .setColor(CORES.aviso)
        .setTitle('👀 Novato suspeito (modo alerta)')
        .setDescription(`${message.author} — ${motivo}.`)
        .setFooter(rodapePadrao('Anti-raid'))
        .setTimestamp();
      await enviarLog(guild, embed);
      return false;
    }

    await message.delete().catch(() => {});
    if (membro.moderatable) await membro.timeout(cfg.duracao_min * 60 * 1000, `Anti-raid: ${motivo}`.slice(0, 450)).catch(() => {});
    marcarSuspeito(guild.id, message.author.id);

    const lista = sinais.get(guild.id) || [];
    sinais.set(guild.id, lista);
    const distintos = registrarSinal(lista, message.author.id, cfg);

    const estado = raids.get(guild.id);
    if (estado) {
      estado.spamBloqueado++;
      estenderRaid(guild, estado, cfg);
    } else {
      const embed = new EmbedBuilder()
        .setColor(CORES.aviso)
        .setTitle('🗑️ Spam de novato barrado')
        .setDescription(`${message.author} (\`${message.author.id}\`) — ${motivo}.\nMensagem apagada e timeout de ${cfg.duracao_min} min.`)
        .addFields({ name: 'Sinais', value: `${distintos}/${SINAIS_PARA_RAID} novatos diferentes (com ${SINAIS_PARA_RAID} liga o modo raid)` })
        .setFooter(rodapePadrao('Anti-raid'))
        .setTimestamp();
      await enviarLog(guild, embed);
    }

    if (distintos >= SINAIS_PARA_RAID && !estado) {
      const ids = [...new Set(lista.map((s) => s.id))];
      await ativarRaid(guild, { tipo: 'spam_novatos', quantidade: distintos }, ids, cfg);
    }
    return true;
  }

  // ---------- Botões ----------
  async function handleButton(interaction) {
    if (!interaction.customId.startsWith('antiraid|')) return false;
    if (!podeGerir(interaction)) return negar(interaction);
    const acao = interaction.customId.split('|')[1];

    if (acao === 'encerrar') {
      const ok = await encerrarRaid(interaction.guild, interaction.user.tag);
      return interaction.reply({ content: ok ? '✅ Modo raid encerrado.' : 'ℹ️ Não havia modo raid ligado.', flags: MessageFlags.Ephemeral });
    }
    if (acao === 'expulsar') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await expulsarSuspeitos(interaction.guild, interaction.user.tag);
      return interaction.editReply(resumoExpulsao(r));
    }
    return false;
  }

  const resumoExpulsao = (r) =>
    r.total
      ? `🧹 Suspeitos marcados: **${r.total}** · expulsos: **${r.expulsos}** · poupados (já têm cargo): **${r.poupados}** · falhas: **${r.falhas}**.`
      : 'ℹ️ Não há suspeitos marcados.';

  // ---------- Comando /antiraid ----------
  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'antiraid') return false;
    if (!podeGerir(interaction)) return negar(interaction);
    const { guild } = interaction;
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const cfg = await getCfg(guild.id);
      const estado = raids.get(guild.id);
      const me = guild.members.me;
      const tem = (p) => (me?.permissions.has(p) ? '✅' : '❌');
      const embed = new EmbedBuilder()
        .setColor(estado ? CORES.lockdown : CORES.info)
        .setTitle('🛡️ Anti-raid')
        .addFields(
          { name: 'Proteção', value: cfg.ativo ? '🟢 Ligada' : '🔴 Desligada', inline: true },
          { name: 'Modo raid agora', value: estado ? `🚨 LIGADO — termina <t:${Math.floor(estado.ate / 1000)}:R>` : '😴 Calmo', inline: true },
          { name: 'Regra', value: `${cfg.limite} entradas em ${cfg.janela_seg}s (ou contas com nome parecido)` },
          { name: 'Ação nos novatos (durante raid)', value: cfg.acao, inline: true },
          { name: 'Duração', value: `${cfg.duracao_min} min`, inline: true },
          { name: 'Idade mínima da conta', value: cfg.idade_min_dias ? `${cfg.idade_min_dias} dia(s)` : 'desligado', inline: true },
          { name: 'Pausar convites/DMs no raid', value: cfg.pausar_convites ? 'sim' : 'não', inline: true },
          {
            name: 'Minhas permissões',
            value: `${tem(PermissionFlagsBits.ModerateMembers)} Moderar Membros · ${tem(PermissionFlagsBits.KickMembers)} Expulsar · ${tem(PermissionFlagsBits.BanMembers)} Banir · ${tem(PermissionFlagsBits.ManageGuild)} Gerenciar Servidor · ${tem(PermissionFlagsBits.ManageMessages)} Gerenciar Mensagens`,
          }
        )
        .setFooter(rodapePadrao('Ajuste com /antiraid config'));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'ligar') {
      const cfg = await getCfg(guild.id);
      if (raids.get(guild.id)) return interaction.reply({ content: 'ℹ️ O modo raid já está ligado.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await ativarRaid(guild, { tipo: 'manual', motivo: `ativado manualmente por ${interaction.user.tag}` }, [], cfg);
      return interaction.editReply('🚨 Modo raid ligado. Novatos que entrarem agora vão ser tratados. Use **/antiraid desligar** quando passar.');
    }

    if (sub === 'desligar') {
      const ok = await encerrarRaid(guild, interaction.user.tag);
      return interaction.reply({ content: ok ? '✅ Modo raid encerrado.' : 'ℹ️ Não havia modo raid ligado.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'expulsar_suspeitos') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await expulsarSuspeitos(guild, interaction.user.tag);
      return interaction.editReply(resumoExpulsao(r));
    }

    if (sub === 'config') {
      const campos = {};
      const o = interaction.options;
      if (o.getBoolean('ativo') !== null) campos.ativo = o.getBoolean('ativo');
      if (o.getInteger('limite') !== null) campos.limite = o.getInteger('limite');
      if (o.getInteger('janela') !== null) campos.janela_seg = o.getInteger('janela');
      if (o.getString('acao') !== null && ACOES_VALIDAS.includes(o.getString('acao'))) campos.acao = o.getString('acao');
      if (o.getInteger('duracao') !== null) campos.duracao_min = o.getInteger('duracao');
      if (o.getInteger('idade_minima') !== null) campos.idade_min_dias = o.getInteger('idade_minima');
      if (o.getBoolean('pausar_convites') !== null) campos.pausar_convites = o.getBoolean('pausar_convites');
      if (!Object.keys(campos).length) return interaction.reply({ content: 'ℹ️ Escolha pelo menos uma opção pra mudar.', flags: MessageFlags.Ephemeral });

      const { persistiu, cfg } = await setCfg(guild.id, campos);
      const linhas = [
        `Proteção: **${cfg.ativo ? 'ligada' : 'desligada'}**`,
        `Regra: **${cfg.limite}** entradas em **${cfg.janela_seg}s**`,
        `Ação: **${cfg.acao}** · duração **${cfg.duracao_min} min**`,
        `Idade mínima: **${cfg.idade_min_dias ? `${cfg.idade_min_dias} dia(s)` : 'desligado'}** · pausar convites: **${cfg.pausar_convites ? 'sim' : 'não'}**`,
      ];
      if (!persistiu) linhas.push('\n⚠️ Não consegui salvar no banco (rodou o `antiraid.sql`?). Vale até o bot reiniciar.');
      return interaction.reply({ content: `✅ Anti-raid atualizado:\n${linhas.join('\n')}`, flags: MessageFlags.Ephemeral });
    }

    return false;
  }

  return { handleCommand, handleButton, handleMessage, estaEmRaid: (guildId) => raids.has(guildId) };
}
