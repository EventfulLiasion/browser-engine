// ============================================================
// TITAN ENGINE — css.ts : CSS tokenizer/parser, selector engine,
// specificity, cascade, inheritance, variables, media queries.
// ============================================================
import { Document, Element } from "./dom.js";

// ---------- CSS AST ----------
export interface Declaration { prop: string; value: string; important: boolean; }
export type SelectorCombinator = "descendant" | "child" | "adjacent" | "sibling";
export interface CompoundSelector {
  tag: string | null;           // null = no constraint, "*" = universal
  id: string | null;
  classes: string[];
  attrs: { name: string; op: string | null; value: string | null }[];
  pseudos: { name: string; arg: string | null }[];
}
export interface ComplexSelector {
  compounds: CompoundSelector[];       // left -> right
  combinators: SelectorCombinator[];   // len = compounds-1
  specificity: [number, number, number];
  raw: string;
}
export type Rule =
  | { kind: "style"; selectors: ComplexSelector[]; declarations: Declaration[]; order: number; media: string | null }
  | { kind: "media"; query: string; rules: Rule[] }
  | { kind: "font-face"; declarations: Declaration[] }
  | { kind: "keyframes"; name: string; frames: { key: string; declarations: Declaration[] }[] };
export interface Stylesheet { rules: Rule[]; }

