# Crypto Price Checker — 低頻 API 與背景推播部署

## 本版本實作
- 後端每 60 秒取得一次 24 小時市場摘要，只監控成交額排名前 40 且達到成交額門檻的交易對。15 分鐘、1 小時、4 小時 K 線只在各自新 K 線形成後查詢，不會每分鐘重抓所有 K 線。
- 排除不適合此技術策略的資產類型與槓桿代幣。
- 告警需趨勢、MACD 強動能、RSI 方向、相對成交量至少 1.8 倍及 K 線方向全部一致，且單根 K 線漲跌幅不超過 2.5%；連續兩根已收盤 K 線同方向成立才告警。
- 技術告警寫入 `data/state.json`，重新整理或重啟後仍保留；同一訊號以 K 線收盤時間去重。定投均價跨零不再產生交易告警，以免弱訊號干擾。
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
- 系統每分鐘只抓一次市場摘要，K 線依週期節流；實際每輪完成時間與錯誤數可在容器日誌查看。若要更低 API 用量，可將 `SCAN_INTERVAL_MS` 設為 `120000` 或 `180000`，但通知延遲也會增加。
- 技術指標只作規則式風險篩選，不保證獲利，也不構成投資建議。


## Binance 地區限制備援（Cloudflare Worker）
Worker 的行情客戶端在 Binance HTTP 451 或既有限制快取時會改用 Coinbase Exchange 公開行情。不同交易所的交易對與流動性可能不同；若 Coinbase 不支援該 USDT 交易對，該筆資料會顯示錯誤。此備援目前只套用於 Cloudflare Worker；Docker/Node 的 `server.js` 仍使用 Binance API。
