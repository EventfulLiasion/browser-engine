import { parseHTML } from "../dist/html.js";
import { parseStylesheet, computeStyles, installMatcher } from "../dist/css.js";
import { buildBoxTree, layout } from "../dist/layout.js";
import { buildDisplayList } from "../dist/paint.js";
import { Tab } from "../dist/browser.js";
import test from "node:test";
import assert from "node:assert/strict";

// tiny smoke suite (runs on node dist/ too)
const html = `<!DOCTYPE html><html><head><title>T</title><style>
:root{--brand:#7048e8} .grid{display:grid;grid-template-columns:1fr 2fr;gap:10px}
.row{display:flex;gap:8px} .row div{flex:1} p:first-child{color:red} @media (max-width:700px){.grid{grid-template-columns:1fr}}</style></head>
<body><div class="row"><div>A</div><div>B</div></div><div class="grid"><div>1</div><div>2</div></div>
<button id="b">hi</button><script>document.querySelector("#b").addEventListener("click",()=>{});</script></body></html>`;

test("HTML, CSS, layout and paint pipeline produces a display list", () => {
  const doc = parseHTML(html, "titan://test");
  installMatcher(doc);
  const sheets = [parseStylesheet([...doc.querySelectorAll("style")].map(s => s.textContent ?? "").join("\n"))];
  const viewport = { viewportWidth: 1280, viewportHeight: 800 };
  computeStyles(doc, sheets, { ...viewport, matchCtx: { hoverElement: null, focusElement: null, activeElement: null, ...viewport } });
  const root = buildBoxTree(doc);
  layout(root, { width: 1280, height: 800 });
  const cmds = buildDisplayList(root);
  assert.equal(doc.title, "T");
  assert.ok(doc.getElementById("b"));
  assert.ok(cmds.length > 0);
});

test("Tab loads a page and evaluates JavaScript", () => {
  const tab = new Tab({ viewport: { width: 1280, height: 800 }, fetcher: async () => html });
  tab.loadHTML(html, "titan://test");
  assert.equal(tab.snapshot().title, "T");
  assert.equal(tab.evalJS("40+2"), 42);
});
