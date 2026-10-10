"""MetaRPC (mrpc.pro) broker manager: drop-in alternative to the MetaApi BrokerManager.

How it differs from MetaApi (read this before deploying)
- MetaRPC has no stored-account object. Every terminal is started with ConnectEx(login, password, server) and
  stopped with Disconnect. So the server keeps the MT password IN MEMORY ONLY (never on disk, never in the session
  token, never logged) for as long as the account is in use, which lets an idle terminal be shut down and started
  again on the next request. A server restart, a logout, or CRED_TTL_SECONDS without use wipes it and the user
  has to connect again.
- Idle protection: a session nobody touched for MRPC_IDLE_SECONDS (default 600) is disconnected (terminal stopped).
  Short TTL caches also cut the number of calls the 1-2 second browser polling would otherwise make.

Endpoint status
- VERIFIED in MetaRPC's public docs: host per platform, `APIKey` header, ConnectEx, Disconnect, the `id` header
  (terminal session id), and that AccountSummary and OrderSend exist.
- NOT VERIFIED: every other path / parameter / response field below (they follow the naming of the sibling MT REST
  APIs). They are all isolated in EP / the *_params helpers / the normalisers so a mismatch is a one-line fix.
  Run `python3 scripts/mrpc_probe.py` against a demo account first; it shows which calls work and their real shape.
"""
import asyncio
import json
import logging
import os
import re
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx

from broker_manager import (ApiError, BrokerManager, BrokerSession, ORDER_TYPES, TF_SECONDS, _epoch, _num,
                            explain_error)

# The password travels in ConnectEx's query string, and httpx logs every request URL at INFO. Silence that.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("kanairy.mrpc")
BUILD = "diag4-2026-10-10"
INSTANCE = uuid.uuid4().hex[:6]            # differs per running copy of the app: shows if two copies share the traffic
DIAG: "deque[str]" = deque(maxlen=60)     # recent failures / first replies, served by /api/health/mrpc when MRPC_DEBUG=1
log.warning("MetaRPC adapter loaded (build %s, instance %s)", BUILD, INSTANCE)

HOSTS = {"mt4": "https://mt4.mrpc.pro", "mt5": "https://mt5.mrpc.pro"}

# ---------------------------------------------------------------- endpoint table
EP = {
    "connect": "/ConnectEx",            # VERIFIED
    "disconnect": "/Disconnect",        # VERIFIED
    "account": "/AccountSummary",       # name VERIFIED, response fields not
    "opened": "/OpenedOrders",          # unverified
    "history": "/OrderHistory",         # unverified
    "symbols": "/Symbols",              # unverified
    "symbol_params": "/SymbolParams",   # unverified
    "quote": "/GetQuote",               # unverified
    "candles": "/PriceHistory",         # unverified
    "send": "/OrderSend",               # name VERIFIED, params not
    "close": "/OrderClose",             # unverified (also used to cancel a pending order)
    "modify": "/OrderModify",           # unverified
}
TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D1": 1440, "W1": 10080, "MN": 43200}

OP_BY_INT = {0: "buy", 1: "sell", 2: "buylimit", 3: "selllimit", 4: "buystop", 5: "sellstop",
             6: "buystoplimit", 7: "sellstoplimit"}
OPERATION = {("buy", "market"): "Buy", ("sell", "market"): "Sell", ("buy", "limit"): "BuyLimit",
             ("sell", "limit"): "SellLimit", ("buy", "stop"): "BuyStop", ("sell", "stop"): "SellStop",
             ("buy", "stop_limit"): "BuyStopLimit", ("sell", "stop_limit"): "SellStopLimit"}
BALANCE_TYPES = {"balance", "credit", "charge", "correction", "bonus", "deposit", "withdrawal"}
BAD_LOGIN = re.compile(r"password|invalid account|invalid login|authori[sz]|wrong|denied|incorrect|not found.*server|"
                       r"no connection|invalid.*server|account.*disabled", re.I)
SESSION_GONE = re.compile(r"not connected|no such (terminal|session)|unknown (id|terminal|session)|terminal.*(not|stopped)|"
                          r"session.*(expired|not found)|invalid id", re.I)
STALLED = re.compile(r"NOT_POLLING|not polling|TERMINAL_API_TIMEOUT|heartbeat", re.I)   # MetaRPC's terminal helper stopped answering
CID_TAG = "kr:"


class MrpcError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- tolerant readers
def _g(d: Any, *names: str, default: Any = None) -> Any:
    """Case-insensitive first-match field read."""
    if not isinstance(d, dict):
        return default
    low = {str(k).lower(): v for k, v in d.items()}
    for n in names:
        v = low.get(n.lower())
        if v is not None:
            return v
    return default


