"""Public market data, news and economic calendar.

This is what the app shows before a broker is connected (and always for news
and the calendar). Everything here comes from real third-party feeds:
  - prices/candles: Yahoo Finance chart endpoint (no key)
  - headlines: publishers' own RSS feeds
  - calendar: the weekly Forex Factory/FairEconomy JSON export
Nothing is generated locally.
"""
import asyncio
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any, Dict, List, Optional

import httpx

UA = {"User-Agent": "Mozilla/5.0 (compatible; KanAIRY/3.0; +https://github.com/Matlala603/KanAIRy)"}


def _fx(sym: str, name: str, digits: int = 5):
    return {"symbol": sym, "name": name, "cat": "Forex", "yahoo": f"{sym}=X", "digits": digits}


CATALOG: List[Dict[str, Any]] = [
    _fx("EURUSD", "Euro / US Dollar"), _fx("GBPUSD", "British Pound / US Dollar"),
    _fx("USDJPY", "US Dollar / Japanese Yen", 3), _fx("USDCHF", "US Dollar / Swiss Franc"),
    _fx("AUDUSD", "Australian Dollar / US Dollar"), _fx("USDCAD", "US Dollar / Canadian Dollar"),
    _fx("NZDUSD", "New Zealand Dollar / US Dollar"), _fx("EURGBP", "Euro / British Pound"),
    _fx("EURJPY", "Euro / Japanese Yen", 3), _fx("GBPJPY", "British Pound / Japanese Yen", 3),
    _fx("EURCHF", "Euro / Swiss Franc"), _fx("EURAUD", "Euro / Australian Dollar"),
    _fx("AUDJPY", "Australian Dollar / Japanese Yen", 3), _fx("CADJPY", "Canadian Dollar / Japanese Yen", 3),
    _fx("CHFJPY", "Swiss Franc / Japanese Yen", 3), _fx("GBPAUD", "British Pound / Australian Dollar"),
    _fx("GBPCAD", "British Pound / Canadian Dollar"), _fx("AUDNZD", "Australian Dollar / New Zealand Dollar"),
    _fx("USDZAR", "US Dollar / South African Rand", 4), _fx("USDMXN", "US Dollar / Mexican Peso", 4),
    _fx("USDTRY", "US Dollar / Turkish Lira", 4), _fx("USDSGD", "US Dollar / Singapore Dollar", 4),
    {"symbol": "XAUUSD", "name": "Gold futures (GC)", "cat": "Metals", "yahoo": "GC=F", "digits": 2},
    {"symbol": "XAGUSD", "name": "Silver futures (SI)", "cat": "Metals", "yahoo": "SI=F", "digits": 3},
    {"symbol": "XPTUSD", "name": "Platinum futures (PL)", "cat": "Metals", "yahoo": "PL=F", "digits": 2},
    {"symbol": "XPDUSD", "name": "Palladium futures (PA)", "cat": "Metals", "yahoo": "PA=F", "digits": 2},
    {"symbol": "USOIL", "name": "WTI crude oil futures", "cat": "Energy", "yahoo": "CL=F", "digits": 2},
    {"symbol": "UKOIL", "name": "Brent crude oil futures", "cat": "Energy", "yahoo": "BZ=F", "digits": 2},
    {"symbol": "NATGAS", "name": "Natural gas futures", "cat": "Energy", "yahoo": "NG=F", "digits": 3},
    {"symbol": "US500", "name": "S&P 500", "cat": "Indices", "yahoo": "^GSPC", "digits": 2},
    {"symbol": "US30", "name": "Dow Jones Industrial", "cat": "Indices", "yahoo": "^DJI", "digits": 2},
    {"symbol": "NAS100", "name": "Nasdaq 100", "cat": "Indices", "yahoo": "^NDX", "digits": 2},
    {"symbol": "GER40", "name": "DAX 40", "cat": "Indices", "yahoo": "^GDAXI", "digits": 2},
    {"symbol": "UK100", "name": "FTSE 100", "cat": "Indices", "yahoo": "^FTSE", "digits": 2},
    {"symbol": "FRA40", "name": "CAC 40", "cat": "Indices", "yahoo": "^FCHI", "digits": 2},
    {"symbol": "JPN225", "name": "Nikkei 225", "cat": "Indices", "yahoo": "^N225", "digits": 2},
    {"symbol": "HK50", "name": "Hang Seng", "cat": "Indices", "yahoo": "^HSI", "digits": 2},
    {"symbol": "BTCUSD", "name": "Bitcoin", "cat": "Crypto", "yahoo": "BTC-USD", "digits": 2},
    {"symbol": "ETHUSD", "name": "Ethereum", "cat": "Crypto", "yahoo": "ETH-USD", "digits": 2},
    {"symbol": "XRPUSD", "name": "XRP", "cat": "Crypto", "yahoo": "XRP-USD", "digits": 4},
    {"symbol": "SOLUSD", "name": "Solana", "cat": "Crypto", "yahoo": "SOL-USD", "digits": 2},
    {"symbol": "BNBUSD", "name": "BNB", "cat": "Crypto", "yahoo": "BNB-USD", "digits": 2},
    {"symbol": "ADAUSD", "name": "Cardano", "cat": "Crypto", "yahoo": "ADA-USD", "digits": 4},
    {"symbol": "DOGEUSD", "name": "Dogecoin", "cat": "Crypto", "yahoo": "DOGE-USD", "digits": 5},
    {"symbol": "LTCUSD", "name": "Litecoin", "cat": "Crypto", "yahoo": "LTC-USD", "digits": 2},
    {"symbol": "AAPL", "name": "Apple", "cat": "Stocks", "yahoo": "AAPL", "digits": 2},
    {"symbol": "MSFT", "name": "Microsoft", "cat": "Stocks", "yahoo": "MSFT", "digits": 2},
    {"symbol": "NVDA", "name": "NVIDIA", "cat": "Stocks", "yahoo": "NVDA", "digits": 2},
    {"symbol": "TSLA", "name": "Tesla", "cat": "Stocks", "yahoo": "TSLA", "digits": 2},
    {"symbol": "AMZN", "name": "Amazon", "cat": "Stocks", "yahoo": "AMZN", "digits": 2},
    {"symbol": "GOOGL", "name": "Alphabet", "cat": "Stocks", "yahoo": "GOOGL", "digits": 2},
    {"symbol": "META", "name": "Meta Platforms", "cat": "Stocks", "yahoo": "META", "digits": 2},
    {"symbol": "NFLX", "name": "Netflix", "cat": "Stocks", "yahoo": "NFLX", "digits": 2},
    {"symbol": "AMD", "name": "Advanced Micro Devices", "cat": "Stocks", "yahoo": "AMD", "digits": 2},
    {"symbol": "JPM", "name": "JPMorgan Chase", "cat": "Stocks", "yahoo": "JPM", "digits": 2},
    {"symbol": "NPN", "name": "Naspers (JSE)", "cat": "Stocks", "yahoo": "NPN.JO", "digits": 2},
]
BY_SYMBOL = {c["symbol"]: c for c in CATALOG}

