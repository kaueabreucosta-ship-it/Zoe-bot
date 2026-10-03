// Economia da Zoe: moeda "Zoe Coins" (ZC), ganha conversando (difícil de propósito) e gasta no cassino.
// Saldo fica no Supabase (tabela `economia`, ver economia.sql); o disco do Render é apagado a cada deploy.
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { randomInt } from 'crypto';
import { girarRolosNivel, multiplicadorSlots, premioMoeda, chancePremio, NIVEL_MAX, girarTigrinho, TIGRINHO_CHANCE, TIGRINHO_MULT } from './cassino-regras.js';
import { CORES, rodapePadrao } from './cores.js';

// ===== Ajuste a economia aqui =====
const MOEDA = 'ZC';
const GANHO_POR_MSG = 2; // moedas por mensagem que conta
const TETO_DIARIO = 40; // máximo ganho por dia conversando (reseta à meia-noite de Brasília)
const COOLDOWN_MSG_MS = 120_000; // uma mensagem só conta a cada 2 minutos por pessoa
const MIN_CARACTERES = 12; // tamanho mínimo da mensagem (sem links, menções e emojis)
const MIN_PALAVRAS = 3;
const APOSTA_MIN = 10;
const APOSTA_MAX = 100;
const COOLDOWN_APOSTA_MS = 5_000;
// ==================================

const ultimoGanho = new Map(); // `${guild}:${user}` -> timestamp
const ultimoTexto = new Map(); // `${guild}:${user}` -> texto limpo da última mensagem que contou
const ultimaAposta = new Map(); // user -> timestamp
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString('pt-BR');
const escolher = (arr) => arr[randomInt(arr.length)];

const FRASES_PERDEU = ['Perdeu. A casa agradece a doação.', 'Nada. Tenta de novo, otimista.', 'A sorte hoje não é sua, e amanhã também não.', 'Perdeu feio. Respira e vai de novo.'];
const FRASES_GANHOU = ['Ganhou. Não se acostuma.', 'Sorte de principiante, aproveita.', 'Passou raspando. Gasta rápido antes que eu me arrependa.', 'Tá bom, tá bom, você ganhou.'];

const INFINITO = '∞';
const BOTAO_ID = 'slots_again';
const BOTAO_TIGRINHO_ID = 'tigrinho_again';
const GIRANDO = '🌀';
const LINHA = '✦ ━━━━━━━━━━━━━━ ✦';
const maquina = (a, b, c) => `${LINHA}\n# ${a} ┃ ${b} ┃ ${c}\n${LINHA}`;
const barra = (valor, max, tam = 10) => {
  const cheio = Math.max(0, Math.min(tam, Math.round((valor / max) * tam)));
  return '▰'.repeat(cheio) + '▱'.repeat(tam - cheio);
};
const embedBase = (titulo, descricao, cor, rodape = 'Cassino') =>
  new EmbedBuilder().setTitle(titulo).setDescription(descricao).setColor(cor).setFooter(rodapePadrao(rodape)).setTimestamp();
// Embed de jogo: mostra quem está jogando (avatar + nome) no topo.
const embedJogo = (interaction, titulo, descricao, cor, rodape) =>
  embedBase(titulo, descricao, cor, rodape).setAuthor({
    name: interaction.member?.displayName || interaction.user.username,
    iconURL: interaction.user.displayAvatarURL({ size: 64 }),
  });
const ehDonoDoServidor = (interaction) => interaction.user.id === interaction.guild.ownerId;

