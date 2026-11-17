# JMTT 카지노 구조 (로비 · 게임 연결 · 서버)

> 카지노에 새 게임을 붙이는 모든 세션이 먼저 읽는 문서. `*.md`라 사이트에는 나가지 않는다 (.dockerignore).
> 기준: v1.9.0 (2026-11-17). 공통 규칙은 home-server의 `DEV_REFERENCE.md`, 코인 API는 `COIN_GUIDE.md`.

---

## 0. 누가 무엇을

| 누구 | 맡는 것 | 손대지 않는 것 |
|---|---|---|
| **로비 세션** (중간관리자) | 로비(`public/index.html`·`lobby.*`), 주소·라우팅, 서버 코어(`server/core/`), 칩 지갑, 공통 화면 부품(`public/shared/`), `server/index.mjs`, Dockerfile, 이 문서 | 각 게임의 규칙·화면 |
| **홀덤 세션** | `public/holdem/`, `server/games/holdem/` | 코어·다른 게임 |
| **게임 세션** (블랙잭·바카라·룰렛·슬롯) | 자기 폴더 두 곳: `public/<id>/`, `server/games/<id>/` | 코어·다른 게임 |
| **서버 세션** (home-server) | 카드(apps.json)·스크린샷·sitemap·개인정보처리방침·코인 권한 | 카지노 코드 |

- 코어를 바꿔야 하면 직접 고치지 말고 로비 세션에 요청한다 (사용자가 전달).
- 카지노 전체가 **컨테이너 하나, 앱 id `casino`, 경로 `/casino`**. 게임을 더해도 터널·compose는 그대로다.

## 1. 주소

| 주소 | 내용 |
|---|---|
| `/casino/` | **로비** (카지노 홀). JMTT 배지와 맨 아래 링크(JMTT · 개인정보처리방침 · 문의)는 여기에 |
| `/casino/<id>/` | 각 게임 화면 (`public/<id>/index.html`) — `holdem`, `blackjack`, `baccarat`, `roulette`, `slots` |
| `/casino/<id>/ws` | 그 게임의 웹소켓 (로그인한 사람만) |
| `/casino/<id>/api/*` | 그 게임의 HTTP API (게임 모듈의 `api`) |
| `/casino/api/lobby` | 로비가 읽는 게임 목록·상태·인원, 내가 앉아 있는 게임 |
| `/casino/api/refill` | 로비 캐셔의 파산 지원금: `GET` 상태, `POST` 받기 (4장) |
| `/casino/<id>` | `/casino/<id>/`로 301 |

**옛 주소** (v1.8까지 홀덤이 `/casino/`에 있었음) — 한 달쯤 유지 후 정리
- `/casino/#방코드` → 로비가 `holdem/#방코드`로 넘김
- `/casino/ws`, `/casino/api/rooms|season|stats` → 홀덤
- `/casino/stats.html` → `/casino/holdem/stats.html` (301)

**준비 중 게임**: `server/core/registry.mjs`에서 `status: 'wip'`인 게임은 로비에 "오픈 예정"으로 보이고, 주소는 **관리자(`CASINO_ADMINS`)만** 열린다. 일반 사용자에게는 404. 그래서 만드는 중에도 main에 올려 실제 사이트에서 미리 볼 수 있다.

## 2. 저장소 구조

