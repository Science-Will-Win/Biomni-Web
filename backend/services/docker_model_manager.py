"""Dynamic vLLM container management via Docker API.

Swaps the vLLM model by stopping/recreating the container with
a new --model and --served-model-name.
"""

import asyncio
import logging
from functools import lru_cache

import httpx

logger = logging.getLogger(__name__)

VLLM_CONTAINER = "vllm-server"
VLLM_IMAGE = "vllm/vllm-openai:latest"
VLLM_INTERNAL_PORT = 8000
VLLM_HOST_PORT = 30000
MAX_MODEL_LEN = 65536


class DockerModelManager:
    def __init__(self):
        import docker
        self._client = docker.from_env()
        self._current_model: str | None = None
        # Detect currently running model
        self._sync_current_model()

    def _sync_current_model(self):
        """Read currently running container to set _current_model."""
        try:
            c = self._client.containers.get(VLLM_CONTAINER)
            if c.status == "running":
                # Parse --served-model-name from command
                cmd = c.attrs.get("Config", {}).get("Cmd", [])
                cmd_str = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
                if "--served-model-name" in cmd_str:
                    idx = cmd_str.index("--served-model-name")
                    parts = cmd_str[idx:].split()
                    if len(parts) >= 2:
                        self._current_model = parts[1]
                        logger.info(f"Detected running vLLM model: {self._current_model}")
        except Exception:
            pass

    async def swap_model(
        self,
        registry_name: str,
        local_path: str,
        max_model_len: int = MAX_MODEL_LEN,
        force: bool = False,
    ) -> None:
        """Stop current vLLM container and start a new one with the given model."""
        if self._current_model == registry_name and not force:
            logger.info(f"Model {registry_name} already loaded, skipping swap")
            return

        logger.info(f"Swapping vLLM model: {self._current_model} → {registry_name}")
        loop = asyncio.get_event_loop()

        # 1) Stop + remove existing container
        await loop.run_in_executor(None, self._stop_container)

        # 2) Start new container
        await loop.run_in_executor(
            None, self._start_container, registry_name, local_path, max_model_len
        )

        # 3) Wait for health check
        await self._wait_healthy()

        self._current_model = registry_name
        logger.info(f"vLLM model swapped to: {registry_name} ({local_path})")

    def _stop_container(self):
        import docker
        try:
            c = self._client.containers.get(VLLM_CONTAINER)
            logger.info(f"Stopping vLLM container...")
            c.stop(timeout=15)
            c.remove()
            logger.info("vLLM container stopped and removed")
        except docker.errors.NotFound:
            logger.info("No existing vLLM container found")

    def _start_container(self, name: str, local_path: str, max_model_len: int):
        from config import get_settings

        settings = get_settings()
        host_models_path = settings.HOST_MODELS_PATH
        if not host_models_path:
            raise ValueError(
                "HOST_MODELS_PATH not set in .env — required for Docker model management"
            )

        logger.info(f"Starting vLLM container with model: {local_path}")
        self._client.containers.run(
            VLLM_IMAGE,
            command=(
                f"--model /app/models/{local_path} "
                f"--served-model-name {name} "
                f"--port {VLLM_INTERNAL_PORT} "
                f"--host 0.0.0.0 "
                f"--max-model-len {max_model_len}"
            ),
            name=VLLM_CONTAINER,
            runtime="nvidia",
            ports={f"{VLLM_INTERNAL_PORT}/tcp": VLLM_HOST_PORT},
            volumes={host_models_path: {"bind": "/app/models", "mode": "rw"}},
            environment={"NVIDIA_VISIBLE_DEVICES": "all"},
            detach=True,
        )

    async def _wait_healthy(self, timeout: int = 180):
        """Poll vLLM /v1/models until it responds 200."""
        url = f"http://host.docker.internal:{VLLM_HOST_PORT}/v1/models"
        logger.info(f"Waiting for vLLM health check at {url} (timeout={timeout}s)")
        async with httpx.AsyncClient() as client:
            for i in range(timeout):
                try:
                    r = await client.get(url, timeout=3)
                    if r.status_code == 200:
                        logger.info(f"vLLM healthy after {i+1}s")
                        return
                except Exception:
                    pass
                await asyncio.sleep(1)
        raise TimeoutError(f"vLLM failed to start within {timeout}s")

    @property
    def current_model(self) -> str | None:
        return self._current_model


_manager: DockerModelManager | None = None


def get_docker_manager() -> DockerModelManager:
    global _manager
    if _manager is None:
        _manager = DockerModelManager()
    return _manager