# timeframe -> (yahoo interval, yahoo range, aggregate factor)
YAHOO_TF = {
    "M1": ("1m", "5d", 1), "M5": ("5m", "1mo", 1), "M15": ("15m", "1mo", 1),
    "M30": ("30m", "1mo", 1), "H1": ("60m", "6mo", 1), "H4": ("60m", "1y", 4),
    "D1": ("1d", "5y", 1), "W1": ("1wk", "10y", 1), "MN": ("1mo", "max", 1),
}


class Cache:
    def __init__(self):
        self.d: Dict[str, Any] = {}

    def get(self, key: str, ttl: float):
        hit = self.d.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        return None

    def stale(self, key: str):
        hit = self.d.get(key)
        return hit[1] if hit else None

    def put(self, key: str, value: Any):
        if len(self.d) > 800:
            for k in sorted(self.d, key=lambda k: self.d[k][0])[:200]:
                self.d.pop(k, None)
        self.d[key] = (time.time(), value)


class PublicData:
    def __init__(self, client: Optional[httpx.AsyncClient] = None):
        self.http = client or httpx.AsyncClient(timeout=15, headers=UA, follow_redirects=True)
        self.cache = Cache()
        self.sem = asyncio.Semaphore(8)

    # ---------- Yahoo ----------
    async def _chart(self, ticker: str, interval: str, rng: str) -> Dict[str, Any]:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        async with self.sem:
            r = await self.http.get(url, params={"interval": interval, "range": rng, "includePrePost": "false"})
        if r.status_code == 429:
            raise PublicError(429, "The public price feed is rate-limiting requests. Try again shortly.")
        if r.status_code >= 400:
            raise PublicError(502, f"The public price feed returned {r.status_code}.")
        body = r.json().get("chart", {})
        if body.get("error") or not body.get("result"):
            raise PublicError(404, "No data for this instrument right now.")
        return body["result"][0]

    async def candles(self, symbol: str, timeframe: str, limit: int = 600) -> List[Dict[str, Any]]:
        inst = BY_SYMBOL.get(symbol)
        if not inst:
            raise PublicError(404, "Unknown instrument")
        if timeframe not in YAHOO_TF:
            raise PublicError(400, "Unsupported timeframe")
        interval, rng, factor = YAHOO_TF[timeframe]
        ck = f"c:{symbol}:{timeframe}"
        ttl = 20 if timeframe in ("M1", "M5") else 45
        rows = self.cache.get(ck, ttl)
        if rows is None:
            try:
                res = await self._chart(inst["yahoo"], interval, rng)
            except (httpx.HTTPError, PublicError) as e:
                stale = self.cache.stale(ck)
                if stale is not None:
                    rows = stale
                else:
                    raise (e if isinstance(e, PublicError) else PublicError(502, "Could not reach the public price feed."))
            else:
                ts = res.get("timestamp") or []
                q = (res.get("indicators", {}).get("quote") or [{}])[0]
                rows = []
                for i, t in enumerate(ts):
                    o, h, l, c = (q.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close"))
                    if None in (o, h, l, c):
                        continue
                    v = (q.get("volume") or [0] * len(ts))[i] or 0
                    rows.append({"t": int(t), "o": o, "h": h, "l": l, "c": c, "v": v})
                if factor > 1:
                    rows = aggregate(rows, 3600 * factor)
                self.cache.put(ck, rows)
        return rows[-limit:]

    async def quote(self, symbol: str) -> Optional[Dict[str, Any]]:
        inst = BY_SYMBOL.get(symbol)
        if not inst:
            return None
        ck = f"q:{symbol}"
        hit = self.cache.get(ck, 5)
        if hit:
            return hit
        try:
            res = await self._chart(inst["yahoo"], "1m", "1d")
        except (httpx.HTTPError, PublicError):
            return self.cache.stale(ck)
        m = res.get("meta", {})
        price = m.get("regularMarketPrice")
        if price is None:
            return self.cache.stale(ck)
        prev = m.get("chartPreviousClose") or m.get("previousClose") or price
        out = {
            "bid": price, "ask": price, "last": price, "prevClose": prev,
            "dayHigh": m.get("regularMarketDayHigh"), "dayLow": m.get("regularMarketDayLow"),
            "time": m.get("regularMarketTime") or int(time.time()),
        }
        self.cache.put(ck, out)
        return out

    async def quotes(self, symbols: List[str]) -> Dict[str, Any]:
        syms = [s for s in dict.fromkeys(symbols) if s in BY_SYMBOL][:40]
        res = await asyncio.gather(*[self.quote(s) for s in syms], return_exceptions=True)
        return {s: r for s, r in zip(syms, res) if isinstance(r, dict)}

    # ---------- News ----------
    NEWS_FEEDS = {
        "fxstreet": ("FXStreet", "https://www.fxstreet.com/rss/news", "forex"),
        "investing": ("Investing.com", "https://www.investing.com/rss/news_1.rss", "forex"),
        "cnbc": ("CNBC Markets", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069", "markets"),
        "marketwatch": ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_marketpulse", "markets"),
        "bloomberg": ("Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss", "markets"),
        "cointelegraph": ("Cointelegraph", "https://cointelegraph.com/rss", "crypto"),
    }

    async def _feed(self, fid: str) -> List[Dict[str, Any]]:
        name, url, cat = self.NEWS_FEEDS[fid]
        ck = f"n:{fid}"
        hit = self.cache.get(ck, 300)
        if hit is not None:
            return hit
        try:
            r = await self.http.get(url)
            r.raise_for_status()
            if len(r.content) > 3_000_000:
                raise ValueError("feed too large")
            root = ET.fromstring(r.content)
        except Exception:
            return self.cache.stale(ck) or []
        items = []
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            if not title or not link.startswith("http"):
                continue
            desc = re.sub(r"<[^>]+>", " ", unescape(it.findtext("description") or ""))
            desc = re.sub(r"\s+", " ", desc).strip()[:320]
            try:
                ts = int(parsedate_to_datetime(it.findtext("pubDate")).astimezone(timezone.utc).timestamp())
            except Exception:
                ts = int(time.time())
            items.append({"title": unescape(title), "url": link, "summary": desc, "time": ts,
                          "source": name, "sourceId": fid, "category": cat})
        items.sort(key=lambda x: x["time"], reverse=True)
        items = items[:40]
        self.cache.put(ck, items)
        return items

    async def news(self, source: str = "all") -> List[Dict[str, Any]]:
        ids = list(self.NEWS_FEEDS) if source == "all" else ([source] if source in self.NEWS_FEEDS else [])
        if not ids:
            raise PublicError(400, "Unknown news source")
        res = await asyncio.gather(*[self._feed(i) for i in ids])
        merged = [x for sub in res for x in sub]
        merged.sort(key=lambda x: x["time"], reverse=True)
        return merged[:80]

    # ---------- Calendar ----------
    async def calendar(self, week: str = "this") -> List[Dict[str, Any]]:
        week = "next" if week == "next" else "this"
        ck = f"cal:{week}"
        hit = self.cache.get(ck, 1800)
        if hit is not None:
            return hit
        url = f"https://nfs.faireconomy.media/ff_calendar_{week}week.json"
        try:
            r = await self.http.get(url)
            r.raise_for_status()
            raw = r.json()
        except Exception:
            stale = self.cache.stale(ck)
            if stale is not None:
                return stale
            raise PublicError(502, "The economic calendar feed is unavailable right now.")
        out = []
        for e in raw:
            try:
                ts = int(datetime.fromisoformat(e["date"]).astimezone(timezone.utc).timestamp())
            except Exception:
                continue
            out.append({
                "time": ts, "title": e.get("title", ""), "country": e.get("country", ""),
                "impact": (e.get("impact") or "Low").lower(),
                "forecast": e.get("forecast") or "", "previous": e.get("previous") or "",
            })
        out.sort(key=lambda x: x["time"])
        self.cache.put(ck, out)
        return out


class PublicError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def aggregate(rows: List[Dict[str, Any]], bucket: int) -> List[Dict[str, Any]]:
    """Roll finer candles up into `bucket`-second candles aligned to UTC."""
    out: List[Dict[str, Any]] = []
    for r in rows:
        start = r["t"] - r["t"] % bucket
        if out and out[-1]["t"] == start:
            b = out[-1]
            b["h"] = max(b["h"], r["h"])
            b["l"] = min(b["l"], r["l"])
            b["c"] = r["c"]
            b["v"] += r["v"]
        else:
            out.append({"t": start, "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "v": r["v"]})
    return out
