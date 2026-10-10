/**
 * Duelos entre usuários (brincadeira):
 *  - /larp  → cada um manda uma imagem "luxuosa"; a IA (visão) decide quem foi mais luxuoso.
 *  - /briga → a IA narra uma briga ENGRAÇADA entre os dois e decide quem ganha.
 *  - /discussao → cria um canal público onde só os 2 podem falar; 15 min depois a IA julga quem ganhou.
 * Nos três, o perdedor aparece com o título "MOGGADO".
 */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';
import { baixarAvatar, gerarImagemMogged } from './moggedimg.js';
import { gerar, prepararImagem } from './ia.js';

const TEMPO_ENVIO_IMAGENS_MS = 2 * 60 * 1000; // 2 min pra os dois mandarem a imagem
const COOLDOWN_MS = 30 * 1000; // por usuário que inicia o duelo
const MAX_BYTES_IMAGEM = 8 * 1024 * 1024; // 8 MB
const TEMPO_DISCUSSAO_MS = 15 * 60 * 1000; // duração da discussão
const TEMPO_ACEITAR_MS = 60 * 1000; // tempo pro desafiado aceitar
const COOLDOWN_DISCUSSAO_MS = 2 * 60 * 1000;
const MAX_DISCUSSOES_POR_SERVIDOR = 3;
const MAX_MSGS_TRANSCRICAO = 80; // só as mais recentes vão pro juiz
const MAX_CHARS_POR_MSG = 160;
const APAGAR_CANAL_DEPOIS_MS = 60 * 1000; // canal some 1 min depois do veredito
const TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function buildDuelCommands() {
  return [
    new SlashCommandBuilder()
      .setName('larp')
      .setDescription('Competição de LARP: quem manda a imagem mais luxuosa? A IA decide')
      .addUserOption((o) => o.setName('oponente').setDescription('Quem vai competir contra você').setRequired(true)),
    new SlashCommandBuilder()
      .setName('briga')
      .setDescription('A IA decide quem ganha uma briga (de zoeira) entre vocês dois')
      .addUserOption((o) => o.setName('oponente').setDescription('Quem vai brigar com você').setRequired(true)),
    new SlashCommandBuilder()
      .setName('discussao')
      .setDescription('Cria um canal público só pra vocês dois discutirem; em 15 min a IA decide quem ganhou')
      .addUserOption((o) => o.setName('oponente').setDescription('Quem vai discutir com você').setRequired(true)),
  ];
}

// Extrai o primeiro objeto JSON de um texto (a IA às vezes devolve ```json ... ```)
function extrairJson(texto) {
  if (!texto) return null;
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function baixarImagem(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) }); // CORREÇÃO: sem timeout, um link lento travava o duelo
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const mimeType = (resp.headers.get('content-type') || '').split(';')[0].trim();
  if (!TIPOS_ACEITOS.includes(mimeType)) throw new Error('Tipo de imagem não suportado');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES_IMAGEM) throw new Error('Imagem grande demais');
  return prepararImagem(buf, mimeType); // reduz pra gastar menos tokens
}

function pegarImagemDaMensagem(message) {
  return message.attachments.find((a) => TIPOS_ACEITOS.includes((a.contentType || '').split(';')[0].trim()));
}

