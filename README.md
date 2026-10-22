# P2P 카지노 · 포커

서버 없이 브라우저끼리 직접 연결(WebRTC, [Trystero](https://github.com/dmotz/trystero))되는 텍사스 홀덤입니다.
GitHub Pages에 그대로 올리면 동작합니다.

**플레이: https://lucete28.github.io/p2p-casino/** (카카오톡 안에서 열면 구글 로그인이 막히니 크롬/사파리로 여세요)

## 파일
- `index.html`, `style.css` — 화면
- `app.js` — P2P 연결, 방 만들기/참가, 화면 그리기
- `poker.js` — 게임 규칙(족보 판정, 베팅, 사이드팟). 설정값(`CONFIG`)도 여기에 있음
- `odds.js` — 내 패 분석(족보별 완성 확률, 예상 승률)과 족보표 데이터
- `cloud.js`, `firebase-config.js` — 구글 로그인과 토큰 저장(Firebase)
- `firestore.rules` — Firebase 보안 규칙(콘솔에 붙여넣기용)

## 규칙/설정 (`poker.js`의 CONFIG)
| 항목 | 기본값 |
|---|---|
| 기본 토큰 | 1000 |
| 토큰이 바닥났을 때 하루 재지급 횟수 | 10 (게임 화면에는 표시 안 함) |
| 블라인드 | 10 / 20 |
| 최대 인원 | 6명 |
| 행동 제한 시간 | 30초 (넘기면 자동 체크/폴드) |

토큰을 모두 잃으면 기본 토큰을 자동으로 다시 받습니다. 하루 10번을 다 쓴 사람에게만 "내일 다시 참여할 수 있어요"라고 안내합니다.

## GitHub Pages 배포
1. GitHub에서 새 저장소를 만듭니다. 예를 들어 `<아이디>.github.io`로 만들면 주소가 `https://<아이디>.github.io`가 됩니다.
2. 이 파일들(`index.html`, `style.css`, `app.js`, `poker.js`, `cloud.js`, `firebase-config.js`)을 업로드합니다.
3. Settings → Pages → Branch를 `main`으로 지정하고 저장합니다.
4. 1~2분 뒤 접속 → **방 만들기** → **초대 링크 복사**로 친구에게 링크를 보냅니다.

로컬에서 테스트할 때는 파일을 더블클릭하지 말고 간단한 서버로 여세요 (예: `python -m http.server`).

## Firebase 연결 (구글 로그인 + 토큰 저장) — 약 5분
설정하면 구글 계정에 토큰과 재지급 횟수가 저장되어, 기기를 바꿔도 이어집니다.
설정하지 않으면(`firebase-config.js`가 `null`) 지금처럼 브라우저에만 저장됩니다.

1. https://console.firebase.google.com 접속 → **프로젝트 추가** → 이름 입력(예: `p2p-casino`) → Google 애널리틱스는 꺼도 됩니다.
2. 프로젝트 홈에서 **웹 앱 추가(`</>` 아이콘)** → 앱 이름 입력 → 화면에 나오는 `firebaseConfig = { ... }` 값을
   `firebase-config.js`의 `export const firebaseConfig = null` 자리에 붙여넣습니다.
3. 왼쪽 메뉴 **Authentication** → 시작하기 → 로그인 방법에서 **Google** 사용 설정 → 저장.
4. Authentication → **설정** → **승인된 도메인**에 `<아이디>.github.io`를 추가합니다.
5. 왼쪽 메뉴 **Firestore Database** → 데이터베이스 만들기 → 위치는 `asia-northeast3 (서울)` → **프로덕션 모드**로 시작.
6. Firestore → **규칙** 탭 → 내용을 모두 지우고 `firestore.rules` 파일 내용을 붙여넣고 **게시**.
7. 바뀐 `firebase-config.js`를 GitHub에 다시 올리면 끝입니다.

무료 플랜(Spark) 한도(하루 쓰기 2만 회 등) 안에서 충분히 돌아가며, 한도를 넘어도 요금이 청구되지 않고 그날만 저장이 멈춥니다.

## 구조와 한계
- 방을 만든 사람(방장)의 브라우저가 딜러 역할을 합니다. 카드를 섞고, 각자의 카드는 **그 사람에게만** 보냅니다.
- 방장이 나가면 그 방은 끝납니다.
- Firebase 보안 규칙(`firestore.rules`)이 막는 것: 남의 토큰 수정, 하루 10회 넘는 재지급, 재지급 횟수 되돌리기, 날짜 조작.
  다만 게임 결과(토큰 증감)는 각자 브라우저가 저장하므로, 작정하고 조작하는 것까지 100% 막지는 못합니다.
  (막으려면 서버 코드가 필요하고, 이는 Firebase 유료 플랜에서만 가능)
- 실제 돈과는 무관한 게임 토큰입니다.

## 개발자용: 로컬 테스트
- 규칙 테스트와 로그인 흐름은 Firebase 에뮬레이터로 확인할 수 있습니다.
  `npx firebase emulators:start --only auth,firestore --project demo-poker` 실행 후
  `http://localhost:8123/?emu` 로 접속하면 가짜 구글 로그인으로 동작합니다.
