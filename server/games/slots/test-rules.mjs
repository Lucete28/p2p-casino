// 슬롯 규칙·서버 모듈 테스트: node server/games/slots/test-rules.mjs
// 모두의 잭팟 파일은 임시 폴더에 쓴다 (DATA_DIR)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'slots-test-'))
const rng = await import('../../core/rng.mjs')
const { default: slots, SPIN_MS, FS_MS, jackpotState } = await import('./index.mjs')
const R = await import('../../../public/slots/rules.mjs')
const { MACHINES, JACKPOT, jackpotWeight, windowOf, lineWin, gemWin, waysWins, cascade, freeSpins, checkBet, linesOf, evaluate, exactRtp, teases, TEASE_MS, MAX_LINE_BET, CRASH_U, crashPoint, crashMultAt, crashTimeFor, SAFE_HALF, maxBackPerLineBet, maxLineBet } = R

let n = 0
const ok = (name, fn) => { fn(); n++; console.log('✓', name) }
const M = MACHINES
const at = (m, r, sym) => m.strips[r].indexOf(sym) // 그 그림이 가운데(s)에 오는 멈춤 자리
// 창 세 칸에 별이 없는 멈춤 자리 (럭키 스타)
const noStar = (m, r) => m.strips[r].findIndex((_, i) => [i - 1, i, i + 1].every(k => m.strips[r][(k + m.strips[r].length) % m.strips[r].length] !== 'star'))

const SLOTS = Object.values(M).filter(m => m.reels > 0)
ok('머신 다섯 대 (슬롯 넷 + 크래시), 종류·릴·줄 모양이 맞다', () => {
  assert.deepEqual(Object.keys(M), ['classic', 'diamond', 'fruit5', 'lucky', 'crash'])
  assert.deepEqual(Object.values(M).map(m => m.type), ['lines', 'gem', 'cascade', 'lines', 'crash'])
  for (const m of SLOTS) {
    assert.equal(m.strips.length, m.reels, m.id)
    for (const l of m.lines || []) { assert.equal(l.length, m.reels); assert.ok(l.every(r => r >= 0 && r <= 2)) }
    for (const st of m.strips) assert.ok(st.every(s => R.SYMBOLS[s]), m.id + ' 모르는 그림')
  }
  assert.equal(M.diamond.lines.length, 1); assert.equal(M.lucky.lines.length, 10); assert.equal(M.fruit5.rows, 4)
  assert.ok(M.diamond.mstrip.every(s => /^x\d+$/.test(s)))
})

ok('클래식 띠는 처음 그대로 (세븐 1 · 바 2 · 종 4 · 수박 5 · 레몬 7 · 체리 5)', () => {
  assert.equal(M.classic.strips[0].join(','), 'cherry,lemon,bell,lemon,melon,cherry,lemon,bar,melon,lemon,cherry,bell,seven,lemon,melon,cherry,bell,lemon,bar,melon,cherry,lemon,bell,melon')
  for (const s of M.classic.strips) assert.deepEqual(s.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {}), { seven: 1, bar: 2, bell: 4, melon: 5, lemon: 7, cherry: 5 })
})

ok('다른 머신의 띠: 그림 수가 릴마다 같고, 별은 릴마다 하나', () => {
  for (const m of [M.diamond, M.fruit5, M.lucky]) {
    const counts = m.strips.map(s => JSON.stringify(Object.entries(s.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})).sort()))
    assert.equal(new Set(counts).size, 1, m.id)
    assert.notEqual(m.strips[0].join(), m.strips[1].join(), m.id + ' 릴이 다 같음')
  }
  for (const st of M.lucky.strips) assert.equal(st.filter(s => s === 'star').length, 1)
})

