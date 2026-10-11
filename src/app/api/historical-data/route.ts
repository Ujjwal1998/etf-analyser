import { NextResponse } from "next/server";
import { alphaVantageSymbol } from "@/lib/market/instruments";
import { historyInGbp, validHistoricalPoints } from "@/lib/market/history";

type RequestedInstrument = { id: string; ticker: string; isin?: string; type?: "ETF" | "Share" | "Unclassified"; priceCurrency?: string };
type Series = { symbol: string; currency: string; source: "justETF" | "Yahoo Finance" | "Alpha Vantage"; points: { date: string; close: number }[]; fetchedAt: string };

const MAX_INSTRUMENTS = 25;
const CACHE_MS = 20 * 60 * 60 * 1000;
const HISTORY_DAYS = 400;
const tickerPattern = /^[A-Z0-9./-]{1,24}$/i;
const seriesCache = new Map<string, Series>();

function dateRange() {
  const end = Math.floor(Date.now() / 1000);
  return { start: end - HISTORY_DAYS * 24 * 60 * 60, end };
}

async function yahooSeries(ticker: string, priceCurrency?: string, benchmark = false): Promise<Omit<Series, "fetchedAt">> {
  const symbol = (benchmark && ticker.toUpperCase() === "ISF" ? "^FTSE" : alphaVantageSymbol(ticker, priceCurrency)).replace(/\.LON$/i, ".L");
  const range = dateRange();
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${range.start}&period2=${range.end}&interval=1d&events=history&includeAdjustedClose=true`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Portfolio-Lens/1.0" }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Yahoo Finance did not return historical prices.");
  const data = await response.json() as { chart?: { result?: { meta?: { currency?: string; symbol?: string }; timestamp?: number[]; indicators?: { adjclose?: { adjclose?: (number | null)[] }[]; quote?: { close?: (number | null)[] }[] } }[] } };
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  // Holdings use raw closes because dividends are already recorded as cash transactions.
  const closes = (benchmark ? result?.indicators?.adjclose?.[0]?.adjclose : undefined) ?? result?.indicators?.quote?.[0]?.close ?? [];
  const points = validHistoricalPoints(timestamps, closes);
  if (points.length === 0) throw new Error(`Yahoo Finance has no history for ${ticker}.`);
  return { symbol: result?.meta?.symbol || symbol, currency: result?.meta?.currency || (symbol.endsWith(".L") ? "GBP" : "USD"), source: "Yahoo Finance", points };
}

async function justEtfSeries(isin: string): Promise<Omit<Series, "fetchedAt">> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - HISTORY_DAYS);
  const params = new URLSearchParams({ locale: "en", currency: "GBP", valuesType: "MARKET_VALUE", reduceData: "false", includeDividends: "false", dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10) });
  const response = await fetch(`https://www.justetf.com/api/etfs/${encodeURIComponent(isin)}/performance-chart?${params}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Portfolio-Lens/1.0", Referer: "https://www.justetf.com/" }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("justETF did not return historical prices.");
  const data = await response.json() as { series?: { date?: string; timestamp?: number; value?: { raw?: number } | number }[] };
  const points = (data.series ?? []).map((point) => ({ date: point.date || (point.timestamp ? new Date(point.timestamp * 1000).toISOString().slice(0, 10) : ""), close: typeof point.value === "number" ? point.value : Number(point.value?.raw) })).filter((point) => Boolean(point.date) && Number.isFinite(point.close));
  if (points.length === 0) throw new Error("justETF returned no historical points.");
  return { symbol: isin, currency: "GBP", source: "justETF", points };
}

async function alphaVantage(params: URLSearchParams) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error("Market data is not configured.");
  params.set("apikey", key);
  const response = await fetch(`https://www.alphavantage.co/query?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Market data provider did not respond.");
  const data = await response.json() as Record<string, unknown>;
  const providerMessage = data.Information ?? data.Note ?? data["Error Message"];
  if (typeof providerMessage === "string") throw new Error(`Alpha Vantage: ${providerMessage}`);
  return data;
}

async function alphaSeries(ticker: string, priceCurrency?: string): Promise<Omit<Series, "fetchedAt">> {
  const symbol = alphaVantageSymbol(ticker, priceCurrency);
  if (symbol.includes(".") || (priceCurrency && priceCurrency !== "USD")) throw new Error("No historical prices with a verified listing currency are available.");
  const data = await alphaVantage(new URLSearchParams({ function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" }));
  const raw = data["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined;
  if (!raw) throw new Error(`Alpha Vantage has no historical series for ${ticker}.`);
  const points = Object.entries(raw).map(([date, values]) => ({ date, close: Number(values["4. close"]) })).filter((point) => Number.isFinite(point.close) && point.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) throw new Error(`Alpha Vantage returned no usable history for ${ticker}.`);
  return { symbol, currency: "USD", source: "Alpha Vantage", points };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { instruments?: RequestedInstrument[] };
    const instruments = body.instruments ?? [];
    if (!Array.isArray(instruments) || instruments.length === 0 || instruments.length > MAX_INSTRUMENTS || instruments.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.ticker !== "string" || !tickerPattern.test(item.ticker))) return NextResponse.json({ error: `Request up to ${MAX_INSTRUMENTS} valid instruments at a time.` }, { status: 400 });
    const entries: [string, Series][] = [];
    const errors: string[] = [];
    let fxPromise: Promise<Omit<Series, "fetchedAt">> | undefined;
    for (const instrument of instruments) {
      const cacheKey = `${instrument.type ?? "benchmark"}:${instrument.isin ?? ""}:${alphaVantageSymbol(instrument.ticker, instrument.priceCurrency)}`;
      const cached = seriesCache.get(cacheKey);
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_MS) {
        entries.push([instrument.id, cached]);
        continue;
      }
      try {
        let result: Omit<Series, "fetchedAt">;
        try {
          if (instrument.type === "ETF" && instrument.isin) {
            try {
              result = await justEtfSeries(instrument.isin.toUpperCase());
            } catch {
              result = await yahooSeries(instrument.ticker, instrument.priceCurrency);
            }
          } else {
            result = await yahooSeries(instrument.ticker, instrument.priceCurrency, !instrument.type);
          }
        } catch {
          result = await alphaSeries(instrument.ticker, instrument.priceCurrency);
        }
        const fx = result.currency === "USD" ? await (fxPromise ??= yahooSeries("GBPUSD=X")) : undefined;
        const withTimestamp = { ...result, currency: "GBP", points: historyInGbp(result.points, result.currency, fx?.points), fetchedAt: new Date().toISOString() };
        seriesCache.set(cacheKey, withTimestamp);
        entries.push([instrument.id, withTimestamp]);
      } catch (error) {
        errors.push(`${instrument.ticker}: ${error instanceof Error ? error.message : "Could not retrieve historical prices."}`);
      }
    }
    return NextResponse.json({ series: Object.fromEntries(entries), errors }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not retrieve historical prices.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
