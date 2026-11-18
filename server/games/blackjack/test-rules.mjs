// 블랙잭 규칙·서버 모듈 테스트: node server/games/blackjack/test-rules.mjs
// 슈를 정해 둔 카드로 바꿔서(가짜 rng.deck) 판마다 칩이 맞게 오가는지 본다
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import bj from './index.mjs'
import { score, isNatural, settleHand, advise, CUT, SHOE_SIZE, TURN_MS } from '../../../public/blackjack/rules.mjs'

let n = 0
const ok = async (name, fn) => { await fn(); n++; console.log('✓', name) }
mock.timers.enable({ apis: ['setTimeout', 'Date'] })

// 가짜 테이블: cards = 슈 맨 앞 카드들 (딜 순서: 플레이어 · 딜러 업 · 플레이어 · 딜러 숨김, 그다음 히트 순서대로)
let uid = 0
function setup(cards, chips = 1000) {
  const p = { id: 'u_t' + uid++, name: 't', chips, inPlay: 0, limits: {} }
  const sent = [], log = []
  const filler = Array.from({ length: SHOE_SIZE - cards.length }, (_, i) => '23456789'[i % 8] + 's')
  const ctx = {
    rng: { deck: () => [...cards, ...filler], int: () => 0 },
    send(_, m) { sent.push(m) },
    players: () => [p],
    limit: () => true,
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; return true },
    payout(pl, a, round, detail) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; log.push({ a, round, detail }); return true },
  }
  bj.join(p, ctx)
  const last = () => sent.filter(m => m.t === 'state').at(-1)
  return {
    p, ctx, sent, log, last,
    deal: bet => bj.message(p, { t: 'deal', bet }, ctx),
    act: a => bj.message(p, { t: 'act', a, seq: last().seq }, ctx),
    toasts: () => sent.filter(m => m.t === 'toast').map(m => m.msg),
    settle: () => mock.timers.tick(10000), // 결과 연출 기다리기
  }
}

await ok('점수: 에이스는 11 또는 1, 소프트 표시', () => {
  assert.deepEqual(score(['As', 'Kd']), { total: 21, soft: true })
  assert.deepEqual(score(['As', 'Ad', '9c']), { total: 21, soft: true })
  assert.deepEqual(score(['As', 'Ad', '9c', 'Kh']), { total: 21, soft: false })
  assert.deepEqual(score(['Ks', 'Qd', '5c']), { total: 25, soft: false })
  assert.ok(isNatural(['Ah', 'Ts']) && !isNatural(['7h', '7s', '7d']))
})

await ok('블랙잭 3:2 (홀수 베팅의 반 칩은 버림), 스플릿 뒤 21은 1:1', () => {
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10 }, ['9s', '8d']).back, 25)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 5 }, ['9s', '8d']).back, 12)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10, split: true }, ['9s', '8d']).back, 20)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10 }, ['Ah', 'Td']).result, 'push')
})

await ok('딜하면 숨긴 카드는 보내지 않고, 정산은 카드 연출 뒤에', () => {
  const T = setup(['Ts', '9d', '7c', '8h']) // 17 vs 9 + (8)
  T.deal(100)
  const s = T.last()
  assert.equal(s.phase, 'play')
  assert.deepEqual(s.dealer, ['9d', null])
  assert.ok(!JSON.stringify(s).includes('8h'))
  assert.equal(T.p.chips, 900); assert.equal(T.p.inPlay, 100)
  T.act('stand') // 딜러 17 스탠드 → 비김
  const d = T.last()
  assert.equal(d.phase, 'done'); assert.deepEqual(d.dealer, ['9d', '8h']); assert.equal(d.hands[0].result, 'push')
  assert.equal(T.p.inPlay, 100, '연출 전에는 아직 진행 중')
  T.settle()
  assert.equal(T.p.chips, 1000); assert.equal(T.p.inPlay, 0)
  assert.equal(T.log[0].detail.dealer, '9d 8h')
})

await ok('플레이어 블랙잭: 바로 끝나고 1.5배', () => {
  const T = setup(['As', '9d', 'Kc', '8h'])
  T.deal(100)
  assert.equal(T.last().phase, 'done'); assert.equal(T.last().hands[0].result, 'blackjack')
  T.settle(); assert.equal(T.p.chips, 1150)
})

await ok('딜러 피크: A 업카드에 딜러 블랙잭이면 원래 베팅만 잃고 바로 끝', () => {
  const T = setup(['Ts', 'Ad', '9c', 'Kh'])
  T.deal(100)
  assert.equal(T.last().phase, 'done'); assert.equal(T.last().hands[0].result, 'lose')
  T.settle(); assert.equal(T.p.chips, 900)
})

