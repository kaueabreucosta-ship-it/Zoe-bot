// Roteador central de IA: Gemini, Mistral (com visão), Cerebras (grátis, só texto), Groq e OpenRouter.
// - Aceita instrução de sistema + histórico de conversa (multi-turno de verdade).
// - Provedor que estoura cota (429) é pausado e pulado até voltar; falhas seguidas (timeout/5xx) entram em
//   backoff crescente; chave inválida pausa por mais tempo.
// - Pedidos com imagem só vão para provedores com visão (Gemini, Mistral, OpenRouter se configurado).
// - Texto puro usa primeiro quem não tem visão, guardando a cota do Gemini pras imagens.
// - Entre provedores "iguais", os mais saudáveis (menos falhas seguidas) vêm primeiro.
// - Imagens são reduzidas antes do envio (menos tokens, menos banda).
import { GoogleGenAI } from '@google/genai';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { limparTexto } from './texto-util.js';

export { limparTexto };

const env = (k) => (process.env[k] || '').trim();

// Modelos podem ser trocados por variável de ambiente, sem mexer no código.
const MODELOS = {
  gemini: env('GEMINI_MODEL') || 'gemini-3.6-flash',
  gemini2: env('GEMINI_MODEL_2'), // opcional: outro modelo Gemini = outra cota grátis
  mistral: env('MISTRAL_MODEL') || 'mistral-small-latest', // aceita imagem
  cerebras: env('CEREBRAS_MODEL') || 'gpt-oss-120b',
  groq: env('GROQ_MODEL') || 'openai/gpt-oss-120b',
  openrouter: env('OPENROUTER_MODEL') || 'openrouter/free',
};

const CHAVES = {
  mistral: env('MISTRAL_API_KEY'),
  cerebras: env('CEREBRAS_API_KEY'),
  groq: env('GROQ_API_KEY'),
  openrouter: env('OPENROUTER_API_KEY'),
};

// Modelos "gpt-oss" gastam tokens pensando. "low" deixa a resposta bem mais rápida e barata.
// Defina IA_REASONING_EFFORT=off se o seu provedor reclamar desse parâmetro.
const REASONING = (env('IA_REASONING_EFFORT') || 'low').toLowerCase();

// Várias chaves do Gemini: GEMINI_API_KEY e/ou GEMINI_API_KEYS (separadas por vírgula).
// A cota grátis é por PROJETO do Google: chaves do mesmo projeto dividem a mesma cota.
const GEMINI_KEYS = [...new Set([env('GEMINI_API_KEY'), ...env('GEMINI_API_KEYS').split(',')].map((k) => k.trim()).filter(Boolean))];
const clientesGemini = GEMINI_KEYS.map((apiKey) => new GoogleGenAI({ apiKey }));

// Prompt adicional solicitado: é lido uma vez e enviado em toda chamada ao Gemini.
const DIRETORIO_IA = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO_PROMPT_GEMINI = path.join(DIRETORIO_IA, 'Gemin-flash-lite-descricaodeservidor.txt');
let promptGeminiCache;
async function carregarPromptGemini() {
  if (promptGeminiCache !== undefined) return promptGeminiCache;
  try {
    promptGeminiCache = await readFile(ARQUIVO_PROMPT_GEMINI, 'utf8');
    console.info(`📘 Prompt extra do Gemini carregado (${promptGeminiCache.length} caracteres).`);
  } catch (err) {
    promptGeminiCache = '';
    console.warn(`⚠️ Não foi possível ler ${path.basename(ARQUIVO_PROMPT_GEMINI)}: ${err.message}`);
  }
  return promptGeminiCache;
}


