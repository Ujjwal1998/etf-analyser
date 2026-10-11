export type PricePoint = { date: string; close: number };

export type RiskMetrics = {
  totalReturn?: number;
  volatility?: number;
  maxDrawdown?: number;
  downsideDeviation?: number;
};

const TRADING_DAYS_PER_YEAR = 252;

function dailyReturns(points: PricePoint[]) {
  const sorted = points.filter((point) => Number.isFinite(point.close) && point.close > 0).toSorted((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(1).flatMap((point, index) => {
    const previous = sorted[index].close;
    const value = point.close / previous - 1;
    return Number.isFinite(value) ? [value] : [];
  });
}

export function calculateRiskMetrics(points: PricePoint[]): RiskMetrics {
  const sorted = points.filter((point) => Number.isFinite(point.close) && point.close > 0).toSorted((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return {};
  const returns = dailyReturns(sorted);
  if (returns.length === 0) return {};
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const downsideVariance = returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length;
  let peak = sorted[0].close;
  let maxDrawdown = 0;
  for (const point of sorted) {
    peak = Math.max(peak, point.close);
    maxDrawdown = Math.min(maxDrawdown, point.close / peak - 1);
  }
  return {
    totalReturn: sorted.at(-1)!.close / sorted[0].close - 1,
    volatility: Math.sqrt(variance * TRADING_DAYS_PER_YEAR),
    maxDrawdown,
    downsideDeviation: Math.sqrt(downsideVariance * TRADING_DAYS_PER_YEAR),
  };
}

export function pointsForPeriod(points: PricePoint[], startDate: string, endDate: string) {
  return points.filter((point) => point.date >= startDate && point.date <= endDate);
}
