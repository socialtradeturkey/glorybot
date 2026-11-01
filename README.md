# GLORYBOT — Signal Evaluation

TradingView'den yalnızca XAUUSD M5 BUY/SELL sinyalleri ve kapanmış M5 mumları alır; sinyal mumunu hariç tutarak sonraki kapanmış mumların gerçek fiyat hareketini ölçer. Yeni sinyaller Telegram'a bildirilir ve gerçek kayıtlar karanlık, responsive dashboard'da gösterilir.

## Teknoloji

Next.js 15 App Router ve TypeScript; Next.js API Routes; Neon PostgreSQL (`@neondatabase/serverless`); webhook şema doğrulaması için Zod 4. Vercel'de standart Next.js projesi olarak dağıtılabilir.

## Yerel kurulum

```bash
pnpm install
cp .env.example .env.local
# .env.local içindeki değerleri kendi Neon/Telegram/TradingView ayarlarınla doldur.
# Neon SQL Editor'de database/schema.sql dosyasını çalıştır.
pnpm dev
```

Kontroller:

```bash
pnpm typecheck
pnpm test
pnpm build
```

`.env.local` ve gerçek secret'lar Git'e eklenmemelidir. `.env.example` yalnızca boş değişken adları içerir.

## Ortam değişkenleri

| Değişken | Amaç |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL bağlantı dizesi (sunucu tarafı, TLS bağlantısı). |
| `TRADINGVIEW_WEBHOOK_SECRET` | TradingView payload'ı veya desteklenen webhook başlığındaki ortak gizli değer. |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API bot token'ı. |
| `TELEGRAM_CHAT_ID` | Bildirimlerin gideceği Telegram sohbet/grup kimliği. |

Vercel'de bu değerleri Project Settings → Environment Variables bölümünde tanımlayın. Gerçek secret'ları kaynak dosyasına, `README`'ye, istemci koduna ya da loglara yazmayın. Canlı secret'lar sağlanmadığından uygulama varsayılan olarak canlı servislere bağlanmaz; DB hazır değilken demo kayıt göstermez.

## Veritabanı

`database/schema.sql` beş tabloyu, XAUUSD/M5 kısıtlarını, foreign key'leri, idempotency unique constraint'lerini ve sorgu indekslerini tanımlar. Neon SQL Editor'de bir kez çalıştırın; şema değişikliklerini inceleyip kontrollü olarak uygulayın. Uygulama başlangıcında otomatik/destructive migration çalıştırılmaz.

## TradingView webhook sözleşmesi

Webhook URL: `https://<vercel-domain>/api/tradingview`. İstek `application/json` olmalıdır. Secret üç yerden biriyle gönderilebilir: JSON'un üst düzey `secret` alanı, `X-Webhook-Secret` başlığı veya `Authorization: Bearer ...`. Header/body'den en az biri `TRADINGVIEW_WEBHOOK_SECRET` ile eşleşmelidir; secret sabit süreli karşılaştırmayla doğrulanır ve veritabanına kaydedilen ham payload'dan çıkarılır.

### Signal event

TradingView alert mesajı örneği (placeholder'ı kendi secret'ınla değiştir; örnek satır gerçek credential içermez):

```json
{
  "event": "signal",
  "signal_id": "glory-xau-m5-20261101T120000Z",
  "symbol": "XAUUSD",
  "timeframe": "M5",
  "direction": "BUY",
  "bar_time": "2026-11-01T12:00:00.000Z",
  "entry_price": 4012.56,
  "secret": "<TRADINGVIEW_WEBHOOK_SECRET>"
}
```

`bar_time`, sinyal mumunun açılış zamanıdır; bu mumun high/low/close değerleri performans hesabına alınmaz. Aynı `signal_id` veya aynı XAUUSD/M5 mum zamanı yeniden gelirse ikinci sinyal ve Telegram bildirimi oluşturulmaz.

### Kapanmış bar event

```json
{
  "event": "bar",
  "symbol": "XAUUSD",
  "timeframe": "M5",
  "open_time": "2026-11-01T12:05:00.000Z",
  "close_time": "2026-11-01T12:10:00.000Z",
  "open": 4012.56,
  "high": 4015.20,
  "low": 4010.10,
  "close": 4014.80,
  "closed": true,
  "secret": "<TRADINGVIEW_WEBHOOK_SECRET>"
}
```

Bar'ın açılış ve kapanış zamanları tam beş dakika aralıklı olmalı; `closed` alanı `true` olmalıdır. TradingView alert'i mum kapanışında tetikleyin. Açık mum, farklı sembol/zaman dilimi veya BUY/SELL dışı yön reddedilir.

## Performans tanımları

Sinyal mumundan sonraki kapanmış M5 mumları kullanılır. MFE ve MAE, giriş fiyatına göre yönsel maksimum olumlu ve olumsuz mesafe olarak **pozitif fiyat birimlerinde** saklanır; current move son kapanmış bar'ın close fiyatına göre yönlü ve işaretlidir.

- BUY: `MFE = max(high − entry, 0)`, `MAE = max(entry − low, 0)`, `current move = last close − entry`.
- SELL: `MFE = max(entry − low, 0)`, `MAE = max(high − entry, 0)`, `current move = entry − last close`.

Aynı kapanmış bar tekrar gönderilirse bar ve performans ikinci kez sayılmaz. Daha sonra kapanan her yeni M5 bar, o andan önce açılmış ilgili sinyallerin ölçümlerini günceller.

## API

| Endpoint | Davranış |
| --- | --- |
| `POST /api/tradingview` | Secret ve payload doğrulama; yeni sinyal/bar kaydı; idempotent duplicate yanıtı; yeni sinyal için tek Telegram denemesi ve teslimat logu. |
| `GET /api/signals` | Veritabanından en yeni 100 sinyal ve performans özetleri. |
| `GET /api/health` | API/DB sağlık durumu. DB yoksa `503` döner, gerçek secret veya bağlantı ayrıntısı açığa çıkarmaz. |

Dashboard örnek/sahte işlem üretmez. Veritabanı ayarlanmamış veya erişilemiyorsa bağlantı/boş durumunu açıkça gösterir.

## Telegram

Yalnızca veritabanına ilk kez kaydedilmiş geçerli sinyal için Bot API'ye tek gönderim denenir. `telegram_logs` benzersiz sinyal kaydı ve durum/sonuç bilgisini tutar. Otomatik tekrar gönderim yapılmaz: Telegram'ın yanıtı belirsiz olduğunda yinelenen mesaj riskini azaltır; başarısız kayıt `failed` olarak görünür ve gerektiğinde elle incelenir. Telegram token'ı loglarda veya response'larda gösterilmez.

## Kapsam dışı

MT4/MT5 ve broker bağlantısı, TP/SL, ilave sinyal filtreleri, EMA/RSI/MACD veya mevcut indikatör algoritmasında değişiklik yoktur. Ürün yalnızca XAUUSD M5 içindir.