await ok('둘 다 블랙잭이면 비김', () => {
  const T = setup(['As', 'Kd', 'Qc', 'Ah'])
  T.deal(100); T.settle()
  assert.equal(T.last().hands[0].result, 'push'); assert.equal(T.p.chips, 1000)
})

await ok('더블: 베팅 두 배, 한 장만 받고 끝', () => {
  const T = setup(['5s', '9d', '6c', '7h', 'Td', 'Ts']) // 11 vs 16 → 더블 T = 21, 딜러 16 + T = 버스트
  T.deal(100)
  assert.equal(T.last().actions.double, true)
  T.act('double')
  assert.equal(T.p.inPlay, 200)
  const d = T.last()
  assert.equal(d.hands[0].cards.length, 3); assert.equal(d.hands[0].doubled, true); assert.equal(d.hands[0].result, 'win')
  T.settle(); assert.equal(T.p.chips, 1200)
})

await ok('칩이 모자라면 더블·스플릿 못 함', () => {
  const T = setup(['8s', '9d', '8c', '7h'], 150)
  T.deal(100)
  assert.deepEqual(T.last().actions, { hit: true, stand: true, double: false, split: false })
  T.act('double')
  assert.equal(T.p.inPlay, 100); assert.ok(T.toasts().some(m => /칩이 모자라/.test(m)))
})

await ok('스플릿 8·8 → 첫 손 더블(스플릿 뒤 더블), 둘째 손 스탠드, 딜러 버스트', () => {
  // 8 8 vs 6(T): 첫 손 8+3 → 더블 T = 21, 둘째 손 8+T = 18, 딜러 16 + T = 버스트
  const T = setup(['8s', '6d', '8c', 'Th', '3d', 'Ts', 'Tc', 'Td'])
  T.deal(100)
  assert.equal(T.last().actions.split, true)
  T.act('split')
  let s = T.last()
  assert.equal(s.hands.length, 2); assert.deepEqual(s.hands[0].cards, ['8s', '3d']); assert.deepEqual(s.hands[1].cards, ['8c'], '둘째 손 카드는 차례가 올 때')
  assert.equal(s.actions.split, false, '스플릿은 한 번만')
  T.act('double')
  s = T.last()
  assert.equal(s.active, 1); assert.deepEqual(s.hands[1].cards, ['8c', 'Tc'])
  T.act('stand')
  s = T.last()
  assert.equal(s.phase, 'done'); assert.deepEqual(s.hands.map(h => h.result), ['win', 'win'])
  assert.equal(T.p.inPlay, 300)
  T.settle(); assert.equal(T.p.chips, 1300)
})

await ok('에이스 스플릿: 한 장씩만, 21이어도 블랙잭이 아니라 1:1', () => {
  const T = setup(['As', '5d', 'Ac', 'Th', 'Kd', 'Qc', '7s']) // A A vs 5(T): K, Q → 21 · 21, 딜러 15 + 7 = 버스트
  T.deal(100)
  T.act('split')
  const s = T.last()
  assert.equal(s.phase, 'done'); assert.deepEqual(s.hands.map(h => h.cards.length), [2, 2]); assert.deepEqual(s.hands.map(h => h.result), ['win', 'win'])
  T.settle(); assert.equal(T.p.chips, 1200)
})

await ok('히트로 21이면 자동 스탠드, 버스트면 딜러는 숨긴 카드만 뒤집음', () => {
  const T = setup(['Ts', '9d', '6c', '8h', '5d', 'Kh'])
  T.deal(100); T.act('hit')
  assert.equal(T.last().phase, 'done'); assert.equal(T.last().hands[0].result, 'win') // 21 vs 17
  const U = setup(['Ts', '6d', '6c', '8h', 'Kd', 'Qh'])
  U.deal(100); U.act('hit')
  assert.equal(U.last().hands[0].result, 'bust'); assert.deepEqual(U.last().dealer, ['6d', '8h'], '모두 버스트면 딜러는 더 받지 않음')
  U.settle(); assert.equal(U.p.chips, 900)
})

