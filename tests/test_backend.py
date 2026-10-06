"""Backend logic tests. Run: python3 tests/test_backend.py
Uses fake MetaApi objects (the real SDK needs network). Stubs httpx if absent."""
import asyncio, os, sys, time, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ["SESSION_SECRET"] = "x" * 32
try:
    import httpx  # noqa
except ImportError:
    stub = types.ModuleType("httpx")
    class _C:
        def __init__(self, *a, **k): pass
    stub.AsyncClient = _C
    class HTTPError(Exception): pass
    stub.HTTPError = HTTPError
    sys.modules["httpx"] = stub

import auth
from broker_manager import BrokerManager, BrokerSession, ApiError, explain_error
from public_data import aggregate

def run(c): return asyncio.get_event_loop().run_until_complete(c) if False else asyncio.run(c)

# ---- tokens
t = auth.sign_token({"login": "123", "server": "S"})
assert auth.verify_token(t)["login"] == "123"
assert auth.verify_token(t[:-2] + "xx") is None
assert auth.verify_token("garbage") is None
assert auth.verify_token(auth.sign_token({"a": 1}, ttl=-5)) is None
p, s = t.split("."); import base64, json
forged = base64.urlsafe_b64encode(json.dumps({"login": "999", "exp": 9999999999}).encode()).decode().rstrip("=") + "." + s
assert auth.verify_token(forged) is None
print("tokens ok")

# ---- aggregate (1h -> 4h aligned to UTC)
rows = [{"t": 1700000000 - 1700000000 % 3600 + i * 3600, "o": i, "h": i + 2, "l": i - 1, "c": i + 1, "v": 1} for i in range(8)]
agg = aggregate(rows, 14400)
assert all(a["t"] % 14400 == 0 for a in agg)
assert sum(a["v"] for a in agg) == 8 and agg[0]["l"] <= agg[0]["o"]
print("aggregate ok")

# ---- fake broker
class Term:
    account_information = {"login": "123", "balance": 1000, "equity": 1010, "margin": 10, "freeMargin": 1000, "currency": "USD", "leverage": 500, "broker": "Fake Ltd", "server": "Fake-Live"}
    positions = [{"id": 7, "symbol": "EURUSD", "type": "POSITION_TYPE_SELL", "volume": 0.1, "openPrice": 1.1, "currentPrice": 1.09, "profit": 10, "time": "2026-10-01T10:00:00+00:00", "stopLoss": 1.2}]
    orders = [{"id": 9, "symbol": "EURUSD", "type": "ORDER_TYPE_BUY_LIMIT", "currentVolume": 0.2, "openPrice": 1.05}]
    specifications = [{"symbol": "EURUSD", "path": "Forex\\Majors\\EURUSD", "minVolume": 0.01, "maxVolume": 50, "digits": 5}]
    def price(self, s): return {"bid": 1.0, "ask": 1.1, "time": time.time()} if s == "EURUSD" else None
class Conn:
    terminal_state = Term()
    calls = []
    history = []
    fail_next = None
    async def subscribe_to_market_data(self, *a): self.calls.append(("sub", a))
    async def get_symbol_price(self, s): return None
    async def get_symbol_specification(self, s): return Term.specifications[0]
    async def create_market_buy_order(self, *a):
        self.calls.append(("mbuy", a))
        if Conn.fail_next:
            exc, Conn.fail_next = Conn.fail_next, None; raise exc
        return {"orderId": "1", "positionId": "2", "stringCode": "TRADE_RETCODE_DONE"}
    async def create_limit_sell_order(self, *a): self.calls.append(("lsell", a)); return {"orderId": "3"}
    async def close_position_partially(self, i, v): self.calls.append(("part", i, v)); return {}
    async def close_position(self, i): self.calls.append(("close", i)); return {}
    async def modify_position(self, i, sl, tp): self.calls.append(("modpos", i, sl, tp)); return {}
    async def modify_order(self, i, p, sl, tp): self.calls.append(("modord", i, p, sl, tp)); return {}
    async def get_history_orders_by_time_range(self, a, b): return {"historyOrders": Conn.history, "synchronizing": False}
    async def get_positions(self): return Term.positions
    async def get_orders(self): return Term.orders
    async def get_deals_by_time_range(self, a, b): return {"deals": [
        {"id": 1, "type": "DEAL_TYPE_BUY", "symbol": "EURUSD", "entryType": "DEAL_ENTRY_IN", "volume": .1, "price": 1.1, "profit": 0, "time": "2026-10-01T10:00:00Z"},
        {"id": 2, "type": "DEAL_TYPE_BALANCE", "profit": 500, "time": "2026-09-01T10:00:00Z"}]}
class Acct:
    async def get_historical_candles(self, sym, tf, start, limit):
        from datetime import datetime, timezone
        return [{"time": datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc), "open": 1, "high": 2, "low": .5, "close": 1.5, "tickVolume": 5} for i in (2, 0, 1, 1)]

