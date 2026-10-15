// ============================================================
// TITAN ENGINE — dom.ts : DOM core (Node, Element, Document,
// EventTarget, events, tree ops, serialization, query API)
// ============================================================

export const enum NodeType {
  ELEMENT_NODE = 1,
  TEXT_NODE = 3,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
}

export type EventListener = (e: EngineEvent) => void;

export class EngineEvent {
  type: string;
  target: EventTargetNode | null = null;
  currentTarget: EventTargetNode | null = null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  immediateStopped = false;
  // mouse-ish extras
  clientX = 0; clientY = 0; key = "";
  detail: unknown = null;
  timeStamp = Date.now();
  eventPhase: 0 | 1 | 2 | 3 = 0; // none/capture/at/bubble

  constructor(type: string, opts: { bubbles?: boolean; cancelable?: boolean; detail?: unknown } = {}) {
    this.type = type;
    this.bubbles = opts.bubbles ?? (type.startsWith("mouse") || type === "click");
    this.cancelable = opts.cancelable ?? true;
    this.detail = opts.detail ?? null;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; }
}

interface ListenerEntry { fn: EventListener; capture: boolean; once: boolean; passive: boolean }

export class EventTargetNode {
  private listeners = new Map<string, ListenerEntry[]>();

  addEventListener(type: string, fn: EventListener, opts?: boolean | { capture?: boolean; once?: boolean; passive?: boolean }): void {
    const o = typeof opts === "boolean" ? { capture: opts } : (opts ?? {});
    const arr = this.listeners.get(type) ?? [];
    if (arr.some(l => l.fn === fn && l.capture === !!o.capture)) return;
    arr.push({ fn, capture: !!o.capture, once: !!o.once, passive: !!o.passive });
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: EventListener, opts?: boolean | { capture?: boolean }): void {
    const cap = typeof opts === "boolean" ? opts : !!opts?.capture;
    const arr = this.listeners.get(type);
    if (!arr) return;
    this.listeners.set(type, arr.filter(l => !(l.fn === fn && l.capture === cap)));
  }
  /** internal dispatch along composed path */
  _invoke(type: string, e: EngineEvent, capturePhase: boolean): boolean {
    const arr = [...(this.listeners.get(type) ?? [])];
    for (const l of arr) {
      if (l.capture !== capturePhase) continue;
      if (l.once) this.removeEventListener(type, l.fn, l.capture);
      e.currentTarget = this;
      try { l.fn.call(this, e); } catch { /* listener errors don't break dispatch */ }
      if (e.immediateStopped) break;
    }
    // inline on* handler e.g. onclick
    const inline = (this as unknown as Record<string, unknown>)["on" + type];
    if (typeof inline === "function" && !capturePhase) {
      try { (inline as (ev: EngineEvent) => void).call(this, e); } catch { }
    }
    return !e.defaultPrevented;
  }
  _has(type: string): boolean { return this.listeners.has(type); }
}

let __uid = 1;

export abstract class Node extends EventTargetNode {
  uid = __uid++;
  nodeType!: NodeType;
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  ownerDocument: Document | null = null;
  _hover = false; _focus = false; _active = false;

  get parentElement(): Element | null {
    let p = this.parentNode;
    while (p) { if (p instanceof Element) return p; p = p.parentNode; }
    return null;
  }
  get nextSibling(): Node | null {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): Node | null {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    const i = s.indexOf(this);
    return i > 0 ? s[i - 1] : null;
  }
  get nextElementSibling(): Element | null {
    let n = this.nextSibling;
    while (n) { if (n instanceof Element) return n; n = n.nextSibling; }
    return null;
  }
  get previousElementSibling(): Element | null {
    let n = this.previousSibling;
    while (n) { if (n instanceof Element) return n; n = n.previousSibling; }
    return null;
  }
  get firstChild(): Node | null { return this.childNodes[0] ?? null; }
  get lastChild(): Node | null { return this.childNodes[this.childNodes.length - 1] ?? null; }

