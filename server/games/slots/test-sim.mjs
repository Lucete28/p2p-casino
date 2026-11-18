// 슬롯 시뮬레이션 (CASINO.md 6장): 서버 모듈(index.mjs)에 진짜 난수로 머신마다 1,000만 스핀을 돌려
// 실제 환급률이 이론값(rules.mjs exactRtp) ±0.3%p 안인지 본다.
//   node server/games/slots/test-sim.mjs [스핀 수] [머신]
// 줄은 전부 켜고 줄당 1칩 (메가 잭팟은 잭팟을 다 받는 베팅 100: 줄당 20칩).
// 메가 잭팟은 잭팟을 뺀 기본 게임 환급률을 보고, 잭팟 장부(쌓인 돈 = 나간 잭팟 + 남은 잭팟·밑돈 - 하우스가 채운 밑돈)를 따로 맞춰 본다.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'slots-sim-'))
const rng = await import('../../core/rng.mjs')
const { default: slots, jackpotState } = await import('./index.mjs')
const { MACHINES, exactRtp } = await import('../../../public/slots/rules.mjs')

const SPINS = Number(process.argv[2]) || 10_000_000
const only = process.argv[3]
slots.init()

for (const m of Object.values(MACHINES)) {
  if (only && m.id !== only) continue
  const lines = (m.lineChoices || [m.lines.length]).at(-1)
  const lineBet = m.jackpot ? m.jackpot.fullBet / lines : 1
  const p = { id: 'u_sim_' + m.id, name: 'sim', chips: 1e15, inPlay: 0, limits: {} }
  let staked = 0, returned = 0, spins = 0, last = null, bonuses = 0, jpWins = 0, jpHits = 0, wins = 0
  const ctx = {
    rng, players: () => [p], broadcast() {}, limit: () => true,
    send(_, msg) { if (msg.t === 'spun') last = msg; else if (msg.t === 'toast') throw new Error('거절됨: ' + msg.msg) },
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; staked += a; return true },
    payout(pl, a) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; returned += a; spins++; return true },
  }
  const jp0 = jackpotState()
  const t0 = performance.now()
  for (let i = 0; i < SPINS; i++) {
    slots.message(p, { t: 'spin', machine: m.id, lineBet, lines }, ctx)
    if (last.bonus) bonuses++
    if (last.back > 0) wins++
    if (last.jackpot) { jpHits++; jpWins += last.jackpot.win }
    slots.leave(p, ctx) // 연출을 기다리지 않고 바로 정산 (나가기와 같은 길)
  }
  const sec = ((performance.now() - t0) / 1000).toFixed(1)
  const x = exactRtp(m)
  const want = m.jackpot ? x.rtp - x.jackpot : x.rtp
  const got = (returned - jpWins) / staked
  console.log(`[${m.name}] 스핀 ${spins.toLocaleString()} · 건 칩 ${staked.toLocaleString()} · ${sec}초`)
  console.log(`  환급률 ${(got * 100).toFixed(3)}% (이론 ${(want * 100).toFixed(3)}%${m.jackpot ? ', 잭팟 빼고' : ''}, 허용 ±0.3%p) · 뭐라도 받은 판 ${(wins / spins * 100).toFixed(1)}%`
    + (m.scatter ? ` · 프리스핀 ${bonuses.toLocaleString()}번 (이론 ${Math.round(SPINS * x.trigger).toLocaleString()})` : ''))
  assert.equal(spins, SPINS)
  assert.equal(p.inPlay, 0)
  assert.ok(Math.abs(got - want) <= 0.003, `${m.id} 환급률이 범위를 벗어남`)
  assert.ok(x.rtp < 1, `${m.id} 이론 환급률이 100% 이상`)
  if (m.jackpot) {
    const j = jackpotState(), J = m.jackpot
    const inflow = staked * (J.contribute + J.reserve)
    const seeded = jpWins + (j.pool + j.reserve) - (jp0.pool + jp0.reserve) - inflow // 하우스가 floor까지 채운 밑돈
    console.log(`  잭팟 ${jpHits}번 (이론 ${Math.round(SPINS * x.jpHit)}) · 나간 잭팟 ${jpWins.toLocaleString()} · 지금 잭팟 ${Math.floor(j.pool).toLocaleString()} · 하우스가 채운 밑돈 ${Math.round(seeded).toLocaleString()}`)
    assert.ok(seeded > -1, '잭팟 장부가 안 맞음 (쌓인 것보다 많이 나감)')
    assert.ok(seeded <= jpHits * J.floor + 1, '하우스 밑돈이 floor × 횟수보다 많음')
  }
}
console.log('통과')
