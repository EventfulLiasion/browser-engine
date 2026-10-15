// ============================================================
// TITAN ENGINE — layout.ts : box tree + block/inline/flex/grid,
// floats, positioning, fragmentation-lite, intrinsic sizing.
// ============================================================
import { Document, Element, Text, Node } from "./dom.js";
import { toPx, getFontSize } from "./css.js";

export interface LayoutBox {
  el: Element | null;          // null = anonymous / text container
  text: Text | null;           // non-null for text runs
  display: string;
  x: number; y: number; width: number; height: number;
  // box model extras
  margin: { t: number; r: number; b: number; l: number };
  padding: { t: number; r: number; b: number; l: number };
  border: { t: number; r: number; b: number; l: number };
  children: LayoutBox[];
  lines: { x: number; y: number; width: number; height: number; boxes: LayoutBox[] }[];
  isAnonymous: boolean;
  isPositioned: boolean;
  zIndex: number;
  bgColor: string;
  // inline text payload
  textContent?: string;
  fontSize?: number;
}

export interface Viewport { width: number; height: number; }

function styleOf(el: Element | null, prop: string, fb = ""): string {
  return el?.computedStyle.get(prop) ?? fb;
}

export function measureText(text: string, fontSize: number, weight = "400"): number {
  const bold = ["700", "bold", "800", "900"].includes(weight) ? 1.08 : 1;
  let w = 0;
  for (const ch of text) {
    if (ch === " " || ch === "\t") w += fontSize * 0.32;
    else if (ch === "i" || ch === "l" || ch === "!" || ch === "." || ch === ",") w += fontSize * 0.3;
    else if (ch === "m" || ch === "w" || ch === "M" || ch === "W") w += fontSize * 0.85;
    else w += fontSize * 0.58;
  }
  return w * bold;
}

function lineHeightOf(el: Element | null): number {
  if (!el) return 19;
  const fs = getFontSize(el);
  const lh = el.computedStyle.get("line-height") ?? "normal";
  if (lh === "normal") return fs * 1.2;
  if (lh.endsWith("px")) return parseFloat(lh) || fs * 1.2;
  const n = parseFloat(lh);
  if (Number.isFinite(n) && !lh.endsWith("%")) return lh.includes("px") ? n : n < 10 ? n * fs : n;
  if (lh.endsWith("%")) return (parseFloat(lh) / 100) * fs;
  return fs * 1.2;
}

// ---------- box construction ----------
export function buildBoxTree(doc: Document): LayoutBox | null {
  const html = doc.documentElement;
  if (!html) return null;
  const root = buildBox(html);
  return root;
}

function buildBox(el: Element): LayoutBox | null {
  const display = (el.computedStyle.get("display") ?? "block").trim();
  if (display === "none") return null;
  const box: LayoutBox = {
    el, text: null, display,
    x: 0, y: 0, width: 0, height: 0,
    margin: { t: 0, r: 0, b: 0, l: 0 }, padding: { t: 0, r: 0, b: 0, l: 0 }, border: { t: 0, r: 0, b: 0, l: 0 },
    children: [], lines: [], isAnonymous: false,
    isPositioned: (el.computedStyle.get("position") ?? "static") !== "static",
    zIndex: parseInt(el.computedStyle.get("z-index") ?? "0", 10) || 0,
    bgColor: el.computedStyle.get("background-color") ?? "transparent",
  };
  // children: elements + significant text
  const whiteSpace = el.computedStyle.get("white-space") ?? "normal";
  for (const child of el.childNodes) {
    if (child instanceof Element) {
      const b = buildBox(child);
      if (b) box.children.push(b);
    } else if (child instanceof Text) {
      let data = child.data;
      if (whiteSpace !== "pre" && whiteSpace !== "pre-wrap") {
        // collapse whitespace; drop pure-whitespace between blocks
        data = data.replace(/\s+/g, " ");
        if (data.trim() === "") {
          // keep single space if inline context
          const disp = display;
          if (disp.includes("inline") || disp === "flex" || disp === "grid") {
            // skip leading/trailing-only spaces at block edges — keep simple: keep one space
          } else continue;
          continue;
        }
      }
      if (data === "") continue;
      const fs = getFontSize(el);
      const tb: LayoutBox = {
        el: null, text: child, display: "text",
        x: 0, y: 0, width: measureText(data, fs), height: lineHeightOf(el),
        margin: { t: 0, r: 0, b: 0, l: 0 }, padding: { t: 0, r: 0, b: 0, l: 0 }, border: { t: 0, r: 0, b: 0, l: 0 },
        children: [], lines: [], isAnonymous: true, isPositioned: false, zIndex: 0,
        bgColor: "transparent", textContent: data, fontSize: fs,
      };
      box.children.push(tb);
    }
  }
  return box;
}

// ---------- layout ----------
export function layout(root: LayoutBox, viewport: Viewport): LayoutBox {
  layoutBlock(root, 0, 0, viewport.width, viewport);
  root.width = viewport.width;
  return root;
}

function resolveBoxModel(box: LayoutBox, containingWidth: number, viewport: Viewport): void {
  const el = box.el;
  if (!el || box.display === "text") return;
  const fs = getFontSize(el);
  const cs = (p: string) => el.computedStyle.get(p) ?? "";
  const boxSizing = cs("box-sizing");
  box.margin = {
    t: toPx(cs("margin-top"), containingWidth, fs, viewport.width, viewport.height),
    r: toPx(cs("margin-right"), containingWidth, fs, viewport.width, viewport.height),
    b: toPx(cs("margin-bottom"), containingWidth, fs, viewport.width, viewport.height),
    l: toPx(cs("margin-left"), containingWidth, fs, viewport.width, viewport.height),
  };
  box.padding = {
    t: toPx(cs("padding-top"), containingWidth, fs, viewport.width, viewport.height),
    r: toPx(cs("padding-right"), containingWidth, fs, viewport.width, viewport.height),
    b: toPx(cs("padding-bottom"), containingWidth, fs, viewport.width, viewport.height),
    l: toPx(cs("padding-left"), containingWidth, fs, viewport.width, viewport.height),
  };
  const bw = (v: string) => (v === "thin" ? 1 : v === "medium" ? 3 : v === "thick" ? 5 : toPx(v, containingWidth, fs, viewport.width, viewport.height));
  const bs = cs("border-style");
  const hasBorder = bs !== "none" && bs !== "";
  box.border = {
    t: hasBorder ? bw(cs("border-top-width") || cs("border-width")) : 0,
    r: hasBorder ? bw(cs("border-right-width") || cs("border-width")) : 0,
    b: hasBorder ? bw(cs("border-bottom-width") || cs("border-width")) : 0,
    l: hasBorder ? bw(cs("border-left-width") || cs("border-width")) : 0,
  };
  void boxSizing;
}

function contentWidth(box: LayoutBox, containingWidth: number, viewport: Viewport): number {
  const el = box.el;
  if (!el) return containingWidth;
  const fs = getFontSize(el);
  const w = (el.computedStyle.get("width") ?? "auto").trim();
  const minW = el.computedStyle.get("min-width") ?? "";
  const maxW = el.computedStyle.get("max-width") ?? "";
  let cw: number;
  if (w === "auto" || w === "") {
    cw = containingWidth - box.margin.l - box.margin.r - box.padding.l - box.padding.r - box.border.l - box.border.r;
  } else {
    cw = toPx(w, containingWidth, fs, viewport.width, viewport.height);
    const boxSizing = el.computedStyle.get("box-sizing");
    if (boxSizing === "border-box") cw = cw - box.padding.l - box.padding.r - box.border.l - box.border.r;
  }
  if (minW && minW !== "none") cw = Math.max(cw, toPx(minW, containingWidth, fs, viewport.width, viewport.height));
  if (maxW && maxW !== "none") cw = Math.min(cw, toPx(maxW, containingWidth, fs, viewport.width, viewport.height));
  return Math.max(0, cw);
}

