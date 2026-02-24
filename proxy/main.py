"""
Ryze Demo — Server A Reverse Proxy
Serves frontend static files + proxies /api/* to the backend on Server B.
CF Access Service Token is injected on every forwarded request.
SSE streaming (for LLM responses) is handled transparently.
"""

import json
import time
import logging
from collections import defaultdict
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("proxy")

http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        base_url=settings.BACKEND_URL,
        timeout=httpx.Timeout(settings.PROXY_TIMEOUT),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
    logger.info(f"Proxy started → {settings.BACKEND_URL}")
    yield
    await http_client.aclose()


app = FastAPI(
    title="Ryze Proxy",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rate Limiter ─────────────────────────────────────────────────────────────

rate_limit_store: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(client_ip: str) -> bool:
    now = time.time()
    window = [t for t in rate_limit_store[client_ip] if now - t < 60.0]
    rate_limit_store[client_ip] = window
    if len(window) >= settings.RATE_LIMIT_PER_MINUTE:
        return False
    rate_limit_store[client_ip].append(now)
    return True


def get_client_ip(request: Request) -> str:
    if cf_ip := request.headers.get("cf-connecting-ip"):
        return cf_ip
    if forwarded := request.headers.get("x-forwarded-for"):
        return forwarded.split(",")[0].strip()
    return request.client.host


def filter_request_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in settings.STRIPPED_HEADERS}


def filter_response_headers(headers: httpx.Headers) -> dict:
    skip = {"transfer-encoding", "connection", "content-encoding"}
    return {k: v for k, v in headers.items() if k.lower() not in skip}


# ── Reverse Proxy ─────────────────────────────────────────────────────────────

@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def reverse_proxy(path: str, request: Request):
    client_ip = get_client_ip(request)

    if not check_rate_limit(client_ip):
        logger.warning(f"Rate limit hit: {client_ip}")
        raise HTTPException(429, "Too many requests")

    target_url = f"/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    req_headers = filter_request_headers(dict(request.headers))
    req_headers["X-Forwarded-For"] = client_ip
    req_headers["X-Real-IP"] = client_ip

    # Inject Cloudflare Access Service Token (if configured)
    if settings.CF_ACCESS_CLIENT_ID:
        req_headers["CF-Access-Client-Id"] = settings.CF_ACCESS_CLIENT_ID
        req_headers["CF-Access-Client-Secret"] = settings.CF_ACCESS_CLIENT_SECRET

    body = await request.body()

    # Detect SSE streaming: check for "stream": true in JSON body
    is_sse = False
    if body:
        try:
            is_sse = bool(json.loads(body).get("stream", False))
        except Exception:
            pass

    logger.info(f"{client_ip} | {request.method} /api/{path} [sse={is_sse}]")

    if is_sse:
        # ── Streaming path: yield chunks as they arrive ───────────────
        async def stream_generator():
            try:
                async with http_client.stream(
                    method=request.method,
                    url=target_url,
                    headers=req_headers,
                    content=body,
                ) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
            except httpx.TimeoutException:
                logger.error(f"Streaming timeout: {target_url}")
                yield b"data: [DONE]\n\n"
            except httpx.ConnectError:
                logger.error(f"Backend unreachable during stream: {settings.BACKEND_URL}")
                yield b"data: [DONE]\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",  # disable nginx buffering
            },
        )

    # ── Non-streaming path ────────────────────────────────────────────
    try:
        resp = await http_client.request(
            method=request.method,
            url=target_url,
            headers=req_headers,
            content=body,
        )
    except httpx.TimeoutException:
        logger.error(f"Timeout: {request.method} {target_url}")
        raise HTTPException(504, "Backend timeout")
    except httpx.ConnectError:
        logger.error(f"Backend unreachable: {settings.BACKEND_URL}")
        raise HTTPException(502, "Backend unavailable")

    logger.info(f"{client_ip} | {request.method} /api/{path} → {resp.status_code}")
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=filter_response_headers(resp.headers),
    )


# ── Frontend static files (must be last) ─────────────────────────────────────

app.mount("/", StaticFiles(directory="public", html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