// ---------- tokenizer helpers ----------
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Split declarations respecting parens/quotes
function splitDeclarations(body: string): Declaration[] {
  const out: Declaration[] = [];
  let cur = "", depth = 0, q: string | null = null;
  const flush = () => {
    const line = cur.trim();
    cur = "";
    if (!line) return;
    const ci = line.indexOf(":");
    if (ci === -1) return;
    let prop = line.slice(0, ci).trim().toLowerCase();
    let value = line.slice(ci + 1).trim();
    let important = false;
    if (/!important\s*$/i.test(value)) { important = true; value = value.replace(/!important\s*$/i, "").trim(); }
    if (prop) out.push({ prop, value, important });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === q && body[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

// ---------- selector parser ----------
function parseCompound(src: string): CompoundSelector {
  const c: CompoundSelector = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = 0;
  // tag or universal at start
  const tm = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)/.exec(src);
  if (tm) { c.tag = tm[1].toLowerCase(); i = tm[0].length; }
  while (i < src.length) {
    const ch = src[i];
    if (ch === "#") {
      const m = /^#([\w-]+)/.exec(src.slice(i));
      if (m) { c.id = m[1]; i += m[0].length; continue; }
      i++; continue;
    }
    if (ch === ".") {
      const m = /^\.([\w-]+)/.exec(src.slice(i));
      if (m) { c.classes.push(m[1]); i += m[0].length; continue; }
      i++; continue;
    }
    if (ch === "[") {
      const end = src.indexOf("]", i);
      const inner = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
      const m = /^\s*([\w-]+)(?:\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s'"]+)))?\s*$/.exec(inner);
      if (m) c.attrs.push({ name: m[1].toLowerCase(), op: m[2] ?? null, value: m[3] ?? m[4] ?? m[5] ?? null });
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === ":") {
      const m = /^::?([\w-]+)(?:\(([^)]*)\))?/.exec(src.slice(i));
      if (m) {
        const name = m[1].toLowerCase();
        // pseudo-elements don't affect matching host (except specificity); keep but ignore at match
        c.pseudos.push({ name, arg: m[2] ?? null });
        i += m[0].length; continue;
      }
      i++; continue;
    }
    i++;
  }
  return c;
}

function specificityOf(compounds: CompoundSelector[]): [number, number, number] {
  let a = 0, b = 0, cc = 0;
  for (const c of compounds) {
    if (c.id) a++;
    b += c.classes.length + c.attrs.length;
    for (const p of c.pseudos) {
      if (["before", "after", "first-line", "first-letter", "selection", "marker"].includes(p.name)) cc++;
      else b++; // pseudo-class counts as class
    }
    if (c.tag && c.tag !== "*") cc++;
  }
  return [a, b, cc];
}

export function parseSelector(raw: string): ComplexSelector | null {
  raw = raw.trim();
  if (!raw) return null;
  // tokenize by combinators, respecting brackets/parens
  const parts: string[] = [];
  const combs: SelectorCombinator[] = [];
  let cur = "", depthB = 0, depthP = 0, q: string | null = null;
  const pushCur = () => { if (cur.trim()) parts.push(cur.trim()); cur = ""; };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[") depthB++;
    if (ch === "]") depthB = Math.max(0, depthB - 1);
    if (ch === "(") depthP++;
    if (ch === ")") depthP = Math.max(0, depthP - 1);
    if (depthB === 0 && depthP === 0) {
      if (ch === ">") { pushCur(); combs.push("child"); continue; }
      if (ch === "+") { pushCur(); combs.push("adjacent"); continue; }
      if (ch === "~") { pushCur(); combs.push("sibling"); continue; }
      if (/\s/.test(ch)) {
        // collapse whitespace to descendant combinator
        pushCur();
        // avoid duplicate combinators
        while (i + 1 < raw.length && /\s/.test(raw[i + 1])) i++;
        // peek: if next is explicit combinator, don't add descendant
        const nxt = raw.slice(i + 1).trim()[0];
        if (nxt === ">" || nxt === "+" || nxt === "~") continue;
        if (parts.length > combs.length) combs.push("descendant");
        continue;
      }
    }
    cur += ch;
  }
  pushCur();
  if (parts.length === 0) return null;
  while (combs.length < parts.length - 1) combs.push("descendant");
  const compounds = parts.map(parseCompound);
  return { compounds, combinators: combs.slice(0, parts.length - 1), specificity: specificityOf(compounds), raw };
}

export function parseSelectorList(selText: string): ComplexSelector[] {
  // split on top-level commas
  const groups: string[] = [];
  let cur = "", dB = 0, dP = 0, q: string | null = null;
  for (let i = 0; i < selText.length; i++) {
    const ch = selText[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[") dB++; if (ch === "]") dB = Math.max(0, dB - 1);
    if (ch === "(") dP++; if (ch === ")") dP = Math.max(0, dP - 1);
    if (ch === "," && dB === 0 && dP === 0) { groups.push(cur); cur = ""; continue; }
    cur += ch;
  }
  groups.push(cur);
  const out: ComplexSelector[] = [];
  for (const g of groups) { const s = parseSelector(g); if (s) out.push(s); }
  return out;
}

// ---------- stylesheet parser ----------
let RULE_ORDER = 0;

export function parseStylesheet(src: string): Stylesheet {
  src = stripComments(src);
  RULE_ORDER = 0;
  const rules: Rule[] = [];
  parseBlock(src, null, rules);
  return { rules };
}

function parseBlock(src: string, media: string | null, out: Rule[]): void {
  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const readBalanced = (openIdx: number): [string, number] => {
    // openIdx points at '{', return [inside, idxAfterClosing]
    let depth = 0, q: string | null = null, j = openIdx;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === q && src[j - 1] !== "\\") q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "{") depth++;
      if (c === "}") { depth--; if (depth === 0) return [src.slice(openIdx + 1, j), j + 1]; }
    }
    return [src.slice(openIdx + 1), src.length];
  };
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    if (src[i] === "}") { i++; continue; }
    if (src.startsWith("@", i)) {
      const hm = /^@([\w-]+)\s*/.exec(src.slice(i));
      if (!hm) { i++; continue; }
      const at = hm[1].toLowerCase();
      i += hm[0].length;
      if (at === "media") {
        const b = src.indexOf("{", i);
        if (b === -1) break;
        const query = src.slice(i, b).trim();
        const [inside, next] = readBalanced(b);
        const inner: Rule[] = [];
        parseBlock(inside, query, inner);
        // flatten with media attached, wrapped as media node too
        out.push({ kind: "media", query, rules: inner });
        for (const r of inner) {
          if (r.kind === "style") out.push({ ...r, media: query });
        }
        i = next; continue;
      }
      if (at === "font-face") {
        const b = src.indexOf("{", i);
        if (b === -1) break;
        const [inside, next] = readBalanced(b);
        out.push({ kind: "font-face", declarations: splitDeclarations(inside) });
        i = next; continue;
      }
      if (at === "keyframes" || at === "-webkit-keyframes") {
        const nm = /^([\w-]+)/.exec(src.slice(i));
        const name = nm?.[1] ?? "anim";
        i += nm?.[0].length ?? 0;
        const b = src.indexOf("{", i);
        if (b === -1) break;
        const [inside, next] = readBalanced(b);
        // parse frames: "from {..} to{..} 50%{..}"
        const frames: { key: string; declarations: Declaration[] }[] = [];
        const fre = /(\d+%|from|to)\s*\{([^}]*)\}/g;
        let fm: RegExpExecArray | null;
        while ((fm = fre.exec(inside))) frames.push({ key: fm[1], declarations: splitDeclarations(fm[2]) });
        out.push({ kind: "keyframes", name, frames });
        i = next; continue;
      }
      // skip other at-rules (@import, @charset, @supports...)
      const semi = src.indexOf(";", i);
      const brace = src.indexOf("{", i);
      if (brace !== -1 && (semi === -1 || brace < semi)) {
        const [, next] = readBalanced(brace);
        i = next;
      } else if (semi !== -1) i = semi + 1;
      else break;
      continue;
    }
    // style rule: selector { decls }
    const b = src.indexOf("{", i);
    if (b === -1) break;
    const selText = src.slice(i, b).trim();
    const [inside, next] = readBalanced(b);
    i = next;
    if (!selText) continue;
    const selectors = parseSelectorList(selText);
    if (!selectors.length) continue;
    out.push({ kind: "style", selectors, declarations: splitDeclarations(inside), order: RULE_ORDER++, media });
  }
}

