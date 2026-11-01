import type { SignalEvent } from "@/lib/trading/validation";

export interface TelegramDeliveryResult {
  ok: boolean;
  code: string;
  messageId?: string;
  httpStatus?: number;
}

export interface TelegramSignal {
  signalId: string;
  direction: SignalEvent["direction"];
  entryPrice: number;
  signalTime: string;
}

export async function sendTelegramSignal(signal: TelegramSignal): Promise<TelegramDeliveryResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, code: "TELEGRAM_NOT_CONFIGURED" };
  }

  const directionLabel = signal.direction === "BUY" ? "BUY · LONG" : "SELL · SHORT";
  const text = [
    "GLORYBOT  /  XAUUSD · M5",
    `${directionLabel} SIGNAL`,
    `Entry: ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(signal.entryPrice)}`,
    `Bar: ${signal.signalTime}`,
    `ID: ${signal.signalId}`,
  ].join("\n");

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });

    if (!response.ok) {
      return { ok: false, code: `TELEGRAM_HTTP_${response.status}`, httpStatus: response.status };
    }

    const result = (await response.json()) as {
      ok?: boolean;
      result?: { message_id?: number };
    };
    if (!result.ok) return { ok: false, code: "TELEGRAM_API_REJECTED", httpStatus: response.status };

    return {
      ok: true,
      code: "SENT",
      messageId: result.result?.message_id === undefined ? undefined : String(result.result.message_id),
      httpStatus: response.status,
    };
  } catch {
    return { ok: false, code: "TELEGRAM_NETWORK_ERROR" };
  }
}