def _unwrap(res: Any) -> Any:
    for _ in range(3):
        if isinstance(res, dict):
            inner = _g(res, "result", "data", "value", "items")
            if inner is not None and len(res) <= 3:
                res = inner
                continue
        break
    return res


def _rows(res: Any, *keys: str) -> List[Dict[str, Any]]:
    res = _unwrap(res)
    if isinstance(res, dict):
        res = _g(res, *keys, default=[]) if keys else []
    return [r for r in (res or []) if isinstance(r, dict)]


def _flat(res: Any) -> Dict[str, Any]:
    """AccountSummary as one flat dict, whether the gateway wraps it in a list / result / nested object."""
    res = _unwrap(res)
    if isinstance(res, list):
        res = res[0] if res and isinstance(res[0], dict) else {}
    if not isinstance(res, dict):
        return {}
    out = dict(res)
    for v in res.values():
        if isinstance(v, dict):
            for k, x in v.items():
                out.setdefault(k, x)
    return out


def _optype(v: Any) -> str:
    """Normalise any order-type spelling to e.g. 'buylimit'."""
    if isinstance(v, (int, float)) and int(v) in OP_BY_INT:
        return OP_BY_INT[int(v)]
    s = re.sub(r"[^a-z]", "", str(v or "").lower().replace("ordertype", "").replace("positiontype", ""))
    return s


def _side(t: str) -> str:
    return "buy" if t.startswith("buy") else "sell"


def _pending(t: str) -> bool:
    return "limit" in t or "stop" in t


def _pretty_type(t: str) -> str:
    kind = "stop_limit" if "stoplimit" in t else "limit" if "limit" in t else "stop" if "stop" in t else ""
    return f"{_side(t)}_{kind}" if kind else _side(t)


# ---------------------------------------------------------------- HTTP client
class MrpcHttp:
    def __init__(self, api_key: str, http: Optional[httpx.AsyncClient] = None):
        self.api_key = api_key
        self.http = http or httpx.AsyncClient(timeout=15)
        self._logged: set = set()

    def _log_once(self, path: str, what: str, body: str = "", params: Optional[Dict[str, Any]] = None):
        """One WARNING per distinct (path, what): enough to diagnose in the host's logs without flooding them."""
        k = (path, what)
        if k in self._logged:
            return
        self._logged.add(k)
        keys = sorted((params or {}).keys())
        for secret_key in ("password",):
            body = body.replace(str((params or {}).get(secret_key, "\0")), "***")
        log.warning("MRPC %s %s | param names: %s | reply: %s", path, what, keys, body[:300])
        DIAG.append(f"{time.strftime('%H:%M:%S')} {path} {what} | params {keys} | reply {body[:300]}")

    async def call(self, platform: str, path: str, params: Optional[Dict[str, Any]] = None, sid: Optional[str] = None) -> Any:
        headers = {"APIKey": self.api_key}
        q = {k: v for k, v in (params or {}).items() if v is not None}
        if sid:
            headers["id"] = sid
            q.setdefault("id", sid)        # some deployments read the id from the query instead of the header
        try:
            r = await self.http.get(HOSTS[platform] + path, params=q, headers=headers)
        except httpx.TimeoutException as e:
            self._log_once(path, "TIMEOUT", "", q)
            raise ApiError(504, "The broker gateway did not answer in time. Try again.", "timeout") from e
        except httpx.HTTPError as e:
            self._log_once(path, f"UNREACHABLE {type(e).__name__}", "", q)
            raise ApiError(502, f"Could not reach {HOSTS[platform].split('//')[1]} ({type(e).__name__}). Check the server's internet access.", "upstream_error") from e
        text = r.text or ""
        if r.status_code in (401, 403) and not BAD_LOGIN.search(text):
            log.warning("MetaRPC refused the key: HTTP %s from %s%s -> %s", r.status_code, HOSTS[platform].split("//")[1], path, text[:200])
            raise ApiError(502, f"MetaRPC refused the API key (HTTP {r.status_code} from {HOSTS[platform].split('//')[1]}). Use the key from mrpc.pro/my > API Keys as MRPC_API_KEY, and check your plan covers {platform.upper()}.", "mrpc_auth")
        if r.status_code >= 400:
            self._log_once(path, f"HTTP {r.status_code}", text, q)
        if r.status_code == 429:
            raise ApiError(429, "The broker gateway is rate limiting requests. Wait a moment.", "rate_limited")
        if r.status_code >= 500:
            raise ApiError(502, "The MetaRPC gateway had an error. Try again.", "upstream_error")
        try:
            body = r.json()
        except ValueError:
            body = text.strip().strip('"')
        if r.status_code >= 400:
            raise MrpcError(r.status_code, str(_g(body, "message", "error", "detail") or body)[:300])
        if isinstance(body, dict):                      # some gateways answer 200 with an error object
            err = _g(body, "error", "errorMessage")
            if err and not _g(body, "result", "data", "id"):
                raise MrpcError(400, str(err)[:300])
        return body