```
p2p-casino/
├─ CASINO.md · README.md · 보고.md
├─ Dockerfile · .dockerignore
├─ server/
│  ├─ index.mjs              시작점: 게임 불러오기, 라우팅, 웹소켓, 종료 처리
│  ├─ core/                  ── 로비 세션 ──
│  │  ├─ registry.mjs        게임 목록과 상태 (live / wip)
│  │  ├─ http.mjs            정적 파일 규칙, 기기 쿠키
│  │  ├─ house.mjs           하우스 게임 '관리 모드' (플레이어·칩·바이인·캐시아웃)
│  │  ├─ wallet.mjs          칩 지갑: 코인 맡기기·정산 대기열·재시작 복구
│  │  ├─ store.mjs           SQLite 하나 (/app/data/casino.db)
│  │  ├─ jmtt.mjs            /auth 확인·코인
│  │  └─ rng.mjs             crypto 난수, 셔플, 카드 묶음
│  ├─ games/
│  │  ├─ holdem/             ── 홀덤 세션 ── index.mjs(모듈) · room.mjs
│  │  ├─ <id>/index.mjs      ── 각 게임 세션 ──
│  │  └─ _test/              테스트 전용 게임 '동전 던지기' (가장 작은 예시. 사이트에는 안 들어감)
│  ├─ dev/mock-auth.mjs      로컬 테스트용 가짜 /auth
│  └─ test-*.mjs             테스트 (8장)
└─ public/
   ├─ index.html · lobby.js · lobby.css · og-image.png   로비
   ├─ shared/casino.js · casino.css                      하우스 게임 공통 화면 부품
   ├─ holdem/                                            홀덤 화면 (poker.js·bot.js는 서버도 같이 씀)
   ├─ <id>/                                              각 게임 화면
   └─ coinflip/                                          테스트 게임 화면 (사이트에는 안 들어감)
```

**정적 파일 규칙** (`server/core/http.mjs`): `public/` 아래, 허용한 확장자(`html js mjs css json svg png webp jpg ico woff2 mp3 ogg wav`)만 내보낸다. 점으로 시작하는 이름, `..`, `*.md`, `package.json`, `test-*`는 막는다. → 게임 세션이 파일을 추가할 때 화이트리스트를 고칠 필요가 없다.

## 3. 게임 모듈 약속

`server/games/<id>/index.mjs`가 객체 하나를 `export default`한다. 두 가지 모드가 있다.

### 관리 모드 (하우스 게임: 블랙잭·바카라·룰렛·슬롯) — 기본

코어(`core/house.mjs`)가 플레이어·칩·바이인·캐시아웃·연결 끊김·재시작을 맡고, 게임은 **판 규칙만** 짠다. 예시: `server/games/_test/index.mjs`.

```js
export default {
  id: 'roulette',              // registry.mjs의 id와 같아야 함
  title: '룰렛',
  buyIn: { min: 1 },           // 칩 바꾸기 최소 (상한 없음, 5장)
  join(p, ctx) {},             // 접속할 때마다 (새로고침·다른 탭 포함). 지금 상태를 ctx.send로 보내 주기
  message(p, msg, ctx) {},     // 브라우저가 보낸 JSON (공통 메시지 buyin·cashout·leave는 코어가 먼저 처리)
  leave(p, ctx) {},            // 나가기·연결 끊김 60초. 진행 중인 판을 마무리할 기회 (예: 블랙잭 자동 스탠드 → payout)
  summary(ctx) { return { players: 0, tables: 0 } }, // (선택) 로비에 보일 숫자. 없으면 칩을 가진 사람 수
  shutdown(ctx) {},            // (선택) 서버를 끌 때
  chipsChanged(p, ctx) {},     // (선택) 칩을 바꾼 직후
  async init(ctx) {},          // (선택) 서버가 켜질 때 한 번
}
```

`p` (플레이어): `p.id`(JMTT 사용자 ID), `p.name`, `p.chips`, `p.inPlay`(진행 중인 판에 건 칩) — **읽기만** 한다.

`ctx`가 주는 것

| 이름 | 하는 일 |
|---|---|
| `ctx.send(p, msg)` / `ctx.broadcast(list, msg)` / `ctx.players()` | 브라우저로 JSON, 접속한 플레이어 목록 |
| `ctx.bet(p, amount, roundId)` | 베팅: 칩에서 빼고 '진행 중'으로 적는다. 정수가 아니거나 1 미만·칩보다 많으면 `false` |
| `ctx.payout(p, amount, roundId, detail)` | 판 끝: 받을 칩(**원금 포함**, 0 이상 정수)을 더하고 '진행 중'을 비운다. 판 기록(30일) 저장 |
| `ctx.settle(p, bet, payout, roundId, detail)` | 한 번에 끝나는 판(슬롯·룰렛)은 이것 하나로. 베팅이 안 되면 `false` |
| `ctx.rng` | `int(n)` · `shuffle(arr)` · `deck(덱수)` (카드 `'As' 'Td' 'Kh' '2c'`) — crypto 기반. **`Math.random` 금지** |
| `ctx.limit(p, key, ms)` | 너무 빠른 요청 막기 (예: 슬롯 스핀 800ms) |
| `ctx.log(...)` | 서버 로그 (이메일·토큰 찍지 않기) |

