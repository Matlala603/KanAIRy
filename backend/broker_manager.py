"""MetaApi broker manager.

Owns every live connection to a MetaTrader account (MT4 or MT5) through
MetaApi, and exposes a small async surface the HTTP layer can call:
account snapshot, quotes, candles, positions, orders, history and trading.

Design notes
- One streaming connection per (login, server). Account info, positions,
  orders and prices are read from the connection's synchronized terminal
  state, so polling them costs nothing on the wire.
- Connecting a brand-new account can take minutes (provision, deploy, broker
  login, first sync). It runs as a background job the client polls, which keeps
  every HTTP request short (Heroku-style 30s router limits).
- Sessions are re-attached lazily after a restart: the MetaApi account already
  exists, so no password is needed and none is stored by KanAIRY.
"""
import asyncio
import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

PROVISIONING_HOST = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai"

POPULAR_BROKERS = [
    "IC Markets", "Exness", "XM", "Pepperstone", "FBS", "HFM", "Tickmill",
    "FXTM", "Admirals", "Vantage", "OANDA", "Equiti", "FTMO", "AvaTrade",
    "Octa", "RoboForex", "FP Markets", "Eightcap", "Deriv", "Alpari",
    "Axi", "BlackBull", "FXPro", "Capital.com", "Standard Bank", "Mex Atlantic",
]

TIMEFRAMES = {
    "M1": "1m", "M5": "5m", "M15": "15m", "M30": "30m",
    "H1": "1h", "H4": "4h", "D1": "1d", "W1": "1w", "MN": "1mn",
}
TF_SECONDS = {
    "M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600,
    "H4": 14400, "D1": 86400, "W1": 604800, "MN": 2592000,
}

ORDER_TYPES = {"market", "limit", "stop", "stop_limit"}


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str = "error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def _epoch(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp())
    return None


