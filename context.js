/**
 * Sistema de Contexto e Memória de Conversas
 * Módulo único e autoritativo de memória de curto prazo por canal.
 *
 * Como funciona:
 * - Mantém, EM MEMÓRIA (não persiste o conteúdo das mensagens em disco/Supabase
 *   de propósito — isso já cumpre "não armazenar mensagens infinitamente" e evita
 *   guardar histórico de conversa de usuários além do necessário), um buffer
 *   limitado de mensagens por servidor+canal.
 * - O buffer é separado por `guildId:channelId`, então conversas de servidores
 *   ou canais diferentes nunca se misturam.
 * - Mensagens de bots são ignoradas (evita loop com o próprio Zoe ou
 *   outros bots do servidor).
 * - O texto de cada mensagem é truncado antes de entrar no buffer, e só uma
 *   quantidade pequena das mensagens mais recentes é enviada pra IA (função
 *   `getContextoParaIA`) — nunca o histórico inteiro.
 * - Existe um limite total de canais rastreados ao mesmo tempo (proteção contra
 *   uso excessivo de memória em bots que estão em muitos servidores/canais).
 */
import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';

const COR_CONTEXTO = CORES.info;

const LIMITE_PADRAO_MENSAGENS = 50; // por canal, se o servidor não configurar outro valor
const LIMITE_MAXIMO_MENSAGENS = 200; // teto absoluto, mesmo que alguém tente configurar mais
const LIMITE_MINIMO_MENSAGENS = 5;
const TAMANHO_MAX_POR_MENSAGEM = 300; // caracteres guardados por mensagem no buffer
const MENSAGENS_ENVIADAS_PARA_IA = 6; // quantas mensagens recentes vão pro prompt da IA
const MAX_CANAIS_RASTREADOS = 1000; // proteção contra crescimento excessivo de memória

export function buildContextCommands() {
  return new SlashCommandBuilder()
    .setName('contexto')
    .setDescription('Sistema de memória de conversas (contexto por canal)')
    .addSubcommand((s) => s.setName('status').setDescription('Mostra o estado do sistema de contexto neste canal'))
    .addSubcommand((s) => s.setName('ativar').setDescription('Ativa a memória de conversas neste servidor'))
    .addSubcommand((s) => s.setName('desativar').setDescription('Desativa a memória de conversas neste servidor'))
    .addSubcommand((s) =>
      s
        .setName('limpar')
        .setDescription('Limpa o histórico de contexto do canal atual')
    )
    .addSubcommand((s) =>
      s
        .setName('limite')
        .setDescription(`Define quantas mensagens por canal ficam guardadas (${LIMITE_MINIMO_MENSAGENS}-${LIMITE_MAXIMO_MENSAGENS})`)
        .addIntegerOption((o) =>
          o
            .setName('quantidade')
            .setDescription('Quantidade de mensagens')
            .setRequired(true)
            .setMinValue(LIMITE_MINIMO_MENSAGENS)
            .setMaxValue(LIMITE_MAXIMO_MENSAGENS)
        )
    );
}

