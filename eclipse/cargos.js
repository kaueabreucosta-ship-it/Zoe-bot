import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { CORES, rodapePadrao } from './cores.js';

// ─────────────────────────────────────────────────────────────
// Painel /cargos — agora com seleção MÚLTIPLA.
// • Até 25 cargos e 25 canais de uma vez.
// • Tudo que você escolher vale para TODOS os cargos/canais selecionados.
// ─────────────────────────────────────────────────────────────

// Permissões de CARGO que podem ser escolhidas pelo painel (máx. 25 = limite do Discord).
// Administrator fica por último porque dá acesso total ao Discord.
const ROLE_PERMISSIONS = [
  ['ViewChannel', 'Ver canais'],
  ['SendMessages', 'Enviar mensagens'],
  ['ManageMessages', 'Gerenciar mensagens'],
  ['EmbedLinks', 'Links incorporados'],
  ['AttachFiles', 'Anexar arquivos'],
  ['ReadMessageHistory', 'Ver histórico'],
  ['AddReactions', 'Adicionar reações'],
  ['UseExternalEmojis', 'Emojis externos'],
  ['MentionEveryone', 'Mencionar @everyone'],
  ['ManageChannels', 'Gerenciar canais'],
  ['ManageRoles', 'Gerenciar cargos'],
  ['ManageWebhooks', 'Gerenciar webhooks'],
  ['KickMembers', 'Expulsar membros'],
  ['BanMembers', 'Banir membros'],
  ['ModerateMembers', 'Moderar membros'],
  ['ManageNicknames', 'Gerenciar apelidos'],
  ['ViewAuditLog', 'Ver registro de auditoria'],
  ['ManageGuild', 'Gerenciar servidor'],
  ['Connect', 'Conectar em voz'],
  ['Speak', 'Falar em voz'],
  ['MuteMembers', 'Mutar em voz'],
  ['DeafenMembers', 'Ensurdecer em voz'],
  ['MoveMembers', 'Mover membros em voz'],
  ['UseVAD', 'Detecção de voz'],
  ['Administrator', 'Administrador (acesso total)'],
].filter(([name]) => PermissionFlagsBits[name] !== undefined)
  .map(([name, label]) => ({ name, label, bit: PermissionFlagsBits[name] }));

// Permissões que podem ser definidas DENTRO de um canal (permitir / negar / neutro).
const CHANNEL_PERMISSIONS = [
  ['ViewChannel', 'Ver canal'],
  ['SendMessages', 'Enviar mensagens'],
  ['SendMessagesInThreads', 'Enviar em tópicos'],
  ['CreatePublicThreads', 'Criar tópicos públicos'],
  ['ReadMessageHistory', 'Ver histórico'],
  ['EmbedLinks', 'Links incorporados'],
  ['AttachFiles', 'Anexar arquivos'],
  ['AddReactions', 'Adicionar reações'],
  ['UseExternalEmojis', 'Emojis externos'],
  ['MentionEveryone', 'Mencionar @everyone'],
  ['ManageMessages', 'Gerenciar mensagens'],
  ['ManageChannels', 'Gerenciar canal'],
  ['ManageWebhooks', 'Gerenciar webhooks'],
  ['Connect', 'Conectar em voz'],
  ['Speak', 'Falar em voz'],
  ['Stream', 'Transmitir vídeo'],
  ['UseVAD', 'Detecção de voz'],
  ['MuteMembers', 'Mutar em voz'],
  ['MoveMembers', 'Mover membros em voz'],
].filter(([name]) => PermissionFlagsBits[name] !== undefined)
  .map(([name, label]) => ({ name, label }));

