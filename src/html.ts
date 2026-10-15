// ============================================================
// TITAN ENGINE — html.ts : HTML5 tokenizer + tree builder
// Handles entities, void elements, rawtext (script/style),
// auto-closing (p/li/td...), implied html/head/body, quirks.
// ============================================================
import { Document, DocumentTypeNode, Element, Text, Comment, Node } from "./dom.js";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥",
  mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", star: "★",
  check: "✓", cross: "✕", bull: "•", middot: "·", divide: "÷", times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);?/g, (m, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const n = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(n)) { try { return String.fromCodePoint(n); } catch { return m; } }
      return m;
    }
    const v = ENTITIES[body.replace(/;$/, "")];
    return v ?? m;
  });
}

type Tok =
  | { kind: "doctype"; name: string }
  | { kind: "start"; tag: string; attrs: [string, string][]; selfClosing: boolean }
  | { kind: "end"; tag: string }
  | { kind: "comment"; data: string }
  | { kind: "text"; data: string }
  | { kind: "eof" };

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
const RAW = new Set(["script","style","textarea","title"]);
const AUTOCLOSE_P = new Set(["p","div","h1","h2","h3","h4","h5","h6","ul","ol","dl","table","section","article","header","footer","nav","aside","main","figure","blockquote","pre","hr","form","fieldset"]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0; const n = src.length;
  const lower = src.toLowerCase();
  while (i < n) {
    if (src[i] === "<") {
      // comment
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        const data = end === -1 ? src.slice(i + 4) : src.slice(i + 4, end);
        toks.push({ kind: "comment", data });
        i = end === -1 ? n : end + 3;
        continue;
      }
      // doctype
      if (/^<!doctype/i.test(src.slice(i, i + 9))) {
        const end = src.indexOf(">", i);
        const chunk = end === -1 ? src.slice(i) : src.slice(i, end + 1);
        const m = /<!doctype\s+([^\s>]+)/i.exec(chunk);
        toks.push({ kind: "doctype", name: (m?.[1] ?? "html").toLowerCase() });
        i = end === -1 ? n : end + 1;
        continue;
      }
      // bogus <!...> skip
      if (src[i + 1] === "!") { const end = src.indexOf(">", i); i = end === -1 ? n : end + 1; continue; }
      // <?...?> skip
      if (src[i + 1] === "?") { const end = src.indexOf("?>", i); i = end === -1 ? n : end + 2; continue; }
      // end tag
      if (src[i + 1] === "/") {
        const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(src.slice(i));
        if (m) { toks.push({ kind: "end", tag: m[1].toLowerCase() }); i += m[0].length; continue; }
        const end = src.indexOf(">", i);
        i = end === -1 ? n : end + 1; continue;
      }
      // start tag
      const sm = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(src.slice(i));
      if (sm) {
        const tag = sm[1].toLowerCase();
        const attrStr = sm[2] ?? "";
        const selfClosing = sm[3] === "/" || VOID.has(tag);
        const attrs: [string, string][] = [];
        const re = /([^\s<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let am: RegExpExecArray | null;
        while ((am = re.exec(attrStr))) {
          const name = am[1].toLowerCase();
          const val = am[2] ?? am[3] ?? am[4] ?? "";
          attrs.push([name, decodeEntities(val)]);
        }
        toks.push({ kind: "start", tag, attrs, selfClosing });
        i += sm[0].length;
        // rawtext: consume until matching end tag verbatim
        if (RAW.has(tag) && !selfClosing) {
          const closeTag = `</${tag}`;
          const idx = lower.indexOf(closeTag, i);
          let rawEnd = idx === -1 ? n : idx;
          // find '>' of close
          if (idx !== -1) {
            // raw text is everything before idx
            const raw = src.slice(i, idx);
            if (raw) toks.push({ kind: "text", data: tag === "script" || tag === "style" ? raw : decodeEntities(raw) });
            i = idx; // let end-tag branch handle it
            continue;
          } else {
            const raw = src.slice(i);
            if (raw) toks.push({ kind: "text", data: raw });
            i = n; continue;
          }
        }
        continue;
      }
      // lone '<' => text
      toks.push({ kind: "text", data: "<" }); i++;
      continue;
    }
    // text node until next '<'
    const next = src.indexOf("<", i);
    const chunk = next === -1 ? src.slice(i) : src.slice(i, next);
    toks.push({ kind: "text", data: decodeEntities(chunk) });
    i = next === -1 ? n : next;
  }
  toks.push({ kind: "eof" });
  return toks;
}

const TABLE_SECTIONS = new Set(["thead","tbody","tfoot","tr","td","th","caption","colgroup"]);

export function parseHTML(src: string, url = "about:blank"): Document {
  const doc = new Document();
  doc.URL = url;
  const toks = tokenize(src);
  const stack: Element[] = [];
  let quirks = true;

  const currentParent = (): Node => (stack.length ? stack[stack.length - 1] : doc);

  const ensureHtmlSkeleton = (want: "html" | "head" | "body"): Element => {
    let html = doc.documentElement;
    if (!html) {
      html = doc.createElement("html");
      doc.appendChild(html); doc.documentElement = html;
    }
    if (want === "html") return html;
    let head = html.childNodes.find((c): c is Element => c instanceof Element && c.tagName === "head") as Element | undefined;
    let body = html.childNodes.find((c): c is Element => c instanceof Element && c.tagName === "body") as Element | undefined;
    if (want === "head") {
      if (!head) { head = doc.createElement("head"); html.insertBefore(head, body ?? null); doc.head = head; }
      return head;
    }
    if (!body) { body = doc.createElement("body"); html.appendChild(body); doc.body = body; }
    return body;
  };

  const insertElement = (tag: string, attrs: [string, string][]): Element => {
    // implied structure
    if (!doc.documentElement && tag !== "html") {
      const html = doc.createElement("html");
      doc.appendChild(html); doc.documentElement = html;
      stack.push(html);
    }
    // content that belongs in head/body
    if (stack.length === 0 && (tag === "head" || tag === "body" || !["html"].includes(tag))) {
      // push html if needed done above
    }
    // auto-close <p> when block starts
    const top = stack[stack.length - 1];
    if (top && top.tagName === "p" && AUTOCLOSE_P.has(tag)) {
      stack.pop();
    }
    // li auto-close
    if (tag === "li" && top && top.tagName === "li") stack.pop();
    // td/th/tr auto-close
    if ((tag === "td" || tag === "th") && top && (top.tagName === "td" || top.tagName === "th")) stack.pop();
    if (tag === "tr" && top && top.tagName === "tr") stack.pop();

    // foster-parent table text: if in table but tag not table-ish and no table ancestor handling — simplify: allow anyway
    const el = doc.createElement(tag);
    for (const [k, v] of attrs) el.setAttribute(k, v);
    // place head-ish elements into head
    if ((tag === "title" || tag === "meta" || tag === "link" || tag === "style" || tag === "base") && doc.documentElement && stack.length === 1 && stack[0].tagName === "html") {
      ensureHtmlSkeleton("head").appendChild(el);
    } else {
      currentParent().appendChild(el);
    }
    // title text sync
    return el;
  };

  for (const t of toks) {
    if (t.kind === "doctype") {
      const dt = new DocumentTypeNode(t.name);
      dt.ownerDocument = doc;
      doc.appendChild(dt);
      if (t.name === "html") quirks = false;
      continue;
    }
    if (t.kind === "comment") {
      const c = doc.createComment(t.data);
      currentParent().appendChild(c);
      continue;
    }
    if (t.kind === "text") {
      // drop pure whitespace between table sections? keep but collapse later
      if (t.data === "") continue;
      // ignore whitespace-only text directly under table (foster parenting lite)
      const top = stack[stack.length - 1];
      if (top && ["table","thead","tbody","tfoot","tr"].includes(top.tagName) && /^\s*$/.test(t.data)) continue;
      const tx = doc.createTextNode(t.data);
      if (stack.length === 0) {
        if (/^\s*$/.test(t.data)) continue;
        ensureHtmlSkeleton("body").appendChild(tx);
      } else currentParent().appendChild(tx);
      continue;
    }
    if (t.kind === "start") {
      if (t.tag === "html") {
        let html = doc.documentElement;
        if (!html) { html = insertElement("html", t.attrs); doc.documentElement = html; stack.push(html); }
        else { for (const [k, v] of t.attrs) if (!html.hasAttribute(k)) html.setAttribute(k, v); if (!stack.includes(html)) stack.push(html); }
        continue;
      }
      if (t.tag === "head" || t.tag === "body") {
        // merge attrs, ensure element, push
        const skel = ensureHtmlSkeleton(t.tag);
        for (const [k, v] of t.attrs) if (!skel.hasAttribute(k)) skel.setAttribute(k, v);
        // pop anything above html
        while (stack.length > 1) stack.pop();
        if (!stack.includes(skel)) stack.push(skel);
        doc._refreshRefs();
        continue;
      }
      const el = insertElement(t.tag, t.attrs);
      if (!t.selfClosing && !VOID.has(t.tag)) stack.push(el);
      doc._refreshRefs();
      continue;
    }
    if (t.kind === "end") {
      const tag = t.tag;
      if (tag === "html" || tag === "head" || tag === "body") {
        const idx = stack.findIndex(e => e.tagName === tag);
        if (idx !== -1) stack.length = idx; // pop tag and above? keep parent
        // ensure refs
        doc._refreshRefs();
        continue;
      }
      // find in stack
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tagName === tag) { idx = k; break; }
      if (idx === -1) continue; // stray end tag — ignore (error recovery)
      stack.length = idx; // pop tag and anything opened inside
      continue;
    }
  }
  // finalize implied head/body
  if (!doc.documentElement) {
    const html = doc.createElement("html");
    doc.appendChild(html);
  }
  ensureHtmlSkeleton("head");
  ensureHtmlSkeleton("body");
  doc._refreshRefs();
  // sync title (matcher-free: getElementsByTagName works without selectors)
  const titleEls = doc.getElementsByTagName("title");
  if (titleEls.length) doc.title = (titleEls[0].textContent ?? "").trim();
  (doc as unknown as { _quirks?: boolean })._quirks = quirks;
  return doc;
}

export function serialize(doc: Document): string { return "<!DOCTYPE html>\n" + doc.toHTML(); }
