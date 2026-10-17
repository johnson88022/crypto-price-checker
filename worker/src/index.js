
const ALLOWED_SYMBOLS = new Set([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
  "DOGEUSDT", "LTCUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT"
]);

const ALLOWED_INTERVALS = new Set(["15m", "1h", "4h", "1d"]);

const BINANCE_HOSTS = [
  "https://data-api.binance.vision/api/v3/klines"
];

const BINANCE_MAX_HOST_ATTEMPTS = 3;
const BINANCE_TIMEOUT_MS = 8000;
const SCAN_BATCH_SIZE = 8;
const SCAN_CONCURRENCY = 3;
const BINANCE_RESTRICTION_KEY = "binance_restriction_v1";
const BINANCE_RESTRICTION_TTL = 6 * 60 * 60;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store"
};


function cachedProviderName(env) {
  // The actual source may be Binance or Coinbase fallback; clients should treat this as a mixed provider.
  return "Binance Spot with Coinbase public-market fallback";
}

function reply(data, status = 200) {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

function validSymbol(value) {
  return typeof value === "string" &&
    ALLOWED_SYMBOLS.has(value.toUpperCase());
}

function parseSymbols(raw, defaults, maxCount) {
  const symbols = (raw || defaults)
    .split(",")
    .map(s => s.trim().toUpperCase());

  if (!symbols.length || symbols.length > maxCount ||
      symbols.some(s => !validSymbol(s))) {
    throw new Error(
      `Invalid symbols. Maximum ${maxCount} supported USDT pairs allowed.`
    );
  }

  return [...new Set(symbols)];
}

/*
 * Binance client：
 * - 同一 client 共用失敗端點紀錄。
 * - HTTP 451 立即停止，並使用 KV 暫存限制狀態 6 小時。
 * - HTTP 418 / 429 立即停止。
 * - 每個 client 最多嘗試 3 個官方端點。
 * - 其他請求在限制快取有效期間不會重複呼叫 Binance。
 */
function createBinanceClient(env) {
  let restrictionChecked = false;
  let cachedRestriction = null;
  let rateLimitError = null;

  const symbolBase = (symbol) => String(symbol || "").toUpperCase().replace(/USDT$/, "");
  const coinbaseProduct = (symbol) => `${symbolBase(symbol)}-USDT`;
  const granularityFor = (interval) => ({
    "15m": 900, "1h": 3600, "4h": 3600, "1d": 86400
  })[interval] || 3600;

  async function coinbase(path) {
    const matchKlines = path.match(/\/api\/v3\/klines\?([^#]+)/);
    const matchPrice = path.match(/\/api\/v3\/ticker\/price\?symbol=([A-Z0-9]+)/i);
    if (!matchKlines && !matchPrice) {
      throw new Error("Coinbase fallback does not support this market-data request");
    }

    let product, endpoint;
    if (matchKlines) {
      const params = new URLSearchParams(matchKlines[1]);
      const symbol = params.get("symbol");
      const interval = params.get("interval") || "1h";
      product = coinbaseProduct(symbol);
      const granularity = granularityFor(interval);
      const limit = Math.min(300, Math.max(50, Number(params.get("limit") || 100)));
      const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
      url.searchParams.set("granularity", String(granularity));
      // Coinbase limits candle windows; request a bounded recent window.
      url.searchParams.set("start", new Date(Date.now() - limit * granularity * 1000).toISOString());
      url.searchParams.set("end", new Date().toISOString());
      endpoint = url.toString();
    } else {
      product = coinbaseProduct(matchPrice[1]);
      endpoint = `https://api.exchange.coinbase.com/products/${product}/ticker`;
    }

    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "CryptoPriceChecker/2.1" },
      signal: AbortSignal.timeout(BINANCE_TIMEOUT_MS)
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 160);
      throw new Error(`Coinbase fallback ${product} HTTP ${response.status}: ${body}`);
    }
    const data = await response.json();

    if (matchPrice) {
      return { symbol: matchPrice[1].toUpperCase(), price: String(data.price) };
    }

    if (!Array.isArray(data) || !data.length) {
      throw new Error(`Coinbase returned no candles for ${product}`);
    }
    // Coinbase candle rows are [time(seconds), low, high, open, close, volume].
    let rows = data.map(c => {
      const openTime = Number(c[0]) * 1000;
      const interval = new URLSearchParams(matchKlines[1]).get("interval") || "1h";
      const intervalMs = ({ "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 })[interval] || 3600000;
      return [openTime, Number(c[3]), Number(c[2]), Number(c[1]), Number(c[4]), Number(c[5]),
        openTime + intervalMs - 1, Number(c[4]) * Number(c[5]), 0, 0, 0, 0];
    }).sort((a, b) => a[0] - b[0]);

    const interval = new URLSearchParams(matchKlines[1]).get("interval") || "1h";
    if (interval === "4h") {
      const grouped = new Map();
      for (const row of rows) {
        const bucket = Math.floor(row[0] / 14400000) * 14400000;
        const prior = grouped.get(bucket);
        if (!prior) {
          const next = [...row];
          next[0] = bucket;
          next[6] = bucket + 14400000 - 1;
          grouped.set(bucket, next);
        } else {
          prior[2] = Math.max(prior[2], row[2]);
          prior[3] = Math.min(prior[3], row[3]);
          prior[4] = row[4];
          prior[5] += row[5];
          prior[6] = bucket + 14400000 - 1;
          prior[7] += row[7];
        }
      }
      rows = [...grouped.values()];
    }
    const requestedLimit = Number(new URLSearchParams(matchKlines[1]).get("limit") || 100);
    return rows.slice(-requestedLimit);
  }

  async function binance(path) {
    if (!restrictionChecked && env?.PUSH_KV) {
      restrictionChecked = true;
      cachedRestriction = await env.PUSH_KV.get(BINANCE_RESTRICTION_KEY).catch(() => null);
    }

    // A previously observed HTTP 451 must not disable the independent data provider.
    if (cachedRestriction) {
      try { return await coinbase(path); }
      catch (fallbackError) {
        throw new Error(`Binance is region-restricted and Coinbase fallback failed: ${fallbackError.message}`);
      }
    }
    if (rateLimitError) throw new Error(rateLimitError);

    const url = `https://data-api.binance.vision${path}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(BINANCE_TIMEOUT_MS)
      });

      if (response.status === 451) {
        const body = (await response.text()).slice(0, 200);
        const message = `Binance HTTP 451: regional eligibility restriction. ${body}`;
        cachedRestriction = message;
        if (env?.PUSH_KV) {
          await env.PUSH_KV.put(BINANCE_RESTRICTION_KEY, message, {
            expirationTtl: BINANCE_RESTRICTION_TTL
          }).catch(error => console.error("Failed to save Binance restriction cache:", error?.message || error));
        }
        try { return await coinbase(path); }
        catch (fallbackError) {
          throw new Error(`${message} Coinbase fallback failed: ${fallbackError.message}`);
        }
      }

      if (response.status === 418 || response.status === 429) {
        rateLimitError = `Binance HTTP ${response.status}: rate limited`;
        throw new Error(rateLimitError);
      }
      if (!response.ok) {
        // Try the independent source for unavailable/unsupported Binance endpoints.
        try { return await coinbase(path); }
        catch (fallbackError) {
          throw new Error(`Binance HTTP ${response.status}; Coinbase fallback failed: ${fallbackError.message}`);
        }
      }

      const data = await response.json();
      if (data && !Array.isArray(data) && typeof data === "object" && ("code" in data || "msg" in data)) {
        try { return await coinbase(path); }
        catch (fallbackError) {
          throw new Error(`Binance API error: ${JSON.stringify(data).slice(0, 120)}; Coinbase fallback failed: ${fallbackError.message}`);
        }
      }
      return data;
    } catch (error) {
      const message = error?.message || String(error);
      if (message.includes("HTTP 418") || message.includes("HTTP 429") || message.includes("rate limited")) throw error;
      // Network errors also get a chance to use Coinbase.
      try { return await coinbase(path); }
      catch (fallbackError) {
        throw new Error(`Binance request failed (${message}); Coinbase fallback failed: ${fallbackError.message}`);
      }
    }
  }

  return binance;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (const value of values.slice(period)) {
    result = (value - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

async function analyze(symbol, interval = "1h", binance = createBinanceClient()) {
  const candles = await binance(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`
  );

  if (!Array.isArray(candles) || candles.length < 51) {
    throw new Error(`Insufficient candle data for ${symbol} ${interval}`);
  }

  const closed = candles.slice(0, -1);
  const closes = closed.map(c => Number(c[4]));
  const highs = closed.map(c => Number(c[2]));
  const lows = closed.map(c => Number(c[3]));
  const volumes = closed.map(c => Number(c[5]));

  if ([...closes, ...highs, ...lows, ...volumes]
      .some(v => !Number.isFinite(v))) {
    throw new Error(`Invalid candle data for ${symbol}`);
  }

  const last = closes[closes.length - 1];
  const priorCloses = closes.slice(0, -1);

  const ema20 = ema(closes.slice(-60), 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);

  const previousEma20 = ema(priorCloses.slice(-60), 20);
  const previousEma50 = ema(priorCloses, 50);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const previousEma12 = ema(priorCloses, 12);
  const previousEma26 = ema(priorCloses, 26);

  const macd =
    ema12 !== null && ema26 !== null ? ema12 - ema26 : null;

  const previousMacd =
    previousEma12 !== null && previousEma26 !== null
      ? previousEma12 - previousEma26
      : null;

  const previousVolumes = volumes.slice(-21, -1);

  const avgVolume = previousVolumes.length
    ? previousVolumes.reduce((a, b) => a + b, 0) /
      previousVolumes.length
    : null;

  const volumeRatio =
    avgVolume > 0 ? volumes[volumes.length - 1] / avgVolume : null;

  const trueRanges = [];

  for (let i = 1; i < closes.length; i++) {
    trueRanges.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const recentTR = trueRanges.slice(-14);

  const atr = recentTR.length
    ? recentTR.reduce((a, b) => a + b, 0) / recentTR.length
    : null;

  const bullishTrend =
    ema20 !== null && ema50 !== null && previousEma50 !== null &&
    last > ema20 && ema20 > ema50 && ema50 > previousEma50;

  const bullishMomentum =
    rsi14 !== null && rsi14 >= 52 && rsi14 <= 66 &&
    macd !== null && previousMacd !== null &&
    macd > 0 && macd > previousMacd;

  const volumeConfirmed =
    volumeRatio !== null && volumeRatio >= 1.0;

  const bearishTrend =
    ema20 !== null && ema50 !== null && previousEma50 !== null &&
    last < ema20 && ema20 < ema50 && ema50 < previousEma50;

  const bearishMomentum =
    rsi14 !== null && rsi14 <= 45 &&
    macd !== null && previousMacd !== null &&
    macd < 0 && macd < previousMacd;

  let score = 0;

  if (ema20 !== null) score += last > ema20 ? 1 : -1;

  if (ema20 !== null && ema50 !== null) {
    score += ema20 > ema50 ? 1 : -1;
  }

  if (previousEma50 !== null && ema50 !== null) {
    score += ema50 > previousEma50 ? 1 : -1;
  }

  if (rsi14 !== null) {
    if (rsi14 >= 52 && rsi14 <= 66) score++;
    else if (rsi14 <= 45) score--;
  }

  if (macd !== null && previousMacd !== null) {
    if (macd > 0 && macd > previousMacd) score++;
    else if (macd < 0 && macd < previousMacd) score--;
  }

  if (volumeConfirmed) score++;

  let signal = "WAIT";

  if (bullishTrend && bullishMomentum && volumeConfirmed) {
    signal = "ACCUMULATE";
  } else if (bearishTrend && bearishMomentum) {
    signal = "CAUTION";
  }

  let explanation = "未同時滿足嚴格條件，暫不產生操作訊號。";

  if (signal === "ACCUMULATE") {
    explanation =
      "趨勢、動能與成交量同時偏多；仍須等待連續兩根已收盤 K 線確認，且不代表應一次投入全部資金。";
  } else if (signal === "CAUTION") {
    explanation =
      "價格與均線趨勢偏弱，且動能轉弱；仍須等待連續兩根已收盤 K 線確認。";
  }

  return {
    symbol,
    interval,
    candleCount: closed.length,
    price: last,
    indicators: {
      ema20, ema50, previousEma50, rsi14,
      macd, previousMacd, atr, volumeRatio
    },
    score,
    signal,
    explanation,
    lastClosedCandleAt: new Date(
      closed[closed.length - 1][0]
    ).toISOString()
  };
}

const enc = new TextEncoder();

function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;

  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }

  return out;
}

function b64urlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const raw = atob(padded);

  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );

  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function hkdfExpand(prk, info, length) {
  let previous = new Uint8Array(0);
  let output = new Uint8Array(0);
  let counter = 1;

  while (output.length < length) {
    previous = await hmacSha256(
      prk,
      concatBytes(previous, info, new Uint8Array([counter++]))
    );
    output = concatBytes(output, previous);
  }

  return output.slice(0, length);
}

function jwtPart(value) {
  return bytesToB64url(enc.encode(JSON.stringify(value)));
}

function endpointAllowed(endpoint) {
  try {
    const u = new URL(endpoint);

    if (u.protocol !== "https:") return false;

    const h = u.hostname.toLowerCase();

    return h === "fcm.googleapis.com" ||
      h.endsWith(".push.services.mozilla.com") ||
      h === "web.push.apple.com" ||
      h.endsWith(".notify.windows.com") ||
      h === "wns.windows.com";
  } catch {
    return false;
  }
}

async function makeVapidJwt(endpoint, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("VAPID secrets are not configured");
  }

  const publicBytes = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const privateBytes = b64urlToBytes(env.VAPID_PRIVATE_KEY);

  if (publicBytes.length !== 65 || privateBytes.length !== 32) {
    throw new Error("Invalid VAPID key format");
  }

  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(publicBytes.slice(1, 33)),
    y: bytesToB64url(publicBytes.slice(33, 65)),
    d: bytesToB64url(privateBytes),
    ext: true,
    key_ops: ["sign"]
  };

  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  const audience = new URL(endpoint).origin;
  const header = jwtPart({ typ: "JWT", alg: "ES256" });
  const claims = jwtPart({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com"
  });

  const unsigned = `${header}.${claims}`;

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(unsigned)
    )
  );

  return `${unsigned}.${bytesToB64url(signature)}`;
}

