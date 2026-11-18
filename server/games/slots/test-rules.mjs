// 슬롯 규칙·서버 모듈 테스트: node server/games/slots/test-rules.mjs
// 누적 잭팟 파일은 임시 폴더에 쓴다 (DATA_DIR)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'slots-test-'))
const rng = await import('../../core/rng.mjs')
const { default: slots, SPIN_MS, FS_MS } = await import('./index.mjs')
const R = await import('../../../public/slots/rules.mjs')
const { MACHINES, windowOf, lineWin, checkBet, evaluate, exactRtp, teases, TEASE_MS, MAX_LINE_BET } = R

let n = 0
const ok = (name, fn) => { fn(); n++; console.log('✓', name) }
const M = MACHINES

ok('머신 다섯 대, 띠 길이·릴 수·줄 모양이 맞다', () => {
  assert.deepEqual(Object.keys(M), ['classic', 'diamond', 'fruit5', 'lucky', 'jackpot'])
  for (const m of Object.values(M)) {
    assert.equal(m.strips.length, m.reels, m.id)
    for (const l of m.lines) { assert.equal(l.length, m.reels); assert.ok(l.every(r => r >= 0 && r <= 2)) }
    assert.equal(new Set(m.lines.map(String)).size, m.lines.length, m.id + ' 줄이 겹침')
    for (const st of m.strips) assert.ok(st.every(s => R.SYMBOLS[s]), m.id + ' 모르는 그림')
  }
  assert.equal(M.fruit5.lines.length, 20); assert.equal(M.lucky.lines.length, 10)
})

ok('클래식 띠는 처음 그대로 (세븐 1 · 바 2 · 종 4 · 수박 5 · 레몬 7 · 체리 5)', () => {
  assert.equal(M.classic.strips[0].join(','), 'cherry,lemon,bell,lemon,melon,cherry,lemon,bar,melon,lemon,cherry,bell,seven,lemon,melon,cherry,bell,lemon,bar,melon,cherry,lemon,bell,melon')
  for (const s of M.classic.strips) {
    const c = s.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {})
    assert.deepEqual(c, { seven: 1, bar: 2, bell: 4, melon: 5, lemon: 7, cherry: 5 })
  }
})

ok('다른 머신의 띠: 그림 수가 릴마다 같고, 별·잭팟은 릴마다 하나 (한 창에 많아야 하나)', () => {
  for (const m of [M.diamond, M.fruit5, M.lucky, M.jackpot]) {
    const counts = m.strips.map(s => JSON.stringify(Object.entries(s.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})).sort()))
    assert.equal(new Set(counts).size, 1, m.id)
    assert.notEqual(m.strips[0].join(), m.strips[1].join(), m.id + ' 릴이 다 같음')
  }
  for (const st of M.lucky.strips) assert.equal(st.filter(s => s === 'star').length, 1)
  for (const st of M.jackpot.strips) assert.equal(st.filter(s => s === 'jp').length, 1)
})

ok('정확한 RTP: 모두 98.5% ~ 99.5% (100%를 넘으면 코인이 불어남)', () => {
  const want = { classic: 0.9918, diamond: 0.9926, fruit5: 0.9926, lucky: 0.9891, jackpot: 0.9923 }
  for (const m of Object.values(M)) {
    const { rtp } = exactRtp(m)
    assert.ok(rtp > 0.985 && rtp < 0.995, `${m.id} ${rtp}`)
    assert.ok(Math.abs(rtp - want[m.id]) < 0.0005, `${m.id} ${rtp} (배당을 바꿨으면 want도 고치기)`)
  }
})

ok('정확한 계산이 모든 경우를 직접 센 것과 같다 (3릴 머신)', () => {
  for (const m of [M.classic, M.diamond, M.jackpot]) {
    const L = m.strips[0].length
    let sum = 0, cnt = 0
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) for (let c = 0; c < L; c++) { sum += evaluate(m, [a, b, c], 5, 1).back; cnt++ }
    const direct = sum / cnt / 5 + (m.jackpot ? m.jackpot.contribute + m.jackpot.reserve : 0)
    assert.ok(Math.abs(direct - exactRtp(m).rtp) < 1e-9, `${m.id} ${direct} ${exactRtp(m).rtp}`)
  }
})