export function parseInlineStyle(style: string): Declaration[] {
  return splitDeclarations(style);
}

// ---------- matching ----------
export interface MatchContext {
  hoverElement: Element | null;
  focusElement: Element | null;
  activeElement: Element | null;
  viewportWidth: number;
  viewportHeight: number;
}

export function matchCompound(el: Element, c: CompoundSelector, ctx: MatchContext | null): boolean {
  if (c.tag && c.tag !== "*" && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op && a.value !== null) {
      const val = a.value;
      switch (a.op) {
        case "=": if (v !== val) return false; break;
        case "~=": if (!v.split(/\s+/).includes(val)) return false; break;
        case "|=": if (!(v === val || v.startsWith(val + "-"))) return false; break;
        case "^=": if (!v.startsWith(val)) return false; break;
        case "$=": if (!v.endsWith(val)) return false; break;
        case "*=": if (!v.includes(val)) return false; break;
      }
    }
  }
  for (const p of c.pseudos) {
    if (!matchPseudo(el, p.name, p.arg, ctx)) return false;
  }
  return true;
}

function matchPseudo(el: Element, name: string, arg: string | null, ctx: MatchContext | null): boolean {
  switch (name) {
    case "before": case "after": case "first-line": case "first-letter":
    case "selection": case "marker": case "placeholder": return true; // host matches
    case "root": return el.tagName === "html";
    case "empty": return el.childNodes.length === 0;
    case "first-child": {
      const p = el.parentNode;
      if (!p) return false;
      const kids = p.childNodes.filter(n => n instanceof Element);
      return kids[0] === el;
    }
    case "last-child": {
      const p = el.parentNode;
      if (!p) return false;
      const kids = p.childNodes.filter(n => (n as Element) instanceof Element);
      return kids[kids.length - 1] === el;
    }
    case "only-child": {
      const p = el.parentNode;
      if (!p) return false;
      return p.childNodes.filter(n => n instanceof Element).length === 1;
    }
    case "nth-child": {
      const p = el.parentNode;
      if (!p) return false;
      const kids = p.childNodes.filter(n => n instanceof Element);
      const idx = kids.indexOf(el) + 1;
      return nthMatch(arg ?? "", idx);
    }
    case "nth-last-child": {
      const p = el.parentNode;
      if (!p) return false;
      const kids = p.childNodes.filter(n => n instanceof Element);
      const idx = kids.length - kids.indexOf(el);
      return nthMatch(arg ?? "", idx);
    }
    case "first-of-type": {
      const p = el.parentNode; if (!p) return true;
      const sibs = p.childNodes.filter(n => n instanceof Element && (n as Element).tagName === el.tagName);
      return sibs[0] === el;
    }
    case "last-of-type": {
      const p = el.parentNode; if (!p) return true;
      const sibs = p.childNodes.filter(n => n instanceof Element && (n as Element).tagName === el.tagName);
      return sibs[sibs.length - 1] === el;
    }
    case "hover": return ctx?.hoverElement === el;
    case "focus": return ctx?.focusElement === el || el._focus;
    case "active": return ctx?.activeElement === el || el._active;
    case "checked": return (el as Element).checked || el.hasAttribute("checked");
    case "disabled": return (el as Element).disabled || el.hasAttribute("disabled");
    case "enabled": return !el.hasAttribute("disabled");
    case "link": return el.tagName === "a" && el.hasAttribute("href");
    case "visited": return false;
    case "not": {
      if (!arg) return true;
      const inner = parseSelectorList(arg);
      for (const s of inner) if (matchesComplex(el, s, ctx)) return false;
      return true;
    }
    default: return false; // unknown pseudo => no match (spec-ish)
  }
}

