# 홈서버(justmadethisthat.com/casino)용. 빌드 없는 정적 파일을 nginx로 그대로 내보낸다.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
# 게임 파일만 골라서 넣는다(개발용 파일이 사이트에 노출되지 않게). 터널이 /casino 경로를 그대로 넘기므로 /casino/ 아래에 둔다
# 새 파일을 추가하면 여기에도 적을 것
COPY index.html stats.html style.css app.js poker.js odds.js bot.js net.js cloud.js firebase-config.js stats.js og-image.png /usr/share/nginx/html/casino/

EXPOSE 3000