def _num(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def explain_error(exc: Exception) -> ApiError:
    """Turn a MetaApi / network exception into a message a trader can act on."""
    if isinstance(exc, ApiError):
        return exc
    text = str(exc) or exc.__class__.__name__
    name = exc.__class__.__name__
    low = text.lower()
    if "e_auth" in low or "authorization" in low or "invalid account" in low or "wrong password" in low:
        return ApiError(401, "The broker rejected these credentials. Check the account number, password and server.", "bad_credentials")
    if "e_server_timezone" in low or "e_resolve_host" in low or "server" in low and "not found" in low:
        return ApiError(400, "The broker server could not be found. Pick the server from the list or copy it exactly from your MetaTrader terminal.", "bad_server")
    if name == "TradeException" or hasattr(exc, "string_code"):
        code = getattr(exc, "string_code", "") or ""
        msg = getattr(exc, "message", None) or text
        return ApiError(400, f"Broker refused the order: {msg}", code or "trade_rejected")
    if name in ("TooManyRequestsException",) or "too many requests" in low:
        return ApiError(429, "Too many requests to the broker gateway. Wait a moment and try again.", "rate_limited")
    if name in ("TimeoutException",) or isinstance(exc, asyncio.TimeoutError) or "timed out" in low:
        return ApiError(504, "The broker did not answer in time. Try again.", "timeout")
    if name in ("NotFoundException",):
        return ApiError(404, text, "not_found")
    if name in ("ValidationException",):
        # never echo upstream details: they can contain the submitted payload
        return ApiError(400, "The broker gateway rejected those account details. Check the account number, server and platform.", "validation")
    if name in ("ForbiddenException", "UnauthorizedException"):
        return ApiError(502, "The MetaApi token was refused. The server operator needs to check METAAPI_TOKEN.", "metaapi_auth")
    # log the exception type, its message (for KeyError this is the missing key) and the traceback,
    # so the failing line is visible in the server logs; nothing here is returned to the client
    logging.getLogger("kanairy").warning("upstream error: %s: %r", name, exc, exc_info=exc)
    return ApiError(502, "The broker gateway returned an error. Try again in a moment.", "upstream_error")


def make_proof(password: str) -> Dict[str, Any]:
    """Salted scrypt hash stored in the MetaApi account metadata, so a later connect can prove it knows the password."""
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return {"v": 1, "salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(h).decode()}


def check_proof(password: str, proof: Any) -> bool:
    try:
        if not isinstance(proof, dict) or proof.get("v") != 1:
            return False
        salt = base64.b64decode(proof["salt"])
        want = base64.b64decode(proof["hash"])
        got = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got, want)
    except Exception:  # noqa: BLE001
        return False


class BrokerSession:
    def __init__(self, key: str, account: Any, connection: Any, info: Dict[str, Any]):
        self.key = key
        self.account = account
        self.conn = connection
        self.info = info                      # login, server, platform, broker
        self.subscribed: set = set()
        self.spec_cache: Dict[str, Dict[str, Any]] = {}
        self.last_used = time.time()
        self.lock = asyncio.Lock()

    # ----- state read from the synchronized terminal (no network) -----
    def _state(self):
        return self.conn.terminal_state

    async def account_info(self) -> Dict[str, Any]:
        info = None
        try:
            info = self._state().account_information
        except Exception:
            info = None
        if not info:
            info = await self.conn.get_account_information()
        margin = _num(info.get("margin"))
        equity = _num(info.get("equity"))
        return {
            "login": str(info.get("login", self.info["login"])),
            "name": info.get("name") or "",
            "broker": info.get("broker") or self.info.get("broker_name") or "",
            "server": info.get("server") or self.info["server"],
            "platform": self.info["platform"],
            "currency": info.get("currency") or "USD",
            "leverage": info.get("leverage"),
            "balance": _num(info.get("balance")),
            "equity": equity,
            "margin": margin,
            "freeMargin": _num(info.get("freeMargin")),
            "marginLevel": (equity / margin * 100) if margin > 0 else None,
            "credit": _num(info.get("credit")),
            "tradeAllowed": info.get("tradeAllowed", True),
            "type": info.get("type"),
        }

    @staticmethod
    def _position(p: Dict[str, Any]) -> Dict[str, Any]:
        t = str(p.get("type", ""))
        return {
            "id": str(p.get("id")),
            "symbol": p.get("symbol"),
            "side": "buy" if "BUY" in t else "sell",
            "volume": _num(p.get("volume")),
            "openPrice": _num(p.get("openPrice")),
            "currentPrice": _num(p.get("currentPrice")),
            "stopLoss": p.get("stopLoss"),
            "takeProfit": p.get("takeProfit"),
            "profit": _num(p.get("profit")),
            "swap": _num(p.get("swap")),
            "commission": _num(p.get("commission")),
            "openTime": _epoch(p.get("time")),
            "comment": p.get("comment") or "",
        }

    @staticmethod
    def _order(o: Dict[str, Any]) -> Dict[str, Any]:
        t = str(o.get("type", "")).replace("ORDER_TYPE_", "")
        return {
            "id": str(o.get("id")),
            "symbol": o.get("symbol"),
            "type": t.lower(),              # buy_limit, sell_stop, ...
            "side": "buy" if t.startswith("BUY") else "sell",
            "volume": _num(o.get("currentVolume", o.get("volume"))),
            "price": _num(o.get("openPrice")),
            "stopLimitPrice": o.get("stopLimitPrice"),
            "stopLoss": o.get("stopLoss"),
            "takeProfit": o.get("takeProfit"),
            "currentPrice": o.get("currentPrice"),
            "time": _epoch(o.get("time")),
            "expiration": _epoch(o.get("expirationTime")),
            "comment": o.get("comment") or "",
        }

    async def positions(self) -> List[Dict[str, Any]]:
        raw = None
        try:
            raw = self._state().positions
        except Exception:
            raw = None
        if raw is None:
            raw = await self.conn.get_positions()
        return [self._position(p) for p in raw]

    async def orders(self) -> List[Dict[str, Any]]:
        raw = None
        try:
            raw = self._state().orders
        except Exception:
            raw = None
        if raw is None:
            raw = await self.conn.get_orders()
        return [self._order(o) for o in raw]

    async def symbols(self) -> List[Dict[str, Any]]:
        specs = []
        try:
            specs = list(self._state().specifications or [])
        except Exception:
            specs = []
        if not specs:
            names = await self.conn.get_symbols()
            specs = [{"symbol": n} for n in names]
        out = []
        for s in specs:
            path = (s.get("path") or "").replace("\\", "/")
            parts = [p for p in path.split("/") if p]
            out.append({
                "symbol": s.get("symbol"),
                "description": s.get("description") or "",
                "path": path,
                "category": parts[0] if len(parts) > 1 else "Other",
                "digits": s.get("digits"),
                "tickSize": s.get("tickSize"),
                "contractSize": s.get("contractSize"),
                "minVolume": s.get("minVolume"),
                "maxVolume": s.get("maxVolume"),
                "volumeStep": s.get("volumeStep"),
                "baseCurrency": s.get("baseCurrency"),
                "profitCurrency": s.get("profitCurrency"),
                "tradeMode": s.get("tradeMode"),
            })
        return [s for s in out if s["symbol"]]

    async def spec(self, symbol: str) -> Dict[str, Any]:
        if symbol not in self.spec_cache:
            self.spec_cache[symbol] = await self.conn.get_symbol_specification(symbol)
        return self.spec_cache[symbol]

    async def _subscribe(self, symbol: str):
        if symbol in self.subscribed:
            return
        await self.conn.subscribe_to_market_data(symbol, [{"type": "quotes", "intervalInMilliseconds": 1000}])
        self.subscribed.add(symbol)

    async def quotes(self, symbols: List[str]) -> Dict[str, Any]:
        self.last_used = time.time()
        out: Dict[str, Any] = {}
        for sym in symbols[:60]:
            price = None
            try:
                await self._subscribe(sym)
                price = self._state().price(sym)
            except Exception:
                price = None
            if not price:
                try:
                    price = await self.conn.get_symbol_price(sym)
                except Exception:
                    price = None
            if price:
                out[sym] = {
                    "bid": _num(price.get("bid")),
                    "ask": _num(price.get("ask")),
                    "time": _epoch(price.get("time")) or int(time.time()),
                }
        return out

    async def candles(self, symbol: str, timeframe: str, limit: int, before: Optional[int]) -> List[Dict[str, Any]]:
        tf = TIMEFRAMES.get(timeframe)
        if not tf:
            raise ApiError(400, f"Unsupported timeframe {timeframe}")
        limit = max(1, min(limit, 1000))
        if before:
            start = datetime.fromtimestamp(before, tz=timezone.utc)
        else:
            start = datetime.now(timezone.utc) + timedelta(seconds=TF_SECONDS[timeframe])
        raw = await self.account.get_historical_candles(symbol, tf, start, limit)
        rows = []
        for c in raw or []:
            t = _epoch(c.get("time"))
            if t is None:
                continue
            rows.append({
                "t": t, "o": _num(c.get("open")), "h": _num(c.get("high")),
                "l": _num(c.get("low")), "c": _num(c.get("close")),
                "v": _num(c.get("tickVolume", c.get("volume"))),
            })
        rows.sort(key=lambda r: r["t"])
        if before:
            rows = [r for r in rows if r["t"] < before]
        # de-duplicate by time
        seen, uniq = set(), []
        for r in rows:
            if r["t"] in seen:
                continue
            seen.add(r["t"])
            uniq.append(r)
        return uniq

    async def history(self, days: int) -> List[Dict[str, Any]]:
        days = max(1, min(days, 365))
        end = datetime.now(timezone.utc) + timedelta(minutes=5)
        start = end - timedelta(days=days)
        res = await self.conn.get_deals_by_time_range(start, end)
        deals = res.get("deals", res) if isinstance(res, dict) else res
        out = []
        for d in deals or []:
            dtype = str(d.get("type", ""))
            if dtype in ("DEAL_TYPE_BALANCE", "DEAL_TYPE_CREDIT", "DEAL_TYPE_CHARGE", "DEAL_TYPE_CORRECTION", "DEAL_TYPE_BONUS"):
                out.append({
                    "id": str(d.get("id")), "kind": "balance", "symbol": "",
                    "time": _epoch(d.get("time")), "profit": _num(d.get("profit")),
                    "comment": d.get("comment") or dtype.replace("DEAL_TYPE_", "").title(),
                })
                continue
            if "BUY" not in dtype and "SELL" not in dtype:
                continue
            out.append({
                "id": str(d.get("id")), "kind": "deal", "symbol": d.get("symbol"),
                "side": "buy" if "BUY" in dtype else "sell",
                "entry": str(d.get("entryType", "")).replace("DEAL_ENTRY_", "").lower(),
                "volume": _num(d.get("volume")), "price": _num(d.get("price")),
                "profit": _num(d.get("profit")), "swap": _num(d.get("swap")),
                "commission": _num(d.get("commission")),
                "positionId": str(d.get("positionId") or ""),
                "time": _epoch(d.get("time")), "comment": d.get("comment") or "",
            })
        out.sort(key=lambda r: r["time"] or 0, reverse=True)
        return out

    # ----- trading -----
    async def place_order(self, req: Dict[str, Any]) -> Dict[str, Any]:
        symbol = req["symbol"]
        side = req["side"]
        otype = req["type"]
        volume = float(req["volume"])
        sl, tp = req.get("stopLoss"), req.get("takeProfit")
        price, limit_price = req.get("price"), req.get("stopLimitPrice")
        if side not in ("buy", "sell"):
            raise ApiError(400, "side must be buy or sell")
        if otype not in ORDER_TYPES:
            raise ApiError(400, "Unsupported order type")
        if volume <= 0:
            raise ApiError(400, "Volume must be greater than zero")
        spec = None
        try:
            spec = await self.spec(symbol)
        except Exception:
            pass
        if not spec:
            raise ApiError(400, f"Could not read the contract specification for {symbol}. Try again in a moment.", "validation")
        if spec:
            vmin, vmax = _num(spec.get("minVolume")), _num(spec.get("maxVolume"))
            vstep = _num(spec.get("volumeStep"))
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
        opts = {"comment": (req.get("comment") or "KanAIRY")[:26]}
        c = self.conn
        if otype == "market":
            fn = c.create_market_buy_order if side == "buy" else c.create_market_sell_order
            res = await fn(symbol, volume, sl, tp, opts)
        elif otype == "limit":
            fn = c.create_limit_buy_order if side == "buy" else c.create_limit_sell_order
            res = await fn(symbol, volume, price, sl, tp, opts)
        elif otype == "stop":
            fn = c.create_stop_buy_order if side == "buy" else c.create_stop_sell_order
            res = await fn(symbol, volume, price, sl, tp, opts)
        else:
            fn = c.create_stop_limit_buy_order if side == "buy" else c.create_stop_limit_sell_order
            res = await fn(symbol, volume, price, limit_price, sl, tp, opts)
        return {
            "ok": True,
            "orderId": str(res.get("orderId", "")),
            "positionId": str(res.get("positionId", "")),
            "code": res.get("stringCode"),
            "message": res.get("message") or "Order accepted",
        }

    async def modify_position(self, position_id: str, sl, tp) -> Dict[str, Any]:
        # None means "leave unchanged": fill it from live state so the broker never reads a missing value as "remove".
        cur = next((p for p in await self.positions() if p["id"] == str(position_id)), None)
        if cur is None:
            raise ApiError(404, "That position is no longer open.", "not_found")
        sl = cur["stopLoss"] if sl is None else sl
        tp = cur["takeProfit"] if tp is None else tp
        res = await self.conn.modify_position(position_id, sl or 0, tp or 0)
        return {"ok": True, "message": res.get("message") or "Position updated"}

    async def close_position(self, position_id: str, volume: Optional[float]) -> Dict[str, Any]:
        if volume:
            cur = next((p for p in await self.positions() if p["id"] == str(position_id)), None)
            if cur is None:
                raise ApiError(404, "That position is no longer open.", "not_found")
            if volume >= cur["volume"] - 1e-12:
                volume = None
        if volume:
            res = await self.conn.close_position_partially(position_id, volume)
        else:
            res = await self.conn.close_position(position_id)
        return {"ok": True, "message": res.get("message") or "Position closed"}

    async def cancel_order(self, order_id: str) -> Dict[str, Any]:
        res = await self.conn.cancel_order(order_id)
        return {"ok": True, "message": res.get("message") or "Order cancelled"}

    async def modify_order(self, order_id: str, price, sl, tp) -> Dict[str, Any]:
        cur = next((o for o in await self.orders() if o["id"] == str(order_id)), None)
        if cur is None:
            raise ApiError(404, "That order is no longer pending.", "not_found")
        price = cur["price"] if price is None else price
        sl = cur["stopLoss"] if sl is None else sl
        tp = cur["takeProfit"] if tp is None else tp
        res = await self.conn.modify_order(order_id, price, sl or 0, tp or 0)
        return {"ok": True, "message": res.get("message") or "Order updated"}


class BrokerManager:
    def __init__(self, token: str, api: Any = None, http: Optional[httpx.AsyncClient] = None):
        self.token = token
        if api is None:
            from metaapi_cloud_sdk import MetaApi  # imported lazily so the app boots without it
            api = MetaApi(token)
        self.api = api
        self.http = http or httpx.AsyncClient(timeout=20)
        self.sessions: Dict[str, BrokerSession] = {}
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._attach_locks: Dict[str, asyncio.Lock] = {}
        self._broker_cache: Dict[str, Any] = {}

    @staticmethod
    def key(login: str, server: str) -> str:
        return f"{str(login).strip()}|{server.strip().lower()}"

    # ----- broker directory (every server MetaApi knows for MT4/MT5) -----
    async def search_brokers(self, query: str, version: int = 5) -> Dict[str, List[str]]:
        query = (query or "").strip()
        if len(query) < 2:
            return {}
        ck = f"{version}:{query.lower()}"
        hit = self._broker_cache.get(ck)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        try:
            r = await self.http.get(
                f"{PROVISIONING_HOST}/known-mt-servers/{int(version)}/search",
                params={"query": query}, headers={"auth-token": self.token},
            )
        except httpx.HTTPError as e:
            raise ApiError(502, "Could not reach the MetaApi broker directory.", "upstream_error") from e
        if r.status_code in (401, 403):
            raise ApiError(502, "The MetaApi token was refused. The server operator needs to check METAAPI_TOKEN.", "metaapi_auth")
        if r.status_code >= 400:
            raise ApiError(502, f"Broker directory error ({r.status_code}).", "upstream_error")
        data = r.json()
        if not isinstance(data, dict):
            data = {}
        data = {str(k): [str(s) for s in v] for k, v in data.items() if isinstance(v, list)}
        self._broker_cache[ck] = (time.time(), data)
        return data

    async def popular_brokers(self, version: int = 5) -> Dict[str, List[str]]:
        ck = f"popular:{version}"
        hit = self._broker_cache.get(ck)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        results = await asyncio.gather(*[self.search_brokers(q, version) for q in POPULAR_BROKERS], return_exceptions=True)
        merged: Dict[str, List[str]] = {}
        failures = 0
        for res in results:
            if isinstance(res, Exception):
                failures += 1
                continue
            for broker, servers in res.items():
                merged.setdefault(broker, [])
                for s in servers:
                    if s not in merged[broker]:
                        merged[broker].append(s)
        if failures == len(results):
            raise ApiError(502, "Could not load the broker directory right now.", "upstream_error")
        self._broker_cache[ck] = (time.time(), merged)
        return merged

    # ----- connecting -----
    async def _find_account(self, login: str, server: str):
        mt = self.api.metatrader_account_api
        accounts: List[Any] = []
        flt = {"query": str(login), "limit": 100}
        fn = getattr(mt, "get_accounts_with_infinite_scroll_pagination", None)
        if fn:
            accounts = await fn(flt)
        else:
            accounts = await mt.get_accounts(flt)
        want = server.strip().lower()
        for a in accounts:
            if str(a.login) == str(login) and str(a.server).strip().lower() == want:
                return a
        return None

    async def _open(self, account: Any, wait_seconds: int = 240):
        if getattr(account, "state", None) not in ("DEPLOYED", "DEPLOYING"):
            await account.deploy()
        await account.wait_connected(wait_seconds)
        conn = account.get_streaming_connection()
        await conn.connect()
        await conn.wait_synchronized({"timeoutInSeconds": wait_seconds})
        return conn

    def _set(self, job_id: str, state: str, message: str, **extra):
        job = self.jobs.setdefault(job_id, {})
        job.update({"state": state, "message": message, "updated": time.time(), **extra})

    async def start_connect(self, login: str, password: str, server: str, platform: str,
                            broker_name: str, on_ready) -> str:
        if not re.fullmatch(r"\d{3,12}", str(login).strip()):
            raise ApiError(400, "Account number must be digits only.", "validation")
        if platform not in ("mt4", "mt5"):
            raise ApiError(400, "Platform must be mt4 or mt5.", "validation")
        if not password or not server.strip():
            raise ApiError(400, "Password and server are required.", "validation")
        # keep job table small
        for jid in [j for j, v in self.jobs.items() if time.time() - v.get("updated", 0) > 1800]:
            self.jobs.pop(jid, None)
        job_id = uuid.uuid4().hex
        self._set(job_id, "queued", "Starting")
        asyncio.create_task(self._connect_job(job_id, str(login).strip(), password, server.strip(), platform, broker_name, on_ready))
        return job_id

    async def _connect_job(self, job_id, login, password, server, platform, broker_name, on_ready):
        try:
            key = self.key(login, server)
            self._set(job_id, "provisioning", "Looking up your account")
            account = await self._find_account(login, server)
            if account is not None:
                # An account already exists on the gateway. Never hand out a session just because it exists:
                # the caller must prove they know the password it was linked with.
                meta = getattr(account, "metadata", None)
                proof = meta.get("kanairy") if isinstance(meta, dict) else None
                if not check_proof(password, proof):
                    raise ApiError(401, "That password does not match the one this account was linked with here, or the account was linked elsewhere. Nothing was changed.", "bad_credentials")
            if account is None:
                self._set(job_id, "provisioning", "Registering your account with the broker gateway")
                account = await self.api.metatrader_account_api.create_account({
                    "name": f"KanAIRY {login}",
                    "type": "cloud-g2",
                    "login": login,
                    "password": password,
                    "server": server,
                    "platform": platform,
                    "application": "MetaApi",
                    "magic": 0,
                    "metadata": {"kanairy": make_proof(password)},
                })
            self._set(job_id, "deploying", "Starting your trading terminal")
            if getattr(account, "state", None) not in ("DEPLOYED", "DEPLOYING"):
                await account.deploy()
            self._set(job_id, "connecting", "Signing in to the broker")
            await account.wait_connected(300)
            self._set(job_id, "syncing", "Synchronising positions and prices")
            conn = account.get_streaming_connection()
            await conn.connect()
            await conn.wait_synchronized({"timeoutInSeconds": 300})
            session = BrokerSession(key, account, conn, {
                "login": login, "server": server, "platform": platform, "broker_name": broker_name,
            })
            self.sessions[key] = session
            info = await session.account_info()
            token = await on_ready(session, info)
            self._set(job_id, "ready", "Connected", token=token, account=info)
        except Exception as e:  # noqa: BLE001
            err = explain_error(e)
            self._set(job_id, "failed", err.message, code=err.code)

    def job(self, job_id: str) -> Dict[str, Any]:
        job = self.jobs.get(job_id)
        if not job:
            raise ApiError(404, "Unknown connection attempt.", "not_found")
        return {k: v for k, v in job.items() if k != "updated"}

    async def session_for(self, claims: Dict[str, Any]) -> BrokerSession:
        key = self.key(claims["login"], claims["server"])
        sess = self.sessions.get(key)
        if sess:
            sess.last_used = time.time()
            return sess
        lock = self._attach_locks.setdefault(key, asyncio.Lock())
        async with lock:
            sess = self.sessions.get(key)
            if sess:
                return sess
            try:
                account = await self._find_account(claims["login"], claims["server"])
                if account is None:
                    raise ApiError(401, "This account is no longer linked. Connect it again.", "relink")
                conn = await self._open(account, 120)
            except Exception as e:  # noqa: BLE001
                raise explain_error(e)
            sess = BrokerSession(key, account, conn, {
                "login": claims["login"], "server": claims["server"],
                "platform": claims.get("platform", "mt5"), "broker_name": claims.get("broker", ""),
            })
            self.sessions[key] = sess
            return sess

    async def drop(self, claims: Dict[str, Any]):
        sess = self.sessions.pop(self.key(claims["login"], claims["server"]), None)
        if sess:
            try:
                await sess.conn.close()
            except Exception:
                pass

    async def reap_idle(self, max_idle: int = 1800):
        """Close streaming connections nobody has touched recently."""
        for key, sess in list(self.sessions.items()):
            if time.time() - sess.last_used > max_idle:
                self.sessions.pop(key, None)
                try:
                    await sess.conn.close()
                except Exception:
                    pass
