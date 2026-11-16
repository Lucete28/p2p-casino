# 홈서버(justmadethisthat.com/casino)용. 빌드 없는 정적 파일을 nginx로 그대로 내보낸다.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
# 게임 파일 (개발용 파일은 .dockerignore로 뺌). 터널이 /casino 경로를 그대로 넘기므로 /casino/ 아래에 둔다
COPY . /usr/share/nginx/html/casino/

EXPOSE 3000
