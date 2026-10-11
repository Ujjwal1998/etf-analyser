const LSE_TICKERS = new Set(["VWRP", "XNAQ", "SMGB", "ISF"]);

export function alphaVantageSymbol(ticker: string, priceCurrency?: string): string {
  const normalized = ticker.trim().toUpperCase();
  const london = LSE_TICKERS.has(normalized) || ["GBP", "GBX"].includes(priceCurrency?.toUpperCase() ?? "");
  return london && !normalized.includes(".") ? `${normalized}.LON` : normalized;
}
