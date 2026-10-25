// The Organization logo for Google (JSON-LD "logo"): the black Tritone wordmark, metadata stripped.
import type { APIRoute } from "astro";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const GET: APIRoute = async () => {
  const png = await sharp(await readFile(join(process.cwd(), "src/assets/logo/tritone-wordmark-black.png")))
    .resize({ width: 1200 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
