/**
 * Recrutamento staff — botões Aceitar / Negar
 *
 * O site envia a candidatura por webhook (webhook não pode ter botões).
 * A última mensagem da candidatura tem no footer `user_id:ID #fim`.
 * Quando a Zoe vê essa mensagem no canal de candidaturas, ela responde logo
 * abaixo com o painel de decisão (Aceitar / Negar).
 *
 * Variáveis de ambiente:
 *   RECRUIT_CHANNEL_ID  canal onde a webhook posta as candidaturas
 *   STAFF_ROLE_ID       cargo dado ao candidato quando aceito
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { rodapePadrao } from './cores.js';

const VERMELHO = 0xe30613;
const VERDE = 0x248046;
const CINZA = 0xda373c;

export function createRecruitSystem({ client, ownerId }) {
  const CANAL_ID = (process.env.RECRUIT_CHANNEL_ID || '').trim();
  const CARGO_STAFF_ID = (process.env.STAFF_ROLE_ID || '').trim();

  if (!CANAL_ID) console.warn('⚠️ RECRUIT_CHANNEL_ID não definida — botões Aceitar/Negar desativados.');
  if (!CARGO_STAFF_ID) console.warn('⚠️ STAFF_ROLE_ID não definida — Aceitar não vai conseguir dar o cargo.');

  function podeDecidir(interaction) {
    if (ownerId && interaction.user.id === ownerId) return true;
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
  }

  function botoes(userId, desativados = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rec|aceitar|${userId}`).setLabel('Aceitar como staff').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(desativados),
      new ButtonBuilder().setCustomId(`rec|negar|${userId}`).setLabel('Negar').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(desativados)
    );
  }

  // ---------- Mensagem da webhook chegou ----------
  async function handleMessage(message) {
    if (!CANAL_ID || !message.webhookId || message.channelId !== CANAL_ID) return;
    const ultimo = message.embeds[message.embeds.length - 1];
    const footer = ultimo?.footer?.text || '';
    const m = footer.match(/user_id:(\d{15,25})/);
    if (!m || !footer.includes('#fim')) return;
    const userId = m[1];

    const embed = new EmbedBuilder()
      .setColor(VERMELHO)
      .setTitle('⚖️ Decisão da candidatura')
      .setDescription(`Candidato: <@${userId}> (\`${userId}\`)\nStatus: ⏳ **Aguardando decisão**`)
      .setFooter(rodapePadrao('Recrutamento'));

    await message.reply({
      embeds: [embed],
      components: [botoes(userId)],
      allowedMentions: { parse: [], repliedUser: false },
    });
  }

  // ---------- Botões ----------
  async function handleButton(interaction) {
    const [, acao, userId] = interaction.customId.split('|');

    if (!podeDecidir(interaction)) {
      return interaction.reply({ content: '🚫 Você precisa da permissão **Gerenciar Cargos** para decidir candidaturas.', ephemeral: true });
    }

    // Trava: se outro moderador já decidiu, os botões estão desativados
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

    // ---- Aceitar ----
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
        content: '❌ Não consegui dar o cargo. Coloque o cargo da Zoe **acima** do cargo de staff na lista de cargos e confira o `STAFF_ROLE_ID`.',
        ephemeral: true,
      });
    }

    const dmOk = await membro
      .send(`🎉 Parabéns! Sua candidatura para a equipe de **${guild.name}** foi **aceita**. Bem-vindo(a) à staff!`)
      .then(() => true)
      .catch(() => false);

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(VERDE)
      .setDescription(
        `Candidato: <@${userId}> (\`${userId}\`)\nStatus: ✅ **Aceito** por ${interaction.user}` +
          `\nAviso no privado: ${dmOk ? 'enviado' : 'não foi possível (DM fechada)'}`
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
      const embed = EmbedBuilder.from(painel.embeds[0])
        .setColor(CINZA)
        .setDescription(
          `Candidato: <@${userId}> (\`${userId}\`)\nStatus: ❌ **Negado** por ${interaction.user}` +
            (motivo ? `\nMotivo: ${motivo}` : '') +
            `\nAviso no privado: ${dmOk ? 'enviado' : 'não foi possível (DM fechada ou saiu do servidor)'}`
        );
      await painel.edit({ embeds: [embed], components: [botoes(userId, true)] }).catch(() => {});
    }
    return interaction.editReply({ content: '✅ Candidatura negada.' });
  }

  return { handleMessage, handleButton, handleModal };
}
