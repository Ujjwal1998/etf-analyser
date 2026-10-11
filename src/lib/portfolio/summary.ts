import type { DailyCashPoint, Holding, PortfolioSummary, Transaction } from "./types";

const KNOWN_ETF_ISINS = new Set([
  "IE00BMFKG444", // Xtrackers NASDAQ 100 UCITS ETF
  "IE00BK5BQT80", // Vanguard FTSE All-World UCITS ETF
  "IE00BMC38736", // VanEck Semiconductor UCITS ETF
  "US00214Q1040", // ARK Innovation ETF
]);
const KNOWN_ETF_TICKERS = new Set(["ARKK"]);

type Lot = { shares: number; cost: number };
type MutableHolding = Holding & { lots: Lot[] };

export function holdingType(isin?: string, ticker?: string, name?: string): Holding["type"] {
  return (isin && KNOWN_ETF_ISINS.has(isin))
    || (ticker && KNOWN_ETF_TICKERS.has(ticker.toUpperCase()))
    || Boolean(name && /\b(etf|ucits)\b/i.test(name))
    ? "ETF"
    : isin ? "Share" : "Unclassified";
}

export function buildPortfolioSummary(transactions: Transaction[]): PortfolioSummary {
  const holdings = new Map<string, MutableHolding>();
  const days = new Map<string, { deposited: number; invested: number }>();
  let deposited = 0;
  let withdrawn = 0;
  let invested = 0;
  let cash = 0;
  let fees = 0;
  let realisedGain = 0;
  let dividends = 0;
  let taxes = 0;

  const sorted = transactions.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const transaction of sorted) {
    if (transaction.currency.toUpperCase() !== "GBP") throw new Error("Only GBP transaction totals are supported. Replace the export with GBP account activity.");
    const date = transaction.timestamp.slice(0, 10);
    const day = days.get(date) ?? { deposited: 0, invested: 0 };
    fees += transaction.fxFee;

    if (transaction.kind === "deposit") {
      deposited += transaction.total;
      cash += transaction.total;
      day.deposited += transaction.total;
    } else if (transaction.kind === "withdrawal") {
      withdrawn += transaction.total;
      cash -= transaction.total;
    } else if (transaction.kind === "dividend") {
      cash += transaction.total;
      dividends += transaction.total;
    } else if (transaction.kind === "tax") {
      cash -= transaction.total;
      taxes += transaction.total;
    } else if (transaction.kind === "buy" || transaction.kind === "sell") {
      const key = transaction.isin || transaction.ticker || transaction.name || transaction.id;
      const holding = holdings.get(key) ?? {
        key,
        isin: transaction.isin,
        ticker: transaction.ticker,
        name: transaction.name || transaction.ticker || "Unlabelled holding",
        shares: 0,
        costBasis: 0,
        currency: transaction.currency,
        priceCurrency: transaction.priceCurrency ?? transaction.currency,
        type: holdingType(transaction.isin, transaction.ticker, transaction.name),
        lots: [],
      };
      const totalWithFee = transaction.total + transaction.fxFee;
      if (transaction.kind === "buy") {
        holding.shares += transaction.shares ?? 0;
        holding.costBasis += totalWithFee;
        holding.lots.push({ shares: transaction.shares ?? 0, cost: totalWithFee });
        invested += totalWithFee;
        cash -= totalWithFee;
        day.invested += totalWithFee;
      } else {
        let remaining = transaction.shares ?? 0;
        let releasedCost = 0;
        while (remaining > 0 && holding.lots.length > 0) {
          const lot = holding.lots[0];
          const sold = Math.min(remaining, lot.shares);
          const cost = lot.cost * (sold / lot.shares);
          releasedCost += cost;
          lot.shares -= sold;
          lot.cost -= cost;
          remaining -= sold;
          if (lot.shares < 0.00000001) holding.lots.shift();
        }
        holding.shares -= transaction.shares ?? 0;
        holding.costBasis -= releasedCost;
        const proceeds = transaction.total - transaction.fxFee;
        realisedGain += proceeds - releasedCost;
        cash += proceeds;
      }
      holdings.set(key, holding);
    }
    days.set(date, day);
  }

  let cumulativeDeposited = 0;
  let cumulativeInvested = 0;
  const dailyCash: DailyCashPoint[] = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => {
    cumulativeDeposited += day.deposited;
    cumulativeInvested += day.invested;
    return { date, deposited: cumulativeDeposited, invested: cumulativeInvested };
  });

  const completedHoldings = [...holdings.values()]
    .filter((holding) => holding.shares > 0.00000001)
    .map((holding) => ({
      key: holding.key,
      isin: holding.isin,
      ticker: holding.ticker,
      name: holding.name,
      shares: holding.shares,
      costBasis: holding.costBasis,
      currency: holding.currency,
      priceCurrency: holding.priceCurrency,
      type: holding.type,
    }))
    .toSorted((a, b) => b.costBasis - a.costBasis);

  return {
    deposited,
    withdrawn,
    netContributions: deposited - withdrawn,
    invested,
    availableCash: cash,
    costBasis: completedHoldings.reduce((total, holding) => total + holding.costBasis, 0),
    fees,
    realisedGain,
    dividends,
    taxes,
    holdings: completedHoldings,
    dailyCash,
    firstTransaction: sorted[0]?.timestamp,
    lastTransaction: sorted.at(-1)?.timestamp,
  };
}
