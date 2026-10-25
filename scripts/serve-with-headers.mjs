// Serves dist/ the way Firebase Hosting does for this site: the "headers", "redirects",
// cleanUrls and trailingSlash settings from firebase.json, and 404.html for anything missing.
// Used by scripts/check-csp.mjs to test the Content-Security-Policy locally before a deploy.
//   node scripts/serve-with-headers.mjs [port]        (default 4322)
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hosting = JSON.parse(readFileSync(join(ROOT, "firebase.json"), "utf8")).hosting;
const PUBLIC = join(ROOT, hosting.public);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
};

// Firebase "source" globs: ** spans directories, * stays inside one segment.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${glob.startsWith("/") || glob.startsWith("**") ? "" : "/"}${re}$`);
}

export function headersFor(path) {
  const out = {};
  for (const rule of hosting.headers ?? []) {
    if (globToRegExp(rule.source).test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function resolve(path) {
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  const base = join(PUBLIC, safe);
  if (!base.startsWith(PUBLIC)) return null;
  if (isFile(base)) return base;
  if (hosting.cleanUrls && isFile(base + ".html")) return base + ".html";
  if (isFile(join(base, "index.html"))) return join(base, "index.html");
  return null;
}

export function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname;
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(req.method === "HEAD" ? undefined : body); };

  for (const r of hosting.redirects ?? []) {
    if (globToRegExp(r.source).test(path)) return send(r.type ?? 301, { Location: r.destination, ...headersFor(path) });
  }
  if (hosting.trailingSlash === false && path.length > 1 && path.endsWith("/"))
    return send(301, { Location: path.slice(0, -1) + url.search });
  if (hosting.cleanUrls && path.endsWith(".html"))
    return send(301, { Location: path.replace(/(index)?\.html$/, "") + url.search || "/" });

  let file = resolve(path);
  let status = 200;
  if (!file) { file = join(PUBLIC, "404.html"); status = 404; }
  send(status, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", ...headersFor(path) }, readFileSync(file));
}

export function serve(port = 4322) {
  return new Promise((ok) => {
    const server = createServer(handler).listen(port, "127.0.0.1", () => ok(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4322);
  await serve(port);
  console.log(`dist/ with firebase.json headers on http://127.0.0.1:${port}`);
}