// Atalhos de permissões: preenchem a seleção, mas não aplicam nada sozinhos.
const ROLE_PERMISSION_PRESETS = {
  leitura: { label: 'Leitura', names: ['ViewChannel', 'ReadMessageHistory'] },
  chat: { label: 'Chat', names: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis'] },
  mod: { label: 'Moderação', names: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ViewAuditLog'] },
  equipe: { label: 'Equipe', names: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'ManageChannels', 'ManageNicknames', 'ViewAuditLog', 'ManageWebhooks'] },
  admin: { label: 'Administrador', names: ['Administrator'] },
};
const CHANNEL_PERMISSION_PRESETS = {
  leitura: { label: 'Leitura', names: ['ViewChannel', 'ReadMessageHistory'] },
  chat: { label: 'Chat', names: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis'] },
  voz: { label: 'Voz', names: ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD'] },
  mod: { label: 'Moderação', names: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'] },
};

const MAX_SELECT = 25; // limite do menu de cargos do Discord
const MAX_CANAIS = 100; // limite de canais por vez no painel de acesso
const STATE_TTL_MS = 30 * 60 * 1000;

// ───────────────────────── helpers ─────────────────────────

function isAdmin(interaction) {
  // zoeConcedido: o OWNER liberou o /cargos para o cargo da pessoa em /permissoes.
  return Boolean(interaction.zoeConcedido || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function hasManageRoles(interaction) {
  return Boolean(interaction.guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageRoles));
}

async function deny(interaction, content = '🚫 Apenas administradores podem usar este painel.') {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function isManageable(guild, role) {
  const highest = guild.members.me?.roles?.highest ?? null;
  return Boolean(role && highest && !role.managed && role.id !== guild.id && role.position < highest.position);
}

function motivo(error) {
  if (typeof error === 'string') return error;
  if (error?.code === 50013) return 'sem permissão / hierarquia';
  return String(error?.message ?? 'erro desconhecido').slice(0, 80);
}

function cut(text, max = 1500) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getRoles(guild, ids = []) {
  return ids.map((id) => guild.roles.cache.get(id)).filter(Boolean);
}

function getChannels(guild, ids = []) {
  return ids.map((id) => guild.channels.cache.get(id)).filter(Boolean);
}

/** Tipos de canal onde faz sentido aplicar overwrite de mensagem/voz. */
const CHANNEL_ACTION_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildForum,
  ChannelType.GuildStageVoice,
]);

/**
 * Expande a seleção: se o usuário escolheu uma categoria, inclui
 * automaticamente todos os canais filhos dela (texto, voz, fórum, etc.).
 * Mantém canais avulsos e remove duplicatas. Limita a MAX_SELECT.
 * Retorna { ids, expandedFromCategories }.
 */
function expandChannelSelection(guild, selectedIds = []) {
  const ids = new Set();
  let expandedFromCategories = 0;

  for (const id of selectedIds) {
    const ch = guild.channels.cache.get(id);
    if (!ch) continue;

    if (ch.type === ChannelType.GuildCategory) {
      // Inclui a própria categoria (overwrite herda) + todos os filhos
      ids.add(ch.id);
      const filhos = guild.channels.cache.filter(
        (c) => c.parentId === ch.id && CHANNEL_ACTION_TYPES.has(c.type),
      );
      for (const filho of filhos.values()) {
        if (ids.size >= MAX_CANAIS) break;
        if (!ids.has(filho.id)) {
          ids.add(filho.id);
          expandedFromCategories += 1;
        }
      }
    } else {
      ids.add(ch.id);
    }
    if (ids.size >= MAX_CANAIS) break;
  }

  return {
    ids: [...ids].slice(0, MAX_CANAIS),
    expandedFromCategories,
  };
}

function roleInfo(role) {
  const perms = ROLE_PERMISSIONS.filter(({ bit }) => role.permissions.has(bit)).map(({ label }) => label);
  return [
    `**Cargo:** <@&${role.id}>`,
    `**Nome:** ${role.name}`,
    `**Cor:** ${role.hexColor === '#000000' ? 'Padrão' : role.hexColor}`,
    `**Posição:** ${role.position}`,
    `**Menção:** ${role.mentionable ? 'Sim' : 'Não'}`,
    `**Exibir separado:** ${role.hoist ? 'Sim' : 'Não'}`,
    `**Administrador:** ${role.permissions.has(PermissionFlagsBits.Administrator) ? 'Sim' : 'Não'}`,
    `**Permissões:** ${perms.length ? perms.join(', ') : 'Nenhuma'}`,
  ].join('\n');
}

const mentionRoles = (roles) => roles.map((r) => (r.id === r.guild.id ? '@everyone' : `<@&${r.id}>`)).join(' ');
const ICONE_CANAL = {
  [ChannelType.GuildText]: '#',
  [ChannelType.GuildAnnouncement]: '📣',
  [ChannelType.GuildVoice]: '🔊',
  [ChannelType.GuildForum]: '💬',
  [ChannelType.GuildStageVoice]: '🎙️',
};

/**
 * Lista os canais pelo NOME (não por menção), agrupados por categoria.
 * Menção `<#id>` aparece como "canal desconhecido" quando quem vê não tem acesso ao canal;
 * o nome sempre aparece.
 */
function listarCanais(channels, max = 1100) {
  const cats = channels.filter((c) => c.type === ChannelType.GuildCategory);
  const catIds = new Set(cats.map((c) => c.id));
  const nome = (c) => `${ICONE_CANAL[c.type] ?? '#'} ${c.name}`;
  const linhas = [];
  for (const cat of cats) {
    linhas.push(`📁 **${cat.name}**`);
    for (const c of channels.filter((x) => x.type !== ChannelType.GuildCategory && x.parentId === cat.id)) {
      linhas.push(`　↳ ${nome(c)}`);
    }
  }
  for (const c of channels.filter((x) => x.type !== ChannelType.GuildCategory && !catIds.has(x.parentId))) {
    linhas.push(nome(c));
  }
  let texto = '';
  let restantes = linhas.length;
  for (const l of linhas) {
    if (texto.length + l.length + 1 > max) break;
    texto += `${l}\n`;
    restantes -= 1;
  }
  return `${texto.trim()}${restantes > 0 ? `\n… e mais ${restantes}` : ''}`;
}

function backButton(id = 'cargo|voltar') {
  return new ButtonBuilder().setCustomId(id).setLabel('↩️ Voltar').setStyle(ButtonStyle.Secondary);
}

function baseEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(CORES.master)
    .setTitle(title)
    .setDescription(cut(description, 4000))
    .setFooter(rodapePadrao('Gerenciador de cargos'));
}

// ───────────────────────── telas ─────────────────────────

function mainPanel(roles, notice = '') {
  let body;
  if (!roles.length) {
    body = 'Selecione **um ou vários cargos** para editar, ou use **Criar cargo** para criar um novo.';
  } else if (roles.length === 1) {
    body = `${roleInfo(roles[0])}\n\nUse os botões abaixo para editar este cargo.`;
  } else {
    body = `**${roles.length} cargos selecionados:**\n${mentionRoles(roles)}\n\n`
      + 'Tudo que você fizer nos botões abaixo vale para **todos** esses cargos.';
  }

  const menu = new RoleSelectMenuBuilder()
    .setCustomId('cargo|selecionar')
    .setPlaceholder('Selecione um ou vários cargos (até 25)')
    .setMinValues(1)
    .setMaxValues(MAX_SELECT);
  if (roles.length && typeof menu.setDefaultRoles === 'function') menu.setDefaultRoles(roles.map((r) => r.id));

  const none = !roles.length;
  return {
    embeds: [baseEmbed('🛠️ Gerenciador de cargos', `${notice ? `${notice}\n\n` : ''}${body}`)],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|criar').setLabel('➕ Criar cargo').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cargo|editar').setLabel(roles.length > 1 ? '🎨 Cor' : '✏️ Nome/cor').setStyle(ButtonStyle.Primary).setDisabled(none),
        new ButtonBuilder().setCustomId('cargo|perms').setLabel('🔐 Permissões').setStyle(ButtonStyle.Secondary).setDisabled(none),
        new ButtonBuilder().setCustomId('cargo|extras').setLabel('⚙️ Opções').setStyle(ButtonStyle.Secondary).setDisabled(none),
        new ButtonBuilder().setCustomId('cargo|excluir').setLabel('🗑️ Excluir').setStyle(ButtonStyle.Danger).setDisabled(none),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|canal').setLabel('📺 Acesso por canal').setStyle(ButtonStyle.Secondary).setDisabled(none),
      ),
    ],
  };
}

