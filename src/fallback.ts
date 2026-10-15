// ============================================================
// TITAN ENGINE — fallback.ts : reader-mode summary for JS-shell
// pages. Sites like YouTube ship an almost-empty static DOM and
// build all content at runtime via JS. When a render produces
// almost no visible output, this extracts embedded data
// (meta tags, headings, links, YouTube's player JSON) into a
// readable summary panel so the tab isn't a blank page.
// ============================================================
import { Document, Element } from "./dom.js";

function metaContent(doc: Document, names: string[]): string {
  const metas = doc.getElementsByTagName("meta");
  for (const want of names) {
    for (const m of metas) {
      const n = (m.getAttribute("name") || m.getAttribute("property") || "").toLowerCase();
      if (n === want) return m.getAttribute("content") || "";
    }
  }
  return "";
}

/** find `key = {...}` in script text and parse the balanced object. */
function extractJsonObject(text: string, key: string): Record<string, unknown> | null {
  const idx = text.indexOf(key);
  if (idx === -1) return null;
  const start = text.indexOf("{", idx + key.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, quote = "";
  const end = Math.min(text.length, start + 3_000_000);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>; }
        catch { return null; }
      }
    }
  }
  return null;
}

interface YTDetails { title: string; author: string; views: string; desc: string; thumb: string }

function youTubeDetails(doc: Document): YTDetails | null {
  for (const s of doc.getElementsByTagName("script")) {
    const code = s.textContent || "";
    if (!code.includes("ytInitialPlayerResponse")) continue;
    const player = extractJsonObject(code, "ytInitialPlayerResponse");
    const vd = (player?.["videoDetails"] ?? null) as Record<string, unknown> | null;
    if (!vd) continue;
    const thumbs = ((vd["thumbnail"] ?? {}) as Record<string, unknown>)["thumbnails"];
    const list = Array.isArray(thumbs) ? (thumbs as Record<string, unknown>[]) : [];
    const biggest = list[list.length - 1] || {};
    return {
      title: String(vd["title"] || ""),
      author: String(vd["author"] || ""),
      views: String(vd["viewCount"] || ""),
      desc: String(vd["shortDescription"] || "").slice(0, 900),
      thumb: String(biggest["url"] || ""),
    };
  }
  return null;
}

function el(doc: Document, tag: string, style: string, text?: string): Element {
  const e = doc.createElement(tag);
  e.setAttribute("style", style);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Injects a summary panel at the top of <body>. Returns true if injected. */
export function injectReaderFallback(doc: Document): boolean {
  const body = doc.body;
  if (!body || doc.getElementById("titan-reader-fallback")) return false;

  const BASE = "font-family:system-ui,sans-serif;color:#16181d;";
  const wrap = el(doc, "div",
    `display:block;${BASE}background:#ffffff;border:1px solid #d8dbe0;border-radius:12px;` +
    `padding:28px 32px;max-width:840px;margin:24px auto;`);
  wrap.setAttribute("id", "titan-reader-fallback");

  wrap.appendChild(el(doc, "p",
    `display:block;${BASE}font-size:12px;color:#6b7280;margin:0 0 12px;`,
    "Titan Reader — this page builds its content with JavaScript, so here is the extracted summary:"));

  const yt = youTubeDetails(doc);
  const title = yt?.title || doc.title || doc.URL;
  wrap.appendChild(el(doc, "h1",
    `display:block;${BASE}font-size:24px;margin:0 0 8px;`, title));

  if (yt) {
    const bits = [yt.author && `by ${yt.author}`, yt.views && `${Number(yt.views).toLocaleString("en-US")} views`]
      .filter(Boolean).join(" · ");
    if (bits) wrap.appendChild(el(doc, "p", `display:block;${BASE}font-size:14px;color:#374151;`, bits));
    if (yt.thumb) {
      const img = doc.createElement("img");
      img.setAttribute("src", yt.thumb);
      img.setAttribute("width", "480");
      img.setAttribute("style", "display:block;border-radius:8px;margin:12px 0;");
      wrap.appendChild(img);
    }
    if (yt.desc) wrap.appendChild(el(doc, "p", `display:block;${BASE}font-size:14px;white-space:pre-wrap;`, yt.desc));
  }

  if (!yt) {
    const desc = metaContent(doc, ["description", "og:description", "twitter:description"]);
    if (desc) wrap.appendChild(el(doc, "p", `display:block;${BASE}font-size:14px;`, desc.slice(0, 600)));
    for (const h of [...doc.getElementsByTagName("h1"), ...doc.getElementsByTagName("h2")].slice(0, 6)) {
      const t = (h.textContent || "").trim().slice(0, 140);
      if (t) wrap.appendChild(el(doc, "h3", `display:block;${BASE}font-size:17px;margin:14px 0 4px;`, t));
    }
  }

  // link list — keeps shell pages navigable
  const links: { text: string; href: string }[] = [];
  for (const a of doc.getElementsByTagName("a")) {
    if (links.length >= 25) break;
    if (a.closest("#titan-reader-fallback")) continue;
    const href = a.getAttribute("href");
    const text = (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
    if (!href || !text) continue;
    if (/^(javascript:|#)/.test(href)) continue;
    links.push({ text, href });
  }
  if (links.length) {
    wrap.appendChild(el(doc, "h3", `display:block;${BASE}font-size:15px;margin:16px 0 6px;`, "Links on this page"));
    for (const l of links) {
      const p = el(doc, "p", `display:block;${BASE}font-size:13px;margin:3px 0;`);
      const a = doc.createElement("a");
      a.setAttribute("href", l.href);
      a.setAttribute("style", "color:#1a5fb4;");
      a.textContent = l.text;
      p.appendChild(a);
      wrap.appendChild(p);
    }
  }

  body.insertBefore(wrap, body.firstChild);
  return true;
}
