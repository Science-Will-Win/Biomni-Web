#!/bin/bash
# Biomni-Web 인프라 상태 확인 스크립트
# 사용: bash check_status.sh

echo "============================================"
echo "  Biomni-Web 인프라 상태 모니터 ($(date '+%H:%M:%S'))"
echo "============================================"

# 1. Docker Desktop 상태
echo ""
echo "📦 [Docker Desktop]"
docker info --format '  Memory: {{.MemTotal | printf "%d"}} bytes' 2>/dev/null && echo "  ✅ Docker Desktop 실행 중" || echo "  ❌ Docker Desktop 꺼짐"

# 2. Docker 이미지
echo ""
echo "🖼️  [Docker 이미지]"
if docker images --format "{{.Repository}}:{{.Tag}} ({{.ID}}, {{.Size}})" 2>/dev/null | grep -q "biomni-web-aigen-backend"; then
    echo "  ✅ biomni-web-aigen-backend 이미지 존재"
    docker images --format "  {{.Repository}}:{{.Tag}} - {{.Size}} ({{.ID}})" biomni-web-aigen-backend
else
    echo "  ❌ biomni-web-aigen-backend 이미지 없음 (빌드 필요)"
fi

if docker images --format "{{.Repository}}" 2>/dev/null | grep -q "vllm"; then
    echo "  ✅ vLLM 이미지 존재"
    docker images --format "  {{.Repository}}:{{.Tag}} - {{.Size}}" vllm/vllm-openai
else
    echo "  ❌ vLLM 이미지 없음"
fi

echo ""
echo "  모든 이미지:"
docker images --format "  {{.ID}} | {{.Repository}}:{{.Tag}} | {{.Size}} | {{.CreatedSince}}" 2>/dev/null

# 3. 실행 중인 컨테이너
echo ""
echo "🏃 [실행 중인 컨테이너]"
RUNNING=$(docker ps --format "{{.Names}}" 2>/dev/null | wc -l)
if [ "$RUNNING" -gt "0" ]; then
    docker ps --format "  ✅ {{.Names}} ({{.Image}}) - {{.Status}} - {{.Ports}}" 2>/dev/null
else
    echo "  ❌ 실행 중인 컨테이너 없음"
fi

# 빌드 중인 컨테이너 확인
echo ""
echo "🔨 [빌드 상태]"
BUILD_CONTAINERS=$(docker ps -a --filter "status=running" --format "{{.ID}} {{.Image}} {{.Status}}" 2>/dev/null | grep -v "vllm\|postgres\|aigen" | head -5)
if [ -n "$BUILD_CONTAINERS" ]; then
    echo "  🔄 빌드 컨테이너 실행 중:"
    docker ps -a --filter "status=running" --format "  {{.ID}} | {{.Image}} | {{.Status}}" 2>/dev/null
else
    # 혹시 Dead 상태 컨테이너가 있는지 확인
    DEAD=$(docker ps -a --filter "status=dead" --format "{{.ID}}" 2>/dev/null | wc -l)
    if [ "$DEAD" -gt "0" ]; then
        echo "  ⚠️  Dead 상태 컨테이너 있음 (빌드 실패 가능):"
        docker ps -a --filter "status=dead" --format "  {{.ID}} | {{.Image}} | {{.Status}}" 2>/dev/null
    else
        echo "  ℹ️  빌드 컨테이너 없음"
    fi
fi

# 4. 포트 상태
echo ""
echo "🌐 [포트 상태]"

# vLLM (30000)
if curl -s --connect-timeout 2 http://localhost:30000/v1/models > /dev/null 2>&1; then
    MODELS=$(curl -s --connect-timeout 2 http://localhost:30000/v1/models 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null || echo "unknown")
    echo "  ✅ vLLM (30000) - 모델: $MODELS"
else
    echo "  ❌ vLLM (30000) - 응답 없음"
fi

# Backend (8003)
if curl -s --connect-timeout 2 http://localhost:8003/api/health > /dev/null 2>&1; then
    echo "  ✅ Backend (8003) - 정상"
else
    echo "  ❌ Backend (8003) - 응답 없음"
fi

# PostgreSQL (5433)
if docker ps --format "{{.Names}}" 2>/dev/null | grep -q "postgres\|aigen-db"; then
    echo "  ✅ PostgreSQL (5433) - 실행 중"
else
    echo "  ❌ PostgreSQL (5433) - 실행 안됨"
fi

# Frontend (5173)
if curl -s --connect-timeout 2 http://localhost:5173 > /dev/null 2>&1; then
    echo "  ✅ Frontend (5173) - 실행 중"
else
    echo "  ❌ Frontend (5173) - 실행 안됨"
fi

# 5. 디스크 공간
echo ""
echo "💾 [디스크 공간]"
df -h /c /d /e 2>/dev/null | tail -n +2 | while read line; do
    echo "  $line"
done

# 6. 중간 이미지 (빌드 진행도 추정)
echo ""
echo "📊 [중간 이미지 (빌드 레이어)]"
docker images -a --format "{{.ID}} | {{.Size}} | {{.CreatedAt}}" 2>/dev/null | grep "<none>" | head -10 | while read line; do
    echo "  $line"
done

echo ""
echo "============================================"
echo "  다음 단계:"
if ! docker images --format "{{.Repository}}" 2>/dev/null | grep -q "biomni-web-aigen-backend"; then
    echo "  1. 백엔드 이미지 빌드 완료 대기"
    echo "     → docker images | grep biomni 로 확인"
fi
if ! curl -s --connect-timeout 1 http://localhost:30000/v1/models > /dev/null 2>&1; then
    echo "  2. vLLM 서버 시작"
    echo "     → docker start vllm-server"
fi
if ! curl -s --connect-timeout 1 http://localhost:8003/api/health > /dev/null 2>&1; then
    echo "  3. docker-compose up -d"
fi
if ! curl -s --connect-timeout 1 http://localhost:5173 > /dev/null 2>&1; then
    echo "  4. npm run dev (frontend)"
fi
echo "============================================"
