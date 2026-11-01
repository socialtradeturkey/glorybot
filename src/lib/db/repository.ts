import { getDatabase } from "@/lib/db/client";
import type { BarEvent, SignalEvent } from "@/lib/trading/validation";
import type { TelegramDeliveryResult } from "@/lib/trading/telegram";
import { redactSensitiveFields } from "@/lib/trading/validation";

export interface StoredSignal {
  id: string;
  signalId: string;
  direction: SignalEvent["direction"];
  entryPrice: number;
  signalTime: string;
}

export interface StoredBarResult {
  duplicate: boolean;
  updatedSignals: number;
}

export async function createSignal(event: SignalEvent, rawPayload: unknown) {
  const sql = getDatabase();
  const safePayload = JSON.stringify(redactSensitiveFields(rawPayload));
  const rows = await sql`
    WITH inserted AS (
      INSERT INTO trading_signals (
        signal_id, symbol, timeframe, direction, signal_time, entry_price, raw_payload
      ) VALUES (
        ${event.signal_id}, ${event.symbol}, ${event.timeframe}, ${event.direction},
        ${event.bar_time}, ${event.entry_price}, ${safePayload}::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING id, signal_id, symbol, timeframe, direction, signal_time, entry_price
    ), measured AS (
      SELECT
        i.id,
        i.entry_price,
        COALESCE(GREATEST(MAX(CASE
          WHEN i.direction = 'BUY' THEN b.high_price - i.entry_price
          ELSE i.entry_price - b.low_price
        END), 0), 0) AS mfe,
        COALESCE(GREATEST(MAX(CASE
          WHEN i.direction = 'BUY' THEN i.entry_price - b.low_price
          ELSE b.high_price - i.entry_price
        END), 0), 0) AS mae,
        ARRAY_AGG(b.close_price ORDER BY b.close_time DESC)
          FILTER (WHERE b.id IS NOT NULL) AS ordered_closes,
        COUNT(b.id)::INTEGER AS bars_count,
        MAX(b.close_time) AS last_bar_time
      FROM inserted i
      LEFT JOIN market_bars b
        ON b.symbol = i.symbol
        AND b.timeframe = i.timeframe
        AND b.is_closed = TRUE
        AND b.open_time > i.signal_time
      GROUP BY i.id, i.entry_price, i.direction
    ), performance AS (
      INSERT INTO signal_performance (
        signal_ref, mfe, mae, current_move, bars_count, last_bar_time
      )
      SELECT
        i.id,
        m.mfe,
        m.mae,
        CASE WHEN i.direction = 'BUY'
          THEN COALESCE((m.ordered_closes)[1], i.entry_price) - i.entry_price
          ELSE i.entry_price - COALESCE((m.ordered_closes)[1], i.entry_price)
        END,
        m.bars_count,
        m.last_bar_time
      FROM inserted i
      JOIN measured m ON m.id = i.id
      ON CONFLICT (signal_ref) DO UPDATE SET
        mfe = EXCLUDED.mfe,
        mae = EXCLUDED.mae,
        current_move = EXCLUDED.current_move,
        bars_count = EXCLUDED.bars_count,
        last_bar_time = EXCLUDED.last_bar_time,
        updated_at = NOW()
      RETURNING signal_ref
    ), notification AS (
      INSERT INTO telegram_logs (signal_ref, status)
      SELECT id, 'pending' FROM inserted
      ON CONFLICT (signal_ref) DO NOTHING
      RETURNING signal_ref
    )
    SELECT id, signal_id, direction, entry_price, signal_time FROM inserted
  `;

  const typedRows = rows as unknown as Array<{
    id: string | number | bigint;
    signal_id: string;
    direction: SignalEvent["direction"];
    entry_price: string | number;
    signal_time: Date | string;
  }>;
  if (typedRows.length === 0) return { created: false as const };
  const row = typedRows[0];

  return {
    created: true as const,
    signal: {
      id: String(row.id),
      signalId: row.signal_id,
      direction: row.direction,
      entryPrice: Number(row.entry_price),
      signalTime: row.signal_time instanceof Date ? row.signal_time.toISOString() : new Date(row.signal_time).toISOString(),
    } satisfies StoredSignal,
  };
}

