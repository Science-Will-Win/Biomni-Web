# 1단계: Node.js 환경에서 Vite 앱 빌드
FROM node:18-alpine AS builder

WORKDIR /app

# 패키지 매니저 파일 복사 및 의존성 설치
COPY package*.json ./
RUN npm install

# 소스 코드 복사 및 빌드
COPY . .
RUN npm run build

# 2단계: Nginx를 사용하여 빌드된 정적 파일 서빙
FROM nginx:alpine

# 빌드된 결과물(dist)을 Nginx 웹 서버 폴더로 복사
COPY --from=builder /app/dist /usr/share/nginx/html

# 포트 노출
EXPOSE 80

# Nginx 실행
CMD ["nginx", "-g", "daemon off;"]