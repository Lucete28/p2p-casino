// 슬롯 규칙·서버 모듈 테스트: node server/games/slots/test-rules.mjs
import assert from 'node:assert/strict'
import * as rng from '../../core/rng.mjs'
import slots, { SPIN_MS } from './index.mjs'
import { STRIPS, REEL_LEN, LINES, PAY3, window3, lineWin, checkBet, evaluate, exactRtp, MAX_LINE_BET, teases, TEASE_MS } from '../../../public/slots/rules.mjs'

let n = 0
const ok = (name, fn) => { fn(); n++; console.log('✓', name) }

ok('릴 3개, 24칸, 그림 수가 같다 (세븐 1 · 바 2 · 종 4 · 수박 5 · 레몬 7 · 체리 5)', () => {
  assert.equal(STRIPS.length, 3)
  for (const s of STRIPS) {
    assert.equal(s.length, REEL_LEN)
    const c = s.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {})
    assert.deepEqual(c, { seven: 1, bar: 2, bell: 4, melon: 5, lemon: 7, cherry: 5 })
  }
})

ok('정확한 RTP 95.02% (하우스 몫 5% ±0.3%p)', () => {
  const { rtp } = exactRtp()
  assert.ok(Math.abs(rtp - 0.95) < 0.003, String(rtp))
})

ok('창은 s-1 · s · s+1, 끝에서 처음으로 이어진다', () => {
  const g = window3([0, 23, 12])
  assert.deepEqual(g[0], [STRIPS[0][23], STRIPS[0][0], STRIPS[0][1]])
  assert.deepEqual(g[1], [STRIPS[1][22], STRIPS[1][23], STRIPS[1][0]])
  assert.deepEqual(g[2], [STRIPS[2][11], STRIPS[2][12], STRIPS[2][13]])
})

ok('한 줄 배당: 셋 > 체리 둘 > 체리 하나', () => {
  assert.equal(lineWin('seven', 'seven', 'seven').mult, 777)
  assert.equal(lineWin('cherry', 'cherry', 'cherry').mult, PAY3.cherry)
  assert.equal(lineWin('cherry', 'cherry', 'bar').mult, 4)
  assert.equal(lineWin('cherry', 'bar', 'cherry').mult, 1)
  assert.equal(lineWin('bar', 'cherry', 'cherry'), null)
  assert.equal(lineWin('bell', 'bell', 'bar'), null)
})

ok('베팅 검사', () => {
  assert.deepEqual(checkBet(3, 5), { lineBet: 3, lines: 5, total: 15 })
  assert.deepEqual(checkBet('2', '1'), { lineBet: 2, lines: 1, total: 2 })
  for (const [b, l] of [[0, 5], [1.5, 5], [-1, 1], [1, 2], [1, 0], [NaN, 5], ['x', 3], [MAX_LINE_BET + 1, 1]]) assert.ok(checkBet(b, l).error, `${b} ${l}`)
})

// 777이 가운데 줄에 서는 자리 찾기
const sevenAt = STRIPS.map(s => s.indexOf('seven')), sevens = sevenAt
ok('777 가운데 → 라인 1만 켜도 777배, 대각선은 라인 5개일 때만', () => {
  const r = evaluate(sevenAt, 1, 10)
  assert.equal(r.back, 7770)
  assert.deepEqual(r.wins.map(w => w.line), [0])
  // ↘ 대각선: 첫 릴은 위(s-1), 둘째 가운데, 셋째 아래(s+1)에 세븐
  const diag = [sevenAt[0] + 1, sevenAt[1], sevenAt[2] - 1]
  assert.equal(evaluate(diag, 3, 1).wins.some(w => w.kind === 'seven3'), false)
  const w5 = evaluate(diag, 5, 1).wins.find(w => w.kind === 'seven3')
  assert.equal(w5.line, 3)
})

ok('켠 라인만 본다, 한 줄에 하나만', () => {
  for (let i = 0; i < 2000; i++) {
    const stops = [rng.int(24), rng.int(24), rng.int(24)]
    const g = window3(stops)
    for (const lines of [1, 3, 5]) {
      const r = evaluate(stops, lines, 2)
      let want = 0
      for (let l = 0; l < lines; l++) { const w = lineWin(...LINES[l].map((row, reel) => g[reel][row])); if (w) want += w.mult * 2 }
      assert.equal(r.back, want)
      assert.ok(r.wins.every(w => w.line < lines))
      assert.equal(new Set(r.wins.map(w => w.line)).size, r.wins.length)
    }
  }
})