function permissionsPanel(roles, selected, notice = '', confirmar = false) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('cargo|perms-sel')
    .setPlaceholder('Marque várias permissões')
    .setMinValues(0)
    .setMaxValues(ROLE_PERMISSIONS.length)
    .addOptions(ROLE_PERMISSIONS.map(({ name, label }) => ({
      label: label.slice(0, 100),
      value: name,
      default: selected.includes(name),
    })));

  const alvo = roles.length === 1 ? `no cargo ${mentionRoles(roles)}` : `nos **${roles.length} cargos** selecionados`;
  const escolhidas = selected.length
    ? selected.map((n) => ROLE_PERMISSIONS.find((p) => p.name === n)?.label ?? n).join(', ')
    : 'nenhuma';

  return {
    embeds: [baseEmbed(
      `🔐 Permissões — ${roles.length === 1 ? roles[0].name : `${roles.length} cargos`}`,
      `${notice ? `${notice}\n\n` : ''}Escolha as permissões no menu e depois use um botão para aplicar ${alvo}:\n\n`
      + '➕ **Adicionar** — liga essas permissões e mantém o resto\n'
      + '➖ **Remover** — desliga só essas permissões\n'
      + '🔁 **Substituir** — deixa o cargo com exatamente essas (entre as da lista)\n'
      + '🚫 **Tirar todas** — zera TODAS as permissões do cargo (pede confirmação)\n\n'
      + `**Escolhidas:** ${escolhidas}`
      + (selected.includes('Administrator') ? '\n\n⚠️ **Administrador dá acesso total ao servidor.** Use somente em cargos confiáveis.' : ''),
    )],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|perm-quick-leitura').setLabel('👁️ Leitura').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|perm-quick-chat').setLabel('💬 Chat').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|perm-quick-mod').setLabel('🛡️ Moderação').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cargo|perm-quick-equipe').setLabel('🧰 Equipe').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cargo|perm-quick-admin').setLabel('👑 Admin').setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|perm-add').setLabel('➕ Adicionar').setStyle(ButtonStyle.Success).setDisabled(!selected.length),
        new ButtonBuilder().setCustomId('cargo|perm-rem').setLabel('➖ Remover').setStyle(ButtonStyle.Danger).setDisabled(!selected.length),
        new ButtonBuilder().setCustomId('cargo|perm-set').setLabel('🔁 Substituir').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('cargo|perm-zerar')
          .setLabel(confirmar ? '⚠️ Confirmar: tirar TODAS' : '🚫 Tirar todas')
          .setStyle(ButtonStyle.Danger),
        backButton(),
      ),
    ],
  };
}

function extrasPanel(roles, notice = '') {
  return {
    embeds: [baseEmbed(
      `⚙️ Opções — ${roles.length === 1 ? roles[0].name : `${roles.length} cargos`}`,
      `${notice ? `${notice}\n\n` : ''}Configure como os cargos aparecem e se podem ser mencionados.`,
    )],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|hoist-on').setLabel('📌 Exibir separado').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|hoist-off').setLabel('↩️ Tirar destaque').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|mention-on').setLabel('🔔 Permitir menção').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|mention-off').setLabel('🚫 Bloquear menção').setStyle(ButtonStyle.Secondary),
        backButton(),
      ),
    ],
  };
}

function confirmDeletePanel(roles) {
  return {
    embeds: [baseEmbed(
      '🗑️ Confirmar exclusão',
      `Tem certeza que quer **excluir ${roles.length} cargo(s)**?\n${mentionRoles(roles)}\n\n⚠️ Isso não pode ser desfeito.`,
    )],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|excluir-ok').setLabel('🗑️ Sim, excluir').setStyle(ButtonStyle.Danger),
        backButton(),
      ),
    ],
  };
}

const SEM_CATEGORIA = '__sem_categoria__';

/** Canais "de verdade" (texto, voz, fórum...) de uma categoria, na ordem do servidor. */
function canaisDaCategoria(guild, catId) {
  return [...guild.channels.cache.values()]
    .filter((c) => CHANNEL_ACTION_TYPES.has(c.type) && (catId === SEM_CATEGORIA ? !c.parentId : c.parentId === catId))
    .sort((x, y) => x.rawPosition - y.rawPosition);
}

function canalOpcao(c, marcado) {
  return { label: `${ICONE_CANAL[c.type] ?? '#'} ${c.name}`.slice(0, 100), value: c.id, default: marcado };
}

/**
 * Tela "Acesso por canal" organizada por categoria:
 *  1) escolhe a categoria  →  2) marca os canais dela (ou a categoria toda)  →  3) escolhe o que os cargos podem fazer.
 * A escolha é somada entre categorias (até MAX_CANAIS canais).
 */
function channelPanel(guild, roles, channels, st = {}, notice = '') {
  const marcados = new Set(st.channelIds ?? []);
  const navCats = st.navCats ?? [];
  const navCat = navCats.length === 1 ? navCats[0] : null; // canais um a um só com 1 categoria aberta

  // ── 1) Menu de categorias ──
  const categorias = [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((x, y) => x.rawPosition - y.rawPosition);
  const opcoesCat = [];
  const descCat = (filhos) => {
    const m = filhos.filter((c) => marcados.has(c.id)).length;
    return `${filhos.length} canal(is)${m ? ` · ${m} marcado(s)` : ''}`;
  };
  const soltos = canaisDaCategoria(guild, SEM_CATEGORIA);
  if (soltos.length) {
    opcoesCat.push({ label: 'Canais sem categoria', value: SEM_CATEGORIA, description: descCat(soltos), default: navCats.includes(SEM_CATEGORIA) });
  }
  for (const cat of categorias) {
    opcoesCat.push({
      label: `📁 ${cat.name}`.slice(0, 100),
      value: cat.id,
      description: descCat(canaisDaCategoria(guild, cat.id)).slice(0, 100),
      default: navCats.includes(cat.id),
    });
  }
  const cortouCats = opcoesCat.length > 25;
  const linhas = [];
  if (opcoesCat.length) {
    linhas.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cargo|cat-select')
        .setPlaceholder('1️⃣ Escolha uma ou várias categorias')
        .setMinValues(0)
        .setMaxValues(Math.min(opcoesCat.length, 25))
        .addOptions(opcoesCat.slice(0, 25)),
    ));
  }

  // ── 2) Menu de canais da categoria aberta ──
  let nomeAberta = '';
  let filhosAbertos = [];
  if (navCat) {
    const catObj = navCat === SEM_CATEGORIA ? null : guild.channels.cache.get(navCat);
    nomeAberta = navCat === SEM_CATEGORIA ? 'Canais sem categoria' : (catObj?.name ?? 'categoria');
    filhosAbertos = canaisDaCategoria(guild, navCat);
    if (filhosAbertos.length) {
      const lista = filhosAbertos.slice(0, 25);
      linhas.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cargo|canal-sel')
          .setPlaceholder('2️⃣ Marque os canais desta categoria')
          .setMinValues(0)
          .setMaxValues(lista.length)
          .addOptions(lista.map((c) => canalOpcao(c, marcados.has(c.id)))),
      ));
    }
  }

  const none = !channels.length;
  const cats = channels.filter((c) => c.type === ChannelType.GuildCategory).length;
  const temEveryone = roles.some((r) => r.id === guild.id);
  const partes = [notice];
  partes.push(`**Cargos (${roles.length}):** ${mentionRoles(roles)}`);
  if (temEveryone) {
    partes.push('⚠️ **@everyone está nos cargos escolhidos.** Qualquer ação aqui vale para **TODO MUNDO do servidor**. Vou pedir confirmação antes de aplicar.');
  }
  if (navCats.length > 1) {
    const nomes = navCats.map((id) => (id === SEM_CATEGORIA ? 'Sem categoria' : guild.channels.cache.get(id)?.name ?? '?'));
    partes.push(`📂 **Abertas (${navCats.length}):** ${nomes.join(', ')}\n_Toque em **Categorias inteiras** para marcar todas de uma vez. Para marcar canais um por um, deixe só uma categoria aberta._`);
  } else if (navCat) {
    partes.push(`📂 **Aberta agora:** ${nomeAberta}`
      + (filhosAbertos.length > 25 ? `\n_Mostrando os 25 primeiros de ${filhosAbertos.length}. Use **Categorias inteiras** para pegar todos._` : '')
      + (!filhosAbertos.length ? '\n_Não tem canais dentro dela._' : ''));
  }
  if (channels.length) {
    partes.push(`**Canais escolhidos (${channels.length}${cats ? `, com ${cats} categoria(s)` : ''}):**\n${listarCanais(channels)}`);
    partes.push(`🎯 **Vai mexer em ${channels.length} canal(is) × ${roles.length} cargo(s)** — nada além disso.`
      + (cats ? '\n_Categoria escolhida afeta os canais dela que seguem a categoria (sincronizados)._' : ''));
    partes.push('**3️⃣** Toque no que esses cargos podem fazer. Errou? Use **↩️ Desfazer** logo depois.\n_Quer outra categoria? Escolha no menu 1️⃣, a escolha é somada._');
  } else {
    partes.push('**1️⃣** Escolha **uma ou várias categorias** no menu abaixo.\n**2️⃣** Marque os canais (com 1 categoria aberta) ou toque em **Categorias inteiras**.\n**3️⃣** Toque no que os cargos podem fazer neles.');
  }
  if (cortouCats) partes.push('_O Discord só mostra 25 categorias no menu. As primeiras estão listadas._');

  linhas.push(
    new ActionRowBuilder().addComponents(
      ...[
        ['ver', ButtonStyle.Success],
        ['ocultar', ButtonStyle.Danger],
        ['escrever', ButtonStyle.Primary],
        ['somente', ButtonStyle.Secondary],
        ['limpar', ButtonStyle.Secondary],
      ].map(([id, estilo]) => {
        const confirmando = st.confirmCanal === id;
        return new ButtonBuilder()
          .setCustomId(`cargo|${id}`)
          .setLabel(confirmando ? '⚠️ Confirmar' : ROTULO_PRESET[id])
          .setStyle(confirmando ? ButtonStyle.Danger : estilo)
          .setDisabled(none);
      }),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cargo|cat-toda').setLabel('📁 Categorias inteiras').setStyle(ButtonStyle.Success).setDisabled(!navCats.length),
      new ButtonBuilder().setCustomId('cargo|desfazer').setLabel('↩️ Desfazer').setStyle(ButtonStyle.Secondary).setDisabled(!st.undo),
      new ButtonBuilder().setCustomId('cargo|sel-limpar').setLabel('🗑️ Limpar').setStyle(ButtonStyle.Secondary).setDisabled(none),
      new ButtonBuilder().setCustomId('cargo|canal-adv').setLabel('🔧 Avançado').setStyle(ButtonStyle.Primary).setDisabled(none),
      backButton(),
    ),
  );

  return {
    embeds: [baseEmbed('📺 Acesso por canal', partes.filter(Boolean).join('\n\n'))],
    components: linhas,
  };
}

