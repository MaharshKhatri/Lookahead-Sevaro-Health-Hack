import 'server-only';
import QRCode from 'qrcode';

/** QR codes rendered server-side to SVG (npm `qrcode`), cached per URL. */
const cache = new Map<string, string>();

export async function qrSvg(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B1320', light: '#E8EEF5' } });
  if (cache.size > 100) cache.clear();
  cache.set(url, svg);
  return svg;
}
