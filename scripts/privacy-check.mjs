// Fails the build if anything in dist/ could reveal the studio's location.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// Public venues are the only places allowed a street address (Event JSON-LD, show
// pages, .ics). Node 22 strips the types from venues.ts on import.
const { VENUES } = await import("../src/data/venues.ts");
const venueAddr = new Set(VENUES.filter((v) => v.street && v.postalCode).map((v) => `${v.street}|${v.postalCode}`));
const venueZips = new Set(VENUES.map((v) => v.postalCode).filter(Boolean));
if (VENUES.some((v) => /hummingbird/i.test(`${v.name} ${(v.aliases ?? []).join(" ")}`))) {
  console.error("Privacy check FAILED: the Hummingbird Hut must never be in src/data/venues.ts");
  process.exit(1);
}

// Every PostalAddress in JSON-LD must be a listed venue's exact street + ZIP, or have neither.
function checkLd(file, text, problems) {
  const blocks = [...text.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const walk = (o, where) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, where));
    if (!o || typeof o !== "object") return;
    if ("streetAddress" in o || "postalCode" in o) {
      if (!venueAddr.has(`${o.streetAddress}|${o.postalCode}`))
        problems.push(`${file}: JSON-LD address "${o.streetAddress ?? ""} ${o.postalCode ?? ""}" is not a public venue in src/data/venues.ts`);
    }
    if (o.location && /hummingbird/i.test(JSON.stringify(o.location)) && /streetAddress|postalCode/.test(JSON.stringify(o.location)))
      problems.push(`${file}: an address on a Hummingbird Hut location`);
    for (const v of Object.values(o)) walk(v, where);
  };
  for (const b of blocks) {
    try {
      walk(JSON.parse(b));
    } catch {
      problems.push(`${file}: unparseable JSON-LD`);
    }
  }
  return text.replace(/<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, "");
}

const banned = [
  /hummingbirdhut\.(?:synology|dsm|ddns|myds)/i, // NAS DDNS hostname
  /"geo"\s*:/i, // schema geo coordinates
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
  if ([".html", ".js", ".json", ".xml", ".txt", ".css", ".ics"].includes(ext)) {
    let text = readFileSync(file, "utf8");
    if (ext === ".html") text = checkLd(file, text, problems);
    for (const re of banned) if (re.test(text)) problems.push(`${file}: matches ${re}`);
    // streetAddress outside checked JSON-LD, or a California ZIP that is not a listed venue's.
    if (/"streetAddress"/i.test(text)) problems.push(`${file}: streetAddress outside JSON-LD`);
    for (const m of text.matchAll(/\bCA,?\s+(9\d{4})\b/g))
      if (!venueZips.has(m[1])) problems.push(`${file}: postal code ${m[1]} is not a public venue's`);
  } else if ([".jpg", ".jpeg", ".webp", ".png", ".avif"].includes(ext)) {
    if (hasMetadata(ext, readFileSync(file))) problems.push(`${file}: has embedded metadata`);
  }
}
if (problems.length) {
  console.error("Privacy check FAILED:\n" + problems.join("\n"));
  process.exit(1);
}
console.log("Privacy check passed.");
