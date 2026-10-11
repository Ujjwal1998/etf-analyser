import { NextResponse } from "next/server";
import type { Constituent } from "@/lib/portfolio/types";

const REQUEST_TIMEOUT_MS = 12_000;

function text(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function parseJustEtfTopHoldings(html: string): Constituent[] {
  const table = html.match(/data-testid="etf-holdings_top-holdings_table"[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  return [...table.matchAll(/stock-profiles\/([^"?#]+)[\s\S]*?title="([^"]+)"[\s\S]*?value_percentage">([\d.]+)%/gi)].map((match) => ({
    id: match[1],
    isin: match[1],
    name: text(match[2]),
    weight: Number(match[3]),
  })).filter((item) => Number.isFinite(item.weight) && item.weight > 0 && item.id.length > 0).slice(0, 10);
}

export async function POST(request: Request) {
  try {
    const { isin } = await request.json() as { isin?: string };
    const normalisedIsin = isin?.trim().toUpperCase();
    if (!normalisedIsin || !/^[A-Z0-9]{12}$/.test(normalisedIsin)) {
      return NextResponse.json({ error: "A valid 12-character ISIN is required." }, { status: 400 });
    }
    const sourceUrl = `https://www.justetf.com/en/etf-profile.html?isin=${normalisedIsin}`;
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "Portfolio-Lens/1.0 issuer-holdings-fetcher" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The issuer website returned ${response.status}.`);
    const html = await response.text();
    const constituents = parseJustEtfTopHoldings(html);
    if (constituents.length === 0) throw new Error("The public holdings page format changed or does not expose a holdings table yet.");
    const coverage = constituents.reduce((sum, constituent) => sum + constituent.weight, 0);
    const date = text(html.match(/data-testid="tl_etf-holdings_reference-date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "") || undefined;
    return NextResponse.json({ constituents, coverage, holdingsDate: date, sourceUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "The issuer website took too long to respond. Try again later or import its holdings CSV."
      : error instanceof TypeError && error.message === "fetch failed"
        ? "The issuer website blocked this server-side request. Import its holdings CSV instead."
        : error instanceof Error ? error.message : "Could not fetch issuer holdings.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
