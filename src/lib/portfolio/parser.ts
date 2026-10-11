import ExcelJS from "exceljs";
import type { ImportWarning, ParseResult, Transaction, TransactionKind } from "./types";

const REQUIRED_HEADERS = ["Action", "Time (UTC)", "ID", "Total", "Currency (Total)"];

const ACTIONS: Record<string, TransactionKind> = {
  Deposit: "deposit",
  Withdrawal: "withdrawal",
  "Market buy": "buy",
  "Market sell": "sell",
  Dividend: "dividend",
  "Withholding tax": "tax",
};

function numberValue(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function parseRows(rows: string[][]): ParseResult {
  if (rows.length === 0) return { transactions: [], warnings: [{ row: 0, message: "The file is empty." }], sourceRows: 0 };

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return {
      transactions: [],
      warnings: [{ row: 1, message: `This is not a recognised Trading 212 export. Missing: ${missing.join(", ")}.` }],
      sourceRows: Math.max(0, rows.length - 1),
    };
  }

  const transactions: Transaction[] = [];
  const warnings: ImportWarning[] = [];
  const transactionIds = new Set<string>();

  rows.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const value = (header: string) => cells[headers.indexOf(header)]?.trim() ?? "";
    const action = value("Action");
    const kind = ACTIONS[action];
    if (!kind) {
      warnings.push({ row, message: `Skipped unsupported action: ${action || "blank action"}.` });
      return;
    }

    const id = value("ID");
    const rawTimestamp = value("Time (UTC)");
    const timestamp = rawTimestamp.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/, "$1T$2Z");
    const total = numberValue(value("Total"));
    const currency = value("Currency (Total)");
    if (!id || !timestamp || total === undefined || !currency) {
      warnings.push({ row, message: "Skipped row with a missing ID, date, total, or total currency." });
      return;
    }
    if (Number.isNaN(Date.parse(timestamp))) {
      warnings.push({ row, message: `Skipped row with an invalid date: ${timestamp}.` });
      return;
    }
    if (currency.toUpperCase() !== "GBP" || (value("Currency (Currency conversion fee)") && value("Currency (Currency conversion fee)").toUpperCase() !== "GBP")) {
      throw new Error("Only exports with totals and conversion fees in GBP are supported. Export your GBP account activity.");
    }
    if (transactionIds.has(id)) {
      warnings.push({ row, message: `Skipped duplicate transaction ID ${id}.` });
      return;
    }
    transactionIds.add(id);

    const shares = numberValue(value("No. of shares"));
    if ((kind === "buy" || kind === "sell") && (!shares || shares <= 0)) {
      warnings.push({ row, message: "Skipped trade with no positive share quantity." });
      return;
    }

    transactions.push({
      id,
      kind,
      timestamp: new Date(timestamp).toISOString(),
      isin: value("ISIN") || undefined,
      ticker: value("Ticker") || undefined,
      name: value("Name") || undefined,
      shares,
      pricePerShare: numberValue(value("Price / share")),
      priceCurrency: value("Currency (Price / share)") || undefined,
      total,
      currency: "GBP",
      exchangeRate: numberValue(value("Exchange rate")),
      fxFee: numberValue(value("Currency conversion fee")) ?? 0,
    });
  });

  return { transactions, warnings, sourceRows: rows.length - 1 };
}

export function parseTrading212Csv(text: string): ParseResult {
  return parseRows(readCsv(text));
}

export async function parseTrading212File(file: File): Promise<ParseResult> {
  if (file.name.toLowerCase().endsWith(".csv")) return parseTrading212Csv(await file.text());
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return { transactions: [], warnings: [{ row: 0, message: "The workbook has no sheets." }], sourceRows: 0 };
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let column = 1; column <= row.cellCount; column += 1) {
        const cell = row.getCell(column);
        cells.push(cell.value instanceof Date ? cell.value.toISOString() : cell.text);
      }
      rows.push(cells);
    });
    return parseRows(rows);
  }
  return { transactions: [], warnings: [{ row: 0, message: "Upload a .csv or .xlsx file." }], sourceRows: 0 };
}
