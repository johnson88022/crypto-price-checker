# Cloudflare Worker 部署與行情備援說明

本次修正 `src/index.js` 的告警 Worker：

- Binance 回報 HTTP 451 時，記錄限制狀態供診斷，但不再因此跳過所有後續掃描。
- 已有 451 快取時，改先嘗試 Coinbase Exchange 公開行情端點，不會持續重試受限的 Binance。
- 價格與 K 線 API 都使用相同備援層；4 小時 K 線由 Coinbase 的 1 小時 K 線聚合。
- Coinbase 不一定提供每個幣種的 USDT 交易對。若替代來源也沒有該交易對，該筆任務會回報錯誤，不會偽造行情。

部署：在 `worker/` 目錄執行 `npx wrangler deploy`。部署後檢查 `/api/scan/status`、`/api/prices?symbols=BTCUSDT,ETHUSDT` 與 `/api/recommendations?symbols=BTCUSDT&interval=1h`。

注意：這項變更只修正 Cloudflare Worker 後端。若你使用 Docker/Node 的 `server.js` 常駐告警模式，該模式仍直接依賴 Binance，需另外套用同等備援；此 ZIP 不會自動替你部署 Worker，也不會更改任何交易所帳戶或地區資格。
