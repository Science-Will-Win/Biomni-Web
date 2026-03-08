#!/bin/bash

echo "=========================================="
echo "🔄 Pre-downloading Biomni Database & Data..."
echo "=========================================="

# 서버가 트래픽을 받기 전에 A1 에이전트를 1회 호출하여 필수 DB를 미리 다운로드합니다.
python -c "
import os
from biomni.agent.a1 import A1

data_path = os.getenv('BIOMNI_DATA_PATH', '/app/data')
os.makedirs(data_path, exist_ok=True)

print(f'Triggering initial download to: {data_path}')
A1(path=data_path)
print('✅ All necessary data and DBs have been successfully downloaded!')
"

echo "=========================================="
echo "🚀 Starting FastAPI Server..."
echo "=========================================="

opentelemetry-instrument \
    --traces_exporter otlp \
    --metrics_exporter otlp \
    --logs_exporter otlp \
    --service_name biomni-backend \
    --exporter_otlp_endpoint "http://172.17.0.1:4317" \
    --exporter_otlp_protocol "grpc" \
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