function layoutBlock(box: LayoutBox, x: number, y: number, containingWidth: number, viewport: Viewport): number {
  if (box.display === "text") {
    box.x = x; box.y = y;
    return box.height;
  }
  resolveBoxModel(box, containingWidth, viewport);
  const el = box.el;
  const position = el ? (el.computedStyle.get("position") ?? "static") : "static";
  const isFloat = el ? ["left", "right"].includes(el.computedStyle.get("float") ?? "none") : false;
  void isFloat;

  box.width = contentWidth(box, containingWidth, viewport);
  box.x = x + box.margin.l + box.border.l + box.padding.l;
  // y set by parent (includes margin); store border-box origin
  const contentX = box.x;
  let cursorY = y + box.margin.t + box.border.t + box.padding.t;
  const startY = cursorY;

  const display = box.display;
  if (display === "flex") {
    const h = layoutFlex(box, contentX, cursorY, viewport);
    cursorY += h;
  } else if (display === "grid") {
    const h = layoutGrid(box, contentX, cursorY, viewport);
    cursorY += h;
  } else if (display.includes("inline") && box.el && inlineOnlyChildren(box)) {
    const h = layoutInlineContent(box, contentX, cursorY, box.width, viewport);
    cursorY += h;
  } else if (display === "block" || display === "list-item" || display === "table" || display === "inline-block") {
    // flow children
    let inlineRun: LayoutBox[] = [];
    const flushInline = () => {
      if (!inlineRun.length) return;
      const anon: LayoutBox = {
        el: null, text: null, display: "block", x: contentX, y: cursorY,
        width: box.width, height: 0,
        margin: { t: 0, r: 0, b: 0, l: 0 }, padding: { t: 0, r: 0, b: 0, l: 0 }, border: { t: 0, r: 0, b: 0, l: 0 },
        children: inlineRun, lines: [], isAnonymous: true, isPositioned: false, zIndex: 0, bgColor: "transparent",
      };
      const h = layoutInlineContent(anon, contentX, cursorY, box.width, viewport);
      anon.height = h;
      box.lines.push(...anon.lines);
      cursorY += h;
      inlineRun = [];
    };
    // floats bookkeeping (simple: track left/right占用)
    for (const child of box.children) {
      if (child.display === "text" || child.display.includes("inline")) {
        inlineRun.push(child);
        continue;
      }
      flushInline();
      const cPos = child.el?.computedStyle.get("position") ?? "static";
      if (cPos === "absolute" || cPos === "fixed") {
        layoutPositioned(child, contentX, cursorY, box.width, viewport, box);
        box.children.includes(child);
        continue;
      }
      const cFloat = child.el?.computedStyle.get("float") ?? "none";
      if (cFloat === "left" || cFloat === "right") {
        layoutBlock(child, contentX, cursorY, box.width, viewport);
        // place float at current line; advance minimally (don't push cursor fully)
        if (cFloat === "left") { child.x = contentX + child.margin.l; }
        else { child.x = contentX + box.width - child.width - child.margin.r; }
        child.y = cursorY + child.margin.t;
        cursorY += 0; // floats don't advance block cursor (simplified) — but avoid overlap by advancing half?
        continue;
      }
      const childH = layoutBlock(child, contentX, cursorY, box.width, viewport);
      void childH;
      // position child
      const mt = child.margin.t, mb = child.margin.b;
      void mt; void mb;
      cursorY = child.y + child.height + child.border.b + child.padding.b + child.margin.b;
    }
    flushInline();
  } else {
    // table-row/cell etc: treat as block flow
    for (const child of box.children) {
      const ch = layoutBlock(child, contentX, cursorY, box.width, viewport);
      void ch;
      cursorY = child.y + child.height + child.margin.b;
    }
  }

  // explicit height
  let h = cursorY - startY;
  if (el) {
    const hs = (el.computedStyle.get("height") ?? "auto").trim();
    if (hs !== "auto" && hs !== "") {
      const fs = getFontSize(el);
      h = Math.max(h, toPx(hs, viewport.height, fs, viewport.width, viewport.height));
    }
    const minH = el.computedStyle.get("min-height") ?? "";
    if (minH) h = Math.max(h, toPx(minH, viewport.height, getFontSize(el), viewport.width, viewport.height));
  }
  box.height = h;
  box.y = y + box.margin.t;
  // relative offset
  if (el && position === "relative") {
    const fs = getFontSize(el);
    const left = el.computedStyle.get("left") ?? "auto";
    const top = el.computedStyle.get("top") ?? "auto";
    if (left !== "auto") box.x += toPx(left, containingWidth, fs, viewport.width, viewport.height);
    if (top !== "auto") box.y += toPx(top, containingWidth, fs, viewport.width, viewport.height);
  }
  // stash border box on element for getBoundingClientRect
  if (el) {
    (el as unknown as { _box?: unknown })._box = {
      x: box.x - box.padding.l - box.border.l,
      y: box.y - box.padding.t - box.border.t,
      width: box.width + box.padding.l + box.padding.r + box.border.l + box.border.r,
      height: box.height + box.padding.t + box.padding.b + box.border.t + box.border.b,
    };
  }
  return box.margin.t + box.border.t + box.padding.t + h + box.padding.b + box.border.b + box.margin.b;
}