코어가 처리하는 공통 메시지

| 브라우저 → 서버 | 서버 → 브라우저 |
|---|---|
| `{ t: 'buyin', amount }` 코인 → 칩 (이미 칩이 있으면 더해짐) | `{ t: 'me', me, coins, game }` 접속 직후 |
| `{ t: 'cashout' }` 칩 → 코인 (판 도중엔 거절) | `{ t: 'chips', chips, inPlay, coins?, cashout? }` 바뀔 때마다 |
| `{ t: 'leave' }` 나가기 (칩은 코인으로) | `{ t: 'toast', msg }` · `{ t: 'restart' }` |

화면 쪽은 `public/shared/casino.js`의 `startGame()`이 위 메시지를 다 처리한다 (윗줄 ← 로비 · 코인 · 칩, 칩 바꾸기 창, 코인으로, 다시 연결). 서버의 알림·거절(`toast`)을 게임 화면이 알아야 하면 `onToast(msg)` — `false`를 돌려주면 기본 알림을 띄우지 않는다. 예시: `public/coinflip/index.html`.

### 소켓 모드 (홀덤처럼 방·자리를 직접 관리하는 게임)

`mode: 'socket'`이면 코어는 로그인 확인·기기 쿠키·연결 유지만 하고 웹소켓을 그대로 넘긴다: `connect(ws)` (`ws.who`, `ws.device`), `api(req, res, path, who, ctx)`, `summary()`, `shutdown()`, `init(ctx)`. 코인은 `ctx.wallet.stakeSeat` / `closeSeat`. 새 게임은 특별한 이유가 없으면 관리 모드를 쓴다.

## 4. 코인과 칩

```
코인(JMTT 잔액) ──칩 바꾸기: stake──▶ 칩(카지노 서버가 들고 있음) ──판마다 bet / payout──▶ 칩
                                                                  └──코인으로·나가기·끊김 60초·서버 종료: cashout──▶ 코인
```

- **판마다 `/auth`를 부르지 않는다.** 들어올 때 한 번, 나갈 때 한 번. 코인 내역에는 `카지노 입장 · 룰렛` / `카지노 정산 · 룰렛`으로 남는다.
- **한 사람은 한 번에 한 게임에만 앉는다** (운영자 결정 2026-11-17). 다른 게임에 칩·자리가 있으면 칩 바꾸기·앉기를 거절한다 (`wallet.stakeSeat` → `busy`). 홀덤은 지금처럼 앉을 때 코인을 전부 맡긴다.
- 칩은 판이 끝날 때마다 `seats` 표에 적는다 (`stack`, `in_play`).
- **판 도중 나가면**(나가기·연결 끊김 60초) 게임의 `leave`가 판을 마무리하지 않는 한 **건 칩을 잃는다** — 카드를 보고 나가서 베팅을 돌려받는 꼼수를 막기 위해.
- **서버가 판 도중 꺼지면** 그 판은 무효: 건 칩까지 돌려준 뒤 모두 정산한다 (`wallet.recover`, `house.shutdown`). 서버 잘못이므로.
- 하우스 게임은 사람끼리 코인이 오가지 않아 여러 계정 몰아주기 위험이 없다. 대신 위험은 **규칙·확률 버그로 코인이 새는 것** → 6장 시뮬레이션 필수.