function channelPermsPanel(roles, channels, selected, notice = '') {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('cargo|canal-perms-sel')
    .setPlaceholder('Marque várias permissões do canal')
    .setMinValues(0)
    .setMaxValues(CHANNEL_PERMISSIONS.length)
    .addOptions(CHANNEL_PERMISSIONS.map(({ name, label }) => ({
      label: label.slice(0, 100),
      value: name,
      default: selected.includes(name),
    })));

  const escolhidas = selected.length
    ? selected.map((n) => CHANNEL_PERMISSIONS.find((p) => p.name === n)?.label ?? n).join(', ')
    : 'nenhuma';

  return {
    embeds: [baseEmbed(
      '🔧 Permissões avançadas do canal',
      [
        notice,
        `**Cargos (${roles.length}):** ${mentionRoles(roles)}`,
        `**Canais (${channels.length}):**\n${listarCanais(channels)}`,
        'Escolha as permissões e aplique em todos os cargos × canais acima:\n\n'
        + '✅ **Permitir** — libera\n❌ **Negar** — bloqueia\n⬜ **Neutro** — remove a regra (volta a herdar)\n\n'
        + `**Escolhidas:** ${escolhidas}`,
        '_Atalhos abaixo selecionam várias permissões de uma vez; depois escolha Permitir, Negar ou Neutro._',
      ].filter(Boolean).join('\n\n'),
    )],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|ch-quick-leitura').setLabel('👁️ Leitura').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|ch-quick-chat').setLabel('💬 Chat').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|ch-quick-voz').setLabel('🎙️ Voz').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cargo|ch-quick-mod').setLabel('🛡️ Moderação').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cargo|ch-quick-limpar').setLabel('🧹 Limpar').setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cargo|ch-allow').setLabel('✅ Permitir').setStyle(ButtonStyle.Success).setDisabled(!selected.length),
        new ButtonBuilder().setCustomId('cargo|ch-deny').setLabel('❌ Negar').setStyle(ButtonStyle.Danger).setDisabled(!selected.length),
        new ButtonBuilder().setCustomId('cargo|ch-reset').setLabel('⬜ Neutro').setStyle(ButtonStyle.Secondary).setDisabled(!selected.length),
        backButton('cargo|canal'),
      ),
    ],
  };
}

function render(guild, st, notice = '') {
  const roles = getRoles(guild, st.roleIds);
  const channels = getChannels(guild, st.channelIds);

  if (!roles.length) return mainPanel([], notice);

  switch (st.screen) {
    case 'perms': return permissionsPanel(roles, st.permSel ?? [], notice, Boolean(st.zerarOk));
    case 'extras': return extrasPanel(roles, notice);
    case 'excluir': return confirmDeletePanel(roles);
    case 'canal': return channelPanel(guild, roles, channels, st, notice);
    case 'canal-perms':
      if (!channels.length) return channelPanel(guild, roles, channels, st, notice);
      return channelPermsPanel(roles, channels, st.chPermSel ?? [], notice);
    default: return mainPanel(roles, notice);
  }
}

// ───────────────────────── execução em lote ─────────────────────────

// Aplica `fn` a cada cargo que o bot consegue gerenciar; os outros entram na lista de falhas.
async function runOnRoles(guild, roles, fn) {
  const ok = [];
  const fail = [];
  for (const role of roles) {
    if (!isManageable(guild, role)) {
      fail.push([role, 'acima do meu cargo, integração ou @everyone']);
      continue;
    }
    try {
      await fn(role);
      ok.push(role);
    } catch (error) {
      fail.push([role, motivo(error)]);
    }
  }
  return { ok, fail };
}

