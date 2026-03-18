FROM jiyeonl/biomni-base:latest

WORKDIR /app/backend_code

# COPY 전에 패키지를 먼저 설치하면 빌드 속도(캐싱)에 유리합니다.
RUN pip install --no-cache-dir asyncpg psycopg2-binary

# 코드 복사 (.dockerignore에 의해 .env 파일은 자동으로 제외됨)
COPY . /app/backend_code

# 확실한 윈도우 찌꺼기(CRLF) 제거 및 실행 권한 부여
# sed가 안 먹히는 엣지 케이스를 방지하기 위해 tr 명령어 사용
RUN tr -d '\r' < entrypoint.sh > entrypoint_tmp.sh \
    && mv entrypoint_tmp.sh entrypoint.sh \
    && chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/app/backend_code/entrypoint.sh"]
