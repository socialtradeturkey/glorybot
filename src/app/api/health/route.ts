import { isDatabaseConfigured } from "@/lib/db/client";
import { checkDatabase } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json(
      { ok: false, status: "degraded", api: "ok", database: "not_configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    await checkDatabase();
    return Response.json(
      { ok: true, status: "ok", api: "ok", database: "ok", checkedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    console.error("health_database_unavailable");
    return Response.json(
      { ok: false, status: "degraded", api: "ok", database: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
