import os
import tempfile
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

# Use temporary SQLite DB for testing
temp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
temp_db_path = temp_db.name
temp_db.close()

os.environ["DATABASE_URL"] = f"sqlite:///{temp_db_path}"
os.environ["LLM_API_KEYS"] = "test_key_1,test_key_2"
os.environ["LLM_MODEL"] = "gemini/gemini-2.0-flash"
os.environ["ENABLE_FAILURE_SIMULATION"] = "true"
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

from app.main import app
from app.database import init_db, get_connection
from app.llm import litellm
from litellm.caching.caching import Cache

client = TestClient(app)


def mock_litellm_completion(**kwargs):
    model = kwargs.get("model", "gemini/gemini-2.0-flash")
    messages = kwargs.get("messages", [])
    user_msg = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    
    response = MagicMock()
    choice = MagicMock()
    choice.message.content = f"Answer to: {user_msg}"
    response.choices = [choice]
    response.usage.prompt_tokens = 35
    response.usage.completion_tokens = 12
    return response


@pytest.fixture(autouse=True)
def setup_teardown():
    # Fresh database & reset LiteLLM cache for each test
    litellm.cache = Cache(type="local")
    init_db()
    conn = get_connection()
    with conn:
        conn.execute("DELETE FROM messages;")
    conn.close()
    yield


def test_health_endpoint():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["keys_configured"] == 2
    assert data["cache_enabled"] is True


def test_validation_errors_422():
    # Empty message
    res = client.post("/chat", json={"session_id": "s-1", "message": "   "})
    assert res.status_code == 422
    assert "detail" in res.json()

    # Missing session_id
    res = client.post("/chat", json={"message": "hello"})
    assert res.status_code == 422
    assert "detail" in res.json()

    # Message over 4000 chars
    long_msg = "x" * 4001
    res = client.post("/chat", json={"session_id": "s-1", "message": long_msg})
    assert res.status_code == 422
    assert "detail" in res.json()


@patch("litellm.acompletion", side_effect=mock_litellm_completion)
def test_live_chat_and_caching(mock_acompletion):
    # 1. First message in session-1 -> LIVE_INFERENCE
    res1 = client.post("/chat", json={"session_id": "s-1", "message": "What is the capital of France?"})
    assert res1.status_code == 200
    data1 = res1.json()
    assert data1["session_id"] == "s-1"
    assert data1["reply"] == "Answer to: What is the capital of France?"
    assert data1["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert data1["metadata"]["key_id"] == "key_1"
    assert data1["metadata"]["fallback_attempts"] == 0
    assert data1["metadata"]["input_tokens"] == 35
    assert data1["metadata"]["output_tokens"] == 12

    # 2. Same first message in a new session (session-2) -> must return LLM_CACHE
    res2 = client.post("/chat", json={"session_id": "s-2", "message": "What is the capital of France?"})
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["session_id"] == "s-2"
    assert data2["reply"] == "Answer to: What is the capital of France?"
    assert data2["metadata"]["resolution_source"] == "LLM_CACHE"
    assert data2["metadata"]["key_id"] is None
    assert data2["metadata"]["fallback_attempts"] == 0
    assert data2["metadata"]["input_tokens"] == 35
    assert data2["metadata"]["output_tokens"] == 12

    # 3. Different message in session-2 -> LIVE_INFERENCE
    res3 = client.post("/chat", json={"session_id": "s-2", "message": "Tell me a joke"})
    assert res3.status_code == 200
    data3 = res3.json()
    assert data3["metadata"]["resolution_source"] == "LIVE_INFERENCE"


@patch("litellm.acompletion", side_effect=mock_litellm_completion)
def test_session_history_and_multi_turn(mock_acompletion):
    # Send first message
    client.post("/chat", json={"session_id": "s-multi", "message": "Hello"})
    # Send second message
    client.post("/chat", json={"session_id": "s-multi", "message": "How are you?"})

    # Retrieve history
    res = client.get("/sessions/s-multi/messages")
    assert res.status_code == 200
    history = res.json()
    assert history["session_id"] == "s-multi"
    msgs = history["messages"]
    assert len(msgs) == 4
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "Hello"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"] == "Answer to: Hello"
    assert "metadata" in msgs[1]
    assert msgs[1]["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert msgs[2]["role"] == "user"
    assert msgs[2]["content"] == "How are you?"
    assert msgs[3]["role"] == "assistant"

    # 404 for unknown session
    res_404 = client.get("/sessions/nonexistent-session/messages")
    assert res_404.status_code == 404
    assert res_404.json() == {"detail": "session not found"}


@patch("litellm.acompletion", side_effect=mock_litellm_completion)
def test_failover_hook_key_1_429(mock_acompletion):
    # key_1 fails with 429 -> should failover to key_2 (200, key_id = key_2, fallback_attempts = 1)
    res = client.post(
        "/chat",
        json={"session_id": "s-failover-1", "message": "Testing failover 429"},
        headers={"X-Simulate-Failure": "key_1=429"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["metadata"]["key_id"] == "key_2"
    assert data["metadata"]["fallback_attempts"] == 1
    assert data["metadata"]["resolution_source"] == "LIVE_INFERENCE"


@patch("litellm.acompletion", side_effect=mock_litellm_completion)
def test_failover_hook_key_1_500(mock_acompletion):
    # key_1 fails with 500 -> should failover to key_2 (200, key_id = key_2, fallback_attempts = 1)
    res = client.post(
        "/chat",
        json={"session_id": "s-failover-2", "message": "Testing failover 500"},
        headers={"X-Simulate-Failure": "key_1=500"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["metadata"]["key_id"] == "key_2"
    assert data["metadata"]["fallback_attempts"] == 1


def test_failover_hook_all_keys_failed_503():
    # *=429 -> all keys fail -> 503 {"detail": "all providers unavailable"}
    res = client.post(
        "/chat",
        json={"session_id": "s-failover-all", "message": "Testing all failed"},
        headers={"X-Simulate-Failure": "*=429"},
    )
    assert res.status_code == 503
    assert res.json() == {"detail": "all providers unavailable"}

    # Must NOT be added to history
    res_check = client.get("/sessions/s-failover-all/messages")
    assert res_check.status_code == 404


def test_real_provider_exception_failover():
    # Simulate key_1 throwing a real exception during inference, key_2 succeeding
    call_count = 0

    async def side_effect(**kwargs):
        nonlocal call_count
        call_count += 1
        if kwargs.get("api_key") == "test_key_1":
            raise Exception("429 Client Error: Too Many Requests")
        
        response = MagicMock()
        choice = MagicMock()
        choice.message.content = "Success from key_2"
        response.choices = [choice]
        response.usage.prompt_tokens = 20
        response.usage.completion_tokens = 8
        return response

    with patch("litellm.acompletion", side_effect=side_effect):
        res = client.post(
            "/chat",
            json={"session_id": "s-real-error", "message": "Test failover on real error"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["metadata"]["key_id"] == "key_2"
        assert data["metadata"]["fallback_attempts"] == 1
        assert data["reply"] == "Success from key_2"


@patch("litellm.acompletion", side_effect=mock_litellm_completion)
def test_custom_system_prompt(mock_acompletion):
    res = client.post(
        "/chat",
        json={
            "session_id": "s-system",
            "message": "Who are you?",
            "system_prompt": "You are a pirate bot.",
        },
    )
    assert res.status_code == 200
    assert res.json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"
