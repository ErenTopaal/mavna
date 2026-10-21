// Serves a built docs directory the way the production proxy does: a file, else
// the folder's index.html, else the prerendered not-found shell with a 404.
//
//   node scripts/serve.mjs <dir> <port>
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const [dirArg = "dist/client", portArg = "5122"] = process.argv.slice(2);
const root = resolve(dirArg);
const port = Number(portArg);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".data": "text/x-script",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function fileAt(path) {
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root)) {
    response.writeHead(400).end();
    return;
  }
  const found = fileAt(target) ?? fileAt(join(target, "index.html"));
  const path = found ?? join(root, "__spa-fallback.html");
  // the search index is written without an extension
  const type = pathname === "/api/search" ? "application/json" : TYPES[extname(path)];
  response.writeHead(found === undefined ? 404 : 200, {
    "content-type": type ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
}).listen(port, () => {
  console.log(`docs: serving ${root} on http://localhost:${port}`);
});
