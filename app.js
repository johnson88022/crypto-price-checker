const LIVE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "PEPEUSDT", "ADAUSDT", "SUIUSDT"];

/** Binance USDT 現貨市值前十；執行時會優先依 CoinGecko 市值排名過濾 Binance 上架交易對，失敗時使用此備援清單。 */
let TOP10_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "TRXUSDT", "AVAXUSDT", "LINKUSDT"
];

const TOP_MOVER_COUNT = 15;
const MOVER_SCAN_POOL = 150;
const FETCH_CHUNK_SIZE = 10;

const KLINE_INTERVAL_MS = {
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
};

function symbolLabel(symbol) {
    return symbol.replace(/USDT$/, "");
}

function formatPrice(symbol, price) {
    price = parseFloat(price);
    if (Number.isNaN(price)) return "—";
    if (symbol === "PEPEUSDT") return price.toFixed(8);
    if (["ADAUSDT", "SUIUSDT", "XRPUSDT", "TRXUSDT", "DOGEUSDT"].includes(symbol)) {
        return price.toFixed(4);
    }
    return price.toFixed(2);
}

function formatPct(pct) {
    if (pct == null || Number.isNaN(pct)) return "—";
    const n = Number(pct);
    return n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
}

function normalizeBinanceSymbol(input) {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return "";
    if (s.endsWith("USDT")) return s;
    return `${s}USDT`;
}

function parseCustomSymbols(raw) {
    if (!raw || !raw.trim()) return [];
    const seen = new Set();
    const out = [];
    for (const part of raw.split(/[,，、\s\n]+/)) {
        const symbol = normalizeBinanceSymbol(part);
        if (symbol && !seen.has(symbol)) {
            seen.add(symbol);
            out.push(symbol);
        }
    }
    return out;
}