ok('두근두근: 켠 줄에서 첫 두 릴이 세븐·바·종으로 같을 때만', () => {
  // 세븐이 가운데에 둘: 라인 1만 켜도 두근
  assert.equal(teases([sevens[0], sevens[1], 0], 1), true)
  // 첫 릴 세븐은 위, 둘째는 가운데 (↘ 대각선) → 5줄일 때만
  const d = [sevens[0] + 1, sevens[1], 0]
  assert.equal(teases(d, 3), false)
  assert.equal(teases(d, 5), true)
  // 레몬·체리 둘은 두근 없음
  const lemon = STRIPS.map(s => s.indexOf('lemon')), cherry = STRIPS.map(s => s.indexOf('cherry'))
  assert.equal(window3([lemon[0], lemon[1], 0])[0][1], 'lemon')
  assert.equal(teases([lemon[0], lemon[1], 0], 1), false)
  assert.equal(teases([cherry[0], cherry[1], 0], 1), false)
})

// ---------- 서버 모듈 (가짜 ctx) ----------
function fakeCtx(p) {
  const sent = [], log = []
  const ctx = {
    rng, sent, log,
    send(_, m) { sent.push(m) },
    players: () => [p],
    limit: () => true,
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; return true },
    payout(pl, a, round, detail) { pl.chips += a; pl.inPlay = 0; log.push({ a, round, detail }); return true },
  }
  return ctx
}

ok('스핀: 바로 bet, 릴이 멈춘 뒤 payout, 그사이 다시 돌리기 거절', () => {
  const p = { id: 'u_t1', chips: 100, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  slots.message(p, { t: 'spin', lineBet: 2, lines: 5 }, ctx)
  const spun = ctx.sent.at(-1)
  assert.equal(spun.t, 'spun')
  assert.equal(p.chips, 90); assert.equal(p.inPlay, 10)
  assert.equal(ctx.log.length, 0)
  slots.message(p, { t: 'spin', lineBet: 1, lines: 1 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'toast')
  assert.equal(p.chips, 90)
  slots.leave(p, ctx) // 나가면 정해진 결과대로 바로 정산
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 90 + spun.back)
  assert.equal(ctx.log[0].a, spun.back)
  assert.deepEqual(ctx.log[0].detail.stops, spun.stops)
})

ok('칩이 모자라거나 이상한 베팅은 칩이 그대로', () => {
  const p = { id: 'u_t2', chips: 4, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  slots.message(p, { t: 'spin', lineBet: 1, lines: 5 }, ctx)
  assert.equal(ctx.sent.at(-1).msg, '칩이 모자라요.')
  slots.message(p, { t: 'spin', lineBet: 1, lines: 4 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'toast')
  slots.message(p, { t: 'spin', lineBet: 0.5, lines: 1 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'toast')
  assert.equal(p.chips, 4); assert.equal(p.inPlay, 0)
})

ok('다시 들어오면 마지막 그림, 서버 종료 때 정산', () => {
  const p = { id: 'u_t3', chips: 50, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  slots.message(p, { t: 'spin', lineBet: 1, lines: 3 }, ctx)
  const spun = ctx.sent.at(-1)
  slots.join(p, ctx)
  const hello = ctx.sent.at(-1)
  assert.deepEqual(hello.stops, spun.stops)
  assert.equal(hello.spinning, true)
  slots.shutdown(ctx)
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 47 + spun.back)
})

// payout은 SPIN_MS 뒤 저절로 (두근두근이면 TEASE_MS 더 늦게). 세븐 둘이 가운데 → 두근 판
const p = { id: 'u_t4', chips: 10, inPlay: 0, limits: {} }
const ctx = fakeCtx(p)
slots.message(p, { t: 'spin', lineBet: 1, lines: 1 }, ctx)
const spun = ctx.sent.at(-1)
assert.equal(spun.tease, teases(spun.stops, 1))
const due = SPIN_MS + (spun.tease ? TEASE_MS : 0)
setTimeout(() => assert.equal(p.inPlay, 1, '너무 일찍 정산'), due - 150)
setTimeout(() => {
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 9 + spun.back)
  console.log(`통과 (${n}개)`)
}, due + 150)
