import {
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';

const PERMISSOES = [
  ['administrador', PermissionFlagsBits.Administrator],
  ['admin', PermissionFlagsBits.Administrator],
  ['gerenciar mensagens', PermissionFlagsBits.ManageMessages],
  ['gerenciar canais', PermissionFlagsBits.ManageChannels],
  ['gerenciar cargos', PermissionFlagsBits.ManageRoles],
  ['banir membros', PermissionFlagsBits.BanMembers],
  ['expulsar membros', PermissionFlagsBits.KickMembers],
  ['moderar membros', PermissionFlagsBits.ModerateMembers],
  ['ver canais', PermissionFlagsBits.ViewChannel],
  ['enviar mensagens', PermissionFlagsBits.SendMessages],
  ['ler histórico', PermissionFlagsBits.ReadMessageHistory],
  ['anexar arquivos', PermissionFlagsBits.AttachFiles],
  ['incorporar links', PermissionFlagsBits.EmbedLinks],
  ['mencionar todos', PermissionFlagsBits.MentionEveryone],
];

const normalizar = (s) => String(s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

function resposta(texto) {
  return String(texto).slice(0, 1900);
}

function extrairMencaoId(texto, tipo) {
  const re = tipo === 'role' ? /<@&(\d+)>/ : tipo === 'channel' ? /<#(\d+)>/ : /<@!?(\d+)>/;
  return texto.match(re)?.[1] || null;
}

function extrairCor(texto) {
  const m = texto.match(/#([0-9a-f]{6})(?:\b|$)/i);
  return m ? `#${m[1].toUpperCase()}` : null;
}

function tirarMencoes(texto) {
  return texto.replace(/<@&\d+>/g, '').replace(/<@!?\d+>/g, '').replace(/<#\d+>/g, '').trim();
}

function obterCargo(guild, texto) {
  const id = extrairMencaoId(texto, 'role');
  if (id) return guild.roles.cache.get(id) || null;
  const limpo = tirarMencoes(texto).replace(/^['"`]|['"`]$/g, '').trim();
  if (!limpo) return null;
  return guild.roles.cache.find((r) => normalizar(r.name) === normalizar(limpo)) || null;
}

function obterCanal(guild, texto) {
  const id = extrairMencaoId(texto, 'channel');
  if (id) return guild.channels.cache.get(id) || null;
  const limpo = texto.replace(/^['"`]|['"`]$/g, '').trim();
  if (!limpo) return null;
  return guild.channels.cache.find((c) => normalizar(c.name) === normalizar(limpo)) || null;
}

function obterMembro(guild, texto) {
  const id = extrairMencaoId(texto, 'user') || (texto.match(/\b\d{15,25}\b/)?.[0] || null);
  if (id) return guild.members.fetch(id).catch(() => null);
  const nome = tirarMencoes(texto).replace(/^['"`]|['"`]$/g, '').trim();
  if (!nome) return null;
  const encontrado = guild.members.cache.find((m) => normalizar(m.user.username) === normalizar(nome) || normalizar(m.displayName) === normalizar(nome));
  return encontrado || null;
}

function permissoesDoTexto(texto) {
  const n = normalizar(texto);
  const bits = new Set();
  for (const [nome, bit] of PERMISSOES) if (n.includes(nome)) bits.add(bit);
  return [...bits];
}

const OWNER_FALLBACK_ID = '1534688636887502888';

function ehDono(message, ownerId) {
  const idConfigurado = String(ownerId || '').trim();
  const idDono = idConfigurado || OWNER_FALLBACK_ID;
  return Boolean(message.author?.id === idDono);
}

async function ehRespostaAoBot(message, client) {
  if (!message.reference?.messageId) return false;
  try {
    const ref = await message.channel.messages.fetch(message.reference.messageId);
    return ref?.author?.id === client.user.id;
  } catch {
    return false;
  }
}

function acionado(texto) {
  return /^\s*(?:eclipse|bot)\b[,:!\-]?/i.test(texto);
}

function semGatilho(texto) {
  return texto.replace(/^\s*(?:eclipse|bot)\b[,:!\-]?\s*/i, '').trim();
}

function cargoGerenciavel(guild, role) {
  const maior = guild.members.me?.roles?.highest;
  return Boolean(role && maior && !role.managed && role.id !== guild.id && role.position < maior.position);
}

async function exigePermissaoBot(guild, bit) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  return Boolean(me?.permissions?.has(bit));
}

async function criarCargo(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageRoles))) return '❌ Preciso de **Gerenciar Cargos**.';
  const cor = extrairCor(resto);
  const semCor = resto.replace(/#([0-9a-f]{6})/i, '').trim();
  const semPerm = semCor.replace(/\s+(?:com|permissoes?|permissões?)\s+.*$/i, '').trim();
  const nome = semPerm.replace(/^['"`]|['"`]$/g, '').trim();
  if (!nome) return '❌ Diga o nome do cargo. Ex.: `Eclipse, crie o cargo Moderador com gerenciar mensagens`';
  if (message.guild.roles.cache.some((r) => normalizar(r.name) === normalizar(nome))) return `⚠️ Já existe um cargo chamado **${nome}**.`;
  const permissions = permissoesDoTexto(resto);
  try {
    const role = await message.guild.roles.create({
      name: nome.slice(0, 100),
      color: cor || undefined,
      permissions,
      reason: `Criado por ${message.author.tag} via mensagem da Eclipse`,
    });
    return `✅ Criei o cargo <@&${role.id}>${permissions.length ? ` com **${permissions.length}** permissão(ões).` : '.'}`;
  } catch (err) {
    return `❌ Não consegui criar o cargo: ${err.message}`;
  }
}

async function editarCargo(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageRoles))) return '❌ Preciso de **Gerenciar Cargos**.';
  const role = obterCargo(message.guild, resto);
  if (!role || !cargoGerenciavel(message.guild, role)) return '❌ Não encontrei esse cargo ou ele está acima do meu cargo.';
  const cor = extrairCor(resto);
  const nomeMatch = resto.match(/(?:nome|chamar|renomear)\s+(?:para\s+)?["`']?(.+?)["`']?(?:\s+#?[0-9a-f]{6}\b|\s*$)/i);
  const novoNome = nomeMatch?.[1]?.trim();
  const patch = {};
  if (cor) patch.color = cor;
  if (novoNome && !/^(cor|cargo)$/i.test(novoNome)) patch.name = novoNome.slice(0, 100);
  if (!Object.keys(patch).length) return '❌ Diga o que quer alterar. Ex.: `Eclipse, muda o cargo @Moderador para nome Equipe e cor #8A2BE2`';
  try {
    await role.edit(patch, `Editado por ${message.author.tag} via mensagem da Eclipse`);
    return `✅ Cargo atualizado: <@&${role.id}>.`;
  } catch (err) {
    return `❌ Não consegui editar o cargo: ${err.message}`;
  }
}

async function alterarPermissoesCargo(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageRoles))) return '❌ Preciso de **Gerenciar Cargos**.';
  const role = obterCargo(message.guild, resto);
  if (!role || !cargoGerenciavel(message.guild, role)) return '❌ Não encontrei esse cargo ou ele está acima do meu cargo.';
  const bits = permissoesDoTexto(resto);
  if (!bits.length) return '❌ Diga as permissões. Ex.: `Eclipse, dê ao cargo @Moderador gerenciar mensagens e ver canais`';
  try {
    await role.setPermissions(bits, `Permissões alteradas por ${message.author.tag} via mensagem da Eclipse`);
    return `✅ Atualizei as permissões de <@&${role.id}>.`;
  } catch (err) {
    return `❌ Não consegui alterar as permissões: ${err.message}`;
  }
}

async function excluirCargo(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageRoles))) return '❌ Preciso de **Gerenciar Cargos**.';
  const role = obterCargo(message.guild, resto);
  if (!role || !cargoGerenciavel(message.guild, role)) return '❌ Não encontrei esse cargo ou ele está acima do meu cargo.';
  try {
    const nome = role.name;
    await role.delete(`Excluído por ${message.author.tag} via mensagem da Eclipse`);
    return `✅ Excluí o cargo **${nome}**.`;
  } catch (err) {
    return `❌ Não consegui excluir o cargo: ${err.message}`;
  }
}

async function atribuirCargo(message, resto, remover = false) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageRoles))) return '❌ Preciso de **Gerenciar Cargos**.';
  const role = obterCargo(message.guild, resto);
  const membro = await obterMembro(message.guild, resto);
  if (!role || !membro) return '❌ Preciso de um cargo e um membro. Ex.: `Eclipse, dê @Moderador para @João`';
  if (!cargoGerenciavel(message.guild, role)) return '❌ Esse cargo está acima do meu cargo.';
  try {
    if (remover) await membro.roles.remove(role, `Removido por ${message.author.tag} via mensagem da Eclipse`);
    else await membro.roles.add(role, `Adicionado por ${message.author.tag} via mensagem da Eclipse`);
    return `✅ ${remover ? 'Removi' : 'Adicionei'} <@&${role.id}> ${remover ? 'de' : 'para'} <@${membro.id}>.`;
  } catch (err) {
    return `❌ Não consegui alterar o cargo do membro: ${err.message}`;
  }
}

