import { describe, expect, it, vi } from "vitest";
import { processTradingViewWebhook, type WebhookRepository } from "@/lib/trading/webhook-service";
import type { StoredSignal } from "@/lib/db/repository";
import type { BarEvent, SignalEvent } from "@/lib/trading/validation";

const validSignal: SignalEvent = {
  event: "signal",
  signal_id: "glory-xau-m5-20261101T120000Z",
  symbol: "XAUUSD",
  timeframe: "M5",
  direction: "BUY",
  bar_time: "2026-11-01T12:00:00.000Z",
  entry_price: 4012.56,
  secret: "top-secret",
};

const storedSignal: StoredSignal = {
  id: "41",
  signalId: validSignal.signal_id,
  direction: "BUY",
  entryPrice: validSignal.entry_price,
  signalTime: validSignal.bar_time,
};

function request(secret = "top-secret") {
  return new Request("https://example.test/api/tradingview", {
    method: "POST",
    headers: { "x-webhook-secret": secret },
  });
}

function repository(overrides: Partial<WebhookRepository> = {}): WebhookRepository {
  return {
    createSignal: vi.fn(async () => ({ created: true as const, signal: storedSignal })),
    recordClosedBar: vi.fn(async () => ({ duplicate: false, updatedSignals: 2 })),
    updateTelegramLog: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("processTradingViewWebhook", () => {
  it("geçerli yeni sinyali kaydeder ve Telegram sonucu loglanır", async () => {
    const repo = repository();
    const notify = vi.fn(async () => ({ ok: false, code: "TELEGRAM_HTTP_503" }));

    const result = await processTradingViewWebhook({
      request: request(),
      body: validSignal,
      expectedSecret: "top-secret",
      repository: repo,
      notify,
    });

    expect(result.status).toBe(200);
    expect(result.body.notificationStatus).toBe("failed");
    expect(repo.createSignal).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(repo.updateTelegramLog).toHaveBeenCalledWith("41", {
      ok: false,
      code: "TELEGRAM_HTTP_503",
    });
  });

  it("yanlış webhook secret'ını reddeder", async () => {
    const repo = repository();
    const notify = vi.fn();
    const result = await processTradingViewWebhook({
      request: request("wrong"),
      body: { ...validSignal, secret: "wrong" },
      expectedSecret: "top-secret",
      repository: repo,
      notify: async () => ({ ok: true, code: "SENT" }),
    });

    expect(result.status).toBe(401);
    expect(repo.createSignal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("aynı signal_id tekrar geldiğinde ikinci Telegram bildirimi üretmez", async () => {
    const repo = repository({ createSignal: vi.fn(async () => ({ created: false as const })) });
    const notify = vi.fn(async () => ({ ok: true, code: "SENT" }));
    const result = await processTradingViewWebhook({
      request: request(),
      body: validSignal,
      expectedSecret: "top-secret",
      repository: repo,
      notify,
    });

    expect(result.body.status).toBe("duplicate");
    expect(notify).not.toHaveBeenCalled();
    expect(repo.updateTelegramLog).not.toHaveBeenCalled();
  });

  it("yalnızca XAUUSD M5 BUY/SELL ve kapalı M5 bar sözleşmesini kabul eder", async () => {
    const repo = repository();
    const result = await processTradingViewWebhook({
      request: request(),
      body: { ...validSignal, symbol: "EURUSD" },
      expectedSecret: "top-secret",
      repository: repo,
      notify: async () => ({ ok: true, code: "SENT" }),
    });

    expect(result.status).toBe(400);
    expect(repo.createSignal).not.toHaveBeenCalled();
  });

  it("yeni kapanmış barı kaydeder ve yalnızca ölçülen sinyalleri günceller", async () => {
    const barEvent: BarEvent = {
      event: "bar",
      symbol: "XAUUSD",
      timeframe: "M5",
      open_time: "2026-11-01T12:05:00.000Z",
      close_time: "2026-11-01T12:10:00.000Z",
      open: 4012.56,
      high: 4015.2,
      low: 4010.1,
      close: 4014.8,
      closed: true,
      secret: "top-secret",
    };
    const repo = repository();
    const notify = vi.fn();
    const result = await processTradingViewWebhook({
      request: request(),
      body: barEvent,
      expectedSecret: "top-secret",
      repository: repo,
      notify: async () => ({ ok: true, code: "SENT" }),
    });

    expect(result.body.updatedSignals).toBe(2);
    expect(repo.recordClosedBar).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});
