// Roteador central de IA: Gemini, Mistral (com visão), Cerebras (grátis, só texto), Groq e OpenRouter.
// - Provedor que estoura cota (429) é pausado e pulado até voltar.
// - Pedidos com imagem só vão para provedores com visão (Gemini, Mistral, OpenRouter se configurado).
// - Texto puro usa primeiro quem não tem visão, guardando a cota do Gemini pras imagens.
// - Imagens são reduzidas antes do envio (menos tokens, menos banda).
import { GoogleGenAI } from '@google/genai';
import { createCanvas, loadImage } from '@napi-rs/canvas';

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

// Várias chaves do Gemini: GEMINI_API_KEY e/ou GEMINI_API_KEYS (separadas por vírgula).
// A cota grátis é por PROJETO do Google: chaves do mesmo projeto dividem a mesma cota.
const GEMINI_KEYS = [...new Set([env('GEMINI_API_KEY'), ...env('GEMINI_API_KEYS').split(',')].map((k) => k.trim()).filter(Boolean))];
const clientesGemini = GEMINI_KEYS.map((apiKey) => new GoogleGenAI({ apiKey }));

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

// ---------- Pausa por cota ----------
const pausadoAte = new Map(); // provedor -> timestamp

function pausarSeCota(provedor, err) {
  const msg = String(err?.message || err);
  if (/404|NOT_FOUND|model.*(not found|does not exist)/i.test(msg)) {
    pausadoAte.set(provedor, Date.now() + 6 * 60 * 60 * 1000);
    console.warn(`⏸️ ${provedor} pausado por 6h: modelo "${MODELOS[provedor]}" parece não existir. Confira a variável de modelo.`);
    return;
  }
  if (!/429|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg)) return;
  const segundos = Number(msg.match(/retry in ([\d.]+)s/i)?.[1] || msg.match(/"retryDelay":"(\d+)s"/)?.[1]);
  // Cota diária: o "retry in" engana, então pausa por mais tempo.
  const diaria = /PerDay|per day/i.test(msg);
  const ms = diaria ? 30 * 60 * 1000 : (segundos ? segundos * 1000 + 2000 : 60 * 1000);
  pausadoAte.set(provedor, Date.now() + ms);
  console.warn(`⏸️ ${provedor} pausado por ${Math.round(ms / 1000)}s (cota).`);
}

const disponivel = (p) => (pausadoAte.get(p) || 0) <= Date.now();

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
async function chamarGemini(modelo, indice, { prompt, imagens, json, maxTokens }) {
  const partes = [{ text: prompt }, ...imagens.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))];
  const r = await clientesGemini[indice].models.generateContent({
    model: modelo,
    contents: [{ role: 'user', parts: partes }],
    config: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  return r.text || '';
}

async function chamarOpenAI(provedor, { prompt, imagens, json, maxTokens }) {
  const content = imagens.length
    ? [{ type: 'text', text: prompt }, ...imagens.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))]
    : prompt;
  const resp = await fetch(URLS[provedor], {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAVES[provedor]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provedor === 'openrouter' && imagens.length ? OPENROUTER_VISAO : MODELOS[provedor],
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      ...(json && provedor === 'mistral' ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`${provedor} status ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

let rodizio = 0;

/**
 * gerar({ prompt, imagens = [], json = false, maxTokens = 500 }) -> string | null
 * Tenta cada provedor disponível; pausa os que estouram cota; null se todos falharem.
 */
export async function gerar({ prompt, imagens = [], json = false, maxTokens = 500 }) {
  const precisaVisao = imagens.length > 0;
  let candidatos = provedoresAtivos.filter((p) => (!precisaVisao || temVisao(p)) && disponivel(p));
  if (!candidatos.length) return null;

  // Texto puro: usa primeiro quem NÃO tem visão (Groq, OpenRouter...) e deixa o Gemini
  // por último, pra guardar a cota dele pras imagens (/larp, moderação de imagem).
  if (!precisaVisao) {
    const semVisao = candidatos.filter((p) => !temVisao(p));
    const comVisao = candidatos.filter((p) => temVisao(p));
    const gira = (arr) => {
      const i = arr.length ? rodizio % arr.length : 0;
      return [...arr.slice(i), ...arr.slice(0, i)];
    };
    candidatos = [...gira(semVisao), ...gira(comVisao)];
  } else {
    const inicio = rodizio % candidatos.length;
    candidatos = [...candidatos.slice(inicio), ...candidatos.slice(0, inicio)];
  }
  rodizio++;

  for (const p of candidatos) {
    try {
      const args = { prompt, imagens, json, maxTokens };
      const [tipo, idx] = p.split(':');
      const texto = tipo === 'gemini' || tipo === 'gemini2' ? await chamarGemini(MODELOS[tipo], Number(idx), args) : await chamarOpenAI(p, args);
      if (texto) return texto;
    } catch (err) {
      console.error(`Erro na IA (${p}):`, String(err.message).slice(0, 200));
      pausarSeCota(p, err);
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
