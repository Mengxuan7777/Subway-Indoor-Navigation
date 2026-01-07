import os, time
import requests
from typing import Literal, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from openai import OpenAI
from google import genai

load_dotenv(".env.local")  # local secrets only (not committed)

app = FastAPI(title="Local LLM Router")

# If your three.js is served from another local port, add it here
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:8001",
        "http://localhost:8001",
    ],
    allow_credentials=True,
    allow_methods=["*"],      # MUST include OPTIONS
    allow_headers=["*"],      # MUST include Content-Type
)

Provider = Literal["openai", "gemini", "deepseek"]

class LLMReq(BaseModel):
    provider: Provider
    model: str
    input: str
    system: Optional[str] = None  # optional system instruction
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None

class LLMResp(BaseModel):
    provider: str
    model: str
    latency_ms: int
    output_text: str
    raw: Dict[str, Any]


# ---------------- OpenAI (Responses API) ----------------
def call_openai(model: str, system: Optional[str], user_input: str, temperature: Optional[float], max_tokens: Optional[int]):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise HTTPException(500, "Missing OPENAI_API_KEY in .env.local")

    client = OpenAI(api_key=key)

    # Build a simple input; you can later expand to structured messages if needed
    input_text = user_input if not system else f"System:\n{system}\n\nUser:\n{user_input}"

    payload = {"model": model, "input": input_text}
    # Responses API has different knobs depending on model; keep minimal first.
    resp = client.responses.create(**payload)

    # output_text is a convenience field commonly present
    text = getattr(resp, "output_text", "") or ""
    raw = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    return text, raw


# ---------------- Gemini API (Google AI Studio / Developer API) ----------------
def call_gemini(model: str, system: Optional[str], user_input: str, temperature: Optional[float], max_tokens: Optional[int]):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise HTTPException(500, "Missing GEMINI_API_KEY in .env.local")

    # Google GenAI SDK supports api_key and/or env var GEMINI_API_KEY. :contentReference[oaicite:1]{index=1}
    client = genai.Client(api_key=key)

    # SDK: client.models.generate_content(model=..., contents=...) :contentReference[oaicite:2]{index=2}
    # Keep it simple: concatenate system + user into one contents string.
    contents = user_input if not system else f"{system}\n\n{user_input}"

    kwargs = {}
    # If you want strict control later, Gemini uses generation_config; keeping minimal now.
    # (Different model families expose different config fields.)
    resp = client.models.generate_content(
        model=model,
        contents=contents,
    )

    # resp.text is the simplest text extraction in many SDK responses
    text = getattr(resp, "text", None)
    if text is None:
        # fallback: try to stringify
        text = str(resp)

    # raw: best-effort serialization
    raw = resp.model_dump() if hasattr(resp, "model_dump") else {"response": str(resp)}
    try:
        client.close()
    except Exception:
        pass

    return text, raw


# ---------------- DeepSeek "native" (official endpoint) ----------------
def call_deepseek(model: str, system: Optional[str], user_input: str, temperature: Optional[float], max_tokens: Optional[int]):
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise HTTPException(500, "Missing DEEPSEEK_API_KEY in .env.local")

    # Official docs show base_url https://api.deepseek.com and POST /chat/completions. :contentReference[oaicite:3]{index=3}
    url = "https://api.deepseek.com/chat/completions"

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user_input})

    payload: Dict[str, Any] = {
        "model": model,           # e.g., "deepseek-chat" or "deepseek-reasoner" :contentReference[oaicite:4]{index=4}
        "messages": messages,
        "stream": False,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    data = r.json()
    if r.status_code >= 400:
        raise HTTPException(r.status_code, detail=data)

    # DeepSeek chat completion: choices[0].message.content :contentReference[oaicite:5]{index=5}
    text = ""
    try:
        text = data["choices"][0]["message"]["content"]
    except Exception:
        text = ""

    return text, data


@app.post("/llm", response_model=LLMResp)
def llm(req: LLMReq):
    t0 = time.time()
    try:
        if req.provider == "openai":
            text, raw = call_openai(req.model, req.system, req.input, req.temperature, req.max_tokens)
        elif req.provider == "gemini":
            text, raw = call_gemini(req.model, req.system, req.input, req.temperature, req.max_tokens)
        elif req.provider == "deepseek":
            text, raw = call_deepseek(req.model, req.system, req.input, req.temperature, req.max_tokens)
        else:
            raise HTTPException(400, "Unknown provider")

        latency_ms = int((time.time() - t0) * 1000)
        return LLMResp(provider=req.provider, model=req.model, latency_ms=latency_ms, output_text=text, raw=raw)

    except HTTPException:
        raise
    except Exception as e:
        # This makes your frontend show the true cause instead of just "500"
        raise HTTPException(status_code=500, detail=str(e))

