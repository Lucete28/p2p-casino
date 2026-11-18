// 블랙잭 한 판 (칩·난수와 상관없는 순수 규칙). 서버 모듈(index.mjs)과 시뮬레이션(test-sim.mjs)이 같이 쓴다
// draw() = 슈에서 카드 한 장. 칩이 되는지는 부르는 쪽이 actions()로 보고 ctx.bet을 먼저 한다
import { score, isNatural, canPair, valueOf, settleHand, dealerHits } from '../../../public/blackjack/rules.mjs'

// 판 상태: { bet, hands: [{ cards, bet, done, doubled, split, aces }], dealer: [업카드, 숨긴 카드, ...], active, phase: 'play'|'done', results, back }
export function deal(bet, draw) {
  const p1 = draw(), d1 = draw(), p2 = draw(), d2 = draw() // 플레이어 · 딜러 · 플레이어 · 딜러(숨김)
  const r = { bet, hands: [{ cards: [p1, p2], bet, done: false, doubled: false, split: false, aces: false }], dealer: [d1, d2], active: 0, phase: 'play' }
  r.peek = valueOf(d1) >= 10 // A·10 업카드면 딜러가 블랙잭인지 먼저 확인 (딜러 블랙잭이면 원래 베팅만 잃음)
  if ((r.peek && isNatural(r.dealer)) || isNatural(r.hands[0].cards)) {
    r.hands[0].done = true
    return finish(r, draw)
  }
  return r
}

// 지금 손에서 할 수 있는 것. chips = 더 걸 수 있는 칩 (더블·스플릿은 그 손의 베팅만큼 더 건다)
export function actions(r, chips) {
  if (!r || r.phase !== 'play') return { hit: false, stand: false, double: false, split: false }
  const h = r.hands[r.active]
  return {
    hit: true,
    stand: true,
    double: h.cards.length === 2 && chips >= h.bet,
    split: r.hands.length === 1 && canPair(h.cards) && chips >= h.bet,
  }
}

// 행동 하나. 할 수 없는 행동이면 false (부르는 쪽이 actions로 먼저 확인)
export function act(r, a, draw) {
  if (r.phase !== 'play') return false
  const h = r.hands[r.active]
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
    if (r.hands.length !== 1 || !canPair(h.cards)) return false
    const aces = h.cards[0][0] === 'A'
    const [c1, c2] = h.cards
    // 둘째 손의 두 번째 카드는 그 손 차례가 왔을 때 받는다 (에이스는 한 장씩 바로 받고 끝)
    r.hands = [
      { cards: [c1, draw()], bet: h.bet, done: aces, doubled: false, split: true, aces },
      { cards: aces ? [c2, draw()] : [c2], bet: h.bet, done: aces, doubled: false, split: true, aces },
    ]
    if (score(r.hands[0].cards).total === 21) r.hands[0].done = true
  } else return false
  advance(r, draw)
  return true
}

// 끝난 손을 지나 다음 손으로. 다 끝났으면 딜러 차례
function advance(r, draw) {
  while (r.active < r.hands.length && r.hands[r.active].done) {
    r.active++
    const n = r.hands[r.active]
    if (n && n.cards.length === 1) {
      n.cards.push(draw())
      if (score(n.cards).total === 21) n.done = true
    }
  }
  if (r.active >= r.hands.length) { r.active = r.hands.length - 1; finish(r, draw) }
}

// 남은 손을 모두 스탠드 (나가기·끊김·30초)
export function standAll(r, draw) {
  while (r.phase === 'play') act(r, 'stand', draw)
}

// 딜러 차례와 정산. 플레이어가 모두 버스트거나 첫 판에서 블랙잭이 나왔으면 딜러는 더 받지 않는다
function finish(r, draw) {
  r.phase = 'done'
  const natural = r.hands.length === 1 && isNatural(r.hands[0].cards)
  const alive = r.hands.some(h => score(h.cards).total <= 21)
  if (alive && !natural && !isNatural(r.dealer)) while (dealerHits(r.dealer)) r.dealer.push(draw())
  r.results = r.hands.map(h => settleHand(h, r.dealer))
  r.back = r.results.reduce((a, x) => a + x.back, 0)
  return r
}