export function buildEconomyCommands() {
  return [
    new SlashCommandBuilder()
      .setName('saldo')
      .setDescription(`Mostra quantas ${MOEDA} (Zoe Coins) você tem`)
      .addUserOption((o) => o.setName('usuario').setDescription('Ver o saldo de outra pessoa')),
    new SlashCommandBuilder()
      .setName('tigrinho')
      .setDescription(`Tigrinho da Zoe: aposte ${MOEDA}, se perder perde a aposta, se ganhar ela dobra`)
      .addIntegerOption((o) => o.setName('aposta').setDescription(`Entre ${APOSTA_MIN} e ${APOSTA_MAX} ${MOEDA}`).setRequired(true).setMinValue(APOSTA_MIN).setMaxValue(APOSTA_MAX)),
    new SlashCommandBuilder()
      .setName('cassino')
      .setDescription(`Cassino da Zoe: aposte suas ${MOEDA}`)
      .addSubcommand((s) =>
        s
          .setName('slots')
          .setDescription('Caça-níquel de 3 rolos')
          .addIntegerOption((o) => o.setName('aposta').setDescription(`Entre ${APOSTA_MIN} e ${APOSTA_MAX} ${MOEDA}`).setRequired(true).setMinValue(APOSTA_MIN).setMaxValue(APOSTA_MAX))
      )
      .addSubcommand((s) =>
        s
          .setName('moeda')
          .setDescription('Cara ou coroa')
          .addStringOption((o) => o.setName('escolha').setDescription('Cara ou coroa?').setRequired(true).addChoices({ name: 'Cara', value: 'cara' }, { name: 'Coroa', value: 'coroa' }))
          .addIntegerOption((o) => o.setName('aposta').setDescription(`Entre ${APOSTA_MIN} e ${APOSTA_MAX} ${MOEDA}`).setRequired(true).setMinValue(APOSTA_MIN).setMaxValue(APOSTA_MAX))
      ),
  ];
}

