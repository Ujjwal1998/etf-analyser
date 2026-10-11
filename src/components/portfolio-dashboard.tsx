"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseTrading212File } from "@/lib/portfolio/parser";
import { calculateRiskMetrics, pointsForPeriod } from "@/lib/portfolio/risk-metrics";
import { buildPortfolioSummary } from "@/lib/portfolio/summary";
import { closeOnOrBefore, portfolioPerformanceSeries, tradedInstruments } from "@/lib/portfolio/performance";
import { Metric, MetricSelect, PanelHeading } from "@/components/dashboard-primitives";
import type { BenchmarkHistory, ConstituentSnapshot, Holding, StoredPortfolio } from "@/lib/portfolio/types";

const STORAGE_KEY = "portfolio-analyser/v1";
const EOD_CACHE_MS = 20 * 60 * 60 * 1000;
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const POSITION_COLOURS = ["#126a4b", "#c7683e", "#466bb0", "#8a5aa4", "#c89b2b", "#3b8991", "#a24f6b", "#667b42"];
const HOLDING_COLOURS = ["#204c43", "#c7683e", "#466bb0", "#8a5aa4", "#c89b2b", "#3b8991", "#a24f6b", "#667b42", "#777a3f", "#84644b"];
const BENCHMARKS = [{ id: "sp500", ticker: "SPY" }, { id: "ftse100", ticker: "ISF" }, { id: "nasdaq100", ticker: "QQQ" }] as const;
const BENCHMARK_PERIODS = [{ label: "1 year", days: 365 }, { label: "6 months", days: 182 }, { label: "3 months", days: 91 }, { label: "1 month", days: 30 }, { label: "1 week", days: 7 }] as const;

function dateOnly(value?: string) {
  return value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(value)) : "—";
}

