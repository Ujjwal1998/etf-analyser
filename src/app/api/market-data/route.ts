import { NextResponse } from "next/server";
import { alphaVantageSymbol } from "@/lib/market/instruments";

type RequestedInstrument = { id: string; ticker: string; isin?: string; type?: "ETF" | "Share" | "Unclassified"; priceCurrency?: string };
type Quote = { price: number; currency: string; asOf: string; symbol: string; rateToGbp: number; fetchedAt: string; source: "justETF" | "Nasdaq" | "Yahoo Finance" | "Alpha Vantage" };

const MAX_INSTRUMENTS = 50;
const CACHE_MS = 20 * 60 * 60 * 1000;
const tickerPattern = /^[A-Z0-9./-]{1,24}$/i;
const quoteCache = new Map<string, Quote>();
let usdGbpCache: { rate: number; fetchedAt: number } | undefined;

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

async function usdToGbp(requestAlpha: (params: URLSearchParams) => Promise<Record<string, unknown>>) {
  try {
    const quote = await yahooQuote("GBPUSD=X");
    return 1 / quote.price;
  } catch {
    // Use Alpha Vantage if Yahoo's dated FX quote is unavailable.
  }
  const data = await requestAlpha(new URLSearchParams({ function: "CURRENCY_EXCHANGE_RATE", from_currency: "USD", to_currency: "GBP" }));
  const rate = data["Realtime Currency Exchange Rate"] as Record<string, string> | undefined;
  const parsed = Number(rate?.["5. Exchange Rate"]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Could not retrieve the USD/GBP exchange rate.");
  return parsed;
}

async function yahooQuote(symbol: string): Promise<Omit<Quote, "rateToGbp">> {
  const yahooSymbol = symbol.replace(/\.LON$/i, ".L");
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Portfolio-Lens/1.0" }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Yahoo Finance did not return a quote.");
  const data = await response.json() as { chart?: { result?: { meta?: { currency?: string; symbol?: string }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const result = data.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  for (let index = closes.length - 1; index >= 0; index--) {
    const price = closes[index];
    const timestamp = result?.timestamp?.[index];
    if (typeof price === "number" && Number.isFinite(price) && price > 0 && timestamp && result?.meta?.currency) return { price, currency: result.meta.currency, asOf: new Date(timestamp * 1000).toISOString().slice(0, 10), symbol: result.meta.symbol || yahooSymbol, fetchedAt: new Date().toISOString(), source: "Yahoo Finance" };
  }
  throw new Error("Yahoo Finance returned no usable closing price.");
}

async function justEtfQuote(isin: string): Promise<Quote> {
  const params = new URLSearchParams({ currency: "GBP", locale: "en" });
  const response = await fetch(`https://www.justetf.com/api/etfs/${isin}/quote?${params}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("justETF did not return an ETF quote.");
  const data = await response.json() as { latestQuote?: { raw?: number }; latestQuoteDate?: string; quoteTradingVenue?: string };
  const price = Number(data.latestQuote?.raw);
  if (!Number.isFinite(price) || price <= 0 || !data.latestQuoteDate) throw new Error("justETF did not return a usable ETF quote.");
  return {
    price,
    currency: "GBP",
    asOf: data.latestQuoteDate,
    symbol: data.quoteTradingVenue || isin,
    rateToGbp: 1,
    fetchedAt: new Date().toISOString(),
    source: "justETF",
  };
}

function priceNumber(value?: string) {
  return Number(value?.replace(/[^0-9.-]/g, ""));
}

async function nasdaqQuote(ticker: string): Promise<Omit<Quote, "rateToGbp">> {
  const response = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=stocks`, {
    headers: { Accept: "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 Portfolio-Lens/1.0" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Nasdaq did not return a share quote.");
  const data = await response.json() as { data?: { symbol?: string; primaryData?: { lastSalePrice?: string; lastTradeTimestamp?: string } } };
  const price = priceNumber(data.data?.primaryData?.lastSalePrice);
  const asOf = data.data?.primaryData?.lastTradeTimestamp;
  if (!Number.isFinite(price) || price <= 0 || !asOf) throw new Error("Nasdaq did not return a usable share quote.");
  return { price, currency: "USD", asOf, symbol: data.data?.symbol || ticker, fetchedAt: new Date().toISOString(), source: "Nasdaq" };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { instruments?: RequestedInstrument[] };
    const instruments = body.instruments ?? [];
    if (!Array.isArray(instruments) || instruments.length === 0 || instruments.length > MAX_INSTRUMENTS || instruments.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.ticker !== "string" || !tickerPattern.test(item.ticker))) {
      return NextResponse.json({ error: `Refresh up to ${MAX_INSTRUMENTS} valid holdings at a time.` }, { status: 400 });
    }

    let nextRequestAt = 0;
    const requestAlpha = async (params: URLSearchParams) => {
      const wait = nextRequestAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextRequestAt = Date.now() + 1_500;
      return alphaVantage(params);
    };
    const now = Date.now();
    const directShares = instruments.filter((item) => item.type !== "ETF");
    const needsUsdFx = directShares.some((item) => item.priceCurrency?.toUpperCase() === "USD");
    let rate = 1;
    let fxError: string | undefined;
    if (needsUsdFx) {
      if (usdGbpCache && now - usdGbpCache.fetchedAt < CACHE_MS) rate = usdGbpCache.rate;
      else {
        try {
          rate = await usdToGbp(requestAlpha);
          usdGbpCache = { rate, fetchedAt: now };
        } catch (error) {
          fxError = error instanceof Error ? error.message : "Could not retrieve USD/GBP exchange rate.";
        }
      }
    }
    const entries: [string, Quote][] = [];
    const errors: string[] = [];
    for (const instrument of instruments) {
      const currency = instrument.priceCurrency?.toUpperCase() || "GBP";
      if (instrument.type === "ETF") {
        if (!instrument.isin || !/^[A-Z0-9]{12}$/i.test(instrument.isin)) {
          errors.push(`${instrument.ticker}: This ETF has no valid ISIN for justETF pricing.`);
          continue;
        }
        const cacheKey = `justetf:${instrument.isin.toUpperCase()}`;
        const cached = quoteCache.get(cacheKey);
        if (cached && now - Date.parse(cached.fetchedAt) < CACHE_MS) {
          entries.push([instrument.id, cached]);
          continue;
        }
        try {
          const result = await justEtfQuote(instrument.isin.toUpperCase());
          quoteCache.set(cacheKey, result);
          entries.push([instrument.id, result]);
        } catch (error) {
          errors.push(`${instrument.ticker}: ${error instanceof Error ? error.message : "Could not retrieve a justETF quote."}`);
        }
        continue;
      }
      const symbol = alphaVantageSymbol(instrument.ticker, currency);
      const cacheKey = `${symbol}:${currency}`;
      const cached = quoteCache.get(cacheKey);
      if (cached && now - Date.parse(cached.fetchedAt) < CACHE_MS) {
        entries.push([instrument.id, cached]);
        continue;
      }
      if (currency === "USD" && fxError) {
        errors.push(`${instrument.ticker}: ${fxError}`);
        continue;
      }
      try {
        try {
          if (currency !== "USD" || symbol.includes(".")) throw new Error("Use the listing-specific provider for this holding.");
          const nasdaq = await nasdaqQuote(instrument.ticker);
          const result = { ...nasdaq, rateToGbp: rate };
          quoteCache.set(cacheKey, result);
          entries.push([instrument.id, result]);
          continue;
        } catch {
          // Resolve listing currency from Yahoo before considering an unlabelled fallback.
        }
        try {
          const yahoo = await yahooQuote(symbol);
          const actualCurrency = yahoo.currency === "GBp" ? "GBX" : yahoo.currency.toUpperCase();
          if (actualCurrency === "USD" && currency !== "USD") throw new Error("The quote listing currency does not match this holding.");
          if (!["GBP", "GBX", "USD"].includes(actualCurrency)) throw new Error(`Pricing in ${actualCurrency} is not supported.`);
          const result = { ...yahoo, rateToGbp: actualCurrency === "USD" ? rate : actualCurrency === "GBX" ? 0.01 : 1 };
          quoteCache.set(cacheKey, result);
          entries.push([instrument.id, result]);
          continue;
        } catch {
          // GLOBAL_QUOTE has no currency field. Restrict it to identified US listings.
        }
        if (currency !== "USD" || symbol.includes(".")) throw new Error("No quote with a verified listing currency is available for this holding.");
        const data = await requestAlpha(new URLSearchParams({ function: "GLOBAL_QUOTE", symbol }));
        const quote = data["Global Quote"] as Record<string, string> | undefined;
        const price = Number(quote?.["05. price"]);
        const asOf = quote?.["07. latest trading day"];
        if (!Number.isFinite(price) || price <= 0 || !asOf) throw new Error(`No end-of-day quote is available for ${instrument.ticker}.`);
        const fetchedAt = new Date().toISOString();
        const result = { price, currency: "USD", asOf, symbol, rateToGbp: rate, fetchedAt, source: "Alpha Vantage" as const };
        quoteCache.set(cacheKey, result);
        entries.push([instrument.id, result]);
      } catch (error) {
        errors.push(`${instrument.ticker}: ${error instanceof Error ? error.message : "Could not retrieve a quote."}`);
      }
    }

    return NextResponse.json({ quotes: Object.fromEntries(entries), errors }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not refresh end-of-day prices.";
    return NextResponse.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
