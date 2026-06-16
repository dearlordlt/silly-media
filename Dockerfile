# devel image (not runtime): ships nvcc + CUDA headers so Hunyuan3D's custom
# CUDA kernels (custom_rasterizer / differentiable_renderer) compile at build.
# CUDA 13.0 to match the installed torch 2.11+cu130 (nvcc must match torch's CUDA).
FROM nvidia/cuda:13.0.1-cudnn-devel-ubuntu22.04

# Only mount compute/utility driver libs (skip display/graphics like libnvidia-gtk3)
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3.10, FFmpeg (for torchcodec/torchaudio), and other dependencies
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3.10-venv \
    python3.10-dev \
    python3-pip \
    git \
    ffmpeg \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    build-essential \
    ninja-build \
    cmake \
    libgl1 \
    libegl1 \
    libopengl0 \
    libglx0 \
    libglib2.0-0 \
    libgomp1 \
    libxrender1 \
    libxext6 \
    libxi6 \
    && rm -rf /var/lib/apt/lists/*

# CUDA build env for compiling torch extensions (4090 = sm_89)
ENV CUDA_HOME=/usr/local/cuda
ENV TORCH_CUDA_ARCH_LIST="8.9"
ENV MAX_JOBS=8

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

# Install ACE-Step 1.5 from GitHub with --no-deps (runtime deps in pyproject.toml)
# Patch Python version requirement (1.5 pins ==3.11.* but works fine with 3.10)
RUN git clone --depth 1 https://github.com/ace-step/ACE-Step-1.5.git /app/ace-step-1.5 && \
    cd /app/ace-step-1.5 && \
    sed -i 's/requires-python = "[^"]*"/requires-python = ">=3.10"/' pyproject.toml && \
    uv pip install -e . --no-deps

# Hunyuan3D-2 (hy3dgen): image->3D shape + texture. Runtime deps live in
# pyproject.toml; hy3dgen itself is used from PYTHONPATH. Compile its two CUDA
# texture kernels into the venv (needs nvcc from the devel base image).
ENV PYTHONPATH=/app/hunyuan3d:$PYTHONPATH
RUN git clone --depth 1 https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git /app/hunyuan3d && \
    cd /app/hunyuan3d/hy3dgen/texgen/custom_rasterizer && \
    python setup.py install && \
    cd /app/hunyuan3d/hy3dgen/texgen/differentiable_renderer && \
    python setup.py install

# hy3dgen's paint pipeline loads custom code via DiffusionPipeline(custom_pipeline=...);
# newer diffusers requires trust_remote_code=True for that. Patch it in.
RUN sed -i 's/custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16)/custom_pipeline=custom_pipeline_path, torch_dtype=torch.float16, trust_remote_code=True)/' \
    /app/hunyuan3d/hy3dgen/texgen/utils/multiview_utils.py

# Expose port
EXPOSE 4201

# Run the application
CMD ["python", "-m", "silly_media.main"]
