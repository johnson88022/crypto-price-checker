const LIVE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "PEPEUSDT", "ADAUSDT", "SUIUSDT"];

/** Binance USDT 現貨 — 市值前 20（固定清單） */
const TOP20_SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "TRXUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "HBARUSDT",
    "SHIBUSDT",
    "DOTUSDT",
    "POLUSDT",
    "LTCUSDT",
    "BCHUSDT",
    "UNIUSDT",
    "NEARUSDT",
    "APTUSDT",
    "SUIUSDT",
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
            <td id="${symbol.toLowerCase()}-okx">…</td>
        </tr>`
    ).join("");
}

async function updatePrices() {
    await Promise.all(
        LIVE_SYMBOLS.map(async (symbol) => {
            const b = document.getElementById(`${symbol.toLowerCase()}-binance`);
            const o = document.getElementById(`${symbol.toLowerCase()}-okx`);
            if (!b || !o) return;
            const [binance, okx] = await Promise.all([getBinancePrice(symbol), getOkxPrice(symbol)]);
            b.textContent = binance;
            o.textContent = okx;
        })
    );
}

async function getFearGreedIndex() {
    try {
        const response = await fetch("https://api.alternative.me/fng/?limit=1&format=json");
        const data = await response.json();
        if (!data?.data?.length) throw new Error("API 回傳數據格式錯誤");
        const indexValue = parseInt(data.data[0].value, 10);
        return Number.isNaN(indexValue) ? null : indexValue;
    } catch (error) {
        console.error("獲取恐慌指數失敗:", error);
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
    const order = ["市值", "漲幅", "跌幅", "自訂"];
    const labels = { 市值: "tag-cap", 漲幅: "tag-up", 跌幅: "tag-down", 自訂: "tag-custom" };
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
    metaEl.textContent = "查詢中…（市值 20＋漲幅 15＋跌幅 15＋自訂，請稍候）";
    document.getElementById("kline-compare-table").hidden = true;

    try {
        const priceMap = await fetchAllBinancePrices();
        const seedSymbols = [...new Set([...TOP20_SYMBOLS, ...customSymbols])];

        metaEl.textContent = "掃描漲幅／跌幅榜中…";
        const { gainerSymbols, loserSymbols, cache: moverCache } = await resolveTopMoverSymbols(
            interval,
            userTimeMs,
            priceMap,
            seedSymbols
        );

        const tagMap = new Map();
        TOP20_SYMBOLS.forEach((s) => addSymbolTag(tagMap, s, "市值"));
        customSymbols.forEach((s) => addSymbolTag(tagMap, s, "自訂"));
        gainerSymbols.forEach((s) => addSymbolTag(tagMap, s, "漲幅"));
        loserSymbols.forEach((s) => addSymbolTag(tagMap, s, "跌幅"));

        const allSymbols = [
            ...new Set([...TOP20_SYMBOLS, ...customSymbols, ...gainerSymbols, ...loserSymbols]),
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
                · 共 ${allSymbols.length} 檔（市值 20＋漲 ${gainerSymbols.length}＋跌 ${loserSymbols.length}${customSymbols.length ? `＋自訂 ${customSymbols.length}` : ""}）
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

document.getElementById("kline-btn").addEventListener("click", queryKlineChangeToNow);

initKlineDateTimePickers();
renderLivePriceTable();
updateUI();
updatePrices();
setInterval(() => {
    updateUI();
    updatePrices();
}, 5000);
