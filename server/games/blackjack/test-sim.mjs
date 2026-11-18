// 블랙잭 시뮬레이션 (CASINO.md 6장): 서버 모듈(index.mjs)에 진짜 난수(core/rng)로 100만 판을 기본 전략(화면의 '추천')대로 돌려
// 하우스 몫이 5장 값(약 0.5%) ±0.3%p 안인지 본다.  node server/games/blackjack/test-sim.mjs [판 수]
// 판마다 10칩 (짝수라 블랙잭 3:2에 버리는 반 칩이 없음). 같은 슈를 75%까지 이어서 쓴다
import assert from 'node:assert/strict'
import * as rng from '../../core/rng.mjs'
import bj from './index.mjs'
import { advise, CUT } from '../../../public/blackjack/rules.mjs'

const ROUNDS = Number(process.argv[2]) || 1_000_000
const BET = 10
const p = { id: 'u_sim', name: 'sim', chips: 1e15, inPlay: 0, limits: {} }
let staked = 0, returned = 0, rounds = 0, last = null, shuffles = 0
const count = { blackjack: 0, win: 0, push: 0, lose: 0, bust: 0, dealerBust: 0, double: 0, split: 0, hands: 0 }
const ctx = {
  rng,
  send(_, m) { if (m.t === 'state') last = m; else if (m.t === 'toast') throw new Error('거절됨: ' + m.msg) },
  players: () => [p],
  limit: () => true,
  bet(pl, amount) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > pl.chips) return false
    pl.chips -= amount; pl.inPlay += amount; staked += amount; return true
  },
  payout(pl, amount) {
    assert.ok(Number.isSafeInteger(amount) && amount >= 0)
    pl.chips += amount; pl.inPlay = 0; returned += amount; rounds++; return true
  },
}

const t0 = performance.now()
bj.join(p, ctx)
for (let i = 0; i < ROUNDS; i++) {
  bj.message(p, { t: 'deal', bet: BET }, ctx) // 지난 판은 여기서 정산된다 (결과 연출을 건너뛰는 길)
  if (last.shoe.shuffled) shuffles++
  while (last.phase === 'play') {
    const h = last.hands[last.active]
    const a = advise(h.cards, last.dealer[0], { canDouble: last.actions.double, canSplit: last.actions.split })
    if (a === 'double') count.double++
    if (a === 'split') count.split++
    bj.message(p, { t: 'act', a, seq: last.seq }, ctx)
  }
  assert.equal(last.phase, 'done')
  for (const h of last.hands) { count[h.result]++; count.hands++; if (h.dealerBust) count.dealerBust++ }
}
bj.leave(p, ctx) // 마지막 판 정산
const sec = ((performance.now() - t0) / 1000).toFixed(1)
const edge = (staked - returned) / (rounds * BET) // 처음 건 칩 기준 (더블·스플릿 추가분 포함한 손실 ÷ 판 수 × 베팅)
const pct = (n, d = rounds) => (n / d * 100).toFixed(2) + '%'

console.log(`판 ${rounds.toLocaleString()} · 건 칩 ${staked.toLocaleString()} (처음 베팅 ${(rounds * BET).toLocaleString()}) · 돌려준 칩 ${returned.toLocaleString()} · ${sec}초`)
console.log(`하우스 몫 ${(edge * 100).toFixed(3)}% (목표 약 0.5%, 허용 0.2~0.8%) · 건 칩 전체 기준 ${((staked - returned) / staked * 100).toFixed(3)}%`)
console.log(`손 ${count.hands.toLocaleString()}: 블랙잭 ${pct(count.blackjack, count.hands)} · 이김 ${pct(count.win, count.hands)} (딜러 버스트 ${pct(count.dealerBust, count.hands)}) · 비김 ${pct(count.push, count.hands)} · 짐 ${pct(count.lose, count.hands)} · 버스트 ${pct(count.bust, count.hands)}`)
console.log(`더블 ${pct(count.double)} · 스플릿 ${pct(count.split)} · 다시 섞기 ${shuffles.toLocaleString()}번 (한 판에 카드 약 5.4장 → 약 ${Math.round(CUT / 5.4)}판마다, 실제 ${Math.round(rounds / shuffles)}판)`)

assert.equal(rounds, ROUNDS)
assert.equal(p.inPlay, 0)
assert.ok(edge >= 0.002 && edge <= 0.008, '하우스 몫이 0.5% ±0.3%p 밖')
console.log('통과')
