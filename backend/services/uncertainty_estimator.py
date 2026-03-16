"""Dual uncertainty estimator for refusal detection.

Supports two modes:
  - "logprob": Computes uncertainty from vLLM's top-k logprobs (entropy/variance).
  - "heteroscedastic": Queries learned log_variance_head output from vLLM plugin.

Selected by model_registry.yaml refusal.estimator setting.
"""

import logging
import math
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

logger = logging.getLogger("biomni_backend.uncertainty")


# ─── Logprob-based uncertainty functions ───

def logprob_entropy(top_logprobs: List[List[Dict[str, float]]]) -> float:
    """Compute mean per-token entropy from top-k logprobs.

    H = -sum(p * log(p)) averaged over tokens.
    Higher entropy → more uniform distribution → more uncertain.

    Args:
        top_logprobs: List of per-token dicts [{token: logprob, ...}, ...]
    """
    if not top_logprobs:
        return 0.0
    entropies = []
    for token_lps in top_logprobs:
        if not token_lps:
            continue
        h = 0.0
        for lp in token_lps.values():
            p = math.exp(lp)
            if p > 0:
                h -= p * lp
        entropies.append(h)
    return sum(entropies) / len(entropies) if entropies else 0.0


def logprob_variance(top_logprobs: List[List[Dict[str, float]]]) -> float:
    """Compute mean per-token logprob variance from top-k logprobs.

    Var = mean((logprob - mean_logprob)^2) averaged over tokens.
    Higher variance → wider probability spread → more uncertain.

    Args:
        top_logprobs: List of per-token dicts [{token: logprob, ...}, ...]
    """
    if not top_logprobs:
        return 0.0
    variances = []
    for token_lps in top_logprobs:
        if not token_lps:
            continue
        lps = list(token_lps.values())
        if len(lps) > 1:
            mean_lp = sum(lps) / len(lps)
            var = sum((x - mean_lp) ** 2 for x in lps) / len(lps)
            variances.append(var)
    return sum(variances) / len(variances) if variances else 0.0


# ─── Estimator Interface ───

class BaseEstimator(ABC):
    """Base class for uncertainty estimators."""

    @abstractmethod
    async def estimate(self, response_data: Dict[str, Any]) -> float:
        """Compute uncertainty score from model response data.

        Returns:
            Float uncertainty score. Higher = more uncertain.
        """
        ...

    def should_refuse(self, uncertainty: float, threshold: float) -> bool:
        """Check if uncertainty exceeds refusal threshold."""
        return uncertainty > threshold


class LogprobEstimator(BaseEstimator):
    """Uncertainty estimator using vLLM's top-k logprobs.

    Uses entropy as the primary metric — it captures how spread out
    the probability distribution is across top-k tokens.
    """

    async def estimate(self, response_data: Dict[str, Any]) -> float:
        top_logprobs = response_data.get("top_logprobs")
        if not top_logprobs:
            logger.debug("No logprobs available, returning 0 uncertainty")
            return 0.0
        entropy = logprob_entropy(top_logprobs)
        variance = logprob_variance(top_logprobs)
        logger.debug(f"Logprob uncertainty: entropy={entropy:.4f}, variance={variance:.4f}")
        # Use entropy as primary metric
        return entropy


class HeteroscedasticEstimator(BaseEstimator):
    """Uncertainty estimator using learned log_variance_head from vLLM plugin.

    Queries the custom /uncertainty/last endpoint added by the vLLM plugin
    to get the mean log-variance from the last forward pass.
    """

    def __init__(self, vllm_url: str = "http://localhost:30000"):
        self.vllm_url = vllm_url

    async def estimate(self, response_data: Dict[str, Any]) -> float:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.vllm_url}/uncertainty/last")
                if r.status_code == 200:
                    data = r.json()
                    mean_lv = data.get("mean_log_variance", 0.0)
                    logger.debug(f"Heteroscedastic uncertainty: mean_log_variance={mean_lv:.4f}")
                    return mean_lv
                else:
                    logger.warning(f"Uncertainty endpoint returned {r.status_code}")
                    return 0.0
        except Exception as e:
            logger.warning(f"Failed to query uncertainty endpoint: {e}")
            return 0.0


def get_estimator(refusal_cfg: Dict[str, Any]) -> Optional[BaseEstimator]:
    """Factory: create estimator based on refusal config.

    Args:
        refusal_cfg: refusal section from model_registry.yaml / resolve_model_behavior()

    Returns:
        BaseEstimator instance, or None if refusal disabled.
    """
    if not refusal_cfg or not refusal_cfg.get("enabled"):
        return None

    estimator_type = refusal_cfg.get("estimator", "logprob")

    if estimator_type == "heteroscedastic":
        vllm_url = refusal_cfg.get("vllm_url", "http://localhost:30000")
        logger.info(f"Using heteroscedastic uncertainty estimator (vLLM: {vllm_url})")
        return HeteroscedasticEstimator(vllm_url=vllm_url)
    else:
        logger.info("Using logprob-based uncertainty estimator")
        return LogprobEstimator()
