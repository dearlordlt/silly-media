FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.10, FFmpeg (for torchcodec/torchaudio), and other dependencies
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3.10-venv \
    python3-pip \
    git \
    ffmpeg \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pip3 install uv

# Set up HuggingFace cache directories
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface

WORKDIR /app

# Create virtual environment
RUN uv venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# Copy everything needed for install
COPY pyproject.toml ./
COPY src/ ./src/

# Install the package
RUN uv pip install -e .

# Install ace-step from GitHub with --no-deps to avoid diffusers version conflict
# (ace-step pins diffusers==0.32.2 but we use diffusers from git HEAD;
#  PyPI package is also broken - missing requirements.txt in sdist)
RUN uv pip install "ace-step @ git+https://github.com/ace-step/ACE-Step.git" --no-deps

# Expose port
EXPOSE 4201

# Run the application
CMD ["python", "-m", "silly_media.main"]
