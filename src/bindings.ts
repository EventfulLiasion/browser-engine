// ============================================================
// TITAN ENGINE — bindings.ts : DOM <-> JS-interpreter bridge.
// Wraps native Element/Document in host objects the script
// engine can call (querySelector, style proxy, events...).
// ============================================================
import { Document, Element, EngineEvent } from "./dom.js";
import { parseHTML } from "./html.js";
import { Interpreter } from "./js.js";

export interface PageContext {
  onNeedRerender: () => void;
  navigate: (url: string) => void;
  getURL: () => string;
  fetchPage: (url: string) => Promise<string>;
  storage: Map<string, Map<string, string>>;
}

const wrapCache = new WeakMap<Element, Record<string, unknown>>();

export function wrapElement(el: Element, interp: Interpreter, ctx: PageContext, doc: Document): Record<string, unknown> {
  const hit = wrapCache.get(el);
  if (hit) return hit;

  const styleProxy = new Proxy({}, {
    get(_t, prop: string) {
      const inline = el.getAttribute("style") ?? "";
      const map = parseStyleAttr(inline);
      const cssProp = camelToCss(prop);
      return map[cssProp] ?? map[prop] ?? "";
    },
    set(_t, prop: string, value: unknown) {
      const inline = el.getAttribute("style") ?? "";
      const map = parseStyleAttr(inline);
      map[camelToCss(String(prop))] = String(value);
      el.setAttribute("style", Object.entries(map).map(([k, v]) => `${k}: ${v}`).join("; "));
      ctx.onNeedRerender();
      return true;
    },
  });

  const host: Record<string, unknown> = {
    __el: el,
    get tagName() { return el.tagName.toUpperCase(); },
    get nodeName() { return el.tagName.toUpperCase(); },
    get id() { return el.id; },
    set id(v: unknown) { el.id = String(v); },
    get className() { return el.className; },
    set className(v: unknown) { el.className = String(v); },
    get textContent() { return el.textContent; },
    set textContent(v: unknown) { el.textContent = String(v); ctx.onNeedRerender(); },
    get innerHTML() { return el.innerHTML; },
    set innerHTML(v: unknown) {
      const frag = parseHTML(`<template>${String(v)}</template>`);
      const tpl = frag.querySelector("template");
      el.childNodes.slice().forEach(c => el.removeChild(c));
      if (tpl) for (const k of [...tpl.childNodes]) el.appendChild(k.cloneNode(true));
      ctx.onNeedRerender();
    },
    get value() { return el.getAttribute("value") ?? ""; },
    set value(v: unknown) { el.setAttribute("value", String(v)); },
    get style() { return styleProxy; },
    get dataset() { return el.dataset; },
    get children() { return el.children.map(c => wrapElement(c, interp, ctx, doc)); },
    get parentNode() { return el.parentNode instanceof Element ? wrapElement(el.parentNode, interp, ctx, doc) : null; },
    classList: {
      add: (...t: string[]) => { el.classList.add(...t); ctx.onNeedRerender(); },
      remove: (...t: string[]) => { el.classList.remove(...t); ctx.onNeedRerender(); },
      toggle: (t: string) => { const r = el.classList.toggle(t); ctx.onNeedRerender(); return r; },
      contains: (t: string) => el.classList.contains(t),
    },
    getAttribute: (n: unknown) => el.getAttribute(String(n)),
    setAttribute: (n: unknown, v: unknown) => { el.setAttribute(String(n), String(v)); ctx.onNeedRerender(); },
    removeAttribute: (n: unknown) => el.removeAttribute(String(n)),
    hasAttribute: (n: unknown) => el.hasAttribute(String(n)),
    addEventListener: (type: unknown, fn: unknown) => {
      if (typeof fn === "function" || (fn && typeof (fn as { call: unknown }).call === "function")) {
        el.addEventListener(String(type), () => {
          const ev = makeEventHost(String(type), host);
          try {
            if (typeof fn === "function") (fn as (e: unknown) => void)(ev);
            else interpHookCall(interp, fn, host, [ev]);
          } catch { /* ignore */ }
        });
      }
    },
    removeEventListener: () => { /* simplified */ },
    appendChild: (child: unknown) => {
      const native = unwrap(child, doc, interp, ctx);
      if (native) { el.appendChild(native); ctx.onNeedRerender(); return child; }
      return null;
    },
    remove: () => { el.parentNode?.removeChild(el); ctx.onNeedRerender(); },
    click: () => el.click(),
    focus: () => el.focus(),
    querySelector: (s: unknown) => {
      const f = el.querySelector(String(s));
      return f ? wrapElement(f, interp, ctx, doc) : null;
    },
    querySelectorAll: (s: unknown) => el.querySelectorAll(String(s)).map(e => wrapElement(e, interp, ctx, doc)),
    getElementsByTagName: (s: unknown) => el.getElementsByTagName(String(s)).map(e => wrapElement(e, interp, ctx, doc)),
    getBoundingClientRect: () => el.getBoundingClientRect(),
  };
  wrapCache.set(el, host);
  return host;
}

