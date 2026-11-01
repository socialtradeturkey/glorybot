import { isDatabaseConfigured } from "@/lib/db/client";
import { listRecentSignals } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json(
      { ok: false, error: "Database is not configured.", data: null },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const signals = await listRecentSignals();
    const count = signals.length;
    const average = (selector: (signal: (typeof signals)[number]) => number) =>
      count === 0 ? 0 : signals.reduce((sum, signal) => sum + selector(signal), 0) / count;

    return Response.json(
      {
        ok: true,
        data: {
          signals,
          summary: {
            total: count,
            buy: signals.filter((signal) => signal.direction === "BUY").length,
            sell: signals.filter((signal) => signal.direction === "SELL").length,
            averageMfe: average((signal) => signal.mfe),
            averageMae: average((signal) => signal.mae),
            averageCurrentMove: average((signal) => signal.currentMove),
          },
          generatedAt: new Date().toISOString(),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    console.error("signals_query_unavailable");
    return Response.json(
      { ok: false, error: "Signal data is temporarily unavailable.", data: null },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
