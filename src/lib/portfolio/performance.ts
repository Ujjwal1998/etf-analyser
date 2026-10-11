import { holdingType } from "./summary";
import type { BenchmarkHistory, Transaction } from "./types";

export function transactionKey(transaction: Transaction) {
  return transaction.isin || transaction.ticker || transaction.name || transaction.id;
}

export function tradedInstruments(transactions: Transaction[]) {
  const instruments = new Map<string, { id: string; ticker: string; isin?: string; type: ReturnType<typeof holdingType>; priceCurrency?: string }>();
  for (const transaction of transactions) {
    if ((transaction.kind === "buy" || transaction.kind === "sell") && transaction.ticker) {
      const id = transactionKey(transaction);
      instruments.set(id, { id, ticker: transaction.ticker, isin: transaction.isin, type: holdingType(transaction.isin, transaction.ticker, transaction.name), priceCurrency: transaction.priceCurrency });
    }
  }
  return [...instruments.values()];
}

export function closeOnOrBefore(points: { date: string; close: number }[] | undefined, date: string) {
  let result: number | undefined;
  for (const point of points ?? []) {
    if (point.date > date) break;
    if (Number.isFinite(point.close) && point.close > 0) result = point.close;
  }
  return result;
}

export function portfolioPerformanceSeries(transactions: Transaction[], history: BenchmarkHistory) {
  const sorted = transactions.toSorted((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const dates = [...new Set([...Object.values(history.series).flatMap((series) => series.points.map((point) => point.date)), ...sorted.map((transaction) => transaction.timestamp.slice(0, 10))])].toSorted();
  const shares = new Map<string, number>();
  let cash = 0;
  let previousValue: number | undefined;
  let index = 100;
  let transactionIndex = 0;
  const indexed: { date: string; close: number }[] = [];
  for (const date of dates) {
    let externalFlow = 0;
    while (transactionIndex < sorted.length && sorted[transactionIndex].timestamp.slice(0, 10) <= date) {
      const transaction = sorted[transactionIndex++];
      const amount = transaction.total;
      if (transaction.kind === "deposit") { cash += amount; externalFlow += amount; }
      else if (transaction.kind === "withdrawal") { cash -= amount; externalFlow -= amount; }
      else if (transaction.kind === "dividend") cash += amount;
      else if (transaction.kind === "tax") cash -= amount;
      else if ((transaction.kind === "buy" || transaction.kind === "sell") && transaction.shares) {
        const key = transactionKey(transaction);
        shares.set(key, (shares.get(key) ?? 0) + (transaction.kind === "buy" ? transaction.shares : -transaction.shares));
        cash += transaction.kind === "buy" ? -(amount + transaction.fxFee) : amount - transaction.fxFee;
      }
    }
    let marketValue = 0;
    let complete = true;
    for (const [key, held] of shares) {
      if (held <= 0.00000001) continue;
      const series = history.series[key];
      const price = closeOnOrBefore(series?.points, date);
      if (series?.currency !== "GBP" || price === undefined) { complete = false; break; }
      marketValue += held * price;
    }
    // Never bridge an unpriced interval with an invented zero valuation.
    if (!complete) { previousValue = undefined; indexed.length = 0; index = 100; continue; }
    const value = cash + marketValue;
    if (previousValue !== undefined && previousValue > 0) index *= (value - externalFlow) / previousValue;
    else if (value > 0) index = 100;
    if (value > 0 && Number.isFinite(index)) indexed.push({ date, close: index });
    previousValue = value;
  }
  return indexed;
}
