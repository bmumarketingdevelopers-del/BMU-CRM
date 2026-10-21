// v37: watermarked previews of a one-time project's final work before the balance is paid.
// Images: scaled to at most 1600 px, the watermark tiled across, sent as JPEG. PDFs: a diagonal mark on every page.
// Other types return null (videos play in the app with an on-screen watermark; anything else waits for payment).
import { Jimp, JimpMime } from 'jimp';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { WATERMARK_TILE_PNG } from './watermark-tile.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/tiff'];
const MAX_SIDE = 1600;

/** Recent previews, so opening the same file again is quick (a handful per server instance). */
const cache = new Map<string, { type: string; body: Buffer }>();
const remember = (key: string, v: { type: string; body: Buffer }) => {
  cache.set(key, v);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  return v;
};

export const canWatermark = (mime: string | null | undefined) => !!mime && (IMAGE_TYPES.includes(mime.toLowerCase()) || mime.toLowerCase() === 'application/pdf');

/** A watermarked preview of the file's bytes, or null when this type can't be watermarked. */
export async function watermarked(key: string, mime: string | null | undefined, bytes: Buffer): Promise<{ type: string; body: Buffer } | null> {
  const m = (mime ?? '').toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  if (IMAGE_TYPES.includes(m)) {
    const img = await Jimp.read(bytes).catch(() => null);
    if (!img) return null;
    if (img.bitmap.width > MAX_SIDE || img.bitmap.height > MAX_SIDE) img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });
    const tile = await Jimp.read(WATERMARK_TILE_PNG);
    // Smaller previews get a smaller tile so the mark still repeats.
    const scale = Math.max(0.45, Math.min(1, img.bitmap.width / 1200));
    if (scale < 1) tile.scale(scale);
    for (let y = -tile.bitmap.height / 2; y < img.bitmap.height; y += tile.bitmap.height) {
      for (let x = (y / tile.bitmap.height) % 2 ? -tile.bitmap.width / 2 : 0; x < img.bitmap.width; x += tile.bitmap.width) img.composite(tile, Math.round(x), Math.round(y));
    }
    return remember(key, { type: 'image/jpeg', body: await img.getBuffer(JimpMime.jpeg, { quality: 72 }) });
  }
  if (m === 'application/pdf') {
    // A PDF we can't read is held back (null) rather than sent unmarked.
    try {
      return remember(key, await markPdf(bytes));
    } catch {
      return null;
    }
  }
  return null;
}

async function markPdf(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(18, Math.min(width, height) / 14);
    for (let y = -height; y < height * 1.5; y += size * 6) {
      for (let x = -width / 2; x < width; x += size * 14) {
        page.drawText('BMU · PREVIEW · Not for use until paid', { x, y, size, font, color: rgb(0.45, 0.45, 0.45), opacity: 0.22, rotate: degrees(30) });
      }
    }
  }
  return { type: 'application/pdf', body: Buffer.from(await pdf.save()) };
}