async function banir(message, resto, banSystem) {
  const membro = await obterMembro(message.guild, resto);
  if (!membro) return '❌ Mencione o membro que deve ser banido.';
  const motivo = resto.replace(/<@!?\d+>/g, '').trim() || 'Banimento solicitado pelo dono via mensagem';
  const resultado = await banSystem.banirViaApi({ guildId: message.guild.id, discordId: membro.id, motivo, por: message.author.tag });
  return resultado.ok ? `🔨 Bani <@${membro.id}>.` : `❌ Não consegui banir: ${resultado.error || 'erro desconhecido'}`;
}

async function expulsar(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.KickMembers))) return '❌ Preciso de **Expulsar Membros**.';
  const membro = await obterMembro(message.guild, resto);
  if (!membro) return '❌ Mencione o membro que deve ser expulso.';
  if (!membro.kickable) return '❌ Não consigo expulsar esse membro por causa da hierarquia/permissões.';
  try { await membro.kick(`Expulso por ${message.author.tag} via mensagem da Eclipse`); return `👢 Expulsei <@${membro.id}>.`; }
  catch (err) { return `❌ Não consegui expulsar: ${err.message}`; }
}

async function timeout(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ModerateMembers))) return '❌ Preciso de **Moderar Membros**.';
  const membro = await obterMembro(message.guild, resto);
  const minutos = Number(resto.match(/(\d+)\s*(?:m|min|mins|minutos?)/i)?.[1] || 10);
  if (!membro) return '❌ Mencione o membro. Ex.: `Eclipse, coloque @João em timeout por 10 minutos`';
  if (!membro.moderatable) return '❌ Não consigo aplicar timeout nesse membro.';
  try { await membro.timeout(Math.min(minutos, 28 * 24 * 60) * 60 * 1000, `Timeout por ${message.author.tag} via mensagem da Eclipse`); return `🔇 Coloquei <@${membro.id}> em timeout por **${minutos} min**.`; }
  catch (err) { return `❌ Não consegui aplicar timeout: ${err.message}`; }
}