function nthMatch(expr: string, idx: number): boolean {
  expr = expr.trim().toLowerCase();
  if (expr === "odd") return idx % 2 === 1;
  if (expr === "even") return idx % 2 === 0;
  const n = parseInt(expr, 10);
  if (String(n) === expr) return idx === n;
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(expr.replace(/\s+/g, ""));
  if (!m) return false;
  let a = m[1];
  const aN = a === "" || a === "+" ? 1 : a === "-" ? -1 : parseInt(a, 10);
  const b = m[2] ? parseInt(m[2].replace(/\s+/g, ""), 10) : 0;
  if (aN === 0) return idx === b;
  const diff = idx - b;
  return diff % aN === 0 && diff / aN >= 0;
}

export function matchesComplex(el: Element, sel: ComplexSelector, ctx: MatchContext | null): boolean {
  const { compounds, combinators } = sel;
  let cur: Element | null = el;
  let i = compounds.length - 1;
  if (!cur || !matchCompound(cur, compounds[i], ctx)) return false;
  while (i > 0) {
    const comb = combinators[i - 1];
    const left = compounds[i - 1];
    if (comb === "child") {
      cur = cur!.parentElement;
      if (!cur || !matchCompound(cur, left, ctx)) return false;
      i--;
    } else if (comb === "descendant") {
      cur = cur!.parentElement;
      let found = false;
      while (cur) {
        if (matchCompound(cur, left, ctx)) { found = true; break; }
        cur = cur.parentElement;
      }
      if (!found) return false;
      i--;
    } else if (comb === "adjacent") {
      cur = cur!.previousElementSibling;
      if (!cur || !matchCompound(cur, left, ctx)) return false;
      i--;
    } else { // sibling
      let sib: Element | null = cur!.previousElementSibling;
      let found = false;
      while (sib) {
        if (matchCompound(sib, left, ctx)) { found = true; cur = sib; break; }
        sib = sib.previousElementSibling;
      }
      if (!found) return false;
      i--;
    }
  }
  return true;
}

export function matchesSelectorText(el: Element, selector: string, ctx: MatchContext | null = null): boolean {
  const list = parseSelectorList(selector);
  return list.some(s => matchesComplex(el, s, ctx));
}

/** install full matcher into Document for querySelector */
export function installMatcher(doc: Document): void {
  doc._matcher = (sel, el) => matchesSelectorText(el, sel, null);
}

// ---------- media queries ----------
export function mediaMatches(query: string | null, vw: number, vh: number): boolean {
  if (!query) return true;
  // support comma OR, 'and' chains, min/max-width/height, orientation
  const groups = query.split(",").map(s => s.trim());
  for (const g of groups) {
    const parts = g.toLowerCase().split(/\band\b/).map(s => s.trim());
    let ok = true;
    for (const p of parts) {
      const clean = p.replace(/[()]/g, "").trim();
      if (clean === "screen" || clean === "all") continue;
      if (clean === "print") { ok = false; break; }
      if (clean === "not screen" || clean === "not all") { ok = false; break; }
      let m: RegExpMatchArray | null;
      if ((m = /min-width\s*:\s*(\d+)px/.exec(clean))) { if (vw < +m[1]) ok = false; }
      else if ((m = /max-width\s*:\s*(\d+)px/.exec(clean))) { if (vw > +m[1]) ok = false; }
      else if ((m = /min-height\s*:\s*(\d+)px/.exec(clean))) { if (vh < +m[1]) ok = false; }
      else if ((m = /max-height\s*:\s*(\d+)px/.exec(clean))) { if (vh > +m[1]) ok = false; }
      else if (/orientation\s*:\s*portrait/.test(clean)) { if (vw >= vh) ok = false; }
      else if (/orientation\s*:\s*landscape/.test(clean)) { if (vw < vh) ok = false; }
      else if (clean === "" || clean === "only screen") continue;
      else { /* unknown feature: treat as match */ }
      if (!ok) break;
    }
    if (ok) return true;
  }
  return false;
}

