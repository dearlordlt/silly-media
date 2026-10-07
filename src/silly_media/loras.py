"""User LoRA framework shared by every model that supports `loras` in its requests.

Storage, per model family (a model declares `lora_family`):
- `z-image` (legacy): `<lora_dir>/*.safetensors`
- any other family:   `<lora_dir>/<family>/*.safetensors`

An optional sidecar `<name>.json` next to a LoRA adds metadata that `GET /loras`
returns and the backend applies:
    display_name, description, default_scale, recommended, source,
    modes (["generate", "edit"]), trigger_words (appended to the prompt
    automatically while the LoRA is active, so clients never add tags).

Files are discovered live: dropping a new LoRA (and optionally its sidecar) into
the family folder is enough, no restart or code change.
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable

import torch

from .config import settings

logger = logging.getLogger(__name__)

LEGACY_FAMILY = "z-image"  # lives directly in lora_dir


def family_dir(family: str) -> Path:
    root = Path(settings.lora_dir).resolve()
    return root if family == LEGACY_FAMILY else (root / family).resolve()


def _read_sidecar(path: Path) -> dict:
    sidecar = path.with_suffix(".json")
    if not sidecar.is_file():
        return {}
    try:
        data = json.loads(sidecar.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        logger.warning(f"Ignoring unreadable LoRA sidecar {sidecar}")
        return {}


def list_loras(family: str) -> list[dict[str, Any]]:
    """Installed LoRAs for a family: name, size_mb and any sidecar metadata."""
    directory = family_dir(family)
    if not directory.is_dir():
        return []
    loras = []
    for path in sorted(directory.glob("*.safetensors")):
        meta = _read_sidecar(path)
        loras.append(
            {
                "name": path.stem,
                "size_mb": round(path.stat().st_size / (1024 * 1024), 1),
                "display_name": meta.get("display_name", path.stem),
                "description": meta.get("description", ""),
                "default_scale": meta.get("default_scale", 1.0),
                "recommended": meta.get("recommended", ""),
                "source": meta.get("source", ""),
                "modes": meta.get("modes", ["generate", "edit"]),
                "trigger_words": meta.get("trigger_words", []),
            }
        )
    return loras


def resolve_path(family: str, name: str) -> Path:
    directory = family_dir(family)
    path = (directory / f"{name}.safetensors").resolve()
    if path.parent != directory or not path.is_file():
        available = [lora["name"] for lora in list_loras(family)]
        raise ValueError(f"LoRA '{name}' not found for {family}. Available: {available}")
    return path


def trigger_words(family: str, names: Iterable[str]) -> list[str]:
    words: list[str] = []
    for name in names:
        for word in _read_sidecar(resolve_path(family, name)).get("trigger_words", []):
            if word not in words:
                words.append(word)
    return words


def default_scale(family: str, name: str) -> float:
    return float(_read_sidecar(resolve_path(family, name)).get("default_scale", 1.0))


def adapter_name(lora_name: str) -> str:
    """peft adapter names become module-dict keys, so dots etc. must go."""
    return "user_" + re.sub(r"[^0-9A-Za-z_-]", "_", lora_name)


def load_state_dict(path: Path) -> dict[str, torch.Tensor]:
    """Load a LoRA and normalise common Civitai/ComfyUI/kohya layouts for diffusers.

    - `diffusion_model.` / `lora_unet_`-free ComfyUI keys get diffusers' `transformer.` prefix
    - kohya `.alpha` tensors are folded into lora_B (scale alpha/rank) and dropped
    - ComfyUI's fused SwiGLU `img_mlp.gate_up` (Qwen-Image 2.1) is split into the
      `gate_layer` / `proj` modules diffusers has (gate rows first, shared lora_A)
    Unsupported formats (e.g. LyCORIS LoKr) raise ValueError.
    """
    from safetensors.torch import load_file

    raw = load_file(str(path))
    if any(".lokr_" in k or ".hada_" in k for k in raw):
        raise ValueError(f"LoRA '{path.stem}' is a LyCORIS (LoKr/LoHa) file, which isn't supported")

    state: dict[str, torch.Tensor] = {}
    alphas: dict[str, torch.Tensor] = {}
    for key, value in raw.items():
        if key.startswith("diffusion_model."):
            key = "transformer." + key[len("diffusion_model."):]
        key = key.replace(".lora_down.", ".lora_A.").replace(".lora_up.", ".lora_B.")
        if key.endswith(".alpha"):
            alphas[key[: -len(".alpha")]] = value
        else:
            state[key] = value

    for module, alpha in alphas.items():
        a_key, b_key = f"{module}.lora_A.weight", f"{module}.lora_B.weight"
        if a_key in state and b_key in state:
            rank = state[a_key].shape[0]
            state[b_key] = state[b_key] * (float(alpha) / rank)

    for a_key in [k for k in state if ".img_mlp.gate_up.lora_A." in k]:
        b_key = a_key.replace(".lora_A.", ".lora_B.")
        lora_a, lora_b = state.pop(a_key), state.pop(b_key)
        gate_b, up_b = lora_b.chunk(2, dim=0)
        state[a_key.replace("gate_up", "gate_layer")] = lora_a
        state[b_key.replace("gate_up", "gate_layer")] = gate_b
        state[a_key.replace("gate_up", "proj")] = lora_a.clone()
        state[b_key.replace("gate_up", "proj")] = up_b
    return state


class LoraStackMixin:
    """Hot-swap a stack of user LoRAs (request.loras) on a diffusers pipeline.

    The active set is diffed against each request: the same combo is a no-op, a
    scale-only change only re-weights, a name change deletes just the user
    adapters and loads the new ones. Built-in adapters the model manages itself
    (e.g. Qwen-Image 2.1's turbo) are passed as `pinned` and survive swaps.
    """

    lora_family: str = ""
    _pipe: Any

    def __init__(self):
        super().__init__()
        self._active_loras: list[tuple[str, float]] = []

    def _reset_lora_state(self) -> None:
        self._active_loras = []

    def _load_user_lora(self, path: Path, adapter: str) -> None:
        self._pipe.load_lora_weights(load_state_dict(path), adapter_name=adapter)

    def _sync_loras(self, loras: Iterable[Any], pinned: dict[str, float] | None = None) -> None:
        """Make the pipe's active adapters = user loras (+ pinned built-ins)."""
        wanted = [
            (spec.name, spec.scale if spec.scale is not None else default_scale(self.lora_family, spec.name))
            for spec in loras
        ]
        wanted_names = [name for name, _ in wanted]
        active_names = [name for name, _ in self._active_loras]

        if wanted_names != active_names:
            # Resolve all paths first so a bad name fails before touching the pipe.
            paths = {name: resolve_path(self.lora_family, name) for name in wanted_names}
            if active_names:
                logger.info(f"Unloading LoRAs {active_names}")
                self._pipe.delete_adapters([adapter_name(n) for n in active_names])
                self._active_loras = []
            try:
                for name, scale in wanted:
                    logger.info(f"Loading LoRA '{name}' (scale={scale})")
                    self._load_user_lora(paths[name], adapter_name(name))
            except Exception:
                # Don't leave a half-loaded set behind; the tracker must match the pipe.
                loaded = [adapter_name(n) for n in wanted_names if adapter_name(n) in self._adapter_names()]
                if loaded:
                    self._pipe.delete_adapters(loaded)
                raise
        self._active_loras = wanted
        self._apply_adapters(pinned or {})

    def _adapter_names(self) -> set[str]:
        try:
            return {a for names in self._pipe.get_list_adapters().values() for a in names}
        except Exception:
            return set()

    def _apply_adapters(self, pinned: dict[str, float]) -> None:
        """Activate the current user loras plus `pinned`, or switch LoRA off entirely."""
        names = [adapter_name(n) for n, _ in self._active_loras] + list(pinned)
        weights = [s for _, s in self._active_loras] + list(pinned.values())
        if names:
            self._pipe.set_adapters(names, adapter_weights=weights)
            # set_adapters only selects adapters; it doesn't undo disable_lora().
            self._pipe.enable_lora()
        elif self._adapter_names():
            self._pipe.disable_lora()

    def _prompt_with_triggers(self, prompt: str) -> str:
        words = trigger_words(self.lora_family, [n for n, _ in self._active_loras])
        missing = [w for w in words if w.lower() not in prompt.lower()]
        return f"{prompt.rstrip()}, {', '.join(missing)}" if missing else prompt
