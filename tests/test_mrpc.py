"""MetaRPC adapter tests against a fake gateway (httpx MockTransport; no network).
Run: python3 tests/test_mrpc.py"""
import asyncio, json, logging, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ["SESSION_SECRET"] = "x" * 32
try:
    import httpx  # noqa
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__)); import httpx_stub  # noqa
    import httpx
from broker_manager import ApiError
from mrpc_manager import MrpcManager

SID = "11111111-2222-3333-4444-555555555555"

class Gateway:
    def __init__(self):
        self.log, self.alive, self.bad_password = [], False, False
        self.opened = [
            {"ticket": 7, "symbol": "EURUSD", "type": "Buy", "lots": 0.1, "openPrice": 1.1, "closePrice": 1.101, "profit": 1.0,
             "stopLoss": 1.09, "takeProfit": 0, "openTime": "2026-10-01T10:00:00Z", "comment": "x"},
            {"ticket": 9, "symbol": "EURUSD", "type": "BuyLimit", "lots": 0.1, "openPrice": 1.05, "comment": ""},
        ]
        self.fail_send_after_accept = False
        self.stall = False
    def handler(self, req: httpx.Request) -> httpx.Response:
        path, q, h = req.url.path, dict(req.url.params), req.headers
        self.log.append((path, q, dict(h)))
        assert h.get("apikey") == "KEY"
        if path == "/ConnectEx":
            if self.bad_password: return httpx.Response(400, json={"message": "Invalid account or password"})
            self.alive = True; return httpx.Response(200, json=SID)
        if path == "/Disconnect":
            self.alive = False; return httpx.Response(200, json="ok")
        if not self.alive or h.get("id") != SID:
            return httpx.Response(404, json={"message": "Terminal not connected"})
        if path == "/AccountSummary" and self.stall:
            self.stall = False
            return httpx.Response(400, json={"type": "TERMINAL_API_TIMEOUT", "errorCode": "TERMINAL_SCRIPT_NOT_POLLING", "errorMessage": "MQL script is not polling commands (last heartbeat was 30s ago)."})
        if path == "/AccountSummary": return httpx.Response(200, json={"balance": 1000, "equity": 1010, "margin": 10, "freeMargin": 1000, "currency": "USD", "leverage": 500, "login": 123456})
        if path == "/OpenedOrders": return httpx.Response(200, json=self.opened)
        if path == "/SymbolParams": return httpx.Response(200, json={"minVolume": 0.01, "maxVolume": 50, "volumeStep": 0.01, "digits": 5})
        if path == "/GetQuote": return httpx.Response(200, json={"bid": 1.1, "ask": 1.1002, "time": "2026-10-09T10:00:00Z"})
        if path == "/Symbols": return httpx.Response(200, json=["EURUSD", "XAUUSD"])
        if path == "/PriceHistory":
            return httpx.Response(200, json=[{"time": "2026-10-09T09:00:00Z", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tickVolume": 10},
                                              {"time": "2026-10-09T10:00:00Z", "open": 1.5, "high": 2, "low": 1, "close": 1.7, "tickVolume": 11}])
        if path == "/OrderSend":
            self.opened.append({"ticket": 100 + len(self.log), "symbol": q["symbol"], "type": q["operation"], "lots": float(q["volume"]), "openPrice": 1.1, "comment": q.get("comment", "")})
            if self.fail_send_after_accept: return httpx.Response(200, json={"ticket": 0}) if False else (_ for _ in ()).throw(httpx.ReadTimeout("slow"))
            return httpx.Response(200, json={"ticket": 555})
        if path in ("/OrderClose", "/OrderModify"): return httpx.Response(200, json={"message": "ok"})
        if path == "/OrderHistory": return httpx.Response(200, json=[
            {"ticket": 1, "type": "Buy", "symbol": "EURUSD", "lots": 0.1, "closePrice": 1.2, "profit": 5, "closeTime": "2026-10-02T10:00:00Z", "comment": ""},
            {"ticket": 2, "type": "Balance", "profit": 100, "closeTime": "2026-10-01T10:00:00Z", "comment": "deposit"}])
        return httpx.Response(404, json={"message": "nope"})

async def main():
    gw = Gateway()
    mgr = MrpcManager("KEY", http=httpx.AsyncClient(transport=httpx.MockTransport(gw.handler)), idle_seconds=1)
    # ---- connect job
    async def on_ready(session, info): return "TOKEN"
    job, poll = await mgr.start_connect("123456", "s3cret!pw", "Demo-Server", "mt5", "Demo", on_ready)
    for _ in range(50):
        st = mgr.job(job, poll)
        if st["state"] in ("ready", "failed"): break
        await asyncio.sleep(0.05)
    assert st["state"] == "ready" and st["token"] == "TOKEN", st
    assert mgr.job(job, poll).get("token") is None                      # token handed out once
    connect_calls = [c for c in gw.log if c[0] == "/ConnectEx"]
    assert connect_calls[0][1]["user"] == "123456" and connect_calls[0][1]["mtClusterName"] == "Demo-Server"
    claims = {"login": "123456", "server": "Demo-Server", "platform": "mt5"}
    sess = await mgr.session_for(claims)
    info = await sess.account_info(); assert info["balance"] == 1000 and info["marginLevel"] == 10100
    pos, ords = await sess.positions(), await sess.orders()
    assert len(pos) == 1 and pos[0]["side"] == "buy" and pos[0]["stopLoss"] == 1.09 and pos[0]["takeProfit"] is None
    assert len(ords) == 1 and ords[0]["type"] == "buy_limit" and ords[0]["price"] == 1.05
    n = len([c for c in gw.log if c[0] == "/OpenedOrders"]); await sess.positions(); await sess.orders()
    assert len([c for c in gw.log if c[0] == "/OpenedOrders"]) == n     # TTL cache: no extra calls
    q = await sess.quotes(["EURUSD"]); assert q["EURUSD"]["ask"] == 1.1002
    c = await sess.candles("EURUSD", "H1", 10, None); assert len(c) == 2 and c[0]["t"] < c[1]["t"] and c[1]["c"] == 1.7
    assert [s["symbol"] for s in await sess.symbols()] == ["EURUSD", "XAUUSD"]
    h = await sess.history(30); assert h[0]["kind"] == "deal" and h[1]["kind"] == "balance"
    # ---- trading: validation and request shape
    try: await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.015}); raise SystemExit("step")
    except ApiError as e: assert e.status == 400
    r = await sess.place_order({"symbol": "EURUSD", "side": "sell", "type": "stop", "volume": 0.1, "price": 1.0, "stopLoss": 1.05, "clientOrderId": "abcdef123456"})
    sent = [c for c in gw.log if c[0] == "/OrderSend"][-1][1]
    assert r["ok"] and sent["operation"] == "SellStop" and sent["comment"] == "kr:abcdef123456" and sent["stoploss"] == "1.05"
    r2 = await sess.place_order({"symbol": "EURUSD", "side": "sell", "type": "stop", "volume": 0.1, "price": 1.0, "stopLoss": 1.05, "clientOrderId": "abcdef123456"})
    assert r2["duplicate"] and len([c for c in gw.log if c[0] == "/OrderSend"]) == 1   # same clientOrderId = one order
    # a timeout after the gateway accepted the order is reconciled from live state, not retried
    gw.fail_send_after_accept = True
    r3 = await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.1, "clientOrderId": "lost0000resp1"})
    assert r3["ok"] and r3["reconciled"], r3
    gw.fail_send_after_accept = False
    await sess.modify_position("7", None, 1.2); m = [c for c in gw.log if c[0] == "/OrderModify"][-1][1]
    assert m["ticket"] == "7" and m["stoploss"] == "1.09" and m["takeprofit"] == "1.2"   # unchanged SL kept
    await sess.close_position("7", 0.05); assert [c for c in gw.log if c[0] == "/OrderClose"][-1][1]["lots"] == "0.05"
    await sess.close_position("7", 0.1); assert "lots" not in [c for c in gw.log if c[0] == "/OrderClose"][-1][1]  # >= full => full close
    await sess.cancel_order("9")
    try: await sess.modify_position("999", 1, 1); raise SystemExit("404")
    except ApiError as e: assert e.status == 404
    # ---- idle: terminal is stopped, session dropped, password kept in memory only
    sess.last_used = time.time() - 5
    await mgr.reap_idle()
    assert not gw.alive and not mgr.sessions and mgr._creds
    # ---- next request transparently starts the terminal again
    s2 = await mgr.session_for(claims); assert gw.alive and (await s2.account_info())["balance"] == 1000
    # ---- gateway loses the terminal mid-session: one transparent restart
    gw.alive = False
    assert (await s2.account_info() if False else await s2.positions()) is not None and gw.alive
    # ---- an unknown endpoint (404, no "terminal gone" text) must NOT restart the terminal over and over
    before = len([c for c in gw.log if c[0] == "/ConnectEx"])
    import mrpc_manager as mm
    saved_ep = dict(mm.EP); mm.EP["opened"] = "/NoSuchCall"; s2._cache.clear()
    for _ in range(3):
        try: await s2.positions(); raise SystemExit("should fail")
        except ApiError as e: assert e.code == "bad_endpoint", e.code
    assert len([c for c in gw.log if c[0] == "/ConnectEx"]) == before
    mm.EP.update(saved_ep); s2._cache.clear()
    # ---- AccountSummary shapes: nested / list-wrapped / alternate names
    for shape in ([{"accountBalance": 777, "accountEquity": 800}], {"result": {"balance": 777, "equity": 800}}, {"summary": {"Balance": 777, "Equity": 800}}):
        s2._cache.clear(); gw_account = shape
        async def fake(name, **p): return gw_account
        s2._call = fake
        a = await s2.account_info(); assert a["balance"] == 777 and a["equity"] == 800, (shape, a)
    del s2._call; s2._cache.clear()
    # ---- stalled terminal (real MetaRPC error): stop + start once, then the call succeeds
    s2.last_restart = 0; s2._cache.clear(); gw.stall = True
    stops = len([c for c in gw.log if c[0] == "/Disconnect"]); starts = len([c for c in gw.log if c[0] == "/ConnectEx"])
    assert (await s2.account_info())["balance"] == 1000
    assert len([c for c in gw.log if c[0] == "/Disconnect"]) == stops + 1 and len([c for c in gw.log if c[0] == "/ConnectEx"]) == starts + 1
    # ---- logout wipes everything
    await mgr.drop(claims); assert not mgr._creds and not gw.alive
    try: await mgr.session_for(claims); raise SystemExit("should need relink")
    except ApiError as e: assert e.status == 401 and e.code == "relink"
    # ---- bad password: friendly error, and the password never reaches the logs
    gw.bad_password = True
    records = []
    class H(logging.Handler):
        def emit(self, r): records.append(r.getMessage())
    logging.getLogger("kanairy.mrpc").addHandler(H()); logging.getLogger("kanairy.mrpc").setLevel(logging.INFO)
    job, poll = await mgr.start_connect("123456", "s3cret!pw", "Demo-Server", "mt5", "Demo", on_ready)
    for _ in range(50):
        st = mgr.job(job, poll)
        if st["state"] in ("ready", "failed"): break
        await asyncio.sleep(0.05)
    assert st["state"] == "failed" and st["code"] == "bad_credentials", st
    assert not any("s3cret" in m for m in records)
    try: mgr.job(job, "wrong"); raise SystemExit("poll key")
    except ApiError as e: assert e.status == 404
    # ---- MetaApi side: undeploy on idle
    from broker_manager import BrokerManager, BrokerSession
    calls = []
    class Acc:
        async def undeploy(self): calls.append("undeploy")
    class Conn:
        async def close(self): calls.append("close")
    bm = BrokerManager("t", api=object(), http=object())
    s = BrokerSession("k", Acc(), Conn(), {"login": "1", "server": "s", "platform": "mt5"}); s.last_used = time.time() - 5000
    bm.sessions["k"] = s; await bm.reap_idle(); assert calls == ["close", "undeploy"] and not bm.sessions
    print("mrpc tests ok")

asyncio.run(main())
