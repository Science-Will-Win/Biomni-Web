FROM python:3.11-slim

# 1. 시스템 의존성 설치 (Biomni 필수 요소: R, WeasyPrint 등)
RUN apt-get update && apt-get install -y \
    git build-essential curl r-base weasyprint \
    libpango-1.0-0 libharfbuzz0b libpangoft2-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. 파이썬 라이브러리 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN opentelemetry-bootstrap -a install

# 3. 소스 코드 복사
COPY . /app/backend_code

# 4. 실행 권한 부여
RUN chmod +x /app/backend_code/entrypoint.sh
WORKDIR /app/backend_code

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]