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

| Method | Endpoint                | Purpose                                      |
|--------|-------------------------|----------------------------------------------|
| POST   | `/v1/chat/completions`  | Unified chat (streaming via `stream` param)  |
| GET    | `/v1/models`            | List available models                        |

The frontend sends all requests to `/v1/chat/completions` with a `model` field that determines routing:
- `local/*` → BioVLM (e.g., `local/biolvlm-8b-grpo`)
- `openai/*` → OpenAI GPT API (e.g., `openai/gpt-4o-mini`)

### Request Format

```json
{
  "model": "local/biolvlm-8b-grpo",
  "messages": [
    {
      "role": "user",
      "content": "string or content array"
    }
  ],
  "max_tokens": 2048,
  "temperature": 0.7,
  "stream": false
}
```

Multimodal messages use content arrays:
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Describe this image" },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
  ]
}
```

### Response Formats

**Non-streaming** — JSON:
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "local/biolvlm-8b-grpo",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "response text" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 10, "total_tokens": 10 }
}
```

**Streaming** — Server-Sent Events:
```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"local/biolvlm-8b-grpo","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"local/biolvlm-8b-grpo","choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"local/biolvlm-8b-grpo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Error responses:
- `400` — Unknown provider: `{ "detail": "Unknown provider: ..." }`
- `503` — API key not configured: `{ "detail": "OpenAI API key not configured..." }`

### Backend-Only Endpoints

| Method | Endpoint    | Purpose        |
|--------|-------------|----------------|
| GET    | `/`         | Welcome/status |
| GET    | `/health`   | Health check   |

## Backend → LLM Flow

### Unified `/v1/chat/completions`

1. `parse_model_id(request.model)` extracts `(provider, model_name)` from `provider/model_name` format
2. If `provider == "openai"`: forwards to OpenAI API via `forward_to_openai()`
3. If `provider == "local"`: parses messages via `parse_openai_messages()` and generates via BioVLM

### BioVLM (local/* models)

Request → `parse_openai_messages()` converts OpenAI format to Qwen-VL format → `generate_response_from_parsed()` tries backends in order:

1. **vLLM** (preferred) — uses `processor.apply_chat_template()` to build prompt with image placeholders, then `llm_engine.generate()` with `multi_modal_data={"image": pil_images}` when images are present
2. **ServerlessLLM** — loads model via `sllm_store.transformers.load_model()`, then uses transformers generate
3. **Transformers** — uses `processor.apply_chat_template()` + `processor()` for combined text+image encoding when images present, falls back to tokenizer-only for text
4. **Mock** (fallback) — returns canned response after 0.5s delay, acknowledges received images

### GPT (openai/* models)

1. Messages converted to OpenAI format (already mostly compatible)
2. `forward_to_openai()` calls `openai.AsyncOpenAI.chat.completions.create()`
3. For streaming: proxied via `openai_stream_proxy()` with model ID replacement
4. For non-streaming: response returned with model ID replaced to keep `openai/` prefix

### Known Gaps

- **Fake streaming** — full generation then word-by-word drip (for local models)
- **Token counts are word counts** — `len(text.split())` used for usage stats

## Frontend Config

Stored in `localStorage`, defaults in `frontend/js/app.js`:

| Key            | Default                      |
|----------------|------------------------------|
| `apiEndpoint`  | `http://localhost:3001`      |
| `temperature`  | `0.7`                        |
| `maxTokens`    | `2048`                       |
| `streamMode`   | `false`                      |
| `biovlmModel`  | `local/biolvlm-8b-grpo`     |
| `gptModel`     | `openai/gpt-4o-mini`        |

## Key Files

```
backend/app.py          — Main FastAPI backend (OpenAI-compatible API)
backend/app_sllm.py     — ServerlessLLM variant backend
frontend/js/app.js      — All frontend logic (API calls, UI)
frontend/css/style.css   — Styles
frontend/index.html      — Single page
mock_server.py           — Dev mock server (port 3001, OpenAI-compatible)
nginx.conf               — Nginx config for production
docker-compose.yml       — Docker deployment
```

## Running Locally

- Mock dev server: `python mock_server.py` (port 3001)
- Full backend: `cd backend && uvicorn app:app --port 8000`
- Frontend: Open `frontend/index.html` or serve via nginx
- Docker: `docker-compose up`