// ---------- cascade ----------
const INHERITED = new Set([
  "color", "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
  "white-space", "visibility", "cursor", "list-style", "list-style-type", "quotes", "direction",
]);

const INITIALS: Record<string, string> = {
  "display": "inline", "position": "static", "color": "#111111", "background-color": "transparent",
  "font-size": "16px", "font-family": "system-ui, sans-serif", "font-weight": "400",
  "line-height": "normal", "text-align": "left", "margin-top": "0", "margin-right": "0",
  "margin-bottom": "0", "margin-left": "0", "padding-top": "0", "padding-right": "0",
  "padding-bottom": "0", "padding-left": "0", "border-top-width": "0", "border-right-width": "0",
  "border-bottom-width": "0", "border-left-width": "0", "border-style": "none",
  "opacity": "1", "visibility": "visible", "overflow": "visible", "box-sizing": "content-box",
  "flex-direction": "row", "justify-content": "flex-start", "align-items": "stretch",
};

const UA_STYLES: [string, Record<string, string>][] = [
  ["html,body", { display: "block", margin: "0", padding: "0" }],
  ["head,title,meta,link,style,script,noscript,template", { display: "none" }],
  ["div,section,article,header,footer,nav,aside,main,figure,figcaption,p,h1,h2,h3,h4,h5,h6,ul,ol,dl,pre,blockquote,form,fieldset,hr", { display: "block" }],
  ["h1", { "font-size": "2em", "font-weight": "700", "margin": "0.67em 0" }],
  ["h2", { "font-size": "1.5em", "font-weight": "700", "margin": "0.75em 0" }],
  ["h3", { "font-size": "1.17em", "font-weight": "700", "margin": "1em 0" }],
  ["p", { display: "block", margin: "1em 0" }],
  ["ul,ol", { display: "block", margin: "1em 0", "padding-left": "40px" }],
  ["li", { display: "list-item" }],
  ["span,b,i,u,em,strong,a,code", { display: "inline" }],
  ["a", { color: "#1a5fb4", "text-decoration": "underline", cursor: "pointer" }],
  ["button,input,select,textarea", { display: "inline-block" }],
  ["button", { padding: "2px 8px", border: "1px solid #888", "background-color": "#eee" }],
  ["img", { display: "inline-block" }],
  ["table", { display: "table", "border-collapse": "collapse" }],
  ["tr", { display: "table-row" }],
  ["td,th", { display: "table-cell", padding: "2px 6px" }],
];

export interface CascadeOptions {
  viewportWidth: number; viewportHeight: number;
  matchCtx: MatchContext;
}

