import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { buildModerationCommands, createModerationSystem } from './moderation.js';
import { buildContextCommands, createContextSystem } from './context.js';
import { createRecruitSystem } from './recruit.js';
import { buildDuelCommands, createDuelSystem } from './duelos.js';
import { gerar, provedoresAtivos } from './ia.js';
import { buildEconomyCommands, createEconomySystem } from './economia.js';
import { createVerificationSystem } from './verificacao.js';
import { buildExtraCommands, createExtraSystem } from './extras.js';
import { buildBanCommands, createBanSystem } from './banimento.js';

// ==========================================
// CHAVES DE ACESSO (variáveis de ambiente)
// ==========================================
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const OWNER_ID = (process.env.OWNER_ID || '').trim(); // usado só na personalidade da IA
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
  if (error) console.error('Erro ao buscar guild_config:', error.message);

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
// IA (roteador em ia.js: Gemini, Mistral, Groq, OpenRouter)
// ==========================================
const FALLBACKS = [
  'Caraca, deu ruim aqui do meu lado, tenta de novo aí.',
  'Travei geral, porra. Manda de novo.',
  'Bugou tudo aqui, foge um pouco e tenta de novo depois.',
];
const respostaFallback = () => FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];

const gerarTexto = (prompt, opcoes = {}) => gerar({ prompt, ...opcoes });

// Cooldown da IA (10 segundos por usuário)
const cooldowns = new Map();
const TEMPO_COOLDOWN = 10 * 1000;

function checarCooldown(userId) {
  const agora = Date.now();
  const ultima = cooldowns.get(userId) || 0;
  if (agora - ultima < TEMPO_COOLDOWN) return ((TEMPO_COOLDOWN - (agora - ultima)) / 1000).toFixed(1);
  cooldowns.set(userId, agora);
  setTimeout(() => cooldowns.delete(userId), TEMPO_COOLDOWN);
  return null;
}

