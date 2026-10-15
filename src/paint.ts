// ============================================================
// TITAN ENGINE — paint.ts : display list + canvas rasterizer.
// Handles backgrounds, borders, radius-lite, shadows-lite,
// text runs, image placeholders, stacking (z-index), overflow.
// ============================================================
import type { LayoutBox, Viewport } from "./layout.js";

export type PaintCmd =
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; radius?: number; shadow?: string }
  | { kind: "border"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: "text"; x: number; y: number; text: string; font: string; color: string }
  | { kind: "image"; x: number; y: number; w: number; h: number; src: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number };

export function normalizeColor(c: string): string {
  c = (c ?? "").trim().toLowerCase();
  if (!c || c === "transparent") return "rgba(0,0,0,0)";
  const NAMED: Record<string, string> = {
    black: "#000", white: "#fff", red: "#e03131", green: "#2f9e44", blue: "#1971c2",
    gray: "#868e96", grey: "#868e96", yellow: "#fcc419", orange: "#fd7e14", purple: "#7048e8",
    pink: "#d6336c", teal: "#0c8599", cyan: "#22b8cf", lime: "#94d82d",
  };
  if (NAMED[c]) c = NAMED[c];
  if (/^#[0-9a-f]{3}$/.test(c)) return "#" + c.slice(1).split("").map(x => x + x).join("");
  return c;
}

export function buildDisplayList(root: LayoutBox): PaintCmd[] {
  const cmds: PaintCmd[] = [];
  // collect positioned vs normal for z-ordering
  const walk = (box: LayoutBox) => {
    paintBox(box, cmds);
    // z-index sort for children (stable)
    const kids = [...box.children].sort((a, b) => a.zIndex - b.zIndex);
    for (const k of kids) walk(k);
    for (const ln of box.lines) {
      const sorted = [...ln.boxes].sort((a, b) => a.zIndex - b.zIndex);
      for (const b of sorted) paintTextBox(b, cmds);
    }
  };
  walk(root);
  return cmds;
}

function paintBox(box: LayoutBox, cmds: PaintCmd[]): void {
  const el = box.el;
  if (!el) return;
  if (box.display === "text") return;
  const cs = el.computedStyle;
  const bx = box.x - box.padding.l - box.border.l;
  const by = box.y - box.padding.t - box.border.t;
  const bw = box.width + box.padding.l + box.padding.r + box.border.l + box.border.r;
  const bh = box.height + box.padding.t + box.padding.b + box.border.t + box.border.b;

  const bg = normalizeColor(cs.get("background-color") ?? cs.get("background") ?? "transparent");
  const opacity = parseFloat(cs.get("opacity") ?? "1");
  void opacity;
  const radius = parseFloat(cs.get("border-radius") ?? cs.get("border-top-left-radius") ?? "0") || 0;
  const shadow = cs.get("box-shadow") ?? "";

  if (bg !== "rgba(0,0,0,0)" && bw > 0 && bh > 0) {
    // checker for gradients — flatten to first color
    const flat = bg.includes("gradient") ? "#e9ecef" : bg;
    cmds.push({ kind: "rect", x: bx, y: by, w: bw, h: bh, color: flat, radius: radius || undefined, shadow: shadow || undefined });
  }
  // borders (per-side widths simplified to uniform max)
  const btw = box.border.t, brw = box.border.r, bbw = box.border.b, blw = box.border.l;
  const maxBW = Math.max(btw, brw, bbw, blw);
  if (maxBW > 0) {
    const bc = normalizeColor(cs.get("border-color") ?? cs.get("border-top-color") ?? "#000");
    cmds.push({ kind: "border", x: bx, y: by, w: bw, h: bh, color: bc, width: maxBW });
  }
  // list-item bullet
  if (box.display === "list-item") {
    cmds.push({ kind: "text", x: bx - 14, y: by + 2, text: "•", font: "14px sans-serif", color: "#333" });
  }
  // replaced elements: img / input / button / hr / video / canvas
  const tag = el.tagName;
  if (tag === "img") {
    const src = el.getAttribute("src") ?? "";
    const iw = bw || 120, ih = bh || 80;
    cmds.push({ kind: "image", x: bx, y: by, w: iw, h: ih, src });
  } else if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") {
    if (bg === "rgba(0,0,0,0)") cmds.push({ kind: "rect", x: bx, y: by, w: Math.max(bw, 40), h: Math.max(bh, 20), color: tag === "button" ? "#e9ecef" : "#ffffff", radius: 3 });
    if (tag === "input" || tag === "textarea") {
      const val = el.getAttribute("value") ?? el.getAttribute("placeholder") ?? "";
      const ph = el.getAttribute("placeholder") ?? "";
      const isPh = !val && ph;
      cmds.push({ kind: "text", x: bx + 6, y: by + 5, text: String(val || ph || "").slice(0, 40), font: "13px sans-serif", color: isPh ? "#999" : "#222" });
    } else if (tag === "button") {
      const label = (el.textContent ?? "").trim() || el.getAttribute("value") || "Button";
      cmds.push({ kind: "text", x: bx + 8, y: by + 5, text: label.slice(0, 30), font: "13px sans-serif", color: "#222" });
    }
  } else if (tag === "hr") {
    cmds.push({ kind: "line", x1: bx, y1: by + 2, x2: bx + bw, y2: by + 2, color: "#adb5bd", width: 1 });
  } else if (tag === "video" || tag === "canvas" || tag === "iframe") {
    cmds.push({ kind: "rect", x: bx, y: by, w: bw || 200, h: bh || 120, color: "#0b7285", radius: 4 });
    cmds.push({ kind: "text", x: bx + 10, y: by + (bh || 120) / 2, text: `▶ ${tag}`, font: "14px sans-serif", color: "#fff" });
  }
}