ok('환급률: 슬롯 네 대 기본 102.5% ~ 104%, 크래시 100% (운영자 결정: 기본 약 103% + 모두의 잭팟 2% = 약 105%)', () => {
  assert.equal(exactRtp(M.crash).rtp, 1.00) // 크래시는 100% 넘으면 안 됨 (아래 '위험 없이 이기는 자동 내리기 없음')
  const want = { classic: 1.0352, diamond: 1.0367 }
  for (const m of Object.values(M)) {
    if (m.type === 'crash') continue
    const rtp = exactRtp(m).rtp ?? m.rtpRef
    assert.ok(rtp > 1.025 && rtp <= 1.04, `${m.id} ${rtp}`)
    if (want[m.id]) assert.ok(Math.abs(rtp - want[m.id]) < 0.0005, `${m.id} ${rtp} (배당을 바꿨으면 want도 고치기)`)
  }
  assert.ok(M.fruit5.rtpRef && M.lucky.rtpRef, '연쇄·프리스핀은 시뮬레이션 값이 있어야 함')
  assert.equal(JACKPOT.contribute + JACKPOT.reserve, 0.02)
})

ok('정확한 계산이 모든 경우를 직접 센 것과 같다 (클래식 · 다이아몬드)', () => {
  for (const m of [M.classic]) {
    const L = m.strips[0].length
    let sum = 0, cnt = 0
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let c = 0; c < L; c++) { sum += evaluate(m, [a, b, c], 5, 1).back; cnt++ }
    assert.ok(Math.abs(sum / cnt / 5 - exactRtp(m).rtp) < 1e-9, m.id)
  }
  const d = M.diamond, L = d.strips[0].length, ML = d.mstrip.length
  let sum = 0, cnt = 0
  for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let c = 0; c < L; c++) for (let x = 0; x < ML; x++) { sum += evaluate(d, [a, b, c, x], 1, 1).back; cnt++ }
  assert.ok(Math.abs(sum / cnt - exactRtp(d).rtp) < 1e-9, `diamond ${sum / cnt}`)
})

ok('클래식 배당: 셋 > 체리 둘 > 체리 하나', () => {
  const m = M.classic
  assert.deepEqual(lineWin(m, ['seven', 'seven', 'seven']), { kind: 'seven3', n: 3, mult: 777 })
  assert.equal(lineWin(m, ['cherry', 'cherry', 'bar']).mult, 7)
  assert.equal(lineWin(m, ['cherry', 'bar', 'cherry']).mult, 1)
  assert.equal(lineWin(m, ['bar', 'cherry', 'cherry']), null)
})

ok('다이아몬드: 다이아는 와일드, 섞일 때마다 ×2, 배수 릴을 곱함', () => {
  const d = M.diamond
  assert.equal(gemWin(d, ['ruby', 'ruby', 'ruby']).mult, 40)
  assert.equal(gemWin(d, ['ruby', 'diamond', 'ruby']).mult, 80)
  assert.equal(gemWin(d, ['diamond', 'ruby', 'diamond']).mult, 160)
  assert.equal(gemWin(d, ['diamond', 'diamond', 'diamond']).mult, 1000)
  assert.equal(gemWin(d, ['diamond', 'blank', 'diamond']).mult, 6)
  assert.equal(gemWin(d, ['blank', 'diamond', 'blank']).mult, 1)
  assert.equal(gemWin(d, ['ruby', 'sapphire', 'emerald']).mult, 1)
  assert.equal(gemWin(d, ['ruby', 'sapphire', 'diamond']).mult, 2) // 섞임 + 다이아 → ×2
  assert.equal(gemWin(d, ['ruby', 'blank', 'ruby']), null)
  const stops = [at(d, 0, 'ruby'), at(d, 1, 'diamond'), at(d, 2, 'ruby'), d.mstrip.indexOf('x5')]
  const r = evaluate(d, stops, 1, 3)
  assert.equal(r.mreel.value, 5)
  assert.equal(r.back, 3 * 80 * 5)
  assert.equal(teases(d, stops, 1), true) // 당첨이면 배수 릴 두근두근
})