ok('클래식 배당: 셋 > 체리 둘 > 체리 하나 (예전과 같음)', () => {
  const m = M.classic
  assert.deepEqual(lineWin(m, ['seven', 'seven', 'seven']), { kind: 'seven3', n: 3, mult: 777 })
  assert.equal(lineWin(m, ['cherry', 'cherry', 'cherry']).mult, 8)
  assert.equal(lineWin(m, ['cherry', 'cherry', 'bar']).mult, 6)
  assert.equal(lineWin(m, ['cherry', 'bar', 'cherry']).mult, 1)
  assert.equal(lineWin(m, ['bar', 'cherry', 'cherry']), null)
  assert.equal(lineWin(m, ['bell', 'bell', 'bar']), null)
})

ok('5릴: 왼쪽부터 이어진 개수만큼, 중간에 끊기면 거기까지', () => {
  const m = M.fruit5
  assert.equal(lineWin(m, ['seven', 'seven', 'seven', 'seven', 'seven']).mult, 4000)
  assert.equal(lineWin(m, ['seven', 'seven', 'seven', 'seven', 'lemon']).mult, 1000)
  assert.equal(lineWin(m, ['seven', 'seven', 'seven', 'lemon', 'seven']).mult, 200)
  assert.equal(lineWin(m, ['seven', 'seven', 'lemon', 'seven', 'seven']), null)
  assert.deepEqual(lineWin(m, ['cherry', 'cherry', 'lemon', 'lemon', 'lemon']), { kind: 'cherry2', n: 2, mult: 4 })
  assert.equal(lineWin(M.diamond, ['blank', 'blank', 'blank']), null)
  assert.equal(lineWin(M.diamond, ['diamond', 'ruby', 'ruby']).mult, 3)
})

ok('베팅 검사: 클래식만 줄 1·3·5, 나머지는 줄 전부', () => {
  assert.deepEqual(checkBet(M.classic, 3, 5), { lineBet: 3, lines: 5, total: 15 })
  assert.deepEqual(checkBet(M.fruit5, 2, 20), { lineBet: 2, lines: 20, total: 40 })
  assert.ok(checkBet(M.fruit5, 1, 5).error)
  assert.ok(checkBet(M.lucky, 1, 20).error)
  for (const [b, l] of [[0, 5], [1.5, 5], [-1, 1], [1, 2], [NaN, 5], ['x', 3], [MAX_LINE_BET + 1, 1]]) assert.ok(checkBet(M.classic, b, l).error, `${b} ${l}`)
})

ok('줄은 켠 것만, 한 줄에 하나만, 합이 back', () => {
  for (const m of Object.values(M)) {
    const lines = m.lines.length
    for (let i = 0; i < 1500; i++) {
      const stops = m.strips.map(s => rng.int(s.length))
      const g = windowOf(m, stops)
      const r = evaluate(m, stops, lines, 2)
      let want = 0
      for (let l = 0; l < lines; l++) { const w = lineWin(m, m.lines[l].map((row, reel) => g[reel][row])); if (w) want += w.mult * 2 }
      if (r.scatter) want += r.scatter.pay
      assert.equal(r.back, want)
      assert.equal(new Set(r.wins.map(w => w.line)).size, r.wins.length)
    }
  }
})

// 띠에서 그림이 있는 자리 찾기: 그 그림이 가운데(s) 오게 하는 멈춤 자리
const at = (m, r, sym) => m.strips[r].indexOf(sym)

ok('별 셋이면 프리스핀, 별 수만큼 한 판 베팅의 배수', () => {
  const m = M.lucky
  const stops = [0, 1, 2, 3, 4].map(r => r < 3 ? at(m, r, 'star') : at(m, r, 'lemon'))
  const r = evaluate(m, stops, 10, 1)
  assert.equal(r.scatter.count, 3)
  assert.equal(r.scatter.pay, 3 * 10)
  assert.equal(r.bonus, true)
  assert.equal(evaluate(m, stops, 10, 1, 2).scatter.pay, 3 * 10 * 2) // 프리스핀 ×2
})

ok('두근두근: 마지막 릴만 남았을 때 큰 그림·잭팟·별', () => {
  const c = M.classic
  assert.equal(teases(c, [at(c, 0, 'seven'), at(c, 1, 'seven'), 0], 1), true)
  assert.equal(teases(c, [at(c, 0, 'lemon'), at(c, 1, 'lemon'), 0], 1), false)
  const j = M.jackpot
  assert.equal(teases(j, [at(j, 0, 'jp'), at(j, 1, 'jp'), 0], 5), true)
  const l = M.lucky
  assert.equal(teases(l, [at(l, 0, 'star'), at(l, 1, 'star'), at(l, 2, 'lemon'), at(l, 3, 'lemon'), 0], 10), true)
  const f = M.fruit5
  assert.equal(teases(f, [0, 1, 2, 3].map(r => at(f, r, 'seven')).concat(0), 20), true)
})

