// 슬롯머신 규칙: 머신 다섯 대의 릴·배당과 당첨 계산. 서버(server/games/slots)와 화면(app.js)이 같이 쓴다.
// 결과(릴이 멈출 자리)는 서버가 ctx.rng로 정하고, 이 파일은 그 자리를 그림·당첨으로 바꾸기만 한다.
// (프리스핀은 서버가 판마다 멈출 자리를 새로 뽑고, 연쇄 폭발의 새 과일도 서버가 뽑아 결과에 담아 보낸다)
//
// 머신 종류 (type)
//   lines   — 줄 당첨: 맨 왼쪽 릴부터 같은 그림이 n개 이어지면 pays[그림][n]배 (클래식 · 럭키 스타)
//             scatter가 있으면 별은 창 어디든 세고, trigger개 이상이면 프리스핀 (럭키 스타)
//   gem     — 다이아몬드: 가운데 줄 하나 + 오른쪽 배수 릴. 다이아는 와일드(아무 그림), 하나 섞일 때마다 ×2
//   cascade — 과일 폭탄: 5×4 칸, 줄 없이 옆 릴끼리 이어지면(웨이) 당첨 → 맞은 과일이 터지고 위에서 새 과일이
//             떨어진다 (새 과일은 서버가 그 릴의 띠에서 무작위로 뽑음: draw). 연쇄마다 배수 chain[i]
//
// 머신 네 대 (운영자 결정 2026-11-18: 메가 잭팟 머신은 빼고, 모두의 잭팟은 네 대 모두에서 미스터리로)
// 공통: 릴 띠를 돌려 멈춘 자리 s면 창에 보이는 칸은 위에서부터 s-1, s, s+1 (4칸 창은 s+2까지).
// 환급률(RTP): 운영자 결정(2026-11-18)으로 머신 기본 약 100% + 모든 머신이 같이 쌓는 미스터리 잭팟 2%.
//   lines·gem은 exactRtp()가 모든 경우를 셈. 연쇄·프리스핀 배수는 시뮬레이션 값(rtpRef)을 적어 둠 (test-sim.mjs로 확인)

export const SYMBOLS = {
  seven: '7', bar: 'BAR', bell: '종', melon: '수박', lemon: '레몬', cherry: '체리',
  diamond: '다이아', ruby: '루비', sapphire: '사파이어', emerald: '에메랄드', blank: '빈칸',
  grape: '포도', orange: '오렌지', plum: '자두', star: '별',
  moon: '달', planet: '행성', comet: '혜성', clover: '네잎클로버', horseshoe: '말굽',
  x1: '×1', x2: '×2', x3: '×3', x5: '×5', x10: '×10',
}

// 3릴 줄 (클래식과 같음): 1 가운데 · 2 위 · 3 아래 · 4 ↘ · 5 ↗
const LINES3 = [[1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]]
// 5릴 줄 10개
const LINES5 = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [1, 0, 1, 2, 1],
]

// 그림 수만 주면 같은 그림이 고르게 흩어진 띠를 만든다 (결정적: 코드가 같으면 띠도 같다).
function strip(counts, shift = 0, reverse = false) {
  const list = reverse ? [...counts].reverse() : counts
  const len = list.reduce((s, [, n]) => s + n, 0)
  const placed = Object.fromEntries(list.map(([k]) => [k, 0]))
  const out = []
  for (let i = 0; i < len; i++) {
    let best = null, bestScore = -Infinity
    for (const [k, n] of list) {
      if (placed[k] >= n) continue
      const score = n * (i + 1) / len - placed[k]
      if (score > bestScore + 1e-9) { best = k; bestScore = score }
    }
    placed[best]++
    out.push(best)
  }
  return out.map((_, i) => out[(i + shift) % len])
}
const reels = (counts, n, shifts) => Array.from({ length: n }, (_, r) => strip(counts, shifts[r], r % 2 === 1))

// 클래식 777: 24칸 띠 3개 (처음 만든 그대로 — 지난 판 기록과 같은 띠)
const C = { 7: 'seven', B: 'bar', L: 'bell', M: 'melon', N: 'lemon', C: 'cherry' }
const CLASSIC = [
  'CNLNMCNBMNCL7NMCLNBMCNLM',
  'NMCLN7MNCBNLMCNLMBNCLMNC',
  'MNCNLBNMCLNM7CNLMNBCMNLC',
].map(s => [...s].map(ch => C[ch]))