ok('과일 폭탄: 웨이 = 릴마다 그 과일 칸 수의 곱, 맨 왼쪽부터 3릴 이상', () => {
  const f = M.fruit5
  const g = [['seven', 'lemon', 'seven', 'plum'], ['seven', 'grape', 'grape', 'grape'], ['lemon', 'seven', 'orange', 'orange'], ['seven', 'seven', 'seven', 'bar'], ['plum', 'plum', 'plum', 'plum']]
  const w = waysWins(f, g)
  const s = w.find(x => x.sym === 'seven')
  assert.equal(s.n, 4); assert.equal(s.ways, 2 * 1 * 1 * 3); assert.equal(s.mult, 60)
  assert.equal(s.cells.length, 2 + 1 + 1 + 3)
  assert.ok(!w.some(x => x.sym === 'plum'), '맨 왼쪽에 없으면 안 됨')
  assert.ok(!w.some(x => x.sym === 'grape'), '두 릴만 이어지면 안 됨')
})

ok('과일 폭탄: 처음 보이는 그림(화면 app.js)에는 당첨이 없다', () => {
  assert.equal(waysWins(M.fruit5, windowOf(M.fruit5, [3, 10, 17, 24, 31])).length, 0)
})

ok('과일 폭탄 연쇄: 맞은 칸이 터지고, 새 과일이 위에서, 연쇄마다 ×1·×2·×3·×5', () => {
  const f = M.fruit5
  let k = 0
  const draw = r => f.strips[r][(k++ * 7) % f.strips[r].length]
  let multi = 0
  for (let t = 0; t < 400; t++) {
    const stops = f.strips.map(s => rng.int(s.length))
    const c = cascade(f, stops, 2, draw)
    assert.deepEqual(c.grid, windowOf(f, stops))
    let grid = c.grid, sum = 0
    c.steps.forEach((s, i) => {
      assert.deepEqual(s.grid, grid)
      assert.equal(s.chain, f.chain[Math.min(i, 3)])
      assert.equal(s.pay, s.wins.reduce((a, w) => a + 2 * w.mult * w.ways * s.chain, 0))
      grid = grid.map((col, r) => { assert.equal(s.drops[r].length, s.removed[r].length); return [...s.drops[r], ...col.filter((_, kk) => !s.removed[r].includes(kk))] })
      sum += s.pay
    })
    if (c.steps.length > 1) multi++
    assert.equal(c.back, sum)
    assert.deepEqual(c.final, grid)
    assert.equal(waysWins(f, grid).length, 0, '끝난 그림엔 당첨이 없어야 함')
  }
  assert.ok(multi > 0, '연쇄가 한 번은 나와야 함')
})

ok('럭키 스타 프리스핀: 별이 뜰 때마다 배수 +별 수, 별 셋이면 +3번, 최대 50번', () => {
  const l = M.lucky
  const star3 = [0, 1, 2, 3, 4].map(r => r < 3 ? at(l, r, 'star') : noStar(l, r))
  const star1 = [0, 1, 2, 3, 4].map(r => r < 1 ? at(l, r, 'star') : noStar(l, r))
  const none = [0, 1, 2, 3, 4].map(r => noStar(l, r))
  const stars = st => windowOf(l, st).flat().filter(s => s === 'star').length
  assert.equal(stars(star3), 3); assert.equal(stars(star1), 1); assert.equal(stars(none), 0)
  const seq = [star1, none, star3]
  let i = 0
  const f = freeSpins(l, 10, 1, () => seq[i++] || none)
  assert.equal(f.spins.length, 8 + 3)
  assert.deepEqual(f.spins.slice(0, 4).map(s => s.mult), [2, 2, 5, 5])
  assert.equal(f.spins[2].more, 3)
  for (const s of f.spins) assert.equal(s.back, evaluate(l, s.stops, 10, 1, s.mult).back)
  assert.equal(f.total, f.spins.reduce((a, s) => a + s.back, 0))
  const forever = freeSpins(l, 10, 1, () => star3) // 계속 다시 걸려도 50번에서 끝
  assert.equal(forever.spins.length, 50)
})