// ---------- 서버 모듈 (가짜 ctx) ----------
function fakeCtx(...players) {
  const sent = [], log = [], all = []
  const ctx = {
    rng, sent, log, all,
    send(p, m) { sent.push(m); all.push([p.id, m]) },
    broadcast(list, m) { for (const p of list) all.push([p.id, m]) },
    players: () => players,
    limit: () => true,
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; return true },
    payout(pl, a, round, detail) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; log.push({ a, round, detail }); return true },
  }
  return ctx
}
slots.init()

ok('스핀: 바로 bet, 정산은 나중, 그사이 다시 돌리기 거절', () => {
  const p = { id: 'u_t1', chips: 100, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  slots.message(p, { t: 'spin', lineBet: 2, lines: 5 }, ctx) // machine 없으면 클래식 (옛 화면)
  const spun = ctx.sent.at(-1)
  assert.equal(spun.t, 'spun'); assert.equal(spun.machine, 'classic')
  assert.equal(p.chips, 90); assert.equal(p.inPlay, 10)
  slots.message(p, { t: 'spin', machine: 'diamond', lineBet: 1, lines: 5 }, ctx)
  assert.equal(ctx.sent.at(-1).t, 'toast')
  slots.leave(p, ctx)
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 90 + spun.back)
  assert.equal(ctx.log[0].detail.machine, 'classic')
})

ok('없는 머신·이상한 베팅·칩 모자람은 칩 그대로', () => {
  const p = { id: 'u_t2', chips: 19, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  for (const d of [{ machine: 'nope', lineBet: 1, lines: 5 }, { machine: 'fruit5', lineBet: 1, lines: 20 }, { machine: 'fruit5', lineBet: 1, lines: 5 }, { machine: 'classic', lineBet: 0.5, lines: 1 }]) {
    slots.message(p, { t: 'spin', ...d }, ctx)
    assert.equal(ctx.sent.at(-1).t, 'toast', JSON.stringify(d))
  }
  assert.equal(p.chips, 19); assert.equal(p.inPlay, 0)
})

ok('모든 머신 1,000판: 칩이 맞게 오가고 back = 줄 + 별 + 프리스핀 + 잭팟', () => {
  for (const id of Object.keys(M)) {
    const m = M[id], lines = (m.lineChoices || [m.lines.length]).at(-1)
    const p = { id: 'u_all_' + id, chips: 1e9, inPlay: 0, limits: {} }
    const ctx = fakeCtx(p)
    for (let i = 0; i < 1000; i++) {
      const before = p.chips
      slots.message(p, { t: 'spin', machine: id, lineBet: 1, lines }, ctx)
      const s = ctx.sent.at(-1)
      assert.equal(s.t, 'spun')
      const fs = s.bonus ? s.bonus.total : 0, jw = s.jackpot ? s.jackpot.win : 0
      assert.equal(s.back, s.base + fs + jw)
      if (s.bonus) {
        assert.equal(s.bonus.spins.length, m.scatter.freeSpins)
        assert.equal(fs, s.bonus.spins.reduce((a, x) => a + x.back, 0))
        for (const x of s.bonus.spins) assert.equal(x.back, evaluate(m, x.stops, lines, 1, m.scatter.mult).back)
      }
      slots.message(p, { t: 'skip' }, ctx)
      assert.equal(p.inPlay, 0)
      assert.equal(p.chips, before - s.total + s.back)
    }
  }
})

ok('누적 잭팟: 베팅의 2%가 쌓이고, 맞으면 베팅 비율만큼 가져감, 파일에 저장', () => {
  const j = M.jackpot, JP = j.jackpot
  const p = { id: 'u_jp', name: '잭팟테스트', chips: 1e9, inPlay: 0, limits: {} }
  const q = { id: 'u_jp2', chips: 1e9, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p, q)
  const hello = () => { slots.join(q, ctx); return ctx.sent.at(-1).jackpot.pool }
  const pool0 = hello()
  // 판 100번 (베팅 100 → 판마다 1.5칩씩 쌓임). 우연히 잭팟(1/27000)이 나오면 그만큼 빠짐
  let staked = 0, won = 0
  for (let i = 0; i < 100; i++) {
    slots.message(p, { t: 'spin', machine: 'jackpot', lineBet: 20, lines: 5 }, ctx)
    const s = ctx.sent.at(-1); staked += s.total
    if (s.jackpot) won++
    slots.message(p, { t: 'skip' }, ctx)
  }
  if (!won) assert.ok(Math.abs(hello() - (pool0 + staked * JP.contribute)) <= 1)
  // 잭팟 맞히기: 가운데 줄 잭팟 셋이 나오게 난수를 고정
  const stops = [0, 1, 2].map(r => j.strips[r].indexOf('jp'))
  let k = 0
  const fixed = { ...rng, int: nMax => (nMax === j.strips[0].length && k < 3 ? stops[k++] : rng.int(nMax)) } // 릴 멈춤만 고정
  const before = hello() + 50 * JP.contribute // 이번 판에 쌓이는 몫까지
  slots.message(p, { t: 'spin', machine: 'jackpot', lineBet: 10, lines: 5 }, { ...ctx, rng: fixed }) // 베팅 50 → 절반
  const s = ctx.sent.at(-1)
  assert.equal(s.jackpot.share, 0.5)
  assert.ok(Math.abs(s.jackpot.win - Math.floor((before + (pool0 % 1)) * 0.5)) <= 1)
  slots.message(p, { t: 'skip' }, ctx)
  assert.ok(ctx.all.some(([, m]) => m.t === 'jackpot' && m.last?.win === s.jackpot.win), '모두에게 알림')
  const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR, 'slots-jackpot.json'), 'utf8'))
  assert.equal(saved.hits, 1); assert.equal(saved.last.name, '잭팟테스트')
  assert.ok(Math.abs(saved.pool - (before - s.jackpot.win)) < 1)
  // 베팅 100 이상이면 전부, 새 잭팟 = 밑돈 (floor 이상)
  k = 0
  slots.message(p, { t: 'spin', machine: 'jackpot', lineBet: 20, lines: 5 }, { ...ctx, rng: fixed })
  const s2 = ctx.sent.at(-1)
  assert.equal(s2.jackpot.share, 1)
  slots.message(p, { t: 'skip' }, ctx)
  assert.ok(hello() >= JP.floor)
})

