// 슬롯머신 규칙: 머신 다섯 대의 릴·줄·배당과 당첨 계산. 서버(server/games/slots)와 화면(app.js)이 같이 쓴다.
// 결과(릴이 멈출 자리)는 서버가 ctx.rng로 정하고, 이 파일은 그 자리를 그림·당첨으로 바꾸기만 한다.
//
// 공통
// - 릴 띠를 돌려 멈춘 자리 s면 창에 보이는 세 칸은 위 s-1 · 가운데 s · 아래 s+1.
// - 줄 = 릴마다 몇 번째 칸(0 위 · 1 가운데 · 2 아래). 줄마다 같은 칩(lineBet)을 건다 → 한 판 = lineBet × 줄 수.
// - 줄 당첨: 맨 왼쪽 릴부터 같은 그림이 n개 이어지면 pays[그림][n]배 (건 칩 포함). 한 줄에서는 하나만.
// - 별(스캐터): 줄과 상관없이 창 어디든 n개면 한 판 베팅의 scatter.pays[n]배, trigger개 이상이면 프리스핀.
// - 잭팟: 가운데 줄에 잭팟 그림 셋 → 누적 잭팟 (금액은 서버가 들고 있음, server/games/slots/index.mjs).
//
// 환급률(RTP)은 exactRtp(머신)이 모든 경우를 셈. 운영자 결정(2026-11-18)으로 모두 약 99%:
//   클래식 99.18 · 다이아몬드 99.26 · 과일 5릴 99.26 · 럭키 스타 98.91 (프리스핀 포함) · 메가 잭팟 99.23 (잭팟 몫 2% 포함)

export const SYMBOLS = {
  seven: '7', bar: 'BAR', bell: '종', melon: '수박', lemon: '레몬', cherry: '체리',
  diamond: '다이아', ruby: '루비', sapphire: '사파이어', emerald: '에메랄드', blank: '빈칸',
  grape: '포도', orange: '오렌지', plum: '자두', star: '별', jp: '잭팟',
}

// 3릴 줄 (클래식과 같음): 1 가운데 · 2 위 · 3 아래 · 4 ↘ · 5 ↗
const LINES3 = [[1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0]]
// 5릴 줄 20개 (앞 10개는 럭키 스타도 씀)
const LINES5 = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 0, 2, 0],
]

// 그림 수만 주면 같은 그림이 고르게 흩어진 띠를 만든다 (결정적: 코드가 같으면 띠도 같다).
// shift로 릴마다 시작점을, 순서를 바꿔 릴마다 다른 띠가 되게 한다
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
    id: 'classic', name: '클래식 777', short: '클래식', desc: '3릴 · 줄 5개. 자주 작게, 가끔 777',
    reels: 3, strips: CLASSIC, lines: LINES3, lineChoices: [1, 3, 5],
    pays: { seven: { 3: 777 }, bar: { 3: 80 }, bell: { 3: 30 }, melon: { 3: 12 }, lemon: { 3: 8 }, cherry: { 1: 1, 2: 6, 3: 8 } },
    tease: ['seven', 'bar', 'bell'],
  },
  diamond: {
    id: 'diamond', name: '다이아몬드', short: '다이아', desc: '3릴 · 줄 5개. 잘 안 터지지만 터지면 최고 ×2,000',
    reels: 3, lines: LINES3,
    strips: reels([['diamond', 1], ['ruby', 2], ['sapphire', 3], ['emerald', 6], ['blank', 20]], 3, [0, 11, 22]),
    pays: { diamond: { 1: 3, 2: 50, 3: 2000 }, ruby: { 3: 550 }, sapphire: { 3: 200 }, emerald: { 3: 75 } },
    tease: ['diamond', 'ruby', 'sapphire'],
  },
  fruit5: {
    id: 'fruit5', name: '과일 5릴', short: '과일5', desc: '5릴 · 줄 20개. 왼쪽부터 3·4·5개, 자주 따요',
    reels: 5, lines: LINES5,
    strips: reels([['seven', 1], ['bell', 2], ['melon', 3], ['grape', 3], ['orange', 4], ['plum', 4], ['cherry', 6], ['lemon', 7]], 5, [0, 7, 14, 21, 4]),
    pays: {
      seven: { 3: 200, 4: 1000, 5: 4000 }, bell: { 3: 100, 4: 400, 5: 1500 }, melon: { 3: 60, 4: 200, 5: 750 },
      grape: { 3: 40, 4: 150, 5: 600 }, orange: { 3: 20, 4: 75, 5: 300 }, plum: { 3: 20, 4: 75, 5: 300 },
      cherry: { 2: 4, 3: 15, 4: 50, 5: 200 }, lemon: { 3: 12, 4: 40, 5: 150 },
    },
    tease: ['seven', 'bell', 'melon'],
  },
  lucky: {
    id: 'lucky', name: '럭키 스타', short: '럭키스타', desc: '5릴 · 줄 10개. 별 3개면 프리스핀 10번 ×2',
    reels: 5, lines: LINES5.slice(0, 10),
    strips: reels([['star', 1], ['seven', 1], ['bar', 2], ['bell', 3], ['orange', 5], ['cherry', 7], ['lemon', 11]], 5, [0, 6, 12, 18, 24]),
    pays: {
      seven: { 3: 75, 4: 400, 5: 2000 }, bar: { 3: 50, 4: 150, 5: 600 }, bell: { 3: 25, 4: 75, 5: 250 },
      orange: { 3: 12, 4: 30, 5: 100 }, cherry: { 2: 1, 3: 6, 4: 20, 5: 60 }, lemon: { 3: 5, 4: 12, 5: 30 },
    },
    scatter: { symbol: 'star', pays: { 3: 3, 4: 20, 5: 100 }, trigger: 3, freeSpins: 10, mult: 2 },
    tease: [],
  },
  jackpot: {
    id: 'jackpot', name: '메가 잭팟', short: '잭팟', desc: '3릴 · 줄 5개. 가운데 줄 잭팟 셋이면 누적 잭팟',
    reels: 3, lines: LINES3,
    strips: reels([['jp', 1], ['seven', 1], ['bar', 2], ['bell', 4], ['melon', 5], ['lemon', 8], ['cherry', 9]], 3, [0, 10, 20]),
    pays: { seven: { 3: 400 }, bar: { 3: 75 }, bell: { 3: 25 }, melon: { 3: 10 }, lemon: { 3: 8 }, cherry: { 1: 1, 2: 4, 3: 8 } },
    tease: ['jp', 'seven', 'bar'],
    // 베팅의 1.5%는 잭팟에, 0.5%는 다음 잭팟 밑돈에. 베팅 fullBet 이상이면 잭팟 전부, 적으면 베팅 비율만큼
    jackpot: { symbol: 'jp', line: 0, contribute: 0.015, reserve: 0.005, fullBet: 100, start: 10000, floor: 1000 },
  },
}
export const MACHINE_IDS = Object.keys(MACHINES)
export const machineOf = id => MACHINES[id] || MACHINES.classic

