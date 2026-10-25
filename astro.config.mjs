import { defineConfig } from "astro/config";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

const SITE = "https://tritone-productions.com";
const dist = new URL("./dist/", import.meta.url);

// Read a built page, to drop noindex/redirect pages from the sitemap and to take
// show pages' lastmod (the calendar entry's last change) from their <meta name="tritone:lastmod">.
function builtPage(url) {
  const path = new URL(url).pathname.replace(/^\//, "") || "index";
  try {
    return readFileSync(new URL(`${path}.html`, dist), "utf8");
  } catch {
    return "";
  }
}

// The Content-Security-Policy in firebase.json allows scripts from 'self' only (no 'unsafe-inline').
// Astro inlines small <script> bundles, and is:inline / set:html scripts stay inline, so after the
// build every executable inline <script> is moved into /_astro/inline.<hash>.js and referenced by src.
// Same position, same attributes, same semantics (a classic script still blocks; a module still defers).
// Data blocks (application/ld+json, application/json) are not executed and stay inline.
// tests/headers.test.mjs fails if an executable inline script or an on*= handler is left in dist/.
const EXEC_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
function externalizeInlineScripts() {
  return {
    name: "tritone:externalize-inline-scripts",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const outDir = join(root, "_astro");
        mkdirSync(outDir, { recursive: true });
        const written = new Set();
        let moved = 0;
        const walk = (d) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".html")) rewrite(p);
          }
        };
        const rewrite = (file) => {
          const html = readFileSync(file, "utf8");
          const out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs, body) => {
            if (/\bsrc\s*=/i.test(attrs)) return tag;
            const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "").toLowerCase();
            if (!EXEC_TYPES.has(type) || !body.trim()) return tag;
            const code = body.trim() + "\n";
            const name = `inline.${createHash("sha256").update(code).digest("base64url").slice(0, 12)}.js`;
            if (!written.has(name)) {
              writeFileSync(join(outDir, name), code);
              written.add(name);
            }
            moved++;
            return `<script${attrs} src="/_astro/${name}"></script>`;
          });
          if (out !== html) writeFileSync(file, out);
        };
        walk(root);
        logger.info(`moved ${moved} inline scripts into ${written.size} files in /_astro`);
      },
    },
  };
}

export default defineConfig({
  site: SITE,
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [
    externalizeInlineScripts(),
    sitemap({
      filter: (page) => !/\/404$/.test(page),
      serialize(item) {
        const html = builtPage(item.url);
        if (/<meta name="robots" content="noindex/.test(html) || /http-equiv="refresh"/.test(html)) return undefined;
        const lastmod = html.match(/<meta name="tritone:lastmod" content="([^"]+)"/)?.[1];
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
