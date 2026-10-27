const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  let filename;
  if (pathname === "/" || /^\/game\/\d+\/?$/.test(pathname)) {
    filename = path.join(root, pathname === "/" ? "Lobby.html" : "MatchThree.html");
  } else {
    filename = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!filename.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
  }

  fs.readFile(filename, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(filename)] || "application/octet-stream" });
    response.end(content);
  });
}).listen(Number(process.env.PORT) || 8765, "0.0.0.0");