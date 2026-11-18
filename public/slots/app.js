// 슬롯머신 화면 (머신 다섯 대 + 모두의 잭팟). 결과는 서버가 정하고, 여기서는 받은 결과를 연출로 보여 주기만 한다.
// 릴은 rules.mjs의 띠 순서 그대로 흘러가서, 멈춘 그림이 서버의 결과와 같다. 과일 폭탄의 새 과일도 서버가 보낸 것.
//
// 화면에서는 '줄'을 고르지 않는다. 베팅 금액 하나만 고르고 줄은 거기서 정해진다:
//   클래식: 베팅 1 → 가운데 줄 1개 · 3 → 가로 3줄 · 5 이상(5의 배수) → 5줄 모두
//   나머지: 베팅 = 단위 × (줄 수 · 과일 폭탄은 25). 다이아몬드는 줄 1개라 아무 금액
import { startGame } from '../shared/casino.js'
import { MACHINES, MACHINE_IDS, SYMBOLS, JACKPOT, TEASE_MS, checkBet, linesOf, exactRtp } from './rules.mjs'
import { burst, flyCoins, floatText, shake, celebrate, celebrating } from './fx.js'

const $ = id => document.getElementById(id)
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
// 좁은 칸용 짧은 숫자: 155,400 → 15.5만 · 31,080,000 → 3,108만 · 2,450,000,000 → 24.5억 (10만 미만은 그대로)
const fmtShort = n => n < 1e5 ? fmt(n) : n < 1e6 ? fmt(Math.floor(n / 1e3) / 10) + '만' : n < 1e8 ? fmt(Math.floor(n / 1e4)) + '만' : fmt(Math.floor(n / 1e7) / 10) + '억'
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const sleep = ms => new Promise(r => setTimeout(r, ms))
const store = { // localStorage 키는 casino:slots: 로 시작
  get(k) { try { return localStorage.getItem('casino:slots:' + k) } catch { return null } },
  set(k, v) { try { localStorage.setItem('casino:slots:' + k, v) } catch {} },
}

const BASE_COLORS = ['#ffd36b', '#ff5a6a', '#4ade80', '#5ac8ff', '#e07bff']
const lineColor = i => BASE_COLORS[i] || `hsl(${(i * 47 + 20) % 360} 85% 66%)`
const COUNT = ['', '한', '두', '세', '네', '다섯']
// 당첨 이름: 'cherry2' → '체리 두 개', 'anyGem' → '보석 섞어 셋'
function kindLabel(k) {
  if (k === 'anyGem') return '보석 섞어 셋'
  const sym = k.replace(/\d+$/, ''), n = Number(k.slice(sym.length))
  return `${SYMBOLS[sym]} ${COUNT[n]} 개${n >= 3 ? '!' : ''}`
}
const main = document.querySelector('.sl')
const TOP = { classic: 'seven3', diamond: 'diamond3', fruit5: 'seven5', lucky: 'moon5' } // 머신의 가장 큰 그림
const TOP_LABEL = { classic: 'JACKPOT 777', diamond: 'DIAMOND!!', fruit5: '7 7 7 7 7', lucky: 'FULL MOON' }
const ICON = { classic: 'seven', diamond: 'diamond', fruit5: 'melon', lucky: 'star' }

// ---------- 머신 ----------
let cur = MACHINES[store.get('machine')] || MACHINES.classic
let lastStops = {} // 서버가 알려 준 머신별 마지막 자리
let jackpotPool = 0, jackpotLast = null

// ---------- 베팅: 금액 하나 → 줄 수·줄당 ----------
const LADDER = []
for (let e = 1; e <= 1e11; e *= 10) LADDER.push(e, 2 * e, 5 * e) // 1, 2, 5, 10, 20, 50 …
function betsOf(m) {
  if (m.lineChoices) return [1, 3, ...LADDER.filter(v => v >= 5 && v % 5 === 0)] // 클래식: 1, 3, 5, 10, 20, 50 …
  return LADDER.map(v => v * linesOf(m))
}
const split = (m, bet) => m.lineChoices
  ? (bet >= 5 ? { lines: 5, lineBet: bet / 5 } : { lines: bet, lineBet: 1 })
  : { lines: linesOf(m), lineBet: bet / linesOf(m) }
function hintOf(m, bet) {
  const { lines } = split(m, bet)
  const jp = '' // 잭팟 확률은 배당표에 (여기는 짧게)
  if (m.lineChoices) return { 1: '가운데 줄 1개만', 3: '가로 줄 3개', 5: '줄 5개 모두' }[lines] + jp
  if (m.type === 'gem') return '가운데 줄 하나 + 배수 릴' + jp
  if (m.type === 'cascade') return '줄 없음 · 연쇄마다 ×1·×2·×3·×5' + jp
  let h = `줄 ${lines}개 모두`
  return h + jp
}
const savedBet = m => { const b = Number(store.get('bet:' + m.id) ?? (m.id === 'classic' ? store.get('bet2') : null)); return betsOf(m).includes(b) ? b : betsOf(m)[m.lineChoices ? 2 : 0] }
let bet = savedBet(cur)

function paintBet() {
  $('bet').textContent = bet >= 1e5 ? fmtShort(bet) : fmt(bet) // 200,000 → 20만 (좁은 화면에서 − + 사이에 들어가게)
  $('bet').title = fmt(bet) + '칩'
  $('betHint').textContent = hintOf(cur, bet)
  const list = betsOf(cur)
  $('betDown').disabled = bet <= list[0]
  $('betUp').disabled = bet >= list.at(-1)
  $('bet').classList.toggle('short', !!game?.me && !busy && game.chips > 0 && game.chips < bet)
  store.set('bet:' + cur.id, String(bet))
  paintPaytables()
  paintSpin()
}
function changeBet(dir) {
  const list = betsOf(cur), i = list.indexOf(bet)
  bet = list[Math.max(0, Math.min(list.length - 1, i + dir))]
  paintBet()
  previewLines()
}
$('betUp').onclick = () => changeBet(1)
$('betDown').onclick = () => changeBet(-1)

// ---------- 전구 ----------
document.querySelectorAll('.sl-bulbs').forEach(b => { for (let i = 0; i < 16; i++) b.append(document.createElement('i')) })

// ---------- 릴 (lines · gem) ----------
// gem은 릴 3개 + 오른쪽 배수 릴(mstrip). 과일 폭탄은 아래 '칸' 쪽에서 따로 그린다
const symSvg = sym => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${sym}"/></svg>`
let reels = []
const tr = (k, count) => `translateY(${(-k / count) * 100}%)`
const stripOf = r => r < cur.reels ? cur.strips[r] : cur.mstrip
const modOf = r => n => { const len = stripOf(r).length; return ((n % len) + len) % len }
const colWeights = () => cur.mstrip ? [...cur.strips.map(() => 1), 0.62] : cur.strips.map(() => 1)

function buildReels() {
  $('reels').replaceChildren()
  main.dataset.reels = cur.reels
  main.dataset.type = cur.type
  const w = colWeights()
  $('reels').style.gridTemplateColumns = w.map(x => `${x}fr`).join(' ')
  $('paylines').setAttribute('viewBox', `0 0 ${w.reduce((a, b) => a + b, 0) * 100} ${(cur.rows || 3) * 100}`)
  reels = w.map((_, r) => {
    const el = document.createElement('div'); el.className = 'sl-reel' + (r >= cur.reels ? ' mreel' : '')
    const strip = document.createElement('div'); strip.className = 'sl-strip'
    el.append(strip); $('reels').append(el)
    return { el, strip, stop: 0 }
  })
  if (cur.type === 'cascade') buildGrid()
}
// 띠의 from부터 count칸을 위에서 아래로 깐다. 띠 높이 = 칸 수 / 3 × 창 높이
function fill(r, from, count) {
  const { strip } = reels[r], st = stripOf(r), mod = modOf(r)
  strip.innerHTML = Array.from({ length: count }, (_, i) => `<div class="sl-cell">${symSvg(st[mod(from + i)])}</div>`).join('')
  strip.style.setProperty('--n', count)
  strip.style.height = (count / 3) * 100 + '%'
}
// 멈춘 모습: s-2 … s+2 다섯 칸, 창에는 가운데 셋 (s-1 · s · s+1)
function setStatic(r, s) {
  if (cur.type === 'cascade') return
  reels[r].stop = modOf(r)(s)
  fill(r, s - 2, 5)
  reels[r].strip.style.transform = tr(1, 5)
}
const cellAt = (r, row) => cur.type === 'cascade' ? gridCells[r][row] : reels[r].strip.children[row + 1]

// 지금 자리에서 target까지 띠를 아래로 흘린다 (번호가 작은 칸이 위에서 내려옴)
function spinTo(r, target, duration, loops) {
  const len = stripOf(r).length, from = reels[r].stop
  const count = modOf(r)(from - target) + len * loops + 5 // target-2 … from+2
  fill(r, target - 2, count)
  const start = count - 4, end = 1
  const { strip } = reels[r]
  strip.style.transform = tr(start, count)
  if (reduced) { setStatic(r, target); return Promise.resolve() }
  strip.classList.add('blur')
  const anim = strip.animate([
    { transform: tr(start, count), easing: 'ease-in' },
    { transform: tr(start + 0.3, count), offset: 0.06, easing: 'cubic-bezier(.45,.05,.3,1)' }, // 살짝 위로 당겼다가
    { transform: tr(end - 0.22, count), offset: 0.93, easing: 'ease-in-out' },                  // 조금 지나쳐서
    { transform: tr(end, count) },                                                              // 제자리
  ], { duration, fill: 'forwards' })
  setTimeout(() => strip.classList.remove('blur'), duration * 0.78)
  return anim.finished.then(() => { anim.cancel(); setStatic(r, target); sfx.stop(); thunk() })
}
// 릴마다 멈추는 시간: 마지막 릴이 약 1.9초 (서버 SPIN_MS 2.3초보다 짧게)
const stopTimes = (n, last = 1900) => Array.from({ length: n }, (_, r) => reduced ? 200 + r * 80 : Math.round(last - (n - 1 - r) * (n > 3 ? 250 : 400)))

// 릴이 멈출 때 몸체가 살짝 덜컹
const cabinet = document.querySelector('.sl-cabinet')
function thunk() { if (!reduced) cabinet.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(0)' }], { duration: 120 }) }

// ---------- 과일 폭탄: 5×4 칸 (돌지 않고 떨어진다) ----------
let gridCells = [] // gridCells[릴][칸] = 칸 요소
let gridNow = null // 지금 보이는 그림
function buildGrid() {
  $('reels').replaceChildren()
  $('reels').style.gridTemplateColumns = `repeat(${cur.reels}, 1fr)`
  gridCells = Array.from({ length: cur.reels }, () => {
    const col = document.createElement('div'); col.className = 'sl-col'
    $('reels').append(col)
    return []
  })
}
function paintGrid(grid) {
  gridNow = grid.map(c => [...c])
  const cols = $('reels').children
  grid.forEach((col, r) => {
    cols[r].innerHTML = col.map(s => `<div class="sl-cell sl-fcell">${symSvg(s)}</div>`).join('')
    gridCells[r] = [...cols[r].children]
  })
}
const gridFromStops = (m, stops) => m.strips.map((st, r) => Array.from({ length: m.rows }, (_, k) => st[((stops[r] - 1 + k) % st.length + st.length) % st.length]))
// 처음: 있던 과일이 아래로 빠지고, 새 과일이 위에서 릴마다 차례로 떨어진다
async function dropIn(grid) {
  const cols = [...$('reels').children]
  if (!reduced && gridNow) {
    await Promise.all(cols.map((c, r) => c.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(110%)', opacity: 0 }], { duration: 260, delay: r * 50, easing: 'ease-in', fill: 'forwards' }).finished))
  }
  paintGrid(grid)
  if (reduced) return
  const anims = []
  cols.forEach((c, r) => {
    c.getAnimations().forEach(a => a.cancel())
    gridCells[r].forEach((el, k) => anims.push(el.animate([{ transform: `translateY(${-(cur.rows + 1) * 100}%)` }, { transform: 'translateY(6%)', offset: 0.85 }, { transform: 'none' }],
      { duration: 520, delay: 140 + r * 130 + (cur.rows - k) * 40, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'backwards' }).finished))
  })
  setTimeout(sfx.stop, 640); setTimeout(sfx.stop, 1100)
  await Promise.all(anims)
}
// 연쇄 한 번: 맞은 칸이 터지고, 남은 과일이 내려오고, 새 과일이 위에서 떨어진다
async function popAndDrop(step) {
  const H = cur.rows
  // 터짐
  const popping = []
  step.removed.forEach((ks, r) => ks.forEach(k => {
    const el = gridCells[r][k]
    el.classList.add('pop')
    if (!reduced) popping.push(el.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.4 }, { transform: 'scale(0)', opacity: 0 }], { duration: 420, easing: 'ease-in', fill: 'forwards' }).finished)
  }))
  sfx.pop()
  await Promise.all(popping)
  // 떨어짐
  const next = gridNow.map((col, r) => [...step.drops[r], ...col.filter((_, k) => !step.removed[r].includes(k))])
  const moves = gridNow.map((col, r) => {
    const n = step.removed[r].length
    const keepRows = col.map((_, k) => k).filter(k => !step.removed[r].includes(k))
    return Array.from({ length: H }, (_, k) => k < n ? -(n + 0.4) : keepRows[k - n] - k) // 새 칸은 위에서, 남은 칸은 원래 자리에서
  })
  paintGrid(next)
  if (reduced) return
  const anims = []
  moves.forEach((mv, r) => mv.forEach((d, k) => {
    if (!d) return
    anims.push(gridCells[r][k].animate([{ transform: `translateY(${d * 100}%)` }, { transform: 'translateY(5%)', offset: 0.85 }, { transform: 'none' }], { duration: 380, delay: r * 30, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'backwards' }).finished)
  }))
  await Promise.all(anims)
  sfx.stop()
}

