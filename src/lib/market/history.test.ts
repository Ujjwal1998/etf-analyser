import { describe, expect, it } from "vitest";
import { historyInGbp, validHistoricalPoints } from "./history";

describe("historical prices", () => {
  it("discards null, zero and invalid Yahoo closes", () => {
    expect(validHistoricalPoints([1, 2, 3, 4, 5], [null, 0, NaN, -1, 100])).toEqual([{ date: "1970-01-01", close: 100 }]);
  });
  it("converts dollars using dated FX, carrying the last rate over weekends", () => {
    expect(historyInGbp([{ date: "2026-01-02", close: 125 }, { date: "2026-01-03", close: 125 }, { date: "2026-01-05", close: 125 }], "USD", [{ date: "2026-01-02", close: 1.25 }, { date: "2026-01-05", close: 1.5 }])).toEqual([{ date: "2026-01-02", close: 100 }, { date: "2026-01-03", close: 100 }, { date: "2026-01-05", close: 125 / 1.5 }]);
  });
  it("converts London pence to pounds", () => {
    expect(historyInGbp([{ date: "2026-01-02", close: 12500 }], "GBp")[0].close).toBe(125);
  });
  it("rejects unsupported currencies and missing FX", () => {
    expect(() => historyInGbp([{ date: "2026-01-02", close: 100 }], "EUR")).toThrow();
    expect(() => historyInGbp([{ date: "2026-01-02", close: 100 }], "USD")).toThrow();
  });
});
