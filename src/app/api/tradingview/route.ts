import { randomUUID } from "node:crypto";
import { createSignal, recordClosedBar, updateTelegramLog, writeApiLog } from "@/lib/db/repository";
import { sendTelegramSignal } from "@/lib/trading/telegram";
import { processTradingViewWebhook } from "@/lib/trading/webhook-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

type BodyReadResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: "INVALID_JSON" | "BODY_TOO_LARGE" };

async function readJsonLimited(request: Request): Promise<BodyReadResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return { ok: false, status: 413, code: "BODY_TOO_LARGE" };
  if (!request.body) return { ok: false, status: 400, code: "INVALID_JSON" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, code: "BODY_TOO_LARGE" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, code: "INVALID_JSON" };
  } finally {
    reader.releaseLock();
  }
}

async function safeLog(requestId: string, eventType: "signal" | "bar" | "invalid", status: number, code: string) {
  try {
    await writeApiLog(requestId, eventType, status, code);
  } catch {
    // Logging is best-effort so that missing schema/DB never leaks connection details.
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await safeLog(requestId, "invalid", 415, "UNSUPPORTED_MEDIA_TYPE");
    return Response.json(
      { ok: false, error: "Content-Type must be application/json.", requestId },
      { status: 415, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const read = await readJsonLimited(request);
  if (!read.ok) {
    await safeLog(requestId, "invalid", read.status, read.code);
    return Response.json(
      { ok: false, error: read.code === "BODY_TOO_LARGE" ? "Request body is too large." : "Invalid JSON body.", requestId },
      { status: read.status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  try {
    const result = await processTradingViewWebhook({
      request,
      body: read.value,
      expectedSecret: process.env.TRADINGVIEW_WEBHOOK_SECRET,
      repository: { createSignal, recordClosedBar, updateTelegramLog },
      notify: (signal) => sendTelegramSignal(signal),
    });
    await safeLog(requestId, result.eventType, result.status, result.code);
    return Response.json(
      { ...result.body, requestId },
      { status: result.status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch {
    await safeLog(requestId, "invalid", 503, "PROCESSING_UNAVAILABLE");
    console.error("tradingview_processing_unavailable", { requestId });
    return Response.json(
      { ok: false, error: "Webhook processing is temporarily unavailable.", requestId },
      { status: 503, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}
