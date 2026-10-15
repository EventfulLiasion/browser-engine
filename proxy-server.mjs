// Titan local fetch proxy — run:  node proxy-server.mjs   (or: npm run proxy)
// Fetches pages server-side (Node has no CORS restrictions) and re-serves
// them with `Access-Control-Allow-Origin: *` so the engine can read them.
// This is what makes bot-guarded sites like youtube.com loadable: the fetch
// happens from YOUR machine/IP, not a datacenter proxy's.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.TITAN_PROXY_PORT || 8471);

const server = http.createServer(async (req, res) => {
  const cors = () => res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { cors(); res.writeHead(204); res.end(); return; }
  let target = "";
  try { target = new URL(req.url || "", "http://x").searchParams.get("url") || ""; }
  catch { /* bad request line */ }
  if (!/^https?:\/\//.test(target)) { cors(); res.writeHead(400); res.end("usage: /?url=https://example.com"); return; }
  try {
    const r = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    cors();
    res.setHeader("content-type", r.headers.get("content-type") || "text/html; charset=utf-8");
    res.writeHead(r.status);
    res.end(buf);
  } catch (e) {
    cors();
    res.writeHead(502);
    res.end("proxy fetch failed: " + String(e).slice(0, 200));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`titan proxy → http://127.0.0.1:${PORT}/?url=https://example.com`));

// Serve the app from the same process so `npm run dev` also brings up the proxy.
// resolve() removes the trailing separator on Windows so the containment
// check below does not accidentally require a doubled backslash.
const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
const appServer = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    if (pathname === "/proxy") {
      const target = new URL(req.url || "/", "http://localhost").searchParams.get("url") || "";
      if (!/^https?:\/\//.test(target)) { res.writeHead(400).end("usage: /proxy?url=https://example.com"); return; }
      try {
        const upstream = await fetch(target, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } });
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "text/html; charset=utf-8", "access-control-allow-origin": "*" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (e) { res.writeHead(502).end("proxy fetch failed: " + String(e).slice(0, 200)); }
      return;
    }
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end("Forbidden"); return; }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found"); }
});
appServer.listen(3000, "127.0.0.1", () => console.log("Titan is running at http://127.0.0.1:3000"));
