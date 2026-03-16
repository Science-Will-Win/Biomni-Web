#!/bin/bash
WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$WORK_DIR")"
MODELS_DIR="$PARENT_DIR/models"

# Ensure models directory exists
mkdir -p "$MODELS_DIR"

# Load model path from .env
VLLM_MODEL_PATH=""
if [ -f "$WORK_DIR/.env" ]; then
    VLLM_MODEL_PATH=$(grep -E '^VLLM_MODEL_PATH=' "$WORK_DIR/.env" | cut -d'=' -f2-)
fi

# Resolve relative path (relative to WORK_DIR)
if [[ "$VLLM_MODEL_PATH" == ../* || "$VLLM_MODEL_PATH" == ./* ]]; then
    MODEL_PATH="$(cd "$WORK_DIR" && realpath -m "$VLLM_MODEL_PATH")"
elif [ -n "$VLLM_MODEL_PATH" ]; then
    MODEL_PATH="$VLLM_MODEL_PATH"
else
    MODEL_PATH="$MODELS_DIR/Ministral-3-3B-Reasoning-2512"
fi

# ─── Start vLLM model server ───
start_vllm() {
    echo "============================================"
    echo "  vLLM Model Server"
    echo "  Models dir : $MODELS_DIR"
    echo "  Model path : $MODEL_PATH"
    echo "  Port       : 30000"
    echo "============================================"

    if [ ! -d "$MODEL_PATH" ]; then
        echo "Model not found. Downloading to $MODEL_PATH ..."
        huggingface-cli download \
            mistralai/Ministral-3-3B-Reasoning-2512 \
            --local-dir "$MODEL_PATH"
    fi

    echo "Starting vLLM server..."
    docker run --gpus all -d \
        --name vllm-server \
        -v "$MODELS_DIR:/app/models" \
        -p 30000:8000 \
        vllm/vllm-openai:latest \
        --model "/app/models/$(basename "$MODEL_PATH")" \
        --port 8000 \
        --host 0.0.0.0

    echo "vLLM container: vllm-server"

    # Wait for vLLM to be ready
    echo "Waiting for vLLM server..."
    for i in $(seq 1 60); do
        if curl -s http://localhost:30000/health > /dev/null 2>&1; then
            echo "vLLM server is ready!"
            break
        fi
        sleep 5
    done
}

# ─── Start Docker backend ───
start_backend() {
    cd "$WORK_DIR" || exit
    docker compose up -d --build
    echo "aigen_server started (localhost:8003)"
    echo "Logs: docker compose logs -f aigen-backend"
}

# ─── Main ───
case "${1:-all}" in
    vllm)
        start_vllm
        ;;
    backend)
        start_backend
        ;;
    all)
        start_vllm
        start_backend
        ;;
    *)
        echo "Usage: $0 {vllm|backend|all}"
        exit 1
        ;;
esac
