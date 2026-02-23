"""
BioVLM Chatbot Backend
"""
import os
import base64
import asyncio
import time
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

# Check for HuggingFace token
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

# OpenAI configuration
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
GPT_RATE_LIMIT_SECONDS = 60

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
    version="1.0.0"
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

# GPT rate limit state
_gpt_last_call_time: float = 0.0
_gpt_rate_lock = asyncio.Lock()


class Message(BaseModel):
    role: str
    content: str
    image: Optional[str] = None


class ChatRequest(BaseModel):
    messages: List[Message]
    max_tokens: int = 2048
    temperature: float = 0.7
    stream: bool = False


class ChatResponse(BaseModel):
    response: str
    usage: Dict[str, int]


class GPTChatResponse(BaseModel):
    response: str
    model: str
    usage: Dict[str, int]


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
            )
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
            tokenizer = AutoTokenizer.from_pretrained(
                MODEL_NAME,
                trust_remote_code=True,
                token=HF_TOKEN
            )
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


def process_image(image_base64: str) -> bytes:
    """Process base64 image"""
    if image_base64.startswith("data:"):
        image_base64 = image_base64.split(",")[1]
    return base64.b64decode(image_base64)


async def generate_response(messages: List[Message], max_tokens: int, temperature: float) -> str:
    """Generate response from BioVLM"""
    global model, tokenizer, llm_engine

    # Build prompt
    prompt_parts = []
    for msg in messages:
        role = "User" if msg.role == "user" else "Assistant"
        prompt_parts.append(f"{role}: {msg.content}")
    prompt = "\n".join(prompt_parts) + "\nAssistant:"

    # vLLM generation
    if llm_engine is not None:
        sampling_params = SamplingParams(
            temperature=temperature,
            max_tokens=max_tokens,
        )
        outputs = llm_engine.generate([prompt], sampling_params)
        return outputs[0].outputs[0].text.strip()

    # Transformers generation
    if model is not None and tokenizer is not None:
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
    user_msg = messages[-1].content if messages else "Hello"
    mock_responses = [
        f"Thank you for your message! As BioVLM, I received your question: \"{user_msg}\"\n\nI'm an AI assistant. Currently running in demo mode.",
        f"Hello! I'm BioVLM, a vision-language AI assistant.\n\nRegarding your question \"{user_msg}\", I can analyze it from multiple perspectives. What aspects would you like me to focus on?",
        f"Got it! Processing your request: \"{user_msg}\"\n\nAs a multimodal AI, I can understand both text and images. How can I help you today?"
    ]
    import random
    return random.choice(mock_responses)


async def generate_stream(messages: List[Message], max_tokens: int, temperature: float):
    """Stream response"""
    response = await generate_response(messages, max_tokens, temperature)
    words = response.split()
    for word in words:
        yield f"data: {word} \n\n"
        await asyncio.sleep(0.03)
    yield "data: [DONE]\n\n"


async def call_openai_gpt(messages: List[Dict], max_tokens: int, temperature: float) -> str:
    """Call OpenAI GPT API"""
    try:
        import openai
        client = openai.AsyncOpenAI(api_key=OPENAI_API_KEY)
        response = await client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return response.choices[0].message.content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI API error: {str(e)}")


@app.on_event("startup")
async def startup_event():
    print(f"GPT Model: {OPENAI_MODEL}")
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


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        response = await generate_response(
            request.messages,
            request.max_tokens,
            request.temperature
        )
        return ChatResponse(
            response=response,
            usage={
                "prompt_tokens": sum(len(m.content.split()) for m in request.messages),
                "completion_tokens": len(response.split()),
                "total_tokens": sum(len(m.content.split()) for m in request.messages) + len(response.split())
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    return StreamingResponse(
        generate_stream(request.messages, request.max_tokens, request.temperature),
        media_type="text/event-stream"
    )


@app.post("/chat/multimodal")
async def chat_multimodal(
    message: str = Form(...),
    image: Optional[UploadFile] = File(None),
    max_tokens: int = Form(2048),
    temperature: float = Form(0.7)
):
    image_base64 = None
    if image:
        contents = await image.read()
        image_base64 = base64.b64encode(contents).decode()

    messages = [Message(role="user", content=message, image=image_base64)]

    try:
        response = await generate_response(messages, max_tokens, temperature)
        return ChatResponse(
            response=response,
            usage={
                "prompt_tokens": len(message.split()),
                "completion_tokens": len(response.split()),
                "total_tokens": len(message.split()) + len(response.split())
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/gpt/status")
async def gpt_status():
    """Check GPT rate limit status"""
    current_time = time.time()
    elapsed = current_time - _gpt_last_call_time
    remaining = max(0, int(GPT_RATE_LIMIT_SECONDS - elapsed)) if _gpt_last_call_time > 0 else 0
    return {
        "available": remaining == 0,
        "seconds_remaining": remaining,
        "rate_limit_seconds": GPT_RATE_LIMIT_SECONDS,
        "model": OPENAI_MODEL
    }


@app.post("/chat/gpt", response_model=GPTChatResponse)
async def chat_gpt(request: ChatRequest):
    """Chat with GPT (rate limited: 1 call per minute)"""
    global _gpt_last_call_time

    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured. Set OPENAI_API_KEY env var.")

    async with _gpt_rate_lock:
        current_time = time.time()
        elapsed = current_time - _gpt_last_call_time
        if _gpt_last_call_time > 0 and elapsed < GPT_RATE_LIMIT_SECONDS:
            remaining = int(GPT_RATE_LIMIT_SECONDS - elapsed)
            raise HTTPException(
                status_code=429,
                detail={"message": "Rate limited", "seconds_remaining": remaining}
            )
        _gpt_last_call_time = current_time

    openai_messages = [{"role": m.role, "content": m.content} for m in request.messages]

    try:
        response = await call_openai_gpt(openai_messages, request.max_tokens, request.temperature)
        return GPTChatResponse(
            response=response,
            model=OPENAI_MODEL,
            usage={
                "prompt_tokens": sum(len(m.content.split()) for m in request.messages),
                "completion_tokens": len(response.split()),
                "total_tokens": sum(len(m.content.split()) for m in request.messages) + len(response.split())
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
