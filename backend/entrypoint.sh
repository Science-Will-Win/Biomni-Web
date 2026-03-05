#!/bin/bash
opentelemetry-instrument \
    --traces_exporter otlp \
    --metrics_exporter otlp \
    --logs_exporter otlp \
    --service_name biomni-backend \
    --exporter_otlp_endpoint "http://172.17.0.1:4317" \
    --exporter_otlp_protocol "grpc" \
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
