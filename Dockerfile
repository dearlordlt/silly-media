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

# Set up HuggingFace cache directories. TRANSFORMERS_CACHE is deprecated but still
# honoured by some loaders, and it means the dir that *contains* the models--* trees —
# i.e. the same thing as HF_HUB_CACHE ($HF_HOME/hub). Pointing it one level up at
# HF_HOME made those loaders write a second copy at the top level, splitting models
# across two layouts and duplicating ~17GB. Keep the two in agreement.
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface/hub

WORKDIR /app

# Create virtual environment
RUN uv venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# Copy everything needed for install
COPY pyproject.toml ./
COPY src/ ./src/

# Install the package
RUN uv pip install -e .

# coqui-tts (<=0.27.5) imports transformers' private isin_mps_friendly, removed in
# transformers 5. torch.isin is the drop-in replacement (their own TODO says so).
RUN sed -i 's/from transformers.pytorch_utils import isin_mps_friendly as isin/from torch import isin/' \
    /app/.venv/lib/python3.10/site-packages/TTS/tts/layers/tortoise/autoregressive.py && \
    grep -n 'from torch import isin' /app/.venv/lib/python3.10/site-packages/TTS/tts/layers/tortoise/autoregressive.py

# transformers >=5.17 generate() no longer hands XTTS's GPT inference model an
# attention_mask on decode steps; it only used the mask's length (= cached tokens + 1)
# to place the position embedding, so derive that from the KV cache instead.
RUN sed -i 's/attention_mask.shape\[1\] - (prefix_len + 1), attention_mask.device/(attention_mask.shape[1] if attention_mask is not None else past_key_values.get_seq_length() + 1) - (prefix_len + 1), emb.device/' \
    /app/.venv/lib/python3.10/site-packages/TTS/tts/layers/xtts/gpt_inference.py && \
    grep -n 'past_key_values.get_seq_length() + 1' /app/.venv/lib/python3.10/site-packages/TTS/tts/layers/xtts/gpt_inference.py

# Install ACE-Step 1.5 from GitHub with --no-deps (runtime deps in pyproject.toml)
# Patch Python version requirement (1.5 pins ==3.11.* but works fine with 3.10)
RUN git clone --depth 1 https://github.com/ace-step/ACE-Step-1.5.git /app/ace-step-1.5 && \
    cd /app/ace-step-1.5 && \
    sed -i 's/requires-python = "[^"]*"/requires-python = ">=3.10"/' pyproject.toml && \
    uv pip install -e . --no-deps

# transformers 5.x + ACE-Step: device_map="cpu" makes the load materialize on CPU
# before the handler's .to(device). Not sufficient on its own — transformers 5
# still builds the skeleton on the meta device, which the remote-code audio
# tokenizer can't survive; the real fix is the _materialized_model_init() wrapper
# in src/silly_media/music/ace_step.py. This sed is the tested companion config.
# The grep fails the build loudly if upstream refactors the call and the sed no-ops.
RUN sed -i 's/attn_implementation=candidate,/attn_implementation=candidate,\n                    device_map="cpu",/' \
    /app/ace-step-1.5/acestep/core/generation/handler/init_service_loader.py && \
    grep -n 'device_map="cpu"' /app/ace-step-1.5/acestep/core/generation/handler/init_service_loader.py

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
