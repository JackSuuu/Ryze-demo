"""
BioVLM Chatbot Backend — OpenAI-compatible API
"""
import os
import base64
import asyncio
import json
import time
import uuid
from typing import Optional, List, Dict, Any, Union, Tuple
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
from io import BytesIO

# Check for HuggingFace token
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

# OpenAI configuration
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
ALLOWED_MODELS = {"openai/gpt-5-mini", "local/biolvlm-8b-grpo"}

# Ollama configuration
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "biovlm:latest")

# Cloudflare Access credentials for BioVLM (only needed when BioVLM is
# behind CF Tunnel on a remote server; leave empty for local dev)
CF_BIOLVLM_CLIENT_ID = os.environ.get("CF_BIOLVLM_CLIENT_ID", "")
CF_BIOLVLM_CLIENT_SECRET = os.environ.get("CF_BIOLVLM_CLIENT_SECRET", "")

# Reusable httpx client that injects CF Access headers (None = no auth needed)
import httpx as _httpx
_biolvlm_http_client = (
    _httpx.AsyncClient(headers={
        "CF-Access-Client-Id": CF_BIOLVLM_CLIENT_ID,
        "CF-Access-Client-Secret": CF_BIOLVLM_CLIENT_SECRET,
    })
    if CF_BIOLVLM_CLIENT_ID else None
)

# ServerlessLLM imports
SLLM_AVAILABLE = False
try:
    from sllm import Sllm
    SLLM_AVAILABLE = True
    print("ServerlessLLM is available")
except ImportError:
    print("ServerlessLLM not installed. Install with: pip install serverless-llm")

# Transformers fallback
TRANSFORMERS_AVAILABLE = False
try:
    from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
    import torch
    TRANSFORMERS_AVAILABLE = True
    print("Transformers is available")
except ImportError:
    print("Transformers not installed")

try:
    from PIL import Image as PILImage
except ImportError:
    PILImage = None
    print("Pillow not installed")

# vLLM support (recommended for production)
VLLM_AVAILABLE = False
try:
    from vllm import LLM, SamplingParams
    VLLM_AVAILABLE = True
    print("vLLM is available")
except ImportError:
    print("vLLM not installed. Install with: pip install vllm")