export function computeStyles(doc: Document, sheets: Stylesheet[], opts: CascadeOptions): void {
  const vw = opts.viewportWidth, vh = opts.viewportHeight;
  // flatten style rules
  interface Cand { sel: ComplexSelector; decl: Declaration; ruleOrder: number; }
  const flat: { selectors: ComplexSelector[]; declarations: Declaration[]; order: number; media: string | null }[] = [];
  for (const sh of sheets) {
    for (const r of sh.rules) {
      if (r.kind === "style") flat.push(r);
      else if (r.kind === "media") {
        if (!mediaMatches(r.query, vw, vh)) continue;
        for (const inner of r.rules) if (inner.kind === "style") flat.push({ ...inner, media: r.query });
      }
    }
  }
  // UA first (order -1)
  const uaRules = UA_STYLES.map(([sel, map], i) => ({
    selectors: parseSelectorList(sel),
    declarations: Object.entries(map).map(([prop, value]) => ({ prop, value, important: false as boolean })),
    order: -1000 + i, media: null as string | null,
  }));
  const all = [...uaRules, ...flat];

  const allElements: Element[] = doc.documentElement ? [doc.documentElement, ...doc.documentElement.querySelectorAll("*")] : [];
  if (doc.documentElement && !allElements.includes(doc.documentElement)) allElements.unshift(doc.documentElement);

  for (const el of allElements) {
    const cands: { decl: Declaration; spec: [number, number, number]; order: number; origin: number }[] = [];
    for (const rule of all) {
      if (rule.media && !mediaMatches(rule.media, vw, vh)) continue;
      for (const sel of rule.selectors) {
        let ok = false;
        try { ok = matchesComplex(el, sel, opts.matchCtx); } catch { ok = false; }
        if (!ok) continue;
        for (const d of rule.declarations) cands.push({ decl: d, spec: sel.specificity, order: rule.order, origin: 1 });
      }
    }
    // presentational hints (origin 0)
    const hints = presentationalHints(el);
    for (const h of hints) cands.push({ decl: h, spec: [0, 0, 0], order: -2000, origin: 0 });
    // inline style (origin 2)
    const inline = el.getAttribute("style");
    if (inline) {
      for (const d of parseInlineStyle(inline)) cands.push({ decl: d, spec: [1, 0, 0], order: 1e9, origin: 2 });
    }
    // sort: origin, important, specificity, order — apply in order so later wins
    cands.sort((x, y) => {
      const xi = (x.decl.important ? 100 : 0) + x.origin;
      const yi = (y.decl.important ? 100 : 0) + y.origin;
      if (xi !== yi) return xi - yi;
      for (let k = 0; k < 3; k++) if (x.spec[k] !== y.spec[k]) return x.spec[k] - y.spec[k];
      return x.order - y.order;
    });
    const computed = new Map<string, string>();
    for (const c of cands) {
      for (const [p, v] of expandShorthand(c.decl.prop, c.decl.value)) computed.set(p, v);
    }
    // inheritance
    const parent = el.parentElement;
    for (const prop of INHERITED) {
      if (!computed.has(prop)) {
        const pv = parent?.computedStyle.get(prop);
        if (pv !== undefined) computed.set(prop, pv);
        else if (INITIALS[prop]) computed.set(prop, INITIALS[prop]);
      }
    }
    for (const [k, v] of Object.entries(INITIALS)) if (!computed.has(k)) computed.set(k, v);
    if (!computed.has("display")) computed.set("display", el.tagName === "div" || el.tagName === "p" ? "block" : "inline");
    // resolve var() + normalize colors
    resolveVars(computed, el);
    el.computedStyle = computed;
  }
}

function presentationalHints(el: Element): Declaration[] {
  const out: Declaration[] = [];
  const bg = el.getAttribute("bgcolor"); if (bg) out.push({ prop: "background-color", value: bg, important: false });
  const color = el.getAttribute("color"); if (color) out.push({ prop: "color", value: color, important: false });
  const width = el.getAttribute("width");
  if (width && ["img", "table", "td", "canvas"].includes(el.tagName)) out.push({ prop: "width", value: /^\d+$/.test(width) ? width + "px" : width, important: false });
  const height = el.getAttribute("height");
  if (height && ["img", "canvas"].includes(el.tagName)) out.push({ prop: "height", value: /^\d+$/.test(height) ? height + "px" : height, important: false });
  const align = el.getAttribute("align");
  if (align) out.push({ prop: "text-align", value: align, important: false });
  if (el.tagName === "font") {
    const size = el.getAttribute("size");
    if (size) out.push({ prop: "font-size", value: size, important: false });
  }
  return out;
}

