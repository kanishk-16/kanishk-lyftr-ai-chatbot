import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(REPO_ROOT / ".env"), str(BACKEND_DIR / ".env"), ".env"),
        extra="allow",
    )

    LLM_API_KEYS: str = Field(default="key_1,key_2")
    LLM_MODEL: str = Field(default="gemini/gemini-flash-lite-latest")
    DATABASE_URL: str = Field(default="sqlite:///./data/app.db")
    ALLOWED_ORIGINS: str = Field(default="*")
    ENABLE_FAILURE_SIMULATION: bool = Field(default=True)
    DEFAULT_SYSTEM_PROMPT: str = Field(
        default="You are a helpful, concise, and accurate AI assistant."
    )

    @property
    def api_keys_list(self) -> list[str]:
        keys = [k.strip() for k in self.LLM_API_KEYS.split(",") if k.strip()]
        return keys

    @property
    def db_path(self) -> str:
        url = self.DATABASE_URL
        if url.startswith("sqlite:////"):
            return "/" + url.removeprefix("sqlite:////")
        elif url.startswith("sqlite:///"):
            return url.removeprefix("sqlite:///")
        return url


settings = Settings()
