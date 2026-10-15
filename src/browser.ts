// ============================================================
// TITAN ENGINE — browser.ts : event loop, network/cache,
// Tab pipeline (parse→style→layout→paint→script), Browser.
// ============================================================
import { Document, Element, EngineEvent } from "./dom.js";
import { parseHTML } from "./html.js";
import { parseStylesheet, computeStyles, installMatcher, type Stylesheet } from "./css.js";
import { buildBoxTree, layout, findBoxAt, type LayoutBox, type Viewport } from "./layout.js";
import { buildDisplayList, type PaintCmd } from "./paint.js";
import { Interpreter, type HostHooks } from "./js.js";
import { installPageGlobals } from "./bindings.js";
import { injectReaderFallback } from "./fallback.js";

// ---------------- Event loop ----------------
export class EventLoop {
  micro: (() => void)[] = [];
  macro: (() => void)[] = [];
  timers = new Map<number, { fn: (...a: never[]) => void; ms: number; next: number; repeat: boolean }>();
  private nextId = 1;
  now = 0;
  raf: ((t: number) => void)[] = [];

  queueMicrotask(fn: () => void): void { this.micro.push(fn); }
  setTimeout(fn: (...a: never[]) => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms: Math.max(0, ms), next: this.now + Math.max(0, ms), repeat: false });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  setInterval(fn: (...a: never[]) => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms: Math.max(0, ms), next: this.now + Math.max(0, ms), repeat: true });
    return id;
  }
  clearInterval(id: number): void { this.timers.delete(id); }
  requestAnimationFrame(fn: (t: number) => void): number {
    this.raf.push(fn);
    return this.raf.length;
  }
  postTask(fn: () => void): void { this.macro.push(fn); }

  /** advance virtual time and run due work; returns # tasks run */
  tick(dt = 16): number {
    this.now += dt;
    let ran = 0;
    // rAF
    if (this.raf.length) {
      const fns = this.raf.splice(0);
      for (const f of fns) { try { f(this.now); } catch { } ran++; }
    }
    // timers due
    for (const [id, t] of [...this.timers]) {
      if (t.next <= this.now) {
        try { t.fn(); } catch { }
        ran++;
        if (t.repeat) t.next = this.now + t.ms;
        else this.timers.delete(id);
      }
    }
    // macro
    const macros = this.macro.splice(0);
    for (const m of macros) { try { m(); } catch { } ran++; }
    // micro (until empty, bounded)
    let guard = 0;
    while (this.micro.length && guard++ < 1000) {
      const f = this.micro.shift()!;
      try { f(); } catch { }
      ran++;
    }
    return ran;
  }
  drain(maxTicks = 50): void {
    for (let i = 0; i < maxTicks; i++) {
      const before = this.micro.length + this.macro.length + this.raf.length;
      this.tick(16);
      if (this.micro.length + this.macro.length + this.raf.length === 0 && before === 0) break;
    }
  }
}

// ---------------- Network ----------------
export type Fetcher = (url: string) => Promise<string>;

export class NetworkCache {
  mem = new Map<string, { body: string; at: number }>();
  maxAge = 60_000;
  hits = 0; misses = 0;
  constructor(private fetcher: Fetcher) {}
  async fetch(url: string): Promise<string> {
    const c = this.mem.get(url);
    if (c && Date.now() - c.at < this.maxAge) { this.hits++; return c.body; }
    this.misses++;
    const body = await this.fetcher(url);
    this.mem.set(url, { body, at: Date.now() });
    return body;
  }
  clear(): void { this.mem.clear(); }
}

// ---------------- Tab ----------------
export interface TabOptions {
  viewport: Viewport;
  fetcher: Fetcher;
  consoleLog?: (...a: unknown[]) => void;
}

export class Tab {
  url = "about:blank";
  history: string[] = [];
  hIndex = -1;
  doc: Document | null = null;
  sheets: Stylesheet[] = [];
  layoutRoot: LayoutBox | null = null;
  displayList: PaintCmd[] = [];
  scrollY = 0;
  title = "";
  loading = false;
  logs: string[] = [];
  loop = new EventLoop();
  net: NetworkCache;
  viewport: Viewport;
  storage = new Map<string, Map<string, string>>();
  interp: Interpreter | null = null;
  needsRerender = false;
  onPaint: (() => void) | null = null;

