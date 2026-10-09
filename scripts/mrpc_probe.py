#!/usr/bin/env python3
"""Check which MetaRPC calls kanAIRY's adapter makes actually work, and show the real response shapes.

Use a DEMO account. Usage:
  MRPC_API_KEY=... python3 scripts/mrpc_probe.py <login> <server> [mt4|mt5] [symbol]
The password is read from the MRPC_PASSWORD env var or prompted (never put it on the command line).
Nothing is traded: OrderSend / OrderClose / OrderModify are listed but not called.
Where a call fails or a field is missing, fix the matching entry in backend/mrpc_manager.py (EP table,
MrpcSession._send_params, or the _g(...) field aliases) and run again."""
import asyncio, getpass, json, os, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
os.environ.setdefault("SESSION_SECRET", "probe" * 8)
from mrpc_manager import EP, MrpcError, MrpcHttp, _parse_sid  # noqa: E402


async def main():
    if len(sys.argv) < 3 or not os.getenv("MRPC_API_KEY"):
        sys.exit(__doc__)
    login, server = sys.argv[1], sys.argv[2]
    plat = sys.argv[3] if len(sys.argv) > 3 else "mt5"
    sym = sys.argv[4] if len(sys.argv) > 4 else "EURUSD"
    pw = os.getenv("MRPC_PASSWORD") or getpass.getpass("Demo account password: ")
    cli = MrpcHttp(os.environ["MRPC_API_KEY"])
    sid = None
    now = datetime.now(timezone.utc); fmt = "%Y-%m-%dT%H:%M:%S"
    steps = [
        ("connect", dict(user=login, password=pw, mtClusterName=server)),
        ("account", {}), ("opened", {}), ("symbols", {}), ("symbol_params", dict(symbol=sym)), ("quote", dict(symbol=sym)),
        ("candles", {"symbol": sym, "timeframe": 60, "from": (now - timedelta(days=3)).strftime(fmt), "to": now.strftime(fmt)}),
        ("history", {"from": (now - timedelta(days=30)).strftime(fmt), "to": now.strftime(fmt)}),
    ]
    try:
        for name, params in steps:
            try:
                res = await cli.call(plat, EP[name], params, sid)
                if name == "connect":
                    sid = _parse_sid(res)
                    print(f"OK   {name:<14} {EP[name]}  -> terminal id {sid[:8]}...")
                    await asyncio.sleep(5)
                    continue
                print(f"OK   {name:<14} {EP[name]}\n     {json.dumps(res, default=str)[:400]}")
            except (MrpcError, Exception) as e:  # noqa: BLE001
                print(f"FAIL {name:<14} {EP[name]}  -> {type(e).__name__}: {getattr(e, 'message', e)}")
                if name == "connect":
                    return
    finally:
        if sid:
            try:
                await cli.call(plat, EP["disconnect"], None, sid); print("OK   disconnect")
            except Exception as e:  # noqa: BLE001
                print("FAIL disconnect", e)
    print("\nNot called (trade-changing): send, close, modify. Compare their names/params with mt5.mrpc.pro/apiui "
          "(or mt4.mrpc.pro/apiui), then place ONE 0.01-lot demo order from the app to confirm.")

asyncio.run(main())
