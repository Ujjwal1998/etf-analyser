import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("market quote listing currencies", () => {
  it("prices a GBP share using its London listing and converts returned pence", async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => Response.json({ chart: { result: [{ meta: { currency: "GBp", symbol: "TEST.L" }, timestamp: [1767312000], indicators: { quote: [{ close: [12500] }] } }] } }));
    vi.stubGlobal("fetch", fetch);
    const response = await POST(new Request("http://localhost/api/market-data", { method: "POST", body: JSON.stringify({ instruments: [{ id: "london-test", ticker: "TEST", type: "Share", priceCurrency: "GBP" }] }) }));
    const result = await response.json();
    expect(result.quotes["london-test"]).toMatchObject({ price: 12500, currency: "GBp", rateToGbp: 0.01 });
    expect(fetch.mock.calls[0][0]).toContain("TEST.L");
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("nasdaq"))).toBe(true);
  });
  it("converts a USD share quote to GBP using the fetched FX quote", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("GBPUSD")
      ? Response.json({ chart: { result: [{ meta: { currency: "USD", symbol: "GBPUSD=X" }, timestamp: [1767312000], indicators: { quote: [{ close: [1.25] }] } }] } })
      : Response.json({ data: { symbol: "TESTUSD", primaryData: { lastSalePrice: "$100.00", lastTradeTimestamp: "2026-01-02" } } })));
    const response = await POST(new Request("http://localhost/api/market-data", { method: "POST", body: JSON.stringify({ instruments: [{ id: "usd-test", ticker: "TESTUSD", type: "Share", priceCurrency: "USD" }] }) }));
    expect((await response.json()).quotes["usd-test"]).toMatchObject({ price: 100, currency: "USD", rateToGbp: 0.8 });
  });
  it("rejects malformed instrument arrays before making provider calls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await POST(new Request("http://localhost/api/market-data", { method: "POST", body: JSON.stringify({ instruments: [null] }) }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
