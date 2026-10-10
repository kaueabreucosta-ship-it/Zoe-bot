/**
 * Anti-link: apaga mensagem com link de quem NÃO é moderador/owner.
 * Liga por padrão. Pra desligar: variável ANTILINK=off no Render.
 *
 * Quem pode mandar link: dono do bot (OWNER_ID), dono do servidor, cargos OWNER_ROLE_ID / MOD_ROLE_ID
 * e qualquer cargo chamado "Moderador" / "Owner" / "Dono" (o nome é comparado por palavra inteira).
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';
import { temLink, podeMandarLink } from './antilink-core.js';

export function createAntiLinkSystem({ client, getGuildConfig, ownerId, ownerRoleId = '', modRoleId = '' }) {
  const ativo = (process.env.ANTILINK || 'on').trim().toLowerCase() !== 'off';
  const idsLiberados = [ownerRoleId, modRoleId].filter(Boolean);
  const avisouSemPermissao = new Set(); // 1 aviso no log por canal (não enche o Render de texto)

  /** Devolve true se APAGOU a mensagem (quem chamou deve parar de processá-la). */
  async function handleMessage(message) {
    if (!ativo || !message.guild || message.author?.bot || message.webhookId) return false;
    if (!temLink(message.content)) return false;

    const membro = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!membro) return false; // sem saber os cargos, não arrisca apagar mensagem de staff

    const cargos = membro.roles.cache.map((r) => ({ id: r.id, name: r.name }));
    if (podeMandarLink({ userId: message.author.id, ownerId, guildOwnerId: message.guild.ownerId, cargos, idsLiberados })) return false;

    const podeApagar = message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages);
    if (!podeApagar) {
      if (!avisouSemPermissao.has(message.channel.id)) {
        avisouSemPermissao.add(message.channel.id);
        console.warn(`⚠️ Anti-link: sem "Gerenciar Mensagens" em #${message.channel.name} — não consigo apagar links lá.`);
      }
      return false;
    }

    const apagou = await message.delete().then(() => true).catch(() => false);
    if (!apagou) return false;

    const aviso = await message.channel
      .send({
        content: `🚫 ${message.author}, link não pode aqui — só **moderador** e **owner** mandam link.`,
        allowedMentions: { users: [message.author.id] },
      })
      .catch(() => null);
    if (aviso) setTimeout(() => aviso.delete().catch(() => {}), 6000);

    // Registro pra staff (mesmo canal de alerta do auto-mod)
    const config = await getGuildConfig(message.guild.id);
    const canalId = config.moderacao_canal_id || config.logs_canal_id;
    const canal = canalId ? await client.channels.fetch(canalId).catch(() => null) : null;
    if (canal) {
      const texto = String(message.content).slice(0, 900).replace(/`/g, "'");
      const embed = new EmbedBuilder()
        .setTitle('🔗 Anti-link')
        .setColor(CORES.aviso)
        .setDescription(`${message.author} mandou link em ${message.channel} e a mensagem foi apagada.\n\`\`\`${texto}\`\`\``)
        .setFooter(rodapePadrao('Ação automática, sem IA'))
        .setTimestamp();
      await canal.send({ embeds: [embed] }).catch(() => {});
    }

    console.log(`🔗 Anti-link: mensagem de ${message.author.tag} apagada em #${message.channel.name}.`);
    return true;
  }

  return { handleMessage };
}
