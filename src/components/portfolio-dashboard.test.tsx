import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// Exercise the component's asynchronous handlers without a DOM dependency.
const harness = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slot = harness.cursor++;
      if (!(slot in harness.slots)) harness.slots[slot] = initial;
      return [harness.slots[slot], (value: unknown) => { harness.slots[slot] = value; }];
    },
    useRef(initial: unknown) {
      const slot = harness.cursor++;
      harness.slots[slot] ??= { current: initial };
      return harness.slots[slot];
    },
    useMemo(compute: () => unknown) { return compute(); },
    useCallback(callback: unknown) { return callback; },
    useEffect(effect: () => void, dependencies: unknown[]) {
      const slot = harness.cursor++;
      const previous = harness.slots[slot] as unknown[] | undefined;
      if (!previous || dependencies.some((value, index) => value !== previous[index])) harness.effects.push(effect);
      harness.slots[slot] = dependencies;
    },
  };
});
import PortfolioDashboard from "./portfolio-dashboard";

type Element = ReactElement<{ children?: unknown; type?: string; onChange?: (event: unknown) => Promise<void>; onClick?: () => void }>;
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as Element;
    return predicate(element) ? element : find(element.props.children, predicate);
  }
}
function render() {
  harness.cursor = 0;
  const tree = PortfolioDashboard();
  for (const effect of harness.effects.splice(0)) effect();
  return tree;
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
const csv = "Action,Time (UTC),ID,Total,Currency (Total),ISIN,Ticker,Name,No. of shares\nDeposit,2026-01-01 10:00:00,deposit,100,GBP,,,,\nMarket buy,2026-01-01 11:00:00,buy,100,GBP,IE00BK5BQT80,VWRP,Vanguard ETF,1";

beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.effects = [];
  vi.useFakeTimers();
  const data = new Map<string, string>();
  vi.stubGlobal("window", { setTimeout, clearTimeout, localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("portfolio request concurrency", () => {
  for (const stale of [false, true]) {
    it(`${stale ? "refreshes expired" : "reuses fresh"} complete browser history`, async () => {
      window.localStorage.setItem("portfolio-analyser/v1", JSON.stringify({
        version: 1, calculationVersion: 2, importedAt: "2026-01-01", fileName: "cash.csv", transactions: [], warnings: [],
        benchmarkHistory: { fetchedAt: new Date(Date.now() - (stale ? 21 : 1) * 60 * 60 * 1000).toISOString(), series: Object.fromEntries(["sp500", "ftse100", "nasdaq100"].map((id) => [id, { currency: "GBP", source: "Yahoo Finance", points: [] }])) },
      }));
      const fetch = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetch);
      render(); await vi.runOnlyPendingTimersAsync(); render();
      expect(fetch).toHaveBeenCalledTimes(stale ? 1 : 0);
    });
  }
  it("adds direct shares to existing ETF exposure for the same company", async () => {
    window.localStorage.setItem("portfolio-analyser/v1", JSON.stringify({
      version: 1, calculationVersion: 2, importedAt: "2026-01-01", fileName: "exposure.csv", warnings: [],
      transactions: [
        { id: "etf", kind: "buy", timestamp: "2026-01-01T10:00:00Z", isin: "IE00BK5BQT80", ticker: "VWRP", name: "Vanguard ETF", shares: 1, total: 100, currency: "GBP", fxFee: 0 },
        { id: "direct", kind: "buy", timestamp: "2026-01-02T10:00:00Z", isin: "COMPANY", ticker: "COMP", name: "Company", shares: 1, total: 100, currency: "GBP", fxFee: 0 },
      ],
      quotes: { IE00BK5BQT80: { price: 100, rateToGbp: 1, fetchedAt: new Date().toISOString() }, COMPANY: { price: 100, rateToGbp: 1, fetchedAt: new Date().toISOString() } },
      constituents: { IE00BK5BQT80: { constituents: [{ id: "COMPANY", isin: "COMPANY", name: "Company", weight: 10 }] } },
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(); await vi.runOnlyPendingTimersAsync();
    const tree = render();
    expect(find(tree, (element) => element.type === "td" && element.props.children === "£110.00")).toBeDefined();
    expect(find(tree, (element) => element.type === "span" && Array.isArray(element.props.children) && element.props.children.includes("Direct position"))).toBeDefined();
    expect(find(tree, (element) => element.type === "span" && Array.isArray(element.props.children) && element.props.children.includes("VWRP"))).toBeDefined();
  });
  for (const order of ["quotes-first", "history-first"] as const) {
    it(`preserves quotes, history and constituents when ${order}`, async () => {
      const quotes = deferred(); const history = deferred(); const constituents = deferred();
      const fetch = vi.fn((url: string) => url.includes("market-data") ? quotes.promise : url.includes("historical-data") ? history.promise : constituents.promise);
      vi.stubGlobal("fetch", fetch);
      const input = find(render(), (element) => element.type === "input" && element.props.type === "file")!;
      const importing = input.props.onChange!({ target: { files: [new File([csv], "activity.csv")], value: "activity.csv" } });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/constituents", expect.anything()));
      render(); await vi.runOnlyPendingTimersAsync();
      expect(fetch).toHaveBeenCalledWith("/api/market-data", expect.anything());
      expect(fetch).toHaveBeenCalledWith("/api/historical-data", expect.anything());
      const resolveQuotes = () => quotes.resolve(Response.json({ quotes: { IE00BK5BQT80: { price: 100, rateToGbp: 1, currency: "GBP", fetchedAt: new Date().toISOString() } } }));
      const resolveHistory = () => history.resolve(Response.json({ series: { IE00BK5BQT80: { symbol: "VWRP", currency: "GBP", source: "justETF", points: [{ date: "2026-01-01", close: 100 }] } } }));
      if (order === "quotes-first") resolveQuotes(); else resolveHistory();
      await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem("portfolio-analyser/v1")!)[order === "quotes-first" ? "quotes" : "benchmarkHistory"]).toBeDefined());
      render();
      constituents.resolve(Response.json({ constituents: [{ id: "company", name: "Company", weight: 10 }], coverage: 10 }));
      await importing; render();
      if (order === "quotes-first") resolveHistory(); else resolveQuotes();
      await vi.waitFor(() => {
        const saved = JSON.parse(window.localStorage.getItem("portfolio-analyser/v1")!);
        expect(saved.quotes).toBeDefined();
        expect(saved.benchmarkHistory).toBeDefined();
      });
      render();
      const saved = JSON.parse(window.localStorage.getItem("portfolio-analyser/v1")!);
      expect(saved.quotes.IE00BK5BQT80.price).toBe(100);
      expect(saved.benchmarkHistory.series.IE00BK5BQT80.currency).toBe("GBP");
      expect(saved.constituents.IE00BK5BQT80.coverage).toBe(10);
    });
  }
});
