"""Helpers for inspecting the local Hugging Face cache."""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def repo_cached(repo_id: str) -> bool:
    """True if `repo_id` has a usable snapshot in the local HF cache.

    Used to keep models out of the registry when their weights aren't on disk, so
    the API doesn't advertise something that would kick off a multi-GB download on
    first request. Re-download the repo and the model registers itself again on the
    next restart.
    """
    from huggingface_hub.constants import HF_HUB_CACHE

    repo_dir = Path(HF_HUB_CACHE) / f"models--{repo_id.replace('/', '--')}"
    ref = repo_dir / "refs" / "main"
    if not ref.is_file():
        return False

    try:
        snapshot = repo_dir / "snapshots" / ref.read_text().strip()
        return snapshot.is_dir() and any(snapshot.iterdir())
    except OSError:
        logger.warning(f"Could not read HF cache entry for {repo_id}", exc_info=True)
        return False