function DonutChart({ title, items }: { title: string; items: { label: string; value: number; colour: string }[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return <p className="empty-chart">No allocation data is available yet.</p>;
  const segments = items.map((item, index) => {
    const start = items.slice(0, index).reduce((sum, previous) => sum + previous.value, 0) / total * 100;
    return { ...item, start, percentage: item.value / total * 100 };
  });
  return <div className="donut-layout">
    <svg className="donut" viewBox="0 0 100 100" role="img" aria-label={title}><circle className="donut-track" cx="50" cy="50" r="38" pathLength="100" />{segments.map((item) => <circle key={item.label} className="donut-segment" cx="50" cy="50" r="38" pathLength="100" stroke={item.colour} strokeDasharray={`${item.percentage} ${100 - item.percentage}`} strokeDashoffset={-item.start} />)}<text x="50" y="48" textAnchor="middle">{pounds.format(total)}</text><text x="50" y="59" textAnchor="middle">allocated</text></svg>
    <ul className="donut-legend">{items.map((item) => <li key={item.label}><i style={{ backgroundColor: item.colour }} /><span>{item.label}</span><strong>{(item.value / total * 100).toFixed(1)}%</strong></li>)}</ul>
  </div>;
}

type BenchmarkMetric = "return" | "volatility" | "drawdown" | "downside";
type BenchmarkPoint = { label: string; date: string; portfolio?: number; sp500?: number; ftse100?: number; nasdaq100?: number };
type BenchmarkMetricPoint = { label: string; portfolio?: Partial<Record<BenchmarkMetric, number>>; sp500?: Partial<Record<BenchmarkMetric, number>>; ftse100?: Partial<Record<BenchmarkMetric, number>>; nasdaq100?: Partial<Record<BenchmarkMetric, number>> };

function BenchmarkChart({ points, metricPoints }: { points: BenchmarkPoint[]; metricPoints: BenchmarkMetricPoint[] }) {
  const [metric, setMetric] = useState<BenchmarkMetric>("return");
  const lines = [{ key: "portfolio", label: "Your portfolio", colour: "#126a4b" }, { key: "sp500", label: "S&P 500 (SPY)", colour: "#466bb0" }, { key: "ftse100", label: "FTSE 100 (^FTSE)", colour: "#c7683e" }, { key: "nasdaq100", label: "Nasdaq-100 (QQQ)", colour: "#8a5aa4" }] as const;
  const available = lines.flatMap((line) => points.map((point) => point[line.key])).filter((value): value is number => value !== undefined);
  if (points.length < 2 || available.length === 0) return <p className="empty-chart">Historical prices are not available for this comparison yet.</p>;
  const min = Math.min(...available, 95);
  const max = Math.max(...available, 105);
  const range = Math.max(max - min, 1);
  const chartY = (value: number) => 96 - ((value - min) / range) * 82;
  const makePath = (key: keyof BenchmarkPoint) => {
    let started = false;
    return points.flatMap((point, index) => {
      const value = point[key];
      if (typeof value !== "number") return [];
      const x = (index / (points.length - 1)) * 100;
      const y = chartY(value);
      const command = started ? "L" : "M";
      started = true;
      return [`${command}${x.toFixed(2)},${y.toFixed(2)}`];
    }).join(" ");
  };
  const today = points.at(-1);
  const periods = points.filter((point) => point.label !== "Today").reverse();
  const metricLabels: Record<BenchmarkMetric, string> = { return: "Return", volatility: "Volatility", drawdown: "Max drawdown", downside: "Downside deviation" };
  const metricDescriptions: Record<BenchmarkMetric, string> = { return: "Total return", volatility: "Annualised daily volatility", drawdown: "Largest peak-to-trough decline", downside: "Annualised negative-return volatility" };
  const activeMetricPoints = metricPoints.filter((point) => point.label !== "Today").reverse();
  const metricValue = (value: number | undefined) => value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
  const bestValue = (values: number[]) => values.length === 0 ? undefined : metric === "return" ? Math.max(...values) : Math.min(...values);
  const returnNumber = (start: number | undefined, end: number | undefined) => start !== undefined && end !== undefined && start !== 0 ? (end / start - 1) * 100 : undefined;
  const returnValue = (start: number | undefined, end: number | undefined) => start !== undefined && end !== undefined && start !== 0 ? `${end >= start ? "+" : ""}${((end / start - 1) * 100).toFixed(1)}%` : "—";
  return <div className="chart-wrap benchmark-chart" aria-label="Portfolio return compared with benchmark indices">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"><line x1="0" y1="96" x2="100" y2="96" className="axis" />{lines.map((line) => <path key={line.key} d={makePath(line.key)} className="line" style={{ stroke: line.colour }} />)}</svg>
    <div className="chart-labels"><span>{points[0].label}</span><span>{points.at(-1)?.label}</span></div>
    <div className="legend benchmark-legend">{lines.map((line) => <span key={line.key}><i style={{ backgroundColor: line.colour }} />{line.label}</span>)}</div>
    <div className="benchmark-controls"><MetricSelect value={metric} options={metricLabels} onChange={(event) => setMetric(event.target.value as BenchmarkMetric)} /><div className="benchmark-metric-description"><span className="eyebrow">Selected view</span><strong>{metricDescriptions[metric]}</strong></div></div>
    {today && <div className="table-scroll benchmark-table"><table><thead><tr><th>Period</th><th>Your portfolio</th><th>S&amp;P 500</th><th>FTSE 100</th><th>Nasdaq-100</th></tr></thead><tbody>{metric === "return" ? periods.map((period) => { const returns = { portfolio: returnNumber(period.portfolio, today.portfolio), sp500: returnNumber(period.sp500, today.sp500), ftse100: returnNumber(period.ftse100, today.ftse100), nasdaq100: returnNumber(period.nasdaq100, today.nasdaq100) }; const best = bestValue(Object.values(returns).filter((value): value is number => value !== undefined)); return <tr key={period.label}><td>{period.label}</td><td className={returns.portfolio !== undefined && returns.portfolio === best ? "best-return" : ""}>{returnValue(period.portfolio, today.portfolio)}</td><td className={returns.sp500 !== undefined && returns.sp500 === best ? "best-return" : ""}>{returnValue(period.sp500, today.sp500)}</td><td className={returns.ftse100 !== undefined && returns.ftse100 === best ? "best-return" : ""}>{returnValue(period.ftse100, today.ftse100)}</td><td className={returns.nasdaq100 !== undefined && returns.nasdaq100 === best ? "best-return" : ""}>{returnValue(period.nasdaq100, today.nasdaq100)}</td></tr>; }) : activeMetricPoints.map((point) => { const values = { portfolio: point.portfolio?.[metric], sp500: point.sp500?.[metric], ftse100: point.ftse100?.[metric], nasdaq100: point.nasdaq100?.[metric] }; const best = bestValue(Object.values(values).filter((value): value is number => value !== undefined)); return <tr key={point.label}><td>{point.label}</td>{lines.map((line) => <td key={line.key} className={values[line.key] !== undefined && values[line.key] === best ? "best-return" : ""}>{metricValue(values[line.key])}</td>)}</tr>; })}</tbody></table></div>}
    <div className="benchmark-disclaimer">The portfolio line is time-weighted, so deposits and withdrawals do not count as investment performance. Benchmarks use SPY for the S&amp;P 500, ^FTSE for the FTSE 100 and QQQ for the Nasdaq-100. History uses justETF for ETFs, Yahoo Finance for shares and indices, and Alpha Vantage only as fallback. Data is cached locally for 20 hours.</div>
  </div>;
}

export default function PortfolioDashboard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const autoRefreshKeyRef = useRef<string | null>(null);
  const benchmarkFetchKeyRef = useRef<string | null>(null);
  const importGenerationRef = useRef(0);
  const portfolioRef = useRef<StoredPortfolio | null>(null);
  const quoteRequestRef = useRef<number | null>(null);
  const historyRequestRef = useRef<number | null>(null);
  const [portfolio, setPortfolio] = useState<StoredPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const savePortfolio = useCallback((next: StoredPortfolio | null) => {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
    portfolioRef.current = next;
    setPortfolio(next);
  }, []);

  const mergePortfolio = useCallback((generation: number, update: (current: StoredPortfolio) => StoredPortfolio) => {
    if (generation !== importGenerationRef.current || !portfolioRef.current) return;
    savePortfolio(update(portfolioRef.current));
  }, [savePortfolio]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as StoredPortfolio;
      if (parsed.version !== 1) return;
      if (!Array.isArray(parsed.transactions) || parsed.transactions.some((transaction) => transaction.currency !== "GBP" || !Number.isFinite(Date.parse(transaction.timestamp)))) throw new Error("Replace the saved portfolio with a GBP export.");
      parsed.transactions = parsed.transactions.map((transaction) => ({ ...transaction, timestamp: new Date(transaction.timestamp).toISOString() }));
      if (parsed.calculationVersion !== 2) {
        parsed.quotes = undefined;
        parsed.benchmarkHistory = undefined;
        parsed.calculationVersion = 2;
      }
      const timer = window.setTimeout(() => savePortfolio(parsed), 0);
      return () => window.clearTimeout(timer);
    } catch (error) {
      const timer = window.setTimeout(() => setMessage(error instanceof Error ? error.message : "Saved portfolio data could not be read. Replace the export."), 0);
      return () => window.clearTimeout(timer);
    }
  }, [savePortfolio]);

  const summary = useMemo(() => portfolio && buildPortfolioSummary(portfolio.transactions), [portfolio]);
  const refreshHistory = useCallback(async () => {
    const current = portfolioRef.current;
    if (!current || historyRequestRef.current === importGenerationRef.current) return;
    const instruments = [...tradedInstruments(current.transactions), ...BENCHMARKS.map((benchmark) => ({ id: benchmark.id, ticker: benchmark.ticker }))];
    const history = current.benchmarkHistory;
    if (history && Date.now() - Date.parse(history.fetchedAt) < EOD_CACHE_MS && instruments.every((instrument) => history.series[instrument.id]?.currency === "GBP")) return;
    const generation = importGenerationRef.current;
    historyRequestRef.current = generation;
    try {
      const series: BenchmarkHistory["series"] = {};
      const errors: string[] = [];
      for (let offset = 0; offset < instruments.length; offset += 25) {
        const response = await fetch("/api/historical-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruments: instruments.slice(offset, offset + 25) }) });
        const payload = await response.json() as { series?: BenchmarkHistory["series"]; errors?: string[]; error?: string };
        if (!response.ok || !payload.series) throw new Error(payload.error || "Could not retrieve historical prices.");
        if (generation !== importGenerationRef.current) return;
        Object.assign(series, payload.series);
        errors.push(...payload.errors ?? []);
      }
      mergePortfolio(generation, (latest) => ({ ...latest, benchmarkHistory: { fetchedAt: new Date().toISOString(), series } }));
      if (errors.length) setMessage(`Benchmark data is partial: ${errors[0]}`);
    } catch (error) {
      if (generation === importGenerationRef.current) setMessage(error instanceof Error ? error.message : "Could not retrieve historical prices.");
    } finally {
      if (historyRequestRef.current === generation) historyRequestRef.current = null;
    }
  }, [mergePortfolio]);
  useEffect(() => {
    if (!portfolio || benchmarkFetchKeyRef.current === portfolio.importedAt) return;
    benchmarkFetchKeyRef.current = portfolio.importedAt;
    void refreshHistory();
  }, [portfolio, refreshHistory]);
  const valuation = useMemo(() => {
    if (!portfolio || !summary) return null;
    const priced = summary.holdings.map((holding) => {
      const quote = portfolio.quotes?.[holding.key];
      return quote ? { key: holding.key, value: holding.shares * quote.price * quote.rateToGbp } : null;
    }).filter((value): value is { key: string; value: number } => value !== null);
    return priced.length === summary.holdings.length ? priced.reduce((total, item) => total + item.value, 0) : null;
  }, [portfolio, summary]);
  const totalReturn = valuation === null || !summary ? null : valuation + summary.availableCash - summary.netContributions;
  const etfHoldings = summary?.holdings.filter((holding) => holding.type === "ETF") ?? [];
  const positionColours = useMemo(() => new Map((summary?.holdings ?? []).map((holding, index) => [holding.key, POSITION_COLOURS[index % POSITION_COLOURS.length]])), [summary]);
  const positionAllocation = useMemo(() => (summary?.holdings ?? []).map((holding) => {
    const quote = portfolio?.quotes?.[holding.key];
    return { label: holding.ticker || holding.name, value: quote ? holding.shares * quote.price * quote.rateToGbp : holding.costBasis, colour: positionColours.get(holding.key) || POSITION_COLOURS[0] };
  }), [portfolio, positionColours, summary]);
  const constituentExposure = useMemo(() => {
    if (!portfolio || !summary) return [];
    const exposure = new Map<string, { name: string; ticker?: string; effectiveWeight: number; effectiveValue: number; sources: { key: string; label: string; effectiveWeight: number; value: number }[] }>();
    for (const holding of summary.holdings) {
      const snapshot = portfolio.constituents?.[holding.key];
      const holdingValue = valuation === null
        ? holding.costBasis
        : holding.shares * (portfolio.quotes?.[holding.key]?.price ?? 0) * (portfolio.quotes?.[holding.key]?.rateToGbp ?? 1);
      const allocation = holdingValue / (valuation === null ? summary.costBasis : valuation);
      if (holding.type === "Share") {
        const key = holding.isin || holding.ticker || holding.name;
        const current = exposure.get(key) ?? { name: holding.name, ticker: holding.ticker, effectiveWeight: 0, effectiveValue: 0, sources: [] };
        current.ticker ??= holding.ticker;
        current.effectiveWeight += allocation * 100;
        current.effectiveValue += holdingValue;
        current.sources.push({ key: holding.key, label: "Direct position", effectiveWeight: allocation * 100, value: holdingValue });
        exposure.set(key, current);
        continue;
      }
      if (!snapshot) continue;
      for (const constituent of snapshot.constituents) {
        const key = constituent.isin || constituent.ticker || constituent.name;
        const contribution = allocation * constituent.weight;
        const current = exposure.get(key) ?? { name: constituent.name, ticker: constituent.ticker, effectiveWeight: 0, effectiveValue: 0, sources: [] };
        current.effectiveWeight += contribution;
        const contributionValue = holdingValue * constituent.weight / 100;
        current.effectiveValue += contributionValue;
        current.sources.push({ key: holding.key, label: holding.ticker || holding.name, effectiveWeight: contribution, value: contributionValue });
        exposure.set(key, current);
      }
    }
    return [...exposure.values()].toSorted((a, b) => b.effectiveValue - a.effectiveValue);
  }, [portfolio, summary, valuation]);
  const constituentAllocation = useMemo(() => {
    const topHoldings = constituentExposure.slice(0, 10).map((item, index) => ({ label: item.ticker || item.name, value: item.effectiveValue, colour: HOLDING_COLOURS[index % HOLDING_COLOURS.length] }));
    const totalPortfolioValue = valuation ?? summary?.costBasis ?? 0;
    const otherValue = totalPortfolioValue - topHoldings.reduce((sum, item) => sum + item.value, 0);
    return otherValue > 0.01 ? [...topHoldings, { label: "Other / undisclosed", value: otherValue, colour: "#d7dbd4" }] : topHoldings;
  }, [constituentExposure, summary, valuation]);
  const topConstituentsTotal = useMemo(() => {
    const value = constituentExposure.slice(0, 10).reduce((sum, item) => sum + item.effectiveValue, 0);
    const portfolioValue = valuation ?? summary?.costBasis ?? 0;
    return { value, weight: portfolioValue > 0 ? (value / portfolioValue) * 100 : 0 };
  }, [constituentExposure, summary, valuation]);
  const benchmarkSeries = useMemo(() => {
    if (!portfolio || !summary || !portfolio.benchmarkHistory) return {};
    return {
      portfolio: portfolioPerformanceSeries(portfolio.transactions, portfolio.benchmarkHistory),
      sp500: portfolio.benchmarkHistory.series.sp500?.points ?? [],
      ftse100: portfolio.benchmarkHistory.series.ftse100?.points ?? [],
      nasdaq100: portfolio.benchmarkHistory.series.nasdaq100?.points ?? [],
    };
  }, [portfolio, summary]);
  const benchmarkPoints = useMemo<BenchmarkPoint[]>(() => {
    if (!portfolio || !summary?.firstTransaction || !portfolio.benchmarkHistory) return [];
    const periods = [...BENCHMARK_PERIODS, { label: "Today", days: 0 }].map((period) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - period.days);
      return { ...period, date: date.toISOString().slice(0, 10) };
    });
    const raw = periods.map((period) => {
      return { label: period.label, date: period.date, portfolio: closeOnOrBefore(benchmarkSeries.portfolio, period.date), sp500: closeOnOrBefore(benchmarkSeries.sp500, period.date), ftse100: closeOnOrBefore(benchmarkSeries.ftse100, period.date), nasdaq100: closeOnOrBefore(benchmarkSeries.nasdaq100, period.date) };
    });
    const base = raw.find((point) => point.portfolio !== undefined && point.sp500 !== undefined && point.ftse100 !== undefined && point.nasdaq100 !== undefined);
    if (!base) return [];
    const baseFor = (key: keyof BenchmarkPoint) => base[key] as number;
    return raw.map((point) => ({ label: point.label, date: point.date, portfolio: point.date < base.date || point.portfolio === undefined ? undefined : point.portfolio / baseFor("portfolio") * 100, sp500: point.date < base.date || point.sp500 === undefined ? undefined : point.sp500 / baseFor("sp500") * 100, ftse100: point.date < base.date || point.ftse100 === undefined ? undefined : point.ftse100 / baseFor("ftse100") * 100, nasdaq100: point.date < base.date || point.nasdaq100 === undefined ? undefined : point.nasdaq100 / baseFor("nasdaq100") * 100 }));
  }, [benchmarkSeries, portfolio, summary]);
  const benchmarkMetricPoints = useMemo<BenchmarkMetricPoint[]>(() => {
    if (!benchmarkSeries.portfolio) return [];
    const today = new Date().toISOString().slice(0, 10);
    return BENCHMARK_PERIODS.map((period) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - period.days);
      const startDate = start.toISOString().slice(0, 10);
      const metricFor = (series: { date: string; close: number }[] | undefined, requirePeriodStart = false) => {
        if (!series) return {};
        const window = pointsForPeriod(series, startDate, today);
        if (requirePeriodStart && window[0]?.date > startDate) return {};
        const metrics = calculateRiskMetrics(window);
        return { return: metrics.totalReturn, volatility: metrics.volatility, drawdown: metrics.maxDrawdown, downside: metrics.downsideDeviation };
      };
      const metrics = { portfolio: metricFor(benchmarkSeries.portfolio, true), sp500: metricFor(benchmarkSeries.sp500), ftse100: metricFor(benchmarkSeries.ftse100), nasdaq100: metricFor(benchmarkSeries.nasdaq100) };
      return { label: period.label, portfolio: metrics.portfolio, sp500: metrics.sp500, ftse100: metrics.ftse100, nasdaq100: metrics.nasdaq100 };
    });
  }, [benchmarkSeries]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const generation = ++importGenerationRef.current;
    setLoading(true);
    setRefreshing(false);
    setMessage(null);
    try {
      const result = await parseTrading212File(file);
      if (result.transactions.length === 0) {
        setMessage(result.warnings[0]?.message ?? "No supported transactions were found.");
        return;
      }
      const next: StoredPortfolio = { version: 1, calculationVersion: 2, importedAt: new Date().toISOString(), fileName: file.name, transactions: result.transactions, warnings: result.warnings };
      if (generation !== importGenerationRef.current) return;
      savePortfolio(next);
      const importedEtfs = buildPortfolioSummary(result.transactions).holdings.filter((holding) => holding.type === "ETF" && holding.isin);
      let fetched = 0;
      for (const holding of importedEtfs) {
        if (generation !== importGenerationRef.current) return;
        try {
          const snapshot = await fetchConstituents(holding);
          mergePortfolio(generation, (current) => ({ ...current, constituents: { ...current.constituents, [holding.key]: snapshot } }));
          fetched += 1;
        } catch {
          // A missing public page should not block importing the user's local transaction data.
        }
      }
      if (generation !== importGenerationRef.current) return;
      setMessage(`Imported ${result.transactions.length} transactions and fetched holdings for ${fetched} of ${importedEtfs.length} ETFs.`);
    } catch (error) {
      if (generation === importGenerationRef.current) setMessage(error instanceof Error ? error.message : "The file could not be read. Check that it is a Trading 212 CSV or XLSX export.");
    } finally {
      if (generation === importGenerationRef.current) setLoading(false);
      event.target.value = "";
    }
  }

  function clearPortfolio() {
    importGenerationRef.current += 1;
    savePortfolio(null);
    setLoading(false);
    setRefreshing(false);
    setMessage("Local portfolio data deleted.");
  }

  const refreshPrices = useCallback(async () => {
    const portfolio = portfolioRef.current;
    if (!portfolio || quoteRequestRef.current === importGenerationRef.current) return;
    const summary = buildPortfolioSummary(portfolio.transactions);
    const generation = importGenerationRef.current;
    const staleHoldings = summary.holdings.filter((holding) => {
      const fetchedAt = portfolio.quotes?.[holding.key]?.fetchedAt;
      return !fetchedAt || Date.now() - Date.parse(fetchedAt) > EOD_CACHE_MS;
    });
    if (staleHoldings.length === 0) {
      setMessage("Using the local end-of-day snapshot. It will be eligible for refresh in 20 hours.");
      return;
    }
    const refreshableHoldings = staleHoldings.filter((holding) => holding.ticker);
    if (refreshableHoldings.length === 0) {
      setMessage("None of the holdings has a ticker that can be priced yet.");
      return;
    }
    setMessage(null);
    quoteRequestRef.current = generation;
    setRefreshing(true);
    try {
      const quotes: NonNullable<StoredPortfolio["quotes"]> = {};
      const errors: string[] = [];
      for (let offset = 0; offset < refreshableHoldings.length; offset += 50) {
        const response = await fetch("/api/market-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruments: refreshableHoldings.slice(offset, offset + 50).map((holding) => ({ id: holding.key, ticker: holding.ticker, isin: holding.isin, type: holding.type, priceCurrency: holding.priceCurrency })) }),
        });
        const payload = await response.json() as { quotes?: StoredPortfolio["quotes"]; errors?: string[]; error?: string };
        if (!response.ok || !payload.quotes) throw new Error(payload.error || "Could not refresh end-of-day prices.");
        if (generation !== importGenerationRef.current) return;
        mergePortfolio(generation, (current) => ({ ...current, quotes: { ...current.quotes, ...payload.quotes } }));
        Object.assign(quotes, payload.quotes);
        errors.push(...payload.errors ?? []);
      }
      const refreshedCount = Object.keys(quotes).length;
      if (refreshedCount === 0) throw new Error(errors[0] || "No end-of-day quotes were returned.");
      const skipped = errors.length;
      setMessage(skipped > 0
        ? `Refreshed ${refreshedCount} quote${refreshedCount === 1 ? "" : "s"}; ${skipped} could not be refreshed. ${errors[0]}`
        : `Refreshed ${refreshedCount} quote${refreshedCount === 1 ? "" : "s"}: ETFs use justETF; shares use Nasdaq or Yahoo Finance, with Alpha Vantage as fallback.`);
    } catch (error) {
      if (generation === importGenerationRef.current) setMessage(error instanceof Error ? error.message : "Could not refresh end-of-day prices.");
    } finally {
      if (quoteRequestRef.current === generation) quoteRequestRef.current = null;
      if (generation === importGenerationRef.current) setRefreshing(false);
    }
  }, [mergePortfolio]);

  useEffect(() => {
    if (!portfolio || !summary || autoRefreshKeyRef.current === portfolio.importedAt) return;
    const hasStaleQuote = summary.holdings.some((holding) => {
      const fetchedAt = portfolio.quotes?.[holding.key]?.fetchedAt;
      return !fetchedAt || Date.now() - Date.parse(fetchedAt) > EOD_CACHE_MS;
    });
    if (!hasStaleQuote) return;
    const importedAt = portfolio.importedAt;
    const timer = window.setTimeout(() => {
      if (autoRefreshKeyRef.current === importedAt) return;
      autoRefreshKeyRef.current = importedAt;
      void refreshPrices();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [portfolio, refreshPrices, summary]);

  async function fetchConstituents(holding: Holding): Promise<ConstituentSnapshot> {
    if (!holding.isin) throw new Error("This ETF does not have an ISIN available for holdings lookup.");
    const response = await fetch("/api/constituents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isin: holding.isin }) });
    const payload = await response.json() as { constituents?: ConstituentSnapshot["constituents"]; coverage?: number; holdingsDate?: string; sourceUrl?: string; error?: string };
    if (!response.ok || !payload.constituents || payload.coverage === undefined) throw new Error(payload.error || "Could not fetch holdings.");
    return { importedAt: new Date().toISOString(), coverage: payload.coverage, holdingsDate: payload.holdingsDate, sourceUrl: payload.sourceUrl, constituents: payload.constituents };
  }

  return <main className="dashboard-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Portfolio Lens home"><span className="brand-mark">PL</span><span>Portfolio Lens</span></a>
      <div className="privacy-chip"><span /> Local portfolio data</div>
    </header>

    <section className="hero" id="top">
      <div><p className="eyebrow">ETF portfolio analyser</p><h1>Know what your money has actually bought.</h1><p className="hero-copy">Import a Trading 212 export. Your transaction history stays in this browser.</p></div>
      <div className="hero-note"><span>End-of-day pricing</span><p>Refreshes send instrument tickers only. Your transactions and portfolio totals stay in this browser.</p></div>
    </section>

    {!portfolio ? <section className="upload-card" aria-labelledby="upload-title">
      <div className="upload-icon" aria-hidden="true">↥</div>
      <p className="eyebrow">Start here</p><h2 id="upload-title">Import your portfolio activity</h2>
      <p>Use a Trading 212 account statement in CSV or XLSX format. We read it in your browser and do not upload it anywhere.</p>
      <input ref={inputRef} id="portfolio-file" type="file" accept=".csv,.xlsx" onChange={handleFile} hidden />
      <button className="primary-button" type="button" onClick={() => inputRef.current?.click()} disabled={loading}>{loading ? "Reading file…" : "Choose export"}</button>
      <p className="small-print">Supported: deposits, withdrawals, market buys, market sells, dividends and withholding tax.</p>
    </section> : <>
      <section className="portfolio-heading">
        <div><p className="eyebrow">Imported portfolio</p><h2>{portfolio.fileName}</h2><p>Imported {dateOnly(portfolio.importedAt)} · {portfolio.transactions.length} recognised transactions</p></div>
        <div className="heading-actions"><button className="secondary-button" type="button" disabled={refreshing} onClick={() => { void refreshPrices(); void refreshHistory(); }}>{refreshing ? "Refreshing…" : "Refresh market data"}</button><label className="secondary-button"><input type="file" accept=".csv,.xlsx" onChange={handleFile} hidden />Replace export</label><button className="text-button" type="button" onClick={clearPortfolio}>Delete local data</button></div>
      </section>

      <section className="metrics" aria-label="Portfolio overview">
        <Metric label="Invested" value={pounds.format(summary!.invested)} detail="Purchase cost including FX fees" />
        <Metric label="Current value" value={valuation === null ? "EOD quotes unavailable" : pounds.format(valuation + summary!.availableCash)} detail={valuation === null ? "A quote is still needed for every open position" : "Open positions plus cash"} />
        <Metric label="Return" value={totalReturn === null ? "—" : pounds.format(totalReturn)} detail={totalReturn === null ? "Needs a quote for every open position" : summary!.netContributions > 0 ? `${((totalReturn / summary!.netContributions) * 100).toFixed(2)}% return on net contributions` : "Gain after accounting for withdrawals"} />
      </section>

      <section className="allocation-charts"><article className="panel"><PanelHeading eyebrow="Position allocation" title="Your open positions" aside="Current value where priced" /><DonutChart title="Open position allocation" items={positionAllocation} /></article><article className="panel"><PanelHeading eyebrow="Look-through allocation" title="Top underlying holdings" aside="Share of the whole portfolio" /><DonutChart title="Top underlying holdings allocation" items={constituentAllocation} /></article></section>

      <section className="panel benchmark-panel"><PanelHeading eyebrow="Benchmark returns" title="Your portfolio vs indices" aside="Indexed to 100 at the earliest common date" /><BenchmarkChart points={benchmarkPoints} metricPoints={benchmarkMetricPoints} /></section>

      <section className="split-grid">
        <article className="panel allocation-panel"><PanelHeading eyebrow="Allocation" title="Open cost basis by type" /><div className="allocation-list">{(["ETF", "Share", "Unclassified"] as const).map((type) => {
          const total = summary!.holdings.filter((holding) => holding.type === type).reduce((sum, holding) => sum + holding.costBasis, 0);
          const percentage = summary!.costBasis ? (total / summary!.costBasis) * 100 : 0;
          return total > 0 ? <div className="allocation-row" key={type}><div><span>{type}</span><strong>{pounds.format(total)}</strong></div><div className="progress"><span style={{ width: `${percentage}%` }} /></div><small>{percentage.toFixed(1)}%</small></div> : null;
        })}</div><p className="panel-note">ETF classification uses a local ISIN mapping. Any uncertain instrument is called out rather than guessed.</p></article>
      </section>

      <section className="panel holdings-panel"><div className="panel-heading"><div><p className="eyebrow">Holdings</p><h3>Your open positions</h3></div><span className="muted">{portfolio.quotes ? "Latest EOD snapshot" : "Cost basis only"}</span></div><div className="table-scroll"><table><thead><tr><th>Instrument</th><th>Type</th><th>Shares</th><th>Cost basis</th><th>Latest close</th><th>Source</th><th>Current value</th><th>Weight</th></tr></thead><tbody>{summary!.holdings.map((holding) => { const quote = portfolio.quotes?.[holding.key]; const value = quote && holding.shares * quote.price * quote.rateToGbp; const colour = positionColours.get(holding.key); return <tr key={holding.key}><td><strong className="position-name"><i className="position-swatch" style={{ backgroundColor: colour }} />{holding.ticker || holding.isin || "—"}</strong><span>{holding.name}</span></td><td><span className={`tag ${holding.type.toLowerCase()}`}>{holding.type}</span></td><td>{integer.format(holding.shares)}</td><td>{pounds.format(holding.costBasis)}</td><td>{quote ? `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(quote.price)} ${quote.currency} · ${quote.asOf}` : "—"}</td><td>{quote?.source || "—"}</td><td>{value ? pounds.format(value) : "—"}</td><td>{summary!.costBasis ? `${((holding.costBasis / summary!.costBasis) * 100).toFixed(1)}%` : "—"}</td></tr>; })}</tbody></table></div></section>

      <section className="panel constituents-panel"><div className="panel-heading"><div><p className="eyebrow">ETF look-through</p><h3>Your total top 10 underlying holdings</h3></div><span className="muted">Ranked by aggregate value</span></div>{etfHoldings.length === 0 ? <p className="panel-note">There are no classified ETF holdings to expand.</p> : <><p className="panel-note">Holdings are fetched automatically from justETF after import and saved only in this browser. Each row combines the same company across every ETF and shows the contribution from each. Values use cost basis until every end-of-day quote is available.</p>{constituentExposure.length > 0 ? <div className="table-scroll constituent-table"><table><thead><tr><th>Constituent</th><th>Contribution by holding</th><th>Total value</th><th>Portfolio weight</th></tr></thead><tbody>{constituentExposure.slice(0, 10).map((item) => <tr key={`${item.ticker}-${item.name}`}><td><strong>{item.ticker || item.name}</strong><span>{item.ticker ? item.name : ""}</span></td><td><div className="source-contributions">{item.sources.map((source) => { const colour = positionColours.get(source.key) || POSITION_COLOURS[0]; return <span className="source-contribution" key={`${source.key}-${source.label}`} style={{ color: colour, borderColor: colour }}><i className="position-swatch" style={{ backgroundColor: colour }} />{source.label}: {pounds.format(source.value)} ({source.effectiveWeight.toFixed(2)}%)</span>; })}</div></td><td>{pounds.format(item.effectiveValue)}</td><td>{item.effectiveWeight.toFixed(2)}%</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>Top 10 total</td><td>{pounds.format(topConstituentsTotal.value)}</td><td>{topConstituentsTotal.weight.toFixed(2)}%</td></tr></tfoot></table></div> : <p className="panel-note">Fetching the fund holdings after import will populate this table.</p>}</>}</section>

      {portfolio.warnings.length > 0 && <section className="warnings"><div><p className="eyebrow">Import report</p><h3>{portfolio.warnings.length} row{portfolio.warnings.length === 1 ? "" : "s"} need review</h3></div><ul>{portfolio.warnings.slice(0, 6).map((warning) => <li key={`${warning.row}-${warning.message}`}>Row {warning.row}: {warning.message}</li>)}</ul>{portfolio.warnings.length > 6 && <p>Plus {portfolio.warnings.length - 6} more rows.</p>}</section>}
    </>}
    {message && <p className="toast" role="status">{message}</p>}
  </main>;
}
