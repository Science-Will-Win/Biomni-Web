# 파일 위치: backend/Dockerfile
FROM biomni-base:latest

# 자주 변하는 Biomni-Web(백엔드) 코드만 복사
COPY . /app/backend_code
WORKDIR /app/backend_code

# entrypoint 권한 및 윈도우 찌꺼기 방지 처리
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]