import { describe, expect, it } from "vitest";
import { portfolioPerformanceSeries, tradedInstruments } from "./performance";
import { buildPortfolioSummary } from "./summary";
import type { BenchmarkHistory, Transaction } from "./types";

function transaction(kind: Transaction["kind"], date: string, total: number, extra: Partial<Transaction> = {}): Transaction {
  return { id: `${kind}-${date}`, kind, timestamp: `${date}T10:00:00.000Z`, currency: "GBP", total, fxFee: 0, ...extra };
}
const activity = [transaction("deposit", "2026-01-01", 100), transaction("buy", "2026-01-01", 100, { isin: "asset", ticker: "TEST", shares: 1 })];
const history: BenchmarkHistory = { fetchedAt: "2026-01-03", series: { asset: { symbol: "TEST", currency: "GBP", source: "Yahoo Finance", points: [{ date: "2026-01-01", close: 100 }, { date: "2026-01-02", close: 100 }, { date: "2026-01-03", close: 100 }] } } };

describe("portfolio performance", () => {
  it("includes dividends and withholding tax in returns", () => {
    const points = portfolioPerformanceSeries([...activity, transaction("dividend", "2026-01-02", 10), transaction("tax", "2026-01-03", 2)], history);
    expect(points[0].close).toBe(100);
    expect(points[1].close).toBeCloseTo(110);
    expect(points[2].close).toBeCloseTo(108);
  });
  it("removes deposits and withdrawals from investment returns", () => {
    const points = portfolioPerformanceSeries([...activity, transaction("deposit", "2026-01-02", 50), transaction("withdrawal", "2026-01-03", 20)], history);
    expect(points.map((point) => point.close)).toEqual([100, 100, 100]);
  });
  it("values a position before it was fully sold", () => {
    const transactions = [...activity, transaction("sell", "2026-01-02", 100, { isin: "asset", ticker: "TEST", shares: 1 })];
    expect(buildPortfolioSummary(transactions).holdings).toHaveLength(0);
    expect(tradedInstruments(transactions)).toHaveLength(1);
    expect(portfolioPerformanceSeries(transactions, history).map((point) => point.close)).toEqual([100, 100, 100]);
  });
  it("does not invent returns before the first priced holding date", () => {
    const laterHistory = { ...history, series: { asset: { ...history.series.asset, points: history.series.asset.points.slice(1) } } };
    expect(portfolioPerformanceSeries(activity, laterHistory).map((point) => point.date)).toEqual(["2026-01-02", "2026-01-03"]);
  });
  it("shows no portfolio performance when a held instrument has no history", () => {
    expect(portfolioPerformanceSeries(activity, { ...history, series: {} })).toEqual([]);
  });
  it("accounts for withdrawals in the headline gain", () => {
    const summary = buildPortfolioSummary([transaction("deposit", "2026-01-01", 1000), transaction("withdrawal", "2026-01-02", 200)]);
    expect(summary.netContributions).toBe(800);
    expect(summary.availableCash - summary.netContributions).toBe(0);
  });
});
