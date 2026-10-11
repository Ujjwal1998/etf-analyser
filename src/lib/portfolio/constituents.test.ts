import { describe, expect, it } from "vitest";
import { parseConstituentsCsv } from "./constituents";

describe("constituent CSV parser", () => {
  it("accepts name, ticker and percentage weights", () => {
    const result = parseConstituentsCsv("Name,Ticker,Weight (%)\nNVIDIA Corp,NVDA,8.2\nApple Inc,AAPL,7.1");
    expect(result.warnings).toEqual([]);
    expect(result.constituents).toEqual(expect.arrayContaining([expect.objectContaining({ ticker: "NVDA", weight: 8.2 })]));
  });
});