await ok('두 번 누름(지난 seq)은 무시, 판 중 새 딜·이상한 베팅 거절', () => {
  const T = setup(['Ts', '9d', '2c', '8h', '3d', '4c'])
  T.deal(100)
  const seq = T.last().seq
  bj.message(T.p, { t: 'act', a: 'hit', seq }, T.ctx)
  bj.message(T.p, { t: 'act', a: 'hit', seq }, T.ctx) // 같은 화면에서 한 번 더
  assert.equal(T.last().hands[0].cards.length, 3)
  T.deal(100); assert.ok(T.toasts().includes('판이 진행 중이에요.'))
  T.act('stand'); T.settle()
  const chips = T.p.chips
  for (const bad of [0, -5, 1.5, 'abc', 1e20, chips + 1]) T.deal(bad)
  assert.equal(T.p.chips, chips); assert.equal(T.p.inPlay, 0); assert.equal(T.last().phase, 'done')
})

await ok('30초 동안 안 누르면 스탠드', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  T.deal(100)
  assert.ok(T.last().turnMs > 29000)
  mock.timers.tick(TURN_MS - 1); assert.equal(T.last().phase, 'play')
  mock.timers.tick(1); assert.equal(T.last().phase, 'done'); assert.equal(T.last().ev, 'timeout')
  T.settle(); assert.equal(T.p.chips, 1100) // 19 vs 17
})

await ok('판 도중 나가면 남은 손 스탠드 → 딜러까지 끝내고 바로 정산', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  T.deal(100)
  bj.leave(T.p, T.ctx)
  assert.equal(T.p.inPlay, 0); assert.equal(T.p.chips, 1100)
  const U = setup(['Ts', '9d', '9c', '8h'])
  U.deal(100); U.act('stand') // 끝났지만 연출 중
  bj.leave(U.p, U.ctx)
  assert.equal(U.p.inPlay, 0); assert.equal(U.p.chips, 1100)
})

await ok('결과 연출 중 다음 딜을 누르면 지난 판을 먼저 정산', () => {
  const T = setup(['Ts', '9d', '9c', '8h', 'Ts', '9d', '9c', '8h'])
  T.deal(100); T.act('stand')
  T.deal(50)
  assert.equal(T.log.length, 1); assert.equal(T.p.chips, 1100 - 50); assert.equal(T.p.inPlay, 50)
})

await ok('서버를 끌 때 연출 중인 판은 결과대로 정산', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  T.deal(100); T.act('stand')
  bj.shutdown(T.ctx)
  assert.equal(T.p.chips, 1100); assert.equal(T.p.inPlay, 0)
})

await ok(`슈: 312장 중 ${CUT}장 넘게 쓰면 다음 딜 전에 다시 섞음`, () => {
  const T = setup([])
  let shuffled = 0, dealt = 0
  for (let i = 0; i < 200; i++) {
    T.deal(1)
    if (T.last().shoe.shuffled) shuffled++
    while (T.last().phase === 'play') T.act('stand')
    if (!T.last().shoe.shuffled) assert.ok(SHOE_SIZE - T.last().shoe.left <= CUT + 20)
    dealt++
  }
  assert.ok(shuffled >= 2, String(shuffled))
})

await ok('기본 전략 (6덱 S17 DAS) 몇 칸', () => {
  const A = (cards, up, o) => advise(cards, up, { canDouble: true, canSplit: true, ...o })
  assert.equal(A(['Ts', '6d'], 'Kh'), 'hit')
  assert.equal(A(['Ts', '2d'], '4h'), 'stand')
  assert.equal(A(['Ts', '2d'], '3h'), 'hit')
  assert.equal(A(['5s', '6d'], 'Ah'), 'hit')
  assert.equal(A(['5s', '6d'], 'Th'), 'double')
  assert.equal(A(['As', '7d'], '9h'), 'hit')
  assert.equal(A(['As', '7d'], '3h'), 'double')
  assert.equal(A(['As', '7d'], '3h', { canDouble: false }), 'stand')
  assert.equal(A(['As', '7d'], '8h'), 'stand')
  assert.equal(A(['As', '6d'], '2h'), 'hit')
  assert.equal(A(['9s', '9d'], '7h'), 'stand')
  assert.equal(A(['9s', '9d'], '6h'), 'split')
  assert.equal(A(['8s', '8d'], 'Ah'), 'split')
  assert.equal(A(['Ts', 'Kd'], '6h'), 'stand')
  assert.equal(A(['5s', '5d'], '9h'), 'double')
  assert.equal(A(['As', 'Ad'], 'Ah'), 'split')
  assert.equal(A(['As', 'Ad'], 'Ah', { canSplit: false }), 'hit')
  assert.equal(A(['As', '3d', '4c'], '4h'), 'stand') // 소프트 18, 세 장 → 더블 대신 스탠드
})

mock.timers.reset()
console.log(`통과 ${n}개`)