// 한 판 베팅 상한은 없다 (CASINO.md 5장). 다만 돌려줄 칩이 안전한 정수를 넘지 않게 라인당 상한만 둔다
export const MAX_LINE_BET = Math.floor(Number.MAX_SAFE_INTEGER / (20 * 5000))

const modLen = (n, len) => ((n % len) + len) % len

// 멈춘 자리 → 창의 그림. grid[릴][칸]
export function windowOf(m, stops) {
  return stops.map((s, r) => {
    const st = m.strips[r], len = st.length
    return [st[modLen(s - 1, len)], st[modLen(s, len)], st[modLen(s + 1, len)]]
  })
}

// n개 이어졌을 때 받을 배수: 정확히 n이 없으면 그보다 적은 개수의 배당 (예: 4개인데 3개 배당만 있으면 3개로)
function payFor(m, sym, n) {
  const p = m.pays[sym]
  if (!p) return null
  for (let k = n; k >= 1; k--) if (p[k]) return { n: k, mult: p[k] }
  return null
}

// 한 줄의 그림들 → { kind, n, mult } 또는 null. 맨 왼쪽부터 같은 그림이 몇 개 이어지는지
export function lineWin(m, cells) {
  const s = cells[0]
  let n = 1
  while (n < cells.length && cells[n] === s) n++
  const w = payFor(m, s, n)
  return w ? { kind: s + w.n, n: w.n, mult: w.mult } : null
}

// 브라우저가 보낸 베팅 검사 → { lineBet, lines, total } 또는 { error }
export function checkBet(m, lineBet, lines) {
  lineBet = Number(lineBet); lines = Number(lines)
  const choices = m.lineChoices || [m.lines.length]
  if (!choices.includes(lines)) return { error: `줄은 ${choices.join('·')}개 중에서 골라 주세요.` }
  if (!Number.isSafeInteger(lineBet) || lineBet < 1) return { error: '줄당 베팅은 1 이상 정수로 해 주세요.' }
  if (lineBet > MAX_LINE_BET) return { error: '베팅이 너무 커요.' }
  return { lineBet, lines, total: lineBet * lines }
}

