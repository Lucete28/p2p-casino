// 슬롯머신 화면 (머신 다섯 대). 결과(멈출 자리)는 서버가 정하고, 여기서는 받은 자리까지 릴을 돌려 보여 주기만 한다.
// 릴은 rules.mjs의 띠 순서 그대로 흘러가서, 멈춘 그림이 서버의 결과와 같다.
//
// 화면에서는 '줄'을 고르지 않는다. 베팅 금액 하나만 고르고 줄은 거기서 정해진다:
//   클래식: 베팅 1 → 가운데 줄 1개 · 3 → 가로 3줄 · 5 이상(5의 배수) → 5줄 모두
//   나머지: 늘 줄 전부, 베팅 = 줄당 × 줄 수 (과일 5릴 20줄이면 20 · 40 · 100 …)
import { startGame } from '../shared/casino.js'
import { MACHINES, MACHINE_IDS, SYMBOLS, TEASE_MS, checkBet, evaluate, exactRtp } from './rules.mjs'
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
const kindLabel = k => { const sym = k.replace(/\d+$/, ''), n = Number(k.slice(sym.length)); return `${SYMBOLS[sym]} ${COUNT[n]} 개${n >= 3 ? '!' : ''}` }
const main = document.querySelector('.sl')

// ---------- 머신 ----------
let cur = MACHINES[store.get('machine')] || MACHINES.classic
let lastStops = {} // 서버가 알려 준 머신별 마지막 자리
let jackpotPool = 0, jackpotLast = null

// ---------- 베팅: 금액 하나 → 줄 수·줄당 ----------
const LADDER = []
for (let e = 1; e <= 1e11; e *= 10) LADDER.push(e, 2 * e, 5 * e) // 1, 2, 5, 10, 20, 50 …
function betsOf(m) {
  if (m.lineChoices) return [1, 3, ...LADDER.filter(v => v >= 5 && v % 5 === 0)] // 클래식: 1, 3, 5, 10, 20, 50 …
  return LADDER.map(v => v * m.lines.length)
}
const split = (m, bet) => m.lineChoices
  ? (bet >= 5 ? { lines: 5, lineBet: bet / 5 } : { lines: bet, lineBet: 1 })
  : { lines: m.lines.length, lineBet: bet / m.lines.length }
