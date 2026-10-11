import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseTrading212Csv, parseTrading212File } from "./parser";
import { buildPortfolioSummary } from "./summary";

const sample = `Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Currency conversion fee,Currency (Currency conversion fee)
Deposit,2026-01-01 10:00:00+00:00,,,,,deposit-1,,,,,1000.00,GBP,,
Market buy,2026-01-02 10:00:00+00:00,IE00BK5BQT80,VWRP,Vanguard FTSE All-World (Acc),,buy-1,4,125,GBP,1,500.00,GBP,,
Market buy,2026-01-03 10:00:00+00:00,US0000000001,ACME,Acme Inc,,buy-2,2,50,USD,1.25,80.00,GBP,0.12,GBP
Market sell,2026-01-04 10:00:00+00:00,IE00BK5BQT80,VWRP,Vanguard FTSE All-World (Acc),,sell-1,1,130,GBP,1,130.00,GBP,,
Mystery action,2026-01-05 10:00:00+00:00,,,,,unknown,,,,,1.00,GBP,,`;

describe("Trading 212 parser", () => {
  it("rejects exports with non-GBP totals rather than silently mixing currencies", () => {
    expect(() => parseTrading212Csv(sample.replace("1000.00,GBP", "1000.00,USD"))).toThrow("Only exports");
  });
  it("normalizes UTC timestamps without an offset", () => {
    expect(parseTrading212Csv(sample.replace("2026-01-01 10:00:00+00:00", "2026-01-01 10:00:00")).transactions[0].timestamp).toBe("2026-01-01T10:00:00.000Z");
  });
  it("normalizes actual XLSX date cells before FIFO sorting", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Transactions");
    sheet.addRow(["Action", "Time (UTC)", "ID", "Total", "Currency (Total)", "Ticker", "No. of shares"]);
    sheet.addRow(["Market buy", new Date("2026-01-01T10:00:00Z"), "buy", 200, "GBP", "TEST", 2]);
    sheet.addRow(["Market sell", new Date("2026-01-02T10:00:00Z"), "sell", 110, "GBP", "TEST", 1]);
    const result = await parseTrading212File(new File([await workbook.xlsx.writeBuffer()], "dates.xlsx"));
    const summary = buildPortfolioSummary(result.transactions);
    expect(result.transactions[0].timestamp).toBe("2026-01-01T10:00:00.000Z");
    expect(summary.costBasis).toBe(100);
    expect(summary.realisedGain).toBe(10);
    expect(summary.dailyCash.map((point) => point.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });
  it("parses supported activity and reports unsupported rows", () => {
    const result = parseTrading212Csv(sample);
    expect(result.transactions).toHaveLength(4);
    expect(result.warnings).toEqual([{ row: 6, message: "Skipped unsupported action: Mystery action." }]);
  });

  it("derives FIFO holdings and includes FX fees in cost basis", () => {
    const summary = buildPortfolioSummary(parseTrading212Csv(sample).transactions);
    expect(summary.deposited).toBe(1000);
    expect(summary.invested).toBe(580.12);
    expect(summary.costBasis).toBe(455.12);
    expect(summary.availableCash).toBeCloseTo(549.88);
    expect(summary.realisedGain).toBe(5);
    expect(summary.dividends).toBe(0);
    expect(summary.holdings.map((holding) => [holding.ticker, holding.type, holding.shares])).toEqual([
      ["VWRP", "ETF", 3],
      ["ACME", "Share", 2],
    ]);
  });

  it("recognises ARKK as an ETF", () => {
    const summary = buildPortfolioSummary([{
      id: "arkk-buy", kind: "buy", timestamp: "2026-01-02T10:00:00.000Z", isin: "US00214Q1040", ticker: "ARKK", name: "ARK Innovation ETF", shares: 1, total: 50, currency: "GBP", priceCurrency: "USD", fxFee: 0,
    }]);
    expect(summary.holdings[0]?.type).toBe("ETF");
  });

  it("reads the same structure from an XLSX workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Transactions");
    sheet.addRows(sample.trim().split("\n").map((line) => line.split(",")));
    const buffer = await workbook.xlsx.writeBuffer();
    const result = await parseTrading212File(new File([buffer], "statement.xlsx"));
    expect(result.transactions).toHaveLength(4);
    expect(result.transactions[1]).toMatchObject({ ticker: "VWRP", kind: "buy", total: 500 });
  });
});
