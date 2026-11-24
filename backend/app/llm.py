import os
import time
import logging
from typing import Optional, List, Dict, Any, Tuple
from fastapi import HTTPException
import litellm
from litellm.caching.caching import Cache
from app.config import settings

logger = logging.getLogger("llm_gateway")

# Configure LiteLLM
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
litellm.telemetry = False
litellm.suppress_debug_info = True

# Built-in LiteLLM local cache
litellm.cache = Cache(type="local")


def parse_simulation_header(header_val: Optional[str]) -> Dict[str, int]:
    """
    Parses X-Simulate-Failure header.
    Format: comma-separated <key_id>=<status> pairs; * means every key.
    Statuses: 429, 500, 502, 503.
    e.g. 'key_1=429', 'key_1=429,key_2=500', '*=429'
    """
    if not header_val or not settings.ENABLE_FAILURE_SIMULATION:
        return {}

    allowed_statuses = {429, 500, 502, 503}
    simulations = {}
    for part in header_val.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        try:
            status = int(v.strip())
            if status in allowed_statuses:
                simulations[k] = status
        except ValueError:
            continue
    return simulations


def get_cache_key(model: str, messages: List[Dict[str, str]]) -> str:
    """Generate LiteLLM cache key for model + messages."""
    return litellm.cache.get_cache_key(model=model, messages=messages)


def extract_cached_data(cached_entry: Any) -> Tuple[str, int, int]:
    """Safely extracts (reply, input_tokens, output_tokens) from various LiteLLM cache payload types."""
    if isinstance(cached_entry, dict):
        if "reply" in cached_entry:
            return (
                str(cached_entry["reply"]),
                int(cached_entry.get("input_tokens", 0)),
                int(cached_entry.get("output_tokens", 0)),
            )
        if "choices" in cached_entry and cached_entry["choices"]:
            choice = cached_entry["choices"][0]
            msg = choice.get("message", {})
            reply = msg.get("content", "")
            usage = cached_entry.get("usage", {})
            return (
                str(reply),
                int(usage.get("prompt_tokens", 0)),
                int(usage.get("completion_tokens", 0)),
            )

    if hasattr(cached_entry, "choices") and cached_entry.choices:
        reply = getattr(cached_entry.choices[0].message, "content", "") or ""
        usage = getattr(cached_entry, "usage", None)
        in_tok = getattr(usage, "prompt_tokens", 0) or 0
        out_tok = getattr(usage, "completion_tokens", 0) or 0
        return str(reply), int(in_tok), int(out_tok)

    return str(cached_entry), 0, 0


async def generate_chat_response(
    messages: List[Dict[str, str]],
    simulate_failure_header: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Handles LLM chat completion with:
    1. Built-in LiteLLM caching (bypassed if failure simulation is active)
    2. Key pool iteration and auto-fallback on 429, quota, 5xx
    3. Simulated failures via X-Simulate-Failure header
    """
    model = settings.LLM_MODEL
    api_keys = settings.api_keys_list
    if not api_keys:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    simulations = parse_simulation_header(simulate_failure_header)
    is_simulation_active = bool(simulations)

    cache_key = get_cache_key(model=model, messages=messages)

    # 1. Check cache (only if simulation is not explicitly requested)
    if not is_simulation_active and litellm.cache:
        t0 = time.perf_counter()
        cached_entry = litellm.cache.get_cache(cache_key=cache_key)
        if cached_entry:
            reply_str, in_tok, out_tok = extract_cached_data(cached_entry)
            latency_ms = max(1, int((time.perf_counter() - t0) * 1000))
            return {
                "reply": reply_str,
                "metadata": {
                    "resolution_source": "LLM_CACHE",
                    "model": model,
                    "latency_ms": latency_ms,
                    "input_tokens": in_tok,
                    "output_tokens": out_tok,
                    "key_id": None,
                    "fallback_attempts": 0,
                },
            }

    # 2. Key pool iteration & live inference
    start_time = time.perf_counter()
    fallback_attempts = 0
    last_error = None

    for idx, api_key in enumerate(api_keys):
        key_id = f"key_{idx + 1}"

        # Check for simulated failure on this key
        simulated_status = None
        if is_simulation_active:
            if "*" in simulations:
                simulated_status = simulations["*"]
            elif key_id in simulations:
                simulated_status = simulations[key_id]

        if simulated_status is not None:
            logger.info("Simulating failure HTTP %s for key %s", simulated_status, key_id)
            fallback_attempts += 1
            last_error = f"Simulated error {simulated_status}"
            continue

        # Real inference attempt with current key
        try:
            response = await litellm.acompletion(
                model=model,
                messages=messages,
                api_key=api_key,
            )

            reply = response.choices[0].message.content or ""
            usage = getattr(response, "usage", None)
            input_tokens = (
                getattr(usage, "prompt_tokens", None)
                or sum(len(m.get("content", "")) for m in messages) // 4
                or 10
            )
            output_tokens = (
                getattr(usage, "completion_tokens", None)
                or len(reply) // 4
                or 5
            )
            latency_ms = max(1, int((time.perf_counter() - start_time) * 1000))

            # Store successful response in LiteLLM cache
            if litellm.cache:
                litellm.cache.add_cache(
                    cache_key=cache_key,
                    result={
                        "reply": reply,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    },
                )

            return {
                "reply": reply,
                "metadata": {
                    "resolution_source": "LIVE_INFERENCE",
                    "model": model,
                    "latency_ms": latency_ms,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "key_id": key_id,
                    "fallback_attempts": fallback_attempts,
                },
            }

        except Exception as exc:
            fallback_attempts += 1
            last_error = str(exc)
            logger.warning(
                "Inference failed with key %s: %s. Attempting fallback.",
                key_id,
                exc,
            )
            continue

    # All keys failed
    logger.error("All keys in pool failed. Last error: %s", last_error)
    raise HTTPException(status_code=503, detail="all providers unavailable")
