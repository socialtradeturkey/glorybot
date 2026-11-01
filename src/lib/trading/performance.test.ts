import { describe, expect, it } from "vitest";
import { calculatePerformance } from "@/lib/trading/performance";
import type { ClosedPriceBar } from "@/lib/trading/performance";

const signalTime = "2026-11-01T12:00:00.000Z";

function bar(
  open_time: string,
  close_time: string,
  high: number,
  low: number,
  close: number,
  closed = true,
): ClosedPriceBar {
  return { open_time, close_time, high, low, close, closed };
}

describe("calculatePerformance", () => {
  it("BUY için sonraki kapanmış mumları ölçer ve sinyal/açık mumu dışarıda bırakır", () => {
    const result = calculatePerformance("BUY", 4012.56, signalTime, [
      bar(signalTime, "2026-11-01T12:05:00.000Z", 9999, 1, 5000),
      bar("2026-11-01T12:05:00.000Z", "2026-11-01T12:10:00.000Z", 4015.2, 4010.1, 4014.8),
      bar("2026-11-01T12:10:00.000Z", "2026-11-01T12:15:00.000Z", 4014, 4008, 4008.5),
      bar("2026-11-01T12:15:00.000Z", "2026-11-01T12:20:00.000Z", 9999, 1, 5000, false),
    ]);

    expect(result.mfe).toBeCloseTo(2.64, 6);
    expect(result.mae).toBeCloseTo(4.56, 6);
    expect(result.currentMove).toBeCloseTo(-4.06, 6);
    expect(result.barsCount).toBe(2);
    expect(result.lastBarTime).toBe("2026-11-01T12:15:00.000Z");
  });

  it("SELL için MFE/MAE yönünü tersine çevirir", () => {
    const result = calculatePerformance("SELL", 4012.5, signalTime, [
      bar("2026-11-01T12:05:00.000Z", "2026-11-01T12:10:00.000Z", 4018, 4010, 4015),
      bar("2026-11-01T12:10:00.000Z", "2026-11-01T12:15:00.000Z", 4019, 4007, 4008),
    ]);

    expect(result).toEqual({
      mfe: 5.5,
      mae: 6.5,
      currentMove: 4.5,
      barsCount: 2,
      lastBarTime: "2026-11-01T12:15:00.000Z",
    });
  });

  it("sonraki kapanmış mum yoksa sıfır ölçüm döndürür", () => {
    expect(calculatePerformance("BUY", 4012.5, signalTime, [])).toEqual({
      mfe: 0,
      mae: 0,
      currentMove: 0,
      barsCount: 0,
      lastBarTime: null,
    });
  });
});
