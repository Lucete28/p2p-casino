// 블랙잭 규칙 (CASINO.md 5장). 서버(server/games/blackjack)와 화면이 같이 쓴다
//   6덱 슈, 75%에서 다시 섞음 · 딜러 소프트 17 스탠드 · 딜러 피크(A·10 업카드면 블랙잭 먼저 확인)
//   블랙잭 3:2 (반 칩은 버림, 실제 카지노와 같음) · 더블 아무 두 장 (스플릿 뒤에도)
//   스플릿 1번 (같은 점수 두 장, 에이스 스플릿은 한 장씩, 스플릿 뒤 21은 블랙잭 아님) · 인슈어런스·서렌더 없음
// 카드는 core/rng.mjs의 문자열 'As' 'Td' 'Kh' '2c'

export const DECKS = 6
export const SHOE_SIZE = DECKS * 52
export const CUT = Math.round(SHOE_SIZE * 0.75) // 이만큼 나가면 다음 판 전에 다시 섞음
export const TURN_MS = 30000 // 사람 행동 기다림. 넘으면 스탠드

// 화면 연출 시간 (서버는 이것으로 정산을 늦춘다: 칩 숫자가 카드보다 먼저 바뀌지 않게)
export const DEAL_MS = 360 // 첫 네 장, 카드 한 장마다
export const HIT_MS = 360 // 히트·더블·스플릿 카드 한 장
export const DEALER_MS = 650 // 딜러: 숨긴 카드 뒤집기, 한 장 더 받기마다
export const RESULT_MS = 250 // 결과 표시

const TEN = 'TJQK'
export const rankOf = c => c[0]
export const valueOf = c => c[0] === 'A' ? 11 : TEN.includes(c[0]) ? 10 : Number(c[0])

// 점수: { total, soft } — soft = 에이스를 11로 세고 있음
export function score(cards) {
  let total = 0, aces = 0
  for (const c of cards) { if (!c) continue; total += valueOf(c); if (c[0] === 'A') aces++ }
  while (total > 21 && aces) { total -= 10; aces-- }
  return { total, soft: aces > 0 }
}
export const isNatural = cards => cards.length === 2 && score(cards).total === 21
export const canPair = cards => cards.length === 2 && valueOf(cards[0]) === valueOf(cards[1])

// 한 손의 결과와 돌려받을 칩 (원금 포함). natural = 스플릿하지 않은 첫 두 장 21
export function settleHand(hand, dealer) {
  const me = score(hand.cards).total, dl = score(dealer).total
  const natural = !hand.split && isNatural(hand.cards), dealerBJ = isNatural(dealer)
  if (natural && dealerBJ) return { result: 'push', back: hand.bet }
  if (natural) return { result: 'blackjack', back: hand.bet + Math.floor(hand.bet * 3 / 2) }
  if (dealerBJ) return { result: 'lose', back: 0 }
  if (me > 21) return { result: 'bust', back: 0 }
  if (dl > 21) return { result: 'win', back: hand.bet * 2, dealerBust: true }
  if (me > dl) return { result: 'win', back: hand.bet * 2 }
  if (me === dl) return { result: 'push', back: hand.bet }
  return { result: 'lose', back: 0 }
}

// 딜러가 한 장 더 받나 (소프트 17 스탠드)
export const dealerHits = cards => score(cards).total < 17

// ---------- 기본 전략 (6덱 · S17 · 더블 애프터 스플릿 · 서렌더 없음) ----------
// 화면의 '추천'과 시뮬레이션이 같이 쓴다. 이대로 하면 하우스 몫이 약 0.5%
// 칸: H 히트 · S 스탠드 · D 더블(안 되면 히트) · Ds 더블(안 되면 스탠드) · P 스플릿
const up = c => valueOf(c) === 11 ? 1 : valueOf(c) // 딜러 업카드 1(A)~10
const inR = (u, a, b) => u >= a && u <= b

function hard(t, u) {
  if (t <= 8) return 'H'
  if (t === 9) return inR(u, 3, 6) ? 'D' : 'H'
  if (t === 10) return inR(u, 2, 9) ? 'D' : 'H'
  if (t === 11) return u === 1 ? 'H' : 'D'
  if (t === 12) return inR(u, 4, 6) ? 'S' : 'H'
  if (t <= 16) return inR(u, 2, 6) ? 'S' : 'H'
  return 'S'
}
function soft(t, u) { // t = 12(AA) ~ 21
  if (t === 12) return 'H'
  if (t <= 14) return inR(u, 5, 6) ? 'D' : 'H'
  if (t <= 16) return inR(u, 4, 6) ? 'D' : 'H'
  if (t === 17) return inR(u, 3, 6) ? 'D' : 'H'
  if (t === 18) return inR(u, 3, 6) ? 'Ds' : inR(u, 2, 8) ? 'S' : 'H'
  return 'S'
}
function pair(v, u) { // v = 카드 점수 (A = 11)
  if (v === 11 || v === 8) return true
  if (v === 10 || v === 5) return false
  if (v === 9) return inR(u, 2, 9) && u !== 7
  if (v === 7) return inR(u, 2, 7)
  if (v === 6) return inR(u, 2, 6)
  if (v === 4) return inR(u, 5, 6)
  return inR(u, 2, 7) // 2·3
}

// 추천 행동: 'hit' | 'stand' | 'double' | 'split'
export function advise(cards, upCard, { canDouble = true, canSplit = false } = {}) {
  const u = up(upCard)
  canDouble = canDouble && cards.length === 2
  if (canSplit && canPair(cards) && pair(valueOf(cards[0]), u)) return 'split'
  const s = score(cards)
  const k = s.soft ? soft(s.total, u) : hard(s.total, u)
  if (k === 'D') return canDouble ? 'double' : 'hit'
  if (k === 'Ds') return canDouble ? 'double' : 'stand'
  return k === 'H' ? 'hit' : 'stand'
}
