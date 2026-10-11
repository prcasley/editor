# SAM 3D Objects runner for the measurement benchmark. UNTESTED: not built or run yet (the
# box that wrote it has no GPU). Follows sam-3d-objects doc/setup.md: the conda env from
# environments/default.yml, then the CUDA 12.1 wheels. Needs an NVIDIA GPU with >= 32 GB.
#
# Build from tools/sam3d-bench (the context must hold sam3d_bench/ and runner/):
#   docker build -f runner/Dockerfile -t sam3d-bench .
# Run (checkpoints are gated on Hugging Face and are mounted, never baked in):
#   docker run --gpus all --rm \
#     -v "$PWD/checkpoints/hf:/opt/sam-3d-objects/checkpoints/hf:ro" \
#     -v "$PWD/cases:/cases:ro" -v "$PWD/runs:/runs" \
#     sam3d-bench --cases /cases --out /runs/sam3d-f91db41

FROM nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04

# The commit this runner was written against; bump deliberately.
ARG SAM3D_REF=f91db411c50efee93d8db7aeb323885650f6f722
ENV DEBIAN_FRONTEND=noninteractive \
    MAMBA_ROOT_PREFIX=/opt/micromamba \
    # pytorch3d / gsplat compile here without a visible GPU: force CUDA kernels for
    # A100 (8.0), A10/A40 (8.6), L40S/L4 (8.9) and H100 (9.0).
    FORCE_CUDA=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates bzip2 build-essential libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
      | tar -xj -C /usr/local/bin --strip-components=1 bin/micromamba

RUN git clone https://github.com/facebookresearch/sam-3d-objects.git /opt/sam-3d-objects \
    && git -C /opt/sam-3d-objects checkout "$SAM3D_REF"
WORKDIR /opt/sam-3d-objects
RUN micromamba env create -y -f environments/default.yml && micromamba clean -a -y

SHELL ["micromamba", "run", "-n", "sam3d-objects", "/bin/bash", "-euo", "pipefail", "-c"]
# doc/setup.md, step 1
ENV PIP_EXTRA_INDEX_URL="https://pypi.ngc.nvidia.com https://download.pytorch.org/whl/cu121"
RUN pip install -e '.[dev]' && pip install -e '.[p3d]'
ENV PIP_FIND_LINKS="https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.5.1_cu121.html"
RUN pip install -e '.[inference]'
RUN python ./patching/hydra

COPY sam3d_bench /opt/sam3d-bench/sam3d_bench
COPY runner/run.py /opt/sam3d-bench/runner/run.py
ENV SAM3D_ROOT=/opt/sam-3d-objects
ENTRYPOINT ["micromamba", "run", "-n", "sam3d-objects", "python", "/opt/sam3d-bench/runner/run.py"]