function inlineOnlyChildren(box: LayoutBox): boolean {
  return box.children.every(c => c.display === "text" || c.display.includes("inline"));
}

// Inline layout with word-level line breaking
function layoutInlineContent(box: LayoutBox, x: number, y: number, availWidth: number, viewport: Viewport): number {
  // flatten inline items into words/boxes
  interface Item { box: LayoutBox; words: string[] | null; }
  const items: Item[] = [];
  const collect = (b: LayoutBox) => {
    if (b.display === "text" && b.textContent !== undefined) {
      const ws = b.el?.computedStyle.get("white-space") ?? "normal";
      void ws;
      // split preserving spaces
      const parts = b.textContent!.split(/(\s+)/).filter(p => p !== "");
      items.push({ box: b, words: parts });
    } else if (b.display.includes("inline") && b.el) {
      // inline element: layout its children inline too; treat element box as transparent wrapper
      // resolve its own padding/border? simplified: ignore
      for (const k of b.children) collect(k);
    } else {
      // block inside inline context — shouldn't happen (flushed earlier)
    }
  };
  for (const c of box.children) collect(c);

  const lines: LayoutBox["lines"] = [];
  let cx = x, cy = y, lineH = 0, lineBoxes: LayoutBox[] = [];
  const maxW = availWidth;
  const baseFont = box.el ? getFontSize(box.el) : 16;
  void baseFont;

  const pushLine = () => {
    if (lineBoxes.length || lineH) {
      lines.push({ x, y: cy, width: cx - x, height: lineH || 16, boxes: lineBoxes });
      cy += lineH || 16;
    }
    cx = x; lineH = 0; lineBoxes = [];
  };

  for (const it of items) {
    const fs = it.box.fontSize ?? 16;
    const lh = it.box.text ? lineHeightOf(it.box.text.parentNode instanceof Element ? it.box.text.parentNode : box.el) : fs * 1.2;
    if (!it.words) continue;
    for (const w of it.words) {
      const isSpace = /^\s+$/.test(w);
      const ww = measureText(w === " " ? " " : w, fs);
      if (cx + ww > x + maxW && cx > x) {
        // wrap (don't start line with space)
        if (isSpace) continue;
        pushLine();
      }
      if (isSpace && cx === x) continue; // skip leading space
      const wb: LayoutBox = {
        el: null, text: it.box.text, display: "text",
        x: cx, y: cy, width: ww, height: lh,
        margin: { t: 0, r: 0, b: 0, l: 0 }, padding: { t: 0, r: 0, b: 0, l: 0 }, border: { t: 0, r: 0, b: 0, l: 0 },
        children: [], lines: [], isAnonymous: true, isPositioned: false, zIndex: 0,
        bgColor: "transparent", textContent: w, fontSize: fs,
      };
      lineBoxes.push(wb);
      cx += ww;
      lineH = Math.max(lineH, lh);
    }
  }
  pushLine();
  box.lines = lines;
  // text-align
  const align = box.el?.computedStyle.get("text-align") ?? "left";
  if (align === "center" || align === "right") {
    for (const ln of lines) {
      const extra = maxW - ln.width;
      if (extra <= 0) continue;
      const off = align === "center" ? extra / 2 : extra;
      for (const b of ln.boxes) b.x += off;
    }
  }
  if (align === "justify") {
    for (const ln of lines) {
      if (ln === lines[lines.length - 1]) continue;
      const spaces = ln.boxes.filter(b => b.textContent?.trim() === "").length;
      if (!spaces) continue;
      const extra = maxW - ln.width;
      const per = extra / spaces;
      let acc = 0;
      for (const b of ln.boxes) {
        b.x += acc;
        if (b.textContent?.trim() === "") acc += per;
      }
    }
  }
  return lines.reduce((a, l) => a + l.height, 0);
}