export const MACHINES = {
  classic: {
    id: 'classic', type: 'lines', name: '클래식 777', short: '클래식', desc: '3릴 · 줄 5개. 자주 작게, 가끔 777',
    reels: 3, rows: 3, strips: CLASSIC, lines: LINES3, lineChoices: [1, 3, 5],
    pays: { seven: { 3: 777 }, bar: { 3: 80 }, bell: { 3: 30 }, melon: { 3: 13 }, lemon: { 3: 8 }, cherry: { 1: 1, 2: 6, 3: 8 } },
    tease: ['seven', 'bar', 'bell'],
  },
  diamond: {
    id: 'diamond', type: 'gem', name: '다이아몬드', short: '다이아', desc: '가운데 줄 하나 + 배수 릴. 다이아는 와일드, 섞일 때마다 ×2',
    reels: 3, rows: 3, lines: [[1, 1, 1]],
    strips: reels([['diamond', 1], ['ruby', 3], ['sapphire', 4], ['emerald', 6], ['blank', 18]], 3, [0, 11, 22]),
    // 오른쪽 배수 릴: 가운데 칸의 배수가 줄 당첨에 곱해진다 (평균 ×1.88)
    mstrip: strip([['x1', 16], ['x2', 5], ['x3', 2], ['x5', 1], ['x10', 1]], 0),
    pays: { ruby: { 3: 40 }, sapphire: { 3: 15 }, emerald: { 3: 7 } },
    wild: 'diamond', wildPays: { 1: 1, 2: 6, 3: 1000 }, anyGem: 1, // 다이아만 n개(나머지 빈칸·섞임) · 보석 셋 섞임. 최고 = 다이아 셋 × 배수 10 = ×10,000
    tease: [],
  },
  fruit5: {
    id: 'fruit5', type: 'cascade', name: '과일 폭탄', short: '과일폭탄', desc: '5×4 칸, 옆 릴끼리 이어지면 터지고 연쇄마다 ×1·×2·×3·×5',
    reels: 5, rows: 4, unit: 25, // 한 판 베팅 = 25 × 단위 (줄 대신 웨이 1,024개, 배당은 웨이 하나당 단위의 몇 배)
    strips: reels([['melon', 4], ['grape', 4], ['plum', 4], ['orange', 5], ['cherry', 5], ['lemon', 5], ['bell', 4], ['bar', 3], ['seven', 2]], 5, [0, 9, 18, 4, 13]),
    pays: {
      seven: { 3: 15, 4: 60, 5: 300 }, bar: { 3: 8, 4: 30, 5: 120 }, melon: { 3: 5, 4: 20, 5: 60 }, bell: { 3: 4, 4: 12, 5: 40 },
      grape: { 3: 3, 4: 8, 5: 25 }, plum: { 3: 2, 4: 6, 5: 20 }, orange: { 3: 1, 4: 4, 5: 12 }, cherry: { 3: 1, 4: 3, 5: 10 }, lemon: { 3: 1, 4: 2, 5: 8 },
    },
    chain: [1, 2, 3, 5],
    rtpRef: 0.9997, // 시뮬레이션 8,000만 판 (±0.05%p)
    tease: [],
  },
  lucky: {
    id: 'lucky', type: 'lines', name: '럭키 스타', short: '럭키스타', desc: '밤하늘 5릴. 별 3개면 프리스핀, 별이 뜰 때마다 배수 +1',
    reels: 5, rows: 3, lines: LINES5,
    strips: reels([['star', 1], ['moon', 1], ['planet', 2], ['comet', 3], ['clover', 5], ['horseshoe', 7], ['blank', 11]], 5, [0, 6, 12, 18, 24]),
    pays: {
      moon: { 3: 200, 4: 1000, 5: 4000 }, planet: { 3: 100, 4: 400, 5: 1500 }, comet: { 3: 50, 4: 150, 5: 600 },
      clover: { 3: 20, 4: 80, 5: 250 }, horseshoe: { 2: 4, 3: 15, 4: 50, 5: 150 },
    },
    // 프리스핀: 시작 배수 1, 별이 뜰 때마다 +1 (끝까지 쌓임), 프리스핀 중 별 3개면 +3번 (최대 50번)
    scatter: { symbol: 'star', pays: { 3: 2, 4: 10, 5: 50 }, trigger: 3, freeSpins: 8, retrigger: 3, maxSpins: 50 },
    rtpRef: 1.0062, // 프리스핀 포함, 시뮬레이션 8,000만 판 (±0.05%p)
    tease: ['moon'],
  },
}
export const MACHINE_IDS = Object.keys(MACHINES)
export const machineOf = id => MACHINES[id] || MACHINES.classic

