"""Huihui-Qwen3-4B-abliterated-v2 LLM implementation."""

import gc
import logging
import threading
import time
from typing import Generator

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from .base import BaseLLMModel
from .schemas import LLMRequest, LLMResponse

logger = logging.getLogger(__name__)


class HuihuiQwen3Model(BaseLLMModel):
    """Huihui-Qwen3-4B-abliterated-v2 text generation model."""

    model_id = "huihui-ai/Huihui-Qwen3-4B-abliterated-v2"
    display_name = "Huihui Qwen3 4B"
    estimated_vram_gb = 10.0

    def __init__(self) -> None:
        super().__init__()
        self._model = None
        self._tokenizer = None
        self._device = "cuda" if torch.cuda.is_available() else "cpu"

    def load(self) -> None:
        """Load model into VRAM."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        self._tokenizer = AutoTokenizer.from_pretrained(self.model_id)
        self._model = AutoModelForCausalLM.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            attn_implementation="eager",  # Avoid potential flash attention dtype issues
        )
        self._model.eval()
        self._dtype = torch.bfloat16

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        """Unload model from VRAM."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        del self._model
        del self._tokenizer
        self._model = None
        self._tokenizer = None
        self._loaded = False

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        logger.info(f"{self.display_name} unloaded")

    def _build_prompt(self, request: LLMRequest) -> str:
        """Build prompt string from request."""
        if request.messages:
            # Use chat template with messages
            messages = [
                {"role": m.role.value, "content": m.content} for m in request.messages
            ]
            return self._tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=request.enable_thinking,
            )
        elif request.prompt:
            # Raw prompt with optional system
            if request.system_prompt:
                messages = [
                    {"role": "system", "content": request.system_prompt},
                    {"role": "user", "content": request.prompt},
                ]
                return self._tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=request.enable_thinking,
                )
            # Just the raw prompt without template
            return request.prompt
        else:
            raise ValueError("Either 'messages' or 'prompt' must be provided")

    def _get_generation_kwargs(self, request: LLMRequest) -> dict:
        """Build generation kwargs from request."""
        gen_kwargs = {
            "max_new_tokens": request.max_tokens,
            "temperature": request.temperature if request.temperature > 0 else None,
            "top_p": request.top_p,
            "top_k": request.top_k,
            "repetition_penalty": request.repetition_penalty,
            "do_sample": request.temperature > 0,
            "pad_token_id": self._tokenizer.pad_token_id
            or self._tokenizer.eos_token_id,
        }

        if request.min_p is not None:
            gen_kwargs["min_p"] = request.min_p

        # Remove None values
        gen_kwargs = {k: v for k, v in gen_kwargs.items() if v is not None}

        return gen_kwargs

    def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate text completion (non-streaming)."""
        if not self._loaded:
            raise RuntimeError("Model not loaded")

        start_time = time.time()

        # Build prompt and tokenize
        prompt = self._build_prompt(request)
        inputs = self._tokenizer(
            prompt,
            return_tensors="pt",
            add_special_tokens=False,
        ).to(self._device)

        # Ensure input_ids are on correct device (attention_mask may have been float)
        inputs = {k: v.to(self._device) for k, v in inputs.items()}

        input_length = inputs["input_ids"].shape[1]

        # Set seed if provided
        actual_seed = None
        if request.seed is not None and request.seed >= 0:
            actual_seed = request.seed
            torch.manual_seed(actual_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(actual_seed)

        # Build generation kwargs
        gen_kwargs = self._get_generation_kwargs(request)

        # Generate
        with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.bfloat16):
            outputs = self._model.generate(**inputs, **gen_kwargs)

        # Decode (skip input tokens)
        generated_ids = outputs[0][input_length:]
        output_text = self._tokenizer.decode(
            generated_ids,
            skip_special_tokens=True,
        )

        elapsed = time.time() - start_time

        return LLMResponse(
            text=output_text.strip(),
            model=self.display_name,
            input_tokens=input_length,
            output_tokens=len(generated_ids),
            generation_time_seconds=round(elapsed, 2),
            seed=actual_seed,
        )

    def generate_stream(self, request: LLMRequest) -> Generator[str, None, None]:
        """Generate text completion with streaming."""
        if not self._loaded:
            raise RuntimeError("Model not loaded")

        # Build prompt and tokenize
        prompt = self._build_prompt(request)
        inputs = self._tokenizer(
            prompt,
            return_tensors="pt",
            add_special_tokens=False,
        ).to(self._device)

        # Set seed if provided
        if request.seed is not None and request.seed >= 0:
            torch.manual_seed(request.seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(request.seed)

        # Create streamer
        streamer = TextIteratorStreamer(
            self._tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )

        # Build generation kwargs
        gen_kwargs = self._get_generation_kwargs(request)
        gen_kwargs["streamer"] = streamer

        # Run generation in background thread
        def generate_in_thread():
            with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.bfloat16):
                self._model.generate(**inputs, **gen_kwargs)

        thread = threading.Thread(target=generate_in_thread)
        thread.start()

        # Yield tokens as they arrive
        for text in streamer:
            if text:  # Skip empty strings
                yield text

        thread.join()