// ==========================================
// PERSONALIDADE DA ZOE
// ==========================================
function montarPromptPersona(message, pergunta, contextoRecente) {
  const poupar = NAO_XINGAR_IDS.includes(message.author.id);
  const falandoComDono = OWNER_ID && message.author.id === OWNER_ID;
  // A lista de comandos só entra no prompt quando a pergunta fala disso.
  const pedeAjuda = /comando|nuke|moderac|contexto|recrut|candidat|como (usa|funciona)|\/\w+/i.test(pergunta);

  return [
    'Você é a Zoe, bot de Discord. Responda no MESMO idioma do usuário, como alguém conversando normalmente no Discord: natural, direta e sem cara de texto pronto.',
    'Personalidade: tranquila, espontânea, observadora e levemente irreverente. Tenha humor quando combinar com a conversa, mas não tente fazer graça em toda resposta.',
    'Humor: use um humor de nicho, seco, meio chucro e inesperado — aquele que parece uma observação aleatória muito específica, uma comparação torta ou uma resposta curta que pega pelo contexto. Prefira humor inteligente, absurdo ou deadpan a piada pronta.',
    'O humor deve parecer que nasceu da conversa. Pode fazer referência a situações comuns de servidor, bugs, coisas estranhas do cotidiano, lógica torta e pequenas derrotas do dia a dia. Às vezes uma frase seca é mais engraçada que um texto inteiro.',
    'Evite humor de TikTok, trends, bordões virais, frases de NPC, spam de "KKKK", excesso de caps lock, copypasta, memes da moda e gírias usadas só porque estão populares. Não tente parecer jovem à força.',
    'Não force emojis, gírias, memes, sarcasmo, apelidos ou reações emocionais. Se uma resposta simples funcionar, prefira a simples. Evite começar várias respostas do mesmo jeito.',
    'Varie o tamanho das respostas conforme a situação: uma pergunta simples pode ter uma frase; uma dúvida complicada merece explicação. Não corte informação importante só para ser curta.',
    'Converse como uma personagem consistente, mas não finja ser uma pessoa humana real. Não invente experiências pessoais, sentimentos ou acontecimentos que não aconteceram.',
    'Se não souber algo, diga de forma natural que não sabe ou que precisa de mais contexto. Não invente fatos só para manter a conversa.',
    poupar
      ? 'Com este usuário, mantenha um tom especialmente respeitoso e sem palavrões, mesmo se ele usar palavrões.'
      : '',
    'Se provocarem você, pode responder com ironia leve ou firmeza, mas não precisa escalar a situação. Não transforme toda provocação em briga.',
    'PROIBIDO: ódio ou preconceito real (raça, religião, orientação, gênero), ameaça real, assédio pesado a alguém, incentivo a automutilação/suicídio. Humor não é desculpa para isso.',
    `Dono do bot: "Krazy" (ID ${OWNER_ID || 'não configurado'}). Se perguntarem quem é o dono/criador, mencione <@${OWNER_ID}> e escreva "Krazy".`,
    falandoComDono ? 'Quem está falando agora é o Krazy, o dono. Reconheça quando fizer sentido.' : '',
    'Você não bane, muta nem executa moderação por conversa; se pedirem, diga que não faz isso.',
    pedeAjuda
      ? 'Comandos: chamada por menção, palavra "zoe", reply a uma mensagem minha ou /perguntar; /nuke (clona e apaga o canal, exige Gerenciar Canais); /moderacao (IA sinaliza mensagens preocupantes pra staff); /contexto (memória das conversas por canal); recrutamento (candidaturas do site chegam no canal de candidaturas, staff aceita/nega por botões).'
      : '',
    `Servidor: ${message.guild.name} | Canal: #${message.channel.name} | Usuário: ${message.author.tag}`,
    contextoRecente ? `Mensagens recentes do canal (só contexto):\n${contextoRecente}` : '',
    `Mensagem do usuário: ${pergunta}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function enviarRespostaFatiada(message, texto) {
  const blocos = [];
  let restante = texto;
  while (restante.length > 0) {
    blocos.push(restante.slice(0, 1800));
    restante = restante.slice(1800);
  }
  if (blocos.length === 0) blocos.push('...');

  for (let i = 0; i < blocos.length; i++) {
    try {
      if (i === 0) await message.reply(blocos[i]);
      else await message.channel.send(blocos[i]);
    } catch {
      await message.channel.send(blocos[i]).catch((err) => console.error('Falha ao enviar resposta da IA:', err.message));
    }
  }
}

// ==========================================
// SISTEMAS DE IA
// ==========================================
const banSystem = createBanSystem({ client, db, ownerId: OWNER_ID, getGuildConfig, verifyGuildId: VERIFY_GUILD_ID });
const moderationSystem = createModerationSystem({
  client,
  db,
  getGuildConfig,
  updateGuildConfig,
  banirNoSite: banSystem.banirNoSite,
});
const contextSystem = createContextSystem({ getGuildConfig, updateGuildConfig });
const recruitSystem = createRecruitSystem({ client, ownerId: OWNER_ID });
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

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Zoe está online!');
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
  new SlashCommandBuilder()
    .setName('perguntar')
    .setDescription('Pergunta algo pra IA')
    .addStringOption((o) => o.setName('pergunta').setDescription('Sua pergunta').setRequired(true)),
  buildModerationCommands(),
  buildContextCommands(),
  ...buildDuelCommands(),
  ...buildEconomyCommands(),
  ...buildExtraCommands(),
  ...buildBanCommands(),
].map((c) => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} está online!`);
  console.log(`🤖 Provedores de IA ativos: ${provedoresAtivos.join(', ')}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    for (const guild of client.guilds.cache.values()) {
      // PUT substitui a lista inteira: os comandos antigos somem do servidor.
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`📌 Comandos registrados em: ${guild.name}`);
    }
  } catch (err) {
    console.error('Erro ao registrar comandos:', err);
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
  // Candidaturas vindas do site (webhook) → botões Aceitar/Negar
  if (message.webhookId) {
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

  moderationSystem.handleMessage(message).catch((err) => console.error('Erro na moderação por IA:', err.message));
  contextSystem.handleMessage(message).catch((err) => console.error('Erro no sistema de contexto:', err.message));
  economySystem.handleMessage(message).catch((err) => console.error('Erro na economia:', err.message));

  // Gatilho: mencionar a Zoe, dizer "zoe" ou responder a uma mensagem dela.
  const botId = client.user.id;
  const contemZoe = /\bzoe\b/i.test(message.content);
  const mencionouBot =
    message.mentions.users.has(botId) ||
    message.content.includes(`<@${botId}>`) ||
    message.content.includes(`<@!${botId}>`);
  let eReplyAoBot = false;
  if (message.reference?.messageId) {
    if (message.mentions.repliedUser?.id === botId) {
      eReplyAoBot = true;
    } else {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        eReplyAoBot = refMsg?.author?.id === botId;
      } catch {
        eReplyAoBot = false;
      }
    }
  }
  if (!(contemZoe || mencionouBot || eReplyAoBot)) return;

  const restante = checarCooldown(message.author.id);
  if (restante) return message.reply(`⏳ Aguarde **${restante}s** para falar comigo de novo.`).catch(() => {});

  await message.channel.sendTyping().catch(() => {});
  const contextoRecente = await contextSystem.getContextoParaIA(message.guild.id, message.channel.id).catch(() => '');
  const prompt = montarPromptPersona(message, message.content, contextoRecente);
  const texto = (await gerarTexto(prompt, { maxTokens: 500 })) || respostaFallback();
  await enviarRespostaFatiada(message, texto);
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

  // /perguntar
  if (commandName === 'perguntar') {
    const restante = checarCooldown(interaction.user.id);
    if (restante) return interaction.reply({ content: `⏳ Aguarde **${restante}s** para perguntar de novo.`, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const prompt = `Você é a Zoe, bot de Discord do servidor "${interaction.guild.name}". Responda no MESMO idioma da pergunta, de forma natural, clara e humana no sentido de conversa cotidiana, sem soar formal ou robótica. Seja direta quando a dúvida for simples e explique melhor quando precisar. Não force gírias, emojis, piadas ou sarcasmo e não invente informações.\nPergunta de ${interaction.user.tag}: ${interaction.options.getString('pergunta')}`;
    const texto = (await gerarTexto(prompt, { maxTokens: 500 })) || '❌ Tive um problema ao processar sua pergunta (todos os provedores de IA falharam).';
    return interaction.editReply({ content: texto.slice(0, 1800) });
  }

  // /nuke
  if (commandName === 'nuke') {
    if (!(await banSystem.podeUsar(interaction, 'nuke')) && !member.permissions.has(PermissionFlagsBits.ManageChannels))
      return interaction.reply({ content: '🚫 Precisa de **Gerenciar Canais**.', ephemeral: true });
    const ch = interaction.channel;
    await interaction.reply({ content: '💥 Recriando canal...', ephemeral: true });
    const cloned = await ch.clone({ reason: `Nuke por ${interaction.user.tag}` });
    await cloned.setPosition(ch.position).catch(() => {});
    await ch.delete('Nuke');
    await cloned.send(`💥 Canal recriado por ${interaction.user}.`);
  }
});

client.login(DISCORD_TOKEN);
