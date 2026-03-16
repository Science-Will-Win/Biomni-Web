"""AigenR0ForConditionalGeneration — vLLM plugin model class.

Inherits from vLLM's Mistral3ForConditionalGeneration.
Model weights are pre-converted to Mistral3 format by convert_aigen_to_mistral3.py.

Additions:
  - log_variance_head: learned uncertainty estimation (used for refusal detection)
  - compute_logits override: captures last hidden state → log_variance_head → shared memory
  - UncertaintyMiddleware reads the stored value via /uncertainty/last endpoint

Note: vLLM V1 runs EngineCore in a separate process. We use shared_memory
to communicate the uncertainty value from EngineCore → API server (middleware).
"""

import struct

import torch
import torch.nn as nn

from multiprocessing import shared_memory

from vllm.config import VllmConfig
from vllm.model_executor.models.mistral3 import Mistral3ForConditionalGeneration


SHARED_MEM_NAME = "aigen_uncertainty"
SHARED_MEM_SIZE = 8  # 1 double = 8 bytes


def _get_or_create_shm(create: bool = False) -> shared_memory.SharedMemory | None:
    """Get existing or create new shared memory block."""
    try:
        return shared_memory.SharedMemory(name=SHARED_MEM_NAME, create=False)
    except FileNotFoundError:
        if create:
            shm = shared_memory.SharedMemory(
                name=SHARED_MEM_NAME, create=True, size=SHARED_MEM_SIZE
            )
            struct.pack_into("d", shm.buf, 0, 0.0)  # Initialize to 0.0
            return shm
        return None


def set_uncertainty(value: float) -> None:
    """Write uncertainty value to shared memory (called from EngineCore process)."""
    shm = _get_or_create_shm(create=True)
    if shm:
        struct.pack_into("d", shm.buf, 0, value)
        shm.close()


def get_last_uncertainty() -> dict:
    """Read uncertainty value from shared memory (called from API server process)."""
    shm = _get_or_create_shm(create=False)
    if shm:
        value = struct.unpack_from("d", shm.buf, 0)[0]
        shm.close()
        return {"mean_log_variance": value}
    return {"mean_log_variance": 0.0}


class AigenR0ForConditionalGeneration(Mistral3ForConditionalGeneration):
    """Aigen-R0-3B: Mistral3 + learned uncertainty estimation head.

    The model weights are pre-converted to match the official Mistral3
    key naming convention (language_model.model.*, vision_tower.transformer.*).

    compute_logits() is overridden to run log_variance_head on the last
    hidden state before delegating to the standard LM head.
    """

    def __init__(self, *, vllm_config: VllmConfig, prefix: str = ""):
        super().__init__(vllm_config=vllm_config, prefix=prefix)
        config = vllm_config.model_config.hf_config
        text_hidden = getattr(config, "hidden_size", None)
        if text_hidden is None:
            text_hidden = config.text_config.hidden_size
        self.log_variance_head = nn.Linear(text_hidden, 1, bias=True)

    def compute_logits(self, hidden_states: torch.Tensor) -> torch.Tensor | None:
        """Compute LM logits and capture uncertainty from log_variance_head.

        The log_variance_head runs on the last token's hidden state to produce
        a scalar log-variance. This is written to shared memory for the
        /uncertainty/last endpoint (served by UncertaintyMiddleware in the
        API server process).
        """
        # Run log_variance_head on last token (no gradient needed for inference)
        with torch.no_grad():
            # hidden_states shape: [num_tokens, hidden_size] (vLLM flattened batch)
            last_hs = hidden_states[-1:]  # [1, hidden_size]
            log_var = self.log_variance_head(last_hs).mean().item()
            set_uncertainty(log_var)

        # Delegate to standard LM head for text generation
        return self.language_model.compute_logits(hidden_states)
