/**
 * Gera a imagem "MOGGED": foto de perfil do perdedor com a palavra MOGGED
 * desenhada em cima e o nick embaixo. Usa @napi-rs/canvas (sem dependências nativas
 * do sistema). Se a biblioteca não carregar, gerarImagemMogged devolve null e quem
 * chamou usa um embed simples como plano B.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TAMANHO = 640;

let canvasLib = null;
try {
  canvasLib = await import('@napi-rs/canvas');
  try {
    // Fontes vão junto do projeto: o Render não garante nenhuma fonte instalada.
    canvasLib.GlobalFonts.registerFromPath(path.join(DIR, 'fonts', 'Poppins-Bold.ttf'), 'ZoeBold');
    canvasLib.GlobalFonts.registerFromPath(path.join(DIR, 'fonts', 'DejaVuSans-Bold.ttf'), 'ZoeFallback');
  } catch (err) {
    console.warn('⚠️ Não consegui registrar as fontes do MOGGED:', err.message);
  }
} catch (err) {
  console.warn('⚠️ @napi-rs/canvas indisponível — o MOGGED vai usar embed simples:', err.message);
}

export async function baixarAvatar(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) }); // CORREÇÃO: timeout
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// Escreve texto centralizado, reduzindo a fonte até caber na largura máxima.
function textoContornado(ctx, texto, x, y, { tamanho, minimo, larguraMax, cor, contorno }) {
  let size = tamanho;
  ctx.font = `${size}px ZoeBold, ZoeFallback`;
  while (ctx.measureText(texto).width > larguraMax && size > minimo) {
    size -= 2;
    ctx.font = `${size}px ZoeBold, ZoeFallback`;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 7);
  ctx.strokeStyle = contorno;
  ctx.strokeText(texto, x, y);
  ctx.fillStyle = cor;
  ctx.fillText(texto, x, y);
}

/** @returns {Promise<Buffer|null>} PNG, ou null se o canvas não estiver disponível. */
export async function gerarImagemMogged({ nome, avatarBuffer }) {
  if (!canvasLib) return null;
  const { createCanvas, loadImage } = canvasLib;
  const S = TAMANHO;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');

  // Fundo + foto de perfil
  ctx.fillStyle = '#0B0714';
  ctx.fillRect(0, 0, S, S);
  if (avatarBuffer) {
    try {
      const img = await loadImage(avatarBuffer);
      ctx.drawImage(img, 0, 0, S, S);
    } catch {
      /* segue só com o fundo escuro */
    }
  }

  // Clima de derrota: tom vermelho + sombras em cima e embaixo pro texto ficar legível
  ctx.fillStyle = 'rgba(110, 30, 200, 0.30)';
  ctx.fillRect(0, 0, S, S);
  const topo = ctx.createLinearGradient(0, 0, 0, S * 0.45);
  topo.addColorStop(0, 'rgba(0, 0, 0, 0.9)');
  topo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = topo;
  ctx.fillRect(0, 0, S, S * 0.45);
  const base = ctx.createLinearGradient(0, S * 0.65, 0, S);
  base.addColorStop(0, 'rgba(0, 0, 0, 0)');
  base.addColorStop(1, 'rgba(0, 0, 0, 0.92)');
  ctx.fillStyle = base;
  ctx.fillRect(0, S * 0.65, S, S * 0.35);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // "MOGGED" em cima, levemente inclinado
  ctx.save();
  ctx.translate(S / 2, S * 0.15);
  ctx.rotate(-0.07);
  textoContornado(ctx, 'MOGGED', 0, 0, {
    tamanho: 150,
    minimo: 60,
    larguraMax: S - 70,
    cor: '#B57BFF',
    contorno: '#000000',
  });
  ctx.restore();

  // Nick embaixo
  const nick = String(nome || '???').slice(0, 28);
  textoContornado(ctx, nick, S / 2, S * 0.9, {
    tamanho: 60,
    minimo: 26,
    larguraMax: S - 60,
    cor: '#FFFFFF',
    contorno: '#000000',
  });

  return canvas.toBuffer('image/png');
}
