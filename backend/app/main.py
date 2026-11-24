import logging
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import get_session_messages, init_db, save_message, session_exists
from app.llm import generate_chat_response, litellm
from app.schemas import (
    ChatMetadata,
    ChatRequest,
    ChatResponse,
    HealthResponse,
    SessionMessagesResponse,
)

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite database schema
    init_db()
    yield


app = FastAPI(
    title="LLM Chatbot Gateway",
    description="LLM Chatbot with Key Failover and Response Caching",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS Middleware: allow all origins with regex pattern so Vercel, localhost, and custom domains work
origins = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if "*" not in origins else [],
    allow_origin_regex=r"^https?://.*" if "*" in origins else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# Global Exception Handlers to guarantee clean JSON responses with "detail"
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors())},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "internal server error"},
    )


@app.get("/")
async def root():
    """
    Root index endpoint directing to health and docs.
    """
    return {
        "status": "ok",
        "service": "Lyftr AI Gateway",
        "endpoints": {
            "health": "/health",
            "chat": "/chat",
            "docs": "/docs",
        },
    }


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Returns 200 once the app is running, the database is reachable and the key pool is loaded.
    """
    keys_configured = len(settings.api_keys_list)
    cache_enabled = litellm.cache is not None
    return HealthResponse(
        status="ok",
        keys_configured=keys_configured,
        cache_enabled=cache_enabled,
    )


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(
    payload: ChatRequest,
    x_simulate_failure: Optional[str] = Header(None, alias="X-Simulate-Failure"),
):
    """
    Handles user chat interaction with multi-turn history, key failover, and response caching.
    """
    session_id = payload.session_id
    user_message = payload.message
    system_prompt = payload.system_prompt or settings.DEFAULT_SYSTEM_PROMPT

    # 1. Fetch previous history from SQLite for multi-turn context
    history_messages = []
    if session_exists(session_id):
        existing_msgs = get_session_messages(session_id)
        for msg in existing_msgs:
            history_messages.append({"role": msg["role"], "content": msg["content"]})

    # 2. Build full message sequence sent to LLM
    llm_messages = [{"role": "system", "content": system_prompt}]
    llm_messages.extend(history_messages)
    llm_messages.append({"role": "user", "content": user_message})

    # 3. Call LLM Gateway (caching + key failover + failure simulation)
    # If this fails (e.g. 503), an HTTPException is raised and nothing is saved to DB
    result = await generate_chat_response(
        messages=llm_messages,
        simulate_failure_header=x_simulate_failure,
    )

    reply_text = result["reply"]
    meta = result["metadata"]

    # 4. Save both user message and assistant message to SQLite
    save_message(session_id=session_id, role="user", content=user_message)
    save_message(
        session_id=session_id,
        role="assistant",
        content=reply_text,
        metadata={
            "resolution_source": meta["resolution_source"],
            "input_tokens": meta["input_tokens"],
            "output_tokens": meta["output_tokens"],
        },
    )

    return ChatResponse(
        session_id=session_id,
        reply=reply_text,
        metadata=ChatMetadata(
            resolution_source=meta["resolution_source"],
            model=meta["model"],
            latency_ms=meta["latency_ms"],
            input_tokens=meta["input_tokens"],
            output_tokens=meta["output_tokens"],
            key_id=meta["key_id"],
            fallback_attempts=meta["fallback_attempts"],
        ),
    )


@app.get("/sessions/{session_id}/messages", response_model=SessionMessagesResponse)
async def get_messages_endpoint(session_id: str):
    """
    Returns the stored history of one session from SQLite, oldest first, without the system prompt.
    404 if session does not exist.
    """
    if not session_exists(session_id):
        raise HTTPException(status_code=404, detail="session not found")

    messages = get_session_messages(session_id)
    return SessionMessagesResponse(
        session_id=session_id,
        messages=messages,
    )