export async function recordClosedBar(event: BarEvent): Promise<StoredBarResult> {
  const sql = getDatabase();
  const rows = await sql`
    WITH inserted AS (
      INSERT INTO market_bars (
        symbol, timeframe, open_time, close_time,
        open_price, high_price, low_price, close_price, is_closed
      ) VALUES (
        ${event.symbol}, ${event.timeframe}, ${event.open_time}, ${event.close_time},
        ${event.open}, ${event.high}, ${event.low}, ${event.close}, ${event.closed}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, symbol, timeframe, open_time
    ), measured AS (
      SELECT
        s.id AS signal_ref,
        COALESCE(GREATEST(MAX(CASE
          WHEN s.direction = 'BUY' THEN b.high_price - s.entry_price
          ELSE s.entry_price - b.low_price
        END), 0), 0) AS mfe,
        COALESCE(GREATEST(MAX(CASE
          WHEN s.direction = 'BUY' THEN s.entry_price - b.low_price
          ELSE b.high_price - s.entry_price
        END), 0), 0) AS mae,
        ARRAY_AGG(b.close_price ORDER BY b.close_time DESC) AS ordered_closes,
        COUNT(b.id)::INTEGER AS bars_count,
        MAX(b.close_time) AS last_bar_time,
        s.direction,
        s.entry_price
      FROM trading_signals s
      JOIN inserted i
        ON i.symbol = s.symbol
        AND i.timeframe = s.timeframe
        AND i.open_time > s.signal_time
      JOIN market_bars b
        ON b.symbol = s.symbol
        AND b.timeframe = s.timeframe
        AND b.is_closed = TRUE
        AND b.open_time > s.signal_time
      GROUP BY s.id, s.direction, s.entry_price
    ), upserted AS (
      INSERT INTO signal_performance (
        signal_ref, mfe, mae, current_move, bars_count, last_bar_time
      )
      SELECT
        signal_ref,
        mfe,
        mae,
        CASE WHEN direction = 'BUY'
          THEN (ordered_closes)[1] - entry_price
          ELSE entry_price - (ordered_closes)[1]
        END,
        bars_count,
        last_bar_time
      FROM measured
      ON CONFLICT (signal_ref) DO UPDATE SET
        mfe = EXCLUDED.mfe,
        mae = EXCLUDED.mae,
        current_move = EXCLUDED.current_move,
        bars_count = EXCLUDED.bars_count,
        last_bar_time = EXCLUDED.last_bar_time,
        updated_at = NOW()
      RETURNING signal_ref
    )
    SELECT
      (SELECT COUNT(*) FROM inserted)::INTEGER AS inserted_count,
      (SELECT COUNT(*) FROM upserted)::INTEGER AS updated_count
  `;

  const typedRows = rows as unknown as Array<{ inserted_count: number | string; updated_count: number | string }>;
  const row = typedRows[0];
  const inserted = Number(row?.inserted_count ?? 0) > 0;
  return {
    duplicate: !inserted,
    updatedSignals: inserted ? Number(row.updated_count ?? 0) : 0,
  };
}

export async function updateTelegramLog(signalRef: string, result: TelegramDeliveryResult): Promise<void> {
  const sql = getDatabase();
  await sql`
    UPDATE telegram_logs
    SET
      status = ${result.ok ? "sent" : "failed"},
      attempts = CASE WHEN attempts = 0 THEN 1 ELSE attempts END,
      telegram_message_id = ${result.messageId ?? null},
      response_status = ${result.httpStatus ?? null},
      error_code = ${result.ok ? null : result.code.slice(0, 100)},
      updated_at = NOW()
    WHERE signal_ref = ${signalRef}
  `;
}

export async function writeApiLog(
  requestId: string,
  eventType: "signal" | "bar" | "invalid" | "health",
  statusCode: number,
  resultCode: string,
): Promise<void> {
  const sql = getDatabase();
  await sql`
    INSERT INTO api_logs (request_id, event_type, status_code, result_code)
    VALUES (${requestId}, ${eventType}, ${statusCode}, ${resultCode.slice(0, 100)})
  `;
}

export async function checkDatabase(): Promise<void> {
  const sql = getDatabase();
  await sql`SELECT 1 AS ok`;
}

export interface DashboardSignal {
  signalId: string;
  symbol: "XAUUSD";
  timeframe: "M5";
  direction: "BUY" | "SELL";
  signalTime: string;
  entryPrice: number;
  mfe: number;
  mae: number;
  currentMove: number;
  barsCount: number;
  lastBarTime: string | null;
  telegramStatus: "pending" | "sent" | "failed" | null;
}

export async function listRecentSignals(): Promise<DashboardSignal[]> {
  const sql = getDatabase();
  const rows = await sql`
    SELECT
      s.signal_id AS "signalId",
      s.symbol,
      s.timeframe,
      s.direction,
      s.signal_time AS "signalTime",
      s.entry_price AS "entryPrice",
      COALESCE(p.mfe, 0) AS mfe,
      COALESCE(p.mae, 0) AS mae,
      COALESCE(p.current_move, 0) AS "currentMove",
      COALESCE(p.bars_count, 0) AS "barsCount",
      p.last_bar_time AS "lastBarTime",
      t.status AS "telegramStatus"
    FROM trading_signals s
    LEFT JOIN signal_performance p ON p.signal_ref = s.id
    LEFT JOIN telegram_logs t ON t.signal_ref = s.id
    ORDER BY s.signal_time DESC, s.id DESC
    LIMIT 100
  `;

  const typedRows = rows as unknown as Array<Record<string, unknown>>;
  return typedRows.map((row) => {
    const record = row as Record<string, unknown>;
    const timestamp = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
    const nullableTimestamp = (value: unknown): string | null =>
      value === null || value === undefined ? null : timestamp(value);

    return {
      signalId: String(record.signalId),
      symbol: "XAUUSD",
      timeframe: "M5",
      direction: record.direction === "SELL" ? "SELL" : "BUY",
      signalTime: timestamp(record.signalTime),
      entryPrice: Number(record.entryPrice),
      mfe: Number(record.mfe),
      mae: Number(record.mae),
      currentMove: Number(record.currentMove),
      barsCount: Number(record.barsCount),
      lastBarTime: nullableTimestamp(record.lastBarTime),
      telegramStatus:
        record.telegramStatus === "sent" || record.telegramStatus === "failed" || record.telegramStatus === "pending"
          ? record.telegramStatus
          : null,
    };
  });
}
