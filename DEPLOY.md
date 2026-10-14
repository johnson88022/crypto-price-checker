# Crypto Price Checker V5 — 後端與手機推播部署

## 本版本實作
- 後端常駐每 60 秒掃描 Binance 所有可交易 USDT 現貨對（不再限制 30 種）；以成交額門檻 `MIN_QUOTE_VOLUME=0` 預設不排除低成交額幣種。
- 排除 USD 穩定幣作為 base asset 的交易對（如 USDCUSDT、FDUSDUSDT、DAIUSDT 等）及槓桿代幣。
- EMA、MACD 柱體連續變化、RSI 位置/方向、相對成交量、價格與 EMA21 的位置綜合計分；15m／1h／4h 任一週期達門檻就建立該週期獨立訊號。
- 異常警示與定投均價跨零事件寫入 `data/state.json`，重新整理或重啟後仍保留；同一訊號以 K 線收盤時間去重。
- 後端透過 Web Push 發送通知，瀏覽器/App 不必保持開啟；前提是服務部署在 HTTPS 網域（localhost 開發除外）、使用者先授權通知並訂閱。
- `data/vapid.json` 首次啟動自動建立，請持續保留 `data/` volume，否則既有訂閱將失效。

## 部署方式（Docker）
1. 將整個專案放到可執行 Docker Compose 的 Linux 主機。
2. 編輯 `docker-compose.yml` 的 `VAPID_SUBJECT`，改成管理者可聯絡的 mailto 地址。
3. 執行：
   ```bash
   docker compose up -d --build
   docker compose logs -f crypto-price-checker
   ```
4. 服務預設在 `http://主機IP:8080`。要讓 iPhone/Android 在關閉頁面後收到推播，請把它放到有有效 TLS 憑證的 HTTPS 網域，並用 Nginx/Caddy 反向代理至 `127.0.0.1:8080`。不要把未加密的 LAN IP 當作正式推播網址。
5. 在手機瀏覽器開啟 HTTPS 網址，允許通知，再按「啟用手機／桌面通知」。iOS 需要先將網站加入主畫面並從主畫面開啟，才支援 Web Push；一般 Safari 分頁的支援依系統版本而異。
6. 驗證：開啟 `https://你的網域/api/health`，確認 `ok: true`、`lastScanAt` 有更新。`lastScanErrors` 是 Binance API 受限、網路或個別交易對資料不足的數量。

## Nginx 反向代理範例
```nginx
server {
    listen 443 ssl http2;
    server_name crypto.example.com;
    # ssl_certificate /path/fullchain.pem;
    # ssl_certificate_key /path/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 注意
- 這個 ZIP 含可部署後端，不代表已經替你部署到公網主機；需由你放到自己的伺服器並提供 HTTPS 網域後，關閉 App 推播才會真正運作。
- 每分鐘全市場掃描會受 Binance API 限流、網路延遲及交易所可用性影響。系統會避免重疊掃描並記錄錯誤；實際每輪完成時間可在容器日誌查看。
- 技術指標只作規則式風險篩選，不保證獲利，也不構成投資建議。