ok('다시 들어오면 머신별 마지막 그림, 서버 종료 때 정산하고 잭팟 저장', () => {
  const p = { id: 'u_t3', chips: 500, inPlay: 0, limits: {} }
  const ctx = fakeCtx(p)
  slots.message(p, { t: 'spin', machine: 'fruit5', lineBet: 1, lines: 20 }, ctx)
  const spun = ctx.sent.at(-1)
  slots.join(p, ctx)
  const hello = ctx.sent.at(-1)
  assert.deepEqual(hello.stops.fruit5, spun.stops)
  assert.equal(hello.spinning, true)
  slots.shutdown(ctx)
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 480 + spun.back)
  assert.ok(existsSync(join(process.env.DATA_DIR, 'slots-jackpot.json')))
})

// 정산 시간: 두근두근이면 TEASE_MS, 프리스핀이면 연출 시간만큼 늦게
const p = { id: 'u_t4', chips: 100, inPlay: 0, limits: {} }
const ctx = fakeCtx(p)
const l = M.lucky
const st = [0, 1, 2, 3, 4].map(r => r < 3 ? at(l, r, 'star') : at(l, r, 'lemon'))
let k = 0
slots.message(p, { t: 'spin', machine: 'lucky', lineBet: 1, lines: 10 }, { ...ctx, rng: { ...rng, int: nMax => (nMax === l.strips[0].length && k < 5 ? st[k++] : rng.int(nMax)) } })
const spun = ctx.sent.at(-1)
assert.ok(spun.bonus && spun.tease)
const due = SPIN_MS + TEASE_MS + FS_MS.intro + 10 * FS_MS.spin + FS_MS.outro
setTimeout(() => assert.equal(p.inPlay, 10, '너무 일찍 정산'), due - 200)
setTimeout(() => {
  assert.equal(p.inPlay, 0)
  assert.equal(p.chips, 90 + spun.back)
  console.log(`✓ 프리스핀 판은 연출(${(due / 1000).toFixed(1)}초)이 끝난 뒤 정산`)
  console.log(`통과 (${n + 1}개)`)
}, due + 200)