  appendChild<T extends Node>(c: T): T {
    if (c instanceof DocumentFragment) {
      for (const k of [...c.childNodes]) this.appendChild(k as unknown as T);
      return c as unknown as T;
    }
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    if (!c.ownerDocument) c.ownerDocument = this.ownerDocument ?? (this instanceof Document ? this : null);
    this.childNodes.push(c);
    Document._mutated(this, "childList", c);
    return c;
  }
  removeChild<T extends Node>(c: T): T {
    const i = this.childNodes.indexOf(c);
    if (i === -1) throw new Error("NotFoundError: node is not a child");
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    Document._mutated(this, "childList", c);
    return c;
  }
  insertBefore<T extends Node>(c: T, ref: Node | null): T {
    if (ref === null) return this.appendChild(c);
    const i = this.childNodes.indexOf(ref);
    if (i === -1) throw new Error("NotFoundError: reference node is not a child");
    if (c instanceof DocumentFragment) {
      for (const k of [...c.childNodes]) { this.childNodes.splice(i, 0, k); k.parentNode = this; }
      return c as unknown as T;
    }
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(i, 0, c as unknown as Node);
    Document._mutated(this, "childList", c as unknown as Node);
    return c;
  }
  replaceChild<T extends Node>(nw: Node, old: T): T {
    this.insertBefore(nw, old);
    return this.removeChild(old);
  }
  contains(n: Node | null): boolean {
    let c: Node | null = n;
    while (c) { if (c === this) return true; c = c.parentNode; }
    return false;
  }
  cloneNode(deep = false): Node {
    throw new Error("cloneNode must be overridden");
  }
  get textContent(): string | null {
    return this.childNodes.map(c => c.textContent ?? "").join("");
  }
  set textContent(v: string | null) {
    this.childNodes = [];
    if (v) this.appendChild(this.ownerDocument!.createTextNode(v));
  }

  dispatchEvent(e: EngineEvent): boolean {
    e.target = this;
    // build propagation path root->...->target
    const path: Node[] = [];
    let n: Node | null = this;
    while (n) { path.unshift(n); n = n.parentNode; }
    e.eventPhase = 1;
    for (let i = 0; i < path.length - 1 && !e.propagationStopped; i++) {
      path[i]._invoke(e.type, e, true);
    }
    if (!e.propagationStopped) {
      e.eventPhase = 2;
      this._invoke(e.type, e, true);
      this._invoke(e.type, e, false);
    }
    if (e.bubbles && !e.propagationStopped) {
      e.eventPhase = 3;
      for (let i = path.length - 2; i >= 0 && !e.propagationStopped; i--) {
        path[i]._invoke(e.type, e, false);
      }
    }
    e.eventPhase = 0;
    return !e.defaultPrevented;
  }

  abstract toHTML(): string;
}

export class DocumentTypeNode extends Node {
  nodeType = NodeType.DOCUMENT_TYPE_NODE as NodeType;
  constructor(public name = "html", public publicId = "", public systemId = "") { super(); }
  cloneNode(): Node { return new DocumentTypeNode(this.name, this.publicId, this.systemId); }
  toHTML(): string { return `<!DOCTYPE ${this.name}>`; }
}

export class Text extends Node {
  nodeType = NodeType.TEXT_NODE as NodeType;
  constructor(public data = "") { super(); }
  get textContent(): string { return this.data; }
  set textContent(v: string | null) { this.data = v ?? ""; }
  get wholeText(): string { return this.data; }
  splitText(offset: number): Text {
    const t = new Text(this.data.slice(offset));
    t.ownerDocument = this.ownerDocument;
    this.data = this.data.slice(0, offset);
    this.parentNode?.insertBefore(t, this.nextSibling);
    return t;
  }
  cloneNode(): Node { const t = new Text(this.data); t.ownerDocument = this.ownerDocument; return t; }
  toHTML(): string { return escapeHTML(this.data); }
}

export class Comment extends Node {
  nodeType = NodeType.COMMENT_NODE as NodeType;
  constructor(public data = "") { super(); }
  cloneNode(): Node { return new Comment(this.data); }
  toHTML(): string { return `<!--${this.data}-->`; }
}

export class DocumentFragment extends Node {
  nodeType = NodeType.DOCUMENT_FRAGMENT_NODE as NodeType;
  cloneNode(deep = false): Node {
    const f = new DocumentFragment();
    if (deep) for (const c of this.childNodes) f.appendChild(c.cloneNode(true));
    return f;
  }
  toHTML(): string { return this.childNodes.map(c => c.toHTML()).join(""); }
}

