// 블랙잭 한 판 규칙 (칩·난수·시간과 상관없는 순수 함수). 서버 모듈(index.mjs)이 쓴다
// draw() = 테이블 슈에서 카드 한 장. 칩이 되는지는 부르는 쪽이 seatActions()로 보고 ctx.bet을 먼저 한다
//
// 자리(seat) 하나의 판: { hands: [{ cards, bet, done, doubled, split, aces }], active, done }
// 딜러: [업카드, 숨긴 카드, ...]
import { score, isNatural, canPair, valueOf, settleHand, dealerHits } from '../../../public/blackjack/rules.mjs'

const hand = (bet, cards = []) => ({ cards, bet, done: false, doubled: false, split: false, aces: false })

// 첫 딜: 자리 순서대로 한 장씩 → 딜러 업카드 → 다시 자리마다 한 장 → 딜러 숨긴 카드
// seats = 이번 판에 건 자리들 (seat.bet 사용). 돌려줌: { dealer, dealerBJ, cards: 나눈 카드 수 }
export function dealRound(seats, draw) {
  for (const s of seats) { s.hands = [hand(s.bet)]; s.active = 0; s.done = false }
  const dealer = []
  for (let k = 0; k < 2; k++) {
    for (const s of seats) s.hands[0].cards.push(draw())
    dealer.push(draw())
  }
  // 딜러 피크: 업카드가 A·10이면 블랙잭인지 먼저 확인. 블랙잭이면 모두 원래 베팅만 걸린 채 바로 딜러 차례
  const dealerBJ = valueOf(dealer[0]) >= 10 && isNatural(dealer)
  for (const s of seats) if (dealerBJ || isNatural(s.hands[0].cards)) { s.hands[0].done = true; s.done = true }
  return { dealer, dealerBJ, cards: seats.length * 2 + 2 }
}

// 지금 손에서 할 수 있는 것. chips = 더 걸 수 있는 칩 (더블·스플릿은 그 손의 베팅만큼 더 건다)
export function seatActions(s, chips) {
  if (!s || s.done || !s.hands?.length) return { hit: false, stand: false, double: false, split: false }
  const h = s.hands[s.active]
  return {
    hit: true,
    stand: true,
    double: h.cards.length === 2 && chips >= h.bet,
    split: s.hands.length === 1 && canPair(h.cards) && chips >= h.bet,
  }
}

// 행동 하나. 할 수 없는 행동이면 false
export function seatAct(s, a, draw) {
  if (s.done) return false
  const h = s.hands[s.active]
  if (a === 'hit') {
    h.cards.push(draw())
    if (score(h.cards).total >= 21) h.done = true // 21이나 버스트면 자동으로 끝
  } else if (a === 'stand') {
    h.done = true
  } else if (a === 'double') {
    if (h.cards.length !== 2) return false
    h.bet *= 2; h.doubled = true
    h.cards.push(draw())
    h.done = true
  } else if (a === 'split') {
    if (s.hands.length !== 1 || !canPair(h.cards)) return false
    const aces = h.cards[0][0] === 'A'
    const [c1, c2] = h.cards
    // 둘째 손의 두 번째 카드는 그 손 차례가 왔을 때 받는다 (에이스는 한 장씩 바로 받고 끝)
    const a1 = { ...hand(h.bet, [c1, draw()]), split: true, aces, done: aces }
    const a2 = { ...hand(h.bet, aces ? [c2, draw()] : [c2]), split: true, aces, done: aces }
    s.hands = [a1, a2]
    if (score(a1.cards).total === 21) a1.done = true
  } else return false
  advance(s, draw)
  return true
}

// 끝난 손을 지나 다음 손으로. 다 끝났으면 자리 끝
function advance(s, draw) {
  while (s.active < s.hands.length && s.hands[s.active].done) {
    s.active++
    const n = s.hands[s.active]
    if (n && n.cards.length === 1) {
      n.cards.push(draw())
      if (score(n.cards).total === 21) n.done = true
    }
  }
  if (s.active >= s.hands.length) { s.active = s.hands.length - 1; s.done = true }
}

// 남은 손을 모두 스탠드
export function standAll(s, draw) {
  while (!s.done) seatAct(s, 'stand', draw)
}

// 딜러 차례: 버스트·블랙잭이 아닌 손이 하나라도 있으면 17이 될 때까지 받는다 (소프트 17 스탠드)
export function dealerPlay(dealer, seats, draw) {
  const live = seats.some(s => !(s.hands.length === 1 && isNatural(s.hands[0].cards)) && s.hands.some(h => score(h.cards).total <= 21))
  if (live && !isNatural(dealer)) while (dealerHits(dealer)) dealer.push(draw())
}

// 자리 정산: 손마다 결과 + 돌려받을 칩(원금 포함)
export function settleSeat(s, dealer) {
  s.results = s.hands.map(h => settleHand(h, dealer))
  s.back = s.results.reduce((a, x) => a + x.back, 0)
  s.staked = s.hands.reduce((a, h) => a + h.bet, 0)
  return s.back
}
