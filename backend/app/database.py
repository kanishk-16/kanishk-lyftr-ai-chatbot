import sqlite3
import json
import os
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from app.config import settings


def get_connection():
    db_path = settings.db_path
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);")
    finally:
        conn.close()


def save_message(
    session_id: str,
    role: str,
    content: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> int:
    conn = get_connection()
    try:
        created_at = datetime.now(timezone.utc).isoformat()
        metadata_str = json.dumps(metadata) if metadata is not None else None
        with conn:
            cursor = conn.execute(
                "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
                (session_id, role, content, metadata_str, created_at),
            )
            return cursor.lastrowid
    finally:
        conn.close()


def session_exists(session_id: str) -> bool:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1", (session_id,))
        return cursor.fetchone() is not None
    except sqlite3.OperationalError:
        init_db()
        return False
    finally:
        conn.close()


def get_session_messages(session_id: str) -> List[Dict[str, Any]]:
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, session_id, role, content, metadata, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )
        rows = cursor.fetchall()
        result = []
        for r in rows:
            meta = None
            if r["metadata"]:
                try:
                    raw_meta = json.loads(r["metadata"])
                    meta = {
                        "resolution_source": raw_meta.get("resolution_source"),
                        "input_tokens": raw_meta.get("input_tokens"),
                        "output_tokens": raw_meta.get("output_tokens"),
                    }
                except Exception:
                    meta = None

            msg = {"role": r["role"], "content": r["content"]}
            if r["role"] == "assistant" and meta is not None:
                msg["metadata"] = meta
            result.append(msg)
        return result
    except sqlite3.OperationalError:
        init_db()
        return []
    finally:
        conn.close()


# Ensure DB is initialized on module load
try:
    init_db()
except Exception:
    pass

