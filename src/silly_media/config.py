from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    hf_token: str | None = None
    hf_home: str = "/root/.cache/huggingface"
    port: int = 4201
    host: str = "0.0.0.0"
    log_level: str = "INFO"

    # Default generation settings
    default_inference_steps: int = 50
    default_cfg_scale: float = 5.0
    default_width: int = 1024
    default_height: int = 1024

    # Model loading settings
    model_preload: bool = True  # Load default model on startup
    model_idle_timeout: int = 300  # Seconds before unloading idle model (0 = never)
    default_model: str = "z-image-turbo"  # Model to preload/use by default

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
