// QR encoder for the dashboard's flyer links (src/lib/admin/qr.ts): byte mode, error correction M.
// 1. A known vector: the matrix for the site URL, as produced by the reference encoder node-qrcode
//    (errorCorrectionLevel "M", same mask). 2. An independent mini decoder below reads the format
//    bits and the data codewords back out of the matrix and recovers the text.
import { test } from "node:test";
import assert from "node:assert/strict";

const { encodeQr, formatBits, qrSvg } = await import("../src/lib/admin/qr.ts");

const SITE_V3_MASK0 = [
  "11111110010010100001001111111", "10000010101111000111101000001", "10111010011000010011101011101", "10111010011111001011001011101",
  "10111010100011001111001011101", "10000010011110111101101000001", "11111110101010101010101111111", "00000000000100010111100000000",
  "10101010011110001100000010010", "00011001001111011000111001001", "00010010010000111100110010111", "01111001010111101111101000010",
  "01111110001110110100111101011", "01011100110010110000111001001", "11100011111111000100010111011", "00110101101100010100111111010",
  "01100110000100001101111001011", "01101100001001011110111001101", "10110111011110111110111000011", "01010001100101101110000101010",
  "10101111001000111110111110000", "00000000110010110000100010111", "11111110010011000101101011011", "10000010010110011100100011001",
  "10111010111110011100111110010", "10111010010000001101010010100", "10111010110101000110100111001", "10000010001101101110101100010",
  "11111110101011111101111111011",
];

test("matches the reference encoder for the site URL (version 3-M, mask 0)", () => {
  const qr = encodeQr("https://tritone-productions.com");
  assert.equal(qr.version, 3);
  assert.equal(qr.mask, 0);
  assert.deepEqual(qr.modules.map((r) => r.map((c) => (c ? 1 : 0)).join("")), SITE_V3_MASK0);
});

// ---- a small, independent decoder for single-block versions (1-3 at level M) ----
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22] };
function isFunction(ver, size, x, y) {
  if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true; // finders, separators, format
  if (x === 6 || y === 6) return true; // timing
  const a = ALIGN[ver];
  for (const ax of a) for (const ay of a) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === a.at(-1)) || (ax === a.at(-1) && ay === 6)) continue;
    if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
  }
  return false;
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function decode(m) {
  const size = m.length, ver = (size - 17) / 4;
  // format bits around the top-left finder (bits 0..14), unmask, check level M and the BCH code
  const cells = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let fmt = 0;
  cells.forEach(([x, y], i) => { if (m[y][x]) fmt |= 1 << i; });
  const raw = fmt ^ 0x5412;
  const ecl = raw >> 13, mask = (raw >> 10) & 7;
  let rem = raw >> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  assert.equal(((raw >> 10) << 10) | (rem & 0x3ff), raw, "format BCH");
  assert.equal(ecl, 0, "error correction level M");
  // zigzag read, unmasking data modules
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!isFunction(ver, size, x, y)) bits.push(m[y][x] !== MASKS[mask](x, y) ? 1 : 0);
    }
  }
  const read = (pos, n) => bits.slice(pos, pos + n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(read(0, 4), 4, "byte mode");
  const len = read(4, 8);
  const bytes = Array.from({ length: len }, (_, i) => read(12 + i * 8, 8));
  return { mask, text: new TextDecoder().decode(new Uint8Array(bytes)) };
}

test("decodes back to the original text (format bits + data, versions 1-3)", () => {
  for (const text of ["HELLO", "https://tritone-productions.com", "tritone-productions.com/book-the-hut", "Oakland, CA ♪"]) {
    const qr = encodeQr(text);
    assert.ok(qr.version <= 3, `${text} fits a single-block version`);
    const out = decode(qr.modules);
    assert.equal(out.mask, qr.mask);
    assert.equal(out.text, text);
  }
});

test("every forced mask still decodes; format bits are right for level M", () => {
  assert.equal(formatBits(0), 0b101010000010010); // standard table value for M, mask 0
  for (let mask = 0; mask < 8; mask++) assert.equal(decode(encodeQr("https://tritone-productions.com/shows", mask).modules).text, "https://tritone-productions.com/shows");
});

test("long URLs pick bigger versions; SVG has a quiet zone and one path", () => {
  const qr = encodeQr("https://tritone-productions.com/shows/franco-nero-the-deluxe-san-francisco-2026-11-08?utm_source=instagram&utm_medium=social&utm_campaign=the-deluxe&utm_content=story");
  assert.ok(qr.version >= 7 && qr.version <= 10, `version ${qr.version}`);
  assert.equal(qr.size, qr.version * 4 + 17);
  const svg = qrSvg(qr, { title: "a <b>" });
  assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`));
  assert.equal(svg.match(/<path /g).length, 1);
  assert.match(svg, /<title>a &lt;b&gt;<\/title>/);
  assert.throws(() => encodeQr("x".repeat(3000)));
});