function expandShorthand(prop: string, value: string): [string, string][] {
  prop = prop.trim().toLowerCase();
  const v = value.trim();
  if (prop === "margin" || prop === "padding") {
    const parts = v.split(/\s+/);
    const [t, r, b, l] = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
      : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
      : [parts[0], parts[1], parts[2], parts[3]];
    const p = prop === "margin" ? "margin" : "padding";
    return [[`${p}-top`, t], [`${p}-right`, r], [`${p}-bottom`, b], [`${p}-left`, l]];
  }
  if (prop === "border") {
    // border: 1px solid red -> width/style/color
    const toks = v.split(/\s+/);
    const out: [string, string][] = [];
    for (const t of toks) {
      if (/^\d/.test(t)) out.push(["border-width", t]);
      else if (["none","hidden","dotted","dashed","solid","double","groove","ridge","inset","outset"].includes(t)) out.push(["border-style", t]);
      else out.push(["border-color", t]);
    }
    return out.length ? out : [[prop, v]];
  }
  if (prop === "border-width" || prop === "border-color") {
    const parts = v.split(/\s+/);
    const [t, r, b, l] = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
      : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
      : [parts[0] ?? v, parts[1] ?? v, parts[2] ?? v, parts[3] ?? v];
    const base = prop === "border-width" ? "border-*-width" : "border-*-color";
    void base;
    return prop === "border-width"
      ? [["border-top-width", t], ["border-right-width", r], ["border-bottom-width", b], ["border-left-width", l]]
      : [["border-top-color", t], ["border-right-color", r], ["border-bottom-color", b], ["border-left-color", l]];
  }
  if (prop === "font") {
    // font: italic bold 16px/1.5 Arial
    const m = /(\d+(?:\.\d+)?(?:px|pt|em|rem|%|large|medium|small|x-large|xx-large)?)(?:\/(\S+))?\s+(.+)/.exec(v);
    if (m) return [["font-size", m[1]], ["line-height", m[2] ?? "normal"], ["font-family", m[3]]];
    return [[prop, v]];
  }
  if (prop === "background") {
    // keep as-is plus background-color extraction
    const colorM = /(#[0-9a-fA-F]{3,8}|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\b[a-z]+)$/.exec(v);
    if (colorM) return [["background", v], ["background-color", colorM[1]]];
    return [[prop, v]];
  }
  if (prop === "flex") {
    // flex: grow shrink basis
    const parts = v.split(/\s+/);
    if (parts.length === 1 && parts[0] === "none") return [["flex-grow", "0"], ["flex-shrink", "0"], ["flex-basis", "auto"]];
    return [["flex-grow", parts[0] ?? "1"], ["flex-shrink", parts[1] ?? "1"], ["flex-basis", parts[2] ?? "0%"]];
  }
  return [[prop, v]];
}

function resolveVars(computed: Map<string, string>, el: Element): void {
  // gather custom props from ancestors
  const vars = new Map<string, string>();
  let cur: Element | null = el;
  const chain: Element[] = [];
  while (cur) { chain.unshift(cur); cur = cur.parentElement; }
  for (const anc of chain) for (const [k, v] of anc.computedStyle) if (k.startsWith("--")) vars.set(k, v);
  for (const [k, v] of [...computed]) if (k.startsWith("--")) vars.set(k, v);
  let guard = 0;
  const resolve = (val: string): string => {
    guard++;
    if (guard > 20) return val;
    return val.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/g, (_m, name: string, fb: string) => {
      const hit = vars.get(name) ?? computed.get(name);
      if (hit !== undefined) return resolve(hit);
      return fb ?? "";
    });
  };
  for (const [k, v] of [...computed]) {
    if (v.includes("var(")) computed.set(k, resolve(v));
  }
}

// length helpers shared with layout
export function toPx(value: string | undefined, ref: number, fontSize = 16, viewportW = 1280, viewportH = 800): number {
  if (!value) return 0;
  value = value.trim().toLowerCase();
  if (value === "auto" || value === "none") return 0;
  if (value.endsWith("px")) return parseFloat(value) || 0;
  if (value.endsWith("vw")) return (parseFloat(value) || 0) / 100 * viewportW;
  if (value.endsWith("vh")) return (parseFloat(value) || 0) / 100 * viewportH;
  if (value.endsWith("em") || value.endsWith("rem")) return (parseFloat(value) || 0) * fontSize;
  if (value.endsWith("%")) return (parseFloat(value) || 0) / 100 * ref;
  if (value.endsWith("pt")) return (parseFloat(value) || 0) * 1.333;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function getFontSize(el: Element): number {
  const fs = el.computedStyle.get("font-size") ?? "16px";
  if (fs.endsWith("px")) return parseFloat(fs) || 16;
  if (fs.endsWith("em")) return (parseFloat(fs) || 1) * 16;
  if (fs === "small") return 13; if (fs === "large") return 18;
  if (fs === "x-large") return 24; if (fs === "xx-large") return 32;
  const n = parseFloat(fs); return Number.isFinite(n) ? n : 16;
}