function resumoCargos(verbo, { ok, fail }) {
  const linhas = [];
  if (ok.length) linhas.push(`✅ ${verbo} em **${ok.length}** cargo(s).`);
  if (fail.length) {
    linhas.push(`⚠️ Não consegui em ${fail.length}: ${fail.slice(0, 5).map(([r, why]) => `**${r.name}** (${why})`).join('; ')}${fail.length > 5 ? '…' : ''}`);
  }
  return cut(linhas.join('\n'), 1200);
}

// Aplica `fn(canal, cargo)` em todas as combinações cargo × canal.
async function runOnChannels(channels, roles, fn) {
  let okCount = 0;
  const fail = [];
  for (const channel of channels) {
    for (const role of roles) {
      try {
        await fn(channel, role);
        okCount += 1;
      } catch (error) {
        fail.push(`#${channel.name} / ${role.name}: ${motivo(error)}`);
      }
    }
  }
  return { okCount, fail, total: channels.length * roles.length };
}

function resumoCanais({ okCount, fail, total }) {
  const linhas = [];
  if (okCount) linhas.push(`✅ ${okCount}/${total} alteração(ões) aplicada(s).`);
  if (fail.length) linhas.push(`⚠️ Falhou em ${fail.length}: ${fail.slice(0, 4).join('; ')}${fail.length > 4 ? '…' : ''}`);
  return cut(linhas.join('\n'), 1200);
}

const ROTULO_PRESET = {
  ver: '👁️ Pode ver',
  ocultar: '🙈 Não pode ver',
  escrever: '✍️ Escrever/falar',
  somente: '🔒 Só leitura',
  limpar: '🧹 Limpar regras',
};

/** Guarda o estado atual das regras (cargo × canal) para poder desfazer. */
function tirarSnapshot(channels, roles) {
  const itens = [];
  for (const channel of channels) {
    for (const role of roles) {
      const ow = channel.permissionOverwrites?.cache?.get(role.id);
      itens.push({
        channelId: channel.id,
        roleId: role.id,
        allow: ow ? ow.allow.toArray() : null,
        deny: ow ? ow.deny.toArray() : null,
      });
    }
  }
  return itens;
}

async function restaurarSnapshot(guild, itens, reason) {
  let ok = 0;
  let falhas = 0;
  const chaves = Object.keys(PermissionFlagsBits).filter((k) => PermissionFlagsBits[k] !== undefined);
  for (const it of itens) {
    const channel = guild.channels.cache.get(it.channelId);
    const role = guild.roles.cache.get(it.roleId);
    if (!channel || !role) { falhas += 1; continue; }
    try {
      if (!it.allow) {
        if (channel.permissionOverwrites.cache.has(role.id)) await channel.permissionOverwrites.delete(role, reason);
      } else {
        const exato = Object.fromEntries(chaves.map((k) => [k, it.allow.includes(k) ? true : it.deny.includes(k) ? false : null]));
        await channel.permissionOverwrites.edit(role, exato, { reason });
      }
      ok += 1;
    } catch {
      falhas += 1;
    }
  }
  return { ok, falhas };
}

function presetOverwrite(action, channel) {
  const voice = Boolean(channel.isVoiceBased?.());
  switch (action) {
    case 'ver': return { ViewChannel: true };
    case 'ocultar': return { ViewChannel: false };
    case 'escrever': return voice ? { ViewChannel: true, Connect: true, Speak: true } : { ViewChannel: true, SendMessages: true };
    case 'somente': return voice ? { ViewChannel: true, Connect: true, Speak: false } : { ViewChannel: true, SendMessages: false };
    default: return null;
  }
}

function toBits(names) {
  return names
    .map((name) => ROLE_PERMISSIONS.find((p) => p.name === name)?.bit)
    .filter((bit) => typeof bit === 'bigint' || typeof bit === 'number');
}

function currentRolePermissionSelection(role) {
  if (role.permissions.has(PermissionFlagsBits.Administrator)) return ['Administrator'];
  return ROLE_PERMISSIONS.filter(({ bit }) => role.permissions.has(bit)).map(({ name }) => name);
}

// ───────────────────────── comando ─────────────────────────

export function buildRoleCommands() {
  return [
    new SlashCommandBuilder()
      .setName('cargos')
      .setDescription('Painel para criar, editar e configurar cargos e canais (vários de uma vez)'),
  ];
}

