"""Tool, Library, and Data Lake catalog endpoints."""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter

logger = logging.getLogger("aigen.tools_router")

router = APIRouter(prefix="/api", tags=["tools"])


# ── Cached responses (computed once on first request) ──

_tools_cache: Dict[str, List[Dict[str, Any]]] | None = None
_libraries_cache: List[Dict[str, str]] | None = None
_data_lake_cache: List[Dict[str, str]] | None = None


@router.get("/tools")
async def list_tools() -> Dict[str, List[Dict[str, Any]]]:
    """Return all Biomni tool definitions grouped by module."""
    global _tools_cache
    if _tools_cache is not None:
        return _tools_cache

    try:
        from services.biomni_tools import BiomniToolLoader
        loader = BiomniToolLoader.get_instance()
        if not loader.is_initialized():
            loader.initialize()
        _tools_cache = loader.get_module2api()
        logger.info(f"Tools cache built: {sum(len(v) for v in _tools_cache.values())} tools")
        return _tools_cache
    except Exception as e:
        logger.warning(f"Failed to load tools: {e}")
        return {}


@router.get("/libraries")
async def list_libraries() -> List[Dict[str, str]]:
    """Return available software libraries from Biomni env_desc."""
    global _libraries_cache
    if _libraries_cache is not None:
        return _libraries_cache

    try:
        from biomni.env_desc import library_content_dict
        _libraries_cache = [
            {"name": name, "description": desc}
            for name, desc in library_content_dict.items()
        ]
        logger.info(f"Libraries cache built: {len(_libraries_cache)} libraries")
        return _libraries_cache
    except Exception as e:
        logger.warning(f"Failed to load libraries: {e}")
        return []


@router.get("/data-lake")
async def list_data_lake() -> List[Dict[str, str]]:
    """Return available data lake datasets."""
    global _data_lake_cache
    if _data_lake_cache is not None:
        return _data_lake_cache

    try:
        from biomni.env_desc import data_lake_dict
        _data_lake_cache = [
            {"name": name, "description": desc}
            for name, desc in data_lake_dict.items()
        ]
        logger.info(f"Data lake cache built: {len(_data_lake_cache)} datasets")
        return _data_lake_cache
    except Exception as e:
        logger.warning(f"Failed to load data lake: {e}")
        return []