// 모두의 잭팟 (미스터리): 어느 머신이든 한 판 베팅의 contribute는 잭팟에, reserve는 다음 밑돈에.
// 판마다 (베팅 ÷ odds) 확률로 잭팟 전부.
// 다 가져가면 밑돈이 새 잭팟 (floor보다 적으면 하우스가 floor까지 채움). 오래 보면 contribute + reserve 만큼이 플레이어에게 돌아감
export const JACKPOT = { contribute: 0.015, reserve: 0.005, odds: 500000, start: 10000, floor: 1000 }

// 한 판 베팅 상한은 없다 (CASINO.md 5장). 다만 돌려줄 칩이 안전한 정수를 넘지 않게 상한만 둔다
export const MAX_LINE_BET = Math.floor(Number.MAX_SAFE_INTEGER / (20 * 100000))

const modLen = (n, len) => ((n % len) + len) % len
const rowsOf = m => m.rows || 3

// 멈춘 자리 → 창의 그림. grid[릴][칸] (칸 0 = 맨 위)
export function windowOf(m, stops) {
  const R = rowsOf(m)
  return m.strips.map((st, r) => Array.from({ length: R }, (_, k) => st[modLen(stops[r] - 1 + k, st.length)]))
}

// n개 이어졌을 때 받을 배수: 정확히 n이 없으면 그보다 적은 개수의 배당
function payFor(m, sym, n) {
  const p = m.pays[sym]
  if (!p) return null
  for (let k = n; k >= 1; k--) if (p[k]) return { n: k, mult: p[k] }
  return null
}

// lines: 한 줄의 그림들 → { kind, n, mult } 또는 null
export function lineWin(m, cells) {
  if (m.type === 'gem') return gemWin(m, cells)
  const s = cells[0]
  let n = 1
  while (n < cells.length && cells[n] === s) n++
  const w = payFor(m, s, n)
  return w ? { kind: s + w.n, n: w.n, mult: w.mult } : null
}

// gem: 가운데 줄 세 칸 → { kind, n, mult } (배수 릴은 따로)
export function gemWin(m, cells) {
  const wild = cells.filter(s => s === m.wild).length
  const rest = cells.filter(s => s !== m.wild)
  if (wild === 3) return { kind: m.wild + '3', n: 3, mult: m.wildPays[3] }
  const same = rest.every(s => s === rest[0])
  if (same && m.pays[rest[0]]?.[3]) return { kind: rest[0] + '3', n: 3, mult: m.pays[rest[0]][3] * 2 ** wild, wild }
  let best = null
  if (wild) best = { kind: m.wild + wild, n: 3, mult: m.wildPays[wild], wild }
  if (rest.every(s => s !== 'blank') && m.anyGem && (!best || m.anyGem * 2 ** wild > best.mult)) best = { kind: 'anyGem', n: 3, mult: m.anyGem * 2 ** wild, wild }
  return best
}

// 브라우저가 보낸 베팅 검사 → { lineBet, lines, total } 또는 { error }
export function checkBet(m, lineBet, lines) {
  lineBet = Number(lineBet); lines = Number(lines)
  const choices = m.lineChoices || [linesOf(m)]
  if (!choices.includes(lines)) return { error: `줄은 ${choices.join('·')}개 중에서 골라 주세요.` }
  if (!Number.isSafeInteger(lineBet) || lineBet < 1) return { error: '줄당 베팅은 1 이상 정수로 해 주세요.' }
  if (lineBet > MAX_LINE_BET) return { error: '베팅이 너무 커요.' }
  return { lineBet, lines, total: lineBet * lines }
}
// 한 판 베팅 = 줄당 × linesOf (연쇄는 unit)
export const linesOf = m => m.type === 'cascade' ? m.unit : m.lines.length

