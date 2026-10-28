# 배포 전에 실행: python set-version.py 1.6.0
# app.js의 VERSION과, 모든 파일이 서로를 불러오는 주소의 ?v= 꼬리표를 같은 버전으로 맞춘다.
# (GitHub Pages가 파일을 캐시해서 새 파일과 옛 파일이 섞이는 것을 막기 위함)
import pathlib, re, sys

version = sys.argv[1]
root = pathlib.Path(__file__).parent
local = r"(\./[\w-]+\.(?:js|css))(?:\?v=[\w.]+)?"

for path in root.glob('*.js'):
    s = path.read_text(encoding='utf8')
    s = re.sub(r"(from\s+'|import\('|import\s+')" + local + "'", lambda m: f"{m.group(1)}{m.group(2)}?v={version}'", s)
    if path.name == 'app.js':
        s = re.sub(r"const VERSION = '[\w.]+'", f"const VERSION = '{version}'", s)
    path.write_text(s, encoding='utf8')

for path in root.glob('*.html'):
    s = path.read_text(encoding='utf8')
    s = re.sub(r'((?:src|href)=")([\w-]+\.(?:js|css))(?:\?v=[\w.]+)?"', lambda m: f'{m.group(1)}{m.group(2)}?v={version}"', s)
    path.write_text(s, encoding='utf8')

print('version set to', version)