def _parse_sid(res: Any) -> str:
    if isinstance(res, dict):
        res = _g(_unwrap(res), "terminalInstanceGuid", "id", "guid", "token", "sessionId", default=_unwrap(res))
    sid = str(res or "").strip().strip('"')
    if not re.fullmatch(r"[0-9A-Za-z\-_]{8,64}", sid):
        raise MrpcError(400, "The gateway did not return a terminal id.")
    return sid


# ---------------------------------------------------------------- session
class MrpcSession(BrokerSession):
    def __init__(self, key: str, mgr: "MrpcManager", sid: str, info: Dict[str, Any]):
        super().__init__(key, None, None, info)
        self.mgr = mgr
        self.sid = sid
        self.platform = info.get("platform", "mt5")
        self._cache: Dict[str, Any] = {}

    # --- transport with one transparent restart if the gateway lost the terminal
    async def _call(self, name: str, **params) -> Any:
        try:
            res = await self.mgr.client.call(self.platform, EP[name], params, self.sid)
            self.mgr._debug_seen(name, res)
            return res
        except MrpcError as e:
            self.mgr._debug_seen(name, f"HTTP {e.status}: {e.message}", failed=True)
            stalled = bool(STALLED.search(e.message))
            if stalled or SESSION_GONE.search(e.message):      # only an explicit "terminal gone / stalled" message restarts it
                await self.mgr._reconnect(self, stop_first=stalled)
                try:
                    return await self.mgr.client.call(self.platform, EP[name], params, self.sid)
                except MrpcError as e2:
                    raise self.mgr._as_api_error(e2)
            if e.status in (404, 405):                         # wrong path/verb: a code problem, not a lost terminal
                raise ApiError(502, f"The MetaRPC gateway has no call {EP[name]}. The server operator must correct it in mrpc_manager.py (EP table).", "bad_endpoint")
            raise self.mgr._as_api_error(e)

    async def _cached(self, name: str, ttl: float, fn):
        hit = self._cache.get(name)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        val = await fn()
        self._cache[name] = (time.time(), val)
        return val

    def _bust(self):
        self._cache.pop("opened", None)
        self._cache.pop("account", None)

    # --- account
    async def account_info(self) -> Dict[str, Any]:
        self.last_used = time.time()
        raw = _flat(await self._cached("account", 2.5, lambda: self._call("account")))
        if not any(k in {x.lower() for x in raw} for k in ("balance", "equity", "accountbalance", "accountequity")):
            self.mgr._warn_once("account-keys", "AccountSummary has no recognisable balance field; keys seen: %s" % sorted(raw)[:40])
        margin = _num(_g(raw, "margin", "accountMargin", "usedMargin"))
        equity = _num(_g(raw, "equity", "accountEquity"))
        return {
            "login": str(_g(raw, "login", "account", "accountNumber", default=self.info["login"])),
            "name": _g(raw, "name", "userName", "accountName", default="") or "",
            "broker": _g(raw, "company", "broker", "companyName", default="") or self.info.get("broker_name") or "",
            "server": _g(raw, "server", "serverName", default=self.info["server"]),
            "platform": self.platform,
            "currency": _g(raw, "currency", "accountCurrency", "depositCurrency", default="USD") or "USD",
            "leverage": _g(raw, "leverage", "accountLeverage"),
            "balance": _num(_g(raw, "balance", "accountBalance")),
            "equity": equity,
            "margin": margin,
            "freeMargin": _num(_g(raw, "freeMargin", "free_margin", "marginFree", "accountFreeMargin")),
            "marginLevel": (equity / margin * 100) if margin > 0 else None,
            "credit": _num(_g(raw, "credit", "accountCredit")),
            "tradeAllowed": not bool(_g(raw, "isInvestor", "investor", default=False)),
            "type": _g(raw, "accountType", "tradeMode"),
        }

    # --- positions and pending orders (both come from one OpenedOrders call)
    async def _opened(self) -> List[Dict[str, Any]]:
        return await self._cached("opened", 2.5, self._fetch_opened)

    async def _fetch_opened(self):
        return _rows(await self._call("opened"), "orders", "positions")

    @staticmethod
    def _ticket(r) -> str:
        return str(_g(r, "ticket", "id", "order", "positionId", default=""))

    async def positions(self) -> List[Dict[str, Any]]:
        self.last_used = time.time()
        out = []
        for r in await self._opened():
            t = _optype(_g(r, "type", "orderType", "cmd", "operation"))
            if not t or _pending(t):
                continue
            out.append({
                "id": self._ticket(r), "symbol": _g(r, "symbol"), "side": _side(t),
                "volume": _num(_g(r, "lots", "volume")), "openPrice": _num(_g(r, "openPrice", "priceOpen")),
                "currentPrice": _num(_g(r, "closePrice", "currentPrice", "priceCurrent")),
                "stopLoss": _g(r, "stopLoss", "sl") or None, "takeProfit": _g(r, "takeProfit", "tp") or None,
                "profit": _num(_g(r, "profit")), "swap": _num(_g(r, "swap")),
                "commission": _num(_g(r, "commission")),
                "openTime": _epoch(_g(r, "openTime", "time")), "comment": _g(r, "comment", default="") or "",
            })
        return out

    async def orders(self) -> List[Dict[str, Any]]:
        self.last_used = time.time()
        out = []
        for r in await self._opened():
            t = _optype(_g(r, "type", "orderType", "cmd", "operation"))
            if not t or not _pending(t):
                continue
            out.append({
                "id": self._ticket(r), "symbol": _g(r, "symbol"), "type": _pretty_type(t), "side": _side(t),
                "volume": _num(_g(r, "lots", "volume")), "price": _num(_g(r, "openPrice", "price")),
                "stopLimitPrice": _g(r, "stopLimitPrice", "stopLimit"),
                "stopLoss": _g(r, "stopLoss", "sl") or None, "takeProfit": _g(r, "takeProfit", "tp") or None,
                "currentPrice": _g(r, "closePrice", "currentPrice"),
                "time": _epoch(_g(r, "openTime", "time")), "expiration": _epoch(_g(r, "expiration", "expirationTime")),
                "comment": _g(r, "comment", default="") or "",
            })
        return out

    # --- symbols / specification / prices
    async def symbols(self) -> List[Dict[str, Any]]:
        raw = _unwrap(await self._cached("symbols", 600, lambda: self._call("symbols")))
        out = []
        for s in raw or []:
            d = s if isinstance(s, dict) else {"symbol": s}
            name = _g(d, "symbol", "name")
            if not name:
                continue
            path = str(_g(d, "path", "group", default="") or "").replace("\\", "/")
            parts = [p for p in path.split("/") if p]
            out.append({
                "symbol": name, "description": _g(d, "description", default="") or "", "path": path,
                "category": parts[0] if len(parts) > 1 else _guess_category(name),
                "digits": _g(d, "digits"), "tickSize": _g(d, "tickSize", "point"),
                "contractSize": _g(d, "contractSize"), "minVolume": _g(d, "minVolume", "lotsMin"),
                "maxVolume": _g(d, "maxVolume", "lotsMax"), "volumeStep": _g(d, "volumeStep", "lotsStep"),
                "baseCurrency": _g(d, "baseCurrency"), "profitCurrency": _g(d, "profitCurrency"),
                "tradeMode": _g(d, "tradeMode"),
            })
        return out

    async def spec(self, symbol: str) -> Dict[str, Any]:
        if symbol not in self.spec_cache:
            raw = _unwrap(await self._call("symbol_params", symbol=symbol))
            raw = raw[0] if isinstance(raw, list) and raw else raw
            self.spec_cache[symbol] = {
                "symbol": symbol, "digits": _g(raw, "digits"), "tickSize": _g(raw, "tickSize", "point"),
                "contractSize": _g(raw, "contractSize"), "minVolume": _g(raw, "minVolume", "lotsMin", "volumeMin"),
                "maxVolume": _g(raw, "maxVolume", "lotsMax", "volumeMax"),
                "volumeStep": _g(raw, "volumeStep", "lotsStep"),
            }
        return self.spec_cache[symbol]

    async def quotes(self, symbols: List[str]) -> Dict[str, Any]:
        self.last_used = time.time()
        sem = asyncio.Semaphore(8)

        async def one(sym: str):
            async def fetch():
                async with sem:
                    return _unwrap(await self._call("quote", symbol=sym))
            try:
                q = await self._cached("q:" + sym, 2.0, fetch)
            except (ApiError, MrpcError):
                return sym, None
            bid, ask = _num(_g(q, "bid")), _num(_g(q, "ask"))
            if not bid and not ask:
                return sym, None
            return sym, {"bid": bid, "ask": ask, "time": _epoch(_g(q, "time", "timestamp")) or int(time.time())}

        pairs = await asyncio.gather(*(one(s) for s in symbols[:60]))
        return {s: q for s, q in pairs if q}

    async def candles(self, symbol: str, timeframe: str, limit: int, before: Optional[int]) -> List[Dict[str, Any]]:
        if timeframe not in TF_MINUTES:
            raise ApiError(400, f"Unsupported timeframe {timeframe}")
        limit = max(1, min(limit, 1000))
        end = datetime.fromtimestamp(before, tz=timezone.utc) if before else datetime.now(timezone.utc) + timedelta(seconds=TF_SECONDS[timeframe])
        start = end - timedelta(seconds=TF_SECONDS[timeframe] * (limit + 5))
        raw = _rows(await self._call("candles", symbol=symbol, timeframe=TF_MINUTES[timeframe],
                                     **{"from": start.strftime("%Y-%m-%dT%H:%M:%S"), "to": end.strftime("%Y-%m-%dT%H:%M:%S")}),
                    "candles", "bars")
        rows, seen = [], set()
        for c in raw:
            t = _epoch(_g(c, "time", "timestamp", "openTime", "t"))
            if t is None or t in seen or (before and t >= before):
                continue
            seen.add(t)
            rows.append({"t": t, "o": _num(_g(c, "open", "o")), "h": _num(_g(c, "high", "h")),
                         "l": _num(_g(c, "low", "l")), "c": _num(_g(c, "close", "c")),
                         "v": _num(_g(c, "tickVolume", "volume", "v"))})
        rows.sort(key=lambda r: r["t"])
        return rows[-limit:]

    async def history(self, days: int) -> List[Dict[str, Any]]:
        days = max(1, min(days, 365))
        end = datetime.now(timezone.utc) + timedelta(minutes=5)
        start = end - timedelta(days=days)
        raw = _rows(await self._call("history", **{"from": start.strftime("%Y-%m-%dT%H:%M:%S"), "to": end.strftime("%Y-%m-%dT%H:%M:%S")}),
                    "orders", "history", "deals")
        out = []
        for d in raw:
            t = _optype(_g(d, "type", "orderType", "cmd", "operation"))
            when = _epoch(_g(d, "closeTime", "time", "openTime"))
            if t in BALANCE_TYPES or (not t.startswith(("buy", "sell"))):
                out.append({"id": self._ticket(d), "kind": "balance", "symbol": "", "time": when,
                            "profit": _num(_g(d, "profit")), "comment": _g(d, "comment", default="") or (t or "balance").title()})
                continue
            if _pending(t):
                continue
            out.append({"id": self._ticket(d), "kind": "deal", "symbol": _g(d, "symbol"), "side": _side(t), "entry": "out",
                        "volume": _num(_g(d, "lots", "volume")), "price": _num(_g(d, "closePrice", "price")),
                        "profit": _num(_g(d, "profit")), "swap": _num(_g(d, "swap")),
                        "commission": _num(_g(d, "commission")), "positionId": self._ticket(d),
                        "time": when, "comment": _g(d, "comment", default="") or ""})
        out.sort(key=lambda r: r["time"] or 0, reverse=True)
        return out

    # --- idempotency: the client order id rides in the order comment ("kr:<id>") and is searched for on a timeout
    async def find_by_client_id(self, cid: str) -> Optional[Dict[str, Any]]:
        tag = CID_TAG + cid
        self._cache.pop("opened", None)
        for r in await self._fetch_opened():
            if tag in str(_g(r, "comment", default="")):
                t = _optype(_g(r, "type", "orderType", "cmd", "operation"))
                tk = self._ticket(r)
                if _pending(t):
                    return {"status": "working", "orderId": tk, "positionId": ""}
                return {"status": "executed", "positionId": tk, "orderId": tk}
        try:
            end = datetime.now(timezone.utc) + timedelta(minutes=5)
            raw = _rows(await self._call("history", **{"from": (end - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S"),
                                                       "to": end.strftime("%Y-%m-%dT%H:%M:%S")}), "orders", "history", "deals")
            for r in raw:
                if tag in str(_g(r, "comment", default="")):
                    return {"status": "executed", "orderId": self._ticket(r), "positionId": self._ticket(r)}
        except Exception:  # noqa: BLE001 - history is a best-effort second look
            pass
        return None

    async def _place_order_raw(self, req: Dict[str, Any], cid: Optional[str]) -> Dict[str, Any]:
        symbol, side, otype = req["symbol"], req["side"], req["type"]
        volume = float(req["volume"])
        sl, tp = req.get("stopLoss"), req.get("takeProfit")
        price, limit_price = req.get("price"), req.get("stopLimitPrice")
        if side not in ("buy", "sell"):
            raise ApiError(400, "side must be buy or sell")
        if otype not in ORDER_TYPES:
            raise ApiError(400, "Unsupported order type")
        if volume <= 0:
            raise ApiError(400, "Volume must be greater than zero")
        try:
            spec = await self.spec(symbol)
        except (ApiError, MrpcError):
            spec = None
        if not spec or not (_num(spec.get("minVolume")) or _num(spec.get("volumeStep"))):
            raise ApiError(400, f"Could not read the contract specification for {symbol}. Try again in a moment.", "validation")
        vmin, vmax, vstep = _num(spec.get("minVolume")), _num(spec.get("maxVolume")), _num(spec.get("volumeStep"))
        if vstep and abs(round(volume / vstep) * vstep - volume) > 1e-9 * max(1, volume / vstep):
            raise ApiError(400, f"Volume for {symbol} must be a multiple of {vstep} lots")
        if vmin and volume < vmin - 1e-12:
            raise ApiError(400, f"Minimum volume for {symbol} is {vmin} lots")
        if vmax and volume > vmax + 1e-12:
            raise ApiError(400, f"Maximum volume for {symbol} is {vmax} lots")
        if otype != "market" and not price:
            raise ApiError(400, "A price is required for pending orders")
        if otype == "stop_limit" and not limit_price:
            raise ApiError(400, "A stop-limit price is required for stop-limit orders")
        if otype != "market":
            if sl and (sl >= price if side == "buy" else sl <= price):
                raise ApiError(400, "For a buy the stop loss must be below the entry price." if side == "buy" else "For a sell the stop loss must be above the entry price.", "validation")
            if tp and (tp <= price if side == "buy" else tp >= price):
                raise ApiError(400, "For a buy the take profit must be above the entry price." if side == "buy" else "For a sell the take profit must be below the entry price.", "validation")
        params = self._send_params(symbol, OPERATION[(side, otype)], volume, price, limit_price, sl, tp,
                                   (CID_TAG + cid) if cid else (req.get("comment") or "KanAIRY")[:26])
        res = _unwrap(await self._call("send", **params))
        self._bust()
        ticket = str(_g(res, "ticket", "order", "orderId", "id", default=res if isinstance(res, (int, str)) else "") or "")
        return {"ok": True, "orderId": ticket, "positionId": ticket if otype == "market" else "",
                "code": _g(res, "code", "retcode"), "message": _g(res, "message", default="Order accepted") or "Order accepted"}

    @staticmethod
    def _send_params(symbol, operation, volume, price, limit_price, sl, tp, comment) -> Dict[str, Any]:
        """OrderSend parameter names (unverified: adjust here if the probe shows different ones)."""
        return {"symbol": symbol, "operation": operation, "volume": volume, "price": price,
                "stoploss": sl, "takeprofit": tp, "stopLimitPrice": limit_price, "comment": comment}

    async def modify_position(self, position_id: str, sl, tp) -> Dict[str, Any]:
        cur = next((p for p in await self.positions() if p["id"] == str(position_id)), None)
        if cur is None:
            raise ApiError(404, "That position is no longer open.", "not_found")
        sl = cur["stopLoss"] if sl is None else sl
        tp = cur["takeProfit"] if tp is None else tp
        res = _unwrap(await self._call("modify", ticket=position_id, price=cur["openPrice"], stoploss=sl or 0, takeprofit=tp or 0))
        self._bust()
        return {"ok": True, "message": _g(res, "message", default="Position updated") or "Position updated"}

    async def close_position(self, position_id: str, volume: Optional[float]) -> Dict[str, Any]:
        if volume:
            cur = next((p for p in await self.positions() if p["id"] == str(position_id)), None)
            if cur is None:
                raise ApiError(404, "That position is no longer open.", "not_found")
            if volume >= cur["volume"] - 1e-12:
                volume = None
        res = _unwrap(await self._call("close", ticket=position_id, lots=volume or None))
        self._bust()
        return {"ok": True, "message": _g(res, "message", default="Position closed") or "Position closed"}

    async def cancel_order(self, order_id: str) -> Dict[str, Any]:
        res = _unwrap(await self._call("close", ticket=order_id))
        self._bust()
        return {"ok": True, "message": _g(res, "message", default="Order cancelled") or "Order cancelled"}

    async def modify_order(self, order_id: str, price, sl, tp) -> Dict[str, Any]:
        cur = next((o for o in await self.orders() if o["id"] == str(order_id)), None)
        if cur is None:
            raise ApiError(404, "That order is no longer pending.", "not_found")
        price = cur["price"] if price is None else price
        sl = cur["stopLoss"] if sl is None else sl
        tp = cur["takeProfit"] if tp is None else tp
        res = _unwrap(await self._call("modify", ticket=order_id, price=price, stoploss=sl or 0, takeprofit=tp or 0))
        self._bust()
        return {"ok": True, "message": _g(res, "message", default="Order updated") or "Order updated"}


def _guess_category(name: str) -> str:
    n = name.upper()
    if re.fullmatch(r"[A-Z]{6}[A-Z._0-9]{0,4}", n) and n[:3] in {"EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "ZAR"}:
        return "Forex"
    if n.startswith(("XAU", "XAG", "XPT", "XPD")):
        return "Metals"
    if n.startswith(("BTC", "ETH", "LTC", "XRP")):
        return "Crypto"
    if any(k in n for k in ("OIL", "BRENT", "WTI", "NGAS")):
        return "Energies"
    return "Other"


# ---------------------------------------------------------------- manager
class MrpcManager(BrokerManager):
    """Same public surface as BrokerManager, backed by MetaRPC."""

    def __init__(self, api_key: str, http: Optional[httpx.AsyncClient] = None, idle_seconds: int = 600, cred_ttl: int = 12 * 3600):
        self.token = api_key
        self.client = MrpcHttp(api_key, http)
        self.http = self.client.http
        self.idle_seconds = idle_seconds
        self.cred_ttl = cred_ttl
        self.sessions: Dict[str, MrpcSession] = {}
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._attach_locks: Dict[str, asyncio.Lock] = {}
        self._broker_cache: Dict[str, Any] = {}
        self._creds: Dict[str, Dict[str, Any]] = {}      # in memory only, see module docstring
        self.debug = os.getenv("MRPC_DEBUG", "").strip() not in ("", "0", "false")
        self._seen: set = set()

    def _debug_seen(self, name: str, res: Any, failed: bool = False):
        """MRPC_DEBUG=1: log each call's first real response (never ConnectEx, so no password) to learn the true shapes."""
        k = (name, failed)
        if not self.debug or k in self._seen:
            return
        self._seen.add(k)
        try:
            body = res if isinstance(res, str) else json.dumps(res, default=str)
        except Exception:  # noqa: BLE001
            body = str(res)
        log.warning("MRPC_DEBUG %s%s %s -> %s", "FAILED " if failed else "", name, EP.get(name, ""), body[:700])
        DIAG.append(f"{time.strftime('%H:%M:%S')} OK-SHAPE {name} {EP.get(name, '')} -> {body[:700]}" if not failed else f"{time.strftime('%H:%M:%S')} FAILED {name} {body[:300]}")

    def _warn_once(self, key: str, msg: str):
        if key not in self._seen:
            self._seen.add(key)
            log.warning(msg)

    # MetaRPC has no server directory; the connect screen's manual "server name" field is the way in.
    async def search_brokers(self, query: str, version: int = 5) -> Dict[str, List[str]]:
        return {}

    async def popular_brokers(self, version: int = 5) -> Dict[str, List[str]]:
        return {}

    @staticmethod
    def _as_api_error(e: MrpcError, connecting: bool = False) -> ApiError:
        if connecting and BAD_LOGIN.search(e.message):
            return ApiError(401, "The broker did not accept this login. Check the account number, the trading password (not the investor password) and that the server name matches your MetaTrader terminal exactly.", "bad_credentials")
        return ApiError(502, f"MetaRPC says: {e.message}"[:300] if e.message else "The broker gateway refused the request.", "upstream_error")

    async def _start_terminal(self, platform: str, login: str, password: str, server: str) -> str:
        try:
            res = await self.client.call(platform, EP["connect"], {"user": login, "password": password, "mtClusterName": server})
            return _parse_sid(res)
        except MrpcError as e:
            raise self._as_api_error(e, connecting=True)

    async def _wait_ready(self, platform: str, sid: str, job_id: Optional[str] = None, limit: int = 90):
        deadline = time.time() + limit
        last: Optional[MrpcError] = None
        while time.time() < deadline:
            try:
                await self.client.call(platform, EP["account"], None, sid)
                return
            except MrpcError as e:
                last = e
                if BAD_LOGIN.search(e.message) and not SESSION_GONE.search(e.message):
                    raise self._as_api_error(e, connecting=True)
            await asyncio.sleep(2)
        raise ApiError(504, "The broker did not answer in time. Check the server name and password, then try again.", "timeout") from last

    async def _connect_job(self, job_id, login, password, server, platform, broker_name, on_ready):
        try:
            key = self.key(login, server)
            self._set(job_id, "deploying", "Starting your trading terminal")
            sid = await self._start_terminal(platform, login, password, server)
            self._set(job_id, "connecting", "Signing in to the broker")
            await self._wait_ready(platform, sid, job_id)
            self._set(job_id, "syncing", "Loading positions and prices")
            old = self.sessions.pop(key, None)
            session = MrpcSession(key, self, sid, {"login": login, "server": server, "platform": platform, "broker_name": broker_name})
            self.sessions[key] = session
            self._creds[key] = {"password": password, "ts": time.time()}
            if old and old.sid != sid:
                asyncio.create_task(self._stop(old))
            info = await session.account_info()
            token = await on_ready(session, info)
            self._set(job_id, "ready", "Connected", token=token, account=info)
        except Exception as e:  # noqa: BLE001
            err = e if isinstance(e, ApiError) else explain_error(e)
            detail = str(e)
            for secret in (password, quote(password, safe="")):
                if secret:
                    detail = detail.replace(secret, "***")
            log.warning("connect failed: login=%s server=%s platform=%s -> %s (%s) | %s: %s",
                        login, server, platform, err.code, err.status, type(e).__name__, detail[:300])
            self._set(job_id, "failed", err.message, code=err.code)

    async def _stop(self, sess: MrpcSession, delete: bool = False):
        try:
            await self.client.call(sess.platform, EP["disconnect"], {"delete": "true"} if delete else None, sess.sid)
        except Exception as e:  # noqa: BLE001 - nothing useful to do if the stop call fails
            log.info("disconnect failed for %s: %s", sess.key, type(e).__name__)

    async def _reconnect(self, sess: MrpcSession, stop_first: bool = False):
        """Start the terminal again from the in-memory credentials (after the gateway lost it)."""
        cred = self._creds.get(sess.key)
        if not cred:
            self.sessions.pop(sess.key, None)
            raise ApiError(401, "This session was paused. Connect your account again.", "relink")
        if time.time() - getattr(sess, "last_restart", 0) < 60:       # never restart in a loop
            raise ApiError(502, "Your broker terminal is restarting. Prices and trading resume in about a minute.", "upstream_error")
        sess.last_restart = time.time()
        log.warning("restarting stalled/lost terminal for %s (instance %s)", sess.key, INSTANCE)
        if stop_first:
            await self._stop(sess)
        lock = self._attach_locks.setdefault(sess.key, asyncio.Lock())
        async with lock:
            try:
                sid = await self._start_terminal(sess.platform, sess.info["login"], cred["password"], sess.info["server"])
                await self._wait_ready(sess.platform, sid, limit=60)
            except MrpcError as e:
                raise self._as_api_error(e, connecting=True)
            sess.sid = sid
            sess._cache.clear()

    async def session_for(self, claims: Dict[str, Any]) -> MrpcSession:
        key = self.key(claims["login"], claims["server"])
        sess = self.sessions.get(key)
        if sess:
            sess.last_used = time.time()
            self._creds.get(key, {})["ts"] = time.time()
            return sess
        lock = self._attach_locks.setdefault(key, asyncio.Lock())
        async with lock:
            sess = self.sessions.get(key)
            if sess:
                return sess
            cred = self._creds.get(key)
            if not cred:
                log.warning("relink needed for %s on instance %s: no in-memory credentials (server restarted, a second app copy, or logged out)", key, INSTANCE)
                raise ApiError(401, "Your terminal was paused to save usage (or the server restarted). Connect your account again.", "relink")
            platform = claims.get("platform", "mt5")
            try:
                sid = await self._start_terminal(platform, claims["login"], cred["password"], claims["server"])
                await self._wait_ready(platform, sid, limit=90)
            except MrpcError as e:
                raise self._as_api_error(e, connecting=True)
            sess = MrpcSession(key, self, sid, {"login": claims["login"], "server": claims["server"], "platform": platform,
                                                "broker_name": claims.get("broker", "")})
            cred["ts"] = time.time()
            self.sessions[key] = sess
            return sess

    async def drop(self, claims: Dict[str, Any]):
        key = self.key(claims["login"], claims["server"])
        sess = self.sessions.pop(key, None)
        self._creds.pop(key, None)                        # logout wipes the password from memory
        if sess:
            await self._stop(sess)

    async def reap_idle(self, max_idle: Optional[int] = None):
        """Stop terminals nobody touched recently (the usage saver) and forget very old credentials."""
        limit = max_idle if max_idle is not None else self.idle_seconds
        now = time.time()
        for key, sess in list(self.sessions.items()):
            if now - sess.last_used > limit:
                self.sessions.pop(key, None)
                await self._stop(sess)
                log.info("paused idle terminal %s", key)
        for key, cred in list(self._creds.items()):
            if now - cred["ts"] > self.cred_ttl and key not in self.sessions:
                self._creds.pop(key, None)