async function encryptPushPayload(subscription, payload) {
  const uaPublic = b64urlToBytes(subscription.p256dh);
  const authSecret = b64urlToBytes(subscription.auth);

  if (uaPublic.length !== 65 || authSecret.length < 16) {
    throw new Error("Invalid subscription encryption keys");
  }

  const serverKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey)
  );

  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      serverKeys.privateKey,
      256
    )
  );

  const authPrk = await hmacSha256(authSecret, shared);

  const ikm = await hkdfExpand(
    authPrk,
    concatBytes(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(
    prk, enc.encode("Content-Encoding: aes128gcm\0"), 16
  );
  const nonce = await hkdfExpand(
    prk, enc.encode("Content-Encoding: nonce\0"), 12
  );

  const aesKey = await crypto.subtle.importKey(
    "raw", cek, { name: "AES-GCM" }, false, ["encrypt"]
  );

  const plaintext = concatBytes(
    enc.encode(JSON.stringify(payload)),
    new Uint8Array([2])
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      plaintext
    )
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublic.length;

  return concatBytes(header, asPublic, ciphertext);
}

async function sendWebPush(subscription, payload, env) {
  if (!endpointAllowed(subscription.endpoint)) {
    throw new Error("Unsupported push endpoint host");
  }

  const body = await encryptPushPayload(subscription, payload);
  const jwt = await makeVapidJwt(subscription.endpoint, env);

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "60",
      "Urgency": "normal"
    },
    body
  });

  return { ok: response.ok, status: response.status };
}

