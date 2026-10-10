/**
 * Sistema de Moderação por IA (substitui o antigo /antidivulgacao)
 * Módulo único e autoritativo de moderação automática do Eclipse.
 *
 * Como funciona:
 * - TODA mensagem de membros (não-staff) é registrada (histórico persistente no Supabase
 *   + um buffer de contexto em memória por canal).
 * - A mensagem mais recente é avaliada por IA (texto + imagens anexadas) usando o contexto
 *   recente da conversa.
 * - Só quando a IA marca a mensagem como "preocupante" é que algo é enviado para o canal
 *   de moderação configurado — com o conteúdo, a imagem (se houver), o motivo apontado
 *   pela IA e o contexto da conversa.
 * - A equipe decide manualmente: Banir, Mutar ou Deixar passar. Nenhuma ação é automática.
 */
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { gerar, prepararImagem } from './ia.js';
import { CORES, rodapePadrao } from './cores.js';

const COR_ALERTA = CORES.moderacaoAlerta;
const COR_RESOLVIDO_BAN = CORES.moderacaoBan;
const COR_RESOLVIDO_MUTE = CORES.moderacaoMute;
const COR_RESOLVIDO_OK = CORES.moderacaoOk;

const MAX_CONTEXTO_MENSAGENS = 6; // quantas mensagens anteriores entram no contexto passado pra IA
const MUTE_PADRAO_MINUTOS = 30;
const LIMITE_TAMANHO_IMAGEM = 4 * 1024 * 1024; // 4MB, margem de segurança pra não estourar o prompt

// CORREÇÃO (anti-raid): cada mensagem gastava 1 chamada de IA. Num raid/spam isso queima a cota grátis em
// minutos e o bot fica cego pro resto do dia. Agora cada servidor tem um teto de avaliações por minuto.
const LIMITE_IA_POR_MIN = 40;
const usoIA = new Map(); // guildId -> { inicio, n }
function iaDisponivelParaServidor(guildId) {
  const agora = Date.now();
  const u = usoIA.get(guildId);
  if (!u || agora - u.inicio >= 60_000) {
    usoIA.set(guildId, { inicio: agora, n: 1 });
    return true;
  }
  if (u.n >= LIMITE_IA_POR_MIN) return false;
  u.n++;
  return true;
}