**파산 지원금 (로비 캐셔)** — 운영자 결정 2026-11-17, 예전 연습 토큰의 "다 잃으면 1,000 재지급"을 코인으로. 캐셔의 출석 버튼 대신 (출석은 JMTT 배지·메인 화면에 그대로 있음)
- **코인 500 이하 + 어느 게임에도 칩이 없음**이면 **1,000코인**, 한국 날짜로 **하루 10번**까지 (운영자 결정 2026-11-17). 조건은 서버가 확인 (`server/core/refill.mjs`의 `REFILL`). 칩을 모두 잃은 하우스 게임 자리(칩 0)는 "칩 있음"으로 치지 않는다
- 메인 `/auth`의 `earn`으로 준다 (이유 "카지노 파산 지원", `ref` = `refill:<사용자>:<날짜>:<몇 번째>` → 겹쳐 눌러도 한 번). 메인이 카지노 `earn`을 열기 전에는 "곧 열려요"(`not_ready`)이고 횟수를 쓰지 않는다
- **파산 안내**: 게임에서 칩을 모두 잃거나(홀덤: 정산 0, 하우스 게임: 칩·진행 중이 0이 됨) 코인이 없어 못 앉으면, 서버에 받을 수 있는지 물어(`GET /casino/api/refill`) 안내창과 **"캐셔로 가기"** 버튼을 띄운다 → `/casino/?cashier`로 가면 로비가 캐셔를 연다. 코인이 500보다 많으면 띄우지 않는다
  - 하우스 게임은 `shared/casino.js`가 자동으로 한다 (`bustDelay`로 결과 연출 뒤에). 홀덤은 `public/holdem/app.js`의 `offerRefill`
- 지원금을 받을 수 있는 사람이 로비에 오면 캐셔가 한 번(탭마다) 열린다
**첫 방문 기념 칩** — 운영자 결정 2026-11-17: 슬롯머신에 처음 들어온 사람에게 칩 5,000개
- `server/core/registry.mjs`의 게임 줄에 `welcome: { chips, title }`을 두면 코어(`house.mjs`)가 **계정당 게임마다 한 번** 준다 (기록: `welcome` 표). 지금은 슬롯 5,000
- 맡긴 코인 없이 칩만 넣는다. 나갈 때 남은 칩은 다른 칩처럼 코인으로 정산 (`cashout` → 메인의 카지노 순발행에 잡힘)
- 다른 게임에 앉아 있으면(한 번에 한 게임) 그때는 안 주고 "일어난 뒤 다시 오면 받아요" 알림, 다음 방문 때 준다
- 화면은 `shared/casino.js`가 `{ t: 'gift' }`를 받아 빛·칩 튀는 효과 팝업 (게임의 처음 안내 창이 열려 있으면 닫힌 뒤에). 게임은 `onGift`로 연출을 더할 수 있다
- 테스트: `test-welcome.mjs`

- 캐셔와 파산 안내창에 **"다른 JMTT 게임에서도 코인을 벌 수 있어요"** + 링크 (지뢰찾기 대전 · 데굴데굴 눈사람 · ~싶을 때 누르는 버튼). 목록은 `public/shared/earn.js` 하나 — 메인의 `EARN_APPS`가 바뀌면 여기만 고친다

## 5. 게임별 기본값 (운영자 결정 2026-11-17: 한도 없음)

- **칩 바꾸기·한 판 베팅에 상한이 없다.** 최소 1 (정수). `/auth`의 한 번 최대 금액(100,000)은 칩 지갑이 나눠 보낸다.

| 게임 | 규칙 (1단계) | 하우스 몫 | 판 속도 |
|---|---|---|---|
| 블랙잭 | 6덱 슈(75%에서 다시 섞음), 딜러 소프트 17 스탠드, 블랙잭 3:2, 더블 아무 두 장, 스플릿 1번(에이스 스플릿은 한 장씩), 인슈어런스·서렌더 없음 | 약 0.5% | 사람 행동 기다림, 30초 넘으면 스탠드 |
| 바카라 | 8덱, 표준 세 번째 카드 규칙, 플레이어 1:1, 뱅커 1:1 − 5% 수수료, 타이 8:1 (타이 때 플레이어·뱅커 베팅은 돌려줌) | 1.06~1.24% (타이 14%) | 판 하나 약 5초 연출 |
| 룰렛 | 유럽식 싱글 제로(0~36). 스트레이트 35:1 … 레드/블랙·홀짝·하이로우 1:1 | 2.7% | 베팅 → 스핀 연출 약 4초 |
| 슬롯 | 3릴 · 5라인. 페이표는 게임 세션이 정하되 **RTP 95%**를 시뮬레이션으로 확인 | 약 5% | 스핀 간격 최소 0.8초 |

