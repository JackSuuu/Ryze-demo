# Ryze-demo — BioVLM Comparison Dashboard

## Project Overview

A comparison dashboard that lets users chat with **BioVLM** (custom biomedical vision-language model) and **OpenAI GPT** side-by-side. Supports text and image (multimodal) input.

## Architecture

```
frontend/ (vanilla HTML/CSS/JS)  →  backend/ (FastAPI, Python)
                                          ↓
                                  BioVLM model (vLLM / transformers / mock)
                                  OpenAI GPT API
```

- **Frontend**: Static site served via nginx, configurable API endpoint (default `http://localhost:3001`)
- **Backend**: FastAPI app (`backend/app.py`), default port `8000`
- **Mock server**: `mock_server.py` on port `3001` for local dev/testing (echoes input)
- **Alternative backend**: `backend/app_sllm.py` — uses ServerlessLLM for model serving

## API Contract

### Endpoints the Frontend Calls

| Method | Endpoint         | Purpose                        |
|--------|------------------|--------------------------------|
| POST   | `/chat`          | BioVLM non-streaming chat      |
| POST   | `/chat/stream`   | BioVLM streaming chat (SSE)    |
| POST   | `/chat/gpt`      | OpenAI GPT chat                |

All three share the same request format. The frontend selects `/chat` vs `/chat/stream` based on `CONFIG.streamMode`.

### Request Format (all POST endpoints)

```json
{
  "messages": [
    {
      "role": "user" | "assistant",
      "content": "string",
      "image": "base64_string | null"
    }
  ],
  "max_tokens": 2048,
  "temperature": 0.7,
  "stream": false
}
```

### Response Formats

**`POST /chat`** — JSON:
```json
{
  "response": "assistant reply text",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**`POST /chat/stream`** — Server-Sent Events:
```
data: word1
data: word2
data: [DONE]
```

**`POST /chat/gpt`** — JSON:
```json
{
  "response": "GPT reply text",
  "model": "gpt-4o-mini",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Error responses:
- `429` — Rate limited: `{ "detail": { "message": "...", "seconds_remaining": N } }`
- `503` — API key not configured: `{ "detail": "..." }`

### Backend-Only Endpoints (not called by frontend)

| Method | Endpoint              | Purpose                          |
|--------|-----------------------|----------------------------------|
| GET    | `/`                   | Welcome / status                 |
| GET    | `/health`             | Health check                     |
| POST   | `/chat/multimodal`    | Multimodal chat via form upload  |
| GET    | `/chat/gpt/status`    | GPT rate limit status            |
| POST   | `/deploy`             | Deploy model (sllm backend only) |

## Backend → LLM Flow

### BioVLM (`/chat`, `/chat/stream`)

Request → `generate_response()` in `backend/app.py:227`, which tries backends in order:

1. **vLLM** (preferred) — uses `processor.apply_chat_template()` to build prompt with image placeholders, then `llm_engine.generate()` with `multi_modal_data={"image": pil_images}` when images are present
2. **ServerlessLLM** — loads model via `sllm_store.transformers.load_model()`, then uses transformers generate
3. **Transformers** — uses `processor.apply_chat_template()` + `processor()` for combined text+image encoding when images present, falls back to tokenizer-only for text
4. **Mock** (fallback) — returns canned response after 0.5s delay, acknowledges received images

Prompt construction:
- **With `AutoProcessor`** (default): Uses `processor.apply_chat_template()` for proper Qwen-VL chat format with image tokens
- **Without processor** (fallback): Naive `User:/Assistant:` concatenation (text-only)

Image handling in `generate_response()`:
- `build_multimodal_messages()` converts `List[Message]` to Qwen-VL format, decoding base64 images to PIL via `base64_to_pil()`
- vLLM receives images via `multi_modal_data` parameter
- Transformers receives images via `processor(text=..., images=...)` call

Streaming (`/chat/stream`): generates full response first, then yields word-by-word as SSE. Not true token streaming.

### GPT (`/chat/gpt`)

1. Rate limit check — 60s cooldown enforced via async lock (`app.py:442`)
2. Messages mapped to OpenAI format — text-only messages use `{"role": ..., "content": "..."}`, image messages use vision format with `{"type": "image_url", "image_url": {"url": "data:...", "detail": "auto"}}` (`app.py:453-466`)
3. Calls `openai.AsyncOpenAI.chat.completions.create()` (`app.py:321`)

### Known Gaps

- **Fake streaming** — full generation then word-by-word drip
- **Token counts are word counts** — `len(text.split())` used for usage stats

## Frontend Config

Stored in `localStorage`, defaults in `frontend/js/app.js`:

| Key            | Default                  |
|----------------|--------------------------|
| `apiEndpoint`  | `http://localhost:3001`  |
| `temperature`  | `0.7`                    |
| `maxTokens`    | `2048`                   |
| `streamMode`   | `false`                  |
| `openaiApiKey` | `""`                     |
| `gptModel`     | `gpt-5-mini`             |

## Key Files

```
backend/app.py          — Main FastAPI backend
backend/app_sllm.py     — ServerlessLLM variant backend
frontend/js/app.js      — All frontend logic (API calls, UI)
frontend/css/style.css   — Styles
frontend/index.html      — Single page
mock_server.py           — Dev mock server (port 3001)
nginx.conf               — Nginx config for production
docker-compose.yml       — Docker deployment
```

## Running Locally

- Mock dev server: `python mock_server.py` (port 3001)
- Full backend: `cd backend && uvicorn app:app --port 8000`
- Frontend: Open `frontend/index.html` or serve via nginx
- Docker: `docker-compose up`