function hintOf(m, bet) {
  const { lines } = split(m, bet)
  if (m.lineChoices) return { 1: '가운데 줄 1개만', 3: '가로 줄 3개', 5: '줄 5개 모두 (가로 3 · 대각선 2)' }[lines]
  let h = `줄 ${lines}개 모두`
  if (m.jackpot) h += bet >= m.jackpot.fullBet ? ' · 잭팟 전부' : ` · 잭팟 ${Math.round(bet / m.jackpot.fullBet * 100)}% (${fmt(m.jackpot.fullBet)}칩부터 전부)`
  return h
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

// ---------- 릴 ----------
const symSvg = sym => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${sym}"/></svg>`
let reels = []
const tr = (k, count) => `translateY(${(-k / count) * 100}%)`
const modOf = r => n => { const len = cur.strips[r].length; return ((n % len) + len) % len }

function buildReels() {
  $('reels').replaceChildren()
  $('reels').style.setProperty('--reels', cur.reels)
  main.dataset.reels = cur.reels
  $('paylines').setAttribute('viewBox', `0 0 ${cur.reels * 100} 300`)
  reels = cur.strips.map(() => {
    const el = document.createElement('div'); el.className = 'sl-reel'
    const strip = document.createElement('div'); strip.className = 'sl-strip'
    el.append(strip); $('reels').append(el)
    return { el, strip, stop: 0 }
  })
}
// 띠의 from부터 count칸을 위에서 아래로 깐다. 띠 높이 = 칸 수 / 3 × 창 높이
function fill(r, from, count) {
  const { strip } = reels[r], st = cur.strips[r], mod = modOf(r)
  strip.innerHTML = Array.from({ length: count }, (_, i) => `<div class="sl-cell">${symSvg(st[mod(from + i)])}</div>`).join('')
  strip.style.setProperty('--n', count)
  strip.style.height = (count / 3) * 100 + '%'
}
// 멈춘 모습: s-2 … s+2 다섯 칸, 창에는 가운데 셋 (s-1 · s · s+1)
function setStatic(r, s) {
  reels[r].stop = modOf(r)(s)
  fill(r, s - 2, 5)
  reels[r].strip.style.transform = tr(1, 5)
}
const cellAt = (r, row) => reels[r].strip.children[row + 1]

// 지금 자리에서 target까지 띠를 아래로 흘린다 (번호가 작은 칸이 위에서 내려옴)
function spinTo(r, target, duration, loops) {
  const len = cur.strips[r].length, from = reels[r].stop
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

// ---------- 줄 그리기 ----------
const svgNS = 'http://www.w3.org/2000/svg'
const lineY = row => 50 + row * 100
function drawLine(i, cls) {
  const rows = cur.lines[i], W = cur.reels * 100
  const pts = [`-6,${lineY(rows[0])}`, ...rows.map((row, r) => `${r * 100 + 50},${lineY(row)}`), `${W + 6},${lineY(rows.at(-1))}`]
  const pl = document.createElementNS(svgNS, 'polyline')
  pl.setAttribute('points', pts.join(' '))
  pl.setAttribute('stroke', lineColor(i))
  pl.setAttribute('class', cls)
  $('paylines').append(pl)
}
// 베팅을 바꾸면 어느 줄이 걸리는지 잠깐 보여 줌
let previewT
function previewLines() {
  if (busy) return
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
// 당첨 줄·별 칸 표시. 돌려주는 값: 빛난 칸들의 화면 위치 (동전이 튀어나올 곳)
function markWins(wins, scatter, floatPays = true) {
  const rects = []
  for (const w of wins) {
    drawLine(w.line, 'win')
    cur.lines[w.line].slice(0, w.n).forEach((row, r) => {
      const c = cellAt(r, row); c.style.setProperty('--lc', lineColor(w.line)); c.classList.add('hit')
      rects.push(c.getBoundingClientRect())
    })
    if (floatPays) {
      const last = w.n - 1, row = cur.lines[w.line][last]
      setTimeout(() => floatText($('fxText'), (last * 2 + 1) / (cur.reels * 2) * 100, (row * 2 + 1) / 6 * 100, '+' + fmt(w.pay), lineColor(w.line)), 150)
    }
  }
  if (scatter?.count) for (const [r, row] of scatter.cells) {
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

// 당첨 크기에 따라 연출 단계: 손해(돌려받음) < 당첨 < 나이스 < 빅윈 < 메가 < 잭팟
// 잭팟 = 누적 잭팟을 맞혔거나, 그 머신의 가장 큰 배당(클래식 777, 다이아 셋, 5릴 세븐 다섯)
const topMult = m => Math.max(...Object.values(m.pays).flatMap(p => Object.values(p)))
function tierOf(m, back, total, wins = []) {
  if (m.jackpot && back > 0 && lastSpun?.jackpot?.win) return 'jackpot'
  if (wins.some(w => w.mult >= topMult(cur))) return 'jackpot'
  const k = back / total
  return k >= 50 ? 'mega' : k >= 10 ? 'big' : k >= 3 ? 'nice' : k >= 1 ? 'win' : k > 0 ? 'small' : 'lose'
}
let streak = 0, lastSpun = null
const center = r => [r.left + r.width / 2, r.top + r.height / 2]

// 한 판(또는 프리스핀 한 번)의 결과 연출. big 이상은 전체 화면을 닫을 때까지 기다린다
function showResult({ wins, scatter, back, total, title, sub, final = true, celebrateBig = true }) {
  return new Promise(resolve => {
    const sorted = [...wins].sort((a, b) => b.pay - a.pay)
    const tier = tierOf(cur, back, total, wins)
    const rects = markWins(wins, scatter, tier !== 'small')
    if (scatter?.pay) setTimeout(() => floatText($('fxText'), 50, 50, `별 ${scatter.count}개 +${fmt(scatter.pay)}`, '#ffe066'), 150)
    if (tier === 'lose') {
      if (final) { main.classList.add('lose'); say(title || '꽝', '', sub ?? `${fmt(total)}칩을 잃었어요 · 다시 해 볼까요?`); sfx.lose() }
      return resolve(tier)
    }
    main.classList.add('win', 'tier-' + tier)
    if (['big', 'mega', 'jackpot'].includes(tier)) main.classList.add('big')
    if (tier === 'jackpot') main.classList.add('jackpot')
    const head = title || (sorted[0] ? kindLabel(sorted[0].kind) : `별 ${scatter.count}개!`) + (sorted.length > 1 ? ` 외 ${sorted.length - 1}줄` : '')
    if (final) {
      const net = back - total
      say(head, '', sub ?? `${fmt(total)}칩 걸고 ${fmt(back)}칩 받음 · ` + (net > 0 ? `${fmt(net)}칩 이득` : net === 0 ? '본전' : `${fmt(-net)}칩 손해`) + (streak >= 2 ? ` · 🔥 ${streak}연속!` : ''))
    }
    if (tier === 'small') { if (final) countUp(back); sfx.coin(); return resolve(tier) }

    // 당첨 칸에서 동전이 튀고, 남은 칩으로 날아감 (칸이 없으면 = 프리스핀 합계 등, 릴 가운데서)
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
    // 빅윈 이상: 줄을 잠깐 보여 준 뒤 전체 화면
    setAuto(false)
    const wr = $('reels').getBoundingClientRect()
    shake(document.querySelector('.sl-machine'), tier === 'big' ? 1 : 1.6)
    burst(wr.left + wr.width / 2, wr.top + wr.height / 2, 30, { power: 1.3, confetti: 30 })
    if (tier === 'jackpot') sfx.jackpot(); else sfx.win(true)
    $('resAmt').textContent = '+' + fmt(back)
    setTimeout(() => celebrate({
      tier, amount: back, fmt,
      label: tier !== 'jackpot' ? null : lastSpun?.jackpot?.win ? 'MEGA JACKPOT' : { diamond: 'DIAMOND ×2000', fruit5: '7 7 7 7 7', lucky: '7 7 7 7 7' }[cur.id] || 'JACKPOT 777',
      sub: lastSpun?.jackpot?.win ? `누적 잭팟! · ${fmt(total)}칩 걸고 ${fmt(back)}칩!` : `${head} · ${fmt(total)}칩 걸고 ${fmt(back)}칩!`,
      onTick: () => sfx.coin(),
      onDone: () => resolve(tier),
    }), 650)
  })
}

// ---------- 프리스핀 (럭키 스타) ----------
// 서버가 열 번의 결과를 미리 보내 준다. 연출이 끝나면 서버가 정산 (건너뛰기 = 서버에 skip → 바로 정산)
let skipping = false
$('fsSkip').onclick = () => { if (!skipping) { skipping = true; game.send({ t: 'skip' }) } }
async function playBonus(m) {
  const b = m.bonus, n = b.spins.length
  skipping = false
  $('fsOf').textContent = n; $('fsMult').textContent = b.mult; $('fsN').textContent = 0; $('fsTotal').textContent = 0
  $('fsBannerSub').textContent = `${n}번 · 당첨 ×${b.mult}`
  $('fsBanner').hidden = false
  main.classList.add('bonus')
  sfx.bonus()
  const wr = $('reels').getBoundingClientRect()
  burst(wr.left + wr.width / 2, wr.top + wr.height / 2, 24, { power: 1.2, confetti: 40 })
  say('프리스핀!', '', `별 ${m.scatter.count}개 · 공짜로 ${n}번, 당첨은 ×${b.mult}`)
  await sleep(reduced ? 600 : 2000)
  $('fsBanner').hidden = true
  $('fsBar').hidden = false
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = b.spins[i]
    $('fsN').textContent = i + 1
    clearHits(); main.classList.add('bonus')
    if (skipping) { s.stops.forEach((st, r) => setStatic(r, st)) } else {
      ticking(true)
      await Promise.all(s.stops.map((st, r) => spinTo(r, st, stopTimes(cur.reels, 1150)[r], 1 + Math.floor(r / 2))))
      ticking(false)
    }
    sum += s.back
    $('fsTotal').textContent = fmt(sum)
    if (!skipping) {
      if (s.back) { await showResult({ wins: s.wins, scatter: s.scatter, back: s.back, total: m.total, final: false, celebrateBig: false }); countUp(sum, sum - s.back) }
      await sleep(s.back ? 600 : 350)
    }
  }
  $('fsBar').hidden = true
  main.classList.remove('bonus')
  return sum
}

// ---------- 누적 잭팟 (메가 잭팟) ----------
let jpShown = 0, jpRaf = 0
function paintJackpot() {
  const box = $('jpBox')
  box.hidden = !cur.jackpot
  const tab = document.querySelector('.sl-pick [data-id="jackpot"] small')
  if (tab) tab.textContent = fmtShort(Math.floor(jackpotPool)) + '칩'
  if (!cur.jackpot) return
  $('jpLast').textContent = jackpotLast ? `최근 ${jackpotLast.name} +${fmtShort(jackpotLast.win)}` : ''
  cancelAnimationFrame(jpRaf)
  const from = jpShown || jackpotPool, to = jackpotPool, t0 = performance.now()
  const step = now => { const k = Math.min(1, (now - t0) / 900); jpShown = from + (to - from) * k; $('jpPool').textContent = fmt(Math.floor(jpShown)); if (k < 1) jpRaf = requestAnimationFrame(step) }
  jpRaf = requestAnimationFrame(step)
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
  let rows = ''
  if (m.jackpot) rows += `<li class="top"><span class="icons" role="img" aria-label="잭팟 3개">${ic('jp').repeat(3)}</span><span class="lbl">가운데 줄 잭팟 3개</span><b>누적 잭팟</b></li>`
  if (m.scatter) {
    const sc = m.scatter
    rows += `<li class="top"><span class="icons" role="img" aria-label="별 3개">${ic('star').repeat(3)}</span><span class="lbl">별 3개 어디든 → 프리스핀 ${sc.freeSpins}번 ×${sc.mult}</span>${amt(sc.pays[3] * total)}</li>`
    rows += `<li><span class="icons">${ic('star')}<span class="any">4·5</span></span><span class="lbl">별 4개 · 5개</span><b>${fmtShort(sc.pays[4] * total)} · ${fmtShort(sc.pays[5] * total)}칩</b></li>`
  }
  for (const [s, p] of Object.entries(m.pays)) {
    const ns = Object.keys(p).map(Number).sort((a, b) => b - a)
    if (m.reels === 3) {
      for (const n of ns) {
        const label = n === 3 ? `${SYMBOLS[s]} 3개` : n === 2 ? `${SYMBOLS[s]} 2개 (왼쪽부터)` : `${SYMBOLS[s]} 1개 (맨 왼쪽)`
        const top = p[n] === topMult(m) && !m.jackpot
        rows += `<li class="${top ? 'top' : ''}"><span class="icons" role="img" aria-label="${label}">${ic(s).repeat(n)}${'<span class="any">?</span>'.repeat(3 - n)}</span><span class="lbl">${label}</span>${amt(lineBet * p[n])}</li>`
      }
    } else { // 5릴: 그림 하나에 한 줄, 개수별 칩
      const top = p[5] === topMult(m)
      rows += `<li class="row5 ${top ? 'top' : ''}"><span class="icons" role="img" aria-label="${SYMBOLS[s]}">${ic(s)}</span><span class="lbl">${SYMBOLS[s]}</span><span class="n5">${ns.sort((a, b) => a - b).map(n => `<em>${n}개</em> ${fmtShort(lineBet * p[n])}`).join('')}</span></li>`
    }
  }
  const note = m.jackpot
    ? `잭팟은 모두의 베팅 2%가 쌓인 것 (1.5%는 잭팟, 0.5%는 다음 잭팟 밑돈). 베팅 ${fmt(m.jackpot.fullBet)}칩 이상이면 잭팟 전부, 적으면 베팅 비율만큼. `
    : m.scatter ? `별은 줄과 상관없이 창 어디든 세요. 프리스핀은 공짜이고 당첨은 ×${m.scatter.mult}, 프리스핀 중엔 다시 걸리지 않아요. ` : ''
  const html = `<ul class="sl-paylist">${rows}</ul>
    <p class="sl-lines-title">당첨되는 줄 <small>(지금 베팅: ${hintOf(m, bet)})</small></p>
    <div class="sl-lines r${m.reels}">${m.lines.map((_, i) => lineMini(m, i, i < lines)).join('')}</div>
    <p class="sl-note">${note}같은 그림이 걸린 줄 위에 <b>왼쪽부터</b> 이어지면 당첨. 여러 줄이 함께 맞으면 모두 더해 받아요.
    한 줄에서는 가장 큰 것 하나만. 이론 환급률(RTP) ${(exactRtp(m).rtp * 100).toFixed(1)}% · 결과는 서버가 정해요. 코인은 게임용이며 현금이나 상품으로 바꿀 수 없어요.</p>`
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
    return `<button type="button" data-id="${id}" aria-pressed="${id === cur.id}"><span class="ic">${symSvg({ classic: 'seven', diamond: 'diamond', fruit5: 'grape', lucky: 'star', jackpot: 'jp' }[id])}</span><b>${m.short}</b><small>${m.reels}릴 · ${m.lines.length}줄</small></button>`
  }).join('')
  $('pick').querySelectorAll('button').forEach(b => b.onclick = () => switchMachine(b.dataset.id))
  paintJackpot()
}
function switchMachine(id) {
  if (busy || id === cur.id || !MACHINES[id]) return
  setAuto(false); queued = false
  cur = MACHINES[id]
  store.set('machine', id)
  main.dataset.machine = id
  $('mName').textContent = cur.name
  bet = savedBet(cur)
  buildReels()
  const st = lastStops[id] || defaultStops(cur)
  st.forEach((s, r) => setStatic(r, s))
  clearHits()
  say(cur.name, '', cur.desc)
  $('pick').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === id)))
  paintBet(); paintJackpot()
  requestAnimationFrame(layoutLever)
}
// 처음 보이는 그림: 머신의 대표 그림이 가운데 줄에
const defaultStops = m => m.strips.map(st => { const s = { classic: 'seven', diamond: 'diamond', fruit5: 'seven', lucky: 'seven', jackpot: 'jp' }[m.id]; return Math.max(0, st.indexOf(s)) })

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

