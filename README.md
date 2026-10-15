# ⚡ Titan Browser

Titan now launches as a Windows desktop browser powered by Microsoft's WebView2 (the Chromium-based Edge engine). YouTube and other modern sites render inside Titan's own window. The original TypeScript browser-engine demo remains available with `npm run dev:web`.

## Run Titan (Windows)

Install the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) and [Node.js](https://nodejs.org/), then run:

```powershell
cd C:\Users\KIIT\Downloads\youtube-productivity-filter-fixed\browser-engine
npm run dev
```

Or double-click `Start Titan.bat` in the project folder.

Titan opens your last session (or YouTube the first time) in its own window. It uses the installed Microsoft Edge WebView2 runtime and keeps cookies, sign-ins, and site data in `%LOCALAPPDATA%\TitanBrowser\WebView2`.

The desktop shell includes multiple tabs with adaptive widths, tab restore, popups opened as tabs, a search start page, bookmarks bar, persistent history, an in-app recent downloads list, page find, print, fullscreen video, zoom, and DevTools. Useful shortcuts: `Ctrl+T` new tab, `Ctrl+N` new window, `Ctrl+W` close tab, `Ctrl+Shift+T` reopen tab, `Ctrl+L` address bar, `Ctrl+D` bookmark, `Ctrl+H` history, `Ctrl+J` downloads, `Ctrl+F` find, `Ctrl+Tab` switch tabs, `Ctrl+1`–`Ctrl+8` select tabs, `Ctrl+9` last tab, `F12` DevTools.

Titan is a Chromium-powered browser shell, not a full Chrome distribution: Chrome extensions, Google account sync, and Chrome's password manager are not included.

## Run the original TypeScript engine demo

```powershell
npm run dev:web
```

Then open the local URL printed by the server. This custom engine is a learning project and does not implement Chromium's full web platform; use the desktop app for real websites.

## TypeScript engine

A maximal-complexity, dependency-free browser engine written from scratch:
HTML5 parser · CSS3 cascade · Flexbox/Grid layout engine · JS interpreter ·
DOM bindings · event loop · tabs/history/cache · canvas rasterizer · DevTools.

No Blink/WebKit, no PostCSS, no Babel — every stage is hand-rolled in `src/`.

```
index.html            ← browser chrome (tabs, omnibox, canvas viewport, inspector, console)
src/dom.ts            ← Node/Element/Document, events (capture/bubble), query API
src/html.ts           ← HTML5 tokenizer + tree builder (entities, void, rawtext, error recovery)
src/css.ts            ← CSS parser, selector engine, specificity, cascade, var(), media queries
src/layout.ts         ← box tree + block/inline/flex/grid/float/position, vw/vh/%, min/max
src/js.ts             ← JS lexer + recursive-descent parser + interpreter (closures, classes, try/catch)
src/bindings.ts       ← DOM↔JS bridge (document/window/location/style proxy/events)
src/browser.ts        ← event loop, NetworkCache, Tab pipeline, Browser (tabs/history/bookmarks)
src/paint.ts          ← display list + Canvas2D rasterizer (borders, radius, shadows, images)
src/main.ts           ← chrome wiring: paint loop, click-hit-testing, scroll, console eval
demo-pages/           ← sample pages
```

## Run the visual browser

```powershell
cd browser-engine
npm install
npm run build
npx serve .        # or: python -m http.server 8080
# open http://localhost:3000 (or :8080)/index.html
```

Try in the omnibox: `titan://welcome` · `titan://flex` · `titan://grid` · any `https://` URL.
Click page elements, scroll with the wheel, eval JS in the DevTools console
(e.g. `document.title`, `document.querySelector("h1").textContent = "hacked"`).

> **Real sites (youtube.com etc.):** browsers block cross-origin `fetch()` (CORS),
> so Titan retries automatically: local helper → public proxies, with progress
> in the console. `npm run dev` starts both the app and its local fetch helper.
> Heavy app-sites still render as a sparse shell —
> their content is built at runtime by megabytes of JS, and Titan caps scripts
> per page (count + size + time budget) so one page can't hang the tab.
> Serve over HTTP (`npm run dev`), not `file://`, for best results.
> JS-shell pages (YouTube watch, etc.) get a Titan Reader summary — extracted
> title, channel, views, description and links — since their content only
> exists after running megabytes of JS.

## Headless / tests

```powershell
node --input-type=module -e "import('./dist/html.js').then(m=>console.log(m.parseHTML('<p>hi</p>').toHTML()))"
```

Pipeline: `parseHTML → installMatcher → parseStylesheet → computeStyles →
buildBoxTree → layout → buildDisplayList → Tab.loadHTML → evalJS`.

## Architecture notes

- **HTML**: single-pass tokenizer with `RAW` (script/style/title) handling,
  implied `html/head/body`, `p/li/td` auto-closing, stray-end-tag recovery.
- **CSS**: `parseStylesheet` handles `@media/@font-face/@keyframes`,
  `parseSelectorList` supports `> + ~`, `[attr^=$*=]`, `:nth-child/:not/:hover…`,
  cascade sorts by origin→`!important`→specificity→order, expands
  `margin/padding/border/font/flex` shorthands, resolves `var()` + inheritance.
- **Layout**: block flow with inline-run flushing + word-level line breaking,
  full row flex (grow/shrink/wrap/justify/align/gap), grid tracks with
  `fr/repeat()/span`, absolute/fixed/relative, floats, `box-sizing`, z-index.
- **JS**: subset ES2023 — `let/const`, functions, arrows, classes + extends,
  template literals, try/catch, `for..in/of`, destructuring-lite via objects,
  host `console/Math/JSON/setTimeout/fetch/Promise`.
- **Browser**: virtual-time `EventLoop` (micro/macro/timers/rAF),
  `NetworkCache` (60s TTL, hit/miss stats), per-`Tab` history stack,
  re-render on DOM/style mutation, click hit-testing via `findBoxAt`.