export function createRoleSystem() {
  // Estado por mensagem: guarda cargos/canais/permissões escolhidos ao trocar de tela.
  const panelState = new Map();

  function pruneState() {
    const limit = Date.now() - STATE_TTL_MS;
    for (const [id, st] of panelState) if (st.at < limit) panelState.delete(id);
  }

  function setState(messageId, data) {
    if (!messageId) return null;
    pruneState();
    const st = { screen: 'main', roleIds: [], channelIds: [], permSel: [], chPermSel: [], ...data, at: Date.now() };
    panelState.set(messageId, st);
    return st;
  }

  function getState(interaction) {
    const id = interaction.message?.id;
    const st = id ? panelState.get(id) : null;
    if (st) st.at = Date.now();
    return st ?? null;
  }

  async function ensureAdmin(interaction) {
    if (!interaction.guild) {
      await deny(interaction, '❌ Este painel só funciona dentro de um servidor.');
      return false;
    }
    if (!isAdmin(interaction)) {
      await deny(interaction);
      return false;
    }
    return true;
  }

  async function ensureBotCanManage(interaction) {
    if (!hasManageRoles(interaction)) {
      await deny(interaction, '❌ Eu preciso da permissão **Gerenciar cargos** para usar esta função.');
      return false;
    }
    return true;
  }

  async function showCreateModal(interaction) {
    const modal = new ModalBuilder().setCustomId('cargo|criar-modal').setTitle('Criar cargo');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('nome').setLabel('Nome do cargo').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder('Ex.: Moderador'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('cor').setLabel('Cor HEX (opcional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7).setPlaceholder('#8A2BE2'),
      ),
    );
    return interaction.showModal(modal);
  }

  async function showEditModal(interaction, roles) {
    const single = roles.length === 1;
    const modal = new ModalBuilder()
      .setCustomId('cargo|editar-modal')
      .setTitle(single ? 'Editar cargo' : `Cor para ${roles.length} cargos`);

    if (single) {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('nome').setLabel('Nome').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(roles[0].name),
        ),
      );
    }
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('cor')
          .setLabel(single ? 'Cor HEX (opcional)' : 'Cor HEX (vale para todos)')
          .setStyle(TextInputStyle.Short)
          .setRequired(!single)
          .setMaxLength(7)
          .setPlaceholder('#8A2BE2')
          .setValue(single && roles[0].hexColor !== '#000000' ? roles[0].hexColor : ''),
      ),
    );
    return interaction.showModal(modal);
  }

  async function sessionExpired(interaction) {
    return deny(interaction, '⌛ Esse painel expirou. Use **/cargos** novamente.');
  }

  async function handle(interaction) {
    if (!(await ensureAdmin(interaction))) return;
    const guild = interaction.guild;

    try {
      // ── /cargos ──
      if (interaction.isChatInputCommand() && interaction.commandName === 'cargos') {
        if (!(await ensureBotCanManage(interaction))) return;
        await interaction.reply({ ...mainPanel([]), flags: MessageFlags.Ephemeral });
        const message = await interaction.fetchReply();
        setState(message.id, {});
        return;
      }

      // ── Select de cargos (múltiplo) ──
      if (interaction.isRoleSelectMenu() && interaction.customId === 'cargo|selecionar') {
        const roles = (interaction.values || []).map((id) => guild.roles.cache.get(id)).filter(Boolean);
        if (!roles.length) return deny(interaction, '❌ Cargo não encontrado.');
        const usable = roles.filter((r) => !r.managed);
        const skipped = roles.length - usable.length;
        if (!usable.length) return deny(interaction, '❌ Esses cargos são gerenciados por integrações e não podem ser alterados.');

        const st = getState(interaction) ?? setState(interaction.message?.id, {});
        st.roleIds = usable.map((r) => r.id);
        st.screen = 'main';
        const notice = skipped ? `ℹ️ ${skipped} cargo(s) de integração foram ignorados.` : '';
        return interaction.update(render(guild, st, notice));
      }

      // ── Menu 1: escolher a categoria que quer abrir ──
      if (interaction.isStringSelectMenu() && interaction.customId === 'cargo|cat-select') {
        const st = getState(interaction);
        if (!st) return sessionExpired(interaction);
        st.navCats = interaction.values ?? [];
        // Escolher categorias para navegar limpa alvos antigos; assim os botões
        // nunca aplicam regras acidentalmente a canais de uma seleção anterior.
        st.channelIds = [];
        st.screen = 'canal';
        return interaction.update(render(guild, st, '📂 Categoria(s) selecionada(s). Marque os canais desejados ou use **Categorias inteiras** para definir os alvos.'));
      }

      // ── Menu 2: marcar canais da categoria aberta (soma com o que já estava escolhido) ──
      if (interaction.isStringSelectMenu() && interaction.customId === 'cargo|canal-sel') {
        const st = getState(interaction);
        if (!st || st.navCats?.length !== 1) return sessionExpired(interaction);
        const daCategoria = new Set(canaisDaCategoria(guild, st.navCats[0]).map((c) => c.id));
        const ids = (interaction.values || []).filter((id) => daCategoria.has(id)).slice(0, MAX_CANAIS);
        // A seleção atual substitui a anterior: só os canais marcados recebem as ações.
        st.channelIds = ids;
        st.screen = 'canal';
        const aviso = ids.length ? `🎯 Selecionados somente ${ids.length} canal(is) desta categoria.` : '🎯 Nenhum canal selecionado. Os botões não aplicarão alterações.';
        return interaction.update(render(guild, st, aviso));
      }

      // ── Select de canais (múltiplo) + expansão de categorias ──
      if (interaction.isChannelSelectMenu() && interaction.customId === 'cargo|canal-select') {
        let st = getState(interaction);
        if (!st) {
          // Estado perdido (bot reiniciou): recria a partir da seleção atual
          st = setState(interaction.message?.id, { screen: 'canal', roleIds: [], channelIds: [] });
          if (!st) return sessionExpired(interaction);
        }
        const { ids, expandedFromCategories } = expandChannelSelection(guild, interaction.values || []);
        st.channelIds = ids;
        st.screen = 'canal';
        st.at = Date.now();
        const notice = expandedFromCategories
          ? `✅ Categoria expandida: **+${expandedFromCategories}** canal(is) incluído(s). Total: **${ids.length}** (máx. ${MAX_CANAIS}).\n_No celular: toque em vários canais antes de confirmar._`
          : ids.length > 1
            ? `✅ **${ids.length}** canais selecionados.`
            : '';
        return interaction.update(render(guild, st, notice));
      }

      // ── Select de permissões do cargo ──
      if (interaction.isStringSelectMenu() && interaction.customId === 'cargo|perms-sel') {
        const st = getState(interaction);
        if (!st) return sessionExpired(interaction);
        st.permSel = interaction.values.filter((v) => ROLE_PERMISSIONS.some((p) => p.name === v));
        st.zerarOk = false;
        st.screen = 'perms';
        return interaction.update(render(guild, st));
      }

      // ── Select de permissões do canal ──
      if (interaction.isStringSelectMenu() && interaction.customId === 'cargo|canal-perms-sel') {
        const st = getState(interaction);
        if (!st) return sessionExpired(interaction);
        st.chPermSel = interaction.values.filter((v) => CHANNEL_PERMISSIONS.some((p) => p.name === v));
        st.screen = 'canal-perms';
        return interaction.update(render(guild, st));
      }

      // ── Modal: criar cargo ──
      if (interaction.isModalSubmit() && interaction.customId === 'cargo|criar-modal') {
        if (!(await ensureBotCanManage(interaction))) return;
        const nome = interaction.fields.getTextInputValue('nome').trim();
        const cor = interaction.fields.getTextInputValue('cor').trim();
        if (!nome) return deny(interaction, '❌ O nome do cargo não pode ficar vazio.');
        if (cor && !/^#[0-9a-fA-F]{6}$/.test(cor)) return deny(interaction, '❌ Cor inválida. Use `#RRGGBB`, por exemplo `#8A2BE2`.');

        const role = await guild.roles.create({
          name: nome,
          color: cor || 0,
          reason: `Criado pelo painel por ${interaction.user.tag}`,
        });

        const st = getState(interaction) ?? setState(interaction.message?.id, {});
        if (st) { st.roleIds = [role.id]; st.screen = 'main'; }
        const payload = render(guild, st ?? { screen: 'main', roleIds: [role.id], channelIds: [] }, '✅ Cargo criado com sucesso.');

        if (interaction.isFromMessage?.()) return interaction.update(payload);
        return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }

      // ── Modal: editar nome/cor ──
      if (interaction.isModalSubmit() && interaction.customId === 'cargo|editar-modal') {
        if (!(await ensureBotCanManage(interaction))) return;
        const st = getState(interaction);
        if (!st) return sessionExpired(interaction);
        const roles = getRoles(guild, st.roleIds);
        if (!roles.length) return deny(interaction, '❌ Cargo não encontrado.');

        const temNome = interaction.fields.fields.has('nome');
        const nome = temNome ? interaction.fields.getTextInputValue('nome').trim() : null;
        const cor = interaction.fields.getTextInputValue('cor').trim();
        if (temNome && !nome) return deny(interaction, '❌ O nome do cargo não pode ficar vazio.');
        if (cor && !/^#[0-9a-fA-F]{6}$/.test(cor)) return deny(interaction, '❌ Cor inválida. Use `#RRGGBB`.');

        await interaction.deferUpdate();
        const result = await runOnRoles(guild, roles, (role) => role.edit({
          ...(temNome ? { name: nome } : {}),
          color: cor || 0,
          reason: `Editado pelo painel por ${interaction.user.tag}`,
        }));
        st.screen = 'main';
        return interaction.editReply(render(guild, st, resumoCargos('Atualizado', result)));
      }

      // ── Botões ──
      if (interaction.isButton() && interaction.customId.startsWith('cargo|')) {
        const action = interaction.customId.split('|')[1];

        if (action === 'criar') return showCreateModal(interaction);

        const st = getState(interaction);
        if (!st) return sessionExpired(interaction);
        const roles = getRoles(guild, st.roleIds);
        if (!roles.length) return deny(interaction, '❌ Selecione pelo menos um cargo pelo menu acima.');

        const needsBot = [
          'editar', 'perm-add', 'perm-rem', 'perm-set', 'perm-zerar', 'hoist-on', 'hoist-off', 'mention-on', 'mention-off',
          'excluir-ok', 'ver', 'ocultar', 'escrever', 'somente', 'limpar', 'ch-allow', 'ch-deny', 'ch-reset', 'desfazer',
        ];
        if (needsBot.includes(action) && !(await ensureBotCanManage(interaction))) return;

        // As confirmações valem só para o próximo toque.
        if (action !== 'perm-zerar') st.zerarOk = false;
        if (!['ver', 'ocultar', 'escrever', 'somente', 'limpar'].includes(action)) st.confirmCanal = null;

        // Navegação
        if (action === 'voltar') { st.screen = 'main'; return interaction.update(render(guild, st)); }
        if (action === 'editar') return showEditModal(interaction, roles);
        if (action === 'extras') { st.screen = 'extras'; return interaction.update(render(guild, st)); }
        if (action === 'excluir') { st.screen = 'excluir'; return interaction.update(render(guild, st)); }
        if (action === 'canal') { st.screen = 'canal'; return interaction.update(render(guild, st)); }
        if (action === 'cat-toda') {
          if (!st.navCats?.length) return deny(interaction, '❌ Escolha pelo menos uma categoria no menu 1️⃣ primeiro.');
          // Categorias inteiras substitui os alvos anteriores, não soma canais antigos.
          const ids = new Set();
          for (const catId of st.navCats) {
            if (catId === SEM_CATEGORIA) {
              for (const c of canaisDaCategoria(guild, SEM_CATEGORIA)) ids.add(c.id);
            } else {
              for (const id of expandChannelSelection(guild, [catId]).ids) ids.add(id);
            }
          }
          const total = ids.size;
          st.channelIds = [...ids].slice(0, MAX_CANAIS);
          st.screen = 'canal';
          const corte = total > MAX_CANAIS ? ` ⚠️ Passou do limite, ficaram só os primeiros ${MAX_CANAIS}.` : '';
          return interaction.update(render(guild, st, `✅ ${st.navCats.length > 1 ? 'Categorias marcadas' : 'Categoria marcada'}. Total: **${st.channelIds.length}** canal(is).${corte}`));
        }

        if (action === 'sel-limpar') {
          st.channelIds = [];
          st.screen = 'canal';
          return interaction.update(render(guild, st, '🗑️ Escolha limpa.'));
        }


        if (action === 'perms') {
          // Com um único cargo, já vem marcado com as permissões atuais.
          st.permSel = roles.length === 1
            ? currentRolePermissionSelection(roles[0])
            : [];
          st.screen = 'perms';
          return interaction.update(render(guild, st));
        }

        if (action === 'canal-adv') {
          if (!st.channelIds.length) return deny(interaction, '❌ Selecione pelo menos um canal primeiro.');
          st.screen = 'canal-perms';
          return interaction.update(render(guild, st));
        }

        // ── Tirar TODAS as permissões (com confirmação) ──
        if (action === 'perm-zerar') {
          if (!st.zerarOk) {
            st.zerarOk = true;
            st.screen = 'perms';
            const alvo = roles.length === 1 ? `do cargo ${mentionRoles(roles)}` : `dos **${roles.length} cargos** selecionados`;
            return interaction.update(render(guild, st, `⚠️ Isso vai tirar **TODAS** as permissões ${alvo}. Toque em **Confirmar** para continuar, ou em outro botão para cancelar.`));
          }
          st.zerarOk = false;
          await interaction.deferUpdate();
          const reason = `Todas as permissões removidas pelo painel por ${interaction.user.tag}`;
          const result = await runOnRoles(guild, roles, (role) => role.setPermissions(0n, reason));
          st.screen = 'perms';
          st.permSel = [];
          return interaction.editReply(render(guild, st, resumoCargos('Todas as permissões removidas', result)));
        }

        // ── Atalhos rápidos e permissões de cargo em lote ──
        // Atalho de cargo: seleciona um conjunto e deixa a aplicação para o botão de confirmação.
        if (action.startsWith('perm-quick-')) {
          const key = action.slice('perm-quick-'.length);
          const preset = ROLE_PERMISSION_PRESETS[key];
          if (!preset) return deny(interaction, '❌ Atalho de permissão desconhecido.');
          st.permSel = preset.names.filter((name) => ROLE_PERMISSIONS.some((p) => p.name === name));
          st.zerarOk = false;
          st.screen = 'perms';
          const warning = key === 'admin' ? '\n⚠️ Esse atalho inclui **Administrador**, que libera acesso total ao servidor.' : '';
          return interaction.update(render(guild, st, `⚡ Atalho **${preset.label}** selecionado (${st.permSel.length} permissões). Agora confirme em **Adicionar** ou **Substituir**.${warning}`));
        }

        // Atalho avançado de canal: seleciona permissões, sem alterar regras até confirmar.
        if (action.startsWith('ch-quick-')) {
          const key = action.slice('ch-quick-'.length);
          if (key === 'limpar') {
            st.chPermSel = [];
            st.screen = 'canal-perms';
            return interaction.update(render(guild, st, '🧹 Seleção de permissões limpa. Nenhuma regra foi alterada.'));
          }
          const preset = CHANNEL_PERMISSION_PRESETS[key];
          if (!preset) return deny(interaction, '❌ Atalho de canal desconhecido.');
          st.chPermSel = preset.names.filter((name) => CHANNEL_PERMISSIONS.some((p) => p.name === name));
          st.screen = 'canal-perms';
          return interaction.update(render(guild, st, `⚡ Atalho **${preset.label}** selecionado (${st.chPermSel.length} permissões). Agora escolha **Permitir**, **Negar** ou **Neutro** para aplicar.`));
        }

        if (['perm-add', 'perm-rem', 'perm-set'].includes(action)) {
          const bits = toBits(st.permSel);
          if (action !== 'perm-set' && !bits.length) return deny(interaction, '❌ Escolha pelo menos uma permissão no menu.');

          await interaction.deferUpdate();
          const allListed = ROLE_PERMISSIONS.map((p) => p.bit);
          const reason = `Permissões alteradas pelo painel por ${interaction.user.tag}`;
          const result = await runOnRoles(guild, roles, (role) => {
            let next;
            if (action === 'perm-add') next = role.permissions.add(bits);
            else if (action === 'perm-rem') next = role.permissions.remove(bits);
            else next = role.permissions.remove(allListed).add(bits); // mantém o que não está na lista do painel
            return role.setPermissions(next, reason);
          });
          const verbo = { 'perm-add': 'Permissões adicionadas', 'perm-rem': 'Permissões removidas', 'perm-set': 'Permissões substituídas' }[action];
          st.screen = 'perms';
          if (roles.length === 1) {
            st.permSel = currentRolePermissionSelection(roles[0]);
          }
          return interaction.editReply(render(guild, st, resumoCargos(verbo, result)));
        }

        // ── Opções (destaque / menção) em lote ──
        if (['hoist-on', 'hoist-off', 'mention-on', 'mention-off'].includes(action)) {
          await interaction.deferUpdate();
          const reason = `Alterado pelo painel por ${interaction.user.tag}`;
          const result = await runOnRoles(guild, roles, (role) => {
            if (action === 'hoist-on') return role.setHoist(true, reason);
            if (action === 'hoist-off') return role.setHoist(false, reason);
            if (action === 'mention-on') return role.setMentionable(true, reason);
            return role.setMentionable(false, reason);
          });
          st.screen = 'extras';
          return interaction.editReply(render(guild, st, resumoCargos('Opção alterada', result)));
        }

        // ── Excluir (após confirmação) ──
        if (action === 'excluir-ok') {
          await interaction.deferUpdate();
          const result = await runOnRoles(guild, roles, (role) => role.delete(`Excluído pelo painel por ${interaction.user.tag}`));
          const deletedIds = new Set(result.ok.map((r) => r.id));
          st.roleIds = st.roleIds.filter((id) => !deletedIds.has(id));
          st.screen = 'main';
          const aviso = resumoCargos('Excluído', result).replace('✅', '🗑️');
          return interaction.editReply(render(guild, st, aviso));
        }

        // ── Acesso por canal: presets ──
        if (['ver', 'ocultar', 'escrever', 'somente', 'limpar'].includes(action)) {
          const channels = getChannels(guild, st.channelIds);
          if (!channels.length) return deny(interaction, '❌ Selecione pelo menos um canal primeiro.');

          // @everyone = o servidor inteiro. Pede confirmação antes.
          if (roles.some((r) => r.id === guild.id) && st.confirmCanal !== action) {
            st.confirmCanal = action;
            st.screen = 'canal';
            return interaction.update(render(guild, st,
              `⚠️ **${ROTULO_PRESET[action]}** para **@everyone** vale para **TODO MUNDO** em ${channels.length} canal(is). Toque em **Confirmar** para aplicar, ou em outro botão para cancelar.`));
          }
          st.confirmCanal = null;

          await interaction.deferUpdate();
          const reason = `Painel de cargos por ${interaction.user.tag}`;
          const snap = tirarSnapshot(channels, roles);
          const result = await runOnChannels(channels, roles, async (channel, role) => {
            if (action === 'limpar') {
              if (channel.permissionOverwrites.cache.has(role.id)) await channel.permissionOverwrites.delete(role, reason);
              return;
            }
            await channel.permissionOverwrites.edit(role, presetOverwrite(action, channel), { reason });
          });
          st.undo = { itens: snap, texto: `${ROTULO_PRESET[action]} em ${channels.length} canal(is)` };
          st.screen = 'canal';
          const quem = roles.length === 1 ? mentionRoles(roles) : `${roles.length} cargos`;
          const cab = `**${ROTULO_PRESET[action]}** → ${quem} em **${channels.length}** canal(is).`;
          return interaction.editReply(render(guild, st, `${cab}\n${resumoCanais(result)}`));
        }

        // ── Desfazer a última ação em canais ──
        if (action === 'desfazer') {
          if (!st.undo?.itens?.length) return deny(interaction, '❌ Não tem nada para desfazer.');
          await interaction.deferUpdate();
          const { ok, falhas } = await restaurarSnapshot(guild, st.undo.itens, `Desfeito pelo painel por ${interaction.user.tag}`);
          const texto = st.undo.texto;
          st.undo = null;
          st.screen = 'canal';
          return interaction.editReply(render(guild, st, `↩️ **Desfeito:** ${texto}. ${ok} regra(s) restaurada(s)${falhas ? `, ${falhas} falhou(aram)` : ''}.`));
        }

        // ── Acesso por canal: permissões avançadas ──
        if (['ch-allow', 'ch-deny', 'ch-reset'].includes(action)) {
          const channels = getChannels(guild, st.channelIds);
          if (!channels.length) return deny(interaction, '❌ Selecione pelo menos um canal primeiro.');
          if (!st.chPermSel.length) return deny(interaction, '❌ Escolha pelo menos uma permissão no menu.');

          const value = action === 'ch-allow' ? true : action === 'ch-deny' ? false : null;
          const overwrite = Object.fromEntries(st.chPermSel.map((name) => [name, value]));

          await interaction.deferUpdate();
          const reason = `Painel de cargos por ${interaction.user.tag}`;
          const snap = tirarSnapshot(channels, roles);
          const result = await runOnChannels(channels, roles, (channel, role) => (
            channel.permissionOverwrites.edit(role, overwrite, { reason })
          ));
          st.undo = { itens: snap, texto: `permissões avançadas em ${channels.length} canal(is)` };
          st.screen = 'canal-perms';
          return interaction.editReply(render(guild, st, `${resumoCanais(result)}\n_Para desfazer, volte para **Acesso por canal** e toque em **↩️ Desfazer**._`));
        }
      }
    } catch (error) {
      console.error('❌ Erro no gerenciador de cargos:', error);
      const message = error?.code === 50013
        ? '❌ O Discord recusou a ação. Confira se o bot tem **Gerenciar cargos** e se o cargo do bot está acima do cargo escolhido.'
        : `❌ Não consegui concluir: ${error?.message ?? 'erro desconhecido'}`;

      if (interaction.replied || interaction.deferred) return interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      return interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  return { handleCommand: handle, handleComponent: handle };
}
