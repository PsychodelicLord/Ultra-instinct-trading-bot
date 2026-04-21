import express from "express";
import { getBotConfig, getBotState, updateBotConfig } from "./ultra-bot";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ultra-instinct-trading-bot" });
});

app.get("/config", (_req, res) => {
  res.json(getBotConfig());
});

app.patch("/config", (req, res) => {
  const next = updateBotConfig(req.body ?? {});
  res.json(next);
});

app.get("/state", (_req, res) => {
  res.json(getBotState());
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Ultra bot dev server listening on http://localhost:${port}`);
});