app = FastAPI(
    title="BioVLM Chatbot API",
    description="A powerful chatbot powered by BioVLM",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Model configuration
MODEL_NAME = os.environ.get("MODEL_NAME", "chivier/biolvlm-8b-grpo")
model = None
processor = None
tokenizer = None
llm_engine = None


# ============================================
# Pydantic Models — OpenAI-compatible
# ============================================

class ImageUrl(BaseModel):
    url: str
    detail: Optional[str] = "auto"


class ContentPartText(BaseModel):
    type: str = "text"
    text: str


class ContentPartImage(BaseModel):
    type: str = "image_url"
    image_url: ImageUrl


class ChatMessage(BaseModel):
    role: str
    content: Union[str, List[Union[ContentPartText, ContentPartImage, Dict[str, Any]]]]


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    max_tokens: Optional[int] = 2048
    temperature: Optional[float] = 0.7
    stream: Optional[bool] = False


class ChatCompletionMessage(BaseModel):
    role: str
    content: str


class ChatCompletionChoice(BaseModel):
    index: int
    message: ChatCompletionMessage
    finish_reason: str


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: Dict[str, int]


# ============================================
# Model Loading
# ============================================

def load_model():
    """Load the model using available backend"""
    global model, processor, tokenizer, llm_engine

    # Try vLLM first (best for production)
    if VLLM_AVAILABLE:
        print(f"Loading model {MODEL_NAME} via vLLM...")
        try:
            llm_engine = LLM(
                model=MODEL_NAME,
                trust_remote_code=True,
                dtype="bfloat16",
                max_model_len=4096,
                limit_mm_per_prompt={"image": 4},
            )
            if TRANSFORMERS_AVAILABLE:
                try:
                    processor = AutoProcessor.from_pretrained(
                        MODEL_NAME, trust_remote_code=True, token=HF_TOKEN
                    )
                    print("Processor loaded for vLLM multimodal support")
                except Exception as pe:
                    print(f"Processor loading failed (text-only mode): {pe}")
            print("Model loaded successfully via vLLM!")
            return True
        except Exception as e:
            print(f"vLLM loading failed: {e}")

    # Try ServerlessLLM
    if SLLM_AVAILABLE:
        print(f"Loading model {MODEL_NAME} via ServerlessLLM...")
        try:
            from sllm_store.transformers import load_model as sllm_load
            model = sllm_load(MODEL_NAME)
            tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
            print("Model loaded successfully via ServerlessLLM!")
            return True
        except Exception as e:
            print(f"ServerlessLLM loading failed: {e}")

    # Fallback to transformers
    if TRANSFORMERS_AVAILABLE:
        print(f"Loading model {MODEL_NAME} via transformers...")
        try:
            try:
                processor = AutoProcessor.from_pretrained(
                    MODEL_NAME, trust_remote_code=True, token=HF_TOKEN
                )
                tokenizer = processor.tokenizer
                print("AutoProcessor loaded (multimodal support enabled)")
            except Exception:
                processor = None
                tokenizer = AutoTokenizer.from_pretrained(
                    MODEL_NAME, trust_remote_code=True, token=HF_TOKEN
                )
                print("Falling back to AutoTokenizer (text-only)")
            model = AutoModelForCausalLM.from_pretrained(
                MODEL_NAME,
                torch_dtype=torch.bfloat16,
                device_map="auto",
                trust_remote_code=True,
                token=HF_TOKEN
            )
            print("Model loaded successfully via transformers!")
            return True
        except Exception as e:
            print(f"Transformers loading failed: {e}")

    print("Running in mock mode - no model loaded")
    return False


# ============================================
# Utility Functions
# ============================================

def process_image(image_base64: str) -> bytes:
    """Process base64 image"""
    if image_base64.startswith("data:"):
        image_base64 = image_base64.split(",")[1]
    return base64.b64decode(image_base64)


def base64_to_pil(image_base64: str) -> "PILImage.Image":
    """Decode a base64 image string to a PIL Image in RGB."""
    raw = process_image(image_base64)
    return PILImage.open(BytesIO(raw)).convert("RGB")


def ensure_data_uri(image_base64: str) -> str:
    """Ensure a base64 string has a data URI prefix (needed by OpenAI)."""
    if image_base64.startswith("data:"):
        return image_base64
    return f"data:image/jpeg;base64,{image_base64}"


# ============================================
# Model Routing & Message Parsing
# ============================================

def parse_model_id(model: str) -> Tuple[str, str]:
    """Parse 'provider/model_name' into (provider, model_name).
    If no slash, treat entire string as model_name with provider='local'.
    """
    if "/" in model:
        provider, _, model_name = model.partition("/")
        return provider.lower(), model_name
    return "local", model


def parse_openai_messages(messages: List[ChatMessage]) -> Tuple[List[dict], List]:
    """Convert OpenAI-format messages to internal Qwen-VL format.
    Returns: (qwen_messages, pil_images)
    """
    qwen_messages = []
    pil_images = []
    for msg in messages:
        if isinstance(msg.content, str):
            qwen_messages.append({"role": msg.role, "content": msg.content})
        else:
            text_parts = []
            msg_images = []
            for part in msg.content:
                part_dict = part if isinstance(part, dict) else part.model_dump() if hasattr(part, 'model_dump') else {}
                if part_dict.get("type") == "text":
                    text_parts.append(part_dict.get("text", ""))
                elif part_dict.get("type") == "image_url":
                    url = part_dict.get("image_url", {}).get("url", "")
                    if PILImage is not None and url:
                        pil_img = base64_to_pil(url)
                        msg_images.append(pil_img)
                        pil_images.append(pil_img)
            combined_text = " ".join(text_parts)
            if msg_images:
                content_parts = [{"type": "image", "image": img} for img in msg_images]
                content_parts.append({"type": "text", "text": combined_text})
                qwen_messages.append({"role": msg.role, "content": content_parts})
            else:
                qwen_messages.append({"role": msg.role, "content": combined_text})
    return qwen_messages, pil_images


# ============================================
# Generation
# ============================================

async def generate_response_from_parsed(qwen_messages: list, pil_images: list, max_tokens: int, temperature: float) -> str:
    """Generate response from BioVLM using pre-parsed Qwen-VL format messages."""
    global model, tokenizer, llm_engine

    has_images = len(pil_images) > 0

    # vLLM generation
    if llm_engine is not None:
        sampling_params = SamplingParams(
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if processor is not None:
            prompt = processor.apply_chat_template(
                qwen_messages, tokenize=False, add_generation_prompt=True
            )
            mm_data = {"image": pil_images} if has_images else None
            outputs = llm_engine.generate(
                [prompt], sampling_params, multi_modal_data=mm_data
            )
        else:
            prompt_parts = []
            for msg in qwen_messages:
                content = msg["content"] if isinstance(msg["content"], str) else " ".join(
                    p.get("text", "") for p in msg["content"] if isinstance(p, dict) and p.get("type") == "text"
                )
                role = "User" if msg["role"] == "user" else "Assistant"
                prompt_parts.append(f"{role}: {content}")
            prompt = "\n".join(prompt_parts) + "\nAssistant:"
            outputs = llm_engine.generate([prompt], sampling_params)
        return outputs[0].outputs[0].text.strip()

    # Transformers generation
    if model is not None and tokenizer is not None:
        if processor is not None and has_images:
            prompt = processor.apply_chat_template(
                qwen_messages, tokenize=False, add_generation_prompt=True
            )
            inputs = processor(
                text=[prompt], images=pil_images, return_tensors="pt", padding=True
            ).to(model.device)
        else:
            if processor is not None:
                prompt = processor.apply_chat_template(
                    qwen_messages, tokenize=False, add_generation_prompt=True
                )
            else:
                prompt_parts = []
                for msg in qwen_messages:
                    content = msg["content"] if isinstance(msg["content"], str) else " ".join(
                        p.get("text", "") for p in msg["content"] if isinstance(p, dict) and p.get("type") == "text"
                    )
                    role = "User" if msg["role"] == "user" else "Assistant"
                    prompt_parts.append(f"{role}: {content}")
                prompt = "\n".join(prompt_parts) + "\nAssistant:"
            inputs = tokenizer(prompt, return_tensors="pt").to(model.device)

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=temperature,
                do_sample=True,
                pad_token_id=tokenizer.eos_token_id,
            )
        response = tokenizer.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        return response.strip()

    # Mock response
    await asyncio.sleep(0.5)
    last_msg = qwen_messages[-1] if qwen_messages else {"content": "Hello"}
    if isinstance(last_msg["content"], str):
        user_msg = last_msg["content"]
    else:
        user_msg = " ".join(
            p.get("text", "") for p in last_msg["content"] if isinstance(p, dict) and p.get("type") == "text"
        )
    image_note = ""
    if has_images:
        image_note = f"\n\n[I received {len(pil_images)} image(s) with your message. In production mode, I would analyze them using my vision capabilities.]"
    mock_responses = [
        f"Thank you for your message! As BioVLM, I received your question: \"{user_msg}\"\n\nI'm an AI assistant. Currently running in demo mode.{image_note}",
        f"Hello! I'm BioVLM, a vision-language AI assistant.\n\nRegarding your question \"{user_msg}\", I can analyze it from multiple perspectives. What aspects would you like me to focus on?{image_note}",
        f"Got it! Processing your request: \"{user_msg}\"\n\nAs a multimodal AI, I can understand both text and images. How can I help you today?{image_note}"
    ]
    import random
    return random.choice(mock_responses)


# ============================================
# Response Builders
# ============================================

def build_chat_completion(model_id: str, content: str) -> dict:
    """Build an OpenAI-compatible chat completion response."""
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": len(content.split()),
            "total_tokens": len(content.split())
        }
    }


