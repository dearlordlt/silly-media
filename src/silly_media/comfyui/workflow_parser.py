"""Parse ComfyUI workflow JSON into GenerateRequest parameters."""

from __future__ import annotations

import logging

from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)


def _find_nodes_by_type(workflow: dict, class_type: str) -> list[tuple[str, dict]]:
    """Find all nodes of a given class_type. Returns [(node_id, node_dict), ...]."""
    return [
        (node_id, node)
        for node_id, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") == class_type
    ]


def _resolve_ref(workflow: dict, ref) -> dict | None:
    """Resolve a node reference like ["4", 0] to the actual node dict."""
    if isinstance(ref, list) and len(ref) >= 2:
        node_id = str(ref[0])
        return workflow.get(node_id)
    return None


def _get_input(node: dict, key: str, default=None):
    """Get an input value from a node, returning default if missing."""
    return node.get("inputs", {}).get(key, default)


def _follow_text_input(workflow: dict, node: dict, input_name: str) -> str:
    """Follow a node input to find a CLIPTextEncode text value."""
    ref = _get_input(node, input_name)
    if ref is None:
        return ""

    # Direct string value (some workflows inline the text)
    if isinstance(ref, str):
        return ref

    # Node reference - follow it
    target = _resolve_ref(workflow, ref)
    if target is None:
        return ""

    class_type = target.get("class_type", "")

    # CLIPTextEncode - grab the text
    if class_type == "CLIPTextEncode":
        text = _get_input(target, "text", "")
        return text if isinstance(text, str) else ""

    # CLIPTextEncodeSDXL or other variants
    if "CLIPTextEncode" in class_type:
        for key in ("text", "text_g", "text_l"):
            text = _get_input(target, key, "")
            if isinstance(text, str) and text:
                return text

    # ConditioningCombine or similar - try to follow recursively
    for key in ("conditioning_1", "conditioning", "positive"):
        sub_ref = _get_input(target, key)
        if sub_ref is not None:
            sub_node = _resolve_ref(workflow, sub_ref)
            if sub_node and "CLIPTextEncode" in sub_node.get("class_type", ""):
                text = _get_input(sub_node, "text", "")
                if isinstance(text, str) and text:
                    return text

    return ""


def _find_latent_dimensions(workflow: dict, ksampler: dict) -> tuple[int, int]:
    """Follow KSampler's latent_image input to find EmptyLatentImage dimensions."""
    ref = _get_input(ksampler, "latent_image")
    target = _resolve_ref(workflow, ref) if ref else None

    if target and target.get("class_type") == "EmptyLatentImage":
        w = _get_input(target, "width", 1024)
        h = _get_input(target, "height", 1024)
        return int(w), int(h)

    # Try finding any EmptyLatentImage in the workflow
    latent_nodes = _find_nodes_by_type(workflow, "EmptyLatentImage")
    if latent_nodes:
        node = latent_nodes[0][1]
        w = _get_input(node, "width", 1024)
        h = _get_input(node, "height", 1024)
        return int(w), int(h)

    return 1024, 1024


def _find_save_node_id(workflow: dict) -> str:
    """Find the SaveImage (or PreviewImage) node ID for output mapping."""
    for class_type in ("SaveImage", "PreviewImage"):
        nodes = _find_nodes_by_type(workflow, class_type)
        if nodes:
            return nodes[0][0]
    # Fallback: return a fake node ID
    return "output"


def parse_workflow(workflow: dict) -> tuple[GenerateRequest, str]:
    """Parse a ComfyUI workflow dict into a GenerateRequest.

    Returns (GenerateRequest, save_node_id) where save_node_id is the
    output node ID to use in the history response.
    """
    # Find KSampler (or KSamplerAdvanced)
    ksamplers = _find_nodes_by_type(workflow, "KSampler")
    if not ksamplers:
        ksamplers = _find_nodes_by_type(workflow, "KSamplerAdvanced")
    if not ksamplers:
        # Last resort: find anything with "sampler" in the class name
        ksamplers = [
            (nid, n)
            for nid, n in workflow.items()
            if isinstance(n, dict) and "sampler" in n.get("class_type", "").lower()
        ]

    if ksamplers:
        ksampler = ksamplers[0][1]
        steps = int(_get_input(ksampler, "steps", 9))
        cfg = float(_get_input(ksampler, "cfg", 0.0))
        seed = _get_input(ksampler, "seed")
        if isinstance(seed, (int, float)):
            seed = int(seed)
        else:
            seed = None

        positive_text = _follow_text_input(workflow, ksampler, "positive")
        negative_text = _follow_text_input(workflow, ksampler, "negative")
        width, height = _find_latent_dimensions(workflow, ksampler)
    else:
        # No sampler found - look for prompts anywhere
        logger.warning("No KSampler found in workflow, using defaults")
        clip_nodes = _find_nodes_by_type(workflow, "CLIPTextEncode")
        positive_text = ""
        negative_text = ""
        for _, node in clip_nodes:
            text = _get_input(node, "text", "")
            if isinstance(text, str) and text and not positive_text:
                positive_text = text
        steps = 9
        cfg = 0.0
        seed = None
        width, height = 1024, 1024

    if not positive_text:
        positive_text = "a beautiful image"
        logger.warning("No positive prompt found in workflow, using default")

    save_node_id = _find_save_node_id(workflow)

    request = GenerateRequest(
        prompt=positive_text,
        negative_prompt=negative_text,
        num_inference_steps=steps,
        cfg_scale=cfg,
        seed=seed if seed and seed >= 0 else None,
        width=width,
        height=height,
    )

    return request, save_node_id