// ---------- 한 판 결과 ----------
// lines·gem → { grid, wins: [{ line, kind, n, mult, pay }], scatter, back, bonus, mreel }
//   mult: 프리스핀 배수 (줄 당첨에만). gem은 mreel(배수 릴 가운데 값)을 곱함
// cascade → { grid, steps: [{ grid, wins: [{ sym, kind, n, ways, mult, pay, cells }], chain, pay, removed }], back }
export function evaluate(m, stops, lines, lineBet, mult = 1, draw) {
  if (m.type === 'cascade') return cascade(m, stops, lineBet, draw)
  const grid = windowOf(m, stops)
  const wins = []
  let back = 0, mreel = null
  if (m.type === 'gem') {
    const ms = m.mstrip, mi = stops[m.reels] ?? 0
    mreel = { stop: mi, value: Number(ms[modLen(mi, ms.length)].slice(1)) }
  }
  for (let i = 0; i < lines; i++) {
    const rows = m.lines[i]
    const w = lineWin(m, rows.map((row, r) => grid[r][row]))
    if (!w) continue
    const x = mult * (mreel ? mreel.value : 1)
    const pay = lineBet * w.mult * x
    wins.push({ line: i, kind: w.kind, n: w.n, mult: w.mult * x, pay, wild: w.wild || 0 })
    back += pay
  }
  let scatter = null, bonus = false
  if (m.scatter) {
    const cells = []
    grid.forEach((col, r) => col.forEach((s, row) => { if (s === m.scatter.symbol) cells.push([r, row]) }))
    const pay = (m.scatter.pays[cells.length] || 0) * lineBet * lines
    scatter = { count: cells.length, pay, cells }
    back += pay
    bonus = cells.length >= m.scatter.trigger
  }
  return { grid, wins, scatter, back, bonus, mreel }
}

// 과일 폭탄: 웨이 당첨 → 터짐 → 남은 과일이 아래로, 위에서 새 과일이 떨어짐 → 다시 확인 (최대 40번)
//   draw(r) = r번 릴에 떨어질 새 과일 (서버: 그 릴의 띠에서 ctx.rng로 한 칸). 떨어진 과일은 steps[i].drops에 남는다
export function cascade(m, stops, unit, draw) {
  const H = rowsOf(m)
  let grid = windowOf(m, stops)
  const first = grid.map(c => [...c])
  const steps = []
  let back = 0
  for (let step = 0; step < 40; step++) {
    const wins = waysWins(m, grid)
    if (!wins.length) break
    const chain = m.chain[Math.min(step, m.chain.length - 1)]
    let pay = 0
    const removed = grid.map(() => new Set())
    for (const w of wins) {
      w.pay = unit * w.mult * w.ways * chain
      pay += w.pay
      for (const [r, k] of w.cells) removed[r].add(k)
    }
    // 떨어뜨리기: 남은 칸은 순서대로 아래로, 비는 만큼 새 과일이 위에서
    const drops = grid.map((col, r) => Array.from({ length: removed[r].size }, () => draw(r)))
    steps.push({ grid: grid.map(c => [...c]), wins, chain, pay, removed: removed.map(s => [...s].sort((a, b) => a - b)), drops })
    back += pay
    grid = grid.map((col, r) => [...drops[r], ...col.filter((_, k) => !removed[r].has(k))])
  }
  return { grid: first, steps, back, final: grid }
}
// 웨이: 맨 왼쪽 릴부터 그 그림이 있는 릴이 n개 이어지면, 릴마다 그 그림 칸 수를 곱한 만큼(웨이 수) 받는다
export function waysWins(m, grid) {
  const wins = []
  for (const sym of Object.keys(m.pays)) {
    let ways = 1, n = 0
    const cells = []
    for (let r = 0; r < grid.length; r++) {
      const ks = grid[r].flatMap((s, k) => s === sym ? [k] : [])
      if (!ks.length) break
      ways *= ks.length; n++
      for (const k of ks) cells.push([r, k])
    }
    const w = payFor(m, sym, n)
    if (w && w.n >= 3 && n >= 3) wins.push({ sym, kind: sym + n, n, ways, mult: m.pays[sym][n] || w.mult, cells: cells.filter(([r]) => r < n) })
  }
  return wins
}

