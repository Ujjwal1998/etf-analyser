export type Point = { date: string; close: number };

export function validHistoricalPoints(timestamps: number[], closes: (number | null)[]) {
  return timestamps.flatMap((timestamp, index) => {
    const close = closes[index];
    return typeof close === "number" && Number.isFinite(close) && close > 0
      ? [{ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close }]
      : [];
  }).toSorted((a, b) => a.date.localeCompare(b.date));
}

export function historyInGbp(points: Point[], currency: string, gbpUsd: Point[] = []) {
  if (currency === "GBP") return points;
  if (currency === "GBp" || currency.toUpperCase() === "GBX") return points.map((point) => ({ ...point, close: point.close / 100 }));
  if (currency !== "USD") throw new Error(`Historical conversion from ${currency} to GBP is not supported.`);
  let fxIndex = 0;
  let rate: number | undefined;
  const converted = points.flatMap((point) => {
    while (fxIndex < gbpUsd.length && gbpUsd[fxIndex].date <= point.date) rate = gbpUsd[fxIndex++].close;
    return rate && rate > 0 ? [{ date: point.date, close: point.close / rate }] : [];
  });
  if (converted.length === 0) throw new Error("No dated USD/GBP exchange rates are available.");
  return converted;
}