const URLS = {
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

// OpenRouter só recebe imagem se você definir OPENROUTER_VISION_MODEL (um modelo :free com visão).
const OPENROUTER_VISAO = env('OPENROUTER_VISION_MODEL');
const VISAO_BASE = new Set(['gemini', 'gemini2', 'mistral', ...(OPENROUTER_VISAO && CHAVES.openrouter ? ['openrouter'] : [])]);

// IDs: "gemini:0", "gemini:1"... (uma entrada por chave), "gemini2:0"..., "mistral", "groq" etc.
const base = (p) => p.split(':')[0];
const temVisao = (p) => VISAO_BASE.has(base(p));

export const provedoresAtivos = [
  ...GEMINI_KEYS.map((_, i) => `gemini:${i}`),
  ...(MODELOS.gemini2 ? GEMINI_KEYS.map((_, i) => `gemini2:${i}`) : []),
  ...['mistral', 'cerebras', 'groq', 'openrouter'].filter((p) => CHAVES[p]),
];

// ---------- Saúde dos provedores ----------
const pausadoAte = new Map(); // provedor -> timestamp
const saude = new Map(); // provedor -> estatísticas

function stats(p) {
  let s = saude.get(p);
  if (!s) {
    s = { ok: 0, erros: 0, seguidas: 0, latenciaMs: 0, ultimoErro: '', ultimaVez: 0 };
    saude.set(p, s);
  }
  return s;
}

function registrarSucesso(p, ms) {
  const s = stats(p);
  s.ok += 1;
  s.seguidas = 0;
  s.latenciaMs = s.latenciaMs ? Math.round(s.latenciaMs * 0.7 + ms * 0.3) : ms;
  s.ultimaVez = Date.now();
}

function registrarFalha(p, err) {
  const s = stats(p);
  s.erros += 1;
  s.seguidas += 1;
  s.ultimoErro = String(err?.message || err).slice(0, 140);
  s.ultimaVez = Date.now();
}

function pausar(provedor, ms, motivo) {
  pausadoAte.set(provedor, Date.now() + ms);
  console.warn(`⏸️ ${provedor} pausado por ${Math.round(ms / 1000)}s (${motivo}).`);
}

// Devolve true se a falha já virou pausa (cota, modelo inexistente, chave inválida).
function pausarSeCota(provedor, err) {
  const msg = String(err?.message || err);
  if (/404|NOT_FOUND|model.*(not found|does not exist)/i.test(msg)) {
    pausar(provedor, 6 * 60 * 60 * 1000, `modelo "${MODELOS[base(provedor)]}" parece não existir — confira a variável de modelo`);
    return true;
  }
  if (/401|API key not valid|invalid api key|incorrect api key|unauthorized/i.test(msg)) {
    pausar(provedor, 6 * 60 * 60 * 1000, 'chave de API recusada');
    return true;
  }
  if (!/429|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg)) return false;
  const segundos = Number(msg.match(/retry in ([\d.]+)s/i)?.[1] || msg.match(/"retryDelay":"(\d+)s"/)?.[1]);
  // Cota diária: o "retry in" engana, então pausa por mais tempo.
  const diaria = /PerDay|per day/i.test(msg);
  const ms = diaria ? 30 * 60 * 1000 : (segundos ? segundos * 1000 + 2000 : 60 * 1000);
  pausar(provedor, ms, 'cota');
  return true;
}

// Falhas "normais" (timeout, 5xx, rede): depois de 2 seguidas, pausa crescente (10s, 20s, 40s... até 5 min).
function backoffSeFalhando(provedor) {
  const { seguidas } = stats(provedor);
  if (seguidas < 2) return;
  pausar(provedor, Math.min(5 * 60_000, 10_000 * 2 ** (seguidas - 2)), `${seguidas} falhas seguidas`);
}

const disponivel = (p) => (pausadoAte.get(p) || 0) <= Date.now();

/** Estado atual de cada provedor (usado pelo /iastatus). */
export function statusProvedores() {
  const agora = Date.now();
  return provedoresAtivos.map((p) => {
    const s = stats(p);
    const restante = Math.max(0, Math.ceil(((pausadoAte.get(p) || 0) - agora) / 1000));
    return {
      id: p,
      modelo: MODELOS[base(p)] || p,
      visao: temVisao(p),
      pausadoSeg: restante,
      ok: s.ok,
      erros: s.erros,
      latenciaMs: s.latenciaMs,
      ultimoErro: s.ultimoErro,
    };
  });
}

// ---------- Imagens ----------
// Reduz para no máximo `lado` px e recomprime em JPEG. Se falhar, usa a original.
export async function prepararImagem(buffer, mimeType, lado = 768) {
  try {
    const img = await loadImage(buffer);
    const escala = Math.min(1, lado / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * escala));
    const h = Math.max(1, Math.round(img.height * escala));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { mimeType: 'image/jpeg', data: canvas.toBuffer('image/jpeg', 70).toString('base64') };
  } catch {
    return { mimeType, data: buffer.toString('base64') };
  }
}

