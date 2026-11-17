# 홈서버(justmadethisthat.com/casino)용 카지노 서버 (v1.8.0~).
# 정적 파일 + /casino/ws 웹소켓 + /casino/api/*. 판 진행·카드·봇·코인 정산을 서버가 한다 (DEV_REFERENCE 2-2 카지노)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 PUBLIC_DIR=/app/public DATA_DIR=/app/data

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/index.mjs server/room.mjs server/store.mjs server/jmtt.mjs ./server/
# 게임 파일만 골라서 넣는다 (개발용 파일·보고.md가 사이트에 노출되지 않게). 새 파일을 추가하면 여기와 server/index.mjs의 PUBLIC_FILES에도 적을 것
COPY index.html stats.html style.css app.js poker.js odds.js bot.js net.js cloud.js stats.js og-image.png ./public/
# poker.js·bot.js를 서버에서도 그대로 쓰므로 ES 모듈로 읽게 함 (이 파일은 사이트에 내보내지 않음)
RUN echo '{"type":"module"}' > /app/public/package.json && mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
