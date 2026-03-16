"""Application configuration using Pydantic BaseSettings."""

import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # --- LLM Providers ---
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    BIOMNI_LLM: str = "gpt-4o"

    # --- vLLM (local model server) ---
    VLLM_BASE_URL: str = "http://host.docker.internal:30000/v1"
    CUSTOM_MODEL_BASE_URL: str = "http://host.docker.internal:30000/v1"
    CUSTOM_MODEL_API_KEY: str = "None"

    # --- PostgreSQL ---
    DATABASE_URL: str = "postgresql+asyncpg://aigen:aigen_pass@aigen-db:5432/aigen"

    # --- Langfuse ---
    LANGFUSE_PUBLIC_KEY: str = ""
    LANGFUSE_SECRET_KEY: str = ""
    LANGFUSE_HOST: str = "http://10.178.0.12:3000"

    # --- OpenTelemetry ---
    OTEL_EXPORTER_OTLP_ENDPOINT: str = "http://10.178.0.13:4317"
    OTEL_SERVICE_NAME: str = "aigen-backend"

    # --- Biomni ---
    BIOMNI_DATA_PATH: str = "/app/data"

    # --- File Paths ---
    UPLOADS_DIR: str = "/app/uploads"
    OUTPUTS_DIR: str = "/app/outputs"
    LOGS_DIR: str = "/app/logs"

    # --- Models Directory ---
    MODELS_DIR: str = "/app/models"
    HOST_MODELS_PATH: str = ""  # Host path for Docker volume mount

    # --- Active Model ---
    ACTIVE_MODEL: str = "ministral-reasoning"

    model_config = {"env_file": "../.env", "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def load_model_registry() -> dict:
    """Load model definitions from model_registry.yaml."""
    registry_path = Path(__file__).parent / "model_registry.yaml"
    if not registry_path.exists():
        return {"models": {}}
    with open(registry_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {"models": {}}


def get_models_dir() -> Path:
    """Return the models directory path."""
    return Path(get_settings().MODELS_DIR)
