import http from "node:http";
import { getBotConfig, getBotState } from "./ultra-bot";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ config: getBotConfig(), state: getBotState() }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Ultra instinct trading bot dev server is running.\nUse /healthz or /status.");
});

server.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`);
});