ok('베팅 검사: 클래식 줄 1·3·5, 다이아 1, 과일 폭탄 25, 나머지는 줄 전부', () => {
  assert.deepEqual(checkBet(M.classic, 3, 5), { lineBet: 3, lines: 5, total: 15 })
  assert.deepEqual(checkBet(M.diamond, 7, 1), { lineBet: 7, lines: 1, total: 7 })
  assert.deepEqual(checkBet(M.fruit5, 2, 25), { lineBet: 2, lines: 25, total: 50 })
  assert.equal(linesOf(M.lucky), 10)
  assert.ok(checkBet(M.fruit5, 1, 20).error)
  for (const [b, l] of [[0, 5], [1.5, 5], [-1, 1], [1, 2], [NaN, 5], ['x', 3], [maxLineBet(M.classic) + 1, 5]]) assert.ok(checkBet(M.classic, b, l).error, `${b} ${l}`)
})

ok('#규모 줄당 베팅 상한: 머신마다 이론상 최대 지급 × 상한이 안전한 정수의 절반 안', () => {
  for (const m of Object.values(M)) {
    const max = maxLineBet(m), lines = (m.lineChoices || [linesOf(m)]).at(-1)
    assert.ok(Number.isSafeInteger(max * maxBackPerLineBet(m)) && max * maxBackPerLineBet(m) <= SAFE_HALF, m.id)
    assert.ok(!checkBet(m, max, lines).error, `${m.id} 상한은 됨`)
    assert.ok(checkBet(m, max + 1, lines).error, `${m.id} 상한+1은 안 됨`)
  }
  assert.equal(MAX_LINE_BET, Math.min(...Object.values(M).map(maxLineBet)))
  // 실제로 나온 지급이 경계를 넘지 않는지 (머신마다 2만 판, 줄당 1)
  const randStops = m => m.strips.map(st => rng.int(st.length)).concat(m.mstrip ? [rng.int(m.mstrip.length)] : [])
  for (const m of SLOTS) {
    const lines = (m.lineChoices || [linesOf(m)]).at(-1)
    for (let i = 0; i < 20000; i++) {
      const r = evaluate(m, randStops(m), lines, 1, 1, rr => m.strips[rr][rng.int(m.strips[rr].length)])
      const back = r.back + (r.bonus ? freeSpins(m, lines, 1, () => randStops(m)).total : 0)
      assert.ok(back <= maxBackPerLineBet(m), `${m.id} ${back}`)
    }
  }
})

ok('크래시: 터지는 배수 P(≥x) = 1/x (언제 내려도 100%), 시간과 배수', () => {
  const c = M.crash
  for (const x of [1.01, 1.04, 1.5, 2, 3.33, 10, 100]) {
    const n = Math.ceil(CRASH_U - CRASH_U * 1.00 / x) // 이 n부터 위로는 모두 x 이상
    assert.ok(crashPoint(c, n) >= x, `${x} ${crashPoint(c, n)}`)
    assert.ok(crashPoint(c, n - 1) < x, `${x} 바로 아래`)
    assert.ok(Math.abs((CRASH_U - n) / CRASH_U - 1.00 / x) < 1e-8) // 확률 1/x
  }
  assert.equal(crashPoint(c, 0), 1.00) // 시작하자마자(×1.00) 터질 수 있음
  assert.equal(crashPoint(c, CRASH_U - 1), c.max)
  for (const x of [1.01, 2, 7.77, 50]) {
    const t = crashTimeFor(c, x)
    assert.ok(crashMultAt(c, t) >= x && crashMultAt(c, t - 1) < x, `${x}`)
  }
})

ok('크래시: 위험 없이 이기는 자동 내리기 없음 (어떤 배수에 걸어도 기댓값 ≤ 100%, 질 확률 > 0)', () => {
  // 103%일 때는 ×1.03 아래로 안 터져서, 자동 내리기 ×1.02면 매판 +2%였다 (2026-11-19 로비 세션이 찾아 고침)
  const c = M.crash
  assert.ok(c.rtp <= 1, '크래시 rtp는 1 이하여야 함')
  for (let x = 1.01; x <= 3; x = Math.round((x + 0.01) * 100) / 100) {
    const n = Math.ceil(CRASH_U - CRASH_U * c.rtp / x) // 이 n 아래면 x 전에 터짐
    const pWin = (CRASH_U - n) / CRASH_U
    assert.ok(pWin < 1, `×${x}에 걸면 지는 경우가 있어야 함`)
    assert.ok(x * pWin <= 1 + 1e-9, `×${x} 자동 내리기 기댓값 ${x * pWin}`)
  }
  // 약 1%는 시작하자마자 터짐
  const first = Math.ceil(CRASH_U - CRASH_U / 1.01)
  assert.ok(crashPoint(c, first - 1) === 1 && Math.abs(first / CRASH_U - 0.0099) < 1e-3)
})

ok('두근두근: 마지막 릴만 남았을 때 큰 그림·별', () => {
  const c = M.classic
  assert.equal(teases(c, [at(c, 0, 'seven'), at(c, 1, 'seven'), 0], 1), true)
  assert.equal(teases(c, [at(c, 0, 'lemon'), at(c, 1, 'lemon'), 0], 1), false)
  const l = M.lucky
  assert.equal(teases(l, [at(l, 0, 'star'), at(l, 1, 'star'), noStar(l, 2), noStar(l, 3), 0], 10), true)
  assert.equal(teases(M.fruit5, [0, 0, 0, 0, 0], 25), false)
})

// ---------- 서버 모듈 (가짜 ctx) ----------
function fakeCtx(...players) {
  const sent = [], log = [], all = []
  return {
    rng, sent, log, all,
    send(p, m) { sent.push(m); all.push([p.id, m]) },
    broadcast(list, m) { for (const p of list) all.push([p.id, m]) },
    players: () => players,
    limit: () => true,
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; return true },
    payout(pl, a, round, detail) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; log.push({ a, round, detail }); return true },
  }
}
const noMystery = { ...rng, int: nMax => nMax === JACKPOT.odds ? JACKPOT.odds - 1 : rng.int(nMax) } // 미스터리 잭팟이 안 나오게
slots.init()

ok('스핀: 바로 bet, 정산은 나중, 그사이 다시 돌리기 거절', () => {
  const p = { id: 'u_t1', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: noMystery }
  slots.message(p, { t: 'spin', lineBet: 2, lines: 5 }, ctx) // machine 없으면 클래식 (옛 화면)
  const spun = ctx.sent.at(-1)
  assert.equal(spun.t, 'spun'); assert.equal(spun.machine, 'classic')
  assert.equal(p.chips, 90); assert.equal(p.inPlay, 10)
  slots.message(p, { t: 'spin', machine: 'diamond', lineBet: 1, lines: 1 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'toast')
  slots.leave(p, ctx)
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 90 + spun.back)
  assert.equal(ctx.log[0].detail.machine, 'classic')
})

ok('없는 머신·이상한 베팅·칩 모자람은 칩 그대로', () => {
  const p = { id: 'u_t2', chips: 24, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  for (const d of [{ machine: 'nope', lineBet: 1, lines: 5 }, { machine: 'fruit5', lineBet: 1, lines: 25 }, { machine: 'fruit5', lineBet: 1, lines: 20 }, { machine: 'classic', lineBet: 0.5, lines: 1 }]) {
    slots.message(p, { t: 'spin', ...d }, ctx)
    assert.equal(ctx.sent.at(-1).t, 'toast', JSON.stringify(d))
  }
  assert.equal(p.chips, 24); assert.equal(p.inPlay, 0)
})

ok('모든 머신 1,000판: 칩이 맞게 오가고 back = 첫 화면 + 프리스핀 + 잭팟 (크래시는 아래 따로)', () => {
  for (const id of Object.keys(M).filter(id => id !== 'crash')) {
    const m = M[id], lines = (m.lineChoices || [linesOf(m)]).at(-1)
    const p = { id: 'u_all_' + id, chips: 1e9, inPlay: 0, limits: {} }
    const ctx = fakeCtx(p)
    for (let i = 0; i < 1000; i++) {
      const before = p.chips
      slots.message(p, { t: 'spin', machine: id, lineBet: 1, lines }, ctx)
      const s = ctx.sent.at(-1)
      assert.equal(s.t, 'spun')
      const fs = s.bonus ? s.bonus.total : 0, jw = s.jackpot ? s.jackpot.win : 0
      assert.equal(s.back, s.base + fs + jw)
      if (m.type === 'cascade') assert.equal(s.base, (s.steps || []).reduce((a, x) => a + x.pay, 0))
      if (m.type === 'gem') assert.equal(s.stops.length, 4)
      slots.message(p, { t: 'skip' }, ctx)
      assert.equal(p.inPlay, 0)
      assert.equal(p.chips, before - s.total + s.back)
    }
  }
})

ok('모두의 잭팟: 어느 머신이든 2% 쌓이고, 미스터리로 터지면 전부, 파일에 저장', () => {
  const p = { id: 'u_jp', name: '잭팟테스트', chips: 1e9, inPlay: 0, limits: {} }
  const q = { id: 'u_jp2', chips: 1e9, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p, q), rng: noMystery }
  // 쌓임: 클래식 베팅 50 → 잭팟 0.75 + 밑돈 0.25
  const a = jackpotState()
  slots.message(p, { t: 'spin', machine: 'classic', lineBet: 10, lines: 5 }, ctx); slots.message(p, { t: 'skip' }, ctx)
  const b = jackpotState()
  assert.ok(Math.abs(b.pool - a.pool - 50 * JACKPOT.contribute) < 1e-9 && Math.abs(b.reserve - a.reserve - 50 * JACKPOT.reserve) < 1e-9)
  // 미스터리: 과일 폭탄에서 터지게
  const mystery = { ...rng, int: nMax => nMax === JACKPOT.odds ? 0 : rng.int(nMax) }
  const pool = jackpotState().pool + 25 * JACKPOT.contribute
  slots.message(p, { t: 'spin', machine: 'fruit5', lineBet: 1, lines: 25 }, { ...ctx, rng: mystery })
  const s = ctx.sent.at(-1)
  assert.equal(s.jackpot.kind, 'mystery')
  assert.equal(s.jackpot.win, Math.floor(pool))
  slots.message(p, { t: 'skip' }, ctx)
  assert.ok(ctx.all.some(([id, m]) => id === 'u_jp2' && m.t === 'jackpot' && m.last?.win === s.jackpot.win && m.last.machine === 'fruit5'), '다른 사람에게도 알림')
  assert.ok(jackpotState().pool >= JACKPOT.floor)
  const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR, 'slots-jackpot.json'), 'utf8'))
  assert.equal(saved.last.name, '잭팟테스트')
})

ok('모두의 잭팟 확률: 드물게 (1억 분의 베팅), 확률에 넣는 베팅은 1만 칩까지만', () => {
  // 운영자 결정 2026-11-19 "너무 자주 터진다" (만~십만 칩씩 걸면 1분·5스핀마다 터졌음)
  assert.equal(JACKPOT.odds, 100_000_000)
  assert.equal(JACKPOT.capBet, 10_000)
  assert.equal(jackpotWeight(500), 500)
  assert.equal(jackpotWeight(10_000), 10_000)
  assert.equal(jackpotWeight(100_000), 10_000) // 십만 칩을 걸어도 1만 칩 확률 (1/10,000)
  // 서버: 10만 칩 베팅에서 뽑은 수가 1만이면 안 터지고, 9,999면 터짐
  for (const [n, hit] of [[10_000, false], [9_999, true]]) {
    const p = { id: 'u_cap' + n, name: '상한', chips: 1e9, inPlay: 0, limits: {} }
    const ctx = { ...fakeCtx(p), rng: { ...rng, int: nMax => nMax === JACKPOT.odds ? n : noMystery.int(nMax) } }
    slots.message(p, { t: 'spin', machine: 'classic', lineBet: 20_000, lines: 5 }, ctx) // 한 판 10만 칩
    assert.equal(!!ctx.sent.at(-1).jackpot, hit, `n=${n}`)
    slots.message(p, { t: 'skip' }, ctx)
  }
})

ok('#규모 모두의 잭팟 적립도 1만 칩까지만 (1억 베팅이어도 150 + 50)', () => {
  const p = { id: 'u_big', name: '큰손', chips: 1e12, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: noMystery }
  const a = jackpotState()
  slots.message(p, { t: 'spin', machine: 'crash', lineBet: 100_000_000, lines: 1 }, ctx) // 1억
  assert.equal(ctx.sent.at(-1).t, 'crashStart')
  const b = jackpotState()
  assert.ok(Math.abs(b.pool - a.pool - 10_000 * JACKPOT.contribute) < 1e-6 && Math.abs(b.reserve - a.reserve - 10_000 * JACKPOT.reserve) < 1e-6)
  slots.leave(p, ctx)
  assert.equal(p.inPlay, 0)
})

ok('#규모 잔액이 아주 크면: 받을 수 있는 최대를 더해 넘칠 베팅은 시작 전에 막음, 되는 베팅은 정상', () => {
  const big = Number.MAX_SAFE_INTEGER - 1e9 // 약 9,007조
  const p = { id: 'u_huge', name: '아주 큰손', chips: big, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: noMystery }
  slots.message(p, { t: 'spin', machine: 'classic', lineBet: 1_000_000, lines: 5 }, ctx) // 최대 3,885 × 100만 = 39억 > 10억 여유
  assert.equal(ctx.sent.at(-1).t, 'toast'); assert.equal(p.chips, big); assert.equal(p.inPlay, 0)
  slots.message(p, { t: 'spin', machine: 'classic', lineBet: 1, lines: 5 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'spun')
  slots.message(p, { t: 'skip' }, ctx)
  assert.ok(Number.isSafeInteger(p.chips) && p.inPlay === 0)
})

ok('다시 들어오면 머신별 마지막 그림, 서버 종료 때 정산하고 잭팟 저장', () => {
  const p = { id: 'u_t3', chips: 500, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: noMystery }
  slots.message(p, { t: 'spin', machine: 'diamond', lineBet: 20, lines: 1 }, ctx)
  const spun = ctx.sent.at(-1)
  slots.join(p, ctx)
  const hello = ctx.sent.at(-1)
  assert.deepEqual(hello.stops.diamond, spun.stops)
  assert.equal(hello.spinning, true)
  assert.ok(hello.jackpot.pool >= JACKPOT.floor)
  slots.shutdown(ctx)
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 480 + spun.back)
  assert.ok(existsSync(join(process.env.DATA_DIR, 'slots-jackpot.json')))
})

// ---------- 시간이 걸리는 것들 (진짜 타이머) ----------
const waits = []
const later = (ms, fn) => waits.push(new Promise((res, rej) => setTimeout(() => { try { fn(); res() } catch (e) { rej(e) } }, ms)))

// 정산 시간: 두근두근이면 TEASE_MS, 프리스핀이면 연출 시간만큼 늦게
{
  const p = { id: 'u_t4', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: noMystery }
  const l = M.lucky
  const st = [0, 1, 2, 3, 4].map(r => r < 3 ? at(l, r, 'star') : noStar(l, r))
  let k = 0
  slots.message(p, { t: 'spin', machine: 'lucky', lineBet: 1, lines: 10 }, { ...ctx, rng: { ...noMystery, int: nMax => (nMax === l.strips[0].length && k < 5 ? st[k++] : noMystery.int(nMax)) } })
  const spun = ctx.sent.at(-1)
  assert.ok(spun.bonus && spun.tease)
  const due = SPIN_MS + TEASE_MS + FS_MS.intro + spun.bonus.spins.length * FS_MS.spin + FS_MS.outro
  later(due - 200, () => assert.equal(p.inPlay, 10, '너무 일찍 정산'))
  later(due + 200, () => { assert.equal(p.inPlay, 0); assert.equal(p.chips, 90 + spun.back); console.log(`✓ 프리스핀 판(${spun.bonus.spins.length}번)은 연출(${(due / 1000).toFixed(1)}초)이 끝난 뒤 정산`) })
}

// 크래시: 터질 배수를 정해 놓고 (n 고정)
const crashRng = c => ({ ...noMystery, int: nMax => nMax === CRASH_U ? Math.ceil(CRASH_U - CRASH_U / c) : noMystery.int(nMax) })
{ // 바로 내리기 → ×1.00, 터질 배수는 안 알려 줌 (내린 뒤에 알려 줌)
  const p = { id: 'u_c1', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: crashRng(5) }
  slots.message(p, { t: 'spin', machine: 'crash', lineBet: 20, lines: 1 }, ctx)
  const st = ctx.sent.at(-1)
  assert.equal(st.t, 'crashStart'); assert.equal(p.chips, 80); assert.equal(p.inPlay, 20)
  assert.ok(!('at' in st) && !('c' in st) && !JSON.stringify(st).includes('"5"'), '터질 배수가 새면 안 됨')
  slots.message(p, { t: 'crashOut' }, ctx)
  const out = ctx.sent.at(-1)
  assert.equal(out.t, 'crashCashed'); assert.equal(out.mult, 1); assert.equal(p.chips, 100); assert.equal(p.inPlay, 0)
  slots.message(p, { t: 'crashOut' }, ctx) // 두 번 눌러도 한 번만
  assert.equal(p.chips, 100)
  console.log('✓ 크래시: 바로 내리면 ×1.00, 터질 배수는 시작할 때 안 보냄')
}
{ // 시작하자마자 ×1.00에서 터짐 → 건 칩 잃음 (자동 내리기 ×1.01을 걸어도)
  const p = { id: 'u_c2', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: { ...noMystery, int: nMax => nMax === CRASH_U ? 0 : noMystery.int(nMax) } }
  slots.message(p, { t: 'spin', machine: 'crash', lineBet: 10, lines: 1, auto: 1.01 }, ctx)
  later(400, () => { assert.equal(p.chips, 90); assert.equal(p.inPlay, 0); assert.equal(ctx.sent.at(-1).t, 'crashed'); assert.equal(ctx.sent.at(-1).at, 1); assert.ok(!ctx.sent.some(m => m.t === 'crashCashed')); console.log('✓ 크래시: ×1.00에서 바로 터지면 자동 내리기를 걸어도 건 칩을 잃음') })
}
{ // 자동 내리기 ×1.05 (약 0.4초) → 터질 배수 3보다 먼저 서버가 내림
  const p = { id: 'u_c3', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: crashRng(3) }
  slots.message(p, { t: 'spin', machine: 'crash', lineBet: 20, lines: 1, auto: 1.05 }, ctx)
  later(900, () => { const o = ctx.sent.find(m => m.t === 'crashCashed'); assert.ok(o, '자동으로 내려야 함'); assert.equal(o.mult, 1.05); assert.equal(o.win, 21); assert.equal(p.chips, 101); console.log('✓ 크래시: 자동 내리기는 서버가 그 배수에') })
}
{ // 날아가는 중에 나가면 그때 배수로 내림
  const p = { id: 'u_c4', chips: 100, inPlay: 0, limits: {} }
  const ctx = { ...fakeCtx(p), rng: crashRng(50) }
  slots.message(p, { t: 'spin', machine: 'crash', lineBet: 100, lines: 1 }, ctx)
  later(1200, () => {
    slots.leave(p, ctx)
    assert.equal(p.inPlay, 0)
    const o = ctx.sent.find(m => m.t === 'crashCashed')
    assert.ok(o.mult >= 1.12 && o.mult < 1.3, String(o.mult)); assert.equal(p.chips, Math.floor(100 * o.mult))
    console.log(`✓ 크래시: 날아가는 중에 나가면 그때 배수(×${o.mult})로 내림`)
  })
}
Promise.all(waits).then(() => console.log(`통과 (${n + 5}개)`), e => { console.error(e); process.exit(1) })