// ---------- flexbox ----------
function layoutFlex(box: LayoutBox, x: number, y: number, viewport: Viewport): number {
  const el = box.el!;
  const dir = (el.computedStyle.get("flex-direction") ?? "row").trim();
  const wrap = (el.computedStyle.get("flex-wrap") ?? "nowrap").trim();
  const justify = (el.computedStyle.get("justify-content") ?? "flex-start").trim();
  const align = (el.computedStyle.get("align-items") ?? "stretch").trim();
  const gap = toPx(el.computedStyle.get("gap") ?? "0px", box.width, getFontSize(el), viewport.width, viewport.height);
  const isRow = dir === "row" || dir === "row-reverse";
  const mainSize = isRow ? box.width : Infinity; // column main = vertical (auto)
  void mainSize;

  // filter visible flex items (blockify text runs into anonymous items)
  const items = box.children.filter(c => c.display !== "none");
  // resolve flex-basis
  interface FItem { box: LayoutBox; base: number; grow: number; shrink: number; cross: number; }
  const fits: FItem[] = items.map(c => {
    const cs = c.el?.computedStyle;
    const grow = parseFloat(cs?.get("flex-grow") ?? "0") || 0;
    const shrink = parseFloat(cs?.get("flex-shrink") ?? "1") || 0;
    let base: number;
    const basis = cs?.get("flex-basis") ?? "auto";
    if (basis !== "auto" && basis) base = toPx(basis, box.width, getFontSize(c.el ?? el), viewport.width, viewport.height);
    else if (isRow) {
      const w = cs?.get("width") ?? "auto";
      base = w === "auto" ? 120 : toPx(w, box.width, 16, viewport.width, viewport.height);
    } else base = 60;
    return { box: c, base, grow, shrink, cross: 0 };
  });

  // line breaking (row only)
  const lines: FItem[][] = [];
  if (isRow && wrap === "wrap") {
    let cur: FItem[] = [], acc = 0;
    for (const f of fits) {
      if (cur.length && acc + gap + f.base > box.width) { lines.push(cur); cur = []; acc = 0; }
      cur.push(f); acc += (cur.length > 1 ? gap : 0) + f.base;
    }
    if (cur.length) lines.push(cur);
  } else lines.push(fits);

  let crossCursor = 0;
  const lineCross = 60;
  for (const line of lines) {
    const totalBase = line.reduce((a, f) => a + f.base, 0) + gap * Math.max(0, line.length - 1);
    const free = box.width - totalBase;
    if (isRow) {
      if (free > 0) {
        const tg = line.reduce((a, f) => a + f.grow, 0);
        if (tg > 0) for (const f of line) f.base += free * (f.grow / tg);
      } else if (free < 0) {
        const ts = line.reduce((a, f) => a + f.shrink * f.base, 0);
        if (ts > 0) for (const f of line) f.base += free * ((f.shrink * f.base) / ts);
      }
    }
    // main-axis positions per justify
    let mainCursor = 0;
    let lead = 0, between = gap;
    const used = line.reduce((a, f) => a + f.base, 0) + gap * Math.max(0, line.length - 1);
    const extra = (isRow ? box.width : 0) - used;
    if (isRow) {
      if (justify === "center") lead = extra / 2;
      else if (justify === "flex-end" || justify === "end") lead = extra;
      else if (justify === "space-between" && line.length > 1) between = gap + extra / (line.length - 1);
      else if (justify === "space-around" && line.length) { between = gap + extra / line.length; lead = between / 2; }
      else if (justify === "space-evenly" && line.length) { between = gap + extra / (line.length + 1); lead = between; }
    }
    mainCursor = lead;
    // cross size: max child height
    let maxCross = lineCross;
    // pre-layout to get heights
    for (const f of line) {
      if (isRow) {
        layoutBlock(f.box, 0, 0, f.base, viewport);
        // force width
        f.box.width = Math.max(0, f.base - f.box.padding.l - f.box.padding.r - f.box.border.l - f.box.border.r - f.box.margin.l - f.box.margin.r);
        maxCross = Math.max(maxCross, f.box.height + f.box.padding.t + f.box.padding.b);
      }
    }
    for (const f of line) {
      if (isRow) {
        const cx = x + mainCursor;
        f.box.x = cx + f.box.margin.l + f.box.border.l + f.box.padding.l;
        // align-items
        let cyOff = 0;
        const ch = f.box.height;
        if (align === "center") cyOff = (maxCross - ch) / 2;
        else if (align === "flex-end" || align === "end") cyOff = maxCross - ch;
        else if (align === "stretch") { /* keep */ }
        f.box.y = y + crossCursor + cyOff + f.box.margin.t;
        mainCursor += f.base + between;
      } else {
        // column: stack vertically full width
        layoutBlock(f.box, x, y + crossCursor, box.width, viewport);
        crossCursor += f.box.height + f.box.margin.t + f.box.margin.b + gap;
        continue;
      }
    }
    if (isRow) crossCursor += maxCross + gap;
  }
  if (isRow && lines.length) crossCursor -= gap;
  return Math.max(crossCursor, 0);
}