// ---------- 줄 그리기 ----------
const svgNS = 'http://www.w3.org/2000/svg'
const lineY = row => 50 + row * 100
const colX = r => { const w = colWeights(); let x = 0; for (let i = 0; i < r; i++) x += w[i] * 100; return x + w[r] * 50 }
function drawLine(i, cls) {
  if (cur.type === 'cascade') return
  const rows = cur.lines[i], W = colWeights().reduce((a, b) => a + b, 0) * 100
  const pts = [`-6,${lineY(rows[0])}`, ...rows.map((row, r) => `${colX(r)},${lineY(row)}`), `${W + 6},${lineY(rows.at(-1))}`]
  const pl = document.createElementNS(svgNS, 'polyline')
  pl.setAttribute('points', pts.join(' '))
  pl.setAttribute('stroke', lineColor(i))
  pl.setAttribute('class', cls)
  $('paylines').append(pl)
}
// 베팅을 바꾸면 어느 줄이 걸리는지 잠깐 보여 줌
let previewT
function previewLines() {
  if (busy || cur.type === 'cascade') return
  clearHits()
  for (let i = 0; i < split(cur, bet).lines; i++) drawLine(i, 'preview')
  previewT = setTimeout(() => { if (!busy) $('paylines').replaceChildren() }, 1400)
}
function clearHits() {
  clearTimeout(previewT)
  $('paylines').replaceChildren()
  document.querySelectorAll('.sl-cell.hit').forEach(c => c.classList.remove('hit'))
  main.classList.remove('win', 'big', 'jackpot', 'lose', 'tier-small', 'tier-win', 'tier-nice', 'tier-big', 'tier-mega', 'tier-jackpot')
}
// 당첨 줄·별·웨이 칸 표시. 돌려주는 값: 빛난 칸들의 화면 위치 (동전이 튀어나올 곳)
function markWins(wins, scatter, floatPays = true, stars = false) {
  const rects = []
  const R = cur.reels + (cur.mstrip ? 1 : 0)
  for (const [i, w] of wins.entries()) {
    const color = w.line !== undefined ? lineColor(w.line) : lineColor(i)
    if (w.line !== undefined) drawLine(w.line, 'win')
    const cells = w.cells || cur.lines[w.line].slice(0, w.n).map((row, r) => [r, row])
    for (const [r, row] of cells) {
      const c = cellAt(r, row); if (!c) continue
      c.style.setProperty('--lc', color); c.classList.add('hit')
      rects.push(c.getBoundingClientRect())
    }
    if (floatPays) {
      const [lr, lrow] = cells.at(-1)
      const W = colWeights().reduce((a, b) => a + b, 0)
      const x = cur.type === 'cascade' ? (lr + 0.5) / cur.reels * 100 : colX(lr) / W
      setTimeout(() => floatText($('fxText'), x, (lrow + 0.5) / (cur.rows || 3) * 100, '+' + fmt(w.pay), color), 150)
    }
  }
  if (cur.mstrip && wins.length) { const c = cellAt(R - 1, 1); c.style.setProperty('--lc', '#ffd36b'); c.classList.add('hit') }
  if (scatter?.count && (stars || scatter.pay)) for (const [r, row] of scatter.cells) { // 별은 당첨일 때만 (프리스핀 중엔 늘)
    const c = cellAt(r, row); c.style.setProperty('--lc', '#ffe066'); c.classList.add('hit')
    rects.push(c.getBoundingClientRect())
  }
  return rects
}

