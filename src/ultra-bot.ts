// @ts-nocheck
import crypto from "crypto";
import { db, tradesTable, botLogsTable } from "./workspace-db";
import { logger } from "./logger";
import { eq, gte, sql } from "drizzle-orm";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const API_KEY_ID = process.env.KALSHI_API_KEY ?? "";

function normalizePrivateKey(raw: string): string {
  let pem = raw.replace(/\\n/g, "\n");
  if (!pem.includes("\n") && pem.includes("-----")) {
    const beginMatch = pem.match(/(-----BEGIN [^-]+-----)/);
    const endMatch   = pem.match(/(-----END [^-]+-----)/);
    if (beginMatch && endMatch) {
      const begin = beginMatch[1];
      const end   = endMatch[1];
      const b64   = pem.slice(begin.length, pem.indexOf(end)).replace(/\s/g, "");
      const lines = b64.match(/.{1,64}/g) ?? [];
      pem = `${begin}\n${lines.join("\n")}\n${end}`;
    }
  }
  if (!pem.includes("-----BEGIN")) {
    const b64   = pem.replace(/\s/g, "");
    const lines = b64.match(/.{1,64}/g) ?? [];
    pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return pem.trim();
}

const PRIVATE_KEY_PEM = normalizePrivateKey(process.env.KALSHI_PRIVATE_KEY ?? "");

function loadPrivateKey(): crypto.KeyObject {
  const types: Array<"pkcs8" | "pkcs1"> = ["pkcs8", "pkcs1"];
  for (const type of types) {
    try { return crypto.createPrivateKey({ key: PRIVATE_KEY_PEM, format: "pem", type }); } catch (_) {}
  }
  return crypto.createPrivateKey({ key: PRIVATE_KEY_PEM, format: "pem" });
}

const CRYPTO_COIN_SERIES: Record<string, string[]> = {
  BTC:  ["KXBTC15M"], ETH: ["KXETH15M"], SOL: ["KXSOL15M"],
  DOGE: ["KXDOGE15M"], XRP: ["KXXRP15M"], ADA: ["KXADA15M"], MATIC: ["KXMATIC15M"],
};

const SPORTS_KEYWORDS = ["NFL","NBA","MLB","NHL","NCAAB","NCAAF","MLS","EPL","FIFA","UEFA","tennis","golf"];

export interface BotConfig {
  maxEntryPriceCents: number;
  minNetProfitCents: number;
  maxNetProfitCents: number;
  minMinutesRemaining: number;
  exitWindowMins: number;
  feeRate: number;
  pollIntervalSecs: number;
  marketCategories: string[];
  cryptoCoins: string[];
  maxOpenPositions: number;
  balanceFloorCents: number;
  dailyProfitTargetCents: number;
  dailyLossLimitCents: number;
}

export const botConfig: BotConfig = {
  maxEntryPriceCents: 59,
  minNetProfitCents: 5,
  maxNetProfitCents: 99,
  minMinutesRemaining: 10,
  exitWindowMins: 7,
  feeRate: 0.07,
  pollIntervalSecs: 5,
  marketCategories: ["crypto", "sports"],
  cryptoCoins: ["BTC", "ETH", "SOL", "DOGE"],
  maxOpenPositions: 1,
  balanceFloorCents: 0,
  dailyProfitTargetCents: 0,
  dailyLossLimitCents: 0,
};

export function updateBotConfig(updates: Partial<BotConfig>): BotConfig {
  Object.assign(botConfig, updates);
  return { ...botConfig };
}
export function getBotConfig(): BotConfig { return { ...botConfig }; }

export interface BotState {
  running: boolean; startedAt: string | null; marketsScanned: number;
  tradesAttempted: number; tradesSucceeded: number; totalPnlCents: number;
  dailyPnlCents: number; openPositionCount: number; balanceCents: number; stoppedReason: string | null;
}

const state: BotState = {
  running: false, startedAt: null, marketsScanned: 0, tradesAttempted: 0,
  tradesSucceeded: 0, totalPnlCents: 0, dailyPnlCents: 0, openPositionCount: 0,
  balanceCents: 0, stoppedReason: null,
};

const openMarkets = new Set<string>();
let tradeMutex = false;
const zeroPriceTs = new Map<string, number>();
const ZERO_SKIP_MS = 20_000;
let lastIdleScanLogMs = 0;
const IDLE_LOG_INTERVAL_MS = 30_000;
let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;
let balanceTimer: NodeJS.Timeout | null = null;

const KALSHI_PATH_PREFIX = "/trade-api/v2";

function signRequest(method: string, path: string, timestampMs: number): string {
  const fullPath = path.startsWith(KALSHI_PATH_PREFIX) ? path : `${KALSHI_PATH_PREFIX}${path}`;
  const msg = `${timestampMs}${method.toUpperCase()}${fullPath}`;
  const key = loadPrivateKey();
  const keyType = key.asymmetricKeyType ?? "";
  let sig: Buffer;
  if (keyType === "ed25519" || keyType === "ed448") {
    sig = crypto.sign(null, Buffer.from(msg), key);
  } else if (keyType === "ec") {
    sig = crypto.sign("sha256", Buffer.from(msg), key);
  } else {
    sig = crypto.sign("sha256", Buffer.from(msg), {
      key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: -2,
    });
  }
  return sig.toString("base64");
}

async function kalshiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const ts = Date.now();
  const sig = signRequest(method, path, ts);
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": API_KEY_ID,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": String(ts),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${text}`); }
  return res.json();
}

function isCryptoMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  for (const [, prefixes] of Object.entries(CRYPTO_COIN_SERIES)) {
    if (prefixes.some(p => upper.includes(p.toUpperCase()))) return true;
  }
  return false;
}

function matchesCryptoCoin(ticker: string, title: string, coins: string[]): boolean {
  if (coins.length === 0) return true;
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return coins.some(coin => {
    const prefixes = CRYPTO_COIN_SERIES[coin.toUpperCase()] ?? [coin];
    return prefixes.some(p => upper.includes(p.toUpperCase()));
  });
}

function isSportsMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return SPORTS_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()));
}

function marketPassesCategoryFilter(ticker: string, title: string): boolean {
  const cats = botConfig.marketCategories;
  if (cats.length === 0) return true;
  if (cats.includes("crypto") && isCryptoMarket(ticker, title)) return matchesCryptoCoin(ticker, title, botConfig.cryptoCoins);
  if (cats.includes("sports") && isSportsMarket(ticker, title)) return true;
  return false;
}

function grossToNet(grossProfitCents: number): number {
  return grossProfitCents - Math.floor(botConfig.feeRate * grossProfitCents);
}
function netToRequiredGross(netTargetCents: number): number {
  return Math.ceil(netTargetCents / (1 - botConfig.feeRate));
}
function calcTargetSellPrice(buyPriceCents: number): number {
  return buyPriceCents + netToRequiredGross(botConfig.minNetProfitCents);
}

async function botLog(level: string, message: string, data?: unknown): Promise<void> {
  logger.info({ level, botMessage: message }, "bot-log");
  try { await db.insert(botLogsTable).values({ level, message, data: data ? JSON.stringify(data) : null }); } catch (_) {}
}

export async function refreshBalance(): Promise<void> {
  try {
    const resp = await kalshiFetch("GET", "/portfolio/balance") as { balance?: { balance?: number } };
    state.balanceCents = Math.round((resp?.balance?.balance ?? 0) * 100);
  } catch (_) {}
}

async function refreshDailyPnl(): Promise<void> {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const result = await db.select({ total: sql<number>`coalesce(sum(${tradesTable.pnlCents}), 0)` })
      .from(tradesTable).where(gte(tradesTable.closedAt, todayStart));
    state.dailyPnlCents = Number(result[0]?.total ?? 0);
  } catch (_) {}
}

async function checkSafetyLimits(): Promise<boolean> {
  await refreshBalance(); await refreshDailyPnl();
  const { balanceFloorCents, dailyProfitTargetCents, dailyLossLimitCents } = botConfig;
  if (balanceFloorCents > 0 && state.balanceCents > 0 && state.balanceCents <= balanceFloorCents) {
    await botLog("warn", `🛑 Auto-stop: Balance floor hit`); await stopBot("Balance floor hit"); return false;
  }
  if (dailyProfitTargetCents > 0 && state.dailyPnlCents >= dailyProfitTargetCents) {
    await botLog("info", `🎉 Auto-stop: Daily profit target reached`); await stopBot("Daily profit target reached"); return false;
  }
  if (dailyLossLimitCents > 0 && state.dailyPnlCents <= -dailyLossLimitCents) {
    await botLog("warn", `🛑 Auto-stop: Daily loss limit hit`); await stopBot("Daily loss limit hit"); return false;
  }
  return true;
}

async function checkSafetyLimitsPassive(): Promise<{ ok: boolean; reason?: string }> {
  await refreshBalance(); await refreshDailyPnl();
  const { balanceFloorCents, dailyProfitTargetCents, dailyLossLimitCents } = botConfig;
  if (balanceFloorCents > 0 && state.balanceCents > 0 && state.balanceCents <= balanceFloorCents)
    return { ok: false, reason: `Balance floor hit` };
  if (dailyProfitTargetCents > 0 && state.dailyPnlCents >= dailyProfitTargetCents)
    return { ok: false, reason: `Daily profit target already reached` };
  if (dailyLossLimitCents > 0 && state.dailyPnlCents <= -dailyLossLimitCents)
    return { ok: false, reason: `Daily loss limit hit` };
  return { ok: true };
}

interface KalshiMarket {
  ticker: string; title: string; close_time: string; status?: string; result?: string;
  yes_bid?: number; yes_ask?: number; no_bid?: number; no_ask?: number;
  yes_ask_dollars?: number; yes_bid_dollars?: number; no_ask_dollars?: number;
  no_bid_dollars?: number; last_price_dollars?: number;
}

function priceCents(m: KalshiMarket, field: "yes_ask"|"yes_bid"|"no_ask"|"no_bid"|"last_price"): number {
  const rawDollars = (m as any)[`${field}_dollars`];
  if (rawDollars != null) { const v = parseFloat(String(rawDollars)); if (!isNaN(v) && v > 0) return Math.round(v * 100); }
  const rawCents = (m as any)[field];
  if (rawCents != null) { const v = parseFloat(String(rawCents)); if (!isNaN(v) && v > 0) return Math.round(v); }
  return 0;
}

async function scanMarkets(): Promise<void> {
  if (!state.running) return;
  if (!(await checkSafetyLimits())) return;
  state.openPositionCount = openMarkets.size;
  if (openMarkets.size >= botConfig.maxOpenPositions) {
    await botLog("info", `Max open positions reached (${openMarkets.size}/${botConfig.maxOpenPositions}) — skipping scan`);
    return;
  }
  try {
    const now = Date.now();
    const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
    const baseUrl = `/markets?status=open&limit=200&max_close_ts=${maxCloseTs}`;
    const resp1 = await kalshiFetch("GET", baseUrl) as { markets?: KalshiMarket[]; cursor?: string };
    let markets = resp1.markets ?? [];
    if (resp1.cursor && markets.length === 200) {
      try {
        const resp2 = await kalshiFetch("GET", `${baseUrl}&cursor=${encodeURIComponent(resp1.cursor)}`) as { markets?: KalshiMarket[] };
        markets = [...markets, ...(resp2.markets ?? [])];
      } catch (_) {}
    }
    const eligible = markets.filter(m => {
      if (!m.close_time) return false;
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      if (mins <= botConfig.minMinutesRemaining || mins > 16) return false;
      return marketPassesCategoryFilter(m.ticker, m.title);
    });
    const under10 = markets.filter(m => { const mins = (new Date(m.close_time).getTime()-now)/60_000; return mins>0&&mins<=10; }).length;
    const window1016 = markets.filter(m => { const mins = (new Date(m.close_time).getTime()-now)/60_000; return mins>10&&mins<=16; }).length;
    const over16 = markets.filter(m => { const mins = (new Date(m.close_time).getTime()-now)/60_000; return mins>16; }).length;
    const sample = eligible.slice(0,5).map(m => `${m.ticker}(${((new Date(m.close_time).getTime()-now)/60_000).toFixed(1)}m)`).join(", ");
    const etMin = Math.floor((now - 4*3600_000) / 60_000) % 15;
    const minsToNext = ((15 - etMin) % 15) || 15;
    const batchHint = eligible.length === 0 ? ` | 💤 next batch ~${minsToNext}min` : "";
    const shouldLog = eligible.length > 0 || (now - lastIdleScanLogMs) >= IDLE_LOG_INTERVAL_MS;
    if (shouldLog) {
      lastIdleScanLogMs = eligible.length === 0 ? now : lastIdleScanLogMs;
      await botLog("info", `🔍 Scanned ${markets.length} total — ${eligible.length} eligible | <10min:${under10} | 10-16min:${window1016} | >16min:${over16}${sample ? ` | ${sample}` : ""}${batchHint}`);
    }
    state.marketsScanned += eligible.length;
    for (const market of eligible.slice(0, 50)) {
      if (!state.running) break;
      if (openMarkets.size >= botConfig.maxOpenPositions) break;
      await evaluateMarket(market);
    }
  } catch (err) { await botLog("error", "Market scan failed", String(err)); }
}

async function evaluateMarket(market: KalshiMarket): Promise<void> {
  const { ticker, title, close_time } = market;
  const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;
  if (minutesLeft <= botConfig.minMinutesRemaining) return;
  if (openMarkets.has(ticker)) return;
  const lastZero = zeroPriceTs.get(ticker);
  if (lastZero && Date.now() - lastZero < ZERO_SKIP_MS) return;
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market ?? market;
    const yesAsk = priceCents(m, "yes_ask"); const noAsk = priceCents(m, "no_ask");
    const yesBid = priceCents(m, "yes_bid"); const noBid = priceCents(m, "no_bid");
    const { maxEntryPriceCents } = botConfig;
    if (yesAsk === 0 && noAsk === 0) { zeroPriceTs.set(ticker, Date.now()); return; }
    await botLog("info", `📊 ${ticker} — YES ask:${yesAsk}¢ bid:${yesBid}¢ | NO ask:${noAsk}¢ bid:${noBid}¢ | limit:${maxEntryPriceCents}¢ | ${minutesLeft.toFixed(1)}min`);
    if (yesAsk > 0 && yesAsk <= maxEntryPriceCents && calcTargetSellPrice(yesAsk) < 100) {
      state.tradesAttempted++;
      await botLog("info", `🟢 Entry: ${title} — buy YES at ${yesAsk}¢`);
      await enterTrade(ticker, title, "YES", yesAsk, minutesLeft); return;
    }
    if (noAsk > 0 && noAsk <= maxEntryPriceCents && calcTargetSellPrice(noAsk) < 100) {
      state.tradesAttempted++;
      await botLog("info", `🟢 Entry: ${title} — buy NO at ${noAsk}¢`);
      await enterTrade(ticker, title, "NO", noAsk, minutesLeft);
    }
  } catch (err) { await botLog("warn", `Failed to evaluate ${ticker}`, String(err)); }
}

async function enterTrade(ticker: string, title: string, side: string, buyPriceCents: number, minutesRemaining: number): Promise<void> {
  if (tradeMutex) { await botLog("info", `⏳ Trade skipped (mutex): ${ticker}`); return; }
  tradeMutex = true;
  try {
    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker, client_order_id: `scalp-buy-${Date.now()}`, type: "limit", action: "buy",
      side: side.toLowerCase(), count: 1,
      ...(side === "YES" ? { yes_price: buyPriceCents } : { no_price: buyPriceCents }),
    }) as { order?: { order_id?: string } };
    const buyOrderId = buyResp?.order?.order_id;
    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker, marketTitle: title, side, buyPriceCents, contractCount: 1,
      feeCents: 0, status: "open", kalshiBuyOrderId: buyOrderId, minutesRemaining,
    }).returning();
    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;
    state.tradesSucceeded++;
    await botLog("info", `✅ Bought 1x ${side} on "${title}" at ${buyPriceCents}¢`, { tradeId: trade.id, buyOrderId });
  } catch (err) {
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
    await botLog("error", `Failed to enter trade on ${ticker}: ${String(err)}`);
  } finally { tradeMutex = false; }
}

async function placeLimitSell(tradeId: number, ticker: string, side: string, _buyPriceCents: number, sellPriceCents: number, contracts: number): Promise<void> {
  try {
    const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker, client_order_id: `scalp-sell-${tradeId}-${Date.now()}`, type: "limit", action: "sell",
      side: side.toLowerCase(), count: contracts,
      ...(side === "YES" ? { yes_price: sellPriceCents/100 } : { no_price: sellPriceCents/100 }),
    }) as { order?: { order_id?: string } };
    const sellOrderId = sellResp?.order?.order_id;
    if (!sellOrderId) { await botLog("warn", `Trade ${tradeId}: sell order no ID — will retry`); return; }
    await db.update(tradesTable).set({ kalshiSellOrderId: sellOrderId }).where(eq(tradesTable.id, tradeId));
    await botLog("info", `📋 Trade ${tradeId}: limit sell @ ${sellPriceCents}¢ placed (${sellOrderId}) — waiting fill`, { tradeId, sellPriceCents, sellOrderId });
  } catch (err) { await botLog("warn", `Failed to place limit sell for trade ${tradeId}`, String(err)); }
}

let sellMonitorRunning = false;
export async function retryOpenPositions(): Promise<void> {
  if (sellMonitorRunning) return;
  if (openMarkets.size === 0 && state.openPositionCount === 0) return;
  sellMonitorRunning = true;
  try {
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    state.openPositionCount = openTrades.length;
    if (openTrades.length === 0) { openMarkets.clear(); return; }

    for (const trade of openTrades) {
      const now = Date.now();
      const tradeAgeMs = now - trade.createdAt.getTime();

      if (tradeAgeMs >= 60_000 && tradeAgeMs < 90_000 && trade.kalshiBuyOrderId) {
        try {
          const orderResp = await kalshiFetch("GET", `/portfolio/orders/${trade.kalshiBuyOrderId}`) as {
            order?: { status?: string; remaining_count?: number; filled_count?: number }
          };
          const order = orderResp.order;
          const status = order?.status ?? "";
          const filled = (order?.filled_count ?? 0) > 0 || status === "filled" || status === "settled" || status === "executed";
          const definitelyUnfilled = !filled && (status === "resting" || status === "open" || status === "pending");
          if (definitelyUnfilled) {
            try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiBuyOrderId}`); } catch (_) {}
            await db.update(tradesTable).set({ status: "cancelled", closedAt: new Date() }).where(eq(tradesTable.id, trade.id));
            openMarkets.delete(trade.marketId);
            state.openPositionCount = openMarkets.size;
            await botLog("warn", `🚫 Trade ${trade.id} cancelled — buy order still ${status} after 60s`, { tradeId: trade.id });
            continue;
          } else if (!filled) {
            await botLog("info", `Trade ${trade.id}: buy order status="${status}" — keeping open`, { tradeId: trade.id });
          }
        } catch (_) {}
      }

      try {
        const resp = await kalshiFetch("GET", `/markets/${trade.marketId}`) as { market?: KalshiMarket };
        const m = resp.market;
        const isLive = !m?.status || m.status === "open" || m.status === "active";
        if (!m || !isLive) {
          const settled = m?.status === "settled" || m?.status === "finalized";
          const ourSideWon = settled && m?.result?.toLowerCase() === trade.side.toLowerCase();
          let pnlCents: number; let logMsg: string;
          if (ourSideWon) {
            const gross = 100 - trade.buyPriceCents;
            const fee = Math.floor(botConfig.feeRate * gross);
            pnlCents = gross - fee;
            logMsg = `🏆 Trade ${trade.id} settled — won! Net +${pnlCents}¢`;
          } else if (settled) {
            pnlCents = -trade.buyPriceCents;
            logMsg = `💸 Trade ${trade.id} settled — lost ${trade.buyPriceCents}¢`;
          } else {
            pnlCents = -trade.buyPriceCents;
            logMsg = `⚠️ Trade ${trade.id} market closed — marking expired`;
          }
          await db.update(tradesTable).set({ status: settled && ourSideWon ? "closed" : "expired", pnlCents, closedAt: new Date() }).where(eq(tradesTable.id, trade.id));
          openMarkets.delete(trade.marketId);
          state.openPositionCount = openMarkets.size;
          await botLog(ourSideWon ? "info" : "warn", logMsg, { tradeId: trade.id });
          continue;
        }

        const currentBid = trade.side === "YES" ? priceCents(m, "yes_bid") : priceCents(m, "no_bid");
        const minsLeft = (new Date(m.close_time).getTime() - now) / 60_000;
        const targetSellPrice = calcTargetSellPrice(trade.buyPriceCents);

        if (minsLeft > 0 && minsLeft <= (botConfig.exitWindowMins + 1)) {
          await botLog("debug", `Trade ${trade.id}: minsLeft=${minsLeft.toFixed(1)}, exitWindow=${botConfig.exitWindowMins}, hasOrderId=${!!trade.kalshiSellOrderId}`);
        }

        if (trade.kalshiSellOrderId) {
          if (minsLeft <= 2) {
            try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiSellOrderId}`); } catch (_) {}
            await db.update(tradesTable).set({ kalshiSellOrderId: null }).where(eq(tradesTable.id, trade.id));
            if (currentBid > 0) {
              await botLog("warn", `⏰ Trade ${trade.id} panic — re-placing at bid ${currentBid}¢`, { tradeId: trade.id });
              await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
            }
          } else {
            try {
              const sellOrderResp = await kalshiFetch("GET", `/portfolio/orders/${trade.kalshiSellOrderId}`) as {
                order?: { status?: string; filled_count?: number; yes_price?: number; no_price?: number }
              };
              const sellOrder = sellOrderResp.order;
              if ((sellOrder?.filled_count ?? 0) > 0) {
                const fillPrice = trade.side === "YES"
                  ? Math.round((sellOrder?.yes_price ?? targetSellPrice/100) * 100)
                  : Math.round((sellOrder?.no_price ?? targetSellPrice/100) * 100);
                const gross = fillPrice - trade.buyPriceCents;
                const fee = Math.floor(botConfig.feeRate * Math.max(0, gross));
                const netPnl = gross - fee;
                await db.update(tradesTable).set({ status: "closed", sellPriceCents: fillPrice, pnlCents: netPnl, feeCents: fee, closedAt: new Date() }).where(eq(tradesTable.id, trade.id));
                openMarkets.delete(trade.marketId);
                state.openPositionCount = openMarkets.size;
                await botLog("info", `✅ Sell filled — trade ${trade.id} closed at ${fillPrice}¢, net ${netPnl>=0?"+":""}${netPnl}¢`, { tradeId: trade.id });
              } else {
                await botLog("info", `📋 Trade ${trade.id}: resting sell @ ${targetSellPrice}¢ pending | bid ${currentBid}¢ | ${minsLeft.toFixed(1)}min left`);
              }
            } catch (_) { await botLog("info", `📋 Trade ${trade.id}: sell order pending | ${minsLeft.toFixed(1)}min left`); }
          }
        } else if (minsLeft <= botConfig.exitWindowMins) {
          if (targetSellPrice >= 100) {
            const fallbackPrice = Math.max(currentBid, trade.buyPriceCents + 1);
            await botLog("warn", `⚠️ Trade ${trade.id} target unreachable — selling at ${fallbackPrice}¢`);
            await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, fallbackPrice, trade.contractCount);
          } else {
            try {
              const priceField = trade.side === "YES" ? "yes_price" : "no_price";
              const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
                ticker: trade.marketId, client_order_id: `sell-${trade.id}-${Date.now()}`,
                type: "limit", action: "sell", side: trade.side.toLowerCase(),
                [priceField]: targetSellPrice/100, count: trade.contractCount,
              }) as { order?: { order_id?: string } };
              const sellOrderId = sellResp.order?.order_id;
              if (sellOrderId) {
                await db.update(tradesTable).set({ kalshiSellOrderId: sellOrderId }).where(eq(tradesTable.id, trade.id));
                await botLog("info", `📋 Trade ${trade.id}: placed limit sell @ ${targetSellPrice}¢ | ${minsLeft.toFixed(1)}min left`, { tradeId: trade.id, targetSellPrice });
              } else { await botLog("warn", `Trade ${trade.id}: sell placed but no order ID`); }
            } catch (sellErr) { await botLog("warn", `Trade ${trade.id}: failed to place limit sell — ${String(sellErr)}`); }
          }
        } else {
          const netProfit = grossToNet(currentBid - trade.buyPriceCents);
          if (netProfit >= botConfig.minNetProfitCents && currentBid > 0) {
            await botLog("info", `🎯 Trade ${trade.id}: hit target early (bid ${currentBid}¢, net +${netProfit}¢) — selling now`, { tradeId: trade.id });
            await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
          } else {
            await botLog("info", `⏸ Trade ${trade.id} (${trade.side} @${trade.buyPriceCents}¢) holding | bid ${currentBid}¢ | net ${netProfit>=0?"+":""}${netProfit}¢ | ${minsLeft.toFixed(1)}min left | sell window opens at ${botConfig.exitWindowMins}min`);
          }
        }
      } catch (err) {
        await botLog("warn", `Failed to check position ${trade.id}`, String(err));
        if (tradeAgeMs > 20 * 60_000) {
          await db.update(tradesTable).set({ status: "expired", pnlCents: -trade.buyPriceCents, closedAt: new Date() }).where(eq(tradesTable.id, trade.id));
          openMarkets.delete(trade.marketId);
          state.openPositionCount = openMarkets.size;
          await botLog("warn", `⚠️ Trade ${trade.id} force-expired after 20min`, { tradeId: trade.id });
        }
      }
    }
    await refreshDailyPnl();
  } catch (err) { logger.error({ err }, "retryOpenPositions failed"); }
  finally { sellMonitorRunning = false; }
}

export function getBotState(): BotState { return { ...state }; }

export async function startBot(): Promise<BotState> {
  if (state.running) return getBotState();
  if (!API_KEY_ID || !PRIVATE_KEY_PEM) throw new Error("KALSHI_API_KEY and KALSHI_PRIVATE_KEY must be set");
  state.running = true; state.startedAt = new Date().toISOString();
  state.marketsScanned = 0; state.tradesAttempted = 0; state.tradesSucceeded = 0; state.stoppedReason = null;
  zeroPriceTs.clear(); lastIdleScanLogMs = 0;
  const existingOpen = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  openMarkets.clear();
  for (const t of existingOpen) openMarkets.add(t.marketId);
  state.openPositionCount = openMarkets.size;
  await refreshBalance(); await refreshDailyPnl();
  await botLog("info", `🤖 Instinct Scalper started — entry ≤${botConfig.maxEntryPriceCents}¢ | target ${botConfig.minNetProfitCents}¢ net | max ${botConfig.maxOpenPositions} positions`);
  retryOpenPositions(); scanMarkets();
  scanTimer = setInterval(scanMarkets, botConfig.pollIntervalSecs * 1000);
  sellTimer = setInterval(retryOpenPositions, botConfig.pollIntervalSecs * 1000);
  balanceTimer = setInterval(refreshBalance, 60_000);
  return getBotState();
}

export async function stopBot(reason?: string): Promise<BotState> {
  if (!state.running) return getBotState();
  state.running = false; state.stoppedReason = reason ?? null;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }
  if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }
  await botLog("info", `🛑 Bot stopped${reason ? ": "+reason : ""}`);
  return getBotState();
}

export async function manualTrade(ticker: string, side: "YES"|"NO", limitCents: number, quantity: number): Promise<{ success: boolean; tradeId?: number; orderId?: string; message: string }> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    if (!resp.market) return { success: false, message: `Market not found: ${ticker}` };
    const { title, close_time } = resp.market;
    const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;
    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker, client_order_id: `manual-${Date.now()}`, type: "limit", action: "buy",
      side: side.toLowerCase(), count: quantity,
      ...(side === "YES" ? { yes_price: limitCents } : { no_price: limitCents }),
    }) as { order?: { order_id?: string } };
    const buyOrderId = buyResp?.order?.order_id;
    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker, marketTitle: title ?? ticker, side, buyPriceCents: limitCents,
      contractCount: quantity, feeCents: 0, status: "open", kalshiBuyOrderId: buyOrderId, minutesRemaining: minutesLeft,
    }).returning();
    openMarkets.add(ticker); state.openPositionCount = openMarkets.size;
    await botLog("info", `🎯 Manual: bought ${quantity}x ${side} on "${title}" at ${limitCents}¢`, { tradeId: trade.id });
    return { success: true, tradeId: trade.id, orderId: buyOrderId, message: `Order placed: ${quantity}x ${side} @ ${limitCents}¢ on ${ticker}` };
  } catch (err) {
    await botLog("error", `🎯 Manual trade failed on ${ticker}: ${String(err)}`);
    return { success: false, message: String(err) };
  }
}

interface CoinFlipAutoState { enabled: boolean; intervalSecs: number; nextFlipAt: number | null; }
const coinFlipAuto: CoinFlipAutoState = { enabled: false, intervalSecs: 900, nextFlipAt: null };
let coinFlipTimer: ReturnType<typeof setTimeout> | null = null;

function msToNextCycleStart(): number {
  const now = Date.now(); const CYCLE_MS = 15 * 60_000;
  return (CYCLE_MS - (now % CYCLE_MS)) + 90_000;
}

function scheduleCoinFlip() {
  if (coinFlipTimer) clearTimeout(coinFlipTimer);
  if (!coinFlipAuto.enabled) return;
  const delay = msToNextCycleStart();
  coinFlipAuto.nextFlipAt = Date.now() + delay;
  coinFlipTimer = setTimeout(async () => {
    if (!coinFlipAuto.enabled) return;
    try { const result = await coinFlipTrade(); await botLog("info", `🪙 Auto-flip: ${result.message}`); } catch (_) {}
    scheduleCoinFlip();
  }, delay);
}

export function startCoinFlipAuto(intervalSecs: number): CoinFlipAutoState {
  coinFlipAuto.enabled = true; coinFlipAuto.intervalSecs = intervalSecs;
  scheduleCoinFlip(); return { ...coinFlipAuto };
}
export function stopCoinFlipAuto(): CoinFlipAutoState {
  coinFlipAuto.enabled = false; coinFlipAuto.nextFlipAt = null;
  if (coinFlipTimer) { clearTimeout(coinFlipTimer); coinFlipTimer = null; }
  return { ...coinFlipAuto };
}
export function getCoinFlipAutoState(): CoinFlipAutoState { return { ...coinFlipAuto }; }

export interface CoinFlipResult { success: boolean; message: string; ticker?: string; title?: string; side?: "YES"|"NO"; priceCents?: number; tradeId?: number; }

export async function coinFlipTrade(): Promise<CoinFlipResult> {
  if (tradeMutex) return { success: false, message: "Another trade in progress — coin flip blocked." };
  tradeMutex = true;
  try {
    const safety = await checkSafetyLimitsPassive();
    if (!safety.ok) return { success: false, message: `Coin flip blocked — ${safety.reason}` };
    const openRows = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    if (Math.max(openMarkets.size, openRows.length) >= botConfig.maxOpenPositions)
      return { success: false, message: `Max open positions reached — coin flip blocked.` };
    const now = Date.now();
    const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
    const resp = await kalshiFetch("GET", `/markets?status=open&limit=200&max_close_ts=${maxCloseTs}`) as { markets?: KalshiMarket[] };
    const eligible = (resp.markets ?? []).filter(m => {
      if (!m.close_time) return false;
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      if (mins <= botConfig.minMinutesRemaining || mins > 16) return false;
      return marketPassesCategoryFilter(m.ticker, m.title);
    });
    if (eligible.length === 0) return { success: false, message: "No markets with >10 min remaining right now — try again shortly." };
    const market = eligible[Math.floor(Math.random() * eligible.length)];
    const { ticker, title } = market;
    const detailResp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = detailResp.market ?? market;
    const freshMinsLeft = (new Date(m.close_time).getTime() - Date.now()) / 60_000;
    if (freshMinsLeft <= botConfig.minMinutesRemaining)
      return { success: false, message: `${ticker} only ${freshMinsLeft.toFixed(1)} min left — skipping.` };
    const yesAsk = priceCents(m, "yes_ask"); const noAsk = priceCents(m, "no_ask");
    const coinYes = Math.random() < 0.5;
    const side: "YES"|"NO" = coinYes ? "YES" : "NO";
    const ask = coinYes ? yesAsk : noAsk;
    const maxAsk = Math.min(botConfig.maxEntryPriceCents, 90);
    if (ask <= 0 || ask > maxAsk)
      return { success: false, message: `Coin landed ${side} on ${ticker} but ask is ${ask}¢ — skipping (max ${maxAsk}¢).` };
    const minutesLeft = (new Date(m.close_time).getTime() - now) / 60_000;
    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker, client_order_id: `coinflip-${Date.now()}`, type: "limit", action: "buy",
      side: side.toLowerCase(), count: 1,
      ...(side === "YES" ? { yes_price: ask } : { no_price: ask }),
    }) as { order?: { order_id?: string } };
    const buyOrderId = buyResp?.order?.order_id;
    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker, marketTitle: title, side, buyPriceCents: ask, contractCount: 1,
      feeCents: 0, status: "open", kalshiBuyOrderId: buyOrderId, minutesRemaining: minutesLeft,
    }).returning();
    openMarkets.add(ticker); state.openPositionCount = openMarkets.size;
    await botLog("info", `🪙 Coin flip: landed ${side} — bought 1x ${side} on "${title}" at ${ask}¢`, { tradeId: trade.id });
    return { success: true, message: `Flipped ${side}! Bought 1x ${side} on "${title}" at ${ask}¢ — watching for profit.`, ticker, title, side, priceCents: ask, tradeId: trade.id };
  } catch (err) {
    await botLog("error", `🪙 Coin flip failed: ${String(err)}`);
    return { success: false, message: String(err) };
  } finally { tradeMutex = false; }
}
