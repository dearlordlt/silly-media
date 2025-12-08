"""Audio generation models module."""

from .base import BaseAudioModel
from .xtts import XTTSv2Model

__all__ = ["BaseAudioModel", "XTTSv2Model"]
