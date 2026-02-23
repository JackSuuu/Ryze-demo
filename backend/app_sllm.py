"""
BioVLM Chatbot Backend - ServerlessLLM Integration
Uses ServerlessLLM's OpenAI-compatible API
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
import httpx

# Configuration
LLM_SERVER_URL = os.environ.get("LLM_SERVER_URL", "http://localhost:8343")
MODEL_NAME = os.environ.get("MODEL_NAME", "chivier/biolvlm-8b-grpo")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
GPT_RATE_LIMIT_SECONDS = 60

app = FastAPI(
    title="BioVLM Chatbot API",
    description="Chatbot powered by BioVLM via ServerlessLLM",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


async def check_model_deployed() -> bool:
    """Check if model is deployed on ServerlessLLM"""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{LLM_SERVER_URL}/v1/models")
            if response.status_code == 200:
                models = response.json()
                return any(m.get("id") == MODEL_NAME for m in models.get("data", []))
    except Exception:
        pass
    return False


async def deploy_model():
    """Deploy model to ServerlessLLM"""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            if await check_model_deployed():
                print(f"Model {MODEL_NAME} already deployed")
                return True

            print(f"Deploying model {MODEL_NAME}...")
            response = await client.post(
                f"{LLM_SERVER_URL}/register",
                json={
                    "model": MODEL_NAME,
                    "backend": "transformers",
                    "num_gpus": 1,
                }
            )
            if response.status_code == 200:
                print(f"Model {MODEL_NAME} deployed successfully!")
                return True
            else:
                print(f"Failed to deploy model: {response.text}")
    except Exception as e:
        print(f"Error deploying model: {e}")
    return False


async def call_serverless_llm(messages: List[Dict], max_tokens: int, temperature: float) -> str:
    """Call BioVLM via ServerlessLLM API"""
    async with httpx.AsyncClient(timeout=120.0) as client:
        payload = {
            "model": MODEL_NAME,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        response = await client.post(
            f"{LLM_SERVER_URL}/v1/chat/completions",
            json=payload
        )

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)

        result = response.json()
        return result["choices"][0]["message"]["content"]


async def generate_response(messages: List[Message], max_tokens: int, temperature: float) -> str:
    """Generate response from BioVLM"""
    openai_messages = []
    for msg in messages:
        openai_messages.append({
            "role": msg.role,
            "content": msg.content
        })

    try:
        return await call_serverless_llm(openai_messages, max_tokens, temperature)
    except Exception as e:
        print(f"BioVLM error: {e}, using fallback response")
        await asyncio.sleep(0.3)
        user_msg = messages[-1].content if messages else "Hello"
        return f"Thank you for your message: \"{user_msg}\"\n\nI'm BioVLM. The model is currently loading or unavailable. Please try again in a moment."


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
    print(f"BioVLM ServerlessLLM URL: {LLM_SERVER_URL}")
    print(f"Model: {MODEL_NAME}")
    print(f"GPT Model: {OPENAI_MODEL}")
    await deploy_model()


@app.get("/")
async def root():
    deployed = await check_model_deployed()
    return {
        "message": "Welcome to BioVLM Chatbot API",
        "model": MODEL_NAME,
        "serverless_llm_url": LLM_SERVER_URL,
        "status": "ready" if deployed else "model_not_deployed"
    }


@app.get("/health")
async def health():
    deployed = await check_model_deployed()
    return {
        "status": "healthy",
        "model_deployed": deployed,
        "backend": "serverlessllm"
    }


@app.post("/deploy")
async def deploy():
    """Manually trigger model deployment"""
    success = await deploy_model()
    return {"success": success, "model": MODEL_NAME}


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