  constructor(opts: TabOptions) {
    this.viewport = opts.viewport;
    this.net = new NetworkCache(opts.fetcher);
    this.consoleLog = opts.consoleLog ?? ((...a: unknown[]) => { this.logs.push(a.map(String).join(" ")); });
  }
  private consoleLog: (...a: unknown[]) => void;

  async navigate(url: string, pushHistory = true): Promise<void> {
    url = resolveURL(url, this.url);
    this.loading = true;
    try {
      if (url.startsWith("about:")) {
        this.loadHTML(url === "about:blank" ? "<html><head><title>New Tab</title></head><body></body></html>" : `<h1>${url}</h1>`, url);
      } else if (url.startsWith("data:text/html,")) {
        this.loadHTML(decodeURIComponent(url.slice("data:text/html,".length)), url);
      } else {
        const html = await this.net.fetch(url);
        this.loadHTML(html, url);
      }
      if (pushHistory) {
        this.history = this.history.slice(0, this.hIndex + 1);
        this.history.push(url);
        this.hIndex = this.history.length - 1;
      }
      this.url = url;
    } catch (e) {
      const msg = escapeHtml(String(e));
      // Rich error page: shows what failed and why (usually CORS or offline),
      // instead of a dead blank tab.
      this.loadHTML(
        `<html><head><title>Failed to load</title><style>body{font-family:system-ui,sans-serif;background:#fff5f5;color:#331010;margin:0;padding:32px}code{background:#ffe3e3;padding:2px 6px;border-radius:4px}.box{max-width:760px;margin:auto;background:#fff;border:1px solid #ffc9c9;border-radius:12px;padding:24px}</style></head>` +
        `<body><div class="box"><h1>⚠️ Couldn't load this page</h1>` +
        `<p><code>${escapeHtml(url)}</code></p>` +
        `<p><b>Error:</b> <code>${msg}</code></p>` +
        `<p>Common causes: the site blocks cross-origin reads (<b>CORS</b> — youtube.com does this), ` +
        `you opened <code>index.html</code> via <code>file://</code>, or you're offline. ` +
        `Titan retries automatically (local helper → public proxies).</p>` +
        `<p>For <b>youtube.com</b> specifically: public proxies are bot-blocked by Google, so run the local ` +
        `fetch helper in a second terminal — <code>npm run proxy</code> — then reload this page.</p>` +
        `<p>Try: <code>titan://welcome</code>, a CORS-enabled site like <code>https://example.com</code>, ` +
        `or serve this folder over HTTP and retry. Details are in the DevTools console.</p></div></body></html>`,
        url,
      );
      this.consoleLog("[load-error]", String(e).slice(0, 300));
      this.url = url;
    } finally {
      this.loading = false;
      this.onPaint?.();
    }
  }

  back(): Promise<void> | void {
    if (this.hIndex > 0) { this.hIndex--; return this.navigate(this.history[this.hIndex], false); }
  }
  forward(): Promise<void> | void {
    if (this.hIndex < this.history.length - 1) { this.hIndex++; return this.navigate(this.history[this.hIndex], false); }
  }

  loadHTML(html: string, url: string): void {
    this.url = url;
    const doc = parseHTML(html, url);
    installMatcher(doc);
    this.doc = doc;
    // collect CSS
    const cssTexts: string[] = [];
    for (const st of doc.querySelectorAll("style")) cssTexts.push(st.textContent ?? "");
    // link stylesheets: resolve + fetch synchronously? mark async upgrade
    const links = doc.querySelectorAll('link[rel="stylesheet"]');
    const pending: Promise<void>[] = [];
    for (const l of links) {
      const href = l.getAttribute("href");
      if (href) {
        const abs = resolveURL(href, url);
        pending.push(this.net.fetch(abs).then(t => { cssTexts.push(t); }).catch(() => {}));
      }
    }
    const finish = () => {
      this.sheets = cssTexts.map(parseStylesheet);
      this.render();
      this.runScripts();
      // re-render after async CSS arrives
      if (pending.length) {
        Promise.all(pending).then(() => {
          // re-collect (cssTexts mutated)
          this.sheets = cssTexts.map(parseStylesheet);
          this.render();
          this.onPaint?.();
        });
      }
    };
    finish();
    this.title = doc.title || url;
  }