// 럭키 스타 프리스핀: 별이 뜰 때마다 배수 +별 수, 별 trigger개 이상이면 retrigger번 더. randStops = () => 멈출 자리
export function freeSpins(m, lines, lineBet, randStops) {
  const sc = m.scatter
  const spins = []
  let left = sc.freeSpins, mult = 1, total = 0
  while (left > 0 && spins.length < sc.maxSpins) {
    left--
    const stops = randStops()
    const stars = windowOf(m, stops).flat().filter(s => s === sc.symbol).length
    mult += stars
    const e = evaluate(m, stops, lines, lineBet, mult)
    const more = stars >= sc.trigger ? sc.retrigger : 0
    left += more
    spins.push({ stops, wins: e.wins, scatter: e.scatter, back: e.back, mult, more, stars })
    total += e.back
  }
  return { spins, total, mult }
}

// 두근두근: 마지막 릴만 남았는데 큰 당첨이 될 수 있으면 마지막 릴을 TEASE_MS 더 돌린다 (연출만, 결과는 이미 정해짐).
// 서버도 같은 판단으로 정산을 그만큼 늦춘다
export const TEASE_MS = 1300
export function teases(m, stops, lines) {
  if (m.type === 'cascade') return false
  const g = windowOf(m, stops)
  if (m.type === 'gem') { // 세 칸이 당첨이면 배수 릴이 멈출 때까지 두근두근
    return !!gemWin(m, m.lines[0].map((row, r) => g[r][row]))
  }
  const last = m.reels - 1
  for (let i = 0; i < lines; i++) {
    const rows = m.lines[i], s = g[0][rows[0]]
    if (!m.tease.includes(s)) continue
    if (rows.slice(0, last).every((row, r) => g[r][row] === s)) return true
  }
  if (m.scatter) {
    let n = 0
    for (let r = 0; r < last; r++) n += g[r].filter(s => s === m.scatter.symbol).length
    if (n >= m.scatter.trigger - 1) return true
  }
  return false
}

// ---------- 정확한 기댓값 (lines·gem) ----------
function freqOf(strips) {
  return strips.map(st => { const f = {}; for (const s of st) f[s] = (f[s] || 0) + 1; for (const k in f) f[k] /= st.length; return f })
}
// 돌려주는 값: rtp(머신 기본), line(줄), scatter(별), trigger(프리스핀 확률), hit(줄 당첨 확률), jpLine(잭팟 셋 확률)
// 럭키 스타 프리스핀 몫은 배수가 쌓여 식이 길어서 rtpRef(시뮬레이션) 쪽에 둔다 → free: null
export function exactRtp(m) {
  if (m.type === 'cascade') return { rtp: null, line: null }
  const f = freqOf(m.strips), R = m.reels
  let line = 0, hit = 0
  if (m.type === 'gem') {
    const keys = Object.keys(SYMBOLS).filter(k => f.some(x => x[k]))
    for (const a of keys) for (const b of keys) for (const c of keys) {
      const p = (f[0][a] || 0) * (f[1][b] || 0) * (f[2][c] || 0)
      if (!p) continue
      const w = gemWin(m, [a, b, c])
      if (w) { line += p * w.mult; hit += p }
    }
    const mf = freqOf([m.mstrip])[0]
    const em = Object.entries(mf).reduce((s, [k, p]) => s + p * Number(k.slice(1)), 0)
    return { rtp: line * em, line, hit, mean: em }
  }
  for (const sym of Object.keys(m.pays)) {
    let pre = 1
    for (let n = 1; n <= R; n++) {
      pre *= f[n - 1][sym] || 0
      const exact = pre * (n < R ? 1 - (f[n][sym] || 0) : 1)
      const w = payFor(m, sym, n)
      if (w) { line += exact * w.mult; hit += exact }
    }
  }
  let scatter = 0, trigger = 0
  if (m.scatter) {
    let dist = [1]
    for (let r = 0; r < R; r++) {
      const q = rowsOf(m) * (f[r][m.scatter.symbol] || 0) // 별끼리 띠에서 rows칸 이상 떨어져 있어 한 릴 창에 많아야 하나
      const next = new Array(dist.length + 1).fill(0)
      dist.forEach((p, k) => { next[k] += p * (1 - q); next[k + 1] += p * q })
      dist = next
    }
    dist.forEach((p, k) => { scatter += p * (m.scatter.pays[k] || 0); if (k >= m.scatter.trigger) trigger += p })
  }
  // 럭키 스타 프리스핀 몫은 배수가 쌓여 식이 길어서 시뮬레이션(rtpRef)
  return { rtp: m.scatter ? null : line + scatter, line, scatter, trigger, hit }
}