sess = BrokerSession("k", Acct(), Conn(), {"login": "123", "server": "Fake-Live", "platform": "mt5"})
async def main():
    a = await sess.account_info(); assert a["marginLevel"] == 10100 and a["broker"] == "Fake Ltd"
    p = (await sess.positions())[0]; assert p["side"] == "sell" and p["openTime"] == 1790848800 - 0 or p["openTime"] > 0
    o = (await sess.orders())[0]; assert o["type"] == "buy_limit" and o["side"] == "buy"
    sy = (await sess.symbols())[0]; assert sy["category"] == "Forex"
    q = await sess.quotes(["EURUSD", "NOPE"]); assert q["EURUSD"]["ask"] == 1.1 and "NOPE" not in q
    c = await sess.candles("EURUSD", "H1", 100, None); assert [x["t"] for x in c] == sorted({x["t"] for x in c}) and len(c) == 3
    h = await sess.history(30); assert h[0]["kind"] == "deal" and h[1]["kind"] == "balance"
    r = await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.1, "stopLoss": 1.0}); assert r["positionId"] == "2"
    await sess.place_order({"symbol": "EURUSD", "side": "sell", "type": "limit", "volume": 0.1, "price": 1.2})
    for bad in ({"volume": 0.001}, {"volume": 99}, {"type": "limit"}):
        req = {"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.1}; req.update(bad)
        try: await sess.place_order(req); raise SystemExit("should reject %s" % bad)
        except ApiError as e: assert e.status == 400
    await sess.close_position("7", 0.05); await sess.close_position("7", None)
    assert [c[0] for c in Conn.calls if c[0] in ("part", "close")] == ["part", "close"]
    # connect job with fake api
    class FakeAcc:
        state = "CREATED"; login = "123"; server = "Fake-Live"; metadata = None
        async def deploy(self): self.state = "DEPLOYED"
        async def wait_connected(self, *a): pass
        async def reload(self): pass
        connection_status = "CONNECTED"
        replicas = []
        def get_streaming_connection(self): return FakeConn()
    class FakeConn(Conn):
        async def connect(self): pass
        async def wait_synchronized(self, *a): pass
    class MtApi:
        created = 0
        async def get_accounts_with_infinite_scroll_pagination(self, f): return [] if not MtApi.created else [FakeAcc()]
        async def create_account(self, d):
            MtApi.created += 1; assert d["platform"] == "mt5" and set(d["metadata"]["kanairy"]) == {"v", "salt", "hash"}; FakeAcc.metadata = d["metadata"]; return FakeAcc()
    api = types.SimpleNamespace(metatrader_account_api=MtApi())
    m = BrokerManager("tok", api=api, http=object())
    async def ready(s, info): return auth.sign_token({"login": s.info["login"], "server": s.info["server"]})
    jid, key = await m.start_connect("123", "pw", "Fake-Live", "mt5", "Fake", ready)
    # the job id alone must not reveal anything
    for bad_key in ("", "nope", "x" * 40):
        try: m.job(jid, bad_key); raise SystemExit("job readable without the poll key")
        except ApiError as e: assert e.status == 404
    try: m.job("0" * 32, key); raise SystemExit("unknown job")
    except ApiError as e: assert e.status == 404
    for _ in range(50):
        await asyncio.sleep(0.02)
        j = m.job(jid, key)
        if j["state"] in ("ready", "failed"): break
    assert j["state"] == "ready", j
    assert "poll_hash" not in j and auth.verify_token(j["token"])["login"] == "123"
    again = m.job(jid, key); assert again["state"] == "ready" and "token" not in again   # token is one-time
    assert not any("token" in v for v in m.jobs.values())
    s2 = await m.session_for(auth.verify_token(j["token"])); assert s2 is m.sessions[m.key("123", "Fake-Live")]
    m.sessions.clear()
    s3 = await m.session_for({"login": "123", "server": "Fake-Live"}); assert s3  # re-attach without password
    # existing account: wrong password must NOT yield a session; right one must
    for pw, want in (("wrong", "failed"), ("pw", "ready")):
        jid, key = await m.start_connect("123", pw, "Fake-Live", "mt5", "Fake", ready)
        for _ in range(100):
            await asyncio.sleep(0.02)
            if m.job(jid, key)["state"] in ("ready", "failed"): break
        assert m.job(jid, key)["state"] == want, (pw, m.job(jid, key))
        if want == "failed": assert m.job(jid, key)["code"] == "bad_credentials" and "token" not in m.job(jid, key)
    FakeAcc.metadata = None  # account linked elsewhere (no proof): refuse
    jid, key = await m.start_connect("123", "pw", "Fake-Live", "mt5", "Fake", ready)
    for _ in range(100):
        await asyncio.sleep(0.02)
        if m.job(jid, key)["state"] in ("ready", "failed"): break
    assert m.job(jid, key)["state"] == "failed"
    # unchanged SL/TP are filled from live state; partial >= volume becomes full close; step enforced
    Conn.calls.clear()
    await sess.modify_position("7", 1.15, None); assert Conn.calls[-1] == ("modpos", "7", 1.15, 0)
    await sess.modify_position("7", None, 1.0); assert Conn.calls[-1] == ("modpos", "7", 1.2, 1.0)
    await sess.modify_order("9", 1.04, None, None); assert Conn.calls[-1] == ("modord", "9", 1.04, 0, 0)
    try: await sess.modify_position("999", 1, 1); raise SystemExit("should 404")
    except ApiError as e: assert e.status == 404
    await sess.close_position("7", 0.1); assert Conn.calls[-1][0] == "close"
    Term.specifications[0]["volumeStep"] = 0.01
    try: await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.015}); raise SystemExit("step")
    except ApiError as e: assert e.status == 400
    await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.07})
    # ---- idempotency: same clientOrderId => one order at the broker
    class TimeoutException(Exception): pass
    Conn.calls.clear()
    req = {"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.07, "clientOrderId": "abcdef123456"}
    r1 = await sess.place_order(dict(req)); r2 = await sess.place_order(dict(req))
    assert len([c for c in Conn.calls if c[0] == "mbuy"]) == 1 and r2["duplicate"] and r2["positionId"] == r1["positionId"]
    assert Conn.calls[0][1][-1]["clientId"] == "abcdef123456"
    # two identical requests racing each other still place a single order
    Conn.calls.clear(); req["clientOrderId"] = "race1234abcd"
    await asyncio.gather(sess.place_order(dict(req)), sess.place_order(dict(req)))
    assert len([c for c in Conn.calls if c[0] == "mbuy"]) == 1
    # timeout where the order DID go through: reconciled from the live state, reported as success, not retried
    Conn.calls.clear(); Conn.fail_next = TimeoutException("Timed out"); req["clientOrderId"] = "lost0000resp1"
    saved = list(Term.positions); Term.positions = saved + [{"id": 55, "symbol": "EURUSD", "clientId": "lost0000resp1", "type": "POSITION_TYPE_BUY", "volume": 0.07, "openPrice": 1.1, "currentPrice": 1.1, "profit": 0, "time": "2026-10-01T10:00:00+00:00"}]
    r = await sess.place_order(dict(req)); assert r["ok"] and r["positionId"] == "55" and r["reconciled"]
    assert (await sess.order_status("lost0000resp1"))["status"] == "executed"
    assert len([c for c in Conn.calls if c[0] == "mbuy"]) == 1
    # timeout where nothing happened: honest "unknown", and a retry is refused until the user checks
    Term.positions = saved; Conn.calls.clear(); Conn.fail_next = TimeoutException("Timed out"); req["clientOrderId"] = "nothing00here"
    try: await sess.place_order(dict(req)); raise SystemExit("should be unclear")
    except ApiError as e: assert e.code == "order_unknown", e.code
    try: await sess.place_order(dict(req)); raise SystemExit("retry must not auto-resubmit")
    except ApiError as e: assert e.code == "order_unknown" and e.status == 409
    assert len([c for c in Conn.calls if c[0] == "mbuy"]) == 1
    assert (await sess.order_status("nothing00here"))["status"] == "unknown"
    # a definite broker refusal is not "unknown"
    class TradeException(Exception): string_code = "TRADE_RETCODE_NO_MONEY"; message = "No money"
    Conn.fail_next = TradeException("No money"); req["clientOrderId"] = "refused0000a1"
    try: await sess.place_order(dict(req)); raise SystemExit("refused")
    except ApiError as e: assert e.status == 400 and e.code == "TRADE_RETCODE_NO_MONEY"
    assert (await sess.order_status("refused0000a1"))["status"] == "not_executed"
    # pending orders: stops on the wrong side of the entry are refused before reaching the broker
    for bad in ({"side": "buy", "price": 1.0, "stopLoss": 1.05}, {"side": "sell", "price": 1.0, "takeProfit": 1.05}):
        r_ = {"symbol": "EURUSD", "type": "limit", "volume": 0.1}; r_.update(bad)
        try: await sess.place_order(r_); raise SystemExit("bad stops")
        except ApiError as e: assert e.status == 400
    print("idempotency ok")
    for bad in (("12", "pw", "S", "mt5"), ("123", "", "S", "mt5"), ("123", "pw", "S", "mt6")):
        try: await m.start_connect(*bad, "", ready); raise SystemExit("should reject")
        except ApiError: pass
    assert explain_error(Exception("E_AUTH Authorization failed")).status == 401
    print("broker manager ok")
asyncio.run(main())