export class Attr {
  constructor(public name: string, public value: string, public ownerElement: Element | null = null) {}
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHTML(s).replace(/"/g, "&quot;");
}

export class DOMTokenList {
  constructor(private el: Element, private attr: string) {}
  private parts(): string[] { return (this.el.getAttribute(this.attr) ?? "").split(/\s+/).filter(Boolean); }
  private commit(p: string[]): void { this.el.setAttribute(this.attr, p.join(" ")); }
  get value(): string { return this.parts().join(" "); }
  get length(): number { return this.parts().length; }
  add(...t: string[]): void { const s = new Set(this.parts()); t.forEach(x => s.add(x)); this.commit([...s]); }
  remove(...t: string[]): void { const s = new Set(this.parts()); t.forEach(x => s.delete(x)); this.commit([...s]); }
  toggle(t: string, force?: boolean): boolean {
    const s = new Set(this.parts());
    const has = s.has(t);
    const want = force ?? !has;
    if (want) s.add(t); else s.delete(t);
    this.commit([...s]); return want;
  }
  contains(t: string): boolean { return this.parts().includes(t); }
  item(i: number): string | null { return this.parts()[i] ?? null; }
  [Symbol.iterator]() { return this.parts()[Symbol.iterator](); }
}

export class Element extends Node {
  nodeType = NodeType.ELEMENT_NODE as NodeType;
  attributes: Attr[] = [];
  // layout/style attachments (filled by style/layout passes)
  computedStyle: Map<string, string> = new Map();
  // form states
  checked = false; disabled = false;

  constructor(public tagName: string) { super(); this.tagName = tagName.toLowerCase(); }
  get localName(): string { return this.tagName; }
  get nodeName(): string { return this.tagName.toUpperCase(); }

  getAttribute(name: string): string | null {
    name = name.toLowerCase();
    return this.attributes.find(a => a.name === name)?.value ?? null;
  }
  setAttribute(name: string, value: string): void {
    name = name.toLowerCase();
    const f = this.attributes.find(a => a.name === name);
    if (f) f.value = String(value);
    else this.attributes.push(new Attr(name, String(value), this));
    if (name === "id" || name === "class") Document._mutated(this, "attributes", null);
  }
  removeAttribute(name: string): void {
    name = name.toLowerCase();
    this.attributes = this.attributes.filter(a => a.name !== name);
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }

  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(v: string) { this.setAttribute("id", v); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", v); }
  get classList(): DOMTokenList { return new DOMTokenList(this, "class"); }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.attributes) if (a.name.startsWith("data-")) {
      const k = a.name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      out[k] = a.value;
    }
    return out;
  }
  get innerHTML(): string { return this.childNodes.map(c => c.toHTML()).join(""); }
  set innerHTML(_v: string) { throw new Error("innerHTML setter lives in html parser (import cycle avoided) — use Document.parseHTML"); }
  get outerHTML(): string {
    const attrs = this.attributes.map(a => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
    if (isVoidElement(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }
  get children(): Element[] { return this.childNodes.filter((n): n is Element => n instanceof Element); }
  get firstElementChild(): Element | null { return this.children[0] ?? null; }
  get lastElementChild(): Element | null { const c = this.children; return c[c.length - 1] ?? null; }
  get childElementCount(): number { return this.children.length; }

  matchesSimple(sel: string): boolean {
    // tiny fast-path for getElementById/class/tag; full engine in selectors.ts
    sel = sel.trim();
    if (!sel) return false;
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) return this.tagName === sel.toLowerCase();
    if (sel === "*") return true;
    return false;
  }

  closest(selector: string): Element | null {
    let el: Element | null = this;
    // lazy import avoided: use ownerDocument matcher hook if installed
    const doc = this.ownerDocument;
    const match = doc?._matcher ?? ((s: string, e: Element) => e.matchesSimple(s));
    while (el) { try { if (match(selector, el)) return el; } catch { } el = el.parentElement; }
    return null;
  }

  querySelectorAll(selector: string): Element[] {
    const doc = this.ownerDocument;
    const match = doc?._matcher;
    const out: Element[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c instanceof Element) {
          let ok = false;
          try { ok = match ? match(selector, c) : c.matchesSimple(selector); } catch { ok = false; }
          if (ok) out.push(c);
          walk(c);
        } else walk(c);
      }
    };
    // support comma groups
    const groups = selector.split(",").map(s => s.trim()).filter(Boolean);
    if (!match || groups.length <= 1) { walk(this); return out; }
    const seen = new Set<Element>();
    for (const g of groups) {
      const sub: Element[] = [];
      const w = (n: Node) => {
        for (const c of n.childNodes) {
          if (c instanceof Element) { try { if (match(g, c)) sub.push(c); } catch { } w(c); }
          else if (c.childNodes.length) w(c);
        }
      };
      w(this);
      for (const e of sub) if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
    return out;
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }

  getElementsByTagName(tag: string): Element[] {
    tag = tag.toLowerCase(); const out: Element[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c instanceof Element) { if (tag === "*" || c.tagName === tag) out.push(c); walk(c); }
      }
    };
    walk(this); return out;
  }
  getElementsByClassName(cls: string): Element[] {
    const out: Element[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c instanceof Element) { if (c.classList.contains(cls)) out.push(c); walk(c); }
      }
    };
    walk(this); return out;
  }
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number } {
    const box = (this as unknown as { _box?: { x: number; y: number; width: number; height: number } })._box;
    if (!box) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
    return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.y, left: box.x };
  }

  click(): void { this.dispatchEvent(new EngineEvent("click", { bubbles: true })); }
  focus(): void { this._focus = true; this.dispatchEvent(new EngineEvent("focus", { bubbles: false })); }
  blur(): void { this._focus = false; this.dispatchEvent(new EngineEvent("blur", { bubbles: false })); }

  cloneNode(deep = false): Node {
    const e = new Element(this.tagName);
    e.attributes = this.attributes.map(a => new Attr(a.name, a.value, e));
    e.ownerDocument = this.ownerDocument;
    if (deep) for (const c of this.childNodes) e.appendChild(c.cloneNode(true));
    return e;
  }
  toHTML(): string { return this.outerHTML; }
}

