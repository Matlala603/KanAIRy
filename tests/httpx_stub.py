"""Tiny stand-in for httpx (only what the tests use) so they run where httpx cannot be installed."""
import json as _json, sys, types
from urllib.parse import urlsplit, parse_qsl

m = types.ModuleType("httpx")
class HTTPError(Exception): pass
class TimeoutException(HTTPError): pass
class ReadTimeout(TimeoutException): pass
class _Url:
    def __init__(self, url, params):
        u = urlsplit(url); self.path = u.path
        self.params = dict(parse_qsl(u.query)); self.params.update({k: str(v) for k, v in (params or {}).items()})
class Request:
    def __init__(self, url, params, headers): self.url = _Url(url, params); self.headers = {k.lower(): v for k, v in (headers or {}).items()}
class Response:
    def __init__(self, status_code, json=None, text=None):
        self.status_code = status_code
        self.text = text if text is not None else (_json.dumps(json) if json is not None else "")
    def json(self):
        try: return _json.loads(self.text)
        except ValueError as e: raise ValueError(str(e))
class MockTransport:
    def __init__(self, handler): self.handler = handler
class AsyncClient:
    def __init__(self, *a, transport=None, **k): self.transport = transport
    async def get(self, url, params=None, headers=None):
        return self.transport.handler(Request(url, params, headers))
for n, v in dict(HTTPError=HTTPError, TimeoutException=TimeoutException, ReadTimeout=ReadTimeout, Request=Request,
                 Response=Response, MockTransport=MockTransport, AsyncClient=AsyncClient).items(): setattr(m, n, v)
sys.modules["httpx"] = m