// ---------- 소리 (WebAudio, 파일 없음) ----------
let ac = null, soundOn = store.get('sound') !== '0', tickN = 0
function audio() {
  if (!soundOn) return null
  try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume() } catch { return null }
  return ac
}
function tone(freq, at, dur, type = 'square', vol = 0.05) {
  const a = audio(); if (!a) return
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain()
  o.type = type; o.frequency.setValueAtTime(freq, t)
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02)
}
const sfx = {
  lever() { tone(160, 0, 0.1, 'sawtooth', 0.05); tone(95, 0.07, 0.16, 'square', 0.04) },
  tick() { tone(1100 + (tickN++ % 4) * 90, 0, 0.018, 'square', 0.012) },
  stop() { tone(170, 0, 0.08, 'square', 0.06); tone(70, 0, 0.14, 'sine', 0.12) },
  coin() { tone(1568, 0, 0.05, 'square', 0.02); tone(2093, 0.04, 0.06, 'square', 0.015) },
  pop() { tone(520, 0, 0.06, 'triangle', 0.06); tone(880, 0.04, 0.08, 'triangle', 0.05); tone(1320, 0.08, 0.06, 'sine', 0.04) },
  chain(n) { [0, 1, 2].forEach(i => tone(660 * 2 ** ((n + i) / 6), i * 0.06, 0.12, 'square', 0.04)) },
  heart(k) { tone(70 + k * 40, 0, 0.12, 'sine', 0.16); tone(70 + k * 40, 0.16, 0.1, 'sine', 0.1); tone(600 + k * 500, 0, 0.05, 'square', 0.015) },
  nice() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.07, 0.14, 'square', 0.045)) },
  lose() { tone(330, 0, 0.12, 'triangle', 0.04); tone(247, 0.12, 0.2, 'triangle', 0.04) },
  win(big) {
    const notes = big ? [523, 659, 784, 1047, 784, 1047, 1319] : [659, 784, 1047]
    notes.forEach((f, i) => tone(f, i * 0.09, 0.16, 'square', 0.04))
  },
  bonus() { [392, 523, 659, 784, 1047, 1319, 1568].forEach((f, i) => { tone(f, i * 0.08, 0.2, 'square', 0.05); tone(f * 1.5, i * 0.08 + 0.04, 0.12, 'triangle', 0.03) }) },
  jackpot() { [523, 659, 784, 1047, 1319, 1568, 2093, 1568, 2093].forEach((f, i) => { tone(f, i * 0.11, 0.22, 'square', 0.05); tone(f / 2, i * 0.11, 0.22, 'triangle', 0.05) }) },
}
let tickTimer = null
const ticking = on => { clearInterval(tickTimer); if (on && soundOn && !reduced) tickTimer = setInterval(sfx.tick, 70) }
const SPEAKER = on => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor"/>${on
  ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>'
  : '<path d="M16.5 9.5l5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'}</svg>`
function paintSound() {
  $('sound').innerHTML = SPEAKER(soundOn)
  $('sound').setAttribute('aria-pressed', String(soundOn))
  $('sound').setAttribute('aria-label', soundOn ? '소리 끄기' : '소리 켜기')
}
$('sound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn ? '1' : '0'); paintSound(); if (soundOn) sfx.coin() }

// ---------- 결과 표시 ----------
function say(title, amt = '', sub = '') {
  $('resTitle').textContent = title
  $('resAmt').textContent = amt
  $('resSub').textContent = sub
}
let countRaf = 0
function countUp(to, from = 0) {
  cancelAnimationFrame(countRaf)
  const el = $('resAmt')
  const dur = reduced ? 0 : Math.min(1800, 350 + Math.log10(to - from + 1) * 320)
  const t0 = performance.now()
  let lastTick = 0
  const step = now => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1
    el.textContent = '+' + fmt(Math.round(from + (to - from) * (1 - (1 - k) ** 3)))
    if (now - lastTick > 85 && k < 1) { sfx.coin(); lastTick = now }
    if (k < 1) countRaf = requestAnimationFrame(step)
  }
  countRaf = requestAnimationFrame(step)
}

// 당첨 크기에 따라 연출 단계: 손해(돌려받음) < 당첨 < 나이스 < 빅윈 < 메가 < 그 머신의 가장 큰 그림
function tierOf(back, total, wins = []) {
  if (wins.some(w => w.kind === TOP[cur.id])) return 'jackpot'
  const k = back / total
  return k >= 50 ? 'mega' : k >= 10 ? 'big' : k >= 3 ? 'nice' : k >= 1 ? 'win' : k > 0 ? 'small' : 'lose'
}
let streak = 0
const center = r => [r.left + r.width / 2, r.top + r.height / 2]
const netText = (total, back) => { const net = back - total; return `${fmt(total)}칩 걸고 ${fmt(back)}칩 받음 · ` + (net > 0 ? `${fmt(net)}칩 이득` : net === 0 ? '본전' : `${fmt(-net)}칩 손해`) }

// 한 판(또는 프리스핀 한 번)의 결과 연출. big 이상은 전체 화면을 닫을 때까지 기다린다
function showResult({ wins, scatter, back, total, title, sub, final = true, celebrateBig = true, mark = true, stars = false }) {
  return new Promise(resolve => {
    const sorted = [...wins].sort((a, b) => b.pay - a.pay)
    const tier = tierOf(back, total, wins)
    const rects = mark ? markWins(wins, scatter, tier !== 'small', stars) : []
    if (scatter?.pay) setTimeout(() => floatText($('fxText'), 50, 50, `${SYMBOLS[cur.scatter.symbol]} ${scatter.count}개 +${fmt(scatter.pay)}`, '#ffe066'), 150)
    if (tier === 'lose') {
      if (final) { main.classList.add('lose'); say(title || '꽝', '', sub ?? `${fmt(total)}칩을 잃었어요 · 다시 해 볼까요?`); sfx.lose() }
      return resolve(tier)
    }
    main.classList.add('win', 'tier-' + tier)
    if (['big', 'mega', 'jackpot'].includes(tier)) main.classList.add('big')
    if (tier === 'jackpot') main.classList.add('jackpot')
    const head = title || (sorted[0] ? kindLabel(sorted[0].kind) : `별 ${scatter.count}개!`) + (sorted.length > 1 ? ` 외 ${sorted.length - 1}개` : '')
    if (final) say(head, '', sub ?? netText(total, back) + (streak >= 2 ? ` · 🔥 ${streak}연속!` : ''))
    if (tier === 'small') { if (final) countUp(back); sfx.coin(); return resolve(tier) }

    // 당첨 칸에서 동전이 튀고, 남은 칩으로 날아감 (칸이 없으면 릴 가운데서)
    const some = rects.length ? rects.slice(0, 6) : [$('reels').getBoundingClientRect()]
    some.forEach(r => burst(...center(r), tier === 'win' ? 6 : 12, { power: tier === 'win' ? 0.7 : 1, confetti: tier === 'win' ? 0 : 8 }))
    if (final) flyCoins(some, $('credit'), tier === 'win' ? 6 : 12)
    if (tier === 'win') { if (final) countUp(back); sfx.win(false); return resolve(tier) }
    if (tier === 'nice' || !celebrateBig) {
      if (final) countUp(back)
      sfx.nice()
      floatText($('fxText'), 50, 50, 'NICE!', '#fff1b8', true)
      shake(document.querySelector('.sl-machine'), 0.5)
      return resolve(tier)
    }
    // 빅윈 이상: 당첨을 잠깐 보여 준 뒤 전체 화면
    setAuto(false)
    const wr = $('reels').getBoundingClientRect()
    shake(document.querySelector('.sl-machine'), tier === 'big' ? 1 : 1.6)
    burst(wr.left + wr.width / 2, wr.top + wr.height / 2, 30, { power: 1.3, confetti: 30 })
    if (tier === 'jackpot') sfx.jackpot(); else sfx.win(true)
    $('resAmt').textContent = '+' + fmt(back)
    setTimeout(() => celebrate({
      tier, amount: back, fmt, label: tier === 'jackpot' ? TOP_LABEL[cur.id] : null,
      sub: `${head} · ${fmt(total)}칩 걸고 ${fmt(back)}칩!`,
      onTick: () => sfx.coin(),
      onDone: () => resolve(tier),
    }), 650)
  })
}

// ---------- 프리스핀 (럭키 스타): 별이 뜰 때마다 배수 +1, 별 셋이면 +3번 ----------
// 서버가 결과를 미리 보내 준다. 연출이 끝나면 서버가 정산 (건너뛰기 = 서버에 skip → 바로 정산)
let skipping = false
$('fsSkip').onclick = () => { if (!skipping) { skipping = true; game.send({ t: 'skip' }) } }
async function playBonus(m) {
  const b = m.bonus
  skipping = false
  let left = cur.scatter.freeSpins, mult = 1, sum = 0
  const paint = () => { $('fsN').textContent = left; $('fsMult').textContent = mult; $('fsTotal').textContent = fmt(sum) }
  $('fsBannerSub').textContent = `${left}번 · 별이 뜰 때마다 배수 +1`
  $('fsBanner').hidden = false
  main.classList.add('bonus')
  sfx.bonus()
  const wr = $('reels').getBoundingClientRect()
  burst(wr.left + wr.width / 2, wr.top + wr.height / 2, 24, { power: 1.2, confetti: 40 })
  say('프리스핀!', '', `별 ${m.scatter.count}개 · 공짜로 ${left}번`)
  await sleep(reduced ? 600 : 2000)
  $('fsBanner').hidden = true
  $('fsBar').hidden = false
  paint()
  for (const s of b.spins) {
    left--
    clearHits(); main.classList.add('bonus')
    if (skipping) { s.stops.forEach((st, r) => setStatic(r, st)) } else {
      ticking(true)
      await Promise.all(s.stops.map((st, r) => spinTo(r, st, stopTimes(cur.reels, 1150)[r], 1 + Math.floor(r / 2))))
      ticking(false)
    }
    if (s.stars) { // 별이 떴다: 배수 +별 수
      mult = s.mult
      if (!skipping) {
        markWins([], s.scatter, false, true)
        floatText($('fxText'), 50, 30, `배수 ×${mult}`, '#ffe066', true)
        $('fsBar').classList.remove('bump'); void $('fsBar').offsetWidth; $('fsBar').classList.add('bump')
        sfx.chain(mult)
        await sleep(500)
      }
    }
    if (s.more) { left += s.more; if (!skipping) { floatText($('fxText'), 50, 60, `+${s.more}번!`, '#b8f5ff', true); sfx.bonus(); await sleep(700) } }
    sum += s.back
    paint()
    if (!skipping) {
      if (s.back) { await showResult({ wins: s.wins, scatter: null, back: s.back, total: m.total, final: false, celebrateBig: false }); countUp(sum, sum - s.back) }
      await sleep(s.back ? 600 : 300)
    }
  }
  $('fsBar').hidden = true
  main.classList.remove('bonus')
  return sum
}

// ---------- 과일 폭탄 한 판 ----------
async function playCascade(m) {
  const g0 = gridFromStops(cur, m.stops)
  await dropIn(g0)
  let sum = 0
  for (const [i, s] of (m.steps || []).entries()) {
    clearHits()
    markWins(s.wins, null, true)
    if (s.chain > 1) { floatText($('fxText'), 50, 45, `연쇄 ×${s.chain}`, '#fff1b8', true); sfx.chain(i * 2) } else sfx.coin()
    sum += s.pay
    say(`${i + 1}연쇄${s.chain > 1 ? ` ×${s.chain}` : ''}`, '+' + fmt(sum), s.wins.map(w => `${SYMBOLS[w.sym]} ${w.n}릴 ×${w.ways}웨이`).join(' · '))
    await sleep(reduced ? 150 : i < 3 ? 650 : 380)
    await popAndDrop(s)
  }
  clearHits()
  const wins = (m.steps || []).flatMap(s => s.wins)
  const steps = (m.steps || []).length
  return showResult({ wins, scatter: null, back: m.base, total: m.total, mark: false,
    title: steps ? (steps > 1 ? `${steps}연쇄!` : kindLabel(wins.sort((a, b) => b.pay - a.pay)[0].kind)) : '꽝' })
}

// ---------- 모두의 잭팟 ----------
let jpShown = 0, jpRaf = 0
function paintJackpot() {
  cancelAnimationFrame(jpRaf)
  const from = jpShown || jackpotPool, to = jackpotPool, t0 = performance.now()
  if (!jpShown || reduced) { jpShown = to; $('gjpPool').textContent = fmt(Math.floor(to)); $('jpPool').textContent = fmt(Math.floor(to)) }
  const step = now => {
    const k = Math.min(1, (now - t0) / 900); jpShown = from + (to - from) * k
    $('gjpPool').textContent = fmt(Math.floor(jpShown)); $('jpPool').textContent = fmt(Math.floor(jpShown))
    if (k < 1) jpRaf = requestAnimationFrame(step)
  }
  jpRaf = requestAnimationFrame(step)
  const last = jackpotLast ? `최근 ${jackpotLast.name} +${fmtShort(jackpotLast.win)}${jackpotLast.machine ? ' · ' + (MACHINES[jackpotLast.machine]?.short || '') : ''}` : '어느 머신이든 터질 수 있어요'
  $('gjpLast').textContent = last; $('jpLast').textContent = last
  $('jpBox').hidden = true // 키 작은 휴대폰에서만 CSS로 보임 (모두의 잭팟 줄 대신)
}
async function playJackpot(m) {
  const j = m.jackpot
  setAuto(false)
  main.classList.add('jp-hit')
  say('미스터리 잭팟!!', '', '아무 머신에서나 갑자기 터지는 모두의 잭팟')
  if (!reduced) {
    $('gjp').classList.add('hit')
    for (let i = 0; i < 6; i++) { tone(400 + i * 120, i * 0.12, 0.1, 'square', 0.05) }
    await sleep(1400)
  }
  await new Promise(resolve => celebrate({
    tier: 'jackpot', amount: j.win, fmt, label: 'MYSTERY JACKPOT',
    sub: `모두의 잭팟! · ${fmt(m.total)}칩 걸고 ${fmt(m.back)}칩`,
    onTick: () => sfx.coin(), onDone: resolve,
  }))
  sfx.jackpot()
  $('gjp').classList.remove('hit'); main.classList.remove('jp-hit')
  say(`잭팟 +${fmt(j.win)}`, '+' + fmt(m.back), netText(m.total, m.back))
}

// ---------- 배당표 (지금 베팅으로 받는 칩) ----------
function lineMini(m, i, on) {
  const R = m.reels, rows = m.lines[i], c = lineColor(i)
  const dots = Array.from({ length: R }, (_, x) => [0, 1, 2].map(y => `<rect x="${x * 10 + 1}" y="${y * 10 + 1}" width="8" height="8" rx="1.5" fill="${rows[x] === y ? c : '#3a3428'}"/>`).join('')).join('')
  const pts = rows.map((row, x) => `${x * 10 + 5},${row * 10 + 5}`).join(' ')
  return `<svg viewBox="0 0 ${R * 10} 30" style="aspect-ratio:${R}/3" class="${on ? '' : 'off'}" aria-hidden="true">${dots}<polyline points="0,${rows[0] * 10 + 5} ${pts} ${R * 10},${rows.at(-1) * 10 + 5}" stroke="${c}" stroke-width="1.6" fill="none"/></svg>`
}
function paintPaytables() {
  const m = cur, { lines, lineBet } = split(m, bet), total = lineBet * lines
  const ic = s => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${s}"/></svg>`
  const amt = x => `<b title="${fmt(x)}칩">${fmtShort(x)}칩</b>`
  const any = '<span class="any">?</span>'
  let rows = ''
  if (m.type === 'gem') {
    const W = m.wildPays
    rows += `<li class="top"><span class="icons">${ic('diamond').repeat(3)}</span><span class="lbl">다이아 셋 (× 배수 릴)</span>${amt(lineBet * W[3])}</li>`
    for (const [s, p] of Object.entries(m.pays)) rows += `<li><span class="icons">${ic(s).repeat(3)}</span><span class="lbl">${SYMBOLS[s]} 셋 · 다이아 섞이면 ×2·×4</span>${amt(lineBet * p[3])}</li>`
    rows += `<li><span class="icons">${ic('ruby')}${ic('sapphire')}${ic('emerald')}</span><span class="lbl">보석 섞어 셋</span>${amt(lineBet * m.anyGem)}</li>`
    rows += `<li><span class="icons">${ic('diamond').repeat(2)}${any}</span><span class="lbl">다이아 둘 (어디든)</span>${amt(lineBet * W[2])}</li>`
    rows += `<li><span class="icons">${ic('diamond')}${any}${any}</span><span class="lbl">다이아 하나 (어디든)</span>${amt(lineBet * W[1])}</li>`
    const mf = {}; for (const x of m.mstrip) mf[x] = (mf[x] || 0) + 1
    rows += `<li class="row5"><span class="icons">${ic('x5')}</span><span class="lbl">배수 릴</span><span class="n5">${Object.entries(mf).map(([k, n]) => `<em>${Math.round(n / m.mstrip.length * 100)}%</em> ${SYMBOLS[k]}`).join('')}</span></li>`
  } else if (m.type === 'cascade') {
    for (const [s, p] of Object.entries(m.pays)) {
      const top = s === 'seven'
      rows += `<li class="row5 ${top ? 'top' : ''}"><span class="icons">${ic(s)}</span><span class="lbl">${SYMBOLS[s]}</span><span class="n5">${[3, 4, 5].map(n => `<em>${n}릴</em> ${fmtShort(lineBet * p[n])}`).join('')}</span></li>`
    }
  } else {
    if (m.scatter?.freeSpins) {
      const sc = m.scatter
      rows += `<li class="top"><span class="icons" role="img" aria-label="별 3개">${ic('star').repeat(3)}</span><span class="lbl">별 3개 어디든 → 프리스핀 ${sc.freeSpins}번, 별마다 배수 +1</span>${amt(sc.pays[3] * total)}</li>`
      rows += `<li><span class="icons">${ic('star')}<span class="any">4·5</span></span><span class="lbl">별 4개 · 5개</span><b>${fmtShort(sc.pays[4] * total)} · ${fmtShort(sc.pays[5] * total)}칩</b></li>`
    }
    for (const [s, p] of Object.entries(m.pays)) {
      const ns = Object.keys(p).map(Number).sort((a, b) => b - a)
      if (m.reels === 3) {
        for (const n of ns) {
          const label = n === 3 ? `${SYMBOLS[s]} 3개` : n === 2 ? `${SYMBOLS[s]} 2개 (왼쪽부터)` : `${SYMBOLS[s]} 1개 (맨 왼쪽)`
          const top = s + n === TOP[m.id]
          rows += `<li class="${top ? 'top' : ''}"><span class="icons" role="img" aria-label="${label}">${ic(s).repeat(n)}${any.repeat(3 - n)}</span><span class="lbl">${label}</span>${amt(lineBet * p[n])}</li>`
        }
      } else { // 5릴: 그림 하나에 한 줄, 개수별 칩
        rows += `<li class="row5 ${s + 5 === TOP[m.id] ? 'top' : ''}"><span class="icons" role="img" aria-label="${SYMBOLS[s]}">${ic(s)}</span><span class="lbl">${SYMBOLS[s]}</span><span class="n5">${ns.sort((a, b) => a - b).map(n => `<em>${n}개</em> ${fmtShort(lineBet * p[n])}`).join('')}</span></li>`
      }
    }
  }
  const how = m.type === 'gem' ? '가운데 줄 하나만 봐요. 다이아는 아무 그림이나 대신하고, 섞일 때마다 ×2. 당첨에 오른쪽 배수 릴의 가운데 값을 곱해요. '
    : m.type === 'cascade' ? '줄이 없어요. 맨 왼쪽 릴부터 같은 과일이 있는 릴이 3개 이상 이어지면 당첨, 릴마다 그 과일 칸 수를 곱한 만큼(웨이) 받아요. 맞은 과일은 터지고 위에서 새 과일이 떨어져 또 맞으면 연쇄 — 배수 ×1 → ×2 → ×3 → ×5. 위 칩은 웨이 하나 값이에요. '
    : m.scatter ? '별은 줄과 상관없이 창 어디든 세요. 프리스핀은 공짜이고, 별이 뜰 때마다 배수가 1씩 커져 끝까지 유지돼요. 프리스핀 중 별 셋이면 3번 더. '
    : '같은 그림이 걸린 줄 위에 <b>왼쪽부터</b> 이어지면 당첨. 여러 줄이 함께 맞으면 모두 더해 받아요. '
  const rtp = exactRtp(m).rtp ?? m.rtpRef
  const linesHtml = m.type === 'lines' ? `<p class="sl-lines-title">당첨되는 줄 <small>(${hintOf(m, bet).split(' · ')[0]})</small></p>
    <div class="sl-lines r${m.reels}">${m.lines.map((_, i) => lineMini(m, i, i < lines)).join('')}</div>` : ''
  const html = `<ul class="sl-paylist">${rows}</ul>${linesHtml}
    <p class="sl-note">${how}<b>모두의 잭팟</b>: 어느 머신이든 베팅의 2%가 쌓이고, 판마다 베팅 ÷ ${fmt(JACKPOT.odds)} 확률로 전부 가져가요 (지금 베팅이면 1/${fmt(Math.round(JACKPOT.odds / bet))}).
    이론 환급률(RTP) 약 ${rtp ? (rtp * 100).toFixed(1) : '100'}% + 잭팟 2% · 결과는 서버가 정해요. 코인은 게임용이며 현금이나 상품으로 바꿀 수 없어요.</p>`
  document.querySelectorAll('[data-paytable]').forEach(el => { el.innerHTML = html })
  $('payFor').textContent = $('helpFor').textContent = `${m.name} · 베팅 ${fmt(bet)}칩일 때 받는 칩`
}

