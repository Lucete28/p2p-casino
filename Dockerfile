# 홈서버(justmadethisthat.com/casino)용 카지노 서버 (v1.9.0~ 로비 구조, CASINO.md)
# /casino/ 로비 + /casino/<게임>/ (정적 파일 + 웹소켓 + API). 판 진행·카드·봇·코인 정산은 서버가 한다 (DEV_REFERENCE 2-2 카지노)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 PUBLIC_DIR=/app/public DATA_DIR=/app/data

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# 서버 코드와 화면 파일을 통째로. 개발용(테스트·mock·테스트 게임)과 문서는 .dockerignore로 뺀다.
# 정적 파일은 public/ 아래 허용한 확장자만 내보낸다 (server/core/http.mjs) → 새 파일을 추가해도 여기를 고칠 필요 없음
COPY server/ ./server/
COPY public/ ./public/
# 홀덤의 poker.js·bot.js를 서버에서도 그대로 쓰므로 ES 모듈로 읽게 함 (package.json은 사이트에 내보내지 않음)
RUN echo '{"type":"module"}' > /app/public/holdem/package.json && mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
