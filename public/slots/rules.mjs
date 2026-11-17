// 슬롯머신 규칙 (CASINO.md 5장: 3릴 · 5라인 · RTP 95%). 서버(server/games/slots)와 화면(app.js)이 같이 쓴다.
// 결과(릴이 멈출 자리)는 서버가 ctx.rng로 정하고, 이 파일은 그 자리를 그림·당첨으로 바꾸기만 한다.
//
// 릴: 24칸 띠 3개. 멈춘 자리 s면 창에 보이는 세 칸은 위 s-1 · 가운데 s · 아래 s+1.
// 라인: 1개(가운데) · 3개(+위·아래) · 5개(+대각선 둘). 라인마다 같은 칩(lineBet)을 건다 → 한 판 = lineBet × 라인 수.
// 배당은 라인당 건 칩의 몇 배를 돌려주는지 (건 칩 포함). 한 라인에서는 가장 큰 것 하나만.
//
// 정확한 RTP (모든 경우를 셈): 95.023% — 라인 수와 상관없이 같다 (라인마다 칸의 분포가 같으므로). exactRtp()로 확인.

export const SYMBOLS = {
  seven: { name: '세븐', short: '7' },
  bar: { name: '바', short: 'BAR' },
  bell: { name: '종', short: '종' },
  melon: { name: '수박', short: '수박' },
  lemon: { name: '레몬', short: '레몬' },
  cherry: { name: '체리', short: '체리' },
}

// 릴마다 칸 수: 세븐 1 · 바 2 · 종 4 · 수박 5 · 레몬 7 · 체리 5 = 24. 순서만 다르다
const S = { 7: 'seven', B: 'bar', L: 'bell', M: 'melon', N: 'lemon', C: 'cherry' }
export const STRIPS = [
  'CNLNMCNBMNCL7NMCLNBMCNLM',
  'NMCLN7MNCBNLMCNLMBNCLMNC',
  'MNCNLBNMCLNM7CNLMNBCMNLC',
].map(s => [...s].map(ch => S[ch]))
export const REEL_LEN = 24

// 줄 = 릴마다 몇 번째 칸(0 위 · 1 가운데 · 2 아래)
export const LINES = [
  [1, 1, 1], // 1 가운데
  [0, 0, 0], // 2 위
  [2, 2, 2], // 3 아래
  [0, 1, 2], // 4 ↘
  [2, 1, 0], // 5 ↗
]
export const LINE_CHOICES = [1, 3, 5]

// 같은 그림 셋
export const PAY3 = { seven: 777, bar: 80, bell: 30, melon: 15, lemon: 8, cherry: 8 }
// 첫 릴부터 체리 둘 · 첫 릴 체리 하나 (셋이 아닐 때)
export const PAY_CHERRY2 = 4
export const PAY_CHERRY1 = 1

// 한 판 베팅 상한은 없다 (CASINO.md 5장). 다만 돌려줄 칩이 안전한 정수를 넘지 않게 라인당 상한만 둔다
export const MAX_LINE_BET = Math.floor(Number.MAX_SAFE_INTEGER / (5 * 1000))

const mod = n => ((n % REEL_LEN) + REEL_LEN) % REEL_LEN

// 멈춘 자리 → 창의 3×3 그림. grid[릴][칸]
export function window3(stops) {
  return stops.map((s, r) => [STRIPS[r][mod(s - 1)], STRIPS[r][mod(s)], STRIPS[r][mod(s + 1)]])
}

// 한 줄의 배수와 이름
export function lineWin(a, b, c) {
  if (a === b && b === c) return { mult: PAY3[a], kind: a + '3', n: 3 }
  if (a === 'cherry' && b === 'cherry') return { mult: PAY_CHERRY2, kind: 'cherry2', n: 2 }
  if (a === 'cherry') return { mult: PAY_CHERRY1, kind: 'cherry1', n: 1 }
  return null
}

// 브라우저가 보낸 베팅 검사 → { lineBet, lines, total } 또는 { error }
export function checkBet(lineBet, lines) {
  lineBet = Number(lineBet); lines = Number(lines)
  if (!LINE_CHOICES.includes(lines)) return { error: '라인은 1·3·5개 중에서 골라 주세요.' }
  if (!Number.isSafeInteger(lineBet) || lineBet < 1) return { error: '라인당 베팅은 1 이상 정수로 해 주세요.' }
  if (lineBet > MAX_LINE_BET) return { error: '베팅이 너무 커요.' }
  return { lineBet, lines, total: lineBet * lines }
}

// 한 판 결과: 켠 라인마다 당첨 확인 → { grid, wins: [{ line, kind, mult, pay, n }], back }
export function evaluate(stops, lines, lineBet) {
  const grid = window3(stops)
  const wins = []
  let back = 0
  for (let i = 0; i < lines; i++) {
    const rows = LINES[i]
    const w = lineWin(grid[0][rows[0]], grid[1][rows[1]], grid[2][rows[2]])
    if (!w) continue
    const pay = lineBet * w.mult
    wins.push({ line: i, kind: w.kind, mult: w.mult, pay, n: w.n })
    back += pay
  }
  return { grid, wins, back }
}

// 정확한 라인당 기댓값 (돌려받는 칩 / 건 칩)과 당첨 확률. 테스트·페이표 확인용
export function exactRtp() {
  const freq = STRIPS.map(strip => strip.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {}))
  const keys = Object.keys(SYMBOLS)
  let ev = 0, hit = 0
  for (const a of keys) for (const b of keys) for (const c of keys) {
    const pr = (freq[0][a] || 0) * (freq[1][b] || 0) * (freq[2][c] || 0) / REEL_LEN ** 3
    const w = lineWin(a, b, c)
    if (w) { ev += pr * w.mult; hit += pr }
  }
  return { rtp: ev, hit }
}
