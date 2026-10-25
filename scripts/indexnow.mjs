// Tell Bing, Yandex, Seznam and the other IndexNow engines (which also feed Copilot and ChatGPT search)
// that every page in the built sitemap is fresh. Run after a live deploy:  node scripts/indexnow.mjs
// The key is public by design: it's served at /<key>.txt to prove we own the host.
import { readFileSync, readdirSync } from "node:fs";

const HOST = "tritone-productions.com";
const keyFile = readdirSync("public").find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error("no IndexNow key file in public/");
const key = keyFile.slice(0, -4);

const urls = readdirSync("dist")
  .filter((f) => /^sitemap-\d+\.xml$/.test(f))
  .flatMap((f) => [...readFileSync(`dist/${f}`, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
if (!urls.length) throw new Error("no URLs in dist/sitemap-*.xml; build first");

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${keyFile}`, urlList: urls }),
});
console.log(`IndexNow: ${urls.length} URLs → HTTP ${res.status}`);
// 200/202 = accepted. Anything else is logged, not fatal: the deploy already succeeded.
if (res.status >= 300) console.log(await res.text());
