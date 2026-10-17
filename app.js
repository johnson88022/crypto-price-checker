let LIVE_SYMBOLS = [];
let ALL_BINANCE_USDT_SYMBOLS = [];
const EXCLUDED_USD_STABLE_BASES = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','USDP','DAI','USDE','USDS','USD1','UST','USTC','FRAX','LUSD','USDD','EURC','AEUR','EURI']);
function isExcludedStableSymbol(symbol) {
    const s = String(symbol || '').toUpperCase();
    const base = s.endsWith('USDT') ? s.slice(0, -4) : s;
    return s === 'USDT' || EXCLUDED_USD_STABLE_BASES.has(base) || /(UP|DOWN|BEAR|BULL)USDT$/.test(s);
}

/** Binance USDT 現貨市值前25；執行時會優先依 CoinGecko 市值排名過濾 Binance 上架交易對，失敗時使用此備援清單。 */
let TOP25_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "TRXUSDT", "AVAXUSDT", "LINKUSDT",
    "TONUSDT", "SHIBUSDT", "DOTUSDT", "BCHUSDT", "NEARUSDT",
    "POLUSDT", "LTCUSDT", "UNIUSDT", "ICPUSDT", "APTUSDT",
    "ETCUSDT", "FILUSDT", "ATOMUSDT", "RENDERUSDT", "ARBUSDT"
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
    "30m": 30 * 60 * 1000,
    "2h": 2 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000,
};

function symbolLabel(symbol) {
    return symbol.replace(/USDT$/, "");
}

function formatPrice(symbol, price) {
    price = Number(price);
    if (!Number.isFinite(price)) return "—";
    // Show enough decimals to distinguish low-priced assets instead of rounding them to zero.
    const digits = price >= 1000 ? 2 : price >= 1 ? 4 : price >= 0.01 ? 6 : price >= 0.0001 ? 8 : 12;
    return price.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
        useGrouping: false
    });
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
        if (symbol && !isExcludedStableSymbol(symbol) && !seen.has(symbol)) {
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
    if (symbol.includes("_") || isExcludedStableSymbol(symbol)) return false;
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
    tbody.innerHTML = LIVE_SYMBOLS.map((symbol) => `
        <tr>
            <td class="sym">${symbolLabel(symbol)}</td>
            <td id="${symbol.toLowerCase()}-binance" class="live-current-price">載入中…</td>
        </tr>`).join("");
}

async function updatePrices() {
    // 即時報價僅顯示幣名與 Binance 現價；移除不穩定的歷史區間漲跌幅請求。
    const priceMap = await fetchAllBinancePrices();
    let failed = 0;
    LIVE_SYMBOLS.forEach(symbol => {
        const priceCell = document.getElementById(`${symbol.toLowerCase()}-binance`);
        const price = priceMap.get(symbol);
        if (priceCell) priceCell.textContent = price == null ? "現價暫不可用" : formatPrice(symbol, price);
        if (price == null) failed += 1;
    });
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
    const order = ["市值前25", "漲幅", "跌幅", "自訂"];
    const labels = { "市值前25": "tag-cap", 漲幅: "tag-up", 跌幅: "tag-down", 自訂: "tag-custom" };
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

async function resolveBinanceTop25ByMarketCap() {
    try {
        const exchangeResponse = await fetch("https://api.binance.com/api/v3/exchangeInfo", { cache: "no-store" });
        if (!exchangeResponse.ok) throw new Error("Binance 交易對清單暫時無法取得");
        const exchange = await exchangeResponse.json();
        const tradableUsdtPairs = (exchange.symbols || [])
            .filter(x => x.status === "TRADING" && x.isSpotTradingAllowed !== false && x.quoteAsset === "USDT" && !isExcludedStableSymbol(`${String(x.baseAsset).toUpperCase()}USDT`));
        ALL_BINANCE_USDT_SYMBOLS = [...new Set(tradableUsdtPairs.map(x => `${String(x.baseAsset).toUpperCase()}USDT`))].sort((a, b) => a.localeCompare(b));
        try {
            const marketResponse = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false", { cache: "no-store", signal: AbortSignal.timeout(5000) });
            if (marketResponse.ok) {
                const markets = await marketResponse.json();
                const listed = new Set(tradableUsdtPairs.map(x => x.baseAsset.toUpperCase()));
                const matched = markets.filter(c => c.symbol && listed.has(c.symbol.toUpperCase()) && Number.isFinite(Number(c.market_cap)))
                    .sort((a, b) => Number(b.market_cap) - Number(a.market_cap)).slice(0, 25).map(c => `${c.symbol.toUpperCase()}USDT`);
                if (matched.length >= 20) TOP25_SYMBOLS = matched.filter(s => !isExcludedStableSymbol(s));
            }
        } catch (error) { console.warn("CoinGecko 市值排行不可用，使用 Binance 可交易幣種清單：", error); }
    } catch (error) { console.warn("無法更新 Binance 交易對清單：", error); }
    TOP25_SYMBOLS = TOP25_SYMBOLS.filter(s => !isExcludedStableSymbol(s));
    return TOP25_SYMBOLS;
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
    metaEl.textContent = "查詢中…（Binance 上架幣種市值前 25＋漲幅 15＋跌幅 15＋自訂）";
    document.getElementById("kline-compare-table").hidden = true;

    try {
        await resolveBinanceTop25ByMarketCap();
        populateDcaSymbolOptions();
        const priceMap = await fetchAllBinancePrices();
        const seedSymbols = [...new Set([...TOP25_SYMBOLS, ...customSymbols])];

        metaEl.textContent = "掃描漲幅／跌幅榜中…";
        const { gainerSymbols, loserSymbols, cache: moverCache } = await resolveTopMoverSymbols(
            interval,
            userTimeMs,
            priceMap,
            seedSymbols
        );

        const tagMap = new Map();
        TOP25_SYMBOLS.forEach((s) => addSymbolTag(tagMap, s, "市值前25"));
        customSymbols.forEach((s) => addSymbolTag(tagMap, s, "自訂"));
        gainerSymbols.forEach((s) => addSymbolTag(tagMap, s, "漲幅"));
        loserSymbols.forEach((s) => addSymbolTag(tagMap, s, "跌幅"));

        const allSymbols = [
            ...new Set([...TOP25_SYMBOLS, ...customSymbols, ...gainerSymbols, ...loserSymbols]),
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
                · 共 ${allSymbols.length} 檔（市值前25＋漲 ${gainerSymbols.length}＋跌 ${loserSymbols.length}${customSymbols.length ? `＋自訂 ${customSymbols.length}` : ""}）
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
resolveBinanceTop25ByMarketCap().then(() => {
    LIVE_SYMBOLS = [...TOP25_SYMBOLS];
    populateDcaSymbolOptions();
    renderLivePriceTable();
    refreshWebApp();
    if (!window.__cpcDcaAutoScanStarted) {
        window.__cpcDcaAutoScanStarted = true;
        setTimeout(() => scanDcaRecommendations(), 1200);
    }
});

// 更新頻率適度放慢，避免 25 個幣種的價格與 K 線請求過於密集。
setInterval(() => {
    if (!document.hidden && LIVE_SYMBOLS.length) refreshWebApp();
}, 30000);

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js", { scope: "./" })
            .then(() => console.info("PWA Service Worker registered"))
            .catch((error) => console.error("Service Worker registration failed:", error));
    });
}

// ==================== Market overview: configurable universe + actionable insights ====================
let marketOverviewLoadedAt = 0;
let marketOverviewLoading = false;
let marketRankCount = 10;
let marketCustomSymbols = [];

function formatCompactMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
}