export function buildModerationCommands() {
  return new SlashCommandBuilder()
    .setName('moderacao')
    .setDescription('Moderação automática por IA — monitora conversas e sinaliza mensagens preocupantes')
    .addSubcommand((s) =>
      s
        .setName('canal')
        .setDescription('Define o canal onde os alertas da IA são enviados')
        .addChannelOption((o) =>
          o.setName('canal').setDescription('Canal de alertas').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((s) => s.setName('ativar').setDescription('Ativa a moderação automática por IA'))
    .addSubcommand((s) => s.setName('desativar').setDescription('Desativa a moderação automática por IA'))
    .addSubcommand((s) =>
      s
        .setName('tempo_mute')
        .setDescription('Define quantos minutos o botão "Mutar" aplica por padrão')
        .addIntegerOption((o) => o.setName('minutos').setDescription('Minutos').setRequired(true).setMinValue(1).setMaxValue(40320))
    )
    .addSubcommand((s) =>
      s
        .setName('historico')
        .setDescription('Mostra o histórico de mensagens registradas de um usuário')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuário').setRequired(true))
        .addIntegerOption((o) => o.setName('limite').setDescription('Quantidade de mensagens (padrão 20, máx 50)').setMinValue(1).setMaxValue(50))
    )
    .addSubcommand((s) =>
      s.setName('teste').setDescription('Manda um alerta de teste pro canal configurado (pra confirmar que está tudo certo)')
    )
    .addSubcommand((s) =>
      s
        .setName('automod')
        .setDescription('Liga/desliga e ajusta o auto-mod de regras (anti-spam, anti-caps, anti-flood)')
        .addStringOption((o) =>
          o
            .setName('regra')
            .setDescription('Qual regra configurar')
            .setRequired(true)
            .addChoices(
              { name: 'Anti-spam (muitas mensagens rápido)', value: 'antispam' },
              { name: 'Anti-caps (CAIXA ALTA)', value: 'anticaps' },
              { name: 'Anti-flood (mensagem repetida)', value: 'antiflood' }
            )
        )
        .addStringOption((o) =>
          o
            .setName('estado')
            .setDescription('Ativar ou desativar essa regra')
            .addChoices({ name: 'Ativar', value: 'ativar' }, { name: 'Desativar', value: 'desativar' })
        )
        .addIntegerOption((o) =>
          o.setName('limite').setDescription('Anti-spam: nº de mensagens | Anti-flood: nº de repetições | Anti-caps: % de maiúsculas').setMinValue(1)
        )
        .addIntegerOption((o) => o.setName('janela_segundos').setDescription('Anti-spam: janela de tempo em segundos').setMinValue(1).setMaxValue(60))
    )
    .addSubcommand((s) => s.setName('automod_status').setDescription('Mostra o estado atual de todas as regras de auto-mod'))
    .addSubcommand((s) => s.setName('painel_automod').setDescription('Abre um painel visual pra ligar/desligar e ajustar as regras de auto-mod'));
}

export function createModerationSystem({ client, db, getGuildConfig, updateGuildConfig, banirNoSite }) {
  // ---------- Contexto em memória (por canal) ----------
  const contextos = new Map(); // channelId -> [{ autorTag, conteudo, temImagem }]

  function empilharContexto(channelId, entrada) {
    const lista = contextos.get(channelId) || [];
    lista.push(entrada);
    while (lista.length > MAX_CONTEXTO_MENSAGENS) lista.shift();
    contextos.set(channelId, lista);
  }

  function formatarContexto(channelId) {
    const lista = contextos.get(channelId) || [];
    if (!lista.length) return '';
    return lista
      .map((m) => `${m.autorTag}: ${m.conteudo || '(sem texto)'}${m.temImagem ? ' [imagem anexada]' : ''}`)
      .join('\n');
  }

  // ---------- Histórico persistente (Supabase) ----------
  // Requer a tabela `mensagens_log` no Supabase — ver moderation.sql
  async function registrarMensagem(message) {
    const anexos = [...message.attachments.values()].map((a) => ({
      url: a.url,
      tipo: a.contentType || null,
    }));

    empilharContexto(message.channel.id, {
      autorTag: message.author.tag,
      conteudo: message.content,
      temImagem: anexos.some((a) => (a.tipo || '').startsWith('image/')),
    });

    try {
      const { error } = await db.from('mensagens_log').insert({
        guild_id: message.guild.id,
        channel_id: message.channel.id,
        message_id: message.id,
        autor_id: message.author.id,
        autor_tag: message.author.tag,
        conteudo: message.content || '',
        anexos,
        criado_em: new Date().toISOString(),
      });
      if (error) console.error('Erro ao registrar mensagem (moderação):', error.message);
    } catch (err) {
      console.error('Erro ao registrar mensagem (moderação, exceção):', err.message);
    }

    return { anexos };
  }

  // ---------- Avaliação por IA (texto + imagem) ----------
  async function baixarImagemBase64(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) return null;
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > LIMITE_TAMANHO_IMAGEM) return null;
      return await prepararImagem(buffer, contentType.split(';')[0]);
    } catch (err) {
      console.error('Erro ao baixar imagem para avaliação (moderação):', err.message);
      return null;
    }
  }

  // Extrai o primeiro bloco JSON de uma resposta de texto (Groq/OpenRouter às
  // vezes envolvem o JSON em ```json ... ``` mesmo quando pedimos só o JSON).
  function extrairJson(texto) {
    if (!texto) return null;
    const limpo = texto.replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(limpo);
    } catch {
      const match = limpo.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  function normalizarResultado(json) {
    if (!json) return null;
    return {
      preocupante: !!json.preocupante,
      categoria: json.categoria || 'não especificado',
      motivo: json.motivo || '',
    };
  }

  async function avaliarMensagem(message, contextoTexto, imagensBase64) {
    const instrucao = [
      'Classificador de moderação de um Discord brasileiro. Analise SÓ a "mensagem mais recente" (o contexto serve apenas pra entender a situação).',
      'Marque preocupante: QUALQUER xingamento/palavrão (mesmo sem alvo, entre amigos ou de brincadeira), preconceito/discriminação (racismo, machismo, homofobia, xenofobia etc.), assédio/bullying, ameaças, conteúdo sexual (envolvendo menores é sempre gravíssimo), nudez/pornografia, golpes/phishing, divulgação/spam de outros servidores ou produtos, incentivo a automutilação/suicídio, imagens chocantes/violentas.',
      'Não marque: conversa normal, brincadeira sem palavrão, discordância educada. Na dúvida, marque.',
      contextoTexto ? `Contexto:\n${contextoTexto}` : '',
      `Mensagem mais recente (${message.author.tag}): "${(message.content || '(sem texto)').slice(0, 600)}"`,
      imagensBase64.length ? `Há ${imagensBase64.length} imagem(ns) anexada(s): analise também.` : '',
      'Responda só com JSON: {"preocupante": true ou false, "categoria": "curta", "motivo": "curto"}',
    ]
      .filter(Boolean)
      .join('\n');

    // Máx. 2 imagens por mensagem. Sem provedor de visão disponível, avalia só o texto.
    const imagens = imagensBase64.slice(0, 2);
    let texto = await gerar({ prompt: instrucao, imagens, json: true, maxTokens: 120 });
    let semImagem = false;
    if (!texto && imagens.length) {
      texto = await gerar({ prompt: instrucao, json: true, maxTokens: 120 });
      semImagem = true;
    }

    const resultado = normalizarResultado(extrairJson(texto));
    if (!resultado) return { preocupante: false, categoria: null, motivo: null };
    if (semImagem) resultado.motivo = `${resultado.motivo} (⚠️ imagem não analisada, só o texto)`.trim();
    return resultado;
  }

  // ---------- Liberação automática pra staff ----------
  // Dá acesso de visualização ao canal de alertas pra qualquer cargo que já
  // tenha permissão de staff (Gerenciar Mensagens ou Gerenciar Servidor),
  // sem precisar de um comando manual pra isso. Roda tanto na criação do
  // canal quanto em /moderacao teste (auto-correção se o canal já existir
  // mas nenhum cargo de staff tiver sido liberado ainda).
  async function liberarParaStaff(guild, canal) {
    const cargosLiberados = [];
    const cargosStaff = guild.roles.cache.filter(
      (cargo) =>
        cargo.id !== guild.roles.everyone.id &&
        !cargo.managed && // ignora cargos de bots/integrações
        (cargo.permissions.has(PermissionFlagsBits.ManageMessages) || cargo.permissions.has(PermissionFlagsBits.ManageGuild))
    );

    for (const [, cargo] of cargosStaff) {
      const jaTemAcesso = canal.permissionOverwrites.cache.get(cargo.id)?.allow.has(PermissionFlagsBits.ViewChannel);
      if (jaTemAcesso) continue;
      try {
        await canal.permissionOverwrites.edit(cargo.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
        });
        cargosLiberados.push(cargo.name);
      } catch (err) {
        console.error(`Erro ao liberar cargo ${cargo.name} no canal de moderação:`, err.message);
      }
    }
    return cargosLiberados;
  }

  // ---------- Criação automática do canal de alerta ----------
  // Se nenhum canal estiver configurado (nem `/moderacao canal`, nem um canal de
  // logs geral), o bot cria um canal próprio pra não ficar sem mandar os alertas
  // — e já libera automaticamente pra quem tiver cargo de staff.
  async function garantirCanalAlerta(guild) {
    try {
      const canal = await guild.channels.create({
        name: 'logs-moderacao',
        type: ChannelType.GuildText,
        topic: 'Alertas da moderação por IA — canal criado automaticamente pelo Eclipse.',
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: guild.members.me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
        reason: 'Canal de alertas de moderação por IA criado automaticamente (nenhum estava configurado).',
      });
      console.log(`📌 Moderação: criei #${canal.name} automaticamente em ${guild.name} (nenhum canal de alerta estava configurado).`);
      const cargosLiberados = await liberarParaStaff(guild, canal);
      if (cargosLiberados.length) {
        console.log(`📌 Moderação: liberei o cargo(s) ${cargosLiberados.join(', ')} pra ver #${canal.name} em ${guild.name}.`);
      }
      return canal;
    } catch (err) {
      console.error(`❌ Moderação: não consegui criar canal de alerta automático em ${guild.name}:`, err.message);
      return null;
    }
  }

  // ---------- Alerta no canal de moderação ----------
  function botoesAlerta(userId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mod|ban|${userId}`).setLabel('Banir').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
      new ButtonBuilder().setCustomId(`mod|mute|${userId}`).setLabel('Mutar').setStyle(ButtonStyle.Secondary).setEmoji('🔇'),
      new ButtonBuilder().setCustomId(`mod|pass|${userId}`).setLabel('Deixar passar').setStyle(ButtonStyle.Success).setEmoji('✅')
    );
  }

  async function enviarAlerta(message, avaliacao, contextoTexto, anexos) {
    const config = await getGuildConfig(message.guild.id);
    const canalAlertaId = config.moderacao_canal_id || config.logs_canal_id;

    let canal = canalAlertaId ? await client.channels.fetch(canalAlertaId).catch(() => null) : null;

    if (!canal) {
      // Nenhum canal configurado, ou o que estava configurado foi apagado/o bot
      // perdeu acesso — cria um canal próprio pra não deixar o alerta se perder.
      canal = await garantirCanalAlerta(message.guild);
      if (!canal) return; // provavelmente falta permissão de Gerenciar Canais pro bot
      await updateGuildConfig(message.guild.id, { moderacao_canal_id: canal.id });
    }

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Mensagem sinalizada pela IA')
      .setColor(COR_ALERTA)
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: 'Usuário', value: `<@${message.author.id}> (${message.author.tag})`, inline: false },
        { name: 'Canal', value: `${message.channel}`, inline: true },
        { name: 'Categoria (IA)', value: avaliacao.categoria || '—', inline: true },
        { name: 'Motivo (IA)', value: (avaliacao.motivo || '—').slice(0, 1024), inline: false },
        { name: 'Mensagem', value: (message.content || '(sem texto)').slice(0, 1024), inline: false }
      )
      .setFooter(rodapePadrao(`ID da mensagem: ${message.id}`))
      .setTimestamp();

    if (contextoTexto) {
      embed.addFields({ name: 'Contexto recente da conversa', value: contextoTexto.slice(0, 1024) });
    }

    const primeiraImagem = anexos.find((a) => (a.tipo || '').startsWith('image/'));
    if (primeiraImagem) embed.setImage(primeiraImagem.url);

    await canal
      .send({ embeds: [embed], components: [botoesAlerta(message.author.id)] })
      .then(() => console.log(`✅ Alerta de moderação enviado em #${canal.name} (mensagem de ${message.author.tag}).`))
      .catch((err) => console.error('Erro ao enviar alerta de moderação:', err.message));
  }

  // ---------- Auto-mod baseado em regras (sem IA — instantâneo) ----------
  // Roda ANTES da avaliação por IA, pra pegar spam/flood/caps na hora, sem
  // depender de cota de nenhum provedor. Guarda um histórico curto por
  // usuário só em memória (não precisa persistir).
  const historicoAutoMod = new Map(); // "guildId:userId" -> [{ conteudo, timestamp, msg }]
  const infracoesAutoMod = new Map(); // "guildId:userId" -> [timestamps das últimas infrações]

  function registrarNoHistoricoAutoMod(chave, conteudo, msg) {
    const agora = Date.now();
    const lista = historicoAutoMod.get(chave) || [];
    lista.push({ conteudo, timestamp: agora, msg });
    // CORREÇÃO: antes guardava só 30s / 20 msgs, mas o painel deixa configurar janela de até 60s e limite até 50
    // (aí a regra NUNCA disparava). Agora guarda 65s / 60 msgs.
    const filtrada = lista.filter((m) => agora - m.timestamp < 65_000).slice(-60);
    historicoAutoMod.set(chave, filtrada);

    // limpeza: quem parou de falar não fica ocupando memória pra sempre
    if (historicoAutoMod.size > 5000) {
      for (const [k, v] of historicoAutoMod) {
        if (!v.length || agora - v[v.length - 1].timestamp > 65_000) historicoAutoMod.delete(k);
      }
    }
    return filtrada;
  }

  // 3 infrações do auto-mod em 60s = reincidente => timeout (a rajada vira silêncio de verdade)
  function reincidente(chave) {
    const agora = Date.now();
    const lista = (infracoesAutoMod.get(chave) || []).filter((t) => agora - t < 60_000);
    lista.push(agora);
    infracoesAutoMod.set(chave, lista);
    if (infracoesAutoMod.size > 5000) {
      for (const [k, v] of infracoesAutoMod) if (!v.length || agora - v[v.length - 1] > 60_000) infracoesAutoMod.delete(k);
    }
    return lista.length >= 3;
  }

  function verificarAntiSpam(historico, config) {
    if (config.automod_antispam_ativo === false) return null;
    const janelaMs = (config.automod_antispam_janela_seg || 5) * 1000;
    const limite = config.automod_antispam_limite || 5;
    const agora = Date.now();
    const recentes = historico.filter((m) => agora - m.timestamp < janelaMs);
    if (recentes.length >= limite) {
      return `enviou ${recentes.length} mensagens em ${config.automod_antispam_janela_seg}s (limite: ${limite})`;
    }
    return null;
  }

  function verificarAntiFlood(historico, config) {
    if (config.automod_antiflood_ativo === false) return null;
    const repeticoes = config.automod_antiflood_repeticoes || 3;
    if (historico.length < repeticoes) return null;
    const ultimas = historico.slice(-repeticoes);
    const conteudoBase = ultimas[0].conteudo?.trim().toLowerCase();
    if (!conteudoBase) return null;
    const todasIguais = ultimas.every((m) => m.conteudo?.trim().toLowerCase() === conteudoBase);
    if (todasIguais) {
      return `repetiu a mesma mensagem ${repeticoes}x seguidas`;
    }
    return null;
  }

  function verificarAntiCaps(conteudo, config) {
    if (config.automod_anticaps_ativo === false) return null;
    const minimo = config.automod_anticaps_minimo ?? 10;
    const somenteLetras = (conteudo || '').replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (somenteLetras.length < minimo) return null;
    const maiusculas = somenteLetras.replace(/[^A-ZÀ-Ý]/g, '').length;
    const porcentagem = (maiusculas / somenteLetras.length) * 100;
    const limite = config.automod_anticaps_porcentagem ?? 70;
    if (porcentagem >= limite) {
      return `mensagem ${porcentagem.toFixed(0)}% em maiúsculas (limite: ${limite}%)`;
    }
    return null;
  }

  /** Retorna true se tratou a mensagem (apagou por auto-mod) — handleMessage deve parar ali. */
  async function verificarAutoMod(message, config) {
    if (!message.content) return false;

    const chave = `${message.guild.id}:${message.author.id}`;
    const historico = registrarNoHistoricoAutoMod(chave, message.content, message);

    const motivoSpam = verificarAntiSpam(historico, config);
    const motivoFlood = motivoSpam ? null : verificarAntiFlood(historico, config);
    const motivo = motivoSpam || motivoFlood || verificarAntiCaps(message.content, config);

    if (!motivo) return false;

    const podeApagar = message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages);
    if (podeApagar) {
      // CORREÇÃO: antes só a ÚLTIMA mensagem da rajada sumia e o resto do spam ficava no canal.
      let alvos = [message];
      const agora = Date.now();
      if (motivoSpam) {
        const janelaMs = (config.automod_antispam_janela_seg || 5) * 1000;
        alvos = historico.filter((m) => agora - m.timestamp < janelaMs).map((m) => m.msg);
      } else if (motivoFlood) {
        alvos = historico.slice(-(config.automod_antiflood_repeticoes || 3)).map((m) => m.msg);
      }
      for (const alvo of alvos) alvo?.delete().catch(() => {});
    }

    if (reincidente(chave) && message.member?.moderatable) {
      await message.member.timeout(10 * 60 * 1000, 'Auto-mod: reincidência (3 infrações em 60s)').catch(() => {});
    }

    const aviso = await message.channel
      .send(`⚠️ ${message.author}, sua mensagem foi removida pelo auto-mod: **${motivo}**.`)
      .catch(() => null);
    if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 6000);

    // Registra no canal de alerta também, igual a moderação por IA, pra staff
    // ter visibilidade sem precisar confiar só no aviso que some do canal.
    const canalAlertaId = config.moderacao_canal_id || config.logs_canal_id;
    const canalAlerta = canalAlertaId ? await client.channels.fetch(canalAlertaId).catch(() => null) : null;
    if (canalAlerta) {
      const embed = new EmbedBuilder()
        .setTitle('🤖 Auto-mod')
        .setColor(CORES.aviso)
        .setDescription(`${message.author} — ${motivo}`)
        .addFields({ name: 'Canal', value: `${message.channel}`, inline: true })
        .setFooter(rodapePadrao('Ação automática, sem IA'))
        .setTimestamp();
      await canalAlerta.send({ embeds: [embed] }).catch(() => {});
    }

    console.log(`🚫 Auto-mod: mensagem de ${message.author.tag} removida (${motivo}).`);
    return true;
  }

  // ---------- Entrada principal (chamada no messageCreate) ----------
  async function handleMessage(message) {
    if (message.author.bot || !message.guild) return;

    const { anexos } = await registrarMensagem(message);

    const config = await getGuildConfig(message.guild.id);
    // Ativo por padrão (igual o antidivulgação) — só some se alguém desativar
    // explicitamente. Não exige mais um canal configurado de antemão: se não
    // houver `/moderacao canal` definido, usa o canal de logs geral do
    // servidor; se nenhum dos dois existir, o alerta simplesmente não é
    // enviado (mas a avaliação/registro continuam acontecendo normalmente).
    if (config.moderacao_ativo === false) return;

    // Staff (Gerenciar Mensagens) fica de fora da avaliação — mensagens continuam sendo
    // registradas no histórico, só não geram alerta.
    if (message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return;

    // Auto-mod (spam/flood/caps) roda primeiro — é instantâneo, local, e não
    // depende de nenhum provedor de IA. Se ele já tratou a mensagem, para por
    // aqui (não faz sentido mandar pra avaliação de IA uma mensagem já apagada).
    if (await verificarAutoMod(message, config)) return;

    // Teto de avaliações de IA por minuto neste servidor (raid/spam não pode queimar a cota inteira).
    if (!iaDisponivelParaServidor(message.guild.id)) return;

    const imagens = [];
    for (const a of anexos) {
      if ((a.tipo || '').startsWith('image/')) {
        const baixada = await baixarImagemBase64(a.url);
        if (baixada) imagens.push(baixada);
      }
    }

    // Sem imagem e com texto muito curto ("kk", "ok"): não vale gastar IA.
    if (imagens.length === 0 && (message.content || '').trim().length < 4) return;

    const contextoTexto = formatarContexto(message.channel.id);
    const avaliacao = await avaliarMensagem(message, contextoTexto, imagens);

    console.log(
      `🔎 Moderação avaliou mensagem de ${message.author.tag} em #${message.channel.name}: ` +
        `${avaliacao.preocupante ? '⚠️ PREOCUPANTE' : 'ok'}${avaliacao.categoria ? ` (${avaliacao.categoria})` : ''}`
    );

    if (avaliacao.preocupante) {
      await enviarAlerta(message, avaliacao, contextoTexto, anexos);
    }
  }

  // ---------- Botões (Banir / Mutar / Deixar passar) ----------
  async function handleButton(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('mod|')) return false;

    const [, acao, userId] = interaction.customId.split('|');

    // CORREÇÃO DE SEGURANÇA: antes, quem tinha só "Gerenciar Mensagens" conseguia clicar em BANIR.
    // Agora cada botão exige a permissão certa do Discord (ou a permissão dada em /permissoes).
    const exigida = {
      ban: [PermissionFlagsBits.BanMembers, 'Banir Membros'],
      mute: [PermissionFlagsBits.ModerateMembers, 'Moderar Membros'],
    }[acao] || [PermissionFlagsBits.ManageMessages, 'Gerenciar Mensagens'];
    if (!interaction.zoeConcedido && !interaction.member.permissions.has(exigida[0])) {
      return interaction.reply({ content: `🚫 Sem permissão pra essa ação (precisa de **${exigida[1]}**).`, ephemeral: true });
    }

    const config = await getGuildConfig(interaction.guild.id);
    const alvo = await interaction.guild.members.fetch(userId).catch(() => null);

    let resultadoTexto;
    let corFinal;
    let falhou = false; // erro de verdade (diferente de "membro não encontrado"): mantém os botões pra tentar de novo

    if (acao === 'ban') {
      if (!alvo) {
        resultadoTexto = '❌ Membro não encontrado (pode já ter saído do servidor).';
        corFinal = COR_ALERTA;
      } else if (!alvo.bannable) {
        resultadoTexto = '❌ Não consigo banir esse membro (cargo igual/acima do meu, ou é o dono do servidor).';
        corFinal = COR_ALERTA;
      } else {
        // CORREÇÃO: antes o erro do ban era engolido e o bot dizia "foi banido" mesmo se tivesse falhado.
        let banErro = null;
        await alvo.ban({ reason: `Moderação IA — decisão manual de ${interaction.user.tag}` }).catch((err) => {
          banErro = err.message;
        });
        if (banErro) {
          falhou = true;
          resultadoTexto = `❌ Não consegui banir ${alvo.user.tag}: ${banErro}`;
          corFinal = COR_ALERTA;
        } else {
          // Banido pelo bot = banido também no site (só no servidor de verificação)
          const site = banirNoSite
            ? await banirNoSite({ guildId: interaction.guild.id, discordId: alvo.id, username: alvo.user.username, reason: `Moderação IA — decisão manual de ${interaction.user.tag}` }).catch(() => ({ ok: false }))
            : { ok: false };
          resultadoTexto = `🔨 ${alvo.user.tag} foi banido${site.ok ? ' (Discord + site)' : site.ignorado ? ' (só no Discord)' : ' (Discord; falhou ao banir no site)'}.`;
          corFinal = COR_RESOLVIDO_BAN;
        }
      }
    } else if (acao === 'mute') {
      if (!alvo) {
        resultadoTexto = '❌ Membro não encontrado (pode já ter saído do servidor).';
        corFinal = COR_ALERTA;
      } else if (!alvo.moderatable) {
        resultadoTexto = '❌ Não consigo mutar esse membro (cargo igual/acima do meu, ou é o dono do servidor).';
        corFinal = COR_ALERTA;
      } else {
        const minutos = config.moderacao_mute_minutos || MUTE_PADRAO_MINUTOS;
        let muteErro = null;
        await alvo.timeout(minutos * 60 * 1000, `Moderação IA — decisão manual de ${interaction.user.tag}`).catch((err) => {
          muteErro = err.message;
        });
        if (muteErro) {
          falhou = true;
          resultadoTexto = `❌ Não consegui mutar ${alvo.user.tag}: ${muteErro}`;
          corFinal = COR_ALERTA;
        } else {
          resultadoTexto = `🔇 ${alvo.user.tag} foi mutado por ${minutos} minuto(s).`;
          corFinal = COR_RESOLVIDO_MUTE;
        }
      }
    } else if (acao === 'pass') {
      resultadoTexto = '✅ Marcado como ok — nenhuma ação foi tomada.';
      corFinal = COR_RESOLVIDO_OK;
    } else {
      return false;
    }

    if (falhou) return interaction.reply({ content: resultadoTexto, ephemeral: true }); // botões continuam lá

    try {
      const embedAtual = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(corFinal)
        .addFields({ name: 'Resolvido', value: `<@${interaction.user.id}>: ${resultadoTexto}` });
      await interaction.update({ embeds: [embedAtual], components: [] });
    } catch (err) {
      console.error('Erro ao atualizar embed de alerta:', err.message);
      await interaction.reply({ content: resultadoTexto, ephemeral: true }).catch(() => {});
    }
    return true;
  }

  // ---------- Comando /moderacao ----------
  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'moderacao') return false;

    if (!interaction.zoeConcedido && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '🚫 Sem permissão (precisa de Gerenciar Servidor).', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const { guild } = interaction;

    if (sub === 'canal') {
      const canal = interaction.options.getChannel('canal');
      await updateGuildConfig(guild.id, { moderacao_canal_id: canal.id });
      return interaction.reply({ content: `📌 Alertas de moderação por IA serão enviados em ${canal}.`, ephemeral: true });
    }

    if (sub === 'ativar') {
      await updateGuildConfig(guild.id, { moderacao_ativo: true });
      const config = await getGuildConfig(guild.id);
      let canalUsadoId = config.moderacao_canal_id || config.logs_canal_id;
      let criouAgora = false;

      if (!canalUsadoId) {
        const novoCanal = await garantirCanalAlerta(guild);
        if (novoCanal) {
          await updateGuildConfig(guild.id, { moderacao_canal_id: novoCanal.id });
          canalUsadoId = novoCanal.id;
          criouAgora = true;
        }
      }

      if (!canalUsadoId) {
        return interaction.reply({
          content: '✅ Moderação por IA ativada, mas não consegui criar um canal de alerta automaticamente (falta permissão de **Gerenciar Canais** pro bot). Configure um manualmente com `/moderacao canal`.',
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: criouAgora
          ? `✅ Moderação por IA ativada. Como nenhum canal estava configurado, criei <#${canalUsadoId}> automaticamente pra receber os alertas (só o bot enxerga por padrão — dê acesso ao cargo da sua staff se quiser que eles vejam também).`
          : `✅ Moderação por IA ativada. Alertas vão para <#${canalUsadoId}>.`,
        ephemeral: true,
      });
    }

    if (sub === 'desativar') {
      await updateGuildConfig(guild.id, { moderacao_ativo: false });
      return interaction.reply({ content: '🔕 Moderação por IA desativada.', ephemeral: true });
    }

    if (sub === 'tempo_mute') {
      const minutos = interaction.options.getInteger('minutos');
      await updateGuildConfig(guild.id, { moderacao_mute_minutos: minutos });
      return interaction.reply({ content: `⏱️ O botão "Mutar" agora aplica **${minutos} minuto(s)** por padrão.`, ephemeral: true });
    }

    if (sub === 'teste') {
      const config = await getGuildConfig(guild.id);
      const canalAlertaId = config.moderacao_canal_id || config.logs_canal_id;
      let canal = canalAlertaId ? await client.channels.fetch(canalAlertaId).catch(() => null) : null;

      if (!canal) {
        canal = await garantirCanalAlerta(guild);
        if (!canal) {
          return interaction.reply({
            content: '❌ Nenhum canal de alerta configurado e não consegui criar um automaticamente (falta permissão de **Gerenciar Canais** pro bot). Configure um manualmente com `/moderacao canal`.',
            ephemeral: true,
          });
        }
        await updateGuildConfig(guild.id, { moderacao_canal_id: canal.id });
      }

      // Auto-correção: se o canal já existia (de antes desta atualização) e
      // nenhum cargo de staff foi liberado pra vê-lo ainda, libera agora.
      const cargosLiberadosAgora = await liberarParaStaff(guild, canal);

      const embedTeste = new EmbedBuilder()
        .setTitle('🧪 Alerta de teste')
        .setColor(CORES.info)
        .setDescription('Se você está vendo isso, o canal de moderação está configurado corretamente e o bot consegue enviar mensagens nele.')
        .addFields({ name: 'Pedido por', value: `${interaction.user}`, inline: true })
        .setFooter(rodapePadrao('Moderação por IA'))
        .setTimestamp();

      const enviado = await canal.send({ embeds: [embedTeste] }).catch((err) => {
        console.error('Erro ao enviar alerta de teste:', err.message);
        return null;
      });

      if (!enviado) {
        return interaction.reply({
          content: `❌ Achei o canal <#${canal.id}>, mas o envio falhou (provavelmente falta permissão de **Enviar Mensagens** ou **Inserir Links/Embeds** pro bot lá). Veja os logs do Render pro erro exato.`,
          ephemeral: true,
        });
      }

      const avisoCargos = cargosLiberadosAgora.length
        ? ` Liberei o acesso de visualização pro cargo(s) **${cargosLiberadosAgora.join(', ')}** nesse canal (ele era privado até agora).`
        : '';
      return interaction.reply({
        content: `✅ Teste enviado em ${canal}.${avisoCargos} Se ninguém da staff tiver um cargo com Gerenciar Mensagens/Gerenciar Servidor, libere manualmente as permissões do canal pra quem precisar ver.`,
        ephemeral: true,
      });
    }

    if (sub === 'historico') {
      const usuario = interaction.options.getUser('usuario');
      const limite = interaction.options.getInteger('limite') || 20;

      const { data, error } = await db
        .from('mensagens_log')
        .select('*')
        .eq('guild_id', guild.id)
        .eq('autor_id', usuario.id)
        .order('criado_em', { ascending: false })
        .limit(limite);

      if (error) {
        console.error('Erro ao buscar histórico (moderação):', error.message);
        return interaction.reply({ content: '❌ Erro ao buscar histórico no banco de dados.', ephemeral: true });
      }
      if (!data || !data.length) {
        return interaction.reply({ content: 'Nenhuma mensagem registrada para esse usuário ainda.', ephemeral: true });
      }

      const linhas = data.reverse().map((m) => {
        const quando = `<t:${Math.floor(new Date(m.criado_em).getTime() / 1000)}:R>`;
        const anexoTxt = m.anexos && m.anexos.length ? ` 📎x${m.anexos.length}` : '';
        return `${quando} em <#${m.channel_id}>: ${(m.conteudo || '(sem texto)').slice(0, 200)}${anexoTxt}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`📜 Histórico de ${usuario.tag}`)
        .setColor(CORES.neutro)
        .setThumbnail(usuario.displayAvatarURL({ size: 256, dynamic: true }))
        .setDescription(linhas.join('\n').slice(0, 4000))
        .setFooter(rodapePadrao(`${data.length} mensagem(ns) — mais recentes primeiro no chat, mostradas em ordem cronológica`));

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'automod') {
      const regra = interaction.options.getString('regra');
      const estado = interaction.options.getString('estado');
      const limite = interaction.options.getInteger('limite');
      const janela = interaction.options.getInteger('janela_segundos');

      const campos = {};
      const resumo = [];

      if (regra === 'antispam') {
        if (estado) campos.automod_antispam_ativo = estado === 'ativar';
        if (limite) campos.automod_antispam_limite = limite;
        if (janela) campos.automod_antispam_janela_seg = janela;
        resumo.push(`Anti-spam: ${estado ? (estado === 'ativar' ? 'ativado' : 'desativado') : 'sem mudança de estado'}`);
        if (limite) resumo.push(`limite: ${limite} mensagens`);
        if (janela) resumo.push(`janela: ${janela}s`);
      } else if (regra === 'anticaps') {
        if (estado) campos.automod_anticaps_ativo = estado === 'ativar';
        if (limite) campos.automod_anticaps_porcentagem = Math.min(limite, 100);
        resumo.push(`Anti-caps: ${estado ? (estado === 'ativar' ? 'ativado' : 'desativado') : 'sem mudança de estado'}`);
        if (limite) resumo.push(`limite: ${Math.min(limite, 100)}% maiúsculas`);
      } else if (regra === 'antiflood') {
        if (estado) campos.automod_antiflood_ativo = estado === 'ativar';
        if (limite) campos.automod_antiflood_repeticoes = limite;
        resumo.push(`Anti-flood: ${estado ? (estado === 'ativar' ? 'ativado' : 'desativado') : 'sem mudança de estado'}`);
        if (limite) resumo.push(`repetições: ${limite}x`);
      }

      if (!Object.keys(campos).length) {
        return interaction.reply({ content: 'ℹ️ Informe pelo menos "estado" ou "limite"/"janela_segundos" pra essa regra.', ephemeral: true });
      }

      await updateGuildConfig(guild.id, campos);
      return interaction.reply({ content: `✅ ${resumo.join(' — ')}.`, ephemeral: true });
    }

    if (sub === 'automod_status') {
      const c = await getGuildConfig(guild.id);
      const linha = (ativo, detalhe) => (ativo === false ? '🔴 Desativado' : `🟢 Ativado — ${detalhe}`);
      const embed = new EmbedBuilder()
        .setTitle('🤖 Status do Auto-mod')
        .setColor(CORES.info)
        .addFields(
          { name: 'Anti-spam', value: linha(c.automod_antispam_ativo, `${c.automod_antispam_limite} msgs / ${c.automod_antispam_janela_seg}s`) },
          { name: 'Anti-caps', value: linha(c.automod_anticaps_ativo, `${c.automod_anticaps_porcentagem}% maiúsculas (mín. ${c.automod_anticaps_minimo} letras)`) },
          { name: 'Anti-flood', value: linha(c.automod_antiflood_ativo, `${c.automod_antiflood_repeticoes}x repetida`) },
          { name: 'Moderação por IA', value: c.moderacao_ativo === false ? '🔴 Desativada' : '🟢 Ativada' }
        )
        .setFooter(rodapePadrao('Ajuste com /moderacao automod'));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'painel_automod') {
      return interaction.reply({ embeds: [embedSeletorAutomod()], components: [componentesSeletorAutomod()], ephemeral: true });
    }

    return false;
  }

  // ---------- Painel visual do auto-mod ----------
  const REGRAS_AUTOMOD = {
    antispam: {
      label: 'Anti-spam',
      ativoField: 'automod_antispam_ativo',
      campos: [
        { field: 'automod_antispam_limite', label: 'Nº de mensagens (limite)', min: 1, max: 50 },
        { field: 'automod_antispam_janela_seg', label: 'Janela de tempo (segundos)', min: 1, max: 60 },
      ],
    },
    anticaps: {
      label: 'Anti-caps',
      ativoField: 'automod_anticaps_ativo',
      campos: [
        { field: 'automod_anticaps_porcentagem', label: '% de maiúsculas pra disparar', min: 1, max: 100 },
        { field: 'automod_anticaps_minimo', label: 'Mínimo de letras na mensagem', min: 1, max: 500 },
      ],
    },
    antiflood: {
      label: 'Anti-flood',
      ativoField: 'automod_antiflood_ativo',
      campos: [{ field: 'automod_antiflood_repeticoes', label: 'Nº de vezes repetida', min: 1, max: 20 }],
    },
  };

  function embedSeletorAutomod() {
    return new EmbedBuilder()
      .setTitle('🤖 Painel do Auto-mod')
      .setColor(CORES.info)
      .setDescription('Escolha uma regra no menu abaixo pra ver o estado atual e ajustar.')
      .setFooter(rodapePadrao('Auto-mod'));
  }

  function componentesSeletorAutomod() {
    const select = new StringSelectMenuBuilder()
      .setCustomId('automod|regra')
      .setPlaceholder('Escolha uma regra')
      .addOptions(Object.entries(REGRAS_AUTOMOD).map(([key, r]) => ({ label: r.label, value: key })));
    return new ActionRowBuilder().addComponents(select);
  }

  function embedRegra(config, regraKey) {
    const r = REGRAS_AUTOMOD[regraKey];
    const ativo = config[r.ativoField] !== false;
    const linhasValores = r.campos.map((c) => `**${c.label}:** ${config[c.field] ?? 'não configurado'}`).join('\n');
    return new EmbedBuilder()
      .setTitle(`🤖 Auto-mod — ${r.label}`)
      .setColor(ativo ? CORES.sucesso : CORES.erro)
      .setDescription(`Estado: ${ativo ? '🟢 Ativado' : '🔴 Desativado'}\n\n${linhasValores}`)
      .setFooter(rodapePadrao('Auto-mod'));
  }

  function componentesRegra(regraKey, config) {
    const r = REGRAS_AUTOMOD[regraKey];
    const ativo = config[r.ativoField] !== false;
    const botaoToggle = new ButtonBuilder()
      .setCustomId(`automod|toggle|${regraKey}`)
      .setLabel(ativo ? 'Desativar' : 'Ativar')
      .setStyle(ativo ? ButtonStyle.Danger : ButtonStyle.Success);
    const botaoValores = new ButtonBuilder()
      .setCustomId(`automod|valores|${regraKey}`)
      .setLabel('Ajustar valores')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔧');
    return new ActionRowBuilder().addComponents(botaoToggle, botaoValores);
  }

  async function handleAutomodSelect(interaction) {
    if (interaction.customId !== 'automod|regra') return false;
    if (!interaction.zoeConcedido && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '🚫 Sem permissão (precisa de Gerenciar Servidor).', ephemeral: true });
    }
    const regraKey = interaction.values[0];
    const config = await getGuildConfig(interaction.guild.id);
    return interaction.update({ embeds: [embedRegra(config, regraKey)], components: [componentesRegra(regraKey, config)] });
  }

  async function handleAutomodButton(interaction) {
    if (!interaction.customId.startsWith('automod|')) return false;
    if (!interaction.zoeConcedido && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '🚫 Sem permissão (precisa de Gerenciar Servidor).', ephemeral: true });
    }
    const [, acao, regraKey] = interaction.customId.split('|');
    const r = REGRAS_AUTOMOD[regraKey];
    if (!r) return interaction.reply({ content: '❌ Regra desconhecida.', ephemeral: true });

    if (acao === 'toggle') {
      const config = await getGuildConfig(interaction.guild.id);
      const novoAtivo = config[r.ativoField] === false; // se tava false, liga; senão desliga
      await updateGuildConfig(interaction.guild.id, { [r.ativoField]: novoAtivo });
      const configAtualizado = await getGuildConfig(interaction.guild.id);
      return interaction.update({ embeds: [embedRegra(configAtualizado, regraKey)], components: [componentesRegra(regraKey, configAtualizado)] });
    }

    if (acao === 'valores') {
      const config = await getGuildConfig(interaction.guild.id);
      const modal = new ModalBuilder().setCustomId(`automod|valoresmodal|${regraKey}`).setTitle(`Ajustar — ${r.label}`);
      for (const c of r.campos) {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(c.field)
              .setLabel(`${c.label} (${c.min}-${c.max})`)
              .setStyle(TextInputStyle.Short)
              .setValue(config[c.field] != null ? String(config[c.field]) : '')
              .setRequired(true)
          )
        );
      }
      return interaction.showModal(modal);
    }

    return false;
  }

  async function handleAutomodModal(interaction) {
    if (!interaction.customId.startsWith('automod|valoresmodal|')) return false;
    // CORREÇÃO: o modal não conferia permissão (os botões e menus conferiam). Agora confere também.
    if (!interaction.zoeConcedido && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '🚫 Sem permissão (precisa de Gerenciar Servidor).', ephemeral: true });
    }
    const [, , regraKey] = interaction.customId.split('|');
    const r = REGRAS_AUTOMOD[regraKey];
    if (!r) return interaction.reply({ content: '❌ Regra desconhecida.', ephemeral: true });

    const campos = {};
    for (const c of r.campos) {
      const bruto = interaction.fields.getTextInputValue(c.field);
      const valor = parseInt(bruto, 10);
      if (!Number.isInteger(valor) || valor < c.min || valor > c.max) {
        return interaction.reply({ content: `❌ "${c.label}" precisa ser um número inteiro entre ${c.min} e ${c.max}.`, ephemeral: true });
      }
      campos[c.field] = valor;
    }
    await updateGuildConfig(interaction.guild.id, campos);
    return interaction.reply({ content: `✅ Valores de **${r.label}** atualizados.`, ephemeral: true });
  }

  return { handleMessage, handleButton, handleCommand, handleAutomodSelect, handleAutomodButton, handleAutomodModal };
}
