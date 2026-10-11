import { describe, expect, it } from "vitest";
import { calculateRiskMetrics } from "./risk-metrics";

describe("portfolio risk metrics", () => {
  const points = [
    { date: "2026-01-01", close: 100 },
    { date: "2026-01-02", close: 110 },
    { date: "2026-01-03", close: 99 },
    { date: "2026-01-04", close: 108.9 },
  ];

  it("calculates total return from the first and last observations", () => {
    expect(calculateRiskMetrics(points).totalReturn).toBeCloseTo(0.089, 8);
  });

  it("annualises daily volatility", () => {
    const result = calculateRiskMetrics(points);
    expect(result.volatility).toBeCloseTo(1.496, 2);
  });

  it("finds the largest peak-to-trough loss", () => {
    expect(calculateRiskMetrics(points).maxDrawdown).toBeCloseTo(-0.1, 8);
  });

  it("calculates annualised downside deviation using negative daily returns", () => {
    expect(calculateRiskMetrics(points).downsideDeviation).toBeCloseTo(0.916, 2);
  });
});
