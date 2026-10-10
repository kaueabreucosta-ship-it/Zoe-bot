import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import http from 'http';
import { readFileSync } from 'fs';
import { createHash, timingSafeEqual } from 'crypto';
import { buildModerationCommands, createModerationSystem } from './moderation.js';
import { createAntiLinkSystem } from './antilink.js';
import { buildContextCommands, createContextSystem } from './context.js';
import { createRecruitSystem } from './recruit.js';
import { buildDuelCommands, createDuelSystem } from './duelos.js';
import { gerar, provedoresAtivos } from './ia.js';
import { buildZoeCommands, createZoeChat } from './zoe-ia.js';
import { MARCA } from './cores.js';
import { buildEconomyCommands, createEconomySystem } from './economia.js';
import { createVerificationSystem } from './verificacao.js';
import { buildExtraCommands, createExtraSystem } from './extras.js';
import { buildBanCommands, createBanSystem } from './banimento.js';
import { buildAntiRaidCommands, createAntiRaidSystem } from './antiraid.js';
import { buildRoleCommands, createRoleSystem } from './cargos.js';
import { buildBackupCommands, createBackupSystem } from './backup.js';
import { handleOwnerNaturalMessage } from './owner-natural.js';

// ==========================================
// CHAVES DE ACESSO (variáveis de ambiente)
// ==========================================
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const OWNER_ID = (process.env.OWNER_ID || '1534688636887502888').trim(); // dono principal; pode ser sobrescrito no Render
const NAO_XINGAR_IDS = (process.env.NAO_XINGAR_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const VERIFY_GUILD_ID = (process.env.VERIFY_GUILD_ID || '').trim();
const SITE_API_URL = (process.env.SITE_API_URL || '').trim().replace(/\/+$/, '');
const BOT_SHARED_SECRET = (process.env.BOT_SHARED_SECRET || '').trim();

if (!VERIFY_GUILD_ID || !SITE_API_URL || !BOT_SHARED_SECRET) {
  console.warn('⚠️ VERIFY_GUILD_ID, SITE_API_URL ou BOT_SHARED_SECRET não definidos — verificação e DM em massa desativadas.');
}

if (!DISCORD_TOKEN || provedoresAtivos.length === 0) {
  console.error('❌ ERRO: defina DISCORD_TOKEN e ao menos uma chave de IA (GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY ou OPENROUTER_API_KEY).');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ERRO: defina SUPABASE_URL e SUPABASE_KEY nas variáveis de ambiente.');
  process.exit(1);
}

// Mantém só protocolo + domínio da URL do Supabase (evita path duplicado).
let SUPABASE_URL_LIMPA;
try {
  const u = new URL(SUPABASE_URL);
  SUPABASE_URL_LIMPA = `${u.protocol}//${u.host}`;
} catch {
  SUPABASE_URL_LIMPA = SUPABASE_URL.replace(/\/+$/, '');
}

const db = createClient(SUPABASE_URL_LIMPA, SUPABASE_KEY, {
  realtime: { transport: ws },
  auth: { persistSession: false, autoRefreshToken: false },
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

client.on('error', (err) => console.error('❌ Erro no client do Discord:', err.message));
client.on('shardError', (err) => console.error('❌ Erro no shard do Discord:', err.message));
process.on('unhandledRejection', (err) => console.error('❌ Promise rejeitada sem catch:', err));
process.on('uncaughtException', (err) => console.error('❌ Exceção não tratada:', err));


// ==========================================
// CONFIG POR SERVIDOR (Supabase, com cache)
// ==========================================
const DEFAULTS_GUILD_CONFIG = {
  guild_id: null,
  logs_canal_id: null,
  moderacao_canal_id: null,
  moderacao_ativo: true,
  moderacao_mute_minutos: 30,
  automod_antispam_ativo: true,
  automod_antispam_limite: 5,
  automod_antispam_janela_seg: 5,
  automod_anticaps_ativo: true,
  automod_anticaps_porcentagem: 70,
  automod_anticaps_minimo: 10,
  automod_antiflood_ativo: true,
  automod_antiflood_repeticoes: 3,
  contexto_ativo: true,
  contexto_limite: 50,
};

const GUILD_CONFIG_CACHE_MS = 30_000;
const guildConfigCache = new Map();

async function getGuildConfig(guildId) {
  const cacheado = guildConfigCache.get(guildId);
  if (cacheado && cacheado.expira > Date.now()) return cacheado.data;

  const { data, error } = await db.from('guild_config').select('*').eq('guild_id', guildId).order('guild_id').limit(1);
  if (error) {
    console.error('Erro ao buscar guild_config:', error.message);
    // CORREÇÃO: antes, um erro do banco caía no "else" abaixo e gravava a config PADRÃO por cima da config
    // real do servidor (canal de logs, automod...). Agora, no erro, só devolve o que tem em cache (ou o padrão)
    // SEM gravar nada e SEM cachear — na próxima mensagem ele tenta de novo.
    return cacheado ? cacheado.data : { ...DEFAULTS_GUILD_CONFIG, guild_id: guildId };
  }

  let resultado;
  if (data && data.length) {
    resultado = data[0];
  } else {
    resultado = { ...DEFAULTS_GUILD_CONFIG, guild_id: guildId };
    await db.from('guild_config').upsert(resultado, { onConflict: 'guild_id' });
  }
  guildConfigCache.set(guildId, { data: resultado, expira: Date.now() + GUILD_CONFIG_CACHE_MS });
  return resultado;
}

async function updateGuildConfig(guildId, campos) {
  const atual = await getGuildConfig(guildId);
  const { error } = await db.from('guild_config').update(campos).eq('guild_id', guildId);
  if (error) {
    console.error('Erro ao atualizar guild_config:', error.message);
    const { error: err2 } = await db.from('guild_config').upsert({ ...atual, guild_id: guildId, ...campos });
    if (err2) console.error('Erro no fallback upsert guild_config:', err2.message);
  }
  guildConfigCache.set(guildId, { data: { ...atual, ...campos, guild_id: guildId }, expira: Date.now() + GUILD_CONFIG_CACHE_MS });
}

// ==========================================
// IA (roteador em ia.js; conversa/persona em zoe-ia.js)
// ==========================================
const gerarTexto = (prompt, opcoes = {}) => gerar({ prompt, ...opcoes });

// ==========================================
// SISTEMAS DE IA
// ==========================================
const banSystem = createBanSystem({ client, db, ownerId: OWNER_ID, ownerRoleId: (process.env.OWNER_ROLE_ID || '').trim(), getGuildConfig, verifyGuildId: VERIFY_GUILD_ID });
const antiRaidSystem = createAntiRaidSystem({ client, db, ownerId: OWNER_ID, getGuildConfig });
const roleSystem = createRoleSystem({ client });
// Anti-link: apaga link de quem não é moderador/owner (ANTILINK=off desliga)
const antiLinkSystem = createAntiLinkSystem({
  client,
  getGuildConfig,
  ownerId: OWNER_ID,
  ownerRoleId: (process.env.OWNER_ROLE_ID || '').trim(),
  modRoleId: (process.env.MOD_ROLE_ID || '').trim(),
});
const backupSystem = createBackupSystem({ db, ownerId: OWNER_ID });
const moderationSystem = createModerationSystem({
  client,
  db,
  getGuildConfig,
  updateGuildConfig,
  // CORREÇÃO: a tabela banned_users é GLOBAL (a mesma do site). Antes, um ban feito em QUALQUER servidor onde o
  // bot estivesse bania a pessoa no site inteiro. Agora só vale no servidor de verificação.
  banirNoSite: (params) =>
    VERIFY_GUILD_ID && params.guildId !== VERIFY_GUILD_ID ? Promise.resolve({ ok: false, ignorado: true }) : banSystem.banirNoSite(params),
});
const contextSystem = createContextSystem({ getGuildConfig, updateGuildConfig });
const zoeChat = createZoeChat({ client, contextSystem, ownerId: OWNER_ID, naoXingarIds: NAO_XINGAR_IDS });
const recruitSystem = createRecruitSystem({ client, ownerId: OWNER_ID, gerarTexto });
const duelSystem = createDuelSystem({ client, gerarTexto });
const economySystem = createEconomySystem({ db });
const extraSystem = createExtraSystem({ db, client });
const verificationSystem = createVerificationSystem({
  client,
  guildId: VERIFY_GUILD_ID,
  siteApiUrl: SITE_API_URL,
  sharedSecret: BOT_SHARED_SECRET,
});

// ==========================================
// SERVIDOR HTTP: keep-alive + API pra verificação e DM em massa
// ==========================================
const MAX_CORPO_BYTES = 1_000_000; // 1MB — evita alguém encher a memória do bot

function lerCorpoJson(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (chunk) => {
      dados += chunk;
      if (dados.length > MAX_CORPO_BYTES) {
        reject(new Error('Corpo da requisição grande demais.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!dados) return resolve({});
      try {
        resolve(JSON.parse(dados));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Comparação em tempo constante (não vaza o segredo por diferença de tempo)
function autorizado(req) {
  if (!BOT_SHARED_SECRET) return false;
  const recebido = String(req.headers['x-bot-secret'] || '');
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(BOT_SHARED_SECRET).digest();
  return timingSafeEqual(a, b);
}

// Site do bot (site/index.html) — aparece quando alguém abre o endereço do Render. Se o arquivo sumir, volta o texto simples.
let SITE_HTML = null;
try {
  SITE_HTML = readFileSync(new URL('./site/index.html', import.meta.url), 'utf8');
} catch {
  console.warn('⚠️ site/index.html não encontrado — a raiz vai responder só texto.');
}

const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'URL inválida.' }));
    }

    try {
      // GET /membro/:id — o site usa pra checar se a pessoa está no servidor
      if (req.method === 'GET' && url.pathname.startsWith('/membro/')) {
        if (!autorizado(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Não autorizado.' }));
        }
        const discordId = url.pathname.split('/')[2] || '';
        if (!/^\d{5,25}$/.test(discordId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'ID inválido.' }));
        }
        const info = await verificationSystem.isMember(discordId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(info));
      }

      // POST /verificar — o site chama depois do OAuth2 pra iniciar a DM com o pedido de webhook
      if (req.method === 'POST' && url.pathname === '/verificar') {
        if (!autorizado(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Não autorizado.' }));
        }
        const { discord_id, username } = await lerCorpoJson(req);
        if (!discord_id || !/^\d{5,25}$/.test(String(discord_id))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'discord_id é obrigatório.' }));
        }
        const membro = await verificationSystem.isMember(discord_id);
        if (!membro.isMember) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Usuário não está no servidor de verificação.' }));
        }
        await verificationSystem.iniciarVerificacao(discord_id, username || membro.username || 'Usuário');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // POST /send-dm — o dashboard de DM chama pra mandar mensagem em massa
      if (req.method === 'POST' && url.pathname === '/send-dm') {
        if (!autorizado(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Não autorizado.' }));
        }
        const { message, targets } = await lerCorpoJson(req);
        if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Mensagem vazia ou maior que 2000 caracteres (limite do Discord).' }));
        }
        const lista = (Array.isArray(targets) ? targets : []).slice(0, 5000);
        // Responde na hora e envia em segundo plano (com pausa entre cada pessoa):
        // o site não fica esperando e o Discord não limita/bloqueia o bot por spam.
        verificationSystem
          .enviarDmEmMassa(message, lista)
          .then((r) => {
            const dmOk = r.filter((x) => x.dm).length;
            console.log(`📨 DM em massa concluída: ${dmOk}/${r.length} DMs entregues.`);
          })
          .catch((err) => console.error('Erro na DM em massa:', err.message));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, enfileirados: lista.length }));
      }

      // POST /ban e /unban — o dashboard (dm-control) chama pra banir/desbanir também no servidor do Discord
      if (req.method === 'POST' && (url.pathname === '/ban' || url.pathname === '/unban')) {
        if (!autorizado(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Não autorizado.' }));
        }
        const { discord_id, reason, by } = await lerCorpoJson(req);
        if (!discord_id || !/^\d{5,25}$/.test(String(discord_id))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'discord_id inválido.' }));
        }
        if (!VERIFY_GUILD_ID) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'VERIFY_GUILD_ID não configurado no bot.' }));
        }
        const params = { guildId: VERIFY_GUILD_ID, discordId: String(discord_id), motivo: typeof reason === 'string' ? reason.slice(0, 300) : '', por: typeof by === 'string' ? by.slice(0, 60) : 'dashboard' };
        const r = url.pathname === '/ban' ? await banSystem.banirViaApi(params) : await banSystem.desbanirViaApi(params);
        res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(r));
      }

      // GET/HEAD / — o UptimeRobot continua recebendo 200, só que agora com o site
      if ((req.method === 'GET' || req.method === 'HEAD') && SITE_HTML && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : SITE_HTML);
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${MARCA.nome} está online!`);
    } catch (err) {
      console.error('Erro no servidor HTTP:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, () => console.log(`🌐 Keep-alive na porta ${PORT}`));

// ==========================================
// COMANDOS
// ==========================================
const commands = [
  new SlashCommandBuilder().setName('nuke').setDescription('Clona o canal atual e apaga o antigo (cuidado!)'),
  ...buildZoeCommands(),
  buildModerationCommands(),
  buildContextCommands(),
  ...buildDuelCommands(),
  ...buildEconomyCommands(),
  ...buildExtraCommands(),
  ...buildBanCommands(),
  buildAntiRaidCommands(),
  buildBackupCommands(),
  ...buildRoleCommands(),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async () => {
  console.log(`✅ ${client.user.tag} está online!`);
  console.log(`🤖 Provedores de IA ativos: ${provedoresAtivos.join(', ')}`);
  recruitSystem.recuperar().catch((err) => console.error('Erro ao recuperar votações do recrutamento:', err.message));
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  // PUT substitui a lista inteira: os comandos antigos somem do servidor. Em paralelo = bot pronto bem mais rápido.
  const resultados = await Promise.allSettled(
    [...client.guilds.cache.values()].map(async (guild) => {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      return guild.name;
    })
  );
  for (const r of resultados) {
    if (r.status === 'fulfilled') console.log(`📌 Comandos registrados em: ${r.value}`);
    else console.error('Erro ao registrar comandos:', r.reason?.message ?? r.reason);
  }
});

client.on('guildCreate', async (guild) => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(`📌 Comandos registrados em: ${guild.name}`);
  } catch (err) {
    console.error('Erro ao registrar comandos no novo servidor:', err.message);
  }
});

// ==========================================
// MENSAGENS: moderação por IA, contexto e gatilho de chat
// ==========================================
client.on('messageCreate', async (message) => {
  // Candidaturas vindas do site (webhook) e fim da enquete do recrutamento (tipo 46 = resultado de enquete)
  if (message.webhookId || message.type === 46) {
    recruitSystem.handleMessage(message).catch((err) => console.error('Erro no recrutamento:', err.message));
    return;
  }
  // DM de verificação (resposta com o link do webhook)
  if (!message.guild) {
    if (!message.author.bot) {
      verificationSystem.handleDM(message).catch((err) => console.error('Erro na verificação (DM):', err.message));
    }
    return;
  }
  if (message.author.bot) return;

  // Dono pode executar ações administrativas por linguagem natural, sem slash command.
  // Só funciona para OWNER_ID e quando o dono menciona a Eclipse ou responde uma mensagem dela.
  const executouPorMensagem = await handleOwnerNaturalMessage(message, { client, ownerId: OWNER_ID, banSystem })
    .catch((err) => {
      console.error('Erro no comando natural do dono:', err.message);
      return false;
    });
  if (executouPorMensagem) return;

  // Anti-raid: novato mandando convite/@everyone/menção em massa é barrado aqui e a mensagem não segue adiante.
  if (await antiRaidSystem.handleMessage(message).catch((err) => { console.error('Erro no anti-raid (mensagem):', err.message); return false; })) return;

  // Anti-link: link de quem não é moderador/owner some aqui e a mensagem não segue adiante.
  if (await antiLinkSystem.handleMessage(message).catch((err) => { console.error('Erro no anti-link:', err.message); return false; })) return;

  moderationSystem.handleMessage(message).catch((err) => console.error('Erro na moderação por IA:', err.message));
  contextSystem.handleMessage(message).catch((err) => console.error('Erro no sistema de contexto:', err.message));
  economySystem.handleMessage(message).catch((err) => console.error('Erro na economia:', err.message));

  // Gatilho: mencionar o bot, chamar pelo nome (começo da frase / mensagem curta) ou responder a uma mensagem dele.
  const { chamada, refMsg } = await zoeChat.detectarChamada(message);
  if (!chamada) return;

  const restante = zoeChat.checarCooldown(message.author.id);
  if (restante) {
    message.react('⏳').catch(() => {}); // só reage: responder texto toda vez dava pra usar como spam
    return;
  }

  await message.channel.sendTyping().catch(() => {});
  await zoeChat.responderMensagem(message, { refMsg }).catch(async (err) => {
    console.error('Erro ao responder com a IA:', err.message);
    await message.reply({ content: 'Deu ruim aqui do meu lado, tenta de novo daqui a pouco.', allowedMentions: { parse: [] } }).catch(() => {});
  });
});

// Editou a mensagem pra enfiar um link? Também apaga.
client.on('messageUpdate', (_antiga, nova) => {
  if (nova.partial || !nova.guild) return;
  antiLinkSystem.handleMessage(nova).catch((err) => console.error('Erro no anti-link (edição):', err.message));
});

// ==========================================
// INTERAÇÕES
// ==========================================
// Marca a interação quando o cargo da pessoa recebeu esse comando no painel /permissoes.
// Os módulos checam `interaction.zoeConcedido` além da permissão normal do Discord.
async function marcarConcessao(interaction, comando) {
  interaction.zoeConcedido = await banSystem.podeUsar(interaction, comando).catch(() => false);
}

client.on('interactionCreate', async (interaction) => {
  // Portão central das permissões do /permissoes: marca liberações e bloqueia comando público restrito a cargos.
  if (interaction.guild && (await banSystem.gate(interaction).catch((err) => { console.error('Erro no portão de permissões:', err.message); return true; })) === false) return;

  // Gerenciador de cargos (/cargos): criação, edição, permissões e opções visuais.
  if (interaction.isChatInputCommand() && interaction.commandName === 'cargos')
    return roleSystem.handleCommand(interaction).catch((err) => console.error('Erro no gerenciador de cargos:', err.message));
  if ((interaction.isRoleSelectMenu() || interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit() || interaction.isChannelSelectMenu()) && interaction.customId?.startsWith('cargo|'))
    return roleSystem.handleComponent(interaction).catch((err) => console.error('Erro no painel de cargos:', err.message));

  // Backup do servidor (/backup e botões de confirmar/cancelar)
  if (interaction.isChatInputCommand() && interaction.commandName === 'backup')
    return backupSystem.handleCommand(interaction).catch((err) => console.error('Erro no backup (comando):', err.message));
  if (interaction.isButton() && interaction.customId.startsWith('backup|'))
    return backupSystem.handleButton(interaction).catch((err) => console.error('Erro no backup (botão):', err.message));

  // Anti-raid (/antiraid e botões do aviso de raid)
  if (interaction.isChatInputCommand() && interaction.commandName === 'antiraid') {
    await marcarConcessao(interaction, 'antiraid');
    return antiRaidSystem.handleCommand(interaction).catch((err) => console.error('Erro no anti-raid (comando):', err.message));
  }
  if (interaction.isButton() && interaction.customId.startsWith('antiraid|')) {
    await marcarConcessao(interaction, 'antiraid');
    return antiRaidSystem.handleButton(interaction).catch((err) => console.error('Erro no anti-raid (botão):', err.message));
  }

  // Banimento (/banir, /desbanir, /banidos, /permissoes) e painel de permissões por cargo
  if (interaction.isChatInputCommand() && ['banir', 'desbanir', 'banidos', 'permissoes'].includes(interaction.commandName))
    return banSystem.handleCommand(interaction).catch((err) => console.error('Erro no banimento:', err.message));
  if ((interaction.isRoleSelectMenu() || interaction.isStringSelectMenu() || interaction.isButton()) && interaction.customId.startsWith('perm|'))
    return banSystem.handleComponent(interaction);

  if (interaction.isButton() && interaction.customId === 'verify|webhook') {
    return verificationSystem.handleInteraction(interaction).catch((err) => {
      console.error('Erro no botão de webhook:', err.message);
      if (!interaction.replied && !interaction.deferred) interaction.reply({ content: '❌ Não consegui abrir o formulário. Tente novamente.', ephemeral: true }).catch(() => {});
    });
  }
  if (interaction.isModalSubmit() && interaction.customId === 'verify|webhook-modal') {
    return verificationSystem.handleInteraction(interaction).catch((err) => {
      console.error('Erro no formulário de webhook:', err.message);
      if (!interaction.replied && !interaction.deferred) interaction.reply({ content: '❌ Não consegui salvar o webhook. Tente novamente.', ephemeral: true }).catch(() => {});
    });
  }

  // Moderação por IA (comando, botões, menus e modais do automod)
  if (interaction.isChatInputCommand() && interaction.commandName === 'moderacao') {
    await marcarConcessao(interaction, 'moderacao');
    return moderationSystem.handleCommand(interaction);
  }
  if (interaction.isButton() && interaction.customId.startsWith('mod|')) {
    // banir exige a concessão de /banir; mutar/deixar passar usam a de /moderacao
    await marcarConcessao(interaction, interaction.customId.split('|')[1] === 'ban' ? 'banir' : 'moderacao');
    return moderationSystem.handleButton(interaction);
  }
  if (interaction.customId?.startsWith('automod|')) await marcarConcessao(interaction, 'moderacao');
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('automod|')) return moderationSystem.handleAutomodSelect(interaction);
  if (interaction.isButton() && interaction.customId.startsWith('automod|')) return moderationSystem.handleAutomodButton(interaction);
  if (interaction.isModalSubmit() && interaction.customId.startsWith('automod|')) return moderationSystem.handleAutomodModal(interaction);

  // Recrutamento (botões Aceitar/Negar e modal de motivo)
  if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith('rec|')) {
    const run = interaction.isButton() ? recruitSystem.handleButton : recruitSystem.handleModal;
    return run(interaction).catch((err) => {
      console.error('Erro no recrutamento (interação):', err.message);
      const msg = { content: '❌ Deu erro ao processar. Tente de novo.', ephemeral: true };
      if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    });
  }

  // Contexto de IA
  if (interaction.isChatInputCommand() && interaction.commandName === 'contexto') {
    await marcarConcessao(interaction, 'contexto');
    return contextSystem.handleCommand(interaction);
  }

  // Extras: economia, tickets, ajuda
  if (interaction.isChatInputCommand() && ['ajuda','ranking','diario','transferir','perfil','economia','ticket'].includes(interaction.commandName))
    return extraSystem.handleCommand(interaction).catch((err) => console.error('Erro nos extras:', err.message));
  if (interaction.isButton() && interaction.customId.startsWith('ticket|'))
    return extraSystem.handleInteraction(interaction).catch((err) => console.error('Erro nos tickets:', err.message));

  // Economia (/saldo e /cassino)
  if (interaction.isChatInputCommand() && ['saldo', 'cassino', 'tigrinho'].includes(interaction.commandName))
    return economySystem.handleCommand(interaction).catch((err) => console.error('Erro na economia (comando):', err.message));

  // Duelos de zoeira (/larp, /briga e /discussao)
  if (interaction.isChatInputCommand() && ['larp', 'briga', 'discussao'].includes(interaction.commandName))
    return duelSystem.handleCommand(interaction);

  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const { commandName, member } = interaction;

  // /perguntar e /iastatus
  if (commandName === 'perguntar') return zoeChat.responderPergunta(interaction).catch((err) => {
    console.error('Erro no /perguntar:', err.message);
    const msg = { content: '❌ Não consegui responder agora. Tenta de novo em instantes.' };
    return interaction.deferred || interaction.replied ? interaction.editReply(msg).catch(() => {}) : interaction.reply({ ...msg, ephemeral: true }).catch(() => {});
  });
  if (commandName === 'iastatus') return zoeChat.responderStatus(interaction);

  // /nuke
  if (commandName === 'nuke') {
    if (!(await banSystem.podeUsar(interaction, 'nuke')) && !member.permissions.has(PermissionFlagsBits.ManageChannels))
      return interaction.reply({ content: '🚫 Precisa de **Gerenciar Canais**.', ephemeral: true });
    const ch = interaction.channel;
    await interaction.reply({ content: '💥 Recriando canal...', ephemeral: true });
    try {
      const cloned = await ch.clone({ reason: `Nuke por ${interaction.user.tag}` });
      await cloned.setPosition(ch.position).catch(() => {});
      await ch.delete('Nuke');
      await cloned.send(`💥 Canal recriado por ${interaction.user}.`);
    } catch (err) {
      console.error('Erro no /nuke:', err.message);
      await interaction.editReply({ content: `❌ Não consegui recriar o canal (o bot tem **Gerenciar Canais**?): ${err.message}` }).catch(() => {});
    }
  }
});

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    console.log(`🛑 ${sinal} recebido — desligando com calma.`);
    client.destroy().catch(() => {});
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

client.login(DISCORD_TOKEN);