export function isVoidElement(tag: string): boolean {
  return new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "circle", "path"]).has(tag.toLowerCase());
}

export class Document extends Node {
  nodeType = NodeType.DOCUMENT_NODE as NodeType;
  documentElement: Element | null = null;
  head: Element | null = null;
  body: Element | null = null;
  title = "";
  URL = "about:blank";
  /** hook installed by selectors.ts for full matching */
  _matcher: ((selector: string, el: Element) => boolean) | null = null;
  private static observers: Set<{ target: Node; cb: () => void }> = new Set();
  static _mutated(_t: Node, _kind: string, _n: Node | null): void {
    for (const o of Document.observers) { try { o.cb(); } catch { } }
  }
  static _observe(target: Node, cb: () => void): () => void {
    const e = { target, cb }; Document.observers.add(e);
    return () => { Document.observers.delete(e); };
  }

  constructor() { super(); this.ownerDocument = this; }

  createElement(tag: string): Element { const e = new Element(tag); e.ownerDocument = this; return e; }
  createTextNode(d: string): Text { const t = new Text(d); t.ownerDocument = this; return t; }
  createComment(d: string): Comment { const c = new Comment(d); c.ownerDocument = this; return c; }
  createDocumentFragment(): DocumentFragment { const f = new DocumentFragment(); f.ownerDocument = this; return f; }

  getElementById(id: string): Element | null {
    const walk = (n: Node): Element | null => {
      for (const c of n.childNodes) {
        if (c instanceof Element) { if (c.id === id) return c; const f = walk(c); if (f) return f; }
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel: string): Element[] {
    const root = this.documentElement ?? this;
    if (root instanceof Element) return root.querySelectorAll(sel);
    const out: Element[] = [];
    const match = this._matcher;
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c instanceof Element) {
          let ok = false;
          try { ok = match ? match(sel, c) : c.matchesSimple(sel); } catch { }
          if (ok) out.push(c);
          walk(c);
        } else walk(c);
      }
    };
    walk(this); return out;
  }
  querySelector(sel: string): Element | null { return this.querySelectorAll(sel)[0] ?? null; }
  getElementsByTagName(t: string): Element[] {
    const r = this.documentElement; return r ? r.getElementsByTagName(t) : [];
  }
  getElementsByClassName(c: string): Element[] {
    const r = this.documentElement; return r ? r.getElementsByClassName(c) : [];
  }
  cloneNode(deep = false): Node {
    const d = new Document(); d.URL = this.URL;
    if (deep) for (const c of this.childNodes) d.appendChild(c.cloneNode(true));
    d._refreshRefs(); return d;
  }
  _refreshRefs(): void {
    this.documentElement = this.childNodes.find((n): n is Element => n instanceof Element && n.tagName === "html") ?? null;
    const html = this.documentElement;
    this.head = html?.childNodes.find((n): n is Element => n instanceof Element && n.tagName === "head") ?? null;
    this.body = html?.childNodes.find((n): n is Element => n instanceof Element && n.tagName === "body") ?? null;
  }
  toHTML(): string { return this.childNodes.map(c => c.toHTML()).join(""); }
}
