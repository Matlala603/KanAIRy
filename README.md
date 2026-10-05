# KanAIRY — MetaTrader terminal in the browser

Trade with any MetaTrader 4 or 5 broker from a browser or phone. FastAPI backend, MetaApi for the broker link, a dependency-free JavaScript front end.

## What it does
- Searches every MT4/MT5 broker and server MetaApi knows, then connects with your account number, password and server.
- Live broker prices, account, positions, pending orders and deal history.
- Market, limit, stop and stop-limit orders with SL/TP; drag SL/TP/pending-order lines on the chart; partial close.
- Canvas chart: candles, hollow, Heikin-Ashi, bars, line, area; 9 timeframes; 25 indicators computed on real candles; drawing tools; price alerts.
- Without a broker connected: delayed public prices and charts (Yahoo Finance), news (publisher RSS feeds) and the economic calendar (FairEconomy).
- Strategy lab: rule-based strategies, deterministic backtest on real history, XML import/export, live signal alerts. It never places trades by itself.

## Run
```bash
cp .env.example .env     # fill in METAAPI_TOKEN and SESSION_SECRET
./start.sh               # or: ./deploy.sh (Docker)
```
Open http://localhost:8000. Heroku-style hosts use the `Procfile`.

| Variable | Purpose |
|---|---|
| `METAAPI_TOKEN` | Your MetaApi token (required) |
| `SESSION_SECRET` | Random 16+ character secret that signs session tokens (required) |
| `ALLOWED_ORIGINS` | Comma-separated extra origins for CORS; empty = same-origin only |

## Security notes
- The broker password is sent once to MetaApi, never stored or logged by this app. A salted scrypt proof is stored in the MetaApi account metadata so that re-linking an existing account requires the same password.
- Sessions are signed 7-day tokens kept in the browser (`localStorage`). Logout closes the server session but a stolen token stays valid until it expires; rotate `SESSION_SECRET` to invalidate all of them.
- Serve over HTTPS. Do not commit `.env`.
- Trading is risky. This is a tool, not advice.

## Tests (no network needed)
```bash
python3 tests/test_backend.py      # backend logic with fake MetaApi
node tests/indicators_check.mjs    # dump indicators for comparison with a reference
node tests/strategy_check.mjs      # backtest determinism and accounting
node tests/mock_server.mjs & node tests/ui_smoke.mjs   # UI in Chromium against a mock API (needs playwright)
```
`tests/mock_server.mjs` serves synthetic data for UI testing only and is not part of the app.

Built by Thakgalo Matlala, Soshanguve, Pretoria.
