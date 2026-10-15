// ============================================================
// TITAN ENGINE — main.ts : browser-chrome wiring (tabs, omnibox,
// viewport canvas, inspector, console). Loaded by index.html.
// ============================================================
import { Browser, type Fetcher, type Tab } from "./browser.js";
import { rasterize } from "./paint.js";
import type { Element as TitanElement } from "./dom.js";

const canvas = document.getElementById("viewport") as HTMLCanvasElement;
const externalFrame = document.getElementById("external-frame") as HTMLIFrameElement;
const ctx = canvas.getContext("2d")!;
const tabstrip = document.getElementById("tabstrip")!;
const omnibox = document.getElementById("omnibox") as HTMLInputElement;
const btnGo = document.getElementById("btn-go")!;
const btnBack = document.getElementById("btn-back")!;
const btnFwd = document.getElementById("btn-fwd")!;
const btnReload = document.getElementById("btn-reload")!;
const btnNew = document.getElementById("btn-newtab")!;
const statsEl = document.getElementById("stats")!;
const devtools = document.getElementById("devtools")!;
const conOut = document.getElementById("console-out")!;
const conIn = document.getElementById("console-in") as HTMLInputElement;
const domTree = document.getElementById("dom-tree")!;
const stylePane = document.getElementById("style-pane")!;

const VW = 1280, VH = 900;

// demo pages bundled (also mirrored in demo-pages/)
const DEMOS: Record<string, string> = {
  "titan://welcome": `<!DOCTYPE html><html><head><title>Welcome to Titan</title><style>
    body{font-family:system-ui;margin:0;background:#f8f9fa;color:#212529}
    header{background:linear-gradient(90deg,#7048e8,#1c7ed6);color:#fff;padding:36px;text-align:center}
    .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;padding:24px;max-width:1000px;margin:auto}
    .card{background:#fff;border:1px solid #dee2e6;border-radius:12px;padding:20px;box-shadow:0 4px 12px rgba(0,0,0,.08)}
    .flex{display:flex;gap:10px;justify-content:center;padding:16px}
    button{background:#7048e8;color:#fff;border:none;border-radius:8px;padding:10px 18px;cursor:pointer}
    </style></head><body>
    <header><h1>⚡ Titan Engine</h1><p>A from-scratch browser engine: HTML · CSS · Flex/Grid · JS · tabs</p></header>
    <div class="flex"><button id="b1">Click me</button><button id="b2">Dark mode</button><button id="b3">Add card</button></div>
    <div class="grid" id="grid">
      <div class="card"><h3>HTML5 parser</h3><p>Tokenizer + tree builder with entities, void elements, rawtext &amp; error recovery.</p></div>
      <div class="card"><h3>CSS cascade</h3><p>Specificity, <code>var()</code>, media queries, flex &amp; grid tracks.</p></div>
      <div class="card"><h3>JS engine</h3><p>Lexer, parser &amp; interpreter with closures, classes and DOM bindings.</p></div>
    </div>
    <script>
      let n = 0;
      document.querySelector("#b1").addEventListener("click", () => { n++; document.querySelector("header p").textContent = "Clicked " + n + " times — event loop works!"; });
      document.querySelector("#b2").addEventListener("click", () => { document.body.style.background = "#212529"; document.body.style.color = "#f1f3f5"; });
      document.querySelector("#b3").addEventListener("click", () => {
        let d = document.createElement("div"); d.className = "card";
        d.textContent = "Dynamically created card #" + Math.floor(Math.random()*1000);
        document.querySelector("#grid").appendChild(d);
      });
      console.log("titan ready", 40+2);
    </script></body></html>`,
  "titan://flex": `<!DOCTYPE html><html><head><title>Flex demo</title><style>
    .row{display:flex;gap:12px;justify-content:space-between;align-items:center;background:#e7f5ff;padding:20px}
    .row div{flex:1;background:#fff;border:2px solid #1971c2;border-radius:8px;padding:24px;text-align:center}
    .row div:nth-child(2){flex-grow:2;background:#d0ebff}</style></head>
    <body><h1>Flexbox</h1><div class="row"><div>A</div><div>B (grow 2)</div><div>C</div></div></body></html>`,
  "titan://grid": `<!DOCTYPE html><html><head><title>Grid demo</title><style>
    .g{display:grid;grid-template-columns:1fr 2fr 1fr;gap:10px;background:#fff5f5;padding:20px}
    .g div{background:#ffc9c9;border-radius:8px;padding:20px;text-align:center}
    @media (max-width: 700px){ .g{grid-template-columns:1fr 1fr} }</style></head>
    <body><h1>Grid + media query (resize!)</h1><div class="g"><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div></div></body></html>`,
};

