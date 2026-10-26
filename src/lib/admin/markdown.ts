// A small, safe Markdown renderer for the weekly digest (scripts/analytics-digest.mjs writes it).
// Understands headings, paragraphs, bullet / numbered lists, pipe tables (with ---: alignment),
// **bold**, _italic_ / *italic*, `code` and [text](https://...) links. Everything is HTML-escaped
// first and raw HTML never passes through; links only keep http(s) hrefs.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Inline Markdown on already-escaped text. */
export function inline(text: string): string {
  // Code spans first, parked behind placeholders so nothing inside them (visitor-supplied strings
  // such as referrers or track names) is ever read as bold, italic or a link.
  const codes: string[] = [];
  let s = escape(text.replace(/\u0000/g, ""));
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, href) => `<a href="${href.replace(/"/g, "&quot;")}" rel="noopener" target="_blank">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "");
}

const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** Block Markdown -> HTML. Unknown constructs render as plain paragraphs. */
export function renderMarkdown(md: string): string {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); const lvl = Math.min(4, h[1].length + 1); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const td = (c: string, j: number, tag: "th" | "td") => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, j) => td(c, j, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td(r[j] ?? "", j, "td")).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); const q: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${renderMarkdown(q.join("\n"))}</blockquote>`); continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("\n");
}
