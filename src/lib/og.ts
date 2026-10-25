// Build-time share images (1200x630 PNG) in the Tritone look: charcoal ground,
// Archivo Black type, white wordmark. Text is drawn as vector paths with
// opentype.js and rasterized by sharp, so no system fonts or headless browser.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";

const W = 1200;
const H = 630;
const CHARCOAL = "#38383B";
const STONE = "#A8A6A1";
const WHITE = "#FFFFFF";

const root = process.cwd();
const fontFile = (p: string) => readFile(join(root, "node_modules", p));
let fonts: Promise<{ display: opentype.Font; body: opentype.Font; logo: Buffer }> | undefined;
const load = () =>
  (fonts ??= Promise.all([
    fontFile("@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff"),
    fontFile("@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff"),
    readFile(join(root, "src/assets/logo/tritone-wordmark-white.png")),
  ]).then(([d, b, logo]) => ({
    display: opentype.parse(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)),
    body: opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
    logo,
  })));

/** Greedy word wrap to `max` px; shrinks the size until it fits in `lines` lines. */
function fit(font: opentype.Font, text: string, max: number, size: number, lines: number, min = 40) {
  for (let s = size; s >= min; s -= 4) {
    const out: string[] = [];
    let cur = "";
    for (const word of text.split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.getAdvanceWidth(next, s) <= max || !cur) cur = next;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    if (out.length <= lines && out.every((l) => font.getAdvanceWidth(l, s) <= max)) return { size: s, lines: out };
  }
  return { size: min, lines: [text] };
}

const path = (font: opentype.Font, text: string, x: number, y: number, size: number, fill: string, spacing = 0) => {
  if (!spacing) return `<path d="${font.getPath(text, x, y, size).toPathData(2)}" fill="${fill}"/>`;
  let d = "";
  let cx = x;
  for (const ch of text) {
    d += font.getPath(ch, cx, y, size).toPathData(2);
    cx += font.getAdvanceWidth(ch, size) + spacing;
  }
  return `<path d="${d}" fill="${fill}"/>`;
};

export interface OgCard {
  /** Small line above, e.g. "FRI · NOV 13 · 8:00 PM". */
  kicker: string;
  /** Big headline, e.g. the band. */
  headline: string;
  /** Line below, e.g. "Rite Spot Cafe · San Francisco". */
  sub?: string;
  /** Huge day number at right (optional). */
  num?: string;
  mon?: string;
}

export async function renderOg(card: OgCard): Promise<Buffer> {
  const { display, body, logo } = await load();
  const left = 72;
  const textMax = card.num ? 720 : 1056;
  const head = fit(display, card.headline.toUpperCase(), textMax, 92, 3);
  const lineH = head.size * 1.0;
  const headTop = 210;

  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="${CHARCOAL}"/>`,
    path(body, card.kicker.toUpperCase(), left, 150, 26, STONE, 3.5),
    ...head.lines.map((l, i) => path(display, l, left, headTop + head.size * 0.8 + i * lineH, head.size, WHITE)),
  ];
  const subY = headTop + head.size * 0.8 + (head.lines.length - 1) * lineH + 70;
  parts.push(`<rect x="${left}" y="${subY - 44}" width="72" height="6" fill="${STONE}"/>`);
  if (card.sub) {
    const sub = fit(body, card.sub.toUpperCase(), textMax, 30, 1, 20);
    parts.push(path(body, sub.lines[0], left, subY + 8, sub.size, STONE, 2));
  }
  if (card.num) {
    const size = 300;
    const w = display.getAdvanceWidth(card.num, size);
    const x = W - 72 - w;
    parts.push(`<rect x="${W - 400}" y="0" width="400" height="${H}" fill="#000000" fill-opacity="0.28"/>`);
    parts.push(path(display, card.num, x, 400, size, WHITE));
    if (card.mon) {
      const mw = display.getAdvanceWidth(card.mon, 64);
      parts.push(path(display, card.mon, W - 72 - mw, 160, 64, STONE));
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;

  const logoPng = await sharp(logo).resize({ width: 260 }).png().toBuffer();
  const logoMeta = await sharp(logoPng).metadata();
  return sharp(Buffer.from(svg))
    .composite([{ input: logoPng, left, top: H - 56 - (logoMeta.height ?? 80) }])
    .png({ compressionLevel: 9 })
    .toBuffer(); // sharp writes no EXIF/XMP unless asked: the privacy check stays happy.
}
