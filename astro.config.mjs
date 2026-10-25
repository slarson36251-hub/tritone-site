import { defineConfig } from "astro/config";
import { readFileSync } from "node:fs";
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

export default defineConfig({
  site: SITE,
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [
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
