from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Backend URL (via Cloudflare Tunnel B)
    BACKEND_URL: str = "https://api.example.com"

    # Local listener (cloudflared connects here)
    HOST: str = "127.0.0.1"
    PORT: int = 8443

    # Cloudflare Access Service Token (set in .env)
    CF_ACCESS_CLIENT_ID: str = ""
    CF_ACCESS_CLIENT_SECRET: str = ""

    # CORS: frontend origin
    ALLOWED_ORIGINS: list[str] = ["https://frontend.example.com"]

    # Rate limiting (requests per minute per IP)
    RATE_LIMIT_PER_MINUTE: int = 60

    # Timeout — use a long value for LLM inference
    PROXY_TIMEOUT: float = 300.0

    # Headers to strip before forwarding
    STRIPPED_HEADERS: set[str] = {
        "host",
        "connection",
        "transfer-encoding",
        "keep-alive",
        "upgrade",
    }

    model_config = {"env_file": ".env"}


settings = Settings()