async def generate_openai_stream(model_id: str, qwen_messages: list, pil_images: list, max_tokens: int, temperature: float):
    """Generate OpenAI-format SSE streaming chunks."""
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())

    response = await generate_response_from_parsed(qwen_messages, pil_images, max_tokens, temperature)

    # Role chunk
    yield f'data: {json.dumps({"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model_id, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})}\n\n'

    # Content chunks
    for word in response.split():
        yield f'data: {json.dumps({"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model_id, "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}]})}\n\n'
        await asyncio.sleep(0.03)

    # Stop chunk
    yield f'data: {json.dumps({"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model_id, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})}\n\n'

    yield "data: [DONE]\n\n"


# ============================================
# OpenAI Forwarding
# ============================================

async def openai_stream_proxy(response, model_id: str):
    """Proxy OpenAI streaming response, replacing model ID."""
    async for chunk in response:
        chunk_dict = chunk.model_dump()
        chunk_dict["model"] = model_id
        yield f"data: {json.dumps(chunk_dict)}\n\n"
    yield "data: [DONE]\n\n"


async def forward_to_openai(provider: str, model_name: str, request: ChatCompletionRequest):
    """Forward request to OpenAI API."""
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured. Set OPENAI_API_KEY env var.")
    # Map display model names to actual upstream model IDs
    model_name = OPENAI_MODEL

    import openai
    client_kwargs = {"api_key": OPENAI_API_KEY}
    if OPENAI_BASE_URL:
        client_kwargs["base_url"] = OPENAI_BASE_URL
    client = openai.AsyncOpenAI(**client_kwargs)

    # Convert messages to dicts for OpenAI
    openai_messages = []
    for msg in request.messages:
        if isinstance(msg.content, str):
            openai_messages.append({"role": msg.role, "content": msg.content})
        else:
            content_parts = []
            for part in msg.content:
                if isinstance(part, dict):
                    content_parts.append(part)
                else:
                    content_parts.append(part.model_dump())
            openai_messages.append({"role": msg.role, "content": content_parts})

    if request.stream:
        response = await client.chat.completions.create(
            model=model_name, messages=openai_messages,
            max_tokens=request.max_tokens, temperature=request.temperature, stream=True
        )
        return StreamingResponse(openai_stream_proxy(response, request.model), media_type="text/event-stream")

    response = await client.chat.completions.create(
        model=model_name, messages=openai_messages,
        max_tokens=request.max_tokens, temperature=request.temperature
    )
    result = response.model_dump()
    result["model"] = request.model
    return result


