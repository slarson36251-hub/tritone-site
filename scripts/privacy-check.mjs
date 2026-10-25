// Fails the build if anything in dist/ could reveal the studio's location.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const banned = [
  /hummingbirdhut\.(?:synology|dsm|ddns|myds)/i, // NAS DDNS hostname
  /"geo"\s*:/i, // schema geo coordinates
  /"streetAddress"/i,
  /maps\.google|google\.com\/maps|maps\.apple|openstreetmap/i,
  /-?\b3[78]\.\d{4,},\s*-?12[12]\.\d{4,}/, // Bay Area lat,long pairs
];
// JPEG: walk header segments up to the image data and flag APP1 (EXIF/XMP) or APP13 (IPTC).
function jpegHasMetadata(buf) {
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) return false; // start of scan: no more headers
    if (marker === 0xe1 || marker === 0xed) return true;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return false;
}
// PNG eXIf/iTXt chunks, WebP EXIF/XMP chunks.
const chunkMarkers = [Buffer.from("eXIf"), Buffer.from("iTXtXML"), Buffer.from("EXIF"), Buffer.from("XMP ")];
const hasMetadata = (ext, buf) =>
  [".jpg", ".jpeg"].includes(ext) ? jpegHasMetadata(buf) : chunkMarkers.some((m) => buf.subarray(0, 4096).includes(m));

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const problems = [];
for (const file of walk("dist")) {
  const ext = extname(file).toLowerCase();
  if ([".html", ".js", ".json", ".xml", ".txt", ".css"].includes(ext)) {
    const text = readFileSync(file, "utf8");
    for (const re of banned) if (re.test(text)) problems.push(`${file}: matches ${re}`);
  } else if ([".jpg", ".jpeg", ".webp", ".png", ".avif"].includes(ext)) {
    if (hasMetadata(ext, readFileSync(file))) problems.push(`${file}: has embedded metadata`);
  }
}
if (problems.length) {
  console.error("Privacy check FAILED:\n" + problems.join("\n"));
  process.exit(1);
}
console.log("Privacy check passed.");
