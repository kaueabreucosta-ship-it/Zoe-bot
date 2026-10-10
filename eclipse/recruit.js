/**
 * Recrutamento staff — análise da Eclipse + botões Aceitar / Negar.
 *
 * O site envia a candidatura por webhook. A Eclipse detecta a mensagem final
 * (#fim), recupera as respostas da candidatura, consulta o histórico recente
 * do membro no servidor e faz uma análise com a IA antes de mostrar os botões.
 *
 * Variáveis de ambiente:
 *   RECRUIT_CHANNEL_ID   canal onde a webhook posta as candidaturas
 *   STAFF_ROLE_ID        cargo da staff: é marcado na votação e é dado ao candidato quando aceito
 *   OWNER_ROLE_ID        cargo OWNER: marcado quando a votação termina (decide aceitar/negar)
 *   MOD_ROLE_ID          cargo MODERADOR: marcado quando a votação termina (decide aceitar/negar)
 *
 * Fluxo: candidatura chega → análise da IA → enquete de 3h (marca a staff) →
 * enquete termina → OWNER e MODERADOR são marcados e os botões Aceitar/Negar liberam.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { rodapePadrao } from './cores.js';

const VERMELHO = 0xe5395b;
const VERDE = 0x248046;
const CINZA = 0xe5395b;
const AMARELO = 0x8a2be2;

export function createRecruitSystem({ client, ownerId, gerarTexto }) {
  const CANAL_ID = (process.env.RECRUIT_CHANNEL_ID || '').trim();
  const CARGO_STAFF_ID = (process.env.STAFF_ROLE_ID || '').trim();
  const CARGO_OWNER_ID = (process.env.OWNER_ROLE_ID || '').trim();
  const CARGO_MOD_ID = (process.env.MOD_ROLE_ID || '').trim();
  const DURACAO_VOTACAO_H = 3; // duração da enquete, em horas
  const processando = new Set(); // evita finalizar a mesma votação duas vezes

  if (!CANAL_ID) console.warn('⚠️ RECRUIT_CHANNEL_ID não definida — recrutamento desativado.');
  if (!CARGO_STAFF_ID) console.warn('⚠️ STAFF_ROLE_ID não definida — Aceitar não vai conseguir dar o cargo.');
  if (!CARGO_OWNER_ID && !CARGO_MOD_ID) console.warn('⚠️ OWNER_ROLE_ID/MOD_ROLE_ID não definidas — ao fim da votação só o dono (OWNER_ID) será marcado e quem tem Gerenciar Cargos decide.');

  function podeDecidir(interaction) {
    if (ownerId && interaction.user.id === ownerId) return true;
    if (CARGO_OWNER_ID || CARGO_MOD_ID) {
      const cargos = interaction.member?.roles?.cache;
      return Boolean(
        (CARGO_OWNER_ID && cargos?.has(CARGO_OWNER_ID)) || (CARGO_MOD_ID && cargos?.has(CARGO_MOD_ID))
      );
    }
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
  }

  function botoes(userId, desativados = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rec|aceitar|${userId}`)
        .setLabel('Aceitar como staff')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(desativados),
      new ButtonBuilder()
        .setCustomId(`rec|negar|${userId}`)
        .setLabel('Negar')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(desativados)
    );
  }

  function botaoEncerrar(userId, pollId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rec|encerrar|${userId}|${pollId}`)
        .setLabel('Encerrar votação')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  function podeEncerrar(interaction) {
    if (ownerId && interaction.user.id === ownerId) return true;
    return Boolean(CARGO_OWNER_ID && interaction.member?.roles?.cache?.has(CARGO_OWNER_ID));
  }

  function limparTexto(texto, limite = 700) {
    return String(texto || '')
      .replace(/@everyone|@here/g, '@\u200beveryone')
      .slice(0, limite);
  }

  function extrairUserId(embeds = []) {
    for (const embed of embeds) {
      const footer = embed?.footer?.text || '';
      const m = footer.match(/user_id:(\d{15,25})/);
      if (m) return m[1];
    }
    return null;
  }

  async function coletarCandidatura(message, userId) {
    const mensagens = [];
    try {
      const anteriores = await message.channel.messages.fetch({ limit: 30, before: message.id });
      for (const m of anteriores.values()) {
        if (!m.webhookId) continue;
        if (extrairUserId(m.embeds) === userId) mensagens.push(m);
      }
    } catch (err) {
      console.warn('⚠️ Não consegui ler todas as mensagens da candidatura:', err.message);
    }

    mensagens.push(message);
    mensagens.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const respostas = [];
    for (const msg of mensagens) {
      for (const embed of msg.embeds) {
        for (const field of embed.fields || []) {
          if (field.name && field.value) {
            respostas.push({ pergunta: field.name, resposta: field.value });
          }
        }
      }
    }

    return { mensagens, respostas };
  }

  async function coletarHistorico(guild, userId) {
    const membro = await guild.members.fetch(userId).catch(() => null);
    if (!membro) return { membro: null, mensagens: [], resumo: 'O candidato não está mais no servidor.' };

    const canais = [];
    for (const canal of guild.channels.cache.values()) {
      if (!canal.isTextBased?.() || !canal.viewable || canal.isThread?.()) continue;
      const perms = canal.permissionsFor?.(client.user);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) continue;
      canais.push(canal);
    }

    // Começa pelos canais com atividade mais recente. Isso evita fazer centenas
    // de requisições em servidores grandes e ainda dá uma amostra útil.
    canais.sort((a, b) => Number(b.lastMessageId || 0) - Number(a.lastMessageId || 0));

    const encontrados = [];
    const limiteCanais = Math.min(canais.length, 12);
    for (let i = 0; i < limiteCanais; i++) {
      const canal = canais[i];
      try {
        const lote = await canal.messages.fetch({ limit: 30 });
        for (const msg of lote.values()) {
          if (msg.author?.id !== userId || msg.webhookId || msg.author.bot) continue;
          encontrados.push({
            canal: `#${canal.name}`,
            data: msg.createdTimestamp,
            texto: limparTexto(msg.content, 500),
          });
        }
      } catch {
        // Canal sem acesso ou erro transitório: segue com os demais.
      }
    }

    encontrados.sort((a, b) => a.data - b.data);
    const recentes = encontrados.slice(-35);

    const cargos = membro.roles.cache
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => r.name)
      .slice(0, 15);

    const dados = [
      `Entrada no servidor: ${membro.joinedTimestamp ? new Date(membro.joinedTimestamp).toLocaleString('pt-BR') : 'não disponível'}`,
      `Cargos: ${cargos.length ? cargos.join(', ') : 'nenhum cargo adicional'}`,
      `Conta criada: ${membro.user.createdAt.toLocaleString('pt-BR')}`,
      `Timeout ativo: ${membro.communicationDisabledUntilTimestamp ? 'sim' : 'não'}`,
      `Mensagens recentes encontradas: ${recentes.length}`,
      recentes.length
        ? recentes.map((m) => `[${new Date(m.data).toLocaleString('pt-BR')}] ${m.canal}: ${m.texto || '(mensagem sem texto)'}`).join('\n')
        : 'Nenhuma mensagem recente encontrada nos canais acessíveis à Eclipse.',
    ];

    return { membro, mensagens: recentes, resumo: dados.join('\n') };
  }

  async function analisarCandidato(guild, userId, candidatura) {
    const historico = await coletarHistorico(guild, userId);
    const membro = historico.membro;
    const respostasTexto = candidatura.respostas.length
      ? candidatura.respostas.map((r, i) => `${i + 1}. ${r.pergunta}: ${r.resposta}`).join('\n')
      : 'Não foi possível extrair as respostas dos embeds.';

    const prompt = [
      'Você é a Eclipse, responsável por analisar candidaturas para a equipe de suporte de um servidor Discord.',
      'Faça uma análise curta, objetiva e humana. Não seja bajuladora e não invente fatos.',
      'Você tem acesso às respostas da candidatura e a uma amostra do histórico recente do membro no servidor.',
      'Use SOMENTE as informações fornecidas. Se o histórico for pequeno, diga que a amostra é limitada.',
      'Considere especialmente: respeito, maturidade, coerência das respostas, iniciativa, capacidade de atendimento, comportamento no servidor e possíveis sinais de risco para a equipe.',
      'Não trate palavrão isolado como motivo automático para reprovação; avalie o contexto.',
      'Não revele informações privadas que não estejam nesses dados.',
      'Dê uma recomendação entre: APROVAR, ANALISAR MELHOR ou RECUSAR. A decisão final continua sendo da staff.',
      'Formato obrigatório:',
      'VEREDITO: APROVAR | ANALISAR MELHOR | RECUSAR',
      'PONTOS POSITIVOS: 2 ou 3 itens curtos',
      'PONTOS DE ATENÇÃO: 1 ou 2 itens curtos',
      'OPINIÃO DA ECLIPSE: 2 a 4 frases, explicando a recomendação com base nas evidências.',
      '',
      `Membro: ${membro?.user?.tag || userId} (${userId})`,
      `RESPOSTAS DA CANDIDATURA:\n${respostasTexto}`,
      `HISTÓRICO DO SERVIDOR:\n${historico.resumo}`,
    ].join('\n');

    let analise = '';
    try {
      analise = (await gerarTexto(prompt, { maxTokens: 750 }))?.trim() || '';
    } catch (err) {
      console.error('Erro na análise da candidatura:', err.message);
    }

    if (!analise) {
      analise = [
        'VEREDITO: ANALISAR MELHOR',
        'PONTOS POSITIVOS: Não foi possível gerar a análise automática.',
        'PONTOS DE ATENÇÃO: Revise manualmente as respostas e o histórico disponível.',
        'OPINIÃO DA ECLIPSE: A análise automática falhou desta vez. Melhor não inventar um parecer; confiram a candidatura manualmente.',
      ].join('\n');
    }

    return { analise, historico, membro };
  }

  function parseAnalise(texto) {
    const linhas = String(texto || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const get = (rotulo) => {
      const linha = linhas.find((x) => x.toUpperCase().startsWith(rotulo));
      return linha ? linha.slice(rotulo.length).replace(/^[:\-]\s*/, '').trim() : '';
    };
    const veredito = get('VEREDITO') || 'ANALISAR MELHOR';
    const positivos = get('PONTOS POSITIVOS');
    const atencao = get('PONTOS DE ATENÇÃO');
    const opiniao = get('OPINIÃO DA ECLIPSE');
    return { veredito, positivos, atencao, opiniao };
  }

  function corVeredito(veredito) {
    if (/APROVAR/i.test(veredito)) return VERDE;
    if (/RECUSAR/i.test(veredito)) return CINZA;
    return AMARELO;
  }

  // ---------- Mensagem final da webhook chegou ----------
  async function handleMessage(message) {
    if (message.type === MessageType.PollResult) return handlePollResult(message);
    if (!CANAL_ID || !message.webhookId || message.channelId !== CANAL_ID) return;
    const userId = extrairUserId(message.embeds);
    const ultimo = message.embeds[message.embeds.length - 1];
    const footer = ultimo?.footer?.text || '';
    if (!userId || !footer.includes('#fim')) return;

    const candidatura = await coletarCandidatura(message, userId);
    const { analise, historico, membro } = await analisarCandidato(message.guild, userId, candidatura);
    const partes = parseAnalise(analise);

    const embed = new EmbedBuilder()
      .setColor(corVeredito(partes.veredito))
      .setTitle('🤖 Análise da Eclipse · Candidatura')
      .setDescription(
        `Candidato: <@${userId}> (\`${userId}\`)\n` +
        `**Veredito sugerido:** ${limparTexto(partes.veredito, 80)}\n\n` +
        `**Pontos positivos**\n${limparTexto(partes.positivos || 'Não informado.', 700)}\n\n` +
        `**Pontos de atenção**\n${limparTexto(partes.atencao || 'Nenhum ponto destacado.', 700)}\n\n` +
        `**Opinião da Eclipse**\n${limparTexto(partes.opiniao || analise, 1200)}`
      )
      .addFields(
        {
          name: '🔎 Histórico consultado',
          value: `Amostra de **${historico.mensagens.length} mensagens recentes** em canais aos quais a Eclipse tem acesso.` +
            (membro?.communicationDisabledUntilTimestamp ? '\n⚠️ O membro está/esteve em timeout recentemente.' : ''),
        },
        {
          name: '🗳️ Votação da staff',
          value: `Em andamento — termina <t:${Math.floor((Date.now() + DURACAO_VOTACAO_H * 3600 * 1000) / 1000)}:R>.\nQuando acabar, os botões Aceitar/Negar liberam para o OWNER e os moderadores. O OWNER pode encerrar antes pelo botão **Encerrar votação**.`,
        }
      )
      .setFooter(rodapePadrao('Eclipse · Recrutamento'));

    // Painel sem botões: eles só aparecem quando a votação terminar.
    const painel = await message.reply({
      embeds: [embed],
      components: [],
      allowedMentions: { parse: [], repliedUser: false },
    });

    const nome = membro?.user?.username || userId;
    const enquete = await abrirVotacao(message.channel, painel, nome);
    if (enquete) {
      await painel.edit({ components: [botaoEncerrar(userId, enquete.id)] }).catch(() => {});
    } else {
      // Enquete não pôde ser criada (permissão ou versão antiga do discord.js): libera os botões direto.
      const e = EmbedBuilder.from(painel.embeds[0]).setFields(
        painel.embeds[0].fields.map((f) =>
          f.name.startsWith('🗳️')
            ? { name: f.name, value: '⚠️ Não consegui criar a enquete (confira a permissão **Enviar enquetes** da Eclipse). Botões liberados direto.' }
            : f
        )
      );
      await painel.edit({ embeds: [e], components: [botoes(userId)] }).catch(() => {});
    }
  }

  // ---------- Enquete de 3 horas (marca a staff) ----------
  async function abrirVotacao(canal, painel, nome) {
    const ping = CARGO_STAFF_ID ? `<@&${CARGO_STAFF_ID}> ` : '';
    try {
      return await canal.send({
        content: `${ping}🗳️ **Votação aberta!** Votem se **${limparTexto(nome, 60)}** deve entrar na staff. A enquete dura **${DURACAO_VOTACAO_H} horas**.`,
        poll: {
          question: { text: limparTexto(`Aceitar ${nome} na staff?`, 280) },
          answers: [
            { text: 'Aceitar', emoji: '✅' },
            { text: 'Negar', emoji: '❌' },
          ],
          duration: DURACAO_VOTACAO_H,
          allowMultiselect: false,
        },
        reply: { messageReference: painel.id, failIfNotExists: false },
        allowedMentions: { roles: CARGO_STAFF_ID ? [CARGO_STAFF_ID] : [], repliedUser: false },
      });
    } catch (err) {
      console.error('Erro ao criar a enquete do recrutamento:', err.message);
      return null;
    }
  }

  // ---------- A enquete terminou (Discord manda uma mensagem de resultado) ----------
  async function handlePollResult(message) {
    if (!CANAL_ID || message.channelId !== CANAL_ID) return;
    const refId = message.reference?.messageId;
    if (!refId) return;
    const pollMsg = await message.channel.messages.fetch(refId).catch(() => null);
    if (!pollMsg) return;
    await finalizarVotacao(pollMsg);
  }

  async function finalizarVotacao(pollMsg) {
    if (pollMsg.author?.id !== client.user.id || !pollMsg.poll) return;
    const painelId = pollMsg.reference?.messageId;
    if (!painelId || processando.has(painelId)) return;
    processando.add(painelId);
    try {
      const painel = await pollMsg.channel.messages.fetch(painelId).catch(() => null);
      if (!painel || painel.author?.id !== client.user.id) return;
      // Só trata se o painel ainda está "aguardando" (com o botão Encerrar votação).
      const aguardando = painel.components?.[0]?.components?.some((c) => c.customId?.startsWith('rec|encerrar'));
      if (!aguardando) return;
      const original = painel.embeds[0];
      const userId = original?.description?.match(/<@(\d{15,25})>/)?.[1];
      if (!userId) return;

      const fresca = await pollMsg.channel.messages.fetch({ message: pollMsg.id, force: true }).catch(() => pollMsg);
      const respostas = [...(fresca.poll?.answers?.values() ?? [])];
      const votos = (texto) => respostas.find((a) => a.text === texto)?.voteCount ?? 0;
      const aceitar = votos('Aceitar');
      const negar = votos('Negar');
      const lado = aceitar > negar ? '✅ A maioria votou para **aceitar**.' : negar > aceitar ? '❌ A maioria votou para **negar**.' : '⚖️ **Empate** (ou sem votos).';

      const embed = EmbedBuilder.from(original).setFields(
        (original.fields || []).map((f) =>
          f.name.startsWith('🗳️')
            ? { name: '🗳️ Votação da staff', value: `Encerrada — ✅ Aceitar: **${aceitar}** · ❌ Negar: **${negar}**\n${lado}\nAgora o OWNER e os moderadores decidem pelos botões.` }
            : f
        )
      );
      await painel.edit({ embeds: [embed], components: [botoes(userId)] });

      const cargos = [CARGO_OWNER_ID, CARGO_MOD_ID].filter(Boolean);
      const ping = cargos.length ? cargos.map((id) => `<@&${id}>`).join(' ') : ownerId ? `<@${ownerId}>` : '';
      await painel.reply({
        content: `${ping} 🗳️ **A votação terminou!** ✅ ${aceitar} · ❌ ${negar}. ${lado}\nDecidam usando os botões **Aceitar como staff** / **Negar** acima.`,
        allowedMentions: { roles: cargos, users: cargos.length || !ownerId ? [] : [ownerId], repliedUser: false },
      });
    } catch (err) {
      console.error('Erro ao finalizar a votação do recrutamento:', err.message);
    } finally {
      processando.delete(painelId);
    }
  }

  // Se a bot ficou fora do ar quando a enquete acabou, resolve ao ligar de novo.
  async function recuperar() {
    if (!CANAL_ID) return;
    const canal = await client.channels.fetch(CANAL_ID).catch(() => null);
    const msgs = await canal?.messages?.fetch({ limit: 50 }).catch(() => null);
    if (!msgs) return;
    for (const m of msgs.values()) {
      if (m.author?.id === client.user.id && m.poll?.resultsFinalized) {
        await finalizarVotacao(m).catch(() => {});
      }
    }
  }

  // ---------- Botões ----------
  async function handleButton(interaction) {
    const [, acao, userId, pollId] = interaction.customId.split('|');

    if (acao === 'encerrar') {
      if (!podeEncerrar(interaction)) {
        return interaction.reply({ content: '🚫 Só o **OWNER** pode encerrar a votação.', ephemeral: true });
      }
      await interaction.deferUpdate();
      const pollMsg = await interaction.channel.messages.fetch(pollId).catch(() => null);
      if (!pollMsg?.poll) {
        return interaction.followUp({ content: '❌ Não achei a enquete dessa candidatura.', ephemeral: true });
      }
      // Se já tinha acabado, o end() dá erro; segue mesmo assim e libera os botões.
      await pollMsg.poll.end().catch(() => {});
      await finalizarVotacao(pollMsg);
      return;
    }

    if (!podeDecidir(interaction)) {
      return interaction.reply({ content: '🚫 Só o **OWNER** e os **moderadores** decidem candidaturas.', ephemeral: true });
    }

    if (interaction.message.components?.[0]?.components?.some((c) => c.disabled)) {
      return interaction.reply({ content: '⚠️ Essa candidatura já foi decidida.', ephemeral: true });
    }

    if (acao === 'negar') {
      const modal = new ModalBuilder()
        .setCustomId(`rec|negarmodal|${userId}|${interaction.message.id}`)
        .setTitle('Negar candidatura')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('motivo')
              .setLabel('Motivo (opcional, vai no privado do candidato)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(500)
          )
        );
      return interaction.showModal(modal);
    }

    await interaction.deferUpdate();
    const guild = interaction.guild;
    const membro = await guild.members.fetch(userId).catch(() => null);
    if (!membro) {
      return interaction.followUp({ content: '❌ Esse candidato não está mais no servidor.', ephemeral: true });
    }
    if (!CARGO_STAFF_ID) {
      return interaction.followUp({ content: '❌ `STAFF_ROLE_ID` não está configurado no bot.', ephemeral: true });
    }
    try {
      await membro.roles.add(CARGO_STAFF_ID, `Candidatura aceita por ${interaction.user.tag}`);
    } catch (err) {
      console.error('Erro ao dar cargo staff:', err.message);
      return interaction.followUp({
        content: '❌ Não consegui dar o cargo. Coloque o cargo da Eclipse **acima** do cargo de staff na lista de cargos e confira o `STAFF_ROLE_ID`.',
        ephemeral: true,
      });
    }

    const dmOk = await membro
      .send(`🎉 Parabéns! Sua candidatura para a equipe de **${guild.name}** foi **aceita**. Bem-vindo(a) à staff!`)
      .then(() => true)
      .catch(() => false);

    const original = interaction.message.embeds[0];
    const embed = EmbedBuilder.from(original)
      .setColor(VERDE)
      .setTitle('🤖 Candidatura aceita · Análise da Eclipse')
      .setDescription(
        `${original?.description || `Candidato: <@${userId}>`}\n\n` +
        `**DECISÃO:** ✅ **ACEITO** por ${interaction.user}\n` +
        `Aviso no privado: ${dmOk ? 'enviado' : 'não foi possível (DM fechada)'}`
      );
    return interaction.editReply({ embeds: [embed], components: [botoes(userId, true)] });
  }

  // ---------- Modal de negar ----------
  async function handleModal(interaction) {
    const [, , userId, painelId] = interaction.customId.split('|');
    if (!podeDecidir(interaction)) {
      return interaction.reply({ content: '🚫 Sem permissão.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const painelAtual = await interaction.channel.messages.fetch(painelId).catch(() => null);
    if (painelAtual?.components?.[0]?.components?.some((c) => c.disabled)) {
      return interaction.editReply({ content: '⚠️ Essa candidatura já foi decidida por outra pessoa.' });
    }
    const motivo = interaction.fields.getTextInputValue('motivo').trim();

    const membro = await interaction.guild.members.fetch(userId).catch(() => null);
    let dmOk = false;
    if (membro) {
      dmOk = await membro
        .send(
          `Olá! Sua candidatura para a equipe de **${interaction.guild.name}** não foi aceita desta vez.` +
            (motivo ? `\n\n**Motivo:** ${motivo}` : '') +
            '\n\nVocê pode tentar de novo mais tarde. Obrigado pelo interesse!'
        )
        .then(() => true)
        .catch(() => false);
    }

    const painel = await interaction.channel.messages.fetch(painelId).catch(() => null);
    if (painel) {
      const original = painel.embeds[0];
      const embed = EmbedBuilder.from(original)
        .setColor(CINZA)
        .setTitle('🤖 Candidatura recusada · Análise da Eclipse')
        .setDescription(
          `${original?.description || `Candidato: <@${userId}>`}\n\n` +
          `**DECISÃO:** ❌ **RECUSADO** por ${interaction.user}` +
          (motivo ? `\n**Motivo:** ${limparTexto(motivo, 500)}` : '') +
          `\nAviso no privado: ${dmOk ? 'enviado' : 'não foi possível (DM fechada ou saiu do servidor)'}`
        );
      await painel.edit({ embeds: [embed], components: [botoes(userId, true)] }).catch(() => {});
    }
    return interaction.editReply({ content: '✅ Candidatura negada.' });
  }

  return { handleMessage, handleButton, handleModal, recuperar };
}