// ---------- Chamadas ----------
// Nenhuma chamada fica pendurada: se um provedor travar, o próximo da fila assume.
const TIMEOUT_IA_MS = 25_000;
function comTimeout(promessa, ms, nome) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${nome}: timeout de ${ms / 1000}s`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(t));
}

// Junta turnos seguidos do mesmo papel e garante que o histórico comece com "user" (exigência do Gemini).
function normalizarHistorico(historico = []) {
  const saida = [];
  for (const h of historico) {
    const texto = String(h?.text ?? '').trim();
    if (!texto) continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const ultimo = saida[saida.length - 1];
    if (ultimo && ultimo.role === role) ultimo.text += `\n${texto}`;
    else saida.push({ role, text: texto });
  }
  while (saida.length && saida[0].role !== 'user') saida.shift();
  return saida;
}

async function chamarGemini(modelo, indice, { prompt, system, historico, imagens, json, maxTokens, temperature }) {
  const promptExtra = await carregarPromptGemini();
  const systemGemini = [system, promptExtra].filter(Boolean).join('\\n\\n--- INSTRUÇÕES ADICIONAIS DO ARQUIVO ---\\n\\n');
  const contents = historico.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] }));
  const partes = [{ text: prompt }, ...imagens.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))];
  const ultimo = contents[contents.length - 1];
  if (ultimo && ultimo.role === 'user') ultimo.parts.push(...partes);
  else contents.push({ role: 'user', parts: partes });

  const r = await comTimeout(
    clientesGemini[indice].models.generateContent({
      model: modelo,
      contents,
      config: {
        maxOutputTokens: maxTokens,
        ...(systemGemini ? { systemInstruction: systemGemini } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    TIMEOUT_IA_MS,
    'gemini'
  );
  return r.text || '';
}

async function chamarOpenAI(provedor, { prompt, system, historico, imagens, json, maxTokens, temperature }) {
  const conteudoFinal = imagens.length
    ? [{ type: 'text', text: prompt }, ...imagens.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))]
    : prompt;

  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...historico.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: conteudoFinal },
  ];

  const modelo = provedor === 'openrouter' && imagens.length ? OPENROUTER_VISAO : MODELOS[provedor];
  const usaRaciocinio = (provedor === 'groq' || provedor === 'cerebras') && /gpt-oss/i.test(modelo) && REASONING !== 'off';

  const resp = await fetch(URLS[provedor], {
    signal: AbortSignal.timeout(TIMEOUT_IA_MS),
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAVES[provedor]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelo,
      messages,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(usaRaciocinio ? { reasoning_effort: REASONING } : {}),
      ...(json && provedor === 'mistral' ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`${provedor} status ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

let rodizio = 0;

function ordenarCandidatos(candidatos, precisaVisao) {
  const gira = (arr) => {
    if (!arr.length) return arr;
    const i = rodizio % arr.length;
    return [...arr.slice(i), ...arr.slice(0, i)];
  };
  // sort() é estável: entre empatados em saúde, vale a ordem do rodízio.
  const porSaude = (arr) => gira(arr).sort((a, b) => stats(a).seguidas - stats(b).seguidas);

  if (precisaVisao) return porSaude(candidatos);
  // Texto puro: usa primeiro quem NÃO tem visão (Groq, Cerebras...) e deixa o Gemini
  // por último, pra guardar a cota dele pras imagens (/larp, moderação de imagem).
  return [...porSaude(candidatos.filter((p) => !temVisao(p))), ...porSaude(candidatos.filter((p) => temVisao(p)))];
}

/**
 * gerar({ prompt, system, historico, imagens, json, maxTokens, temperature }) -> string | null
 *  - prompt:      a mensagem atual (obrigatório)
 *  - system:      instrução fixa (persona/regras). Fica separada do prompt: mais barato e mais obediente.
 *  - historico:   [{ role: 'user' | 'assistant', text }] turnos anteriores
 *  - imagens:     [{ mimeType, data(base64) }]
 *  - json:        pede saída em JSON
 * Tenta cada provedor disponível; pausa os que estouram cota; null se todos falharem.
 */
export async function gerar({ prompt, system = '', historico = [], imagens = [], json = false, maxTokens = 500, temperature } = {}) {
  const precisaVisao = imagens.length > 0;
  const candidatos = provedoresAtivos.filter((p) => (!precisaVisao || temVisao(p)) && disponivel(p));
  if (!candidatos.length) return null;

  const ordem = ordenarCandidatos(candidatos, precisaVisao);
  rodizio++;

  // Se o histórico terminar num turno "user", junta ele ao prompt (nunca dois "user" seguidos).
  const hist = normalizarHistorico(historico);
  const promptFinal = hist.length && hist[hist.length - 1].role === 'user' ? `${hist.pop().text}\n${prompt}` : prompt;

  const args = {
    prompt: promptFinal,
    system,
    historico: hist,
    imagens,
    json,
    maxTokens,
    temperature: temperature ?? (json ? 0.2 : undefined),
  };

  for (const p of ordem) {
    const inicio = Date.now();
    try {
      const [tipo, idx] = p.split(':');
      const texto = tipo === 'gemini' || tipo === 'gemini2' ? await chamarGemini(MODELOS[tipo], Number(idx), args) : await chamarOpenAI(p, args);
      if (texto && texto.trim()) {
        registrarSucesso(p, Date.now() - inicio);
        return texto;
      }
      registrarFalha(p, 'resposta vazia');
    } catch (err) {
      console.error(`Erro na IA (${p}):`, String(err.message).slice(0, 200));
      registrarFalha(p, err);
      if (!pausarSeCota(p, err)) backoffSeFalhando(p);
    }
  }
  return null;
}

export function extrairJson(texto) {
  if (!texto) return null;
  const m = texto.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
