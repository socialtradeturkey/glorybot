import type { BarEvent, SignalEvent } from "@/lib/trading/validation";
import { parseTradingViewEvent, redactSensitiveFields } from "@/lib/trading/validation";
import { extractWebhookSecretCandidates, matchesWebhookSecret } from "@/lib/trading/security";
import type { StoredSignal, StoredBarResult } from "@/lib/db/repository";
import type { TelegramDeliveryResult } from "@/lib/trading/telegram";

export interface WebhookRepository {
  createSignal(event: SignalEvent, safePayload: unknown): Promise<
    | { created: false }
    | { created: true; signal: StoredSignal }
  >;
  recordClosedBar(event: BarEvent): Promise<StoredBarResult>;
  updateTelegramLog(signalRef: string, result: TelegramDeliveryResult): Promise<void>;
}

export interface WebhookProcessResult {
  status: number;
  eventType: "signal" | "bar" | "invalid";
  code: string;
  body: Record<string, unknown>;
}

export async function processTradingViewWebhook(input: {
  request: Request;
  body: unknown;
  expectedSecret: string | undefined;
  repository: WebhookRepository;
  notify: (signal: StoredSignal) => Promise<TelegramDeliveryResult>;
}): Promise<WebhookProcessResult> {
  const { request, body, expectedSecret, repository, notify } = input;

  if (!expectedSecret?.trim()) {
    return {
      status: 503,
      eventType: "invalid",
      code: "WEBHOOK_NOT_CONFIGURED",
      body: { ok: false, error: "Webhook is not configured." },
    };
  }

  const secretCandidates = extractWebhookSecretCandidates(request, body);
  if (!matchesWebhookSecret(secretCandidates, expectedSecret)) {
    return {
      status: 401,
      eventType: "invalid",
      code: "INVALID_WEBHOOK_SECRET",
      body: { ok: false, error: "Unauthorized." },
    };
  }

  const parsed = parseTradingViewEvent(body);
  if (!parsed.success) {
    return {
      status: 400,
      eventType: "invalid",
      code: "INVALID_PAYLOAD",
      body: { ok: false, error: "Invalid webhook payload.", issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) },
    };
  }

  const event = parsed.data;
  const safePayload = redactSensitiveFields(body);

  if (event.event === "bar") {
    const result = await repository.recordClosedBar(event);
    return {
      status: 200,
      eventType: "bar",
      code: result.duplicate ? "DUPLICATE_BAR" : "BAR_RECORDED",
      body: {
        ok: true,
        event: "bar",
        status: result.duplicate ? "duplicate" : "recorded",
        updatedSignals: result.updatedSignals,
      },
    };
  }

  const result = await repository.createSignal(event, safePayload);
  if (!result.created) {
    return {
      status: 200,
      eventType: "signal",
      code: "DUPLICATE_SIGNAL",
      body: { ok: true, event: "signal", status: "duplicate" },
    };
  }

  let delivery: TelegramDeliveryResult;
  try {
    delivery = await notify(result.signal);
  } catch {
    delivery = { ok: false, code: "TELEGRAM_NETWORK_ERROR" };
  }

  try {
    await repository.updateTelegramLog(result.signal.id, delivery);
  } catch {
    // Keep the accepted signal response stable; never log provider URLs or secret-bearing errors.
    console.error("telegram_delivery_log_update_failed", { signalId: result.signal.signalId });
  }

  return {
    status: 200,
    eventType: "signal",
    code: "SIGNAL_RECORDED",
    body: {
      ok: true,
      event: "signal",
      status: "recorded",
      notificationStatus: delivery.ok ? "sent" : "failed",
    },
  };
}