async def forward_to_ollama(request: ChatCompletionRequest):
    """Forward request to local Ollama instance (supports remote via CF Tunnel)."""
    import openai
    client = openai.AsyncOpenAI(
        base_url=f"{OLLAMA_BASE_URL}/v1",
        api_key="ollama",
        **(_biolvlm_http_client and {"http_client": _biolvlm_http_client} or {}),
    )

    # Convert messages to dicts
    ollama_messages = []
    for msg in request.messages:
        if isinstance(msg.content, str):
            ollama_messages.append({"role": msg.role, "content": msg.content})
        else:
            content_parts = []
            for part in msg.content:
                if isinstance(part, dict):
                    content_parts.append(part)
                else:
                    content_parts.append(part.model_dump())
            ollama_messages.append({"role": msg.role, "content": content_parts})

    if request.stream:
        response = await client.chat.completions.create(
            model=OLLAMA_MODEL, messages=ollama_messages,
            max_tokens=request.max_tokens, temperature=request.temperature, stream=True
        )
        return StreamingResponse(openai_stream_proxy(response, request.model), media_type="text/event-stream")

    response = await client.chat.completions.create(
        model=OLLAMA_MODEL, messages=ollama_messages,
        max_tokens=request.max_tokens, temperature=request.temperature
    )
    result = response.model_dump()
    result["model"] = request.model
    return result


# ============================================
# Endpoints
# ============================================

@app.on_event("startup")
async def startup_event():
    print(f"OpenAI Model: {OPENAI_MODEL}")
    load_model()


@app.get("/")
async def root():
    model_status = "ready"
    if llm_engine is not None:
        model_status = "vllm"
    elif model is not None:
        model_status = "transformers"
    else:
        model_status = "mock"

    return {
        "message": "Welcome to BioVLM Chatbot API",
        "model": MODEL_NAME,
        "status": model_status
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model_loaded": model is not None or llm_engine is not None,
        "backend": "vllm" if llm_engine else ("transformers" if model else "mock")
    }


@app.get("/v1/models")
async def list_models():
    """List available models."""
    models = [
        {"id": f"local/{MODEL_NAME.split('/')[-1]}", "object": "model", "owned_by": "local"}
    ]
    if OPENAI_API_KEY:
        models.append({"id": f"openai/{OPENAI_MODEL}", "object": "model", "owned_by": "openai"})
    return {"object": "list", "data": models}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """Unified chat completions endpoint (OpenAI-compatible)."""
    if request.model not in ALLOWED_MODELS:
        raise HTTPException(status_code=403, detail=f"Model not allowed: {request.model}. Allowed: {', '.join(ALLOWED_MODELS)}")
    provider, model_name = parse_model_id(request.model)

    if provider == "openai":
        return await forward_to_openai(provider, model_name, request)

    if provider == "local":
        return await forward_to_ollama(request)

    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}. Use local/* for BioVLM or openai/* for GPT.")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