async function onSpun(m) {
  try { await playSpin(m) } catch (err) { console.error('[slots]', err) } finally { // 연출이 깨져도 기계는 풀어 줌
    clearInterval(tickTimer); main.classList.remove('teasing', 'bonus'); $('fsBar').hidden = true; $('fsBanner').hidden = true
    setBusy(false)
  }
  if (auto && !celebrating()) setTimeout(() => { if (auto) requestSpin() }, m.back ? 1300 : 450)
}
async function playSpin(m) {
  clearTimeout(waitT)
  awaiting = false
  if (m.machine !== cur.id) { // 다른 탭에서 돌린 판: 그 머신으로 바꿔서 보여 줌
    busy = false; switchMachine(m.machine)
  }
  lastSpun = m
  lastStops[m.machine] = m.stops
  setBusy(true)
  ticking(true)
  const R = cur.reels, times = stopTimes(R)
  if (m.tease) times[R - 1] += TEASE_MS // 서버도 정산을 그만큼 늦춤 (rules.mjs teases)
  const spins = m.stops.map((s, r) => spinTo(r, s, times[r], r === R - 1 && m.tease ? 6 : 2 + Math.floor(r * 3 / R)))
  if (m.tease) {
    // 마지막 릴만 남았을 때: 그 릴만 금빛으로 두근두근
    await spins[R - 2]
    ticking(false)
    reels[R - 1].el.classList.add('tease'); main.classList.add('teasing')
    say('두근두근…', '', m.scatter && m.scatter.count >= (cur.scatter?.trigger || 9) - 1 ? '별 하나만 더!' : '마지막 하나만 맞으면!')
    let k = 0
    const beat = setInterval(() => sfx.heart(Math.min(1, k++ / 8)), 330)
    await spins[R - 1]
    clearInterval(beat)
    reels[R - 1].el.classList.remove('tease'); main.classList.remove('teasing')
  }
  await Promise.all(spins)
  ticking(false)
  const net = m.back - m.total
  streak = net > 0 ? streak + 1 : 0
  if (m.bonus) {
    await showResult({ wins: m.wins, scatter: m.scatter, back: m.base, total: m.total, final: false, celebrateBig: false })
    await sleep(reduced ? 200 : 900)
    const fs = await playBonus(m)
    clearHits()
    const all = m.base + fs
    const tier = await showResult({ wins: [], scatter: null, back: all, total: m.total, title: `프리스핀 합계 +${fmt(fs)}`,
      sub: `${fmt(m.total)}칩 걸고 ${fmt(all)}칩 받음 (프리스핀 ${fmt(fs)})` })
    if (tier === 'lose') say('프리스핀 끝', '', '이번엔 아쉬워요')
  } else if (m.jackpot) {
    await showResult({ wins: m.wins, scatter: m.scatter, back: m.back, total: m.total, title: `누적 잭팟 +${fmt(m.jackpot.win)}` })
  } else {
    await showResult({ wins: m.wins, scatter: m.scatter, back: m.back, total: m.total })
  }
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
main.dataset.machine = cur.id
$('mName').textContent = cur.name
buildReels()
defaultStops(cur).forEach((s, r) => setStatic(r, s))
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
      if (!busy && lastStops[cur.id]) lastStops[cur.id].forEach((s, r) => setStatic(r, s))
      if (m.jackpot) { jackpotPool = m.jackpot.pool; jackpotLast = m.jackpot.last; paintJackpot() }
      return
    }
    if (m.t === 'jackpot') { jackpotPool = m.pool; jackpotLast = m.last; paintJackpot(); return }
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

// 개발 확인용: 지금 머신·릴이 멈춘 자리 (결과를 바꿀 수는 없음)
export const debug = { machine: () => cur.id, stops: () => reels.map(r => r.stop), evaluate: (st, l, lb) => evaluate(cur, st, l, lb) }