function formatMarketPrice(symbol, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    if (n >= 0.01) return n.toFixed(5);
    return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function parseMarketSymbols(raw) {
    const seen = new Set();
    return String(raw || "").split(/[\s,，;；]+/).map(value => value.trim().toUpperCase())
        .filter(Boolean).map(value => value.endsWith("USDT") ? value : `${value}USDT`)
        .filter(value => /^[A-Z0-9]{2,14}USDT$/.test(value) && !isExcludedStableSymbol(value))
        .filter(value => !seen.has(value) && seen.add(value));
}

function readMarketSettings() {
    try {
        const savedSymbols = localStorage.getItem("cpc_market_custom_symbols");
        const savedCount = Number(localStorage.getItem("cpc_market_rank_count"));
        marketCustomSymbols = savedSymbols ? parseMarketSymbols(savedSymbols) : [];
        marketRankCount = Number.isFinite(savedCount) && savedCount >= 3 && savedCount <= 30 ? Math.round(savedCount) : 10;
    } catch (_) {
        marketCustomSymbols = [];
        marketRankCount = 10;
    }
    const symbolInput = document.getElementById("market-symbol-input");
    const countInput = document.getElementById("market-rank-count");
    if (symbolInput) symbolInput.value = marketCustomSymbols.map(s => s.replace(/USDT$/, "")).join(", ");
    if (countInput) countInput.value = String(marketRankCount);
}

function applyMarketSettings() {
    const raw = document.getElementById("market-symbol-input")?.value || "";
    const parsed = parseMarketSymbols(raw);
    if (raw.trim() && !parsed.length) {
        const status = document.getElementById("market-status");
        status.textContent = "沒有辨識到有效幣種。請輸入 BTC、ETH、SOL 等幣名，並以逗號或換行分隔。";
        status.classList.add("error-text");
        return;
    }
    const countRaw = Number(document.getElementById("market-rank-count")?.value || 10);
    if (!Number.isFinite(countRaw) || countRaw < 3 || countRaw > 30) {
        const status = document.getElementById("market-status");
        status.textContent = "排行數量請設定在 3 到 30 之間。";
        status.classList.add("error-text");
        return;
    }
    marketCustomSymbols = parsed;
    marketRankCount = Math.round(countRaw);
    try {
        localStorage.setItem("cpc_market_custom_symbols", marketCustomSymbols.join(","));
        localStorage.setItem("cpc_market_rank_count", String(marketRankCount));
    } catch (_) { /* Private browsing may block local storage; settings still work for this page session. */ }
    marketOverviewLoadedAt = 0;
    loadMarketOverview(true);
}

function renderMarketRankRows(elementId, rows) {
    const tbody = document.getElementById(elementId);
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">目前觀察清單沒有足夠數據</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map((row, index) => {
        const pct = Number(row.priceChangePercent);
        const pctClass = pct > 0 ? "market-up" : pct < 0 ? "market-down" : "market-flat";
        return `<tr><td><span class="market-rank-number">${index + 1}</span><strong>${symbolLabel(row.symbol)}</strong></td><td class="market-number">${formatMarketPrice(row.symbol, row.lastPrice)}</td><td class="${pctClass} market-number">${formatPct(pct)}</td><td class="market-number">${formatCompactMoney(row.quoteVolume)}</td></tr>`;
    }).join("");
}

function setMarketInsight(id, value, note) {
    const valueNode = document.getElementById(`market-insight-${id}`);
    const noteNode = document.getElementById(`market-insight-${id}-note`);
    if (valueNode) valueNode.textContent = value;
    if (noteNode) noteNode.textContent = note;
}

function getMarketRangePosition(row) {
    const low = Number(row.lowPrice);
    const high = Number(row.highPrice);
    const price = Number(row.lastPrice);
    if (![low, high, price].every(Number.isFinite) || high <= low) return null;
    return Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
}

function buildMarketObservations(rows, upRatio, medianChange, concentration) {
    const list = document.getElementById("market-observation-list");
    if (!list) return;
    const messages = [];
    if (upRatio >= 70) messages.push({ title: "漲勢擴散", text: `觀察清單有 ${upRatio.toFixed(0)}% 幣種上漲，漲勢較普遍；仍要確認是否由少數高漲幅幣種拉動。`, type: "positive" });
    else if (upRatio <= 30) messages.push({ title: "弱勢範圍較廣", text: `只有 ${upRatio.toFixed(0)}% 幣種上漲，跌勢較普遍。這不是立即抄底的理由，先留意是否止跌。`, type: "warning" });
    else messages.push({ title: "市場方向分歧", text: `上漲比例 ${upRatio.toFixed(0)}%，多空尚未形成明顯一致方向；可比較個別幣種強弱。`, type: "neutral" });

    if (Number.isFinite(medianChange)) {
        if (medianChange > 1) messages.push({ title: "典型幣種偏強", text: `漲跌幅中位數為 +${medianChange.toFixed(2)}%。一半幣種高於此值、一半低於此值，較不容易被單一暴漲幣種誤導。`, type: "positive" });
        else if (medianChange < -1) messages.push({ title: "典型幣種偏弱", text: `漲跌幅中位數為 ${medianChange.toFixed(2)}%，代表觀察清單中間位置的幣種也偏弱，而不只是少數幣下跌。`, type: "warning" });
        else messages.push({ title: "整體變動有限", text: `漲跌幅中位數為 ${formatPct(medianChange)}，典型幣種的 24 小時變化相對溫和。`, type: "neutral" });
    }
    if (concentration >= 60) messages.push({ title: "成交活躍度集中", text: `前三大成交額占觀察清單約 ${concentration.toFixed(0)}%。整體成交額可能主要由少數幣種貢獻，不能視為所有幣都活躍。`, type: "warning" });
    else messages.push({ title: "成交分布較分散", text: `前三大幣種占成交額約 ${concentration.toFixed(0)}%，觀察清單的交易活躍度沒有過度集中在前三名。`, type: "neutral" });

    const highVol = rows.filter(row => Math.abs(Number(row.priceChangePercent)) >= 8)
        .sort((a, b) => Math.abs(Number(b.priceChangePercent)) - Math.abs(Number(a.priceChangePercent))).slice(0, 3);
    highVol.forEach(row => messages.push({ title: `${symbolLabel(row.symbol)} 波動偏大`, text: `24 小時變動 ${formatPct(Number(row.priceChangePercent))}。大幅波動可能伴隨快速回撤，避免只因排行靠前就追價。`, type: "warning" }));

    const strength = rows.filter(row => Number(row.priceChangePercent) >= 2 && (getMarketRangePosition(row) ?? 0) >= 70 && Number(row.quoteVolume) >= 1000000)
        .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent)).slice(0, 3);
    strength.forEach(row => messages.push({ title: `${symbolLabel(row.symbol)} 動能值得追蹤`, text: `24 小時漲幅 ${formatPct(Number(row.priceChangePercent))}，現價位於當日高低區間約 ${(getMarketRangePosition(row) || 0).toFixed(0)}% 位置，且成交額達 ${formatCompactMoney(Number(row.quoteVolume))} USDT。這表示目前偏強，不代表後續必漲。`, type: "positive" }));

    if (messages.length < 4) messages.push({ title: "下一步怎麼看", text: "先觀察市場廣度是否延續，再確認個別幣種的漲幅、當日區間位置及成交額是否相互支持。此頁只有 24 小時快照，不能單靠它判定趨勢反轉。", type: "neutral" });
    list.innerHTML = messages.slice(0, 7).map(item => `<li class="observation-${item.type}"><strong>${item.title}</strong><span>${item.text}</span></li>`).join("");
}