export function createContextSystem({ getGuildConfig, updateGuildConfig }) {
  // ---------- Buffer em memória: chave "guildId:channelId" -> array de mensagens ----------
  const buffers = new Map();

  function chave(guildId, channelId) {
    return `${guildId}:${channelId}`;
  }

  function limiteDoServidor(config) {
    const valor = Number(config?.contexto_limite) || LIMITE_PADRAO_MENSAGENS;
    return Math.min(Math.max(valor, LIMITE_MINIMO_MENSAGENS), LIMITE_MAXIMO_MENSAGENS);
  }

  function sistemaAtivo(config) {
    // Ativado por padrão (bullet "criar configuração para ativar/desativar" —
    // o padrão fica ligado pra memória funcionar sem precisar de setup extra,
    // igual foi pedido pra antidivulgação ficar sempre ativa por padrão).
    return config?.contexto_ativo !== false;
  }

  // ---------- Proteção contra uso excessivo de memória ----------
  function garantirLimiteDeCanais() {
    if (buffers.size <= MAX_CANAIS_RASTREADOS) return;
    // remove o canal rastreado há mais tempo sem atividade nova (Map preserva
    // ordem de inserção; ao reinserir uma chave ativa nós a recriamos no fim).
    const maisAntigo = buffers.keys().next().value;
    if (maisAntigo) buffers.delete(maisAntigo);
  }

  function empilhar(guildId, channelId, entrada, limite) {
    const k = chave(guildId, channelId);
    const lista = buffers.get(k) || [];
    lista.push(entrada);
    while (lista.length > limite) lista.shift();
    // reinserir a chave move ela pro "fim" do Map, marcando como usada recentemente
    buffers.delete(k);
    buffers.set(k, lista);
    garantirLimiteDeCanais();
  }

  // ---------- Registro de mensagens (chamado no messageCreate) ----------
  async function handleMessage(message) {
    if (!message.guild || message.author.bot) return; // ignora DMs e mensagens de bots

    const config = await getGuildConfig(message.guild.id);
    if (!sistemaAtivo(config)) return;

    const conteudo = (message.content || '').trim();
    if (!conteudo) return; // não guarda mensagens vazias (só anexo/sticker, por exemplo)

    // Proteção básica de privacidade: nunca guarda o conteúdo de mensagens que
    // pareçam ser comandos com dados sensíveis (ex: tokens, senhas coladas por
    // engano) — corta fora qualquer coisa que pareça um token/segredo longo.
    const conteudoSeguro = conteudo.replace(/[A-Za-z0-9_-]{24,}/g, '[oculto]');

    empilhar(
      message.guild.id,
      message.channel.id,
      {
        autorId: message.author.id,
        autorTag: message.author.tag,
        conteudo: conteudoSeguro.slice(0, TAMANHO_MAX_POR_MENSAGEM),
        criadoEm: Date.now(),
      },
      limiteDoServidor(config)
    );
  }

  // ---------- Leitura do contexto para uso pela IA ----------
  // Retorna só as últimas `MENSAGENS_ENVIADAS_PARA_IA` mensagens, já formatadas,
  // ou string vazia se o sistema estiver desativado / não houver nada guardado.
  async function getContextoParaIA(guildId, channelId) {
    const config = await getGuildConfig(guildId);
    if (!sistemaAtivo(config)) return '';

    const lista = buffers.get(chave(guildId, channelId)) || [];
    if (!lista.length) return '';

    const recentes = lista.slice(-MENSAGENS_ENVIADAS_PARA_IA);
    return recentes.map((m) => `${m.autorTag}: ${m.conteudo}`).join('\n');
  }

  function quantidadeArmazenada(guildId, channelId) {
    return (buffers.get(chave(guildId, channelId)) || []).length;
  }

  function limparCanal(guildId, channelId) {
    return buffers.delete(chave(guildId, channelId));
  }

  // ---------- Comando /contexto ----------
  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'contexto') return false;

    if (!interaction.zoeConcedido && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '🚫 Sem permissão (precisa de Gerenciar Servidor).', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const { guild, channel } = interaction;
    const config = await getGuildConfig(guild.id);

    if (sub === 'status') {
      const embed = new EmbedBuilder()
        .setTitle('🧠 Contexto e Memória de Conversas')
        .setColor(COR_CONTEXTO)
        .addFields(
          { name: 'Estado', value: sistemaAtivo(config) ? '✅ Ativo' : '🔕 Desativado', inline: true },
          { name: 'Canal atual', value: `${channel}`, inline: true },
          { name: 'Limite configurado', value: `${limiteDoServidor(config)} mensagens/canal`, inline: true },
          { name: 'Guardadas neste canal', value: `${quantidadeArmazenada(guild.id, channel.id)}`, inline: true }
        )
        .setFooter(rodapePadrao('A memória fica só em RAM (não é salva em disco) e nunca mistura servidores/canais diferentes.'));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'ativar') {
      await updateGuildConfig(guild.id, { contexto_ativo: true });
      return interaction.reply({ content: '✅ Memória de conversas ativada.', ephemeral: true });
    }

    if (sub === 'desativar') {
      await updateGuildConfig(guild.id, { contexto_ativo: false });
      return interaction.reply({ content: '🔕 Memória de conversas desativada.', ephemeral: true });
    }

    if (sub === 'limpar') {
      const tinhaAlgo = limparCanal(guild.id, channel.id);
      return interaction.reply({
        content: tinhaAlgo ? `🧹 Histórico de contexto de ${channel} limpo.` : 'ℹ️ Não havia histórico guardado para este canal.',
        ephemeral: true,
      });
    }

    if (sub === 'limite') {
      const quantidade = interaction.options.getInteger('quantidade');
      await updateGuildConfig(guild.id, { contexto_limite: quantidade });
      return interaction.reply({ content: `📏 Limite de contexto ajustado para **${quantidade}** mensagens por canal.`, ephemeral: true });
    }

    return false;
  }

  return { handleMessage, handleCommand, getContextoParaIA };
}