## 6. 게임 세션 체크리스트

**코인·공정성**
- [ ] 결과는 서버가 `ctx.rng`로 정한다. 브라우저에 카드·결과를 **미리 보내지 않는다** (블랙잭 딜러의 숨긴 카드 포함)
- [ ] 칩은 `ctx.bet` / `ctx.payout` / `ctx.settle`로만. 브라우저가 보낸 값은 서버에서 다시 검사 (정수·범위·칩 잔액은 `ctx.bet`이 함)
- [ ] **시뮬레이션**: `server/games/<id>/test-sim.mjs`로 100만 판(슬롯은 1,000만 스핀) 돌려 실제 하우스 몫이 5장 값 ±0.3%p 안인지. 결과를 보고에 적는다
- [ ] 판 도중 나가기·끊김: `leave`에서 판을 어떻게 끝내는지 정하고 테스트 (안 끝내면 건 칩을 잃음)

**화면**
- [ ] `public/shared/casino.css`·`casino.js`(`startGame`)를 쓴다: 윗줄 **← 로비 · 게임 이름 · 코인 · 칩**, 블랙&골드, Pretendard
- [ ] 로그인 안 한 사람: 화면은 보여 주고, 칩 바꾸기를 누르면 로그인 (`startGame`이 처리)
- [ ] 게임 페이지에는 **JMTT 배지·광고 스크립트를 넣지 않는다** (DEV_REFERENCE 1-11, 2-5)
- [ ] `<title>`, `<meta name="description">`, `canonical`·`og:url` = `https://justmadethisthat.com/casino/<id>/` (DEV_REFERENCE 1-8)
- [ ] `localStorage` 키는 `casino:<id>:` 로 시작
- [ ] 모바일(375px)에서 가로 스크롤 없음, 버튼 44px 이상

**작업 범위**
- [ ] 자기 폴더 두 곳 밖은 고치지 않는다. 오픈(`registry`의 `live`)은 로비 세션에 요청

## 7. 진행 순서

| 단계 | 누가 | 상태 |
|---|---|---|
| 1. 구조 개편 (홀덤 이전, 코어·칩 지갑·로비·옛 주소) | 로비 세션 | **v1.9.0** 배포 (2026-11-17) |
| 2. 캐셔 파산 지원금 | 로비 세션 | **v1.9.1** (메인 `earn` 권한 대기) |
| 3. 새 게임 개발 (`wip`, 관리자만 보임) | 게임 세션 | 슬롯 진행 예정, 룰렛 보류 (2026-11-17 운영자) |
| 4. 하나씩 오픈 (`live` + 서버 세션에 카드·sitemap 요청) | 로비 세션 | |

## 8. 로컬 개발과 테스트

```bash
cd server && npm ci
node dev/mock-auth.mjs                       # 3100: 가짜 /auth + 나머지는 3200 카지노로 (MOCK_PORT·CASINO_PORT로 바꿀 수 있음)
PORT=3200 JMTT_AUTH_URL=http://127.0.0.1:3100 JMTT_COIN_KEY=test CASINO_ADMINS=u_alice CASINO_TEST_GAMES=1 DATA_DIR=../data-dev node index.mjs
# 브라우저: http://127.0.0.1:3100/auth/login?as=alice&next=/casino/   (u_alice = 관리자, 코인 1,000으로 시작)
```

| 테스트 (`BASE=http://127.0.0.1:3100 node <파일>`) | 보는 것 |
|---|---|
| `test-routes.mjs` | 주소·옛 주소·wip 막기·내보내면 안 되는 파일·로비 API |
| `test-house.mjs` | 관리 모드·칩 지갑 (테스트 게임). `CRASH=1`이면 판 도중 멈춤 → 서버 강제 종료·재시작 후 건 칩까지 돌아왔는지 장부 확인 |
| `test-refill.mjs` | 파산 지원금: 코인 501이면 거절·500이면 됨, 칩이 있으면 거절(칩 0 자리는 괜찮음), 하루 10번, 동시에 눌러도 한 번. mock을 `MOCK_NO_EARN=1`로 띄우고 `EXPECT_NO_EARN=1`이면 메인 권한 없을 때(`not_ready`) |
| `test-e2e.mjs` · `test-seats.mjs` · `test-crash.mjs` | 홀덤 (홀덤 세션) |

