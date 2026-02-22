#!/bin/bash

# OTLP 계측과 함께 Uvicorn 실행
opentelemetry-instrument \
    --traces_exporter otlp \
    --metrics_exporter otlp \
    --logs_exporter otlp \
    --service_name biomni-backend \
    --exporter_otlp_endpoint "http://10.178.0.13:4317" \
    --exporter_otlp_protocol "grpc" \
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload