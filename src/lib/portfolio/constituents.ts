import type { Constituent } from "./types";

type ParseConstituentsResult = { constituents: Constituent[]; warnings: string[] };

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  row.push(value);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function column(headers: string[], options: string[]) {
  return headers.findIndex((header) => options.includes(header.toLowerCase()));
}

export function parseConstituentsCsv(text: string): ParseConstituentsResult {
  const rows = csvRows(text);
  if (rows.length < 2) return { constituents: [], warnings: ["The file has no constituent rows."] };
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const nameColumn = column(headers, ["name", "holding", "holding name", "security name", "constituent"]);
  const weightColumn = column(headers, ["weight", "weight (%)", "weight %", "% of net assets", "portfolio weight"]);
  const tickerColumn = column(headers, ["ticker", "symbol"]);
  const isinColumn = column(headers, ["isin"]);
  if (nameColumn < 0 || weightColumn < 0) return { constituents: [], warnings: ["Use a CSV with a constituent name and weight column."] };

  const warnings: string[] = [];
  const constituents = rows.slice(1).flatMap((row, index) => {
    const name = row[nameColumn]?.trim();
    const weight = Number(row[weightColumn]?.replaceAll("%", "").replaceAll(",", "").trim());
    if (!name || !Number.isFinite(weight) || weight <= 0) {
      warnings.push(`Skipped CSV row ${index + 2}.`);
      return [];
    }
    const ticker = tickerColumn >= 0 ? row[tickerColumn]?.trim() || undefined : undefined;
    const isin = isinColumn >= 0 ? row[isinColumn]?.trim() || undefined : undefined;
    return [{ id: isin || ticker || `${name}-${index}`, name, ticker, isin, weight }];
  });
  const usesDecimalWeights = constituents.length > 0 && Math.max(...constituents.map((item) => item.weight)) <= 1;
  return { constituents: usesDecimalWeights ? constituents.map((item) => ({ ...item, weight: item.weight * 100 })) : constituents, warnings };
}