async function loadMarketOverview(force = false) {
    const status = document.getElementById("market-status");
    if (marketOverviewLoading) return;
    if (!force && Date.now() - marketOverviewLoadedAt < 30000) return;
    marketOverviewLoading = true;
    status.textContent = "正在向 Binance 取得 24 小時市場數據…";
    status.classList.remove("error-text");
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-store" });
        if (!response.ok) throw new Error(`Binance 回應 HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error("收到的市場資料格式不正確");

        const allSpotRows = payload.filter(row => row && typeof row.symbol === "string" && isLikelySpotUsdtPair(row.symbol)
            && Number.isFinite(Number(row.priceChangePercent)) && Number.isFinite(Number(row.lastPrice)));
        const bySymbol = new Map(payload.filter(row => row && typeof row.symbol === "string").map(row => [row.symbol, row]));
        // Preserve the default major-cap universe and add user-defined symbols; custom input never replaces majors.
        const selectedSymbols = [...new Set([...TOP25_SYMBOLS, ...marketCustomSymbols])].filter(symbol => !isExcludedStableSymbol(symbol));
        const missingSymbols = selectedSymbols.filter(symbol => !bySymbol.has(symbol));
        const observedRows = selectedSymbols.map(symbol => bySymbol.get(symbol)).filter(row => row
            && Number.isFinite(Number(row.priceChangePercent)) && Number.isFinite(Number(row.lastPrice)));
        if (!observedRows.length) throw new Error("自訂清單沒有找到有效的 Binance USDT 現貨交易對，請確認幣名是否正確。");

        const upCount = observedRows.filter(row => Number(row.priceChangePercent) > 0).length;
        const downCount = observedRows.filter(row => Number(row.priceChangePercent) < 0).length;
        const flatCount = observedRows.length - upCount - downCount;
        const upRatio = (upCount / observedRows.length) * 100;
        const totalVolume = observedRows.reduce((sum, row) => sum + (Number(row.quoteVolume) || 0), 0);
        const sortedChanges = observedRows.map(row => Number(row.priceChangePercent)).sort((a, b) => a - b);
        const mid = Math.floor(sortedChanges.length / 2);
        const medianChange = sortedChanges.length % 2 ? sortedChanges[mid] : (sortedChanges[mid - 1] + sortedChanges[mid]) / 2;
        const byVolume = [...observedRows].sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
        const top3Volume = byVolume.slice(0, 3).reduce((sum, row) => sum + (Number(row.quoteVolume) || 0), 0);
        const concentration = totalVolume > 0 ? (top3Volume / totalVolume) * 100 : 0;

        document.getElementById("market-up-count").textContent = `${upCount} / ${observedRows.length}`;
        document.getElementById("market-down-count").textContent = `${downCount} / ${observedRows.length}`;
        document.getElementById("market-up-ratio").textContent = `${upRatio.toFixed(0)}%`;
        document.getElementById("market-total-volume").textContent = `約 ${formatCompactMoney(totalVolume)} USDT`;
        setMarketInsight("breadth", upRatio >= 70 ? "漲勢較普遍" : upRatio <= 30 ? "跌勢較普遍" : "多空分歧", `上漲 ${upCount} 種、下跌 ${downCount} 種${flatCount ? `、持平 ${flatCount} 種` : ""}；共計 ${observedRows.length} 種。`);
        setMarketInsight("median", formatPct(medianChange), "觀察清單漲跌幅的中間值；比平均值更不容易被極端漲跌影響。");
        setMarketInsight("concentration", `${concentration.toFixed(0)}%`, "前三大成交額占比。比例高表示交易活躍度集中，不代表資金淨流入。");

        ["market-volume-count-label", "market-gainers-count-label", "market-losers-count-label"].forEach(id => {
            const node = document.getElementById(id);
            if (node) node.textContent = String(marketRankCount);
        });
        const rankRows = [...observedRows];
        renderMarketRankRows("market-volume-body", [...allSpotRows].sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, marketRankCount));
        renderMarketRankRows("market-gainers-body", [...rankRows].filter(row => Number(row.priceChangePercent) > 0).sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent)).slice(0, marketRankCount));
        renderMarketRankRows("market-losers-body", [...rankRows].filter(row => Number(row.priceChangePercent) < 0).sort((a, b) => Number(a.priceChangePercent) - Number(b.priceChangePercent)).slice(0, marketRankCount));

        const tip = document.querySelector("#market-summary-tip span");
        if (tip) {
            const state = upRatio >= 70 ? "上漲較普遍" : upRatio <= 30 ? "下跌較普遍" : "多空分歧";
            const medianState = medianChange > 1 ? "中間位置的幣種也偏強" : medianChange < -1 ? "中間位置的幣種也偏弱" : "典型幣種漲跌幅不大";
            const concentrationState = concentration >= 60 ? "成交集中在少數幣種" : "成交分布相對分散";
            tip.textContent = `研判：${state}；${medianState}；${concentrationState}。建議先看這三項是否互相支持，再查看下方訊號。這是規則式市場觀察，不是買賣指令。`;
        }
        buildMarketObservations(observedRows, upRatio, medianChange, concentration);
        marketOverviewLoadedAt = Date.now();
        const sourceName = marketCustomSymbols.length ? `市值前 25＋自訂觀察清單 ${observedRows.length}/${selectedSymbols.length} 種` : `預設市值觀察清單 ${observedRows.length} 種`;
        status.textContent = `來源：Binance Spot · ${sourceName} · 排行顯示 ${marketRankCount} 名 · 更新於 ${formatUpdatedTime()}${missingSymbols.length ? ` · 未找到：${missingSymbols.map(s => s.replace(/USDT$/, "")).join(", ")}` : ""}`;
    } catch (error) {
        console.error("載入市場總覽失敗：", error);
        status.textContent = error.message || "市場數據暫時無法取得。請稍後重試。";
        status.classList.add("error-text");
    } finally {
        marketOverviewLoading = false;
    }
}

readMarketSettings();
document.getElementById("market-refresh-btn")?.addEventListener("click", () => loadMarketOverview(true));
document.getElementById("market-apply-settings")?.addEventListener("click", applyMarketSettings);

// Feature tabs keep the interface compact on desktop and mobile.
function initFeatureTabs() {
    const tabs = [...document.querySelectorAll("[data-feature-tab]")];
    const panels = [...document.querySelectorAll("[data-feature-panel]")];
    const activate = (name) => {
        tabs.forEach(tab => {
            const active = tab.dataset.featureTab === name;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", String(active));
        });
        panels.forEach(panel => { panel.hidden = panel.dataset.featurePanel !== name; });
    };
    tabs.forEach(tab => tab.addEventListener("click", () => {
        activate(tab.dataset.featureTab);
        if (tab.dataset.featureTab === "market") loadMarketOverview();
    }));
    activate("alerts");
}
initFeatureTabs();

// ==================== DCA Return Calculator ====================
function normalizeDcaSymbol(input) {
    const symbol = normalizeBinanceSymbol(input || "");
    return isExcludedStableSymbol(symbol) ? "" : symbol;
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
    const symbol = normalizeDcaSymbol(document.getElementById("dca-symbol-input").value);
    const startDate = parseDateInput(document.getElementById("dca-start").value);
    const frequency = document.getElementById("dca-frequency").value;
    const amountInput = document.getElementById("dca-amount");
    if (!amountInput.value.trim()) amountInput.value = "100";
    const amount = Number(amountInput.value);

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

function populateDcaSymbolOptions(filter = "") {
    const list = document.getElementById("dca-symbol-options");
    const input = document.getElementById("dca-symbol-input");
    if (!list) return;
    const query = String(filter || "").trim().toUpperCase().replace(/USDT$/, "");
    // 空白時只顯示市值前 25；有輸入時改從 Binance 全部可交易 USDT 現貨交易對模糊搜尋。
    const sourceSymbols = query && ALL_BINANCE_USDT_SYMBOLS.length
        ? ALL_BINANCE_USDT_SYMBOLS
        : TOP25_SYMBOLS.filter(symbol => !isExcludedStableSymbol(symbol));
    const symbols = sourceSymbols.filter(symbol => !query || symbolLabel(symbol).includes(query));
    list.innerHTML = symbols.map(symbol => {
        const label = symbolLabel(symbol);
        const sourceLabel = query ? "Binance USDT 現貨" : "市值前 25";
        return `<button type="button" class="symbol-option" role="option" data-symbol="${label}"><strong>${label}</strong><span>USDT · ${sourceLabel}</span></button>`;
    }).join("") || `<div class="symbol-options-empty">沒有符合的 Binance USDT 現貨幣種；仍可直接輸入自訂代號</div>`;
    // 不要在清空輸入框時自動補回 BTC；允許使用者自由編輯到空字串或單一字母。
}

function initDcaSymbolPicker() {
    const input = document.getElementById("dca-symbol-input");
    const list = document.getElementById("dca-symbol-options");
    const toggle = document.getElementById("dca-symbol-toggle");
    if (!input || !list || !toggle) return;
    const open = (filter = "") => {
        populateDcaSymbolOptions(filter);
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
    };
    const close = () => {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
    };
    // 點入欄位先顯示完整熱門清單；只有使用者真的輸入文字時才依關鍵字篩選。
    input.addEventListener("focus", () => open(""));
    input.addEventListener("click", () => { if (list.hidden) open(""); });
    input.addEventListener("input", () => open(input.value));
    toggle.addEventListener("click", () => list.hidden ? open("") : close());
    list.addEventListener("click", event => {
        const option = event.target.closest("[data-symbol]");
        if (!option) return;
        input.value = option.dataset.symbol;
        close();
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    document.addEventListener("click", event => {
        if (!event.target.closest(".dca-symbol-picker")) close();
    });
    input.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
}

function initDcaInputs() {
    const start = document.getElementById("dca-start");
    const end = document.getElementById("dca-end");
    const untilNow = document.getElementById("dca-until-now");
    const today = new Date();
    const todayKey = toUtcDateKey(today);
    start.value = todayKey;
    end.value = todayKey;
    const amountInput = document.getElementById("dca-amount");
    if (amountInput && !amountInput.value.trim()) amountInput.value = "100";
    amountInput?.addEventListener("blur", () => { if (!amountInput.value.trim()) amountInput.value = "100"; });
    start.max = todayKey;
    end.max = todayKey;

    untilNow.addEventListener("change", () => {
        end.disabled = untilNow.checked;
    });
    end.disabled = true;
    populateDcaSymbolOptions();
    initDcaSymbolPicker();
}

document.getElementById("dca-btn").addEventListener("click", calculateDcaReturn);
initDcaInputs();


// DCA discovery: scan the selected Binance universe and rank coins by current price vs
// historical scheduled-buy average. Clicking a row opens the existing full scenario report.
function dcaTier(pct) {
    if (pct <= -20) return { label: "非常推薦", cls: "recommendation-very-good", rank: 0 };
    if (pct <= -5) return { label: "推薦", cls: "recommendation-good", rank: 1 };
    if (pct <= 5) return { label: "普通", cls: "recommendation-neutral", rank: 2 };
    if (pct <= 20) return { label: "不推薦", cls: "recommendation-bad", rank: 3 };
    return { label: "非常不推薦", cls: "recommendation-very-bad", rank: 4 };
}
function dcaMoney(n) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { maximumFractionDigits: 12, minimumFractionDigits: 0 });
}
let dcaDiscoveryRows = [];
let dcaDiscoveryScanInProgress = false;
function renderDcaDiscoveryRows(errors = []) {
    const list = document.getElementById("dca-discovery-list");
    if (!list) return;
    const query = (document.getElementById("dca-discovery-search")?.value || "").trim().toUpperCase();
    const tier = document.getElementById("dca-tier-filter")?.value || "all";
    const source = dcaDiscoveryRows.length ? dcaDiscoveryRows : (window.dcaDiscoveryRows || []);
    const filtered = source.filter(r => (!query || symbolLabel(r.symbol).includes(query)) && (tier === "all" || String(r.tier.rank) === tier));
    list.innerHTML = filtered.map(r => `<button type="button" class="dca-discovery-row" data-dca-symbol="${r.symbol}" data-dca-start="${r.firstDate}">
        <span class="dca-discovery-coin"><strong>${symbolLabel(r.symbol)}</strong><small>${r.count.toLocaleString()} 次定投樣本 · 起始 ${r.firstDate}</small></span>
        <span class="dca-discovery-price"><strong>${formatPrice(r.symbol,r.current)} USDT</strong><small>均價 ${formatPrice(r.symbol,r.avg)} USDT</small></span>
        <span class="dca-discovery-grade ${r.tier.cls}">${r.tier.label}<small>${formatPct(r.pct)}</small></span></button>`).join("") || '<div class="muted">目前篩選條件沒有符合的幣種。</div>';
    if (errors.length) list.insertAdjacentHTML("beforeend", `<div class="dca-scan-errors">無法分析 ${errors.length} 種（交易對不存在、歷史資料不足或 API 暫時受限）；例如：${errors.slice(0, 25).map(r=>symbolLabel(r.symbol)).join("、")}${errors.length > 25 ? "…" : ""}</div>`);
}

async function scanDcaRecommendations() {
    if (dcaDiscoveryScanInProgress) return;
    dcaDiscoveryScanInProgress = true;
    const button = document.getElementById("dca-scan-btn");
    const list = document.getElementById("dca-discovery-list");
    const summary = document.getElementById("dca-tier-summary");
    const frequency = document.getElementById("dca-frequency").value;
    const amountInput = document.getElementById("dca-amount");
    if (!amountInput.value.trim()) amountInput.value = "100";
    const amount = Number(amountInput.value) || 100;
    const universe = document.getElementById("dca-scan-universe").value;
    const cacheKey = `cpc_dca_discovery_v5:${frequency}:${universe}`;
    let hasFreshCache = false;
    try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
        if (cached && Array.isArray(cached.rows) && Date.now() - cached.at < 30 * 60 * 1000) {
            hasFreshCache = true;
            dcaDiscoveryRows = cached.rows;
            renderDcaDiscoveryRows();
            const counts = [0,1,2,3,4].map(rank => dcaDiscoveryRows.filter(r => r.tier.rank === rank).length);
            summary.innerHTML = `<span>非常推薦 <b>${counts[0]}</b></span><span>推薦 <b>${counts[1]}</b></span><span>普通 <b>${counts[2]}</b></span><span>不推薦 <b>${counts[3]}</b></span><span>非常不推薦 <b>${counts[4]}</b></span>`;
            list.insertAdjacentHTML("afterbegin", '<div class="muted">已先載入快取結果，正在背景更新全市場數據…</div>');
        }
    } catch {}
    let symbols;
    if (universe === "top25") symbols = [...TOP25_SYMBOLS];
    else {
        if (!ALL_BINANCE_USDT_SYMBOLS.length) await resolveBinanceTop25ByMarketCap();
        // Scan the full active USDT spot universe; leveraged tokens and duplicate-like wrappers are excluded.
        symbols = ALL_BINANCE_USDT_SYMBOLS.filter(s => !/(UP|DOWN|BULL|BEAR)USDT$/.test(s));
        symbols = [...new Set([...TOP25_SYMBOLS, ...symbols])];
    }
    symbols = [...new Set(symbols)];
    if (!symbols.length) { dcaDiscoveryScanInProgress = false; list.innerHTML = '<div class="error-text">沒有可掃描的幣種，請重新整理後再試。</div>'; return; }
    button.disabled = true;
    button.textContent = "掃描中…";
    if (hasFreshCache) {
        renderDcaDiscoveryRows();
        list.insertAdjacentHTML("afterbegin", '<div class="muted">已先顯示快取結果，正在背景更新全市場數據…</div>');
    } else list.innerHTML = '<div class="muted">正在查詢 Binance 歷史 K 線與現價，請稍候…</div>';
    summary.textContent = hasFreshCache ? "快取已載入，背景更新中" : "掃描中";
    const now = new Date();
    const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999);
    const rows = [];
    try {
        // Keep concurrency conservative to reduce API rate-limit errors. Full-universe scans may take several minutes.
        const totalSymbols = symbols.length;
        for (let i = 0; i < symbols.length; i += 6) {
            const chunk = symbols.slice(i, i + 6);
            const batch = await Promise.all(chunk.map(async symbol => {
                try {
                    const firstUrl = new URL("https://api.binance.com/api/v3/klines");
                    firstUrl.searchParams.set("symbol", symbol);
                    firstUrl.searchParams.set("interval", "1d");
                    firstUrl.searchParams.set("startTime", "0");
                    firstUrl.searchParams.set("limit", "1");
                    const firstRes = await fetch(firstUrl);
                    const firstData = await firstRes.json();
                    if (!firstRes.ok || !Array.isArray(firstData) || !firstData.length) throw new Error("無歷史 K 線");
                    const firstDate = new Date(Number(firstData[0][0]));
                    const startMs = Number(firstData[0][0]);
                    const [prices, current] = await Promise.all([
                        fetchBinanceDailyCloses(symbol, startMs, endMs),
                        fetchBinanceCurrentPriceRaw(symbol)
                    ]);
                    const dates = [...prices.keys()].sort();
                    if (!dates.length) throw new Error("歷史資料不足");
                    const startDate = new Date(`${dates[0]}T00:00:00`);
                    const schedule = buildDcaSchedule(startDate, now, frequency);
                    let invested = 0, units = 0, count = 0;
                    for (const date of schedule) {
                        const key = toUtcDateKey(date);
                        const price = prices.get(key);
                        if (Number.isFinite(price) && price > 0) {
                            invested += amount;
                            units += amount / price;
                            count++;
                        }
                    }
                    if (!count || !units) throw new Error("無法建立定投樣本");
                    const avg = invested / units;
                    const pct = ((current - avg) / avg) * 100;
                    return { symbol, current, avg, pct, count, firstDate: dates[0], tier: dcaTier(pct) };
                } catch (e) {
                    return { symbol, error: e.message || "資料不可用" };
                }
            }));
            rows.push(...batch);
            list.innerHTML = `<div class="muted scan-progress">已完成 ${rows.length.toLocaleString()} / ${totalSymbols.toLocaleString()} 個幣種（全市場掃描可能需要數分鐘，請勿關閉頁面）…</div>`;
        }
        const valid = rows.filter(r => !r.error).sort((a,b) => a.tier.rank-b.tier.rank || a.pct-b.pct);
        dcaDiscoveryRows = valid;
        window.dcaDiscoveryRows = valid;
        try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), rows: valid })); } catch {}
        renderDcaDiscoveryRows();
        const errors = rows.filter(r => r.error);
        const counts = [0,1,2,3,4].map(rank => valid.filter(r => r.tier.rank === rank).length);
        summary.innerHTML = `<span>非常推薦 <b>${counts[0]}</b></span><span>推薦 <b>${counts[1]}</b></span><span>普通 <b>${counts[2]}</b></span><span>不推薦 <b>${counts[3]}</b></span><span>非常不推薦 <b>${counts[4]}</b></span>`;
        renderDcaDiscoveryRows(errors);
        const summaryNote = document.getElementById("dca-tier-summary");
        if (summaryNote) summaryNote.dataset.total = String(valid.length);
    } catch (e) {
        list.innerHTML = `<div class="error-text">掃描失敗：${e.message || "請稍後重試"}</div>`;
    } finally {
        dcaDiscoveryScanInProgress = false;
        button.disabled = false;
        button.textContent = "重新掃描推薦幣種";
    }
}
const dcaModal = document.getElementById("dca-detail-modal");
const dcaResult = document.getElementById("dca-result");
const dcaResultHome = dcaResult.parentElement;
const dcaResultMarker = document.createComment("DCA result home");
dcaResultHome.insertBefore(dcaResultMarker, dcaResult);
function closeDcaModal() {
    dcaModal.hidden = true;
    dcaResultMarker.parentNode?.insertBefore(dcaResult, dcaResultMarker.nextSibling);
}
document.getElementById("dca-modal-close").addEventListener("click", closeDcaModal);
dcaModal.addEventListener("click", e => { if (e.target.matches("[data-close-dca-modal]")) closeDcaModal(); });
document.getElementById("dca-discovery-list").addEventListener("click", async e => {
    const row = e.target.closest("[data-dca-symbol]");
    if (!row) return;
    document.getElementById("dca-symbol-input").value = symbolLabel(row.dataset.dcaSymbol);
    if (!document.getElementById("dca-amount").value) document.getElementById("dca-amount").value = "100";
    document.getElementById("dca-start").value = row.dataset.dcaStart;
    document.getElementById("dca-until-now").checked = true;
    document.getElementById("dca-end").disabled = true;
    document.getElementById("dca-modal-title").textContent = `${symbolLabel(row.dataset.dcaSymbol)} 定投分析`;
    document.getElementById("dca-modal-subtitle").textContent = "正在依目前選定的頻率與每次投入金額計算完整情境…";
    dcaModal.hidden = false;
    document.getElementById("dca-modal-result-slot").appendChild(dcaResult);
    await calculateDcaReturn();
    document.getElementById("dca-modal-subtitle").textContent = `從 Binance 可取得的最早日 K 線開始 · ${({daily:"每天",weekly:"每週",monthly:"每月"})[document.getElementById("dca-frequency").value]} · 每次 ${Number(document.getElementById("dca-amount").value || 100)} USDT`;
});
document.getElementById("dca-scan-btn").addEventListener("click", scanDcaRecommendations);
document.getElementById("dca-frequency")?.addEventListener("change", () => scanDcaRecommendations());
document.getElementById("dca-scan-universe")?.addEventListener("change", () => scanDcaRecommendations());
document.getElementById("dca-discovery-search")?.addEventListener("input", () => renderDcaDiscoveryRows());
document.getElementById("dca-tier-filter")?.addEventListener("change", () => renderDcaDiscoveryRows());


// ==================== Multi-factor crypto technical analysis engine ====================
// The previous anomaly-alert / DCA-average-cross alert engine is intentionally retired.
const ANALYSIS_INTERVALS = ['1d', '4h', '1h', '15m'];
const ANALYSIS_INTERVAL_LABELS = {'5m':'5 分鐘','15m':'15 分鐘','1h':'1 小時','4h':'4 小時','1d':'1 日'};
const analysisRunButton = document.getElementById('analysis-run-btn');

function analysisEma(values, period) {
    if (values.length < period) return [];
    const alpha = 2 / (period + 1), out = Array(values.length).fill(null);
    let seed = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
    out[period-1] = seed;
    for (let i=period;i<values.length;i++) out[i] = values[i]*alpha + out[i-1]*(1-alpha);
    return out;
}
function analysisRsi(closes, period=14) {
    if(closes.length<period+1)return [];
    let gain=0,loss=0;
    for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)gain+=d;else loss-=d;}
    let ag=gain/period,al=loss/period,out=Array(closes.length).fill(null);
    out[period]=al===0?100:100-100/(1+ag/al);
    for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;out[i]=al===0?100:100-100/(1+ag/al);}
    return out;
}
function analysisMacd(closes) {
    const e12=analysisEma(closes,12),e26=analysisEma(closes,26);
    const line=closes.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null);
    const validStart=line.findIndex(Number.isFinite); if(validStart<0)return null;
    const vals=line.slice(validStart),sig=analysisEma(vals,9),signal=Array(closes.length).fill(null);
    sig.forEach((v,i)=>{if(v!=null)signal[validStart+i]=v;});
    const hist=line.map((v,i)=>v!=null&&signal[i]!=null?v-signal[i]:null),i=closes.length-1;
    if(!Number.isFinite(hist[i])||!Number.isFinite(hist[i-1]))return null;
    return {line:line[i],signal:signal[i],hist:hist[i],prevHist:hist[i-1],prevLine:line[i-1],prevSignal:signal[i-1],histPrev2:hist[i-2]};
}
function analysisAtr(candles, period=14) {
    if(candles.length<period+1)return null;
    const tr=[];for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
    return tr.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function analysisFormat(symbol,n){return Number.isFinite(n)?formatPrice(symbol,n):'資料不足';}
function analysisPct(n){return Number.isFinite(n)?`${n>=0?'+':''}${n.toFixed(2)}%`:'資料不足';}
function analysisEscape(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function fetchAnalysisCandles(symbol, interval, limit=260) {
    const u=new URL('https://api.binance.com/api/v3/klines');u.searchParams.set('symbol',symbol);u.searchParams.set('interval',interval);u.searchParams.set('limit',String(limit));
    const r=await fetch(u.toString(),{cache:'no-store'});if(!r.ok)throw new Error(`${interval} K 線取得失敗（HTTP ${r.status}）`);
    const raw=await r.json(),now=Date.now();
    // Exclude the currently forming candle; only closed candles may confirm a signal.
    return raw.filter(k=>Number(k[6])<now).map(k=>({openTime:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],closeTime:+k[6],quoteVolume:+k[7],trades:+k[8]})).filter(c=>[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
}
function analysisPivots(candles, radius=2) {
    const highs=[],lows=[];
    for(let i=radius;i<candles.length-radius;i++){
        let hi=true,lo=true;for(let j=i-radius;j<=i+radius;j++){if(j===i)continue;if(candles[j].high>=candles[i].high)hi=false;if(candles[j].low<=candles[i].low)lo=false;}
        if(hi)highs.push({i,p:candles[i].high});if(lo)lows.push({i,p:candles[i].low});
    }
    return {highs,lows};
}
function analyzeTimeframe(candles, symbol, interval) {
    if(candles.length<210)throw new Error(`${ANALYSIS_INTERVAL_LABELS[interval]||interval} 僅取得 ${candles.length} 根已收盤 K 線，EMA200 等必要分析資料不足`);
    const closes=candles.map(c=>c.close),volumes=candles.map(c=>c.volume),last=candles.length-1,c=candles[last],prev=candles[last-1];
    const ema9=analysisEma(closes,9),ema21=analysisEma(closes,21),ema50=analysisEma(closes,50),ema200=analysisEma(closes,200),rsi=analysisRsi(closes),macd=analysisMacd(closes),atr=analysisAtr(candles);
    if(!macd||!Number.isFinite(rsi[last])||![ema9[last],ema21[last],ema50[last],ema200[last],atr].every(Number.isFinite))throw new Error(`${ANALYSIS_INTERVAL_LABELS[interval]||interval} 指標資料不足`);
    const avgVol=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20,rvol=avgVol>0?c.volume/avgVol:null;
    const obv=[0];for(let i=1;i<candles.length;i++)obv.push(obv[i-1]+(closes[i]>closes[i-1]?volumes[i]:closes[i]<closes[i-1]?-volumes[i]:0));
    const vwapData=candles.slice(-20);let vwapNum=0,vwapDen=0;for(const x of vwapData){const typical=(x.high+x.low+x.close)/3;vwapNum+=typical*x.volume;vwapDen+=x.volume;}const vwap=vwapDen?vwapNum/vwapDen:null;
    const piv=analysisPivots(candles.slice(-100),2),hs=piv.highs,ls=piv.lows,sh=hs.slice(-2),sl=ls.slice(-2);
    const hh=sh.length===2&&sh[1].p>sh[0].p,lh=sh.length===2&&sh[1].p<sh[0].p,hl=sl.length===2&&sl[1].p>sl[0].p,ll=sl.length===2&&sl[1].p<sl[0].p;
    const swingHigh=hs.length?hs[hs.length-1].p:null,swingLow=ls.length?ls[ls.length-1].p:null;
    const priorHigh=Math.max(...candles.slice(-21,-1).map(x=>x.high)),priorLow=Math.min(...candles.slice(-21,-1).map(x=>x.low));
    const sweepHigh=c.high>priorHigh&&c.close<priorHigh,sweepLow=c.low<priorLow&&c.close>priorLow;
    const upBOS=swingHigh!=null&&c.close>swingHigh,downBOS=swingLow!=null&&c.close<swingLow;
    const emaBull=ema9[last]>ema21[last]&&ema21[last]>ema50[last]&&ema50[last]>ema200[last],emaBear=ema9[last]<ema21[last]&&ema21[last]<ema50[last]&&ema50[last]<ema200[last];
    const emaCrossUp=ema9[last]>ema21[last]&&ema9[last-1]<=ema21[last-1],emaCrossDown=ema9[last]<ema21[last]&&ema9[last-1]>=ema21[last-1];
    const macdCrossUp=macd.line>macd.signal&&macd.prevLine<=macd.prevSignal,macdCrossDown=macd.line<macd.signal&&macd.prevLine>=macd.prevSignal;
    const bullishCandle=c.close>c.open,bearishCandle=c.close<c.open;
    const longScore=(emaBull?2:0)+(c.close>ema21[last]?1:0)+(macd.hist>0&&macd.hist>macd.prevHist?1:0)+(rsi[last]>50&&rsi[last]>=rsi[last-1]?1:0)+(upBOS||sweepLow?2:0)+(bullishCandle&&rvol>=1.2?1:0);
    const shortScore=(emaBear?2:0)+(c.close<ema21[last]?1:0)+(macd.hist<0&&macd.hist<macd.prevHist?1:0)+(rsi[last]<50&&rsi[last]<=rsi[last-1]?1:0)+(downBOS||sweepHigh?2:0)+(bearishCandle&&rvol>=1.2?1:0);
    const lastTwo=candles.slice(-2),twoLong=lastTwo.length===2&&lastTwo.every((x,i)=>x.close>x.open&&(i===0||x.close>lastTwo[i-1].close)),twoShort=lastTwo.length===2&&lastTwo.every((x,i)=>x.close<x.open&&(i===0||x.close<lastTwo[i-1].close));
    const pattern=[];
    // Price-action patterns are deliberately labelled potential unless a neckline/boundary is confirmed on close.
    const recent=candles.slice(-40),localHighs=analysisPivots(recent,2).highs,localLows=analysisPivots(recent,2).lows;
    if(localHighs.length>=2){const a=localHighs.at(-2).p,b=localHighs.at(-1).p;if(Math.abs(a-b)/Math.max(a,b)<.012)pattern.push({name:'潛在 M 型雙頂／等高壓力',status:c.close<Math.min(a,b)?'頸線/區間已跌破':'尚未確認',level:Math.min(a,b)});}
    if(localLows.length>=2){const a=localLows.at(-2).p,b=localLows.at(-1).p;if(Math.abs(a-b)/Math.max(a,b)<.012)pattern.push({name:'潛在 W 型雙底／等低支撐',status:c.close>Math.max(a,b)?'區間已收復':'尚未確認',level:Math.max(a,b)});}
    if(localHighs.length>=3){const p3=localHighs.slice(-3),[a,b,d]=p3.map(x=>x.p);if(Math.abs(a-d)/Math.max(a,d)<.035&&b>Math.max(a,d)*1.015)pattern.push({name:'潛在頭肩頂',status:c.close<Math.min(a,d)?'可能已跌破肩線區域':'尚未確認頸線突破',level:Math.min(a,d)});if([a,b,d].every(x=>Math.abs(x-((a+b+d)/3))/((a+b+d)/3)<.012))pattern.push({name:'潛在三重頂',status:c.close<Math.min(a,b,d)?'可能已跌破頂部支撐':'尚未確認',level:Math.min(a,b,d)});}
    if(localLows.length>=3){const p3=localLows.slice(-3),[a,b,d]=p3.map(x=>x.p);if(Math.abs(a-d)/Math.max(a,d)<.035&&b<Math.min(a,d)*.985)pattern.push({name:'潛在頭肩底',status:c.close>Math.max(a,d)?'可能已收復肩線區域':'尚未確認頸線突破',level:Math.max(a,d)});if([a,b,d].every(x=>Math.abs(x-((a+b+d)/3))/((a+b+d)/3)<.012))pattern.push({name:'潛在三重底',status:c.close>Math.max(a,b,d)?'可能已收復底部壓力':'尚未確認',level:Math.max(a,b,d)});}
    const lastFive=candles.slice(-5),oldMove=lastFive[2].close-lastFive[0].close,newMove=lastFive[4].close-lastFive[2].close;
    if(oldMove<0&&newMove>0&&Math.abs(newMove)>Math.abs(oldMove)*.65)pattern.push({name:'潛在 V 型反轉',status:'短線反彈已出現，仍需結構與量能確認',level:Math.min(...lastFive.slice(0,3).map(x=>x.low))});
    if(oldMove>0&&newMove<0&&Math.abs(newMove)>Math.abs(oldMove)*.65)pattern.push({name:'潛在尖頂／V 型回落',status:'短線回落已出現，仍需結構與量能確認',level:Math.max(...lastFive.slice(0,3).map(x=>x.high))});
    if(localHighs.length>=3&&localLows.length>=3){const hh=localHighs.slice(-3).map(x=>x.p),ll=localLows.slice(-3).map(x=>x.p);if(hh[0]>hh[1]&&hh[1]>hh[2]&&ll[0]<ll[1]&&ll[1]<ll[2])pattern.push({name:'潛在對稱三角形',status:'收盤突破前仍屬整理形態',level:(hh[2]+ll[2])/2});else if(hh[0]>=hh[1]&&hh[1]>=hh[2]&&ll[0]<ll[1]&&ll[1]<ll[2])pattern.push({name:'潛在下降楔形／收斂',status:'尚待突破確認',level:ll[2]});else if(hh[0]<hh[1]&&hh[1]<hh[2]&&ll[0]<=ll[1]&&ll[1]<=ll[2])pattern.push({name:'潛在上升楔形／上行收斂',status:'尚待突破確認',level:hh[2]});}
    const priorRange=recent.slice(0,-1),rangeHigh=Math.max(...priorRange.map(x=>x.high)),rangeLow=Math.min(...priorRange.map(x=>x.low)),rangePct=(rangeHigh-rangeLow)/Math.max(c.close,1e-12);
    if(rangePct<.08)pattern.push({name:'潛在箱體盤整',status:c.close>rangeHigh?'向上突破':c.close<rangeLow?'向下跌破':'仍在區間內',level:c.close>rangeHigh?rangeHigh:rangeLow});
    if(!pattern.length)pattern.push({name:upBOS?'向上結構突破':downBOS?'向下結構跌破':'尚無明確完整反轉形態',status:upBOS?'已收盤突破結構高點':downBOS?'已收盤跌破結構低點':'等待更多形態確認',level:upBOS?swingHigh:downBOS?swingLow:null});
    const orderBlockBull=[...candles.slice(-30,-1)].reverse().find(x=>x.close<x.open&&c.close>x.high),orderBlockBear=[...candles.slice(-30,-1)].reverse().find(x=>x.close>x.open&&c.close<x.low);
    const fvgBull=last>=2&&candles[last].low>candles[last-2].high?{low:candles[last-2].high,high:candles[last].low}:null;
    const fvgBear=last>=2&&candles[last].high<candles[last-2].low?{low:candles[last].high,high:candles[last-2].low}:null;
    const rangeMid=(rangeHigh+rangeLow)/2;
    return {symbol,interval,candles,close:c.close,change:(c.close-prev.close)/prev.close*100,candleTime:c.closeTime,ema:{e9:ema9[last],e21:ema21[last],e50:ema50[last],e200:ema200[last],bull:emaBull,bear:emaBear,crossUp:emaCrossUp,crossDown:emaCrossDown},rsi:rsi[last],rsiPrev:rsi[last-1],macd,rvol,avgVol,volume:c.volume,atr,vwap,obv:obv.at(-1),obvPrev:obv.at(-6),hh,hl,lh,ll,swingHigh,swingLow,priorHigh,priorLow,sweepHigh,sweepLow,upBOS,downBOS,longScore,shortScore,twoLong,twoShort,bullishCandle,bearishCandle,patterns:pattern,orderBlockBull,orderBlockBear,fvgBull,fvgBear,rangeHigh,rangeLow,rangeMid,premium:c.close>rangeMid,emaCrossUp,emaCrossDown,macdCrossUp,macdCrossDown};
}
function tfTrend(t){if(t.ema.bull&&t.close>t.ema.e200)return '偏多';if(t.ema.bear&&t.close<t.ema.e200)return '偏空';if(t.close>t.ema.e50&&t.ema.e9>t.ema.e21)return '短線偏多';if(t.close<t.ema.e50&&t.ema.e9<t.ema.e21)return '短線偏空';return '盤整/分歧';}
function analysisCard(title, lines, extra=''){return `<section class="analysis-card ${extra}"><h3>${title}</h3><ul>${lines.map(x=>`<li>${x}</li>`).join('')}</ul></section>`;}
function checkRow(label,ok,detail=''){const cls=ok===true?'analysis-pass':ok===false?'analysis-fail':'analysis-unknown',mark=ok===true?'成立':ok===false?'不成立':'資料不足';return `<div class="analysis-check"><span>${label}${detail?`：${detail}`:''}</span><strong class="${cls}">${mark}</strong></div>`;}
function renderAnalysis(symbol,primary,frames,rrMin,livePrice) {
    const t=primary,allFrames=[frames['1d'],frames['4h'],frames['1h'],frames['15m']].filter(Boolean),trend=allFrames.map(tfTrend);
    const longVotes=allFrames.filter(x=>tfTrend(x).includes('偏多')).length,shortVotes=allFrames.filter(x=>tfTrend(x).includes('偏空')).length;
    const mtfLong=longVotes>=3,mtfShort=shortVotes>=3,mtfText=mtfLong?'多週期偏多':mtfShort?'多週期偏空':'週期分歧';
    const longEvidence=[t.ema.bull||t.close>t.ema.e21,t.upBOS||t.sweepLow,t.rsi>50,t.macd.hist>0,t.rvol!=null&&t.rvol>=.8,t.twoLong];
    const shortEvidence=[t.ema.bear||t.close<t.ema.e21,t.downBOS||t.sweepHigh,t.rsi<50,t.macd.hist<0,t.rvol!=null&&t.rvol>=.8,t.twoShort];
    const longScore=t.longScore+(mtfLong?1:0),shortScore=t.shortScore+(mtfShort?1:0);
    const longModulesReady=Number.isFinite(t.rsi)&&!!t.macd&&Number.isFinite(t.rvol)&&Number.isFinite(t.atr)&&Number.isFinite(t.ema.e200)&&t.patterns.length>0;
    const shortModulesReady=longModulesReady;
    const recent=t.candles.slice(-20),support=Math.min(...recent.map(x=>x.low)),resistance=Math.max(...recent.map(x=>x.high));
    const direction=longModulesReady&&longScore>=6&&longScore>=shortScore+2&&t.twoLong&&mtfLong?'LONG':shortModulesReady&&shortScore>=6&&shortScore>=longScore+2&&t.twoShort&&mtfShort?'SHORT':'NONE';
    let entryLow=null,entryHigh=null,stop=null,tp1=null,tp2=null,rr1=null,rr2=null,rrOk=false;
    if(direction==='LONG'){entryLow=Math.min(t.close,t.ema.e21);entryHigh=Math.max(t.close,t.ema.e21);stop=Math.min(support,t.close-t.atr*1.5);const risk=entryHigh-stop;tp1=entryHigh+risk*rrMin;tp2=entryHigh+risk*Math.max(3,rrMin+1);rr1=(tp1-entryHigh)/risk;rr2=(tp2-entryHigh)/risk;rrOk=rr1>=rrMin&&tp1>resistance;}
    if(direction==='SHORT'){entryLow=Math.min(t.close,t.ema.e21);entryHigh=Math.max(t.close,t.ema.e21);stop=Math.max(resistance,t.close+t.atr*1.5);const risk=stop-entryLow;tp1=entryLow-risk*rrMin;tp2=entryLow-risk*Math.max(3,rrMin+1);rr1=(entryLow-tp1)/risk;rr2=(entryLow-tp2)/risk;rrOk=rr1>=rrMin&&tp1<support;}
    const finalDirection=direction!=='NONE'&&rrOk?'VALID': 'NONE';
    const status=finalDirection==='VALID'?(direction==='LONG'?(longScore>=8?'強勢做多候選':'做多候選'):(shortScore>=8?'強勢做空候選':'做空候選')):'觀望';
    const score=Math.max(longScore,shortScore),moduleNames=['形態學','SMC 結構','成交量','RSI','MACD','EMA'];
    const patternLines=t.patterns.map(p=>`${analysisEscape(p.name)}；${analysisEscape(p.status)}${p.level!=null?`（關鍵位 ${analysisFormat(symbol,p.level)}）`:''}`);
    const structureLines=[`市場結構：${t.hh?'HH':t.lh?'LH':'高點未確認'} / ${t.hl?'HL':t.ll?'LL':'低點未確認'}`,`BOS：${t.upBOS?'已向上突破':t.downBOS?'已向下跌破':'未確認'}`,`CHoCH / MSS：${t.sweepLow&&t.upBOS?'掃低後向上結構轉變':t.sweepHigh&&t.downBOS?'掃高後向下結構轉變':'尚無充分確認'}`,`Order Block：${t.orderBlockBull?`潛在多方 OB ${analysisFormat(symbol,t.orderBlockBull.low)}–${analysisFormat(symbol,t.orderBlockBull.high)}`:t.orderBlockBear?`潛在空方 OB ${analysisFormat(symbol,t.orderBlockBear.low)}–${analysisFormat(symbol,t.orderBlockBear.high)}`:'未辨識到收盤確認的 OB'}`,`FVG：${t.fvgBull?`潛在多方 ${analysisFormat(symbol,t.fvgBull.low)}–${analysisFormat(symbol,t.fvgBull.high)}`:t.fvgBear?`潛在空方 ${analysisFormat(symbol,t.fvgBear.low)}–${analysisFormat(symbol,t.fvgBear.high)}`:'最近 K 線未形成明確三 K 缺口'}`,`Liquidity Sweep：${t.sweepLow?'掃過前低後收回':t.sweepHigh?'掃過前高後收回':'未確認'}`,`Premium / Discount：${t.premium?'區間中位數上方（Premium）':'區間中位數下方（Discount）'}；中位 ${analysisFormat(symbol,t.rangeMid)}`,`Displacement：${Math.abs(t.change)>=1.5?'本根收盤變動顯著，需結合量能確認':'未見極端單根位移'}`];
    const volLines=[`RVOL：${Number.isFinite(t.rvol)?t.rvol.toFixed(2)+'×':'資料不足'}（相對前 20 根已收盤 K 線均量）${t.rvol>=2?'；異常放量':t.rvol<.7?'；縮量':'；一般量能'}`,`量價：${t.change>=0?'收盤價漲':'收盤價跌'} ${analysisPct(t.change)}，本根成交量 ${!Number.isFinite(t.rvol)?'資料不足':t.rvol>=1.2?'高於近期均量':t.rvol<.8?'低於近期均量':'接近近期均量'}`,`突破量能：${(t.upBOS||t.downBOS)&&t.rvol<1?'突破/跌破缺乏量能支持':'未發現明顯量能反對證據'}`,`OBV：${t.obv>t.obvPrev?'最近約 5 根累積上升':t.obv<t.obvPrev?'最近約 5 根累積下降':'方向不明確'}`,`VWAP(近 20 根)：${t.vwap?`${analysisFormat(symbol,t.vwap)}；收盤${t.close>t.vwap?'在上方':'在下方'}`:'無法計算'}`];
    const rsiLines=[`RSI(14)：${t.rsi.toFixed(1)}；${t.rsi>=70?'超買區':t.rsi<=30?'超賣區':t.rsi>50?'中軸上方偏強':'中軸下方偏弱'}`,`中軸：${t.rsi>50?'50 上方':t.rsi<50?'50 下方':'位於 50'}`,`RSI 方向：${t.rsi>t.rsiPrev?'上升':t.rsi<t.rsiPrev?'下降':'持平'}`,`頂/底背離：${detectRsiDivergence(t.candles)}`];
    const macdLines=[`MACD：${t.macd.line>t.macd.signal?'MACD 線在訊號線上方':'MACD 線在訊號線下方'}`,`交叉：${t.macdCrossUp?'黃金交叉':t.macdCrossDown?'死亡交叉':'本根未出現新交叉'}`,`柱狀圖：${t.macd.hist>0?'正值': '負值'}；${Math.abs(t.macd.hist)>Math.abs(t.macd.prevHist)?'動能擴大':'動能收斂'}`,`零軸：${t.macd.line>0?'零軸上方':'零軸下方'}`,`頂/底背離：${detectMacdDivergence(t.candles)}`];
    const emaLines=[`EMA 排列：${t.ema.bull?'9 > 21 > 50 > 200 多頭排列':t.ema.bear?'9 < 21 < 50 < 200 空頭排列':'均線未形成完整多空排列'}`,`EMA9/21：${t.ema.crossUp?'本根黃金交叉':t.ema.crossDown?'本根死亡交叉':t.ema.e9>t.ema.e21?'快線在上':'快線在下'}`,`現價相對均線：${t.close>t.ema.e9?'高於 EMA9':'低於 EMA9'}；${t.close>t.ema.e21?'高於 EMA21':'低於 EMA21'}；${t.close>t.ema.e50?'高於 EMA50':'低於 EMA50'}；${t.close>t.ema.e200?'高於 EMA200':'低於 EMA200'}`,`斜率：EMA9 ${t.ema.e9>t.ema.e21?'偏上':'偏弱'}；均線交叉須注意滯後與盤整噪音`];
    const longChecks=[['支撐／折價／掃低區',t.close<=t.rangeMid||t.sweepLow,'價格位置'],['多頭結構證據',t.upBOS||t.sweepLow,'BOS／掃低'],['動能至少一項支持',t.rsi>50||t.macd.hist>0||t.ema.e9>t.ema.e21,'RSI／MACD／EMA'],['量價未明顯反對',t.rvol>=.8&&!(t.upBOS&&t.rvol<1),'RVOL 與突破量能'],['兩根不同收盤 K 線確認',t.twoLong,'連續兩根偏多收盤'],['風險報酬比符合',finalDirection==='VALID'&&direction==='LONG',`最低 1:${rrMin}`]];
    const shortChecks=[['壓力／溢價／掃高區',t.close>=t.rangeMid||t.sweepHigh,'價格位置'],['空頭結構證據',t.downBOS||t.sweepHigh,'BOS／掃高'],['動能至少一項支持',t.rsi<50||t.macd.hist<0||t.ema.e9<t.ema.e21,'RSI／MACD／EMA'],['量價未明顯反對',t.rvol>=.8&&!(t.downBOS&&t.rvol<1),'RVOL 與跌破量能'],['兩根不同收盤 K 線確認',t.twoShort,'連續兩根偏空收盤'],['風險報酬比符合',finalDirection==='VALID'&&direction==='SHORT',`最低 1:${rrMin}`]];
    const multiLines=ANALYSIS_INTERVALS.map(iv=>frames[iv]?`${ANALYSIS_INTERVAL_LABELS[iv]}：${tfTrend(frames[iv])}；收盤 ${analysisFormat(symbol,frames[iv].close)}`:`${ANALYSIS_INTERVAL_LABELS[iv]}：資料不足`);
    const checksHtml=(arr)=>arr.map(x=>checkRow(x[0],x[1],x[2])).join('');
    const statusClass=status.includes('做多')?'long':status.includes('做空')?'short':'neutral';
    const time1=new Date(t.candles.at(-2).closeTime).toLocaleString('zh-TW',{hour12:false}),time2=new Date(t.candles.at(-1).closeTime).toLocaleString('zh-TW',{hour12:false});
    const entryText=finalDirection==='VALID'?`${analysisFormat(symbol,entryLow)} – ${analysisFormat(symbol,entryHigh)}`:'不提供：必要條件、兩根收盤確認或風報比未全部成立';
    const riskLines=[`停損參考：${finalDirection==='VALID'?analysisFormat(symbol,stop):'未提供'}`,`止盈目標：${finalDirection==='VALID'?`TP1 ${analysisFormat(symbol,tp1)}；TP2 ${analysisFormat(symbol,tp2)}`:'未提供'}`,`風險報酬比：${finalDirection==='VALID'?`TP1 約 1:${rr1.toFixed(2)}；TP2 約 1:${rr2.toFixed(2)}`:'不符合或無法計算'}`,`失效條件：${direction==='LONG'?`收盤跌破 ${analysisFormat(symbol,stop)} 或多頭結構失效`:direction==='SHORT'?`收盤突破 ${analysisFormat(symbol,stop)} 或空頭結構失效`:'等待有效方向後再定義結構失效點'}`,`最近支撐/壓力：${analysisFormat(symbol,support)} / ${analysisFormat(symbol,resistance)}`,`波動與假突破：ATR(14) ${analysisFormat(symbol,t.atr)}；${(!Number.isFinite(t.rvol)||t.rvol<1)?'量能偏弱/不足，假突破風險提高':'仍須觀察突破後回踩與收盤'}`];
    const result=document.getElementById('analysis-result');
    result.innerHTML=`<div class="analysis-summary"><div class="analysis-stat"><span>交易對 / 週期</span><strong>${analysisEscape(symbol)} · ${ANALYSIS_INTERVAL_LABELS[t.interval]}</strong></div><div class="analysis-stat"><span>已收盤 K 線價格</span><strong>${analysisFormat(symbol,t.close)}</strong><small>即時報價 ${analysisFormat(symbol,livePrice)}</small></div><div class="analysis-stat"><span>主要趨勢</span><strong>${trend[0]===trend[1]&&trend[1]===trend[2]?trend[0]:mtfText}</strong></div><div class="analysis-stat"><span>最終狀態</span><strong><span class="analysis-badge ${statusClass}">${status}</span></strong><small>多 ${longScore} 分 / 空 ${shortScore} 分（加權評分）</small></div></div>
    <div class="analysis-grid">${analysisCard('形態學',patternLines.concat([`區間支撐/壓力：${analysisFormat(symbol,t.rangeLow)} / ${analysisFormat(symbol,t.rangeHigh)}`,`形態失效：若收盤重新進入突破區或跌破/突破關鍵位，原判讀失效`]))}${analysisCard('SMC 智慧資金結構',structureLines)}${analysisCard('成交量與量價關係',volLines)}${analysisCard('RSI',rsiLines)}${analysisCard('MACD',macdLines)}${analysisCard('EMA 均線',emaLines)}${analysisCard('多週期一致性',multiLines.concat([`一致性結論：${mtfText}（不將不同週期當作同一確認條件）`]))}<section class="analysis-card"><h3>多頭條件檢查</h3>${checksHtml(longChecks)}</section><section class="analysis-card"><h3>空頭條件檢查</h3>${checksHtml(shortChecks)}</section><section class="analysis-card"><h3>訊號確認</h3><ul><li>第一根已收盤 K 線：${time1}（${t.candles.at(-2).close>t.candles.at(-2).open?'收漲':'收跌/平盤'}）</li><li>第二根已收盤 K 線：${time2}（${t.candles.at(-1).close>t.candles.at(-1).open?'收漲':'收跌/平盤'}）</li><li>連續兩根多頭確認：${t.twoLong?'成立':'不成立'}；空頭確認：${t.twoShort?'成立':'不成立'}</li><li>分析時間：${new Date().toLocaleString('zh-TW',{hour12:false})}</li></ul></section><section class="analysis-card"><h3>進場參考</h3><p>${entryText}</p><p class="analysis-muted">${finalDirection==='VALID'?'只作計畫參考；不得將分析訊號視為必須成交。':'目前不符合進場條件，建議觀望，不追價。'}</p></section><section class="analysis-card analysis-risk"><h3>風險管理</h3><ul>${riskLines.map(x=>`<li>${x}</li>`).join('')}</ul></section></div><p class="analysis-disclaimer">此分析屬於技術面情境評估，不保證行情走勢或獲利。SMC 訂單區塊、FVG、流動性與形態皆由 OHLCV 近似推估，並非交易所完整訂單流。請自行評估倉位、手續費、滑點與清算風險。</p>`;
}
function detectRsiDivergence(candles){if(candles.length<50)return '資料不足';const a=candles.slice(-50),p=analysisPivots(a,2),highs=p.highs.slice(-2),lows=p.lows.slice(-2),r=analysisRsi(a.map(x=>x.close));if(highs.length===2&&highs[1].p>highs[0].p&&r[highs[1].i]<r[highs[0].i])return '一般頂背離（動能減弱，非立即反轉保證）';if(lows.length===2&&lows[1].p<lows[0].p&&r[lows[1].i]>r[lows[0].i])return '一般底背離（動能減弱，非立即反轉保證）';if(highs.length===2&&highs[1].p<highs[0].p&&r[highs[1].i]>r[highs[0].i])return '潛在隱藏頂背離';if(lows.length===2&&lows[1].p>lows[0].p&&r[lows[1].i]<r[lows[0].i])return '潛在隱藏底背離';return '未辨識到清晰背離';}
function detectMacdDivergence(candles){if(candles.length<60)return '資料不足';const a=candles.slice(-60),closes=a.map(x=>x.close),m=analysisMacd(closes),p=analysisPivots(a,2);if(!m)return '資料不足';const highs=p.highs.slice(-2),lows=p.lows.slice(-2);if(highs.length===2&&highs[1].p>highs[0].p)return '需進一步比對 MACD 擺動高點；價格高點走高';if(lows.length===2&&lows[1].p<lows[0].p)return '需進一步比對 MACD 擺動低點；價格低點走低';return '未辨識到清晰背離';}
async function runTechnicalAnalysis(){
    const status=document.getElementById('analysis-status'),result=document.getElementById('analysis-result');if(!status||!result)return;
    if(analysisRunButton)analysisRunButton.disabled=true;
    try{
        const raw=document.getElementById('analysis-symbol').value||'BTCUSDT';const symbol=normalizeBinanceSymbol(raw);
        if(!symbol||!symbol.endsWith('USDT')||isExcludedStableSymbol(symbol))throw new Error('請輸入有效的 Binance USDT 現貨交易對，例如 BTCUSDT。');
        const interval=document.getElementById('analysis-interval').value,rrMin=Number(document.getElementById('analysis-min-rr').value)||2;
        status.textContent=`正在取得 ${symbol} 的已收盤 K 線與多週期數據…`;
        const intervals=[...new Set([...ANALYSIS_INTERVALS,interval])];
        const results=await Promise.all(intervals.map(async iv=>[iv,await fetchAnalysisCandles(symbol,iv,260)]));const rawFrames=Object.fromEntries(results);
        const frames={};for(const iv of intervals)frames[iv]=analyzeTimeframe(rawFrames[iv],symbol,iv);
        const primary=frames[interval];
        // Latest ticker is displayed as context only; signal confirmation always uses closed candles.
        let livePrice=primary.close;try{const r=await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'});if(r.ok){const j=await r.json();if(Number.isFinite(+j.price))livePrice=+j.price;}}catch{}
        renderAnalysis(symbol,primary,frames,rrMin,livePrice);
        status.textContent=`完成：${symbol} · ${ANALYSIS_INTERVAL_LABELS[interval]} · 已排除未收盤 K 線 · ${new Date().toLocaleString('zh-TW',{hour12:false})}`;
    }catch(e){status.textContent=`分析中止：${e.message||'未知錯誤'}`;result.innerHTML=`<div class="alert-empty"><strong>資料不足，觀望</strong><span>${analysisEscape(e.message||'無法完成分析')}。系統不會虛構訊號或進場價格，請確認交易對、網路與 Binance API 可用性後重試。</span></div>`;}
    finally{if(analysisRunButton)analysisRunButton.disabled=false;}
}
analysisRunButton?.addEventListener('click',runTechnicalAnalysis);
document.getElementById('analysis-symbol')?.addEventListener('keydown',e=>{if(e.key==='Enter')runTechnicalAnalysis();});
// Deliberately do not run scans or push notifications automatically: this is an on-demand analysis engine.
