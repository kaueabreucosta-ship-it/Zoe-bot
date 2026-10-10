/**
 * Verificação via OAuth2 do site + coleta de webhook por DM + DM em massa.
 *
 * Fluxo:
 *  1. O site chama POST /verificar depois que a pessoa faz login com Discord
 *     (OAuth2) e a Eclipse confirma que ela está no servidor. A Eclipse manda uma DM
 *     com embed pedindo o link do webhook.
 *  2. A pessoa responde a DM com o link do webhook.
 *  3. A Eclipse valida o formato e avisa o site (POST /api/members) pra guardar
 *     o membro + webhook no dashboard de DM.
 *  4. Quando o admin clica "Enviar DM pra todos" no dashboard, o site chama
 *     POST /send-dm aqui, e a Eclipse manda a mensagem no privado de cada um
 *     (e no webhook, se tiver).
 *
 * Variáveis de ambiente:
 *   VERIFY_GUILD_ID     ID do servidor onde a verificação checa membresia
 *   SITE_API_URL        URL base do dashboard de DM (sem barra no final)
 *   BOT_SHARED_SECRET   segredo compartilhado entre a Eclipse e o site
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';

const WEBHOOK_REGEX = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const PAUSA_ENTRE_DMS_MS = 1200; // evita rate limit / flag de spam do Discord
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const PENDENTE_TTL_MS = 15 * 60 * 1000; // 15 minutos pra responder a DM

export function createVerificationSystem({ client, guildId, siteApiUrl, sharedSecret }) {
  const pendentes = new Map(); // discordId -> { username, expira }

  function limparPendentesExpirados() {
    const agora = Date.now();
    for (const [id, info] of pendentes) {
      if (info.expira < agora) pendentes.delete(id);
    }
  }

  async function isMember(discordId) {
    if (!guildId) throw new Error('VERIFY_GUILD_ID não configurado.');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('A Eclipse não está no servidor configurado em VERIFY_GUILD_ID.');
    const membro = await guild.members.fetch(discordId).catch(() => null);
    return {
      isMember: !!membro,
      username: membro ? membro.user.username : null,
    };
  }

  // Verificação sem webhook: o site já salvou o membro. Aqui só avisamos por DM.
  async function iniciarVerificacao(discordId, username) {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) throw new Error('Não encontrei esse usuário no Discord.');

    const embed = new EmbedBuilder()
      .setColor(CORES.alerta)
      .setTitle('✅ Você foi verificado!')
      .setDescription(
        `Tudo certo, **${username}**. Sua verificação foi concluída e você já está na lista de membros.\n\n` +
          'Não precisa fazer mais nada.'
      )
      .setFooter(rodapePadrao('Verificação'));

    try {
      await user.send({ embeds: [embed] });
    } catch {
      throw new Error('Não consegui mandar DM (a pessoa pode estar com DM fechada).');
    }
  }

  async function registrarWebhookNoSite(discordId, username, webhookUrl) {
    const res = await fetch(`${siteApiUrl}/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': sharedSecret },
      body: JSON.stringify({ discord_id: discordId, username, webhook_url: webhookUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'O site recusou o cadastro do webhook.');
    }
  }

  // Chamado pelo messageCreate do index.js pra toda DM recebida.
  // Retorna true se a mensagem era a resposta de uma verificação pendente.
  async function handleDM(message) {
    limparPendentesExpirados();
    const pendente = pendentes.get(message.author.id);
    if (!pendente) return false;

    const link = message.content.trim();
    if (!WEBHOOK_REGEX.test(link)) {
      await message
        .reply(
          '⚠️ Isso não parece um link de webhook válido. Deve ser algo como:\n' +
            '`https://discord.com/api/webhooks/123.../abc...`'
        )
        .catch(() => {});
      return true;
    }

    try {
      await registrarWebhookNoSite(message.author.id, pendente.username, link);
      pendentes.delete(message.author.id);
      await message.reply('✅ Webhook salvo! Você já está na lista de membros verificados.').catch(() => {});
    } catch (err) {
      await message.reply(`❌ Deu erro ao salvar: ${err.message}`).catch(() => {});
    }
    return true;
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === 'verify|webhook') {
      const pendente = pendentes.get(interaction.user.id);
      if (!pendente) {
        return interaction.reply({ content: '⚠️ Sua sessão de verificação expirou. Faça a verificação novamente no site.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId('verify|webhook-modal')
        .setTitle('Adicionar webhook');

      const input = new TextInputBuilder()
        .setCustomId('webhook_url')
        .setLabel('URL do webhook do Discord')
        .setPlaceholder('https://discord.com/api/webhooks/...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'verify|webhook-modal') {
      const pendente = pendentes.get(interaction.user.id);
      if (!pendente) {
        return interaction.reply({ content: '⚠️ Sua sessão de verificação expirou. Faça a verificação novamente no site.', ephemeral: true });
      }

      const link = interaction.fields.getTextInputValue('webhook_url').trim();
      if (!WEBHOOK_REGEX.test(link)) {
        return interaction.reply({
          content: '⚠️ URL inválida. Use uma URL de webhook do Discord, como `https://discord.com/api/webhooks/...`.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        await registrarWebhookNoSite(interaction.user.id, pendente.username, link);
        pendentes.delete(interaction.user.id);
        return interaction.editReply('✅ Webhook salvo! Você já está na lista de membros verificados.');
      } catch (err) {
        return interaction.editReply(`❌ Deu erro ao salvar: ${err.message}`);
      }
    }

    return false;
  }

  // Usado pelo POST /send-dm: manda a mesma mensagem na DM e no webhook de cada alvo.
  async function enviarDmEmMassa(mensagem, targets) {
    const resultados = [];
    for (const alvo of targets) {
      const item = { discord_id: alvo.discord_id, dm: false, webhook: null };
      try {
        const user = await client.users.fetch(alvo.discord_id);
        await user.send(mensagem);
        item.dm = true;
      } catch (err) {
        item.dmErro = err.message;
      }

      // Só posta em webhooks do próprio Discord (impede o bot de chamar URL qualquer)
      if (alvo.webhook_url) {
        if (!WEBHOOK_REGEX.test(alvo.webhook_url)) {
          item.webhook = false;
          item.webhookErro = 'URL de webhook inválida.';
        } else {
          try {
            const res = await fetch(alvo.webhook_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // parse: [] => @everyone/@here/menções NÃO notificam ninguém nos canais dos membros
              body: JSON.stringify({ content: mensagem, allowed_mentions: { parse: [] } }),
              signal: AbortSignal.timeout(10_000),
            });
            item.webhook = res.ok;
          } catch (err) {
            item.webhook = false;
            item.webhookErro = err.message;
          }
        }
      }
      resultados.push(item);
      await esperar(PAUSA_ENTRE_DMS_MS);
    }
    return resultados;
  }

  return { isMember, iniciarVerificacao, handleDM, handleInteraction, enviarDmEmMassa };
}