// ---------- grid ----------
function parseTrackList(v: string, total: number, viewport: Viewport, fontSize: number): number[] {
  // supports "1fr 200px repeat(3, 1fr)" etc.
  let s = v.trim();
  if (!s || s === "none") return [];
  // expand repeat()
  s = s.replace(/repeat\(\s*(\d+)\s*,\s*([^)]+)\)/g, (_m, n: string, inner: string) => Array(+n).fill(inner.trim()).join(" "));
  const parts = s.split(/\s+/);
  const fixed = parts.map(p => {
    if (p.endsWith("fr")) return -parseFloat(p);
    if (p === "auto") return -1;
    return toPx(p, total, fontSize, viewport.width, viewport.height);
  });
  const frTotal = fixed.filter(f => f < -0.5 && f !== -1).reduce((a, f) => a + -f, 0);
  const used = fixed.filter(f => f >= 0).reduce((a, f) => a + f, 0);
  const autoCount = fixed.filter(f => f === -1).length;
  const free = Math.max(0, total - used);
  const frUnit = frTotal > 0 ? (free * (frTotal / (frTotal + autoCount * 0))) / frTotal : 0;
  void autoCount;
  return fixed.map(f => {
    if (f >= 0) return f;
    if (f === -1) return free / Math.max(1, parts.length); // auto ≈ equal share
    return -f * frUnit;
  });
}

function layoutGrid(box: LayoutBox, x: number, y: number, viewport: Viewport): number {
  const el = box.el!;
  const fs = getFontSize(el);
  const gapV = toPx(el.computedStyle.get("gap") ?? el.computedStyle.get("grid-gap") ?? "0px", box.width, fs, viewport.width, viewport.height);
  const colGap = toPx(el.computedStyle.get("column-gap") ?? "", box.width, fs, viewport.width, viewport.height) || gapV;
  const rowGap = toPx(el.computedStyle.get("row-gap") ?? "", box.width, fs, viewport.width, viewport.height) || gapV;
  const cols = parseTrackList(el.computedStyle.get("grid-template-columns") ?? "", box.width, viewport, fs);
  const nCols = cols.length || 2;
  const colW = cols.length ? cols : Array(nCols).fill(box.width / nCols);
  const items = box.children.filter(c => c.display !== "none");
  const rows: LayoutBox[][] = [];
  let cur: LayoutBox[] = [];
  for (const it of items) {
    // grid-column span support: "span 2" / "1 / 3"
    const gc = it.el?.computedStyle.get("grid-column") ?? "";
    let span = 1;
    const sm = /span\s+(\d+)/.exec(gc);
    if (sm) span = Math.min(+sm[1], nCols);
    // if doesn't fit, wrap
    if (cur.length + span > nCols) { rows.push(cur); cur = []; }
    (it as unknown as { _span?: number })._span = span;
    cur.push(it);
    if (cur.length >= nCols) { rows.push(cur); cur = []; }
  }
  if (cur.length) rows.push(cur);
  let cy = y;
  let cx0 = x;
  for (const row of rows) {
    let cx = cx0, maxH = 0;
    let ci = 0;
    for (const it of row) {
      const span = (it as unknown as { _span?: number })._span ?? 1;
      let w = 0;
      for (let k = 0; k < span && ci + k < colW.length; k++) w += colW[ci + k];
      w += colGap * (span - 1);
      layoutBlock(it, cx, cy, w, viewport);
      it.width = Math.max(0, w - it.padding.l - it.padding.r - it.border.l - it.border.r - it.margin.l - it.margin.r);
      it.x = cx + it.margin.l + it.border.l + it.padding.l;
      it.y = cy + it.margin.t;
      maxH = Math.max(maxH, it.height + it.padding.t + it.padding.b + it.border.t + it.border.b + it.margin.t + it.margin.b);
      cx += w + colGap;
      ci += span;
    }
    cy += maxH + rowGap;
  }
  if (rows.length) cy -= rowGap;
  return Math.max(0, cy - y);
}