async function sendTelegram(text, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return {
      skipped: true,
      reason: "Telegram secrets not configured"
    };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram send failed: HTTP ${response.status}`);
  }

  return { ok: true };
}

async function sendBrowserPush(payload, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return {
      skipped: true,
      reason: "VAPID secrets not configured"
    };
  }

  const result = await env.DB
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    .all();

  const subscriptions = result.results || [];
  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const sub of subscriptions) {
    try {
      const outcome = await sendWebPush(sub, payload, env);

      if (outcome.ok) {
        sent++;
      } else {
        failed++;

        if (outcome.status === 404 || outcome.status === 410) {
          await env.DB
            .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .bind(sub.endpoint)
            .run();
          removed++;
        }
      }
    } catch (error) {
      failed++;
      console.error("Web Push failed:", error.message);
    }
  }

  return {
    subscriptions: subscriptions.length,
    sent,
    failed,
    removed
  };
}

async function notifyAlertBatch(alerts, env) {
  if (!alerts.length) return;

  const lines = alerts.map(a =>
    `${a.signal === "ACCUMULATE" ? "🟢 定投訊號" : "🟠 風險提醒"} ${a.symbol} ${a.interval}\n` +
    `價格：${a.price}\n` +
    `RSI：${a.indicators?.rsi14 == null ? "N/A" : a.indicators.rsi14.toFixed(2)}｜Score：${a.score}\n` +
    `${a.explanation}`
  );

  const payload = {
    title: `定投掃描：${alerts.length} 個新訊號`,
    body: lines.join("\n\n").slice(0, 1800),
    url: "/api/alerts"
  };

  const sends = [sendBrowserPush(payload, env)];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    sends.push(
      sendTelegram(
        `加密貨幣定投掃描（${new Date().toISOString()}）\n\n` +
        lines.join("\n\n").slice(0, 3900),
        env
      )
    );
  }

  const results = await Promise.allSettled(sends);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "Notification channel failed:",
        result.reason?.message || result.reason
      );
    }
  }
}

async function scanAll(env) {
  if (!env.DB || !env.PUSH_KV) {
    throw new Error("Missing DB or PUSH_KV binding");
  }

  // 即使 Binance 曾回報 HTTP 451，也繼續掃描；資料客戶端會改用 Coinbase 備援。
  const tasks = [];

  for (const symbol of ALLOWED_SYMBOLS) {
    for (const interval of ALLOWED_INTERVALS) {
      tasks.push({ symbol, interval });
    }
  }

  const cursorKey = "scan_cursor";
  const savedCursor = Number(await env.PUSH_KV.get(cursorKey) || 0);

  const startIndex = Number.isInteger(savedCursor) && savedCursor >= 0
    ? savedCursor % tasks.length
    : 0;

  const selectedTasks = [];

  for (let i = 0; i < Math.min(SCAN_BATCH_SIZE, tasks.length); i++) {
    selectedTasks.push(tasks[(startIndex + i) % tasks.length]);
  }

  const nextCursor = (startIndex + selectedTasks.length) % tasks.length;

  await env.PUSH_KV.put(cursorKey, String(nextCursor));

  const binance = createBinanceClient(env);
  let next = 0;
  const newAlerts = [];
  const errors = [];
  const now = Date.now();

  const cooldownMs = {
    "15m": 4 * 60 * 60 * 1000,
    "1h": 8 * 60 * 60 * 1000,
    "4h": 24 * 60 * 60 * 1000,
    "1d": 72 * 60 * 60 * 1000
  };

  async function worker() {
    while (next < selectedTasks.length) {
      const task = selectedTasks[next++];
      const stateKey = `${task.symbol}:${task.interval}`;

      try {
        const analysis = await analyze(task.symbol, task.interval, binance);

        const priorRow = await env.DB
          .prepare("SELECT value FROM scan_state WHERE key = ?")
          .bind(stateKey)
          .first();

        let prior = null;

        try {
          prior = priorRow ? JSON.parse(priorRow.value) : null;
        } catch {
          prior = null;
        }

        if (prior && prior.candleAt === analysis.lastClosedCandleAt) {
          continue;
        }

        const priorStableSignal = prior?.signal || "WAIT";

        const candidateCount =
          prior?.candidateSignal === analysis.signal
            ? (Number(prior.candidateCount) || 0) + 1
            : 1;

        const stableSignal =
          candidateCount >= 2 ? analysis.signal : priorStableSignal;

        const actionable = ["ACCUMULATE", "CAUTION"].includes(stableSignal);
        const isTransition =
          actionable && stableSignal !== priorStableSignal;

        const lastAlertAtMs = prior?.lastAlertAt
          ? Date.parse(prior.lastAlertAt)
          : 0;

        const sameDirectionCooldownActive =
          prior?.lastAlertSignal === stableSignal &&
          Number.isFinite(lastAlertAtMs) &&
          now - lastAlertAtMs < cooldownMs[task.interval];

        const shouldAlert =
          isTransition && !sameDirectionCooldownActive;

        const nextState = {
          signal: stableSignal,
          candidateSignal: analysis.signal,
          candidateCount,
          candleAt: analysis.lastClosedCandleAt,
          lastAlertSignal: shouldAlert
            ? stableSignal
            : (prior?.lastAlertSignal || null),
          lastAlertAt: shouldAlert
            ? new Date(now).toISOString()
            : (prior?.lastAlertAt || null)
        };

        await env.DB.prepare(
          `INSERT INTO scan_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        ).bind(
          stateKey,
          JSON.stringify(nextState),
          new Date(now).toISOString()
        ).run();

        if (shouldAlert) {
          const direction =
            stableSignal === "ACCUMULATE" ? "BUY" : "CAUTION";

          const title =
            `${task.symbol} ${task.interval} ${stableSignal}`;

          const summary =
            `${analysis.explanation} ` +
            `價格=${analysis.price}; ` +
            `RSI14=${analysis.indicators.rsi14}; ` +
            `score=${analysis.score}; ` +
            `volumeRatio=${analysis.indicators.volumeRatio}; ` +
            `candle=${analysis.lastClosedCandleAt}`;

          const digest = await crypto.subtle.digest(
            "SHA-256",
            enc.encode(
              `${task.symbol}|${task.interval}|${stableSignal}|${analysis.lastClosedCandleAt}`
            )
          );

          const fingerprint =
            bytesToB64url(new Uint8Array(digest));

          const id = crypto.randomUUID();
          const triggeredAt = new Date(now).toISOString();

          const inserted = await env.DB.prepare(
            `INSERT OR IGNORE INTO alerts
             (id, symbol, timeframe, direction, title, summary, triggered_at, fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            id,
            task.symbol,
            task.interval,
            direction,
            title,
            summary,
            triggeredAt,
            fingerprint
          ).run();

          if ((inserted.meta?.changes ?? 0) > 0) {
            newAlerts.push({
              ...analysis,
              signal: stableSignal,
              triggeredAt
            });
          }
        }
      } catch (error) {
        errors.push({
          symbol: task.symbol,
          interval: task.interval,
          error: error.message || "Scan failed"
        });

        console.error(
          `Scan failed for ${task.symbol} ${task.interval}:`,
          error.message
        );

        // 451 已經寫入 KV；本批其餘工作不再呼叫 Binance。
        if (
          String(error.message || "").includes("HTTP 451") ||
          String(error.message || "").includes("regional eligibility restriction")
        ) {
          next = selectedTasks.length;
          break;
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SCAN_CONCURRENCY, selectedTasks.length) },
      () => worker()
    )
  );

  await notifyAlertBatch(newAlerts, env);

  let deletedOldAlerts = 0;

  try {
    const cutoff = new Date(
      now - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const cleanup = await env.DB
      .prepare("DELETE FROM alerts WHERE triggered_at < ?")
      .bind(cutoff)
      .run();

    deletedOldAlerts = cleanup.meta?.changes ?? 0;
  } catch (error) {
    errors.push({
      task: "alert-cleanup",
      error: error.message || "Cleanup failed"
    });
  }

  const summary = {
    ok: errors.length === 0,
    scanned: selectedTasks.length,
    totalTasks: tasks.length,
    batchSize: SCAN_BATCH_SIZE,
    startCursor: startIndex,
    nextCursor,
    remainingTasks: tasks.length - selectedTasks.length,
    alertsCreated: newAlerts.length,
    deletedOldAlerts,
    errors
  };

  await env.PUSH_KV.put(
    "last_scan_summary",
    JSON.stringify({
      ...summary,
      at: new Date().toISOString()
    }),
    { expirationTtl: 60 * 60 * 24 * 7 }
  );

  return summary;
}

function requireAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  const supplied = request.headers.get("Authorization") || "";

  return !!expected && supplied === `Bearer ${expected}`;
}

function setupHtml() {
  return `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>定投通知設定</title>
<body style="font:16px system-ui;max-width:680px;margin:40px auto;padding:0 16px">
<h1>瀏覽器 Web Push 設定</h1>
<p>請在支援通知的瀏覽器中開啟，允許通知權限，並保持此網站的通知權限啟用。</p>
<button id="enable">啟用瀏覽器通知</button>
<pre id="status" style="white-space:pre-wrap"></pre>
<script>
const statusEl=document.querySelector('#status');
function decodeKey(s){
  const p='='.repeat((4-s.length%4)%4);
  const b=atob(s.replace(/-/g,'+').replace(/_/g,'/')+p);
  return Uint8Array.from(b,c=>c.charCodeAt(0));
}
document.querySelector('#enable').onclick=async()=>{
  try{
    if(!('serviceWorker'in navigator)||!('PushManager'in window))
      throw Error('此瀏覽器不支援 Web Push');

    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw Error('通知權限未允許');

    const reg=await navigator.serviceWorker.register('/push-sw.js');
    const keyRes=await fetch('/api/push/vapid-public-key');
    const keyData=await keyRes.json();

    if(!keyRes.ok||!keyData.publicKey)
      throw Error(keyData.error||'無法取得 VAPID 公鑰');

    let sub=await reg.pushManager.getSubscription();

    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:decodeKey(keyData.publicKey)
      });
    }

    const res=await fetch('/api/push/subscribe',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(sub)
    });

    const data=await res.json();

    if(!res.ok||!data.ok)
      throw Error(data.error||'訂閱儲存失敗');

    statusEl.textContent='成功！此瀏覽器已訂閱推播通知。';
  }catch(e){
    statusEl.textContent='設定失敗：'+e.message;
  }
};
</script>
</body>
</html>`;
}

function serviceWorkerJs() {
  return `self.addEventListener('push',event=>{
let data={title:'加密貨幣定投提醒',body:'有新的掃描訊號',url:'/api/alerts'};
try{if(event.data)data={...data,...event.data.json()};}catch{}
event.waitUntil(self.registration.showNotification(data.title||'定投提醒',{
body:data.body||'',data:{url:data.url||'/api/alerts'}
}));
});
self.addEventListener('notificationclick',event=>{
event.notification.close();
const target=new URL(event.notification.data?.url||'/api/alerts',self.location.origin).href;
event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
for(const c of list){
if(c.url.startsWith(self.location.origin)&&'focus'in c)
return c.focus().then(()=>c.navigate(target));
}
return clients.openWindow(target);
}));
});`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: JSON_HEADERS
      });
    }

    try {
      if (path === "/push/setup" && method === "GET") {
        return new Response(setupHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      if (path === "/push-sw.js" && method === "GET") {
        return new Response(serviceWorkerJs(), {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-store"
          }
        });
      }

      if (path === "/api/health" && method === "GET") {
        if (!env.DB) throw new Error("D1 binding DB is missing");
        if (!env.PUSH_KV) throw new Error("KV binding PUSH_KV is missing");

        const result = await env.DB
          .prepare("SELECT COUNT(*) AS total FROM alerts")
          .first();

        const restriction = await env.PUSH_KV.get(BINANCE_RESTRICTION_KEY);

        return reply({
          ok: true,
          database: "connected",
          alertsTable: "accessible",
          alertCount: result.total,
          kv: "binding detected",
          cron: "*/5 * * * *",
          scanBatchSize: SCAN_BATCH_SIZE,
          binanceRestrictionCached: !!restriction,
          binanceRestriction: restriction || null,
          telegramConfigured: !!(
            env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ),
          webPushConfigured: !!(
            env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
          ),
          endpoints: [
            "/api/health",
            "/api/prices",
            "/api/recommendations",
            "/api/alerts",
            "/api/push/vapid-public-key",
            "/api/push/subscribe",
            "/api/admin/scan",
            "/api/admin/test-notifications",
            "/api/scan/status",
            "/push/setup"
          ]
        });
      }

      if (path === "/api/prices" && method === "GET") {
        let requested;

        try {
          requested = parseSymbols(
            url.searchParams.get("symbols"),
            "BTCUSDT,ETHUSDT,SOLUSDT",
            10
          );
        } catch (error) {
          return reply({ ok: false, error: error.message }, 400);
        }

        const binance = createBinanceClient(env);


        const prices = await Promise.all(
          requested.map(async symbol => {
            const item = await binance(
              `/api/v3/ticker/price?symbol=${symbol}`
            );

            return {
              symbol: item.symbol,
              price: Number(item.price)
            };
          })
        );

        return reply({
          ok: true,
          source: cachedProviderName(env),
          prices,
          fetchedAt: new Date().toISOString()
        });
      }

      if (path === "/api/recommendations" && method === "GET") {
        let requested;

        try {
          requested = parseSymbols(
            url.searchParams.get("symbols"),
            "BTCUSDT,ETHUSDT,SOLUSDT",
            5
          );
        } catch (error) {
          return reply({ ok: false, error: error.message }, 400);
        }

        const interval = url.searchParams.get("interval") || "1h";

        if (!ALLOWED_INTERVALS.has(interval)) {
          return reply({
            ok: false,
            error: "interval must be 15m, 1h, 4h or 1d"
          }, 400);
        }



        const binance = createBinanceClient(env);

        const results = await Promise.all(
          requested.map(async symbol => {
            try {
              return await analyze(symbol, interval, binance);
            } catch (error) {
              return {
                symbol,
                error: error.message || "Analysis failed"
              };
            }
          })
        );

        const successCount = results.filter(item => !item.error).length;
        const firstError = results.find(item => item.error)?.error || null;
        const isRestriction = firstError &&
          (firstError.includes("HTTP 451") ||
           firstError.includes("regional eligibility restriction"));

        return reply({
          ok: successCount > 0,
          ...(isRestriction ? {
            code: "BINANCE_REGIONAL_RESTRICTION",
            error: firstError
          } : {}),
          method: "strict EMA20/EMA50 trend + RSI14 + MACD momentum + volume confirmation",
          interval,
          results,
          disclaimer:
            "僅供資訊參考，不構成投資建議；技術指標不保證未來表現。"
        }, isRestriction && successCount === 0 ? 503 : 200);
      }

      if (path === "/api/alerts" && method === "GET") {
        if (!env.DB) throw new Error("D1 binding DB is missing");

        const rawLimit = Number(url.searchParams.get("limit") || 20);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
          : 20;

        const result = await env.DB.prepare(
          `SELECT id, symbol, timeframe, direction, title, summary,
                  triggered_at, fingerprint
           FROM alerts
           ORDER BY triggered_at DESC
           LIMIT ?`
        ).bind(limit).all();

        return reply({
          ok: true,
          alerts: result.results || []
        });
      }

      if (path === "/api/alerts" && method === "POST") {
        if (!requireAdmin(request, env)) {
          return reply({
            ok: false,
            error: "Unauthorized: configure ADMIN_TOKEN and send Authorization: Bearer <token>"
          }, env.ADMIN_TOKEN ? 401 : 503);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return reply({
            ok: false,
            error: "Request body must be valid JSON"
          }, 400);
        }

        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return reply({
            ok: false,
            error: "Request body must be a JSON object"
          }, 400);
        }

        const symbol = String(body.symbol || "").toUpperCase();
        const timeframe = String(body.timeframe || "1h");
        const direction = String(body.direction || "").toUpperCase();
        const title = String(body.title || "").trim();
        const summary = body.summary == null
          ? null
          : String(body.summary).slice(0, 2000);

        if (!validSymbol(symbol)) {
          return reply({ ok: false, error: "Unsupported symbol" }, 400);
        }

        if (!ALLOWED_INTERVALS.has(timeframe)) {
          return reply({ ok: false, error: "Invalid timeframe" }, 400);
        }

        if (!["BUY", "SELL", "WATCH", "CAUTION"].includes(direction)) {
          return reply({ ok: false, error: "Invalid direction" }, 400);
        }

        if (!title || title.length > 200) {
          return reply({
            ok: false,
            error: "Title is required (max 200 chars)"
          }, 400);
        }

        const id = crypto.randomUUID();
        const triggeredAt = new Date().toISOString();

        const digest = await crypto.subtle.digest(
          "SHA-256",
          enc.encode(`${symbol}|${timeframe}|${direction}|${title}`)
        );

        const fingerprint = bytesToB64url(new Uint8Array(digest));

        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO alerts
           (id, symbol, timeframe, direction, title, summary, triggered_at, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          symbol,
          timeframe,
          direction,
          title,
          summary,
          triggeredAt,
          fingerprint
        ).run();

        const changes = result.meta?.changes ?? 0;

        return reply({
          ok: true,
          created: changes > 0,
          duplicate: changes === 0,
          id: changes > 0 ? id : null
        }, changes > 0 ? 201 : 200);
      }

      if (path === "/api/push/vapid-public-key" && method === "GET") {
        if (!env.VAPID_PUBLIC_KEY) {
          return reply({
            ok: false,
            error: "VAPID_PUBLIC_KEY secret is not configured"
          }, 503);
        }

        return reply({
          ok: true,
          publicKey: env.VAPID_PUBLIC_KEY
        });
      }

      if (path === "/api/push/subscribe" && method === "POST") {
        if (!env.DB) throw new Error("D1 binding DB is missing");

        let body;

        try {
          body = await request.json();
        } catch {
          return reply({
            ok: false,
            error: "Request body must be valid JSON"
          }, 400);
        }

        const endpoint = String(body?.endpoint || "");
        const p256dh = String(body?.keys?.p256dh || "");
        const auth = String(body?.keys?.auth || "");

        if (endpoint.length > 2000 || !endpointAllowed(endpoint)) {
          return reply({
            ok: false,
            error: "Unsupported or invalid push endpoint"
          }, 400);
        }

        try {
          if (b64urlToBytes(p256dh).length !== 65 ||
              b64urlToBytes(auth).length < 16) {
            throw new Error();
          }
        } catch {
          return reply({
            ok: false,
            error: "Invalid push subscription keys"
          }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO push_subscriptions
           (endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh=excluded.p256dh,
             auth=excluded.auth,
             created_at=excluded.created_at`
        ).bind(
          endpoint,
          p256dh,
          auth,
          new Date().toISOString()
        ).run();

        return reply({ ok: true, subscribed: true }, 201);
      }

      if (path === "/api/push/subscribe" && method === "DELETE") {
        if (!env.DB) throw new Error("D1 binding DB is missing");

        let body;

        try {
          body = await request.json();
        } catch {
          return reply({
            ok: false,
            error: "Request body must be valid JSON"
          }, 400);
        }

        const endpoint = String(body?.endpoint || "");

        if (!endpointAllowed(endpoint)) {
          return reply({
            ok: false,
            error: "Unsupported or invalid push endpoint"
          }, 400);
        }

        await env.DB
          .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .bind(endpoint)
          .run();

        return reply({ ok: true, unsubscribed: true });
      }

      if (path === "/api/admin/scan" && method === "POST") {
        if (!requireAdmin(request, env)) {
          return reply({
            ok: false,
            error: "Unauthorized"
          }, env.ADMIN_TOKEN ? 401 : 503);
        }

        return reply(await scanAll(env));
      }

      if (path === "/api/admin/test-notifications" && method === "POST") {
        if (!requireAdmin(request, env)) {
          return reply({
            ok: false,
            error: "Unauthorized"
          }, env.ADMIN_TOKEN ? 401 : 503);
        }

        const payload = {
          title: "定投通知測試",
          body: "Cloudflare Worker 通知測試成功；這不是交易訊號。",
          url: "/api/alerts"
        };

        const channels = [
          {
            channel: "webPush",
            promise: Promise.resolve().then(
              () => sendBrowserPush(payload, env)
            )
          }
        ];

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          channels.push({
            channel: "telegram",
            promise: Promise.resolve().then(
              () => sendTelegram(
                "🔔 定投通知測試\nCloudflare Worker 通知測試成功；這不是交易訊號。",
                env
              )
            )
          });
        }

        const results = await Promise.allSettled(
          channels.map(item => item.promise)
        );

        return reply({
          ok: true,
          results: results.map((result, index) => ({
            channel: channels[index].channel,
            status: result.status,
            result: result.status === "fulfilled"
              ? result.value
              : { error: result.reason?.message || "failed" }
          }))
        });
      }

      if (path === "/api/scan/status" && method === "GET") {
        if (!env.PUSH_KV) throw new Error("KV binding PUSH_KV is missing");

        const value = await env.PUSH_KV.get("last_scan_summary");
        const restriction = await env.PUSH_KV.get(BINANCE_RESTRICTION_KEY);

        return reply({
          ok: true,
          binanceRestricted: !!restriction,
          binanceRestriction: restriction || null,
          lastScan: value ? JSON.parse(value) : null
        });
      }

      // 管理員明確確認後，才能清除暫存的 Binance 451 限制。
      if (path === "/api/admin/binance-restriction/reset" && method === "POST") {
        if (!requireAdmin(request, env)) {
          return reply({
            ok: false,
            error: "Unauthorized"
          }, env.ADMIN_TOKEN ? 401 : 503);
        }

        await env.PUSH_KV.delete(BINANCE_RESTRICTION_KEY);

        return reply({
          ok: true,
          cleared: true,
          message: "Binance restriction cache cleared. The next request will test Binance again."
        });
      }

      return reply({
        ok: false,
        error: "Not found"
      }, 404);
    } catch (error) {
      console.error("Request failed:", error.message || error);

      return reply({
        ok: false,
        error: error.message || "Internal server error"
      }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      scanAll(env).catch(error => {
        console.error(
          "Scheduled scan failed:",
          error.message || error
        );
      })
    );
  }
};
