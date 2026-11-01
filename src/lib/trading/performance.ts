import type { BarEvent, SignalEvent } from "@/lib/trading/validation";

export type ClosedPriceBar = Omit<
  Pick<BarEvent, "open_time" | "close_time" | "high" | "low" | "close" | "closed">,
  "closed"
> & { closed: boolean };
export type SignalDirection = SignalEvent["direction"];

export interface PerformanceMetrics {
  mfe: number;
  mae: number;
  currentMove: number;
  barsCount: number;
  lastBarTime: string | null;
}

function pricePrecision(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function calculatePerformance(
  direction: SignalDirection,
  entryPrice: number,
  signalBarTime: string,
  bars: readonly ClosedPriceBar[],
): PerformanceMetrics {
  const signalTime = Date.parse(signalBarTime);
  const eligibleBars = bars
    .filter((bar) => bar.closed && Date.parse(bar.open_time) > signalTime)
    .slice()
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));

  if (eligibleBars.length === 0) {
    return { mfe: 0, mae: 0, currentMove: 0, barsCount: 0, lastBarTime: null };
  }

  const favorable = eligibleBars.map((bar) =>
    direction === "BUY" ? bar.high - entryPrice : entryPrice - bar.low,
  );
  const adverse = eligibleBars.map((bar) =>
    direction === "BUY" ? entryPrice - bar.low : bar.high - entryPrice,
  );
  const latest = eligibleBars[eligibleBars.length - 1];
  const rawCurrentMove = direction === "BUY" ? latest.close - entryPrice : entryPrice - latest.close;

  return {
    mfe: pricePrecision(Math.max(0, ...favorable)),
    mae: pricePrecision(Math.max(0, ...adverse)),
    currentMove: pricePrecision(rawCurrentMove),
    barsCount: eligibleBars.length,
    lastBarTime: latest.close_time,
  };
}
