export type TransactionKind =
  | "deposit"
  | "buy"
  | "sell"
  | "dividend"
  | "tax"
  | "withdrawal";

export type Transaction = {
  id: string;
  kind: TransactionKind;
  timestamp: string;
  isin?: string;
  ticker?: string;
  name?: string;
  shares?: number;
  pricePerShare?: number;
  priceCurrency?: string;
  total: number;
  currency: string;
  exchangeRate?: number;
  fxFee: number;
};

export type ImportWarning = { row: number; message: string };

export type ParseResult = {
  transactions: Transaction[];
  warnings: ImportWarning[];
  sourceRows: number;
};

export type Holding = {
  key: string;
  isin?: string;
  ticker?: string;
  name: string;
  shares: number;
  costBasis: number;
  currency: string;
  priceCurrency: string;
  type: "ETF" | "Share" | "Unclassified";
};

export type DailyCashPoint = {
  date: string;
  deposited: number;
  invested: number;
};

export type PortfolioSummary = {
  deposited: number;
  withdrawn: number;
  netContributions: number;
  invested: number;
  availableCash: number;
  costBasis: number;
  fees: number;
  realisedGain: number;
  dividends: number;
  taxes: number;
  holdings: Holding[];
  dailyCash: DailyCashPoint[];
  firstTransaction?: string;
  lastTransaction?: string;
};

export type MarketQuote = {
  price: number;
  currency: string;
  asOf: string;
  symbol: string;
  rateToGbp: number;
  fetchedAt: string;
  source: "justETF" | "Nasdaq" | "Yahoo Finance" | "Alpha Vantage";
};

export type Constituent = {
  id: string;
  name: string;
  ticker?: string;
  isin?: string;
  weight: number;
};

export type ConstituentSnapshot = {
  importedAt: string;
  holdingsDate?: string;
  coverage: number;
  constituents: Constituent[];
  sourceUrl?: string;
};

export type StoredPortfolio = {
  version: 1;
  calculationVersion?: 2;
  importedAt: string;
  fileName: string;
  transactions: Transaction[];
  warnings: ImportWarning[];
  quotes?: Record<string, MarketQuote>;
  constituents?: Record<string, ConstituentSnapshot>;
  benchmarkHistory?: BenchmarkHistory;
};

export type HistoricalSeries = {
  symbol: string;
  currency: string;
  source: "justETF" | "Yahoo Finance" | "Alpha Vantage";
  points: { date: string; close: number }[];
};

export type BenchmarkHistory = {
  fetchedAt: string;
  series: Record<string, HistoricalSeries>;
};