async function nuke(message) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageChannels))) return '❌ Preciso de **Gerenciar Canais**.';
  const ch = message.channel;
  if (!ch?.isTextBased() || !('clone' in ch)) return '❌ Esse canal não pode ser recriado dessa forma.';
  try {
    const clone = await ch.clone({ reason: `Nuke por ${message.author.tag} via mensagem da Eclipse` });
    await clone.setPosition(ch.position).catch(() => {});
    await ch.delete('Nuke solicitado pelo dono via mensagem da Eclipse');
    await clone.send(`💥 Canal recriado por <@${message.author.id}>.`).catch(() => {});
    return null;
  } catch (err) { return `❌ Não consegui recriar o canal: ${err.message}`; }
}

async function criarCanal(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageChannels))) return '❌ Preciso de **Gerenciar Canais**.';
  const categoria = /categoria|category/i.test(resto);
  const nome = resto.replace(/^(?:um\s+)?(?:canal|categoria)\s*/i, '').replace(/\s+(?:de texto|texto|categoria|category)\s*$/i, '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!nome) return '❌ Diga o nome do canal.';
  try {
    const c = await message.guild.channels.create({ name: nome.slice(0, 100), type: categoria ? ChannelType.GuildCategory : ChannelType.GuildText, reason: `Criado por ${message.author.tag} via mensagem da Eclipse` });
    return `✅ Criei ${categoria ? 'a categoria' : 'o canal'} ${c}.`;
  } catch (err) { return `❌ Não consegui criar: ${err.message}`; }
}

