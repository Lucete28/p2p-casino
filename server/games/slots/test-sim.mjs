// 슬롯 시뮬레이션 (CASINO.md 6장): 서버 모듈(index.mjs)에 진짜 난수로 머신마다 1,000만 판을 돌려
// 실제 환급률이 기준값 ±0.3%p 안인지 본다. 기준값: 줄·다이아몬드는 rules.mjs exactRtp(모든 경우를 셈),
// 과일 폭탄(연쇄)·럭키 스타(프리스핀 배수)는 rtpRef(따로 돌린 큰 시뮬레이션).
//   node server/games/slots/test-sim.mjs [판 수] [머신]
// 환급률은 모두의 잭팟을 뺀 머신 몫. 잭팟은 장부(쌓인 2% = 나간 잭팟 + 남은 잭팟·밑돈 - 하우스가 채운 밑돈)를 따로 맞춰 본다.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'slots-sim-'))
const rng = await import('../../core/rng.mjs')
const { default: slots, jackpotState } = await import('./index.mjs')
const { MACHINES, JACKPOT, exactRtp, linesOf, CRASH_U, crashPoint } = await import('../../../public/slots/rules.mjs')

const SPINS = Number(process.argv[2]) || 10_000_000
// 한방형은 1,000만 판으로는 흔들림이 ±0.3%p보다 커서 더 돌린다 (다이아몬드 최고 ×10,000이 약 82만 판에 한 번 → 환급률 1.2%를 혼자 가짐)
const MORE = { diamond: 8 }
const only = process.argv[3]
slots.init()
const jp0 = jackpotState()
let allStaked = 0, allJpWins = 0, allHits = 0

for (const m of Object.values(MACHINES)) {
  if (only && m.id !== only) continue
  if (m.type === 'crash') continue // 크래시는 진짜 시간이 흘러야 해서 아래에서 규칙으로 따로
  const lines = (m.lineChoices || [linesOf(m)]).at(-1)
  const lineBet = 1
  const p = { id: 'u_sim_' + m.id, name: 'sim', chips: 1e15, inPlay: 0, limits: {} }
  let staked = 0, returned = 0, spins = 0, last = null, bonuses = 0, jpWins = 0, jpHits = 0, wins = 0, mystery = 0, sq = 0
  const N = SPINS * (MORE[m.id] || 1)
  const ctx = {
    rng, players: () => [p], broadcast() {}, limit: () => true,
    send(_, msg) { if (msg.t === 'spun') last = msg; else if (msg.t === 'toast') throw new Error('거절됨: ' + msg.msg) },
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; staked += a; return true },
    payout(pl, a) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; returned += a; spins++; return true },
  }
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    slots.message(p, { t: 'spin', machine: m.id, lineBet, lines }, ctx)
    const base = (last.back - (last.jackpot?.win || 0)) / last.total; sq += base * base
    if (last.bonus) bonuses++
    if (last.back > 0) wins++
    if (last.jackpot) { jpHits++; jpWins += last.jackpot.win; if (last.jackpot.kind === 'mystery') mystery++ }
    slots.leave(p, ctx) // 연출을 기다리지 않고 바로 정산 (나가기와 같은 길)
  }
  const sec = ((performance.now() - t0) / 1000).toFixed(1)
  const x = exactRtp(m)
  const want = x.rtp ?? m.rtpRef
  const got = (returned - jpWins) / staked
  console.log(`[${m.name}] 판 ${spins.toLocaleString()} · 건 칩 ${staked.toLocaleString()} · ${sec}초`)
  console.log(`  환급률 ${(got * 100).toFixed(3)}% (기준 ${(want * 100).toFixed(3)}%${x.rtp ? '' : ' 시뮬레이션'}, 허용 ±0.3%p, 잭팟 빼고) · 뭐라도 받은 판 ${(wins / spins * 100).toFixed(1)}%`
    + (m.scatter ? ` · 보너스 ${bonuses.toLocaleString()}번 (이론 ${Math.round(N * x.trigger).toLocaleString()})` : '')
    + ` · 잭팟 ${jpHits}번 (미스터리 ${mystery}, 이론 ${(staked / JACKPOT.odds).toFixed(2)})`
    + ` · 표준오차 ±${(Math.sqrt(sq / N - got * got) / Math.sqrt(N) * 100).toFixed(3)}%p`)
  assert.equal(spins, N)
  assert.equal(p.inPlay, 0)
  assert.ok(Math.abs(got - want) <= 0.003, `${m.id} 환급률이 범위를 벗어남`)
  allStaked += staked; allJpWins += jpWins; allHits += jpHits
}

// 크래시: 판마다 1.03 ~ 20 사이 아무 배수에서 내린다고 치고 (어떤 전략이든 rtp = 103%여야 함)
if (!only || only === 'crash') {
  const m = MACHINES.crash
  let bet = 0, back = 0, boom = 0
  for (let i = 0; i < SPINS; i++) {
    const target = 1.01 + rng.int(1900) / 100
    const c = crashPoint(m, rng.int(CRASH_U))
    bet += 1; if (c >= target) back += target; else boom++
  }
  console.log(`[크래시] 판 ${SPINS.toLocaleString()} · 환급률 ${(back / bet * 100).toFixed(3)}% (기준 ${(m.rtp * 100).toFixed(0)}%, 허용 ±0.3%p) · 터져서 잃은 판 ${(boom / SPINS * 100).toFixed(1)}%`)
  assert.ok(Math.abs(back / bet - m.rtp) <= 0.003, 'crash 환급률이 범위를 벗어남')
}

// 모두의 잭팟 장부: 들어온 2% = 나간 잭팟 + (남은 잭팟 + 밑돈 증가) - 하우스가 채운 밑돈
const j = jackpotState()
const inflow = allStaked * (JACKPOT.contribute + JACKPOT.reserve)
const seeded = allJpWins + (j.pool + j.reserve) - (jp0.pool + jp0.reserve) - inflow
console.log(`[모두의 잭팟] 잭팟 ${allHits}번 · 들어온 돈 ${Math.round(inflow).toLocaleString()} · 나간 잭팟 ${allJpWins.toLocaleString()} · 지금 잭팟 ${Math.floor(j.pool).toLocaleString()} · 하우스가 채운 밑돈 ${Math.round(seeded).toLocaleString()}`)
assert.ok(seeded > -1, '잭팟 장부가 안 맞음 (쌓인 것보다 많이 나감)')
assert.ok(seeded <= allHits * JACKPOT.floor + 1, '하우스 밑돈이 floor × 횟수보다 많음')
console.log('통과')