// ---------- 남은 칩 (몸체 숫자판). 숫자는 서버가 보낸 칩만 ----------
// 도는 동안 늘어나는 숫자는 잡아 뒀다가 연출이 끝나면 굴러 올라가게 (결과가 미리 보이지 않게)
let creditShown = null, creditRaf = 0
function paintCredit(chips, force = false) {
  const el = $('credit')
  $('creditBar').hidden = !game?.me
  if (busy && !force && creditShown !== null && chips > creditShown) return
  cancelAnimationFrame(creditRaf)
  const from = creditShown ?? chips
  creditShown = chips
  // 큰 숫자는 몸체 밖으로 안 나가게: 1,000만 이상은 짧게(1,234만), 그 아래 8자리 넘으면 글자만 조금 작게
  const show = n => n >= 1e7 ? fmtShort(n) : fmt(n)
  el.dataset.len = show(chips).length > 8 ? 'l' : ''
  el.title = fmt(chips) + '칩'
  if (chips <= from || reduced) { el.textContent = show(chips); return }
  const t0 = performance.now(), dur = Math.min(1200, 300 + Math.log10(chips - from + 1) * 250)
  const step = now => {
    const k = Math.min(1, (now - t0) / dur)
    el.textContent = show(Math.round(from + (chips - from) * (1 - (1 - k) ** 3)))
    if (k < 1) creditRaf = requestAnimationFrame(step)
  }
  creditRaf = requestAnimationFrame(step)
}
$('creditAdd').onclick = () => game?.openBuyIn()