async function deletarCanal(message, resto) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageChannels))) return '❌ Preciso de **Gerenciar Canais**.';
  const c = obterCanal(message.guild, resto) || message.channel;
  try { const nome = c.name; await c.delete(`Excluído por ${message.author.tag} via mensagem da Eclipse`); return `🗑️ Excluí **#${nome}**.`; }
  catch (err) { return `❌ Não consegui excluir: ${err.message}`; }
}

async function permissaoCanal(message, resto, permitir) {
  if (!(await exigePermissaoBot(message.guild, PermissionFlagsBits.ManageChannels))) return '❌ Preciso de **Gerenciar Canais**.';
  const role = obterCargo(message.guild, resto);
  const channel = obterCanal(message.guild, resto) || message.channel;
  if (!role) return '❌ Mencione ou escreva o cargo que terá o acesso.';
  try {
    await channel.permissionOverwrites.edit(role.id, {
      ViewChannel: permitir,
      ReadMessageHistory: permitir,
      SendMessages: permitir ? null : false,
    }, { reason: `Permissão alterada por ${message.author.tag} via mensagem da Eclipse` });
    return `✅ ${permitir ? 'Liberei' : 'Bloqueei'} o acesso de <@&${role.id}> em ${channel}.`;
  } catch (err) { return `❌ Não consegui alterar o canal: ${err.message}`; }
}

function ajuda() {
  return [
    '🧠 **Modo dono por mensagem ativo.**',
    '`Eclipse, crie o cargo Moderador com gerenciar mensagens #8A2BE2`',
    '`Eclipse, dê @Moderador para @Pessoa`',
    '`Eclipse, remova @Moderador de @Pessoa`',
    '`Eclipse, mude o cargo @Moderador para nome Equipe e cor #8A2BE2`',
    '`Eclipse, dê ao cargo @Moderador gerenciar canais e ver canais`',
    '`Eclipse, crie um canal suporte` / `crie uma categoria suporte`',
    '`Eclipse, bloqueie #chat para @Membro` / `libere #chat para @Membro`',
    '`Eclipse, bana @Pessoa` / `expulse @Pessoa` / `timeout @Pessoa por 10 minutos`',
    '`Eclipse, nuke`',
  ].join('\n');
}

