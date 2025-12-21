"""Qwen3-VL-8B vision model implementation."""

import base64
import gc
import io
import logging

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

from .base import BaseVisionModel
from .schemas import VisionRequest

logger = logging.getLogger(__name__)


class Qwen3VLModel(BaseVisionModel):
    """Qwen3-VL-8B-Instruct vision model."""

    model_id = "Qwen/Qwen3-VL-8B-Instruct"
    display_name = "Qwen3-VL 8B"
    estimated_vram_gb = 18.0

    def __init__(self) -> None:
        super().__init__()
        self._model = None
        self._processor = None

    def load(self) -> None:
        """Load model into VRAM."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        self._model = Qwen3VLForConditionalGeneration.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            device_map="auto",
        )
        self._processor = AutoProcessor.from_pretrained(self.model_id)

        self._loaded = True
        logger.info(f"{self.display_name} loaded")

    def unload(self) -> None:
        """Unload model from VRAM."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        del self._model
        del self._processor
        self._model = None
        self._processor = None
        self._loaded = False

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        logger.info(f"{self.display_name} unloaded")

    def analyze(
        self, request: VisionRequest, image: Image.Image | None = None
    ) -> str:
        """Analyze image with text query.

        Args:
            request: Vision request with query and optional base64 image
            image: Optional PIL Image (used for multipart uploads)

        Returns:
            Text response from the model
        """
        if not self._loaded:
            raise RuntimeError("Model not loaded")

        # Build message content
        content = []

        if image is not None or request.image is not None:
            if image is None:
                # Decode base64 image from request
                image_bytes = base64.b64decode(request.image)
                image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            content.append({"type": "image", "image": image})

        content.append({"type": "text", "text": request.query})

        messages = [{"role": "user", "content": content}]

        # Process inputs
        inputs = self._processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self._model.device)

        # Build generation kwargs
        generate_kwargs = {
            "temperature": request.temperature,
            "do_sample": request.temperature > 0,
            "max_new_tokens": request.max_tokens if request.max_tokens is not None else 16384,
        }

        # Generate response
        with torch.inference_mode():
            output_ids = self._model.generate(**inputs, **generate_kwargs)

        # Trim input tokens and decode
        generated_ids = output_ids[0][inputs["input_ids"].shape[1] :]

        # Debug: log raw output
        raw_response = self._processor.decode(generated_ids, skip_special_tokens=False)
        logger.info(f"Raw response length: {len(generated_ids)} tokens")
        logger.info(f"Raw response (first 500 chars): {raw_response[:500]}")

        response = self._processor.decode(generated_ids, skip_special_tokens=True)
        logger.info(f"Clean response length: {len(response)} chars")

        return response.strip()