export function createDuelSystem({ client, gerarTexto }) {
  const duelosAtivos = new Set(); // channelId — 1 duelo por canal
  const discussoesPorServidor = new Map(); // guildId -> quantidade ativa
  const usuariosEmDiscussao = new Set(); // userId
  const cooldowns = new Map(); // userId -> timestamp

  function checarCooldown(userId, ms = COOLDOWN_MS) {
    const agora = Date.now();
    const ultima = cooldowns.get(userId) || 0;
    if (agora - ultima < ms) return Math.ceil((ms - (agora - ultima)) / 1000);
    cooldowns.set(userId, agora);
    setTimeout(() => cooldowns.delete(userId), ms);
    return 0;
  }

  // Resultado do perdedor: imagem desenhada (foto de perfil + "MOGGED" + nick) dentro de um embed.
  // Se o canvas não estiver disponível, cai no embed simples com a foto de perfil.
  async function montarMoggado({ guild, perdedor, vencedor, motivo, tipo }) {
    const membro = await guild.members.fetch(perdedor.id).catch(() => null);
    const nome = membro?.displayName || perdedor.displayName || perdedor.username;
    const avatarUrl = (membro || perdedor).displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });

    let png = null;
    try {
      png = await gerarImagemMogged({ nome, avatarBuffer: await baixarAvatar(avatarUrl) });
    } catch (err) {
      console.error('Erro ao desenhar o MOGGED:', err.message);
    }

    const embed = new EmbedBuilder()
      .setColor(CORES.erro)
      .setDescription(`**${nome}** foi mogged por ${vencedor}!\n\n${motivo}`.slice(0, 3500))
      .setFooter(rodapePadrao(tipo));
    if (png) embed.setImage('attachment://mogged.png');
    else embed.setTitle('💀 MOGGED').setAuthor({ name: nome, iconURL: avatarUrl }).setImage(avatarUrl);

    // função, pra poder enviar o mesmo resultado em mais de um canal
    return () => ({ embeds: [embed], files: png ? [new AttachmentBuilder(png, { name: 'mogged.png' })] : [] });
  }

  // ---------- /larp ----------
  async function rodarLarp(interaction, a, b) {
    const canal = interaction.channel;
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(CORES.master)
          .setTitle('💎 Competição de LARP')
          .setDescription(
            `${a} vs ${b}\n\nOs dois têm **2 minutos** pra mandar **uma imagem luxuosa** aqui no canal ` +
              `(carro, mansão, relógio, jogo, skin, o que quiser). A IA decide quem foi mais luxuoso e o outro é **moggado**.`
          )
          .setFooter(rodapePadrao('LARP')),
      ],
    });

    const imagens = new Map(); // userId -> attachment
    const coletor = canal.createMessageCollector({
      filter: (m) => !m.author.bot && (m.author.id === a.id || m.author.id === b.id) && !!pegarImagemDaMensagem(m),
      time: TEMPO_ENVIO_IMAGENS_MS,
    });

    coletor.on('collect', (m) => {
      if (imagens.has(m.author.id)) return; // vale só a primeira imagem de cada um
      imagens.set(m.author.id, pegarImagemDaMensagem(m));
      m.react('✅').catch(() => {});
      if (imagens.size === 2) coletor.stop('completo');
    });

    coletor.on('end', async (_c, motivo) => {
      try {
        if (motivo !== 'completo') {
          const faltou = [a, b].filter((u) => !imagens.has(u.id)).map((u) => `${u}`).join(' e ');
          await canal.send(`⌛ Tempo esgotado! ${faltou} não mandou imagem. Duelo cancelado.`);
          return;
        }

        await canal.sendTyping().catch(() => {});
        const [imgA, imgB] = await Promise.all([baixarImagem(imagens.get(a.id).url), baixarImagem(imagens.get(b.id).url)]);

        const prompt = [
          'Juiz de uma zoeira entre amigos: "LARP de luxo". A 1ª imagem é do competidor 1 e a 2ª do competidor 2.',
          'Decida qual é mais LUXUOSA/flex (carros, mansões, relógios, itens raros, skins, conquistas, estética de riqueza). Julgue só o luxo da imagem, sem comentário preconceituoso sobre pessoas.',
          'Responda só com JSON: {"vencedor": 1 ou 2, "motivo": "até 2 frases curtas em português, zoando levemente o perdedor"}',
        ].join('\n');

        const texto = await gerar({ prompt, imagens: [imgA, imgB], json: true, maxTokens: 200 });
        if (!texto) throw new Error('Nenhum provedor de IA com visão disponível (cota esgotada?)');
        const json = extrairJson(texto);
        const v = Number(json?.vencedor);
        if (v !== 1 && v !== 2) throw new Error('Resposta inválida da IA');

        const vencedor = v === 1 ? a : b;
        const perdedor = v === 1 ? b : a;
        const resultado = await montarMoggado({
          guild: interaction.guild,
          perdedor,
          vencedor,
          motivo: String(json.motivo || 'Faltou luxo.'),
          tipo: 'LARP',
        });
        await canal.send(resultado());
      } catch (err) {
        console.error('Erro no /larp:', err.message);
        await canal.send('❌ A IA não conseguiu julgar agora (limite de uso atingido ou imagem ruim). Tentem de novo daqui a pouco.').catch(() => {});
      } finally {
        duelosAtivos.delete(canal.id);
      }
    });
  }

  // ---------- /briga ----------
  async function rodarBriga(interaction, a, b) {
    await interaction.deferReply();
    try {
      // Um empurrãozinho de sorte pra não ficar sempre previsível
      const sorte = Math.random() < 0.5 ? 1 : 2;
      const prompt = [
        'Narrador de uma briga ENGRAÇADA e exagerada (estilo desenho/anime/luta de videogame) entre dois amigos.',
        `Competidor 1: ${a.displayName} | Competidor 2: ${b.displayName}`,
        `A sorte deste round favorece o ${sorte}, mas você decide. Sem sangue, gore, violência sexual ou preconceito: zoeira leve com golpes ridículos e memes.`,
        'Narre em no máximo 4 frases curtas, em português. Responda só com JSON: {"vencedor": 1 ou 2, "narracao": "..."}',
      ].join('\n');

      const texto = await gerarTexto(prompt, { json: true, maxTokens: 250 });
      const json = extrairJson(texto);
      const v = Number(json?.vencedor);
      if (v !== 1 && v !== 2) throw new Error('Resposta inválida da IA');

      const vencedor = v === 1 ? a : b;
      const perdedor = v === 1 ? b : a;
      const resultado = await montarMoggado({
        guild: interaction.guild,
        perdedor,
        vencedor,
        motivo: String(json.narracao || 'Foi uma luta intensa.'),
        tipo: 'Briga',
      });
      await interaction.editReply(resultado());
    } catch (err) {
      console.error('Erro no /briga:', err.message);
      await interaction.editReply('❌ A briga travou (a IA não respondeu direito). Tenta de novo.').catch(() => {});
    } finally {
      duelosAtivos.delete(interaction.channelId);
    }
  }

  // ---------- /discussao ----------
  function liberarDiscussao(guildId, ...userIds) {
    const n = (discussoesPorServidor.get(guildId) || 1) - 1;
    if (n <= 0) discussoesPorServidor.delete(guildId);
    else discussoesPorServidor.set(guildId, n);
    userIds.forEach((id) => usuariosEmDiscussao.delete(id));
  }

  async function julgarDiscussao(a, b, transcricao) {
    const linhas = transcricao.map((t) => `${t.competidor === 1 ? a.displayName : b.displayName}: ${t.texto}`).join('\n');
    const prompt = [
      'Juiz de uma DISCUSSÃO DE ECLIPSEIRA (roast battle) entre dois amigos, 15 minutos de provocações.',
      `Competidor 1: ${a.displayName} | Competidor 2: ${b.displayName}`,
      'Critérios: criatividade, humor, revidar no ponto, consistência, controle da discussão. Repetir a mesma ofensa ou spammar não ganha ponto. Palavrão e zoeira pesada são normais; preconceito real, ameaça real ou assédio sério devem ser penalizados.',
      'Responda só com JSON: {"vencedor": 1 ou 2, "motivo": "até 3 frases curtas em português citando o melhor momento"}',
      'Transcrição (em ordem):',
      linhas,
    ].join('\n');
    const json = extrairJson(await gerarTexto(prompt, { json: true, maxTokens: 200 }));
    const v = Number(json?.vencedor);
    if (v !== 1 && v !== 2) throw new Error('Resposta inválida da IA');
    return { vencedor: v, motivo: String(json.motivo || 'Ganhou nos argumentos.') };
  }

  async function rodarDiscussao(interaction, a, b) {
    const guild = interaction.guild;
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels))
      return interaction.reply({ content: '🚫 Eu preciso da permissão **Gerenciar Canais** pra criar o canal da discussão.', ephemeral: true });
    if ((discussoesPorServidor.get(guild.id) || 0) >= MAX_DISCUSSOES_POR_SERVIDOR)
      return interaction.reply({ content: `⏳ Já tem ${MAX_DISCUSSOES_POR_SERVIDOR} discussões rolando neste servidor. Espera uma acabar.`, ephemeral: true });
    if (usuariosEmDiscussao.has(a.id) || usuariosEmDiscussao.has(b.id))
      return interaction.reply({ content: '⏳ Um de vocês já está numa discussão.', ephemeral: true });

    const restante = checarCooldown(a.id, COOLDOWN_DISCUSSAO_MS);
    if (restante) return interaction.reply({ content: `⏳ Aguarde **${restante}s** pra iniciar outra discussão.`, ephemeral: true });

    // Reserva a vaga já (evita duas discussões simultâneas dos mesmos usuários)
    discussoesPorServidor.set(guild.id, (discussoesPorServidor.get(guild.id) || 0) + 1);
    usuariosEmDiscussao.add(a.id);
    usuariosEmDiscussao.add(b.id);

    const botoes = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('disc|aceitar').setLabel('Aceitar').setStyle(ButtonStyle.Danger).setEmoji('🔥'),
      new ButtonBuilder().setCustomId('disc|recusar').setLabel('Recusar').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      content: `${b}`,
      embeds: [
        new EmbedBuilder()
          .setColor(CORES.master)
          .setTitle('🗣️ Desafio de discussão')
          .setDescription(
            `${a} te desafiou pra uma discussão de **15 minutos** num canal público, onde **só vocês dois** podem falar.\n` +
              `Todo mundo assiste. No final a IA decide quem ganhou e o outro é **moggado**.\n\n` +
              `Só ${b} pode aceitar (60s).`
          )
          .setFooter(rodapePadrao('Discussão')),
      ],
      components: [botoes],
      allowedMentions: { users: [b.id] },
    });
    const convite = await interaction.fetchReply();

    const resposta = await convite
      .awaitMessageComponent({
        componentType: ComponentType.Button,
        time: TEMPO_ACEITAR_MS,
        filter: (i) => {
          if (i.user.id === b.id) return true;
          i.reply({ content: `🚫 Só ${b} pode responder esse desafio.`, ephemeral: true }).catch(() => {});
          return false;
        },
      })
      .catch(() => null);

    if (!resposta || resposta.customId !== 'disc|aceitar') {
      liberarDiscussao(guild.id, a.id, b.id);
      const texto = resposta ? `🏳️ ${b} recusou o desafio.` : '⌛ O desafio expirou sem resposta.';
      if (resposta) await resposta.update({ content: texto, embeds: [], components: [] }).catch(() => {});
      else await interaction.editReply({ content: texto, embeds: [], components: [] }).catch(() => {});
      return;
    }

    let canal;
    try {
      const nomeBase = `discussao-${a.username}-vs-${b.username}`.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 90) || 'discussao';
      canal = await guild.channels.create({
        name: nomeBase,
        type: ChannelType.GuildText,
        parent: interaction.channel?.parentId ?? null,
        topic: `Discussão: ${a.username} vs ${b.username} — só os dois podem falar.`,
        reason: `Discussão iniciada por ${a.tag}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AddReactions,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.SendMessagesInThreads,
            ],
          },
          { id: a.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: b.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],
      });
    } catch (err) {
      console.error('Erro ao criar canal da discussão:', err.message);
      liberarDiscussao(guild.id, a.id, b.id);
      await resposta.update({ content: '❌ Não consegui criar o canal (confere minhas permissões).', embeds: [], components: [] }).catch(() => {});
      return;
    }

    const fim = Math.floor((Date.now() + TEMPO_DISCUSSAO_MS) / 1000);
    await resposta.update({ content: `🔥 Desafio aceito! A discussão está rolando em ${canal}.`, embeds: [], components: [] }).catch(() => {});
    await canal
      .send({
        content: `${a} ${b}`,
        embeds: [
          new EmbedBuilder()
            .setColor(CORES.master)
            .setTitle('🗣️ Discussão começou!')
            .setDescription(
              `${a} vs ${b}\n\nSó vocês dois podem falar aqui. A IA julga <t:${fim}:R>.\n` +
                `Pode xingar à vontade, mas **preconceito de verdade** (racismo, homofobia etc.) e ameaça te fazem **perder pontos**.`
            )
            .setFooter(rodapePadrao('Discussão')),
        ],
      })
      .catch(() => {});

    const transcricao = [];
    const contagem = { 1: 0, 2: 0 };
    const coletor = canal.createMessageCollector({
      filter: (m) => !m.author.bot && (m.author.id === a.id || m.author.id === b.id),
      time: TEMPO_DISCUSSAO_MS,
    });

    coletor.on('collect', (m) => {
      const competidor = m.author.id === a.id ? 1 : 2;
      contagem[competidor]++;
      const texto = (m.content || '').trim().slice(0, MAX_CHARS_POR_MSG);
      if (texto) {
        transcricao.push({ competidor, texto });
        if (transcricao.length > MAX_MSGS_TRANSCRICAO) transcricao.shift();
      }
    });

    coletor.on('end', async (_c, motivo) => {
      try {
        if (motivo === 'channelDelete') return; // canal apagado no meio

        let vencedorNum;
        let motivoTexto;
        if (contagem[1] === 0 && contagem[2] === 0) {
          await canal.send('😴 Ninguém falou nada em 15 minutos. Discussão cancelada, ninguém foi moggado.').catch(() => {});
          return;
        } else if (contagem[1] === 0 || contagem[2] === 0) {
          vencedorNum = contagem[1] === 0 ? 2 : 1;
          const fugiu = vencedorNum === 1 ? b : a;
          motivoTexto = `${fugiu} amarelou e não falou nada. Vitória por W.O.`;
        } else {
          await canal.send('⚖️ Tempo! A IA está julgando...').catch(() => {});
          const r = await julgarDiscussao(a, b, transcricao);
          vencedorNum = r.vencedor;
          motivoTexto = r.motivo;
        }

        const vencedor = vencedorNum === 1 ? a : b;
        const perdedor = vencedorNum === 1 ? b : a;
        const resultado = await montarMoggado({
          guild,
          perdedor,
          vencedor,
          motivo: motivoTexto,
          tipo: 'Discussão',
        });
        await canal.send(resultado()).catch(() => {});
        await interaction.channel?.send(resultado()).catch(() => {});
        await canal.send(`🗑️ Este canal será apagado em ${APAGAR_CANAL_DEPOIS_MS / 1000}s.`).catch(() => {});
      } catch (err) {
        console.error('Erro ao julgar discussão:', err.message);
        await canal.send('❌ A IA não conseguiu julgar essa discussão. Ninguém foi moggado.').catch(() => {});
      } finally {
        liberarDiscussao(guild.id, a.id, b.id);
        setTimeout(() => canal.delete('Discussão encerrada').catch(() => {}), APAGAR_CANAL_DEPOIS_MS);
      }
    });
  }

  // ---------- entrada ----------
  async function handleCommand(interaction) {
    if (!interaction.guild) return interaction.reply({ content: '🚫 Só funciona em servidor.', ephemeral: true });

    const alvo = interaction.options.getUser('oponente', true);
    if (alvo.bot) return interaction.reply({ content: '🤖 Bot não compete, escolhe um humano.', ephemeral: true });
    if (alvo.id === interaction.user.id)
      return interaction.reply({ content: '🪞 Você não pode competir contra você mesmo.', ephemeral: true });

    if (interaction.commandName === 'discussao') {
      try {
        return await rodarDiscussao(interaction, interaction.user, alvo);
      } catch (err) {
        console.error('Erro na discussão:', err.message);
        return;
      }
    }

    if (duelosAtivos.has(interaction.channelId))
      return interaction.reply({ content: '⏳ Já tem um duelo rolando neste canal. Espera acabar.', ephemeral: true });

    const restante = checarCooldown(interaction.user.id);
    if (restante)
      return interaction.reply({ content: `⏳ Aguarde **${restante}s** pra iniciar outro duelo.`, ephemeral: true });

    duelosAtivos.add(interaction.channelId);
    try {
      if (interaction.commandName === 'larp') return await rodarLarp(interaction, interaction.user, alvo);
      return await rodarBriga(interaction, interaction.user, alvo);
    } catch (err) {
      duelosAtivos.delete(interaction.channelId);
      console.error('Erro no duelo:', err.message);
      const msg = { content: '❌ Deu erro ao iniciar o duelo.', ephemeral: true };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
  }

  return { handleCommand };
}