// ---------- 머신 고르기 ----------
function paintPick() {
  $('pick').innerHTML = MACHINE_IDS.map(id => {
    const m = MACHINES[id]
    const sub = m.type === 'gem' ? '와일드·배수' : m.type === 'cascade' ? '연쇄 폭발' : m.scatter ? '프리스핀' : '3릴 · 5줄'
    return `<button type="button" data-id="${id}" aria-pressed="${id === cur.id}"><span class="ic">${symSvg(ICON[id])}</span><b>${m.short}</b><small>${sub}</small></button>`
  }).join('')
  $('pick').querySelectorAll('button').forEach(b => b.onclick = () => switchMachine(b.dataset.id))
  paintJackpot()
}
function showMachine() {
  main.dataset.machine = cur.id
  $('mName').textContent = cur.name
  buildReels()
  const st = lastStops[cur.id] || defaultStops(cur)
  if (cur.type === 'cascade') paintGrid(gridFromStops(cur, st)); else st.forEach((s, r) => setStatic(r, s))
}
function switchMachine(id) {
  if (busy || id === cur.id || !MACHINES[id]) return
  setAuto(false); queued = false
  cur = MACHINES[id]
  store.set('machine', id)
  bet = savedBet(cur)
  showMachine()
  clearHits()
  say(cur.name, '', cur.desc)
  $('pick').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === id)))
  paintBet(); paintJackpot()
  requestAnimationFrame(layoutLever)
}
// 처음 보이는 그림: 머신의 대표 그림이 가운데 줄에
const defaultStops = m => {
  const s = { classic: 'seven', diamond: 'diamond', fruit5: 'seven', lucky: 'moon' }[m.id]
  const st = m.strips.map(x => Math.max(0, x.indexOf(s)))
  if (m.mstrip) st.push(Math.max(0, m.mstrip.indexOf('x10')))
  return st
}

