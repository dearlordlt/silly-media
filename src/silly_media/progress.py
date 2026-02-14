"""Progress tracking for generation tasks."""

import time
from dataclasses import dataclass


@dataclass
class GenerationProgress:
    """Track progress of image generation."""
    active: bool = False
    step: int = 0
    total_steps: int = 0
    started_at: float = 0.0

    def start(self, total_steps: int):
        self.active = True
        self.step = 0
        self.total_steps = total_steps
        self.started_at = time.time()

    def update(self, step: int):
        self.step = step

    def finish(self):
        self.active = False
        self.step = 0
        self.total_steps = 0

    def to_dict(self):
        if not self.active:
            return {"active": False}
        return {
            "active": True,
            "step": self.step,
            "total_steps": self.total_steps,
            "percent": round(self.step / self.total_steps * 100) if self.total_steps > 0 else 0,
            "elapsed": round(time.time() - self.started_at, 1),
        }


# Global progress trackers
progress = GenerationProgress()
img2img_progress = GenerationProgress()
music_progress = GenerationProgress()
