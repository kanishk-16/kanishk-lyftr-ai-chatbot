# Lyftr AI - LLM Chatbot with Key Failover and Response Caching

A production-grade, resilient full-stack AI chatbot built with **React (TypeScript)**, **FastAPI**, **LiteLLM Gateway**, and **SQLite**. Designed for high reliability under key rate-limits (HTTP 429), quota exhaustion, and upstream server errors (HTTP 5xx), featuring automatic response caching and strict per-request token usage tracking.

---

## 1. Live URLs

- **Frontend Application**: [https://kanishk-lyftr-ai-chatbot.vercel.app](https://kanishk-lyftr-ai-chatbot.vercel.app)
- **Backend API Base**: [https://kanishk-lyftr-ai-chatbot.onrender.com](https://kanishk-lyftr-ai-chatbot.onrender.com)
- **API Health Endpoint**: [https://kanishk-lyftr-ai-chatbot.onrender.com/health](https://kanishk-lyftr-ai-chatbot.onrender.com/health)
- **Public GitHub Repository**: [https://github.com/kanishk-16/kanishk-lyftr-ai-chatbot](https://github.com/kanishk-16/kanishk-lyftr-ai-chatbot)
- **Demo Video (2–3 mins)**: `https://<YOUR-VIDEO-LINK>` (Loom / YouTube / Drive)

---

## 2. Run locally: with Docker and without

### Option A: With Docker (Recommended)

Make sure Docker and Docker Compose are installed and running.

1. **Clone the repository**:
   ```bash
   git clone <REPO_URL>
   cd Lyftr-AI-assignment
   ```

2. **Configure Environment Variables**:
   Copy the sample environment file:
   ```bash
   cp .env.example .env
   ```
   Add your valid LLM API keys in `.env` (e.g., Gemini or OpenAI keys):
   ```env
   LLM_API_KEYS=key_1_secret,key_2_secret
   LLM_MODEL=gemini/gemini-2.0-flash
   ENABLE_FAILURE_SIMULATION=true
   ```

3. **Start the Stack**:
   ```bash
   make up
   ```
   * Or without `make`:
   ```bash
   docker compose up -d --build
   ```

4. **Access the Applications**:
   - **Frontend UI**: [http://localhost:3000](http://localhost:3000)
   - **Backend API & Swagger Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
   - **Health Check**: [http://localhost:8000/health](http://localhost:8000/health)

5. **Stop the Stack**:
   ```bash
   make down
   ```

---

### Option B: Without Docker

#### Prerequisites
- Python 3.10+
- Node.js 18+ and npm

#### 1. Backend Setup
```bash
cd backend
python -m venv .venv

# On Linux/macOS:
source .venv/bin/activate
# On Windows:
.\.venv\Scripts\activate

pip install -r requirements.txt

# Start backend server on port 8000
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
# The frontend starts on http://localhost:3000 (configured in vite.config.ts)
```

#### 3. Run Backend Automated Test Suite
```bash
cd backend
pytest -v tests/
```

---

## 3. Design decisions: key fallback, caching, SQLite session storage

### Key Fallback Architecture
- **Ordered Key Pool**: Configured keys in `LLM_API_KEYS` are parsed and assigned immutable, masked identifiers (`key_1`, `key_2`, ...). The raw API keys are never exposed in responses or logs.
- **Failover Logic**: When an inference attempt fails due to HTTP 429 (Rate Limit / Quota Exceeded), network timeouts, or HTTP 5xx errors from the provider, the gateway intercepts the error, increments `fallback_attempts`, and transparently routes the request to the next available key in the pool.
- **Clean 503 Degradation**: If and only if all configured keys fail, the gateway responds with HTTP 503 and JSON `{"detail": "all providers unavailable"}`. Failed requests are never saved to session history.

### Response Caching Strategy
- **Built-in LiteLLM Cache**: Enabled via LiteLLM's local memory cache.
- **Deterministic Cache Key**: The cache key is derived from `model + full_message_history` (including system prompt, prior turns, and the new message).
- **Session-Independent Identical Hits**: If two distinct sessions send the exact same initial query with the same system prompt, the second request returns `LLM_CACHE` with sub-10ms response time and identical token counts, with `key_id: null` and `fallback_attempts: 0`.
- **Multi-Turn Isolation**: Follow-up questions naturally modify the message history array, ensuring cache keys remain distinct and preventing stale conversational responses.

### SQLite Session Storage
- **Zero-Dependency Persistence**: Session state is stored in SQLite without external database dependencies (e.g., Redis or PostgreSQL).
- **Persistent Docker Volume**: Mounted to `/data/app.db` via `DATABASE_URL=sqlite:////data/app.db`, preserving message history across container restarts.
- **Schema Auto-Migration**: The `messages` table and performance index on `(session_id, id)` are verified and created on startup:
  ```sql
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  ```

---

## 4. Verification: how to see failover, cache hits and per-message token usage

### 1. Verify Response Caching
1. Open the UI at [http://localhost:3000](http://localhost:3000).
2. Click the quick prompt: `"What is the capital of France?"`.
3. Observe the response:
   - Source tag: `LIVE_INFERENCE`
   - Key: `key_1`
   - Latency: ~800–1200 ms
4. Click **New Session** (icon next to session ID), and send the exact same question: `"What is the capital of France?"`.
5. Observe the response:
   - Source tag: `LLM_CACHE`
   - Key: `null`
   - Latency: < 20 ms
   - Input and Output Tokens: Identical to the initial live request.

### 2. Verify Key Failover via `X-Simulate-Failure`
Use the **Failover Hook** dropdown in the UI or cURL:

- **Simulate Key 1 Rate-Limited (429)**:
  ```bash
  curl -X POST http://localhost:8000/chat \
    -H "Content-Type: application/json" \
    -H "X-Simulate-Failure: key_1=429" \
    -d '{"session_id": "s-test-failover", "message": "Hello from failover test"}'
  ```
  **Result**: HTTP 200, `"key_id": "key_2"`, `"fallback_attempts": 1`.

- **Simulate Key 1 Internal Error (500)**:
  ```bash
  curl -X POST http://localhost:8000/chat \
    -H "Content-Type: application/json" \
    -H "X-Simulate-Failure: key_1=500" \
    -d '{"session_id": "s-test-failover", "message": "Hello from 500 test"}'
  ```
  **Result**: HTTP 200, `"key_id": "key_2"`, `"fallback_attempts": 1`.

- **Simulate All Keys Exhausted (`*=429`)**:
  ```bash
  curl -X POST http://localhost:8000/chat \
    -H "Content-Type: application/json" \
    -H "X-Simulate-Failure: *=429" \
    -d '{"session_id": "s-test-all-failed", "message": "Should fail"}'
  ```
  **Result**: HTTP 503 `{"detail": "all providers unavailable"}`. History check (`GET /sessions/s-test-all-failed/messages`) returns 404 because failed requests are never recorded.

### 3. Verify Per-Message Token Usage
- Each assistant message container displays:
  - `meta-input-tokens`: Prompt tokens for that turn (system prompt + active history + new message).
  - `meta-output-tokens`: Completion tokens generated for that specific reply.

---

## 5. Setup Used: your editor and AI tools

- **Development Environment**: Visual Studio Code / Cursor on Windows 11
- **Runtimes & Frameworks**:
  - Python 3.13 / Python 3.11-slim (Docker)
  - Node.js 22 / Node 20-alpine (Docker)
  - FastAPI, LiteLLM, Pydantic v2, Pytest
  - React 19, TypeScript, Vite, Lucide Icons, Nginx Alpine
- **AI Tooling**: Antigravity AI agent for rapid scaffolding, automated test generation, contract validation, and multi-stage container optimization.

---

## 6. Bonus features (if any): what you added beyond the requirements and why

1. **Interactive In-UI Failover Simulation**: A dedicated dropdown toolbar allows testers and reviewers to inject `X-Simulate-Failure` headers without requiring Postman or cURL commands.
2. **Real-time Gateway Health Monitor**: Top-bar pill badge continuously verifies connection to `GET /health`, indicating key pool size and active cache status.
3. **One-Click Session Reset**: Instantly resets client session state with a fresh session identifier to easily test cache replication across independent sessions.
4. **Custom System Prompt Override**: Drawer input (`system-prompt-input`) allowing dynamic persona customisation per session.
5. **Multi-Stage Container Optimization**:
   - Backend: Builder pattern discarding build tools, yielding a lean Python image.
   - Frontend: Node build artifacts served through an alpine Nginx server (< 25MB).
6. **Automated Backend Pytest Suite**: Full test suite covering health check, validation errors (422), live inference, caching accuracy, multi-turn state, simulated failure hooks, and real provider exception fallbacks.