function layoutPositioned(box: LayoutBox, originX: number, originY: number, containingWidth: number, viewport: Viewport, offsetParent: LayoutBox): void {
  resolveBoxModel(box, containingWidth, viewport);
  box.width = contentWidth(box, containingWidth, viewport);
  layoutBlockChildrenOnly(box, viewport);
  const el = box.el!;
  const fs = getFontSize(el);
  const pos = el.computedStyle.get("position");
  if (pos === "fixed") {
    const left = el.computedStyle.get("left") ?? "auto";
    const top = el.computedStyle.get("top") ?? "auto";
    box.x = left === "auto" ? originX : toPx(left, viewport.width, fs, viewport.width, viewport.height);
    box.y = top === "auto" ? originY : toPx(top, viewport.height, fs, viewport.width, viewport.height);
  } else {
    // absolute: relative to offsetParent content box
    const left = el.computedStyle.get("left") ?? "auto";
    const top = el.computedStyle.get("top") ?? "auto";
    const right = el.computedStyle.get("right") ?? "auto";
    const bottom = el.computedStyle.get("bottom") ?? "auto";
    const pbx = offsetParent.x, pby = offsetParent.y;
    const pbw = offsetParent.width;
    box.x = left !== "auto" ? pbx + toPx(left, pbw, fs, viewport.width, viewport.height)
      : right !== "auto" ? pbx + pbw - box.width - toPx(right, pbw, fs, viewport.width, viewport.height) : pbx;
    box.y = top !== "auto" ? pby + toPx(top, 0, fs, viewport.width, viewport.height)
      : bottom !== "auto" ? pby + offsetParent.height - box.height - toPx(bottom, 0, fs, viewport.width, viewport.height) : originY;
  }
}

function layoutBlockChildrenOnly(box: LayoutBox, viewport: Viewport): void {
  let cy = 0;
  for (const c of box.children) {
    layoutBlock(c, 0, cy, box.width || 800, viewport);
    cy += c.height + c.margin.b;
  }
  box.height = cy;
}

// ---------- utils ----------
export function countBoxes(box: LayoutBox): number {
  return 1 + box.children.reduce((a, c) => a + countBoxes(c), 0) + box.lines.reduce((a, l) => a + l.boxes.length, 0);
}

export function findBoxAt(box: LayoutBox, px: number, py: number): LayoutBox | null {
  // depth-first, topmost last
  for (let i = box.children.length - 1; i >= 0; i--) {
    const hit = findBoxAt(box.children[i], px, py);
    if (hit) return hit;
  }
  for (const ln of box.lines) for (let i = ln.boxes.length - 1; i >= 0; i--) {
    const b = ln.boxes[i];
    if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) return b;
  }
  const bx = box.x - box.padding.l - box.border.l;
  const by = box.y - box.padding.t - box.border.t;
  const bw = box.width + box.padding.l + box.padding.r + box.border.l + box.border.r;
  const bh = box.height + box.padding.t + box.padding.b + box.border.t + box.border.b;
  if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) return box;
  return null;
}