  render(): void {
    const doc = this.doc;
    if (!doc) return;
    this.renderInner();
    // Reader fallback: re-evaluate from scratch each pass so the panel
    // disappears on its own if scripts later produce real visible content.
    // NOTE: must re-check substance AFTER removing the panel — otherwise an
    // async CSS re-render removes the panel and leaves a bare shell.
    const fb = doc.getElementById("titan-reader-fallback");
    if (fb) {
      fb.parentNode?.removeChild(fb);
      this.renderInner();
    }
    // Only for real web pages that depend on JS: a small static page with no
    // scripts renders exactly what it is — leave it alone. Blank tabs / demo
    // pages must stay untouched.
    const looksLikeShell = doc.getElementsByTagName("script").length > 0;
    if (/^https?:\/\//.test(this.url) && looksLikeShell && !this.hasRealContent() && doc.body) {
      if (injectReaderFallback(doc)) {
        this.renderInner();
        if (!fb) this.consoleLog("[reader] JS-shell page — showing extracted summary");
      }
    }
  }

  /** true when the page has enough genuine visible content to stand alone. */
  private hasRealContent(): boolean {
    let text = 0;
    for (const c of this.displayList) {
      if (c.kind === "text" && c.text.trim().length > 0) text++;
    }
    return this.displayList.length >= 30 && text >= 10;
  }

  private renderInner(): void {
    const doc = this.doc;
    if (!doc) return;
    const vw = this.viewport.width, vh = this.viewport.height;
    computeStyles(doc, this.sheets, {
      viewportWidth: vw, viewportHeight: vh,
      matchCtx: { hoverElement: null, focusElement: null, activeElement: null, viewportWidth: vw, viewportHeight: vh },
    });
    const root = buildBoxTree(doc);
    if (!root) return;
    layout(root, this.viewport);
    this.layoutRoot = root;
    this.displayList = buildDisplayList(root);
    this.needsRerender = false;
  }

  rerender(): void {
    this.render();
    this.onPaint?.();
  }

  private runScripts(): void {
    if (!this.doc) return;
    const scripts = this.doc.querySelectorAll("script");
    if (!scripts.length) return;
    const hooks: HostHooks = {
      setTimeout: (fn, ms) => this.loop.setTimeout(fn, ms),
      clearTimeout: (id) => this.loop.clearTimeout(id),
      setInterval: (fn, ms) => this.loop.setInterval(fn, ms),
      clearInterval: (id) => this.loop.clearInterval(id),
      queueMicrotask: (fn) => this.loop.queueMicrotask(fn),
      fetch: async (url: string) => {
        try { return await this.net.fetch(resolveURL(url, this.url)); }
        catch { return ""; }
      },
      consoleLog: (...a: unknown[]) => this.consoleLog(...a),
    };
    this.interp = new Interpreter(hooks);
    const ctx = {
      onNeedRerender: () => { this.needsRerender = true; },
      navigate: (u: string) => { void this.navigate(u); },
      getURL: () => this.url,
      fetchPage: (u: string) => this.net.fetch(resolveURL(u, this.url)),
      storage: this.storage,
    };
    installPageGlobals(this.interp, this.doc, ctx);
    // Guard rails for real-world pages (youtube.com ships ~1MB of HTML and
    // dozens of heavy scripts). Without caps one hostile page can hang the tab.
    const MAX_INLINE_SCRIPT = 300_000;   // chars — larger inline scripts are skipped
    const MAX_EXTERNAL_SCRIPT = 500_000; // chars — larger downloads are skipped
    const MAX_SCRIPTS = 40;              // max scripts executed per page
    const SCRIPT_BUDGET_MS = 4000;       // total wall-clock budget for page scripts
    const budgetStart = Date.now();
    let ranCount = 0;
    const budgetLeft = (): boolean => {
      if (ranCount >= MAX_SCRIPTS) { this.consoleLog("[js] script limit reached, skipping rest"); return false; }
      if (Date.now() - budgetStart > SCRIPT_BUDGET_MS) { this.consoleLog("[js] script time budget exceeded, skipping rest"); return false; }
      return true;
    };
    const runOne = (code: string, label: string) => {
      if (!budgetLeft()) return;
      if (code.length > MAX_INLINE_SCRIPT) {
        this.consoleLog(`[js] skipped ${label} (${code.length} chars > cap)`);
        return;
      }
      ranCount++;
      try { this.interp!.run(code); }
      catch (e) { this.consoleLog("[js-error]", String(e).slice(0, 300)); }
    };
    const asyncSrc: { el: Element; abs: string }[] = [];
    for (const s of scripts) {
      const src = s.getAttribute("src");
      if (src) asyncSrc.push({ el: s, abs: resolveURL(src, this.url) });
      else {
        const code = s.textContent ?? "";
        if (code.trim()) runOne(code, "inline script");
      }
    }
    if (asyncSrc.length) {
      const capped = asyncSrc.slice(0, MAX_SCRIPTS);
      if (asyncSrc.length > capped.length) this.consoleLog(`[js] ${asyncSrc.length - capped.length} external scripts skipped (over limit)`);
      void Promise.all(capped.map(a =>
        this.net.fetch(a.abs).then(code => {
          if (code.length > MAX_EXTERNAL_SCRIPT) this.consoleLog(`[js] skipped ${a.abs.slice(0, 80)} (${code.length} chars > cap)`);
          else runOne(code, a.abs.slice(0, 80));
        }).catch(() => {})
      )).then(() => {
        this.loop.drain();
        if (this.needsRerender) this.rerender();
        else this.onPaint?.();
        this.doc!.dispatchEvent(new EngineEvent("load", { bubbles: false }));
      });
    } else {
      this.loop.drain();
      if (this.needsRerender) this.rerender();
      this.doc.dispatchEvent(new EngineEvent("DOMContentLoaded", { bubbles: false }));
      this.doc.dispatchEvent(new EngineEvent("load", { bubbles: false }));
    }
  }

