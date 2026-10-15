#!/bin/bash
# Put the Holo4 builds the bake-off compares into ~/models on ultra.
#
#   deploy/explore/fetch-holo4.sh            # 4-bit MLX + Q4 GGUF (about 41 GB)
#   deploy/explore/fetch-holo4.sh --six-bit  # also the 6-bit MLX (about 29 GB more)
#
# The 35B-A3B only: it is Apache-2.0. The 27B is CC BY-NC, and testing paid
# apps is commercial use, so it is not fetched. The MLX build is one person's
# conversion (abenzerps), not the vendor's; the GGUF is the vendor's own.
set -euo pipefail
command -v hf >/dev/null || { echo "needs the Hugging Face CLI: uv tool install huggingface_hub[cli]"; exit 1; }
M="${MODELS_DIR:-$HOME/models}"
mkdir -p "$M/mlx" "$M/gguf"
hf download abenzerps/Holo4-35B-A3B-MLX --include "4bit/*" --local-dir "$M/mlx/Holo4-35B-A3B-MLX"
if [ "${1:-}" = "--six-bit" ]; then
  hf download abenzerps/Holo4-35B-A3B-MLX --include "6bit/*" --local-dir "$M/mlx/Holo4-35B-A3B-MLX"
fi
hf download Hcompany/Holo4-35B-A3B-GGUF --include "*Q4_K_M*" "*mmproj*" --local-dir "$M/gguf/Holo4-35B-A3B"
du -sh "$M/mlx/Holo4-35B-A3B-MLX" "$M/gguf/Holo4-35B-A3B"
echo "Read each model card's licence before anything ships: $M/gguf/Holo4-35B-A3B/README.md"