알려진 것: `test-seats.mjs`의 마지막 항목 "나가면 모두 정산"은 방장이 봇에게 칩을 모두 잃으면(정산할 0) 실패한다. v1.8.4에서도 같음 (홀덤 세션에 전달).

## 9. 배포와 push

- home-server `deploy.sh`가 **1분마다** 이 저장소의 `main`을 `git pull --ff-only` → 바뀌었으면 `casino` 컨테이너를 다시 빌드·재시작한다. 브랜치 push는 배포되지 않는다
- 어느 세션이 push하든 저장소 하나라 `main`에 들어가면 **카지노 전체**가 다시 배포된다
- **재시작 = 앉아 있는 모든 사람 정산** (진행 중 판 무효). 세션 여럿이 자주 push하면 그때마다 판이 끊긴다 → **브랜치에서 작업하고 main에는 모아서**
- **빌드가 깨지면 카지노 전체가 옛 버전에 머문다** → push 전에 테스트. 게임 모듈 하나가 불러오기에서 오류를 내면 그 게임만 `down`(로비에 "점검 중")이 되고 나머지는 돈다
- push 전에 `git pull --rebase`. `main`에 force-push 하지 않는다 (서버의 `--ff-only`가 멈춘다)

## 10. 서버 세션(home-server)에 요청할 것 (1단계 배포 후, 보고.md로)

1. **카드(apps.json)**: 이름 `JMTT 카지노`, 한 줄 소개 `홀덤·블랙잭·룰렛·슬롯을 코인으로 즐기는 카지노`, keywords에 `블랙잭, 바카라, 룰렛, 슬롯, 슬롯머신, blackjack, baccarat, roulette, slots` 추가, 스크린샷을 로비 화면으로 교체
2. **sitemap**: `/casino/holdem/` 추가 (게임이 오픈될 때마다 `/casino/<id>/` 추가). `/casino/`는 그대로
3. **개인정보처리방침**: 새로 모으는 것 — 하우스 게임 판 기록(베팅·결과, 30일, 홀덤 판 기록과 같은 성격). 새 외부 서비스 없음
4. **메모리·코인 권한**: 바꿀 것 없음 (`mem_limit 512m`, `casino`에 이미 `stake`/`cashout`)

---

## 부록 A. 게임 세션 착수 안내문 (게임마다 붙여 넣기)

```text
너는 JMTT 카지노의 <게임 이름> 담당이야. 저장소는 Lucete28/p2p-casino (로컬: 바탕화면\p2p-casino 또는 새로 clone).
먼저 저장소의 CASINO.md 전체와 home-server의 COIN_GUIDE.md를 읽어.
- 작업 범위: public/<id>/ 와 server/games/<id>/ 두 폴더만. 코어(server/core, server/index.mjs, public/shared, 로비, Dockerfile)는 고치지 말고 필요하면 요청으로 정리해.
- 서버는 CASINO.md 3장 '관리 모드' (export default { id, title, buyIn, join, message, leave, ... }). 결과·난수·칩은 ctx로만. 가장 작은 예시는 server/games/_test/index.mjs와 public/coinflip/index.html.
- 화면은 public/shared/casino.js의 startGame()과 casino.css를 써.
- 규칙은 CASINO.md 5장의 <게임> 줄. 베팅 한도는 없다(최소 1). 규칙을 바꾸고 싶으면 이유와 함께 제안.
- 6장 체크리스트를 모두 지키고, test-sim.mjs로 하우스 몫을 확인해. 로컬 실행은 8장.
- 브랜치 <id>에서 작업하고 main에는 사용자가 합친다. 상태는 wip라 관리자만 볼 수 있다.
- 끝나면 보고: 한 일, 시뮬레이션 결과(판 수, 실제 하우스 몫), 화면 캡처, 코어에 요청할 것.
```