  evalJS(code: string): unknown {
    if (!this.interp || !this.doc) return "[no-page]";
    try {
      const r = this.interp.run(code);
      if (this.needsRerender) this.rerender();
      return r ?? "undefined";
    } catch (e) { return String(e); }
  }

  clickAt(px: number, py: number): string {
    if (!this.layoutRoot || !this.doc) return "no-page";
    const y = py + this.scrollY;
    const box = findBoxAt(this.layoutRoot, px, y);
    const el = box?.el ?? (box?.text?.parentNode instanceof Element ? box.text.parentNode : null);
    if (!el) return "miss";
    // focus form fields
    if (["input", "textarea", "button", "a"].includes(el.tagName)) el.focus();
    el.dispatchEvent(new EngineEvent("click", { bubbles: true }));
    // default action: links + buttons
    if (el.tagName === "a") {
      const href = el.getAttribute("href");
      if (href) { void this.navigate(href); return `navigate:${href}`; }
    }
    if (el.tagName === "input" && (el.getAttribute("type") ?? "text") === "checkbox") {
      el.checked = !el.checked;
      if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked");
    }
    if (this.needsRerender) this.rerender();
    this.onPaint?.();
    return `clicked:<${el.tagName}>`;
  }

  snapshot(): { boxes: number; cmds: number; title: string; url: string } {
    return {
      boxes: this.layoutRoot ? countBoxes(this.layoutRoot) : 0,
      cmds: this.displayList.length,
      title: this.title, url: this.url,
    };
  }
}

function countBoxes(b: LayoutBox): number {
  return 1 + b.children.reduce((a, c) => a + countBoxes(c), 0);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function resolveURL(input: string, base: string): string {
  input = input.trim();
  if (/^(about:|data:|javascript:)/.test(input)) return input;
  if (/^https?:\/\//.test(input)) return input;
  if (input.startsWith("//")) return "https:" + input;
  try {
    if (base.startsWith("http")) return new URL(input, base).toString();
  } catch { /* ignore */ }
  if (input.startsWith("/")) return input;
  return input;
}

// ---------------- Browser ----------------
export class Browser {
  tabs: Tab[] = [];
  active = 0;
  bookmarks: { title: string; url: string }[] = [];
  constructor(private opts: TabOptions) {}
  newTab(url = "about:blank"): Tab {
    const t = new Tab(this.opts);
    this.tabs.push(t);
    this.active = this.tabs.length - 1;
    if (url !== "about:blank") void t.navigate(url);
    else t.loadHTML("<html><head><title>New Tab</title></head><body></body></html>", "about:blank");
    return t;
  }
  current(): Tab { return this.tabs[this.active]; }
  closeTab(i = this.active): void {
    this.tabs.splice(i, 1);
    if (!this.tabs.length) this.newTab();
    this.active = Math.min(this.active, this.tabs.length - 1);
  }
  switch(i: number): void { if (this.tabs[i]) this.active = i; }
  bookmarkCurrent(): void {
    const t = this.current();
    if (!this.bookmarks.some(b => b.url === t.url)) this.bookmarks.push({ title: t.title, url: t.url });
  }
}