// ---------- 돌리기 ----------
let game = null, busy = false, queued = false, waitT = null, awaiting = false, auto = false
function setBusy(on) {
  busy = on
  $('lever').classList.toggle('locked', on)
  main.classList.toggle('spinning', on)
  if (!on && game) paintCredit(game.chips, true)
  paintBet()
}
function setAuto(on) {
  auto = on
  $('auto').setAttribute('aria-pressed', String(on))
  $('auto').textContent = on ? '멈춤' : '자동'
}
// 큰 버튼 글자: 지금 할 일을 알려 줌
function paintSpin() {
  const b = $('spin')
  const label = !game ? 'SPIN' : !game.me ? '로그인' : !game.chips && !game.inPlay && !busy ? '칩 바꾸기' : 'SPIN'
  b.textContent = label
  b.classList.toggle('word', label !== 'SPIN')
  b.disabled = busy
  $('leverTip').hidden = label !== 'SPIN' || busy || !!store.get('pulled')
}

function requestSpin() {
  if (!game) return
  if (!game.me) return game.openBuyIn() // 로그인 화면으로
  if (busy) return
  const { lines, lineBet } = split(cur, bet)
  const ok = checkBet(cur, lineBet, lines)
  if (ok.error) { setAuto(false); return game.toast(ok.error) }
  if (game.inPlay > 0) { queued = true; return } // 앞 판 정산이 오면 바로
  if (!game.chips) { setAuto(false); return game.openBuyIn() }
  if (ok.total > game.chips) { setAuto(false); return game.toast(`칩이 모자라요. 베팅을 ${fmt(game.chips)}칩 이하로 줄이거나 칩을 바꿔 주세요.`) }
  queued = false
  store.set('pulled', '1')
  setBusy(true)
  clearHits()
  cancelAnimationFrame(countRaf)
  say('돌아가는 중…', '', `${fmt(ok.total)}칩 걸었어요`)
  sfx.lever()
  game.send({ t: 'spin', machine: cur.id, lineBet, lines })
  clearTimeout(waitT)
  awaiting = true
  waitT = setTimeout(() => refused('다시 눌러 주세요'), 2500) // 답이 없으면 (연결 끊김 등)
}
// 서버가 스핀을 거절하면 (onToast) 바로 다시 누를 수 있게
function refused(msg) {
  if (!awaiting) return
  awaiting = false
  clearTimeout(waitT)
  setBusy(false); setAuto(false)
  say(msg)
}

let playing = false
async function onSpun(m) {
  if (playing) return // 연출 중에 또 오는 일은 없지만 (서버가 한 번에 한 판만), 겹치지 않게
  playing = true
  try { await playSpin(m) } catch (err) { console.error('[slots]', err) } finally { // 연출이 깨져도 기계는 풀어 줌
    playing = false
    clearInterval(tickTimer); main.classList.remove('teasing', 'bonus', 'jp-hit'); $('fsBar').hidden = true; $('fsBanner').hidden = true
    setBusy(false)
  }
  if (auto && !celebrating()) setTimeout(() => { if (auto) requestSpin() }, m.back ? 1300 : 450)
}
async function playSpin(m) {
  clearTimeout(waitT)
  awaiting = false
  if (m.machine !== cur.id) { busy = false; switchMachine(m.machine) } // 다른 탭에서 돌린 판
  lastStops[m.machine] = m.stops
  setBusy(true)
  const net = m.back - m.total
  streak = net > 0 ? streak + 1 : 0
  if (cur.type === 'cascade') {
    await playCascade(m)
  } else {
    ticking(true)
    const R = reels.length, times = stopTimes(R)
    if (m.tease) times[R - 1] += TEASE_MS // 서버도 정산을 그만큼 늦춤 (rules.mjs teases)
    const spins = m.stops.map((s, r) => spinTo(r, s, times[r], r === R - 1 && m.tease ? 6 : 2 + Math.floor(r * 3 / R)))
    if (m.tease) {
      // 마지막 릴만 남았을 때: 그 릴만 금빛으로 두근두근
      await spins[R - 2]
      ticking(false)
      reels[R - 1].el.classList.add('tease'); main.classList.add('teasing')
      say('두근두근…', '', cur.type === 'gem' ? '배수는 얼마?' : m.scatter && m.scatter.count >= (cur.scatter?.trigger || 9) - 1 ? '별 하나만 더!' : '마지막 하나만 맞으면!')
      let k = 0
      const beat = setInterval(() => sfx.heart(Math.min(1, k++ / 8)), 330)
      await spins[R - 1]
      clearInterval(beat)
      reels[R - 1].el.classList.remove('tease'); main.classList.remove('teasing')
    }
    await Promise.all(spins)
    ticking(false)
    if (m.bonus) {
      await showResult({ wins: m.wins, scatter: m.scatter, back: m.base, total: m.total, final: false, celebrateBig: false })
      await sleep(reduced ? 200 : 900)
      const fs = await playBonus(m)
      clearHits()
      const all = m.base + fs
      const tier = await showResult({ wins: [], scatter: null, back: all, total: m.total, title: `프리스핀 합계 +${fmt(fs)}`, mark: false,
        sub: `${fmt(m.total)}칩 걸고 ${fmt(all)}칩 받음 (프리스핀 ${fmt(fs)} · 배수 ×${m.bonus.mult})` })
      if (tier === 'lose') say('프리스핀 끝', '', '이번엔 아쉬워요')
    } else {
      const extra = m.mreel && m.wins.length ? ` · 배수 ×${m.mreel.value}` : ''
      await showResult({ wins: m.wins, scatter: m.scatter, back: m.base, total: m.total,
        sub: m.base ? netText(m.total, m.base) + extra : undefined })
    }
  }
  if (m.jackpot) await playJackpot(m)
}

