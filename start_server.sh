#!/bin/bash
WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$WORK_DIR")"
MODELS_DIR="$PARENT_DIR/models"

# Ensure models directory exists
mkdir -p "$MODELS_DIR"

# Load model path from .env
SGLANG_MODEL_PATH=""
if [ -f "$WORK_DIR/.env" ]; then
    SGLANG_MODEL_PATH=$(grep -E '^SGLANG_MODEL_PATH=' "$WORK_DIR/.env" | cut -d'=' -f2-)
fi

# Resolve relative path (relative to WORK_DIR)
if [[ "$SGLANG_MODEL_PATH" == ../* || "$SGLANG_MODEL_PATH" == ./* ]]; then
    MODEL_PATH="$(cd "$WORK_DIR" && realpath -m "$SGLANG_MODEL_PATH")"
elif [ -n "$SGLANG_MODEL_PATH" ]; then
    MODEL_PATH="$SGLANG_MODEL_PATH"
else
    MODEL_PATH="$MODELS_DIR/Ministral-3-3B-Reasoning-2512"
fi

# ─── Start SGLang model server ───
start_sglang() {
    echo "============================================"
    echo "  SGLang Model Server"
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

    echo "Starting SGLang server..."
    python -m sglang.launch_server \
        --model-path "$MODEL_PATH" \
        --port 30000 \
        --host 0.0.0.0 \
        --attention-backend triton \
        --context-length 8192 &
    SGLANG_PID=$!
    echo "SGLang PID: $SGLANG_PID"

    # Wait for SGLang to be ready
    echo "Waiting for SGLang server..."
    for i in $(seq 1 30); do
        if curl -s http://localhost:30000/health > /dev/null 2>&1; then
            echo "SGLang server is ready!"
            break
        fi
        sleep 2
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
    sglang)
        start_sglang
        ;;
    backend)
        start_backend
        ;;
    all)
        start_sglang
        start_backend
        ;;
    *)
        echo "Usage: $0 {sglang|backend|all}"
        exit 1
        ;;
esac