export function createEconomySystem({ db }) {
  // ---------- Ganho por interação ----------
  function limparTexto(txt) {
    return (txt || '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  async function handleMessage(message) {
    if (message.author.bot || !message.guild) return;
    const chave = `${message.guild.id}:${message.author.id}`;
    const agora = Date.now();
    if (agora - (ultimoGanho.get(chave) || 0) < COOLDOWN_MSG_MS) return;

    const texto = limparTexto(message.content);
    if (texto.length < MIN_CARACTERES || texto.split(' ').length < MIN_PALAVRAS) return;
    if (/^(.)\1+$/.test(texto.replace(/\s/g, ''))) return; // "aaaaaaaa"
    if (ultimoTexto.get(chave) === texto) return; // repetir a mesma frase não conta

    ultimoGanho.set(chave, agora);
    ultimoTexto.set(chave, texto);
    const { error } = await db.rpc('eco_ganhar', {
      p_guild: message.guild.id,
      p_user: message.author.id,
      p_valor: GANHO_POR_MSG,
      p_teto: TETO_DIARIO,
    });
    if (error) console.error('Erro na economia (ganho):', error.message);
  }

  // ---------- Comandos ----------
  async function saldo(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const nome = alvo.displayName ?? alvo.username;
    const e = embedBase('💰 Carteira', '\u200b', CORES.info, 'Economia')
      .setAuthor({ name: nome, iconURL: alvo.displayAvatarURL({ size: 64 }) })
      .setThumbnail(alvo.displayAvatarURL({ size: 256 }));

    if (alvo.id === interaction.guild.ownerId) {
      e.setColor(CORES.master).setDescription(`# ${INFINITO} ${MOEDA}\n👑 Dono do servidor · moedas infinitas`);
      return interaction.reply({ embeds: [e] });
    }
    const { data, error } = await db.from('economia').select('saldo, ganho_hoje, ganho_dia').eq('guild_id', interaction.guild.id).eq('user_id', alvo.id).maybeSingle();
    if (error) {
      console.error('Erro na economia (saldo):', error.message);
      return interaction.reply({ content: '❌ A economia está fora do ar (a tabela existe no Supabase?).', flags: MessageFlags.Ephemeral });
    }
    const valor = data?.saldo ?? 0;
    e.setDescription(`# ${fmt(valor)} ${MOEDA}`);
    if (alvo.id === interaction.user.id) {
      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const ganhoHoje = data && String(data.ganho_dia) === hoje ? data.ganho_hoje : 0;
      e.addFields({ name: '💬 Ganhos de hoje conversando', value: `${barra(ganhoHoje, TETO_DIARIO)}  **${ganhoHoje}/${TETO_DIARIO}** ${MOEDA}` });
      if (valor === 0) e.addFields({ name: '💡 Dica', value: 'Zerado. Converse no servidor (mensagens de verdade, não "kkkk") ou pegue o `/diario`.' });
    }
    return interaction.reply({ embeds: [e] });
  }


  // Serve tanto pro comando (/cassino) quanto pro botão "girar de novo".
  // Devolve a mensagem final, ou null se a aposta não rolou.
  async function apostar(interaction, aposta, rolar) {
    const ehBotao = typeof interaction.isButton === 'function' && interaction.isButton();
    const restante = COOLDOWN_APOSTA_MS - (Date.now() - (ultimaAposta.get(interaction.user.id) || 0));
    if (restante > 0) {
      await interaction.reply({ content: `⏳ Calma, apostador. Espere ${Math.ceil(restante / 1000)}s.`, flags: MessageFlags.Ephemeral });
      return null;
    }
    ultimaAposta.set(interaction.user.id, Date.now());

    if (ehBotao) await interaction.deferUpdate();
    else await interaction.deferReply();

    const falhar = async (content) => {
      if (!ehBotao) await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return null;
    };

    const { titulo, frames, final, premio, ganhou, botao, rodape } = rolar();
    const dono = ehDonoDoServidor(interaction); // dono do servidor: moedas infinitas, não mexe no banco

    let novoSaldo = `${INFINITO} ${MOEDA}`;
    if (!dono) {
      const { data, error } = await db.rpc('eco_liquidar', {
        p_guild: interaction.guild.id,
        p_user: interaction.user.id,
        p_aposta: aposta,
        p_premio: premio,
      });
      if (error) {
        console.error('Erro na economia (aposta):', error.message);
        return falhar('❌ A economia está fora do ar. Tente depois.');
      }
      if (data === null) return falhar(`🚫 Saldo insuficiente pra apostar **${fmt(aposta)} ${MOEDA}**. Use /saldo e vá conversar.`);
      novoSaldo = `${fmt(data)} ${MOEDA}`;
    }

    // Animação: rolos travando um por um, com barra de progresso. O botão some enquanto gira.
    for (let i = 0; i < frames.length; i++) {
      const progresso = `${'▰'.repeat(i + 1)}${'▱'.repeat(frames.length - i)}`;
      await interaction.editReply({
        embeds: [embedJogo(interaction, titulo, `${frames[i]}\n\n${GIRANDO} *girando...* ${progresso}`, CORES.info, rodape)],
        components: [],
      });
      await dormir(700);
    }

    const lucro = premio - aposta;
    const sinal = lucro > 0 ? `+${fmt(lucro)} ${MOEDA}` : lucro === 0 ? 'aposta devolvida' : `-${fmt(aposta)} ${MOEDA}`;
    const frase = escolher(ganhou ? FRASES_GANHOU : FRASES_PERDEU);
    const resultado = embedJogo(
      interaction,
      `${titulo} · ${lucro > 0 ? 'VITÓRIA' : lucro === 0 ? 'EMPATE' : 'DERROTA'}`,
      `${final}\n\n*${frase}*`,
      lucro >= 0 && ganhou ? CORES.sucesso : CORES.erro,
      rodape
    ).addFields(
      { name: '🎟️ Aposta', value: `${fmt(aposta)} ${MOEDA}`, inline: true },
      { name: lucro > 0 ? '📈 Ganho' : lucro === 0 ? '➖ Resultado' : '📉 Perda', value: sinal, inline: true },
      { name: '💰 Saldo', value: novoSaldo, inline: true }
    );
    if (dono) resultado.setDescription(`👑 *Dono do servidor · moedas infinitas*\n${resultado.data.description}`);

    const components = botao
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(botao.id || BOTAO_ID).setLabel(botao.label).setStyle(ButtonStyle.Danger))]
      : [];
    return interaction.editReply({ embeds: [resultado], components });
  }

  // Um giro do caça-níquel no nível indicado (1x, 2x, 3x...).
  const rolarSlots = (aposta, nivel) => () => {
    const rolos = girarRolosNivel(nivel);
    const mult = multiplicadorSlots(rolos);
    const total = mult * nivel;
    const [a, b, c] = rolos.map((r) => r.s);
    const tela = (x, y, z) => maquina(x, y, z);
    let legenda = '';
    if (a === b && b === c) legenda = `\n🎉 **TRINCA!** x${mult}${nivel > 1 ? ` · nível ${nivel}x = **x${total}**` : ''}`;
    else if (mult === 1) legenda = nivel > 1 ? `\nUm par: x1 · nível ${nivel}x = **x${total}**` : '\nUm par: aposta devolvida.';
    if (nivel > 1) legenda += `\n⚠️ Nível **${nivel}x**: prêmio multiplicado, mas só **${Math.round(chancePremio(nivel) * 100)}%** da sorte normal.`;
    return {
      titulo: `🎰 Caça-níquel da Zoe${nivel > 1 ? ` · ${nivel}x` : ''}`,
      premio: aposta * total,
      ganhou: total > 0,
      frames: [tela(GIRANDO, GIRANDO, GIRANDO), tela(a, GIRANDO, GIRANDO), tela(a, b, GIRANDO)],
      final: `${tela(a, b, c)}${legenda}`,
      botao: nivel < NIVEL_MAX ? { label: `🔁 Girar de novo · ${nivel + 1}x` } : null,
    };
  };

  // Primeiro giro (1x) + botão que sobe o nível a cada clique, mesma aposta.
  async function sessaoSlots(interaction, aposta) {
    let nivel = 1;
    const msg = await apostar(interaction, aposta, rolarSlots(aposta, nivel));
    if (!msg || NIVEL_MAX <= 1) return;

    const coletor = msg.createMessageComponentCollector({ componentType: ComponentType.Button, idle: 30_000 });
    let ocupado = false;
    coletor.on('collect', async (i) => {
      if (i.customId !== BOTAO_ID) return;
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: '🚫 Esse botão é de quem abriu a roleta. Use /cassino slots.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (ocupado) return i.deferUpdate().catch(() => {});
      ocupado = true;
      try {
        const ok = await apostar(i, aposta, rolarSlots(aposta, nivel + 1));
        if (ok) nivel += 1;
        if (nivel >= NIVEL_MAX) coletor.stop('max');
      } catch (err) {
        console.error('Erro no botão da roleta:', err.message);
      } finally {
        ocupado = false;
      }
    });
    coletor.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  }

  // Tigrinho: perdeu = perde a aposta; ganhou = a aposta dobra (recebe 2x de volta).
  const rolarTigrinho = (aposta) => () => {
    const { ganhou, rolos } = girarTigrinho();
    const [a, b, c] = rolos;
    return {
      titulo: '🐯 Tigrinho da Zoe',
      premio: ganhou ? aposta * TIGRINHO_MULT : 0,
      ganhou,
      frames: [maquina(GIRANDO, GIRANDO, GIRANDO), maquina(a, GIRANDO, GIRANDO), maquina(a, b, GIRANDO)],
      final: `${maquina(a, b, c)}\n${ganhou ? `🎉 **TRINCA DE ${a}!** Sua aposta **dobrou**: ${fmt(aposta)} → **${fmt(aposta * TIGRINHO_MULT)} ${MOEDA}**.` : `💀 Sem trinca. Você perdeu **${fmt(aposta)} ${MOEDA}**.`}`,
      botao: { label: `🔁 Jogar de novo · ${fmt(aposta)} ${MOEDA}`, id: BOTAO_TIGRINHO_ID },
      rodape: `Tigrinho • ${Math.round(TIGRINHO_CHANCE * 100)}% de chance · prêmio ${TIGRINHO_MULT}x`,
    };
  };

  async function sessaoTigrinho(interaction, aposta) {
    const msg = await apostar(interaction, aposta, rolarTigrinho(aposta));
    if (!msg) return;

    const coletor = msg.createMessageComponentCollector({ componentType: ComponentType.Button, idle: 30_000 });
    let ocupado = false;
    coletor.on('collect', async (i) => {
      if (i.customId !== BOTAO_TIGRINHO_ID) return;
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: '🚫 Esse botão é de quem abriu o Tigrinho. Use /tigrinho.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (ocupado) return i.deferUpdate().catch(() => {});
      ocupado = true;
      try {
        await apostar(i, aposta, rolarTigrinho(aposta));
      } catch (err) {
        console.error('Erro no botão do Tigrinho:', err.message);
      } finally {
        ocupado = false;
      }
    });
    coletor.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  }

  async function handleCommand(interaction) {
    if (interaction.commandName === 'saldo') return saldo(interaction);
    const aposta = interaction.options.getInteger('aposta');
    if (interaction.commandName === 'tigrinho') return sessaoTigrinho(interaction, aposta);

    const sub = interaction.options.getSubcommand();

    if (sub === 'slots') return sessaoSlots(interaction, aposta);

    if (sub === 'moeda') {
      const escolha = interaction.options.getString('escolha');
      return apostar(interaction, aposta, () => {
        const saiu = randomInt(2) === 0 ? 'cara' : 'coroa';
        const ganhou = saiu === escolha;
        return {
          titulo: '🪙 Cara ou coroa',
          premio: ganhou ? premioMoeda(aposta) : 0,
          ganhou,
          frames: [maquina('🪙', '🪙', '🪙')],
          final: `${LINHA}\n# 🪙 ${saiu.toUpperCase()}\n${LINHA}\nVocê escolheu **${escolha}**.`,
        };
      });
    }
  }

  return { handleMessage, handleCommand };
}
