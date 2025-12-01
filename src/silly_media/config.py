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

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