export async function handleOwnerNaturalMessage(message, { client, ownerId, banSystem }) {
  if (!message.guild || !ehDono(message, ownerId) || message.author.bot) return false;

  // Só entra no modo admin se a mensagem COMEÇAR com "Eclipse," / "bot,"
  // (com ou sem menção). Respostas casuais ao bot vão pro chat da IA.
  // Antes: qualquer reply do dono era interceptado e gerava "Não entendi essa ação".
  const bruto = String(message.content || '').trim();
  if (!acionado(bruto) && !/<@!?\d+>/.test(bruto)) return false;

  // Se só mencionou o bot sem o gatilho textual "Eclipse,", deixa a IA responder
  const temGatilhoTexto = acionado(bruto.replace(/<@!?\d+>/g, '').trim());
  if (!temGatilhoTexto) return false;

  const texto = semGatilho(bruto.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim());
  if (!texto) {
    await message.reply(ajuda());
    return true;
  }

  const n = normalizar(texto);
  let resultado = null;

  if (/^(ajuda|help|o que voce pode fazer|o que você pode fazer|comandos?)$/.test(n)) resultado = ajuda();
  else if (/^(?:cria|crie|criar|adiciona|adicione)\s+(?:um\s+)?cargo\b/i.test(texto)) resultado = await criarCargo(message, texto.replace(/^(?:cria|crie|criar|adiciona|adicione)\s+(?:um\s+)?cargo\s*/i, ''));
  else if (/^(?:muda|mude|edita|edite|renomeia|renomeie)\s+(?:o\s+)?cargo\b/i.test(texto)) resultado = await editarCargo(message, texto.replace(/^(?:muda|mude|edita|edite|renomeia|renomeie)\s+(?:o\s+)?cargo\s*/i, ''));
  else if (/^(?:d[êe]|da|dá|adicione|adiciona)\s+(?:ao\s+)?cargo\b/i.test(texto) && /permiss|gerenciar|administrador|banir|expulsar|moderar|ver canais|enviar mensagens/i.test(texto)) resultado = await alterarPermissoesCargo(message, texto);
  else if (/^(?:exclui|excluir|delete|apaga|apagar)\s+(?:o\s+)?cargo\b/i.test(texto)) resultado = await excluirCargo(message, texto.replace(/^(?:exclui|excluir|delete|apaga|apagar)\s+(?:o\s+)?cargo\s*/i, ''));
  else if (/^(?:da|dá|de|adicione|adiciona|coloque)\b/i.test(texto) && /<@&\d+>/.test(texto) && /<@!?\d+>/.test(texto)) resultado = await atribuirCargo(message, texto, false);
  else if (/^(?:remove|remova|retira|retire)\b/i.test(texto) && /<@&\d+>/.test(texto) && /<@!?\d+>/.test(texto)) resultado = await atribuirCargo(message, texto, true);
  else if (/^(?:bane|banir|banir o|bana)\b/i.test(texto)) resultado = await banir(message, texto, banSystem);
  else if (/^(?:expulsa|expulse|kick)\b/i.test(texto)) resultado = await expulsar(message, texto);
  else if (/timeout|coloca.*timeout|mute temporario|silencia.*temporario/i.test(n)) resultado = await timeout(message, texto);
  else if (/^(?:cria|crie|criar)\s+(?:um\s+)?(?:canal|categoria)\b/i.test(texto)) resultado = await criarCanal(message, texto);
  else if (/^(?:exclui|excluir|apaga|apagar)\s+(?:o\s+)?canal\b/i.test(texto)) resultado = await deletarCanal(message, texto);
  else if (/^(?:bloqueia|bloqueie|bloqueia o acesso)\b/i.test(texto) && /<@&\d+>/.test(texto)) resultado = await permissaoCanal(message, texto, false);
  else if (/^(?:libera|libere|permite|permit[a-z]*)\b/i.test(texto) && /<@&\d+>/.test(texto)) resultado = await permissaoCanal(message, texto, true);
  else if (/^(?:nuke|recria|recrie|reseta)\b/i.test(n)) resultado = await nuke(message);
  else {
    // Não era comando admin → deixa a IA responder (chat normal)
    return false;
  }

  if (resultado) await message.reply(resposta(resultado));
  return true;
}