function uiLog(...a: unknown[]): void {
  const line = document.createElement("div");
  line.textContent = a.map(String).join(" ");
  conOut.appendChild(line);
  conOut.scrollTop = conOut.scrollHeight;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

const PROXIES: { name: string; ms: number; mk: (u: string) => string }[] = [
  // Local helper first: fast fail (~2.5s) when `npm run proxy` isn't running,
  // and the ONLY path that works for bot-guarded sites like youtube.com.
  { name: "local", ms: 25000, mk: (u: string) => `${new URL("/proxy", window.location.href).href}?url=${encodeURIComponent(u)}` },
  { name: "allorigins", ms: 15000, mk: (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: "codetabs", ms: 15000, mk: (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { name: "corsproxy", ms: 15000, mk: (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];

const fetcher: Fetcher = async (url: string) => {
  if (DEMOS[url]) return DEMOS[url];
  if (url.startsWith("titan://")) return `<html><head><title>404</title></head><body><h1>Unknown ${url}</h1><p>Try titan://welcome, titan://flex, titan://grid</p></body></html>`;
  // 1) direct fetch (works for CORS-enabled sites + same-origin demo pages)
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/text|html|xml|json|javascript/.test(ct)) throw new Error(`Unsupported content-type ${ct}`);
    return await res.text();
  } catch (directErr) {
    uiLog("[net] direct fetch failed:", String(directErr).slice(0, 160));
    // 2) CORS-proxy fallbacks (needed for youtube.com etc. — they send no ACAO header)
    if (!/^https?:\/\//.test(url)) throw directErr;
    const errs: string[] = [String(directErr).slice(0, 120)];
    for (const p of PROXIES) {
      const purl = p.mk(url);
      try {
        uiLog(`[net] trying ${p.name}…`);
        const res = await fetchWithTimeout(purl, p.ms);
        if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.length < 50) throw new Error(`${p.name} returned empty body`);
        uiLog(`[net] ${p.name} OK,`, text.length, "bytes");
        return text;
      } catch (e) {
        uiLog(`[net] ${p.name} failed:`, String(e).slice(0, 120));
        errs.push(`${p.name}: ${String(e).slice(0, 120)}`);
      }
    }
    throw new Error(`All fetches failed. ${errs.join(" | ")}`);
  }
};

const browser = new Browser({
  viewport: { width: VW, height: VH },
  fetcher,
  consoleLog: (...a: unknown[]) => uiLog(...a),
});

const externalEmbeds = new WeakMap<Tab, string>();

function youtubeEmbedURL(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let id = "";
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] || "";
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else if (/^\/(shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split("/")[2] || "";
    }
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  } catch { return null; }
}

function isYouTubeURL(value: string): boolean {
  try {
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(new URL(value).hostname.toLowerCase());
  } catch { return false; }
}

function syncExternalFrame(): void {
  const embed = externalEmbeds.get(browser.current());
  if (embed) {
    if (externalFrame.src !== embed) externalFrame.src = embed;
    externalFrame.style.display = "block";
    canvas.style.visibility = "hidden";
  } else {
    externalFrame.style.display = "none";
    if (externalFrame.src && !externalFrame.src.endsWith("about:blank")) externalFrame.src = "about:blank";
    canvas.style.visibility = "visible";
  }
}

function showYouTubePlayer(tab: Tab, url: string, embed: string, pushHistory = true): void {
  tab.loadHTML("<html><head><title>YouTube</title></head><body><p>YouTube video player</p></body></html>", url);
  if (pushHistory) {
    tab.history = tab.history.slice(0, tab.hIndex + 1);
    tab.history.push(url);
    tab.hIndex = tab.history.length - 1;
  }
  externalEmbeds.set(tab, embed);
  syncExternalFrame();
  statsEl.textContent = `YouTube player · ${url}`;
  domTree.textContent = "Embedded YouTube player";
  stylePane.textContent = "YouTube video player\nClick Play in the video frame.";
  renderTabs();
}

function showUnsupportedYouTubePage(tab: Tab, url: string): void {
  externalEmbeds.delete(tab);
  syncExternalFrame();
  tab.loadHTML(`<html><head><title>YouTube homepage</title><style>
    body{font-family:system-ui,sans-serif;background:#f8f9fa;color:#212529;margin:0;padding:36px}
    main{max-width:760px;margin:24px auto;background:white;border:1px solid #dee2e6;border-radius:12px;padding:28px}
    h1{margin-top:0}code{background:#f1f3f5;padding:2px 6px;border-radius:4px}
    </style></head><body><main><h1>YouTube’s full interface isn’t supported in Titan</h1>
    <p>Titan draws pages with its own canvas renderer and can’t run the full YouTube web app.</p>
    <p>Direct video links can show YouTube’s embedded player inside Titan.</p></main></body></html>`, url);
  tab.history = tab.history.slice(0, tab.hIndex + 1);
  tab.history.push(url);
  tab.hIndex = tab.history.length - 1;
  statsEl.textContent = `Unsupported page · ${url}`;
  domTree.textContent = "YouTube homepage is not rendered by Titan";
  stylePane.textContent = "Direct YouTube watch links use the embedded video player.\nThe full homepage requires a Chromium based renderer.";
  paint();
  renderTabs();
}

function sizeCanvas(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  paint(dpr);
}

function paint(dpr = 1): void {
  const tab = browser.current();
  // canvas CSS size -> engine viewport mapping (engine is 1280 wide; scale to fit)
  const r = canvas.getBoundingClientRect();
  const scale = r.width / VW;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform((canvas.width / VW), 0, 0, (canvas.width / VW), 0, -tab.scrollY * (canvas.width / VW));
  if (tab.layoutRoot) {
    // rasterize in engine coords; temporarily adjust for dpr via transform above
    ctx.save();
    rasterize(tab.displayList, ctx, { width: VW, height: VH }, 1);
    ctx.restore();
  }
  void scale; void dpr;
  const s = tab.snapshot();
  statsEl.textContent = `${s.title} · ${s.boxes} boxes · ${s.cmds} paint cmds · cache ${tab.net.hits}h/${tab.net.misses}m · ${tab.url}`;
  renderDomTree();
}

function renderTabs(): void {
  tabstrip.innerHTML = "";
  browser.tabs.forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "tab" + (i === browser.active ? " active" : "");
    d.textContent = (t.title || "New Tab").slice(0, 18) + (t.loading ? "…" : "");
    d.onclick = () => { browser.switch(i); omnibox.value = browser.current().url; browser.current().onPaint = () => paint(); syncExternalFrame(); paint(); renderTabs(); };
    const x = document.createElement("span");
    x.textContent = " ×"; x.onclick = (e) => { e.stopPropagation(); browser.closeTab(i); syncExternalFrame(); renderTabs(); paint(); };
    d.appendChild(x);
    tabstrip.appendChild(d);
  });
}

function renderDomTree(): void {
  const tab = browser.current();
  if (!tab.doc?.documentElement) { domTree.textContent = "(no document)"; return; }
  const lines: string[] = [];
  const walk = (el: TitanElement, d: number): void => {
    const pad = "  ".repeat(d);
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className ? `.${String(el.className).split(/\s+/).join(".")}` : "";
    lines.push(`${pad}<${el.tagName}${id}${cls}>`);
    if (lines.length > 400) return;
    for (const c of Array.from(el.children)) walk(c as TitanElement, d + 1);
  };
  try { walk(tab.doc.documentElement as unknown as TitanElement, 0); } catch { }
  domTree.textContent = lines.join("\n");
}

async function go(url: string): Promise<void> {
  url = url.trim() || "titan://welcome";
  if (!/^(titan:\/\/|about:|data:|https?:\/\/)/.test(url)) {
    if (url.includes(".") && !url.includes(" ")) url = "https://" + url;
    else url = "titan://welcome";
  }
  omnibox.value = url;
  const tab = browser.current();
  const embed = youtubeEmbedURL(url);
  if (embed) {
    showYouTubePlayer(tab, url, embed);
    return;
  }
  if (isYouTubeURL(url)) {
    showUnsupportedYouTubePage(tab, url);
    return;
  }
  externalEmbeds.delete(tab);
  syncExternalFrame();
  tab.onPaint = () => { paint(); renderTabs(); };
  await tab.navigate(url);
  paint(); renderTabs();
  const s = tab.snapshot();
  stylePane.textContent = `title: ${s.title}\nurl: ${s.url}\nboxes: ${s.boxes}\ncmds: ${s.cmds}`;
}

// ---- wire UI ----
btnGo.onclick = () => void go(omnibox.value);
omnibox.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void go(omnibox.value); });
btnBack.onclick = () => {
  const tab = browser.current();
  if (tab.hIndex > 0) {
    tab.hIndex--;
    const url = tab.history[tab.hIndex];
    const embed = youtubeEmbedURL(url);
    if (embed) { showYouTubePlayer(tab, url, embed, false); omnibox.value = url; }
    else { externalEmbeds.delete(tab); syncExternalFrame(); void tab.navigate(url, false).then(() => { paint(); omnibox.value = url; }); }
  }
};
btnFwd.onclick = () => {
  const tab = browser.current();
  if (tab.hIndex < tab.history.length - 1) {
    tab.hIndex++;
    const url = tab.history[tab.hIndex];
    const embed = youtubeEmbedURL(url);
    if (embed) { showYouTubePlayer(tab, url, embed, false); omnibox.value = url; }
    else { externalEmbeds.delete(tab); syncExternalFrame(); void tab.navigate(url, false).then(() => { paint(); omnibox.value = url; }); }
  }
};
btnReload.onclick = () => void go(browser.current().url);
btnNew.onclick = () => { browser.newTab(); browser.current().onPaint = () => paint(); syncExternalFrame(); renderTabs(); paint(); omnibox.value = "titan://welcome"; void go("titan://welcome"); };

canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * (VW / r.width);
  const py = (e.clientY - r.top) * (VW / r.width);
  const res = browser.current().clickAt(px, py);
  void res;
  paint();
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const tab = browser.current();
  tab.scrollY = Math.max(0, tab.scrollY + e.deltaY);
  paint();
}, { passive: false });

conIn.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") {
    const code = conIn.value;
    const line = document.createElement("div");
    line.textContent = "> " + code;
    line.style.color = "#1971c2";
    conOut.appendChild(line);
    const out = browser.current().evalJS(code);
    const line2 = document.createElement("div");
    line2.textContent = String(out);
    conOut.appendChild(line2);
    conIn.value = "";
  }
});

// pump event loop @60fps
setInterval(() => {
  let work = false;
  for (const t of browser.tabs) {
    const n = t.loop.tick(16);
    if (n) work = true;
    if (t.needsRerender) { t.rerender(); if (t === browser.current()) paint(); work = true; }
  }
  if (work && browser.tabs.length) paint();
}, 16);

window.addEventListener("resize", sizeCanvas);

// boot
uiLog("[titan] engine booted (build with reader-fallback + local-proxy support)");
browser.newTab();
browser.current().onPaint = () => { paint(); renderTabs(); };
omnibox.value = "titan://welcome";
renderTabs();
void go("titan://welcome").then(() => sizeCanvas());
sizeCanvas();