async function mapInChunks(items, chunkSize, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

function isLikelySpotUsdtPair(symbol) {
    if (!symbol.endsWith("USDT")) return false;
    if (symbol.includes("_")) return false;
    if (/(UP|DOWN|BEAR|BULL)USDT$/.test(symbol)) return false;
    return symbol.length >= 5 && symbol.length <= 16;
}

async function fetchAllBinancePrices() {
    const response = await fetch("https://api.binance.com/api/v3/ticker/price");
    const data = await response.json();
    if (!response.ok) throw new Error("無法取得 Binance 現價列表");
    const map = new Map();
    for (const item of data) {
        map.set(item.symbol, parseFloat(item.price));
    }
    return map;
}

async function fetchHighVolumeUsdtSymbols(limit) {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    const data = await response.json();
    if (!response.ok) throw new Error("無法取得 24h 行情");
    return data
        .filter((t) => isLikelySpotUsdtPair(t.symbol))
        .filter((t) => parseFloat(t.quoteVolume) > 500_000)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map((t) => t.symbol);
}

function alignKlineOpenTime(timestampMs, interval) {
    const step = KLINE_INTERVAL_MS[interval];
    if (!step) return timestampMs;
    return Math.floor(timestampMs / step) * step;
}

function formatKlineTime(timestampMs) {
    return new Date(timestampMs).toLocaleString("zh-TW", { hour12: false });
}

async function getBinancePrice(symbol) {
    try {
        const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        const data = await response.json();
        if (!response.ok || data?.code) throw new Error(data?.msg || "Binance API error");
        return formatPrice(symbol, data.price);
    } catch (error) {
        console.error(`無法從 Binance 獲取 ${symbol} 的價格`, error);
        return "—";
    }
}

async function getOkxPrice(symbol) {
    try {
        const okxSymbol = symbol.replace("USDT", "-USDT");
        const response = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${okxSymbol}`);
        const data = await response.json();
        if (!response.ok || data?.code && data.code !== "0") throw new Error(data?.msg || "OKX API error");
        if (!data?.data?.length) throw new Error("無效的數據格式");
        return formatPrice(symbol, data.data[0].last);
    } catch (error) {
        console.error(`無法從 OKX 獲取 ${symbol} 的價格`, error);
        return "—";
    }
}

function renderLivePriceTable() {
    const tbody = document.getElementById("live-price-body");
    tbody.innerHTML = LIVE_SYMBOLS.map(
        (symbol) => `
        <tr>
            <td class="sym">${symbolLabel(symbol)}</td>
            <td id="${symbol.toLowerCase()}-binance">…</td>
        </tr>`
    ).join("");
}

async function updatePrices() {
    let failed = 0;
    await Promise.all(
        LIVE_SYMBOLS.map(async (symbol) => {
            const b = document.getElementById(`${symbol.toLowerCase()}-binance`);
            if (!b) return;
            const binance = await getBinancePrice(symbol);
            b.textContent = binance;
            if (binance === "—") failed += 1;
        })
    );
    return failed;
}

async function getFearGreedIndex() {
    // 恢復原本的 Alternative.me Fear & Greed Index 資料來源。
    try {
        const response = await fetch("https://api.alternative.me/fng/?limit=1&format=json", {
            headers: { "Accept": "application/json" },
            cache: "no-store"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const value = Number(payload?.data?.[0]?.value);
        return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
    } catch (error) {
        console.warn("無法取得恐慌與貪婪指數：", error);
        return null;
    }
}

function setThemeFromFearGreed(index) {
    const root = document.documentElement;
    let tone = "neutral";
    if (index <= 25) tone = "fear";
    else if (index <= 45) tone = "caution";
    else if (index <= 55) tone = "neutral";
    else if (index <= 75) tone = "greed";
    else tone = "extreme-greed";
    root.dataset.fearGreed = tone;
}

async function updateUI() {
    const fearGreedIndex = await getFearGreedIndex();
    const el = document.getElementById("fear-greed-index");
    if (fearGreedIndex !== null) {
        el.textContent = fearGreedIndex;
        setThemeFromFearGreed(fearGreedIndex);
    } else {
        el.textContent = "—";
        setThemeFromFearGreed(50);
    }
}

async function fetchKlineAtTime(symbol, interval, userTimeMs) {
    const openTime = alignKlineOpenTime(userTimeMs, interval);
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(openTime));
    url.searchParams.set("limit", "1");

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data?.msg || "無法取得 K 線");
    }
    if (!Array.isArray(data) || !data.length || Number(data[0][0]) !== openTime) {
        throw new Error("找不到該時間的 K 棒");
    }

    const candle = data[0];
    return {
        openTime: Number(candle[0]),
        closeTime: Number(candle[6]),
        close: parseFloat(candle[4]),
    };
}

async function fetchChangeRowCached(symbol, interval, userTimeMs, priceMap) {
    try {
        const currentPrice = priceMap.get(symbol);
        if (currentPrice == null || Number.isNaN(currentPrice)) {
            throw new Error("無此 USDT 交易對");
        }
        const kline = await fetchKlineAtTime(symbol, interval, userTimeMs);
        const basePrice = kline.close;
        const pct = ((currentPrice - basePrice) / basePrice) * 100;
        return {
            symbol,
            basePrice,
            currentPrice,
            pct,
            openTime: kline.openTime,
            closeTime: kline.closeTime,
            error: null,
        };
    } catch (error) {
        return { symbol, error: error.message || "失敗" };
    }
}

function addSymbolTag(tagMap, symbol, tag) {
    if (!tagMap.has(symbol)) tagMap.set(symbol, new Set());
    tagMap.get(symbol).add(tag);
}

function renderTagBadges(tags) {
    if (!tags || !tags.size) return "—";
    const order = ["市值前10", "漲幅", "跌幅", "自訂"];
    const labels = { "市值前10": "tag-cap", 漲幅: "tag-up", 跌幅: "tag-down", 自訂: "tag-custom" };
    return [...tags]
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map((tag) => `<span class="tag ${labels[tag] || ""}">${tag}</span>`)
        .join("");
}

function renderCompareTable(rows, highlightSymbols, tagMap) {
    const table = document.getElementById("kline-compare-table");
    const tbody = document.getElementById("kline-compare-body");
    const highlightSet = new Set(highlightSymbols || []);

    const valid = rows.filter((r) => r.error == null);
    valid.sort((a, b) => b.pct - a.pct);

    const errors = rows.filter((r) => r.error != null);

    let html = valid
        .map((row, i) => {
            const up = row.pct >= 0;
            const hl = highlightSet.has(row.symbol) ? " row-highlight" : "";
            const tags = tagMap.get(row.symbol);
            return `
            <tr class="${hl}">
                <td>${i + 1}</td>
                <td class="sym">${symbolLabel(row.symbol)}</td>
                <td class="tags-cell">${renderTagBadges(tags)}</td>
                <td>${formatPrice(row.symbol, row.basePrice)}</td>
                <td>${formatPrice(row.symbol, row.currentPrice)}</td>
                <td class="${up ? "pct-up" : "pct-down"}">${formatPct(row.pct)}</td>
            </tr>`;
        })
        .join("");

    if (errors.length) {
        html += errors
            .map((row) => {
                const tags = tagMap.get(row.symbol);
                return `
            <tr class="row-error${highlightSet.has(row.symbol) ? " row-highlight" : ""}">
                <td>—</td>
                <td class="sym">${symbolLabel(row.symbol)}</td>
                <td class="tags-cell">${renderTagBadges(tags)}</td>
                <td colspan="3">${row.error}</td>
            </tr>`;
            })
            .join("");
    }

    tbody.innerHTML = html;
    table.hidden = false;
}

async function resolveTopMoverSymbols(interval, userTimeMs, priceMap, excludeSymbols) {
    const exclude = new Set(excludeSymbols);
    const pool = (await fetchHighVolumeUsdtSymbols(MOVER_SCAN_POOL)).filter((s) => !exclude.has(s));
    const scanned = await mapInChunks(pool, FETCH_CHUNK_SIZE, (symbol) =>
        fetchChangeRowCached(symbol, interval, userTimeMs, priceMap)
    );
    const cache = new Map();
    for (const row of scanned) {
        cache.set(row.symbol, row);
    }
    const valid = scanned.filter((r) => r.error == null);
    const gainerSymbols = [...valid]
        .filter((r) => r.pct > 0)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, TOP_MOVER_COUNT)
        .map((r) => r.symbol);
    const loserSymbols = [...valid]
        .filter((r) => r.pct < 0)
        .sort((a, b) => a.pct - b.pct)
        .slice(0, TOP_MOVER_COUNT)
        .map((r) => r.symbol);
    return { gainerSymbols, loserSymbols, cache };
}

function getKlineUserTimeMs() {
    const dateValue = document.getElementById("kline-date").value;
    const timeValue = document.getElementById("kline-time").value;
    if (!dateValue || !timeValue) return null;
    const userTimeMs = new Date(`${dateValue}T${timeValue}`).getTime();
    return Number.isNaN(userTimeMs) ? null : userTimeMs;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function initKlineDateTimePickers() {
    const dateInput = document.getElementById("kline-date");
    const timeInput = document.getElementById("kline-time");
    const now = new Date();
    dateInput.value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    timeInput.value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

async function resolveBinanceTop10ByMarketCap() {
    try {
        const [exchangeResponse, marketResponse] = await Promise.all([
            fetch("https://api.binance.com/api/v3/exchangeInfo"),
            fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false")
        ]);
        if (!exchangeResponse.ok || !marketResponse.ok) throw new Error("市值來源暫時無法取得");
        const exchange = await exchangeResponse.json();
        const markets = await marketResponse.json();
        const listed = new Set((exchange.symbols || [])
            .filter(x => x.status === "TRADING" && x.isSpotTradingAllowed !== false && x.quoteAsset === "USDT")
            .map(x => x.baseAsset.toUpperCase()));
        const matched = markets
            .filter(c => c.symbol && listed.has(c.symbol.toUpperCase()) && Number.isFinite(Number(c.market_cap)))
            .sort((a, b) => Number(b.market_cap) - Number(a.market_cap))
            .slice(0, 10)
            .map(c => `${c.symbol.toUpperCase()}USDT`);
        if (matched.length >= 8) TOP10_SYMBOLS = matched;
    } catch (error) {
        console.warn("無法更新市值前十，使用備援清單：", error);
    }
    return TOP10_SYMBOLS;
}

async function queryKlineChangeToNow() {
    const metaEl = document.getElementById("kline-meta");
    const interval = document.getElementById("kline-interval").value;
    const customRaw = document.getElementById("kline-symbol").value;

    const userTimeMs = getKlineUserTimeMs();
    if (userTimeMs == null) {
        metaEl.textContent = "請用日曆選日期、時鐘選時間";
        metaEl.classList.add("error-text");
        return;
    }

    const customSymbols = parseCustomSymbols(customRaw);
    metaEl.classList.remove("error-text");
    metaEl.textContent = "查詢中…（Binance 上架幣種市值前 10＋漲幅 15＋跌幅 15＋自訂）";
    document.getElementById("kline-compare-table").hidden = true;

    try {
        await resolveBinanceTop10ByMarketCap();
        populateDcaSymbolOptions();
        const priceMap = await fetchAllBinancePrices();
        const seedSymbols = [...new Set([...TOP10_SYMBOLS, ...customSymbols])];

        metaEl.textContent = "掃描漲幅／跌幅榜中…";
        const { gainerSymbols, loserSymbols, cache: moverCache } = await resolveTopMoverSymbols(
            interval,
            userTimeMs,
            priceMap,
            seedSymbols
        );

        const tagMap = new Map();
        TOP10_SYMBOLS.forEach((s) => addSymbolTag(tagMap, s, "市值前10"));
        customSymbols.forEach((s) => addSymbolTag(tagMap, s, "自訂"));
        gainerSymbols.forEach((s) => addSymbolTag(tagMap, s, "漲幅"));
        loserSymbols.forEach((s) => addSymbolTag(tagMap, s, "跌幅"));

        const allSymbols = [
            ...new Set([...TOP10_SYMBOLS, ...customSymbols, ...gainerSymbols, ...loserSymbols]),
        ];
        const rowCache = new Map(moverCache);

        const rows = await mapInChunks(allSymbols, FETCH_CHUNK_SIZE, async (symbol) => {
            if (rowCache.has(symbol)) return rowCache.get(symbol);
            const row = await fetchChangeRowCached(symbol, interval, userTimeMs, priceMap);
            rowCache.set(symbol, row);
            return row;
        });

        const sample = rows.find((r) => r.openTime != null);
        if (sample) {
            const customLabel = customSymbols.length
                ? customSymbols.map(symbolLabel).join(", ")
                : null;
            metaEl.innerHTML = `
                <span class="meta-strong">${interval} K</span>
                · ${formatKlineTime(sample.openTime)} ～ ${formatKlineTime(sample.closeTime)}
                · 基準：該 K 收盤 → 現價
                · 共 ${allSymbols.length} 檔（市值前 10＋漲 ${gainerSymbols.length}＋跌 ${loserSymbols.length}${customSymbols.length ? `＋自訂 ${customSymbols.length}` : ""}）
                ${customLabel ? ` · 高亮：<span class="meta-strong">${customLabel}</span>` : ""}
            `;
        } else {
            metaEl.textContent = "無法取得 K 棒資料，請確認時間或網路";
        }

        renderCompareTable(rows, customSymbols, tagMap);
    } catch (error) {
        console.error("K 棒查詢失敗：", error);
        metaEl.textContent = error.message || "查詢失敗";
        metaEl.classList.add("error-text");
    }
}

const refreshButton = document.getElementById("refresh-btn");
const statusText = document.getElementById("app-status-text");
const loadingIndicator = document.getElementById("loading-indicator");
const lastUpdatedEl = document.getElementById("last-updated");

function setAppStatus(message, isError = false, loading = false) {
    statusText.textContent = message;
    statusText.classList.toggle("error-text", isError);
    loadingIndicator.hidden = !loading;
}

function formatUpdatedTime() {
    return new Date().toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

async function refreshWebApp() {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-refreshing");
    setAppStatus("更新市場資料中…", false, true);

    try {
        const [, failed] = await Promise.all([updateUI(), updatePrices()]);
        lastUpdatedEl.textContent = `更新於 ${formatUpdatedTime()}`;
        if (failed > 0) {
            setAppStatus(`已更新，但有 ${failed} 個行情無法取得`, true);
        } else {
            setAppStatus("市場資料已更新");
        }
    } catch (error) {
        console.error("更新市場資料失敗：", error);
        setAppStatus("部分市場資料更新失敗，請稍後重試", true);
    } finally {
        refreshButton.disabled = false;
        refreshButton.classList.remove("is-refreshing");
    }
}

document.getElementById("kline-btn").addEventListener("click", queryKlineChangeToNow);
refreshButton.addEventListener("click", refreshWebApp);

initKlineDateTimePickers();
renderLivePriceTable();
resolveBinanceTop10ByMarketCap().then(populateDcaSymbolOptions);
refreshWebApp();

setInterval(() => {
    if (!document.hidden) refreshWebApp();
}, 5000);

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js", { scope: "./" })
            .then(() => console.info("PWA Service Worker registered"))
            .catch((error) => console.error("Service Worker registration failed:", error));
    });
}

// ==================== DCA Return Calculator ====================
function normalizeDcaSymbol(input) {
    const symbol = normalizeBinanceSymbol(input || "");
    return symbol;
}

function toUtcDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateInput(value) {
    if (!value) return null;
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
}

function dateAtUtcStart(date) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonthsClamped(date, months) {
    const originalDay = date.getDate();
    const result = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(originalDay, lastDay));
    return result;
}

function buildDcaSchedule(startDate, endDate, frequency) {
    const dates = [];
    if (frequency === "monthly") {
        const anchorDay = startDate.getDate();
        let monthOffset = 0;
        while (true) {
            const candidate = addMonthsClamped(new Date(startDate.getFullYear(), startDate.getMonth(), 1), monthOffset);
            const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
            candidate.setDate(Math.min(anchorDay, lastDay));
            if (candidate > endDate) break;
            dates.push(candidate);
            monthOffset += 1;
        }
        return dates;
    }

    let current = new Date(startDate.getTime());
    while (current <= endDate) {
        dates.push(new Date(current.getTime()));
        current.setDate(current.getDate() + (frequency === "weekly" ? 7 : 1));
    }
    return dates;
}

async function fetchBinanceCurrentPriceRaw(symbol) {
    const url = new URL("https://api.binance.com/api/v3/ticker/price");
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data?.code || !data?.price) {
        throw new Error(data?.msg || `無法取得 ${symbolLabel(symbol)} 現價`);
    }
    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`無法取得 ${symbolLabel(symbol)} 現價`);
    return price;
}

async function fetchBinanceDailyCloses(symbol, startMs, endMs) {
    const prices = new Map();
    let cursor = startMs;
    const maxIterations = 20;

    for (let i = 0; i < maxIterations && cursor <= endMs; i += 1) {
        const url = new URL("https://api.binance.com/api/v3/klines");
        url.searchParams.set("symbol", symbol);
        url.searchParams.set("interval", "1d");
        url.searchParams.set("startTime", String(cursor));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", "1000");

        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok || data?.code) {
            throw new Error(data?.msg || `無法取得 ${symbolLabel(symbol)} 歷史價格`);
        }
        if (!Array.isArray(data) || data.length === 0) break;

        for (const candle of data) {
            const openTime = Number(candle[0]);
            prices.set(new Date(openTime).toISOString().slice(0, 10), Number(candle[4]));
        }

        const lastOpenTime = Number(data[data.length - 1][0]);
        const nextCursor = lastOpenTime + 24 * 60 * 60 * 1000;
        if (nextCursor <= cursor) break;
        cursor = nextCursor;
        if (data.length < 1000) break;
    }

    return prices;
}

async function fetchBinanceDcaCandles(symbol, interval, startMs, endMs) {
    const candles = [];
    let cursor = startMs;
    for (let i = 0; i < 20 && cursor <= endMs; i += 1) {
        const url = new URL("https://api.binance.com/api/v3/klines");
        url.searchParams.set("symbol", symbol);
        url.searchParams.set("interval", interval);
        url.searchParams.set("startTime", String(cursor));
        url.searchParams.set("endTime", String(endMs));
        url.searchParams.set("limit", "1000");
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok || data?.code) throw new Error(data?.msg || "無法取得高低點歷史 K 棒");
        if (!Array.isArray(data) || !data.length) break;
        for (const c of data) candles.push({ openTime: Number(c[0]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) });
        const next = Number(data[data.length - 1][0]) + (interval === "1d" ? 86400000 : interval === "1w" ? 604800000 : 2678400000);
        if (next <= cursor || data.length < 1000) break;
        cursor = next;
    }
    return candles;
}

function candleForDate(candles, date) {
    const ms = dateAtUtcStart(date);
    for (let i = 0; i < candles.length; i += 1) {
        const nextOpen = candles[i + 1]?.openTime ?? Number.POSITIVE_INFINITY;
        if (candles[i].openTime <= ms && ms < nextOpen) return candles[i];
    }
    return null;
}

function getDcaRecommendation(priceVsAveragePct) {
    // 以「現價相對自身 DCA 平均成本」作為分級：價格越低於平均成本，
    // 對下一筆定投而言通常越有利；價格高於平均成本則降低追價意願。
    if (priceVsAveragePct <= -20) {
        return { label: "非常推薦", className: "recommendation-very-good", hint: "現價明顯低於平均成本，屬於相對便宜區。若仍符合你的風險與資金規劃，可優先考慮定投。" };
    }
    if (priceVsAveragePct <= -5) {
        return { label: "推薦", className: "recommendation-good", hint: "現價低於平均成本，屬於相對有利的定投價格區。" };
    }
    if (priceVsAveragePct <= 5) {
        return { label: "普通", className: "recommendation-neutral", hint: "現價接近平均成本，價格沒有明顯優勢，適合依原定投計畫執行。" };
    }
    if (priceVsAveragePct <= 20) {
        return { label: "不推薦", className: "recommendation-bad", hint: "現價高於平均成本，若是新增定投可考慮照原計畫、小額執行，避免因上漲而追價。" };
    }
    return { label: "非常不推薦", className: "recommendation-very-bad", hint: "現價明顯高於平均成本，屬於相對昂貴區；若只是評估下一筆定投，不宜因短期上漲而追價。" };
}

async function calculateDcaReturn() {
    const button = document.getElementById("dca-btn");
    const status = document.getElementById("dca-status");
    const result = document.getElementById("dca-result");
    const untilNow = document.getElementById("dca-until-now").checked;
    const selectedSymbol = document.getElementById("dca-symbol-select").value;
    const customSymbolInput = document.getElementById("dca-symbol-custom");
    const symbol = normalizeDcaSymbol(selectedSymbol === "CUSTOM" ? customSymbolInput.value : selectedSymbol);
    const startDate = parseDateInput(document.getElementById("dca-start").value);
    const frequency = document.getElementById("dca-frequency").value;
    const amount = Number(document.getElementById("dca-amount").value);

    status.classList.remove("error-text");
    result.hidden = true;

    if (!symbol) {
        status.textContent = "請輸入幣種，例如 BTC、ETH、SOL";
        status.classList.add("error-text");
        return;
    }
    if (!startDate) {
        status.textContent = "請選擇開始時間";
        status.classList.add("error-text");
        return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        status.textContent = "請輸入大於 0 的每次定投金額";
        status.classList.add("error-text");
        return;
    }

    const today = new Date();
    const endInput = document.getElementById("dca-end").value;
    const selectedEnd = parseDateInput(endInput);
    const endDate = untilNow ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : selectedEnd;

    if (!endDate) {
        status.textContent = "請選擇結束時間，或勾選「至今」";
        status.classList.add("error-text");
        return;
    }
    if (endDate < startDate) {
        status.textContent = "結束時間不能早於開始時間";
        status.classList.add("error-text");
        return;
    }
    if (startDate > today) {
        status.textContent = "開始時間不能晚於今天";
        status.classList.add("error-text");
        return;
    }

    const effectiveEnd = endDate > today ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : endDate;
    const schedule = buildDcaSchedule(startDate, effectiveEnd, frequency);
    if (!schedule.length) {
        status.textContent = "這個期間沒有可執行的定投日期";
        status.classList.add("error-text");
        return;
    }

    button.disabled = true;
    button.classList.add("is-refreshing");
    status.textContent = `正在取得 ${symbolLabel(symbol)} 歷史價格…`;

    try {
        const startMs = dateAtUtcStart(startDate);
        const endMs = dateAtUtcStart(effectiveEnd) + 24 * 60 * 60 * 1000 - 1;
        const candleInterval = frequency === "monthly" ? "1M" : frequency === "weekly" ? "1w" : "1d";
        const [dailyPrices, scenarioCandles, currentPriceText] = await Promise.all([
            fetchBinanceDailyCloses(symbol, startMs, endMs),
            fetchBinanceDcaCandles(symbol, candleInterval, Math.max(0, startMs - (frequency === "monthly" ? 35 : frequency === "weekly" ? 8 : 0) * 86400000), endMs),
            fetchBinanceCurrentPriceRaw(symbol),
        ]);
        const currentPrice = Number(currentPriceText);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            throw new Error(`無法取得 ${symbolLabel(symbol)} 目前價格`);
        }

        const purchases = [];
        let totalInvested = 0;
        let totalUnits = 0;
        let skipped = 0;
        let bestUnits = 0;
        let worstUnits = 0;
        let scenarioSkipped = 0;

        for (const date of schedule) {
            const key = toUtcDateKey(date);
            const isToday = key === toUtcDateKey(today);
            const price = isToday ? currentPrice : dailyPrices.get(key);
            if (!Number.isFinite(price) || price <= 0) {
                skipped += 1;
                continue;
            }
            const units = amount / price;
            totalInvested += amount;
            totalUnits += units;
            const candle = candleForDate(scenarioCandles, date);
            if (candle && candle.high > 0 && candle.low > 0) {
                // 最佳情境：每次都買在該週／月／日最低點；最差情境：每次都買在最高點。
                bestUnits += amount / candle.low;
                worstUnits += amount / candle.high;
            } else {
                scenarioSkipped += 1;
                bestUnits += units;
                worstUnits += units;
            }
            purchases.push({ date: key, price, units });
        }

        if (!purchases.length || totalInvested <= 0) {
            throw new Error(`找不到 ${symbolLabel(symbol)} 在指定期間的歷史價格，請確認幣種與日期`);
        }

        const finalValue = totalUnits * currentPrice;
        const profit = finalValue - totalInvested;
        const roi = (profit / totalInvested) * 100;

        const averageBuyPrice = totalInvested / totalUnits;
        const priceVsAveragePct = ((currentPrice - averageBuyPrice) / averageBuyPrice) * 100;
        // 額外價格突破警示：獨立於「非常推薦／非常不推薦」分級。
        const purchasePrices = purchases
            .map((purchase) => Number(purchase.price))
            .filter((price) => Number.isFinite(price) && price > 0);
        const historicalLowestPrice = purchasePrices.length ? Math.min(...purchasePrices) : null;
        const historicalHighestPrice = purchasePrices.length ? Math.max(...purchasePrices) : null;
        let priceWarning = "";
        if (historicalLowestPrice !== null && currentPrice < historicalLowestPrice) {
            priceWarning = `⚠️ 現價已跌破過去最低買入價 ${formatPrice(symbol, historicalLowestPrice)}`;
        } else if (historicalHighestPrice !== null && currentPrice > historicalHighestPrice) {
            priceWarning = `⚠️ 現價已突破過去最高買入價 ${formatPrice(symbol, historicalHighestPrice)}`;
        }
        const recommendation = getDcaRecommendation(priceVsAveragePct);
        document.getElementById("dca-invested").textContent = `${totalInvested.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
        document.getElementById("dca-final-value").textContent = `${finalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
        document.getElementById("dca-average-price").textContent = `${formatPrice(symbol, averageBuyPrice)} USDT`;
        document.getElementById("dca-current-price").textContent = `${formatPrice(symbol, currentPrice)} USDT`;
        document.getElementById("dca-total-units").textContent = totalUnits.toLocaleString("en-US", { maximumFractionDigits: 12 });
        const bestValue = bestUnits * currentPrice;
        const worstValue = worstUnits * currentPrice;
        const bestRoi = ((bestValue - totalInvested) / totalInvested) * 100;
        const worstRoi = ((worstValue - totalInvested) / totalInvested) * 100;
        document.getElementById("dca-best-roi").textContent = `${bestRoi >= 0 ? "+" : ""}${bestRoi.toFixed(2)}%`;
        document.getElementById("dca-worst-roi").textContent = `${worstRoi >= 0 ? "+" : ""}${worstRoi.toFixed(2)}%`;
        document.getElementById("dca-best-value").textContent = `${bestValue.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})} USDT`;
        document.getElementById("dca-worst-value").textContent = `${worstValue.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})} USDT`;
        document.getElementById("dca-best-average-price").textContent = `${formatPrice(symbol, totalInvested / bestUnits)} USDT`;
        document.getElementById("dca-worst-average-price").textContent = `${formatPrice(symbol, totalInvested / worstUnits)} USDT`;

        const recommendationEl = document.getElementById("dca-recommendation");
        const recommendationDetailEl = document.getElementById("dca-recommendation-detail");
        recommendationEl.textContent = recommendation.label;
        recommendationEl.className = `recommendation-badge ${recommendation.className}`;
        const relationText = priceVsAveragePct === 0
            ? "與平均買入價相同"
            : `現價 ${priceVsAveragePct >= 0 ? "+" : ""}${priceVsAveragePct.toFixed(2)}% ${priceVsAveragePct >= 0 ? "高於" : "低於"}平均買入價`;
        recommendationDetailEl.textContent = `${relationText} · ${recommendation.hint}`;
        const priceWarningEl = document.getElementById("dca-price-warning");
        if (priceWarningEl) {
            priceWarningEl.textContent = priceWarning || "—";
            priceWarningEl.className = priceWarning ? "dca-price-warning active" : "dca-price-warning";
        }
        const profitEl = document.getElementById("dca-profit");
        const roiEl = document.getElementById("dca-roi");
        profitEl.textContent = `${profit >= 0 ? "+" : ""}${profit.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
        roiEl.textContent = `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`;
        profitEl.classList.toggle("pct-up", profit >= 0);
        profitEl.classList.toggle("pct-down", profit < 0);
        roiEl.classList.toggle("pct-up", roi >= 0);
        roiEl.classList.toggle("pct-down", roi < 0);

        const frequencyLabel = { daily: "每天", weekly: "每週", monthly: "每月" }[frequency];
        const endLabel = untilNow ? "至今" : effectiveEnd.toLocaleDateString("zh-TW");
        document.getElementById("dca-summary").textContent =
            `${symbolLabel(symbol)} · ${startDate.toLocaleDateString("zh-TW")} ～ ${endLabel} · ${frequencyLabel} · 每次 ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT · 實際買入 ${purchases.length} 次 · 目前價格 ${formatPrice(symbol, currentPrice)}${skipped ? ` · ${skipped} 次因歷史資料不可用而略過` : ""}${scenarioSkipped ? ` · ${scenarioSkipped} 次情境高低點資料不可用，改以實際定投價估算` : ""}`;

        document.getElementById("dca-purchase-count").textContent = `${purchases.length} 次`;
        document.getElementById("dca-purchase-body").innerHTML = purchases.map((purchase, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${purchase.date}${purchase.date === toUtcDateKey(today) ? "（至今）" : ""}</td>
                <td>${formatPrice(symbol, purchase.price)} USDT</td>
                <td>${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</td>
                <td>${purchase.units.toLocaleString("en-US", { maximumFractionDigits: 12 })}</td>
            </tr>
        `).join("");

        result.hidden = false;
        status.textContent = `計算完成：共 ${purchases.length} 次定投`;
    } catch (error) {
        console.error("定投報酬計算失敗：", error);
        status.textContent = error.message || "定投報酬計算失敗，請稍後重試";
        status.classList.add("error-text");
    } finally {
        button.disabled = false;
        button.classList.remove("is-refreshing");
    }
}

function populateDcaSymbolOptions() {
    const select = document.getElementById("dca-symbol-select");
    const previous = select.value || "BTCUSDT";
    select.innerHTML = TOP10_SYMBOLS.map(symbol => `<option value="${symbol}">${symbolLabel(symbol)} / USDT</option>`).join("")
        + '<option value="CUSTOM">自訂幣種…</option>';
    select.value = TOP10_SYMBOLS.includes(previous) ? previous : "BTCUSDT";
    if (!TOP10_SYMBOLS.includes(select.value)) select.selectedIndex = 0;
}

function initDcaInputs() {
    const start = document.getElementById("dca-start");
    const end = document.getElementById("dca-end");
    const untilNow = document.getElementById("dca-until-now");
    const today = new Date();
    const todayKey = toUtcDateKey(today);
    start.value = todayKey;
    end.value = todayKey;
    start.max = todayKey;
    end.max = todayKey;

    untilNow.addEventListener("change", () => {
        end.disabled = untilNow.checked;
    });
    const symbolSelect = document.getElementById("dca-symbol-select");
    const customSymbol = document.getElementById("dca-symbol-custom");
    symbolSelect.addEventListener("change", () => {
        customSymbol.hidden = symbolSelect.value !== "CUSTOM";
        if (symbolSelect.value === "CUSTOM") customSymbol.focus();
    });
    end.disabled = true;
    populateDcaSymbolOptions();
}

document.getElementById("dca-btn").addEventListener("click", calculateDcaReturn);
initDcaInputs();