function paintTextBox(box: LayoutBox, cmds: PaintCmd[]): void {
  if (box.textContent === undefined) return;
  // find ancestor element for style
  let p: unknown = box.text?.parentNode ?? null;
  let color = "#111", font = "16px sans-serif", deco = "";
  let bg = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pel = p as any;
  if (pel && pel.computedStyle) {
    const cs = pel.computedStyle as Map<string, string>;
    color = normalizeColor(cs.get("color") ?? "#111");
    const fs = cs.get("font-size") ?? "16px";
    const ff = (cs.get("font-family") ?? "sans-serif").split(",")[0].replace(/['"]/g, "");
    const fw = cs.get("font-weight") ?? "400";
    const fst = cs.get("font-style") ?? "normal";
    font = `${fst === "italic" ? "italic " : ""}${fw === "700" || fw === "bold" ? "bold " : ""}${fs} ${ff}`;
    deco = cs.get("text-decoration") ?? "";
    bg = cs.get("background-color") ?? "";
  }
  if (!box.textContent) return;
  if (bg && bg !== "transparent" && normalizeColor(bg) !== "rgba(0,0,0,0)") {
    cmds.push({ kind: "rect", x: box.x - 1, y: box.y - 1, w: box.width + 2, h: box.height + 2, color: normalizeColor(bg) });
  }
  cmds.push({ kind: "text", x: box.x, y: box.y + box.height * 0.78, text: box.textContent, font, color });
  if (deco.includes("underline")) {
    cmds.push({ kind: "line", x1: box.x, y1: box.y + box.height * 0.86, x2: box.x + box.width, y2: box.y + box.height * 0.86, color, width: 1 });
  }
  if (deco.includes("line-through")) {
    cmds.push({ kind: "line", x1: box.x, y1: box.y + box.height * 0.5, x2: box.x + box.width, y2: box.y + box.height * 0.5, color, width: 1 });
  }
}

export function rasterize(cmds: PaintCmd[], ctx: CanvasRenderingContext2D, viewport: Viewport, dpr = 1): void {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  for (const c of cmds) {
    try {
      if (c.kind === "rect") {
        if (c.color === "rgba(0,0,0,0)") continue;
        ctx.fillStyle = c.color;
        if (c.shadow) { ctx.save(); ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; }
        if (c.radius) {
          const r = Math.min(c.radius, c.w / 2, c.h / 2);
          ctx.beginPath();
          ctx.roundRect(c.x, c.y, c.w, c.h, r);
          ctx.fill();
        } else ctx.fillRect(c.x, c.y, c.w, c.h);
        if (c.shadow) ctx.restore();
      } else if (c.kind === "border") {
        ctx.strokeStyle = c.color; ctx.lineWidth = c.width;
        ctx.strokeRect(c.x, c.y, c.w, c.h);
      } else if (c.kind === "text") {
        ctx.fillStyle = c.color; ctx.font = c.font;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(c.text, c.x, c.y);
      } else if (c.kind === "image") {
        // placeholder gradient + label (no network images in v1)
        const g = ctx.createLinearGradient(c.x, c.y, c.x + c.w, c.y + c.h);
        g.addColorStop(0, "#d0ebff"); g.addColorStop(1, "#a5d8ff");
        ctx.fillStyle = g;
        ctx.fillRect(c.x, c.y, c.w || 120, c.h || 80);
        ctx.strokeStyle = "#74c0fc"; ctx.strokeRect(c.x, c.y, c.w || 120, c.h || 80);
        ctx.fillStyle = "#1864ab"; ctx.font = "12px sans-serif";
        const label = (c.src || "image").slice(0, 28);
        ctx.fillText("🖼 " + label, c.x + 6, c.y + 18);
      } else if (c.kind === "line") {
        ctx.strokeStyle = c.color; ctx.lineWidth = c.width;
        ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
      }
    } catch { /* one bad cmd shouldn't kill frame */ }
  }
  ctx.restore();
}