// 한 판 결과 → { grid, wins: [{ line, kind, n, mult, pay }], scatter: { count, pay, cells }, back, bonus, jackpot }
//   mult: 프리스핀 배수 (보통 1). jackpot은 가운데 줄 잭팟 셋 여부만 (금액은 서버가 정함)
export function evaluate(m, stops, lines, lineBet, mult = 1) {
  const grid = windowOf(m, stops)
  const wins = []
  let back = 0
  for (let i = 0; i < lines; i++) {
    const rows = m.lines[i]
    const w = lineWin(m, rows.map((row, r) => grid[r][row]))
    if (!w) continue
    const pay = lineBet * w.mult * mult
    wins.push({ line: i, kind: w.kind, n: w.n, mult: w.mult * mult, pay })
    back += pay
  }
  let scatter = null, bonus = false
  if (m.scatter) {
    const cells = []
    grid.forEach((col, r) => col.forEach((s, row) => { if (s === m.scatter.symbol) cells.push([r, row]) }))
    const pay = (m.scatter.pays[cells.length] || 0) * lineBet * lines * mult
    scatter = { count: cells.length, pay, cells }
    back += pay
    bonus = cells.length >= m.scatter.trigger
  }
  let jackpot = false
  if (m.jackpot) {
    const rows = m.lines[m.jackpot.line]
    jackpot = rows.every((row, r) => grid[r][row] === m.jackpot.symbol)
  }
  return { grid, wins, scatter, back, bonus, jackpot }
}

// 두근두근: 마지막 릴만 남았는데 큰 당첨이 될 수 있으면 마지막 릴을 TEASE_MS 더 돌린다 (연출만, 결과는 이미 정해짐).
// - 줄: 켠 줄에서 마지막 릴 앞까지 tease 그림이 다 같을 때
// - 별: 마지막 릴 앞까지 별이 trigger-1개 이상일 때
// 서버도 같은 판단으로 정산을 그만큼 늦춰서, 칩 숫자가 마지막 릴보다 먼저 바뀌지 않게 한다
export const TEASE_MS = 1300
export function teases(m, stops, lines) {
  const g = windowOf(m, stops), last = m.reels - 1
  for (let i = 0; i < lines; i++) {
    const rows = m.lines[i], s = g[0][rows[0]]
    if (!m.tease.includes(s)) continue
    if (rows.slice(0, last).every((row, r) => g[r][row] === s)) return true
  }
  if (m.jackpot) {
    const rows = m.lines[m.jackpot.line]
    if (rows.slice(0, last).every((row, r) => g[r][row] === m.jackpot.symbol)) return true
  }
  if (m.scatter) {
    let n = 0
    for (let r = 0; r < last; r++) n += g[r].filter(s => s === m.scatter.symbol).length
    if (n >= m.scatter.trigger - 1) return true
  }
  return false
}

// ---------- 정확한 기댓값 (테스트·배당표 확인용) ----------
// 줄 하나의 기댓값: 줄마다 릴의 칸 분포가 같으므로 (멈춤 자리가 고르면) 모든 줄이 같다
function freqOf(m) {
  return m.strips.map(st => { const f = {}; for (const s of st) f[s] = (f[s] || 0) + 1; for (const k in f) f[k] /= st.length; return f })
}
export function exactRtp(m) {
  const f = freqOf(m), R = m.reels
  let line = 0, hit = 0
  for (const sym of Object.keys(m.pays)) {
    // 정확히 n개 이어질 확률 = (앞 n개가 sym) × (n번째가 sym이 아님, 마지막이면 1)
    let pre = 1
    for (let n = 1; n <= R; n++) {
      pre *= f[n - 1][sym] || 0
      const exact = pre * (n < R ? 1 - (f[n][sym] || 0) : 1)
      const w = payFor(m, sym, n)
      if (w) { line += exact * w.mult; hit += exact }
    }
  }
  // 별: 릴마다 창에 별이 보일 확률 (별끼리 3칸 이상 떨어져 있어 한 릴 창에 많아야 하나)
  let scatter = 0, trigger = 0
  if (m.scatter) {
    let dist = [1]
    for (let r = 0; r < R; r++) {
      const q = 3 * (f[r][m.scatter.symbol] || 0)
      const next = new Array(dist.length + 1).fill(0)
      dist.forEach((p, k) => { next[k] += p * (1 - q); next[k + 1] += p * q })
      dist = next
    }
    dist.forEach((p, k) => { scatter += p * (m.scatter.pays[k] || 0); if (k >= m.scatter.trigger) trigger += p })
  }
  const base = line + scatter
  const free = m.scatter ? trigger * m.scatter.freeSpins * m.scatter.mult * base : 0 // 프리스핀은 다시 걸리지 않음
  const jackpot = m.jackpot ? m.jackpot.contribute + m.jackpot.reserve : 0 // 오래 보면 잭팟으로 돌아가는 몫
  let jpHit = 0
  if (m.jackpot) { jpHit = 1; for (let r = 0; r < R; r++) jpHit *= f[r][m.jackpot.symbol] || 0 }
  return { rtp: base + free + jackpot, line, scatter, trigger, free, jackpot, jpHit, hit }
}
