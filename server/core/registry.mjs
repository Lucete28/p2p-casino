// 카지노 게임 목록과 상태. 로비 세션만 고친다 (CASINO.md 0장)
// status: 'live' = 누구나 · 'wip' = 준비 중 (로비에 "오픈 예정", 주소는 관리자만 열림)
// 게임 코드는 server/games/<id>/index.mjs, 화면은 public/<id>/
export const GAMES = [
  { id: 'holdem', title: '텍사스 홀덤', status: 'live' },
  { id: 'blackjack', title: '블랙잭', status: 'wip' },
  { id: 'baccarat', title: '바카라', status: 'wip' },
  { id: 'roulette', title: '룰렛', status: 'wip' },
  // welcome: 이 게임에 처음 들어온 사람(계정당 한 번)에게 주는 기념 칩 (운영자 결정 2026-11-17: 슬롯 5,000). core/house.mjs가 지급
  { id: 'slots', title: '슬롯머신', status: 'wip', welcome: { chips: 5000, title: '첫 방문 기념' } },
]

// 로컬 테스트 전용 게임 (CASINO_TEST_GAMES=1일 때만). 코어의 관리 모드·칩 지갑을 시험한다
if (process.env.CASINO_TEST_GAMES === '1') GAMES.push({ id: 'coinflip', title: '동전 던지기 (테스트)', status: 'live', dir: '_test' })
