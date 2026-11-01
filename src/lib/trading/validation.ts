import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const price = z.number().finite().positive().max(1_000_000_000);
const common = {
  symbol: z.literal("XAUUSD"),
  timeframe: z.literal("M5"),
  secret: z.string().min(1).max(512).optional(),
};

const signalEventSchema = z
  .object({
    event: z.literal("signal"),
    signal_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    ...common,
    direction: z.enum(["BUY", "SELL"]),
    bar_time: timestamp,
    entry_price: price,
  })
  .strict();

const barEventSchema = z
  .object({
    event: z.literal("bar"),
    ...common,
    open_time: timestamp,
    close_time: timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    closed: z.literal(true),
  })
  .strict()
  .superRefine((bar, context) => {
    const duration = Date.parse(bar.close_time) - Date.parse(bar.open_time);
    if (duration !== 5 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["close_time"],
        message: "M5 bar must span exactly five minutes.",
      });
    }
    if (bar.high < Math.max(bar.open, bar.close, bar.low)) {
      context.addIssue({
        code: "custom",
        path: ["high"],
        message: "High must be at least the open, close, and low.",
      });
    }
    if (bar.low > Math.min(bar.open, bar.close, bar.high)) {
      context.addIssue({
        code: "custom",
        path: ["low"],
        message: "Low must be no greater than the open, close, and high.",
      });
    }
  });

export const tradingViewEventSchema = z.discriminatedUnion("event", [
  signalEventSchema,
  barEventSchema,
]);

export type TradingViewEvent = z.infer<typeof tradingViewEventSchema>;
export type SignalEvent = Extract<TradingViewEvent, { event: "signal" }>;
export type BarEvent = Extract<TradingViewEvent, { event: "bar" }>;

export function parseTradingViewEvent(input: unknown) {
  return tradingViewEventSchema.safeParse(input);
}

const secretLikeKey = /secret|token|password|authorization|api[_-]?key/i;

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      secretLikeKey.test(key) ? "[redacted]" : redactSensitiveFields(entry),
    ]),
  );
}