function interpHookCall(interp: Interpreter, fn: unknown, thisArg: unknown, args: unknown[]): void {
  // fn is a JSFunction
  const f = fn as { call: (t: unknown, a: unknown[]) => unknown };
  if (f && typeof f.call === "function") f.call(thisArg, args);
}

function makeEventHost(type: string, target: unknown): Record<string, unknown> {
  return {
    type, target, currentTarget: target,
    bubbles: true, cancelable: true, defaultPrevented: false,
    preventDefault() { (this as Record<string, unknown>).defaultPrevented = true; },
    stopPropagation() {}, key: "", clientX: 0, clientY: 0,
  };
}

function parseStyleAttr(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const i = part.indexOf(":");
    if (i === -1) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}
function camelToCss(s: string): string {
  return s.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
}

function unwrap(child: unknown, doc: Document, interp: Interpreter, ctx: PageContext): Element | null {
  if (child && typeof child === "object" && "__el" in (child as object)) {
    return (child as { __el: Element }).__el;
  }
  if (typeof child === "string") {
    const t = doc.createTextNode(child);
    // wrap text in span? append directly needs Node support — create span
    const s = doc.createElement("span");
    s.appendChild(t);
    return s;
  }
  return null;
}

export function installPageGlobals(interp: Interpreter, doc: Document, ctx: PageContext): void {
  const g = interp.global;

  const documentHost: Record<string, unknown> = {
    get title() { return doc.title; },
    set title(v: unknown) { doc.title = String(v); },
    get URL() { return ctx.getURL(); },
    get documentElement() { return doc.documentElement ? wrapElement(doc.documentElement, interp, ctx, doc) : null; },
    get body() { return doc.body ? wrapElement(doc.body, interp, ctx, doc) : null; },
    get head() { return doc.head ? wrapElement(doc.head, interp, ctx, doc) : null; },
    createElement: (tag: unknown) => wrapElement(doc.createElement(String(tag)), interp, ctx, doc),
    createTextNode: (t: unknown) => String(t),
    getElementById: (id: unknown) => {
      const f = doc.getElementById(String(id));
      return f ? wrapElement(f, interp, ctx, doc) : null;
    },
    querySelector: (s: unknown) => {
      try { const f = doc.querySelector(String(s)); return f ? wrapElement(f, interp, ctx, doc) : null; }
      catch { return null; }
    },
    querySelectorAll: (s: unknown) => {
      try { return doc.querySelectorAll(String(s)).map(e => wrapElement(e, interp, ctx, doc)); }
      catch { return []; }
    },
    getElementsByTagName: (s: unknown) => doc.getElementsByTagName(String(s)).map(e => wrapElement(e, interp, ctx, doc)),
    addEventListener: (type: unknown, fn: unknown) => {
      (doc as Document).addEventListener(String(type), () => {
        try { (fn as (e: unknown) => void)(makeEventHost(String(type), documentHost)); } catch { }
      });
    },
  };

  const locationHost: Record<string, unknown> = {
    get href() { return ctx.getURL(); },
    set href(v: unknown) { ctx.navigate(String(v)); },
    assign: (u: unknown) => ctx.navigate(String(u)),
    reload: () => ctx.navigate(ctx.getURL()),
    get pathname() { try { return new URL(ctx.getURL()).pathname; } catch { return "/"; } },
    toString: () => ctx.getURL(),
  };

  const localStorageHost = {
    getItem: (k: unknown) => ctx.storage.get(ctx.getURL())?.get(String(k)) ?? null,
    setItem: (k: unknown, v: unknown) => {
      let m = ctx.storage.get(ctx.getURL());
      if (!m) { m = new Map(); ctx.storage.set(ctx.getURL(), m); }
      m.set(String(k), String(v));
    },
    removeItem: (k: unknown) => ctx.storage.get(ctx.getURL())?.delete(String(k)),
  };

  const windowHost: Record<string, unknown> = {
    document: documentHost,
    location: locationHost,
    navigator: { userAgent: "Titan/1.0 (from-scratch)", platform: "TitanOS", language: "en-US" },
    localStorage: localStorageHost,
    get innerWidth() { return 1280; },
    get innerHeight() { return 800; },
    alert: (m: unknown) => interp.hooks.consoleLog("[alert]", String(m)),
  };
  // window.window === window
  (windowHost as Record<string, unknown>).window = windowHost;
  (windowHost as Record<string, unknown>).globalThis = windowHost;
  (windowHost as Record<string, unknown>).self = windowHost;

  for (const [k, v] of Object.entries(windowHost)) {
    try { g.declare(k, v); } catch { /* re-install */ try { } catch { } }
  }
  try { g.declare("document", documentHost); } catch { }
  try { g.declare("location", locationHost); } catch { }
  try { g.declare("navigator", windowHost.navigator); } catch { }
  try { g.declare("localStorage", localStorageHost); } catch { }
  try { g.declare("window", windowHost); } catch { }
  try { g.declare("globalThis", windowHost); } catch { }
  try { g.declare("alert", windowHost.alert); } catch { }

  void EngineEvent;
}