// ---------- 레버 ----------
const lever = $('lever'), rod = $('leverRod'), knob = $('leverKnob')
let pull = 0, pivot = 200, reach = 90, springRaf = 0
function layoutLever() {
  const win = document.querySelector('.sl-window'), mach = document.querySelector('.sl-machine')
  pivot = win.getBoundingClientRect().top - mach.getBoundingClientRect().top + win.offsetHeight / 2
  reach = Math.min(110, Math.max(60, win.offsetHeight * 0.48))
  lever.style.setProperty('--pivot', pivot + 'px')
  lever.style.setProperty('--knob0', pivot - reach + 'px')
  drawLever()
}
function drawLever() {
  const y = pivot - reach + pull * reach * 1.75 // 위 → 받침 아래까지
  knob.style.top = y + 'px'
  knob.style.transform = `scale(${1 + pull * 0.22})` // 당기면 앞으로 다가오는 느낌
  rod.style.top = Math.min(y, pivot) + 'px'
  rod.style.height = Math.abs(y - pivot) + 'px'
}
function animatePull(to, ms, done) {
  cancelAnimationFrame(springRaf)
  const from = pull, t0 = performance.now()
  const ease = to === 0 ? k => 1 - (1 - k) ** 3 * Math.cos(k * 7) : k => k * k // 돌아올 때 살짝 튕김
  const step = now => {
    const k = Math.min(1, (now - t0) / ms)
    pull = from + (to - from) * ease(k)
    drawLever()
    if (k < 1) springRaf = requestAnimationFrame(step); else { pull = to; drawLever(); done?.() }
  }
  springRaf = requestAnimationFrame(step)
}
let drag = null
lever.addEventListener('pointerdown', e => {
  if (busy) return
  cancelAnimationFrame(springRaf)
  drag = { y: e.clientY, pull, moved: 0 }
  lever.setPointerCapture(e.pointerId)
})
lever.addEventListener('pointermove', e => {
  if (!drag) return
  drag.moved = Math.max(drag.moved, Math.abs(e.clientY - drag.y))
  pull = Math.max(0, Math.min(1, drag.pull + (e.clientY - drag.y) / (reach * 1.75)))
  drawLever()
})
const release = e => {
  if (!drag) return
  const d = drag; drag = null
  if (e.type === 'pointercancel') return animatePull(0, 450)
  if (d.moved < 6) return animatePull(1, 150, () => { requestSpin(); animatePull(0, 520) }) // 누르기만 해도 당김
  if (pull > 0.6) requestSpin()
  animatePull(0, 520)
}
lever.addEventListener('pointerup', release)
lever.addEventListener('pointercancel', release)
new ResizeObserver(layoutLever).observe(document.querySelector('.sl-window'))

$('spin').onclick = () => {
  if (busy) return
  if ($('spin').textContent === 'SPIN') animatePull(1, 150, () => animatePull(0, 520))
  requestSpin()
}
$('auto').onclick = () => { setAuto(!auto); if (auto && !busy) requestSpin() }
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.target !== document.body || e.repeat) return
  e.preventDefault(); $('spin').click()
})

// ---------- 하는 법 (처음 한 번 자동으로) ----------
const helpDlg = $('helpDlg')
$('help').onclick = () => helpDlg.showModal()
$('helpOk').onclick = () => {
  helpDlg.close()
  store.set('guide', '1')
  if (game?.me && !game.chips && !game.inPlay) game.openBuyIn()
}
const firstVisit = !store.get('guide')

// ---------- 시작 ----------
showMachine()
paintPick(); paintSound(); paintBet(); layoutLever()
if (firstVisit) helpDlg.showModal()

game = await startGame({
  autoBuyIn: !firstVisit, // 처음이면 안내를 먼저 보고 '시작하기'에서 칩 바꾸기
  bustDelay: 1500, // 칩을 다 잃었을 때 파산 안내는 릴이 멈추고 결과를 본 뒤에
  onToast(d) { refused(d.msg) }, // 알림 자체는 기본대로 띄움
  onLoggedOut() { $('creditBar').hidden = true; say('로그인하면 할 수 있어요', '', '로그인 버튼을 눌러 시작해요'); paintSpin() },
  onReady() { paintBet(); paintCredit(game?.chips ?? 0) },
  onChips({ chips, inPlay }) {
    paintCredit(chips)
    paintBet()
    if (!inPlay && queued && !busy) requestSpin()
  },
  onMessage(m) {
    if (m.t === 'hello') {
      lastStops = m.stops && !Array.isArray(m.stops) ? m.stops : {}
      if (!busy && lastStops[cur.id]) showMachine()
      if (m.jackpot) { jackpotPool = m.jackpot.pool; jackpotLast = m.jackpot.last; paintJackpot() }
      return
    }
    if (m.t === 'jackpot') {
      const hit = m.last && (!jackpotLast || m.last.at !== jackpotLast.at)
      jackpotPool = m.pool; jackpotLast = m.last; paintJackpot()
      if (hit && !busy) game.toast(`🎉 ${m.last.name} 님이 모두의 잭팟 ${fmt(m.last.win)}칩!`)
      return
    }
    if (m.t === 'spun') return onSpun(m)
  },
})
paintBet()

// ---------- JMTT 홈으로 (윗줄은 공통 부품이라 여기서 링크만 덧붙임) ----------
// 칩이 있으면 나가기(남은 칩 → 코인, 도는 스핀은 정해진 결과대로 정산)를 보낸 뒤 이동
{
  const a = document.createElement('a')
  a.className = 'casino-back sl-jmtt'
  a.href = '/'
  a.textContent = 'JMTT'
  a.title = 'JMTT 홈으로 (남은 칩은 코인으로 돌려받아요)'
  document.querySelector('.casino-top [data-back]')?.after(a)
  a.onclick = e => {
    if (!game?.me || (!game.chips && !game.inPlay)) return
    e.preventDefault()
    game.send({ t: 'leave' })
    setTimeout(() => { location.href = '/' }, 200)
  }
}
