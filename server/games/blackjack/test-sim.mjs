// 블랙잭 시뮬레이션 (CASINO.md 6장): 서버 모듈(index.mjs)에 진짜 난수(core/rng)로 한 테이블 3명이 기본 전략대로
// 판을 돌려 하우스 몫이 5장 값(약 0.5%) ±0.3%p 안인지 본다.  node server/games/blackjack/test-sim.mjs [판 수]
// 판 수 × 3명 = 손 수. 판마다 10칩 (짝수라 블랙잭 3:2에 버리는 반 칩이 없음). 같은 슈를 75%까지 이어서 쓴다
// 기다리는 시간(베팅 마감·딜러·결과)은 _advance로 건너뛴다
import assert from 'node:assert/strict'
import * as rng from '../../core/rng.mjs'
import bj, { _advance } from './index.mjs'
import { advise, CUT } from '../../../public/blackjack/rules.mjs'

const ROUNDS = Number(process.argv[2]) || 400_000
const BET = 10, N = 3
const players = Array.from({ length: N }, (_, i) => ({ id: 'u_sim' + i, name: 'sim' + i, chips: 1e15, inPlay: 0, limits: {}, sockets: { size: 1 } }))
const last = new Map()
let staked = 0, returned = 0, paid = 0, shuffles = 0
const count = { blackjack: 0, win: 0, push: 0, lose: 0, bust: 0, dealerBust: 0, double: 0, split: 0, hands: 0 }
const ctx = {
  rng,
  send(p, m) { if (m.t === 'state') last.set(p.id, m); else if (m.t === 'toast') throw new Error('거절됨: ' + m.msg) },
  players: () => players,
  limit: () => true,
  bet(pl, amount) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > pl.chips) return false
    pl.chips -= amount; pl.inPlay += amount; staked += amount; return true
  },
  payout(pl, amount) {
    assert.ok(Number.isSafeInteger(amount) && amount >= 0)
    pl.chips += amount; pl.inPlay = 0; returned += amount; paid++; return true
  },
}

const t0 = performance.now()
for (const p of players) bj.join(p, ctx)
assert.equal(new Set(players.map(p => last.get(p.id).table)).size, 1, '같은 테이블')
for (let r = 0; r < ROUNDS; r++) {
  for (const p of players) bj.message(p, { t: 'bet', amount: BET }, ctx)
  assert.ok(_advance(players[0])) // 베팅 마감 → 딜
  if (last.get(players[0].id).shoe.shuffled) shuffles++
  for (const p of players) {
    for (let m = last.get(p.id), me = m.seats[m.me]; !me.done; m = last.get(p.id), me = m.seats[m.me]) {
      const h = me.hands[me.active]
      const a = advise(h.cards, m.dealer[0], { canDouble: m.actions.double, canSplit: m.actions.split })
      if (a === 'double') count.double++
      if (a === 'split') count.split++
      bj.message(p, { t: 'act', a, seq: m.seq }, ctx)
    }
  }
  assert.ok(_advance(players[0])) // 딜러 차례
  const d = last.get(players[0].id)
  assert.equal(d.phase, 'dealer')
  for (const s of d.seats) if (s) for (const h of s.hands) { count[h.result]++; count.hands++; if (h.dealerBust) count.dealerBust++ }
  assert.ok(_advance(players[0])) // 정산
  assert.ok(_advance(players[0])) // 새 베팅
}
for (const p of players) bj.leave(p, ctx)
const sec = ((performance.now() - t0) / 1000).toFixed(1)
const hands = ROUNDS * N
const edge = (staked - returned) / (hands * BET) // 처음 건 칩 기준 (더블·스플릿 추가분 포함한 손실 ÷ 손 수 × 베팅)
const pct = (n, d = hands) => (n / d * 100).toFixed(2) + '%'

console.log(`판 ${ROUNDS.toLocaleString()} × ${N}명 = ${hands.toLocaleString()} · 건 칩 ${staked.toLocaleString()} (처음 베팅 ${(hands * BET).toLocaleString()}) · 돌려준 칩 ${returned.toLocaleString()} · ${sec}초`)
console.log(`하우스 몫 ${(edge * 100).toFixed(3)}% (목표 약 0.5%, 허용 0.2~0.8%) · 건 칩 전체 기준 ${((staked - returned) / staked * 100).toFixed(3)}%`)
console.log(`손 ${count.hands.toLocaleString()}: 블랙잭 ${pct(count.blackjack, count.hands)} · 이김 ${pct(count.win, count.hands)} (딜러 버스트 ${pct(count.dealerBust, count.hands)}) · 비김 ${pct(count.push, count.hands)} · 짐 ${pct(count.lose, count.hands)} · 버스트 ${pct(count.bust, count.hands)}`)
console.log(`더블 ${pct(count.double)} · 스플릿 ${pct(count.split)} · 다시 섞기 ${shuffles.toLocaleString()}번 (3명이면 한 판에 카드 약 11.5장 → 약 ${Math.round(CUT / 11.5)}판마다, 실제 ${Math.round(ROUNDS / shuffles)}판)`)

assert.equal(paid, hands)
for (const p of players) assert.equal(p.inPlay, 0)
assert.ok(edge >= 0.002 && edge <= 0.008, '하우스 몫이 0.5% ±0.3%p 밖')
console.log('통과')
