// 슬롯 시뮬레이션 (CASINO.md 6장): 서버 모듈(index.mjs)에 진짜 난수로 1,000만 스핀을 돌려 하우스 몫이 이론값(약 4.98%) ±0.3%p인지 본다
//   node server/games/slots/test-sim.mjs [스핀 수]
// 스핀마다 5라인 · 라인당 1칩 (777이 777배라 베팅 크기를 섞으면 결과가 많이 흔들림). 라인 수·배팅 크기는 RTP에 영향 없음 (rules.mjs 참고)
import assert from 'node:assert/strict'
import * as rng from '../../core/rng.mjs'
import slots from './index.mjs'
import { exactRtp, REEL_LEN } from '../../../public/slots/rules.mjs'

const SPINS = Number(process.argv[2]) || 10_000_000
const { rtp, hit } = exactRtp()
const EXPECT = 1 - rtp

const p = { id: 'u_sim', name: 'sim', chips: 1e15, inPlay: 0, limits: {} }
let staked = 0, returned = 0, spins = 0, lastSpun = null, lineHits = 0, jackpots = 0
const stopCounts = [0, 1, 2].map(() => new Array(REEL_LEN).fill(0))
const ctx = {
  rng,
  send(_, m) { if (m.t === 'spun') lastSpun = m; else if (m.t === 'toast') throw new Error('거절됨: ' + m.msg) },
  players: () => [p],
  limit: () => true,
  bet(pl, amount) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > pl.chips) return false
    pl.chips -= amount; pl.inPlay += amount; staked += amount; return true
  },
  payout(pl, amount) {
    assert.ok(Number.isSafeInteger(amount) && amount >= 0)
    pl.chips += amount; pl.inPlay = 0; returned += amount; spins++; return true
  },
}

const t0 = performance.now()
for (let i = 0; i < SPINS; i++) {
  slots.message(p, { t: 'spin', lineBet: 1, lines: 5 }, ctx)
  lastSpun.stops.forEach((s, r) => stopCounts[r][s]++)
  lineHits += lastSpun.wins.length
  for (const w of lastSpun.wins) if (w.kind === 'seven3') jackpots++
  slots.leave(p, ctx) // 릴이 멈출 때를 기다리지 않고 바로 정산 (나가기와 같은 길)
}
const edge = (staked - returned) / staked
const sec = ((performance.now() - t0) / 1000).toFixed(1)

console.log(`스핀 ${spins.toLocaleString()} (라인 ${(spins * 5).toLocaleString()}) · 건 칩 ${staked.toLocaleString()} · 돌려준 칩 ${returned.toLocaleString()} · ${sec}초`)
console.log(`하우스 몫 ${(edge * 100).toFixed(3)}% (이론 ${(EXPECT * 100).toFixed(3)}%, 허용 ±0.3%p) · RTP ${(100 - edge * 100).toFixed(3)}%`)
console.log(`라인 당첨률 ${(lineHits / spins / 5 * 100).toFixed(2)}% (이론 ${(hit * 100).toFixed(2)}%) · 777 ${jackpots.toLocaleString()}번 (이론 ${Math.round(spins * 5 / REEL_LEN ** 3).toLocaleString()})`)
const exp = SPINS / REEL_LEN
const chis = stopCounts.map(c => c.reduce((s, x) => s + (x - exp) ** 2 / exp, 0))
console.log(`릴 멈춤 자리 고르기 χ² = ${chis.map(c => c.toFixed(1)).join(' · ')} (자유도 23, 99.9%에서 49.7 미만이면 고름)`)

assert.equal(spins, SPINS)
assert.equal(p.inPlay, 0)
assert.ok(Math.abs(edge - EXPECT) <= 0.003, '하우스 몫이 범위를 벗어남')
assert.ok(Math.abs(EXPECT - 0.05) <= 0.003, '이론 하우스 몫이 5% ±0.3%p가 아님')
if (SPINS >= 100_000) for (const c of chis) assert.ok(c < 49.7, '멈춤 자리가 고르지 않음')
console.log('통과')
