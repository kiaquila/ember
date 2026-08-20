#!/usr/bin/env node
/* Local preview for dist/. Node builtins only. */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "dist");
const port = Number(process.env.PORT ?? 4660);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

async function resolveFile(pathname) {
  try {
    /* Decoding belongs inside the guard: a malformed escape like `/%` throws
       a URIError, which outside it would take the whole preview down. A bad
       path and a missing file mean the same thing here — nothing to serve. */
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(dist, relative);
    if (!candidate.startsWith(dist)) return null;
    let file = candidate;
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    await stat(file);
    return file;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const file = await resolveFile(url.pathname);
  if (!file) {
    /* The build publishes exactly the page and its two favicons, so there is
       no 404 document to stream — reading one would crash the preview. */
    response.writeHead(404, { "content-type": TYPES[".txt"] });
    response.end(`Not found: ${url.pathname}\n`);
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`  preview on http://localhost:${port}`);
});
