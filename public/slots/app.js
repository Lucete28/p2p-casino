// 슬롯머신 화면. 결과(멈출 자리)는 서버가 정하고, 여기서는 받은 자리까지 릴을 돌려 보여 주기만 한다.
// 릴은 rules.mjs의 띠 순서 그대로 흘러가서, 멈춘 그림이 서버의 결과와 같다.
import { startGame } from '../shared/casino.js'
import { STRIPS, REEL_LEN, LINES, LINE_CHOICES, PAY3, PAY_CHERRY2, PAY_CHERRY1, checkBet } from './rules.mjs'

const $ = id => document.getElementById(id)
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
const mod = n => ((n % REEL_LEN) + REEL_LEN) % REEL_LEN
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const store = { // localStorage 키는 casino:slots: 로 시작
  get(k) { try { return localStorage.getItem('casino:slots:' + k) } catch { return null } },
  set(k, v) { try { localStorage.setItem('casino:slots:' + k, v) } catch {} },
}

const LINE_COLORS = ['#ffd36b', '#ff5a6a', '#4ade80', '#5ac8ff', '#e07bff']
const STOP_MS = reduced ? [300, 420, 540] : [1100, 1500, 1900] // 마지막 릴 정지가 서버 SPIN_MS(2300)보다 짧아야 함
const KIND = {
  seven3: '777 잭팟', bar3: 'BAR 셋', bell3: '종 셋', melon3: '수박 셋', lemon3: '레몬 셋', cherry3: '체리 셋', cherry2: '체리 둘', cherry1: '체리',
}
const main = document.querySelector('.sl')

// ---------- 전구 ----------
document.querySelectorAll('.sl-bulbs').forEach(b => { for (let i = 0; i < 16; i++) b.append(document.createElement('i')) })

// ---------- 릴 ----------
const symSvg = sym => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${sym}"/></svg>`
const reels = [0, 1, 2].map(() => {
  const el = document.createElement('div'); el.className = 'sl-reel'
  const strip = document.createElement('div'); strip.className = 'sl-strip'
  el.append(strip); $('reels').append(el)
  return { el, strip, stop: 0 }
})
const tr = (k, count) => `translateY(${(-k / count) * 100}%)`

// 띠의 from부터 count칸을 위에서 아래로 깐다. 띠 높이 = 칸 수 / 3 × 창 높이
function fill(r, from, count) {
  const { strip } = reels[r]
  strip.innerHTML = Array.from({ length: count }, (_, i) => `<div class="sl-cell">${symSvg(STRIPS[r][mod(from + i)])}</div>`).join('')
  strip.style.setProperty('--n', count)
  strip.style.height = (count / 3) * 100 + '%'
}
// 멈춘 모습: s-2 … s+2 다섯 칸, 창에는 가운데 셋 (s-1 · s · s+1)
function setStatic(r, s) {
  reels[r].stop = mod(s)
  fill(r, s - 2, 5)
  reels[r].strip.style.transform = tr(1, 5)
}
const cellAt = (r, row) => reels[r].strip.children[row + 1]

// 지금 자리에서 target까지 띠를 아래로 흘린다 (번호가 작은 칸이 위에서 내려옴)
function spinTo(r, target, duration, loops) {
  const from = reels[r].stop
  const count = mod(from - target) + REEL_LEN * loops + 5 // target-2 … from+2
  fill(r, target - 2, count)
  const start = count - 4, end = 1
  const { strip } = reels[r]
  strip.style.transform = tr(start, count)
  if (!reduced) strip.classList.add('blur')
  const anim = strip.animate([
    { transform: tr(start, count), easing: 'ease-in' },
    { transform: tr(start + 0.3, count), offset: 0.06, easing: 'cubic-bezier(.45,.05,.3,1)' }, // 살짝 위로 당겼다가
    { transform: tr(end - 0.22, count), offset: 0.93, easing: 'ease-in-out' },                  // 조금 지나쳐서
    { transform: tr(end, count) },                                                              // 제자리
  ], { duration, fill: 'forwards' })
  setTimeout(() => strip.classList.remove('blur'), duration * 0.78)
  return anim.finished.then(() => { anim.cancel(); setStatic(r, target); sfx.stop() })
}

// ---------- 라인 그리기 ----------
const svgNS = 'http://www.w3.org/2000/svg'
const lineY = row => 50 + row * 100
function drawLine(i, cls) {
  const [a, b, c] = LINES[i]
  const pl = document.createElementNS(svgNS, 'polyline')
  pl.setAttribute('points', `-6,${lineY(a)} 50,${lineY(a)} 150,${lineY(b)} 250,${lineY(c)} 306,${lineY(c)}`)
  pl.setAttribute('stroke', LINE_COLORS[i])
  pl.setAttribute('class', cls)
  $('paylines').append(pl)
}
let previewT
function previewLines() {
  if (busy) return
  clearHits()
  for (let i = 0; i < state.lines; i++) drawLine(i, 'preview')
  clearTimeout(previewT)
  previewT = setTimeout(() => { if (!busy) $('paylines').replaceChildren() }, 1400)
}
function paintMarks() {
  document.querySelectorAll('.sl-marks li').forEach(li => {
    const i = Number(li.dataset.line)
    li.style.setProperty('--lc', LINE_COLORS[i])
    li.classList.toggle('on', i < state.lines)
  })
}
function clearHits() {
  clearTimeout(previewT)
  $('paylines').replaceChildren()
  document.querySelectorAll('.sl-cell.hit').forEach(c => c.classList.remove('hit'))
  document.querySelectorAll('.sl-marks li.hit').forEach(c => c.classList.remove('hit'))
  main.classList.remove('win', 'big', 'jackpot')
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
  win(big) {
    const notes = big ? [523, 659, 784, 1047, 784, 1047, 1319] : [659, 784, 1047]
    notes.forEach((f, i) => tone(f, i * 0.09, 0.16, 'square', 0.04))
  },
  jackpot() { [523, 659, 784, 1047, 1319, 1568, 2093, 1568, 2093].forEach((f, i) => { tone(f, i * 0.11, 0.22, 'square', 0.05); tone(f / 2, i * 0.11, 0.22, 'triangle', 0.05) }) },
}
let tickTimer = null
const ticking = on => { clearInterval(tickTimer); if (on && soundOn && !reduced) tickTimer = setInterval(sfx.tick, 70) }

// ---------- 베팅 ----------
const LADDER = []
for (let e = 1; e <= 1e13; e *= 10) for (const m of [1, 2, 5]) LADDER.push(m * e)
const saved = (() => { try { return JSON.parse(store.get('bet')) || {} } catch { return {} } })()
const state = {
  lines: LINE_CHOICES.includes(saved.lines) ? saved.lines : 5,
  lineBet: Number.isSafeInteger(saved.lineBet) && saved.lineBet >= 1 ? saved.lineBet : 1,
}
function paintBet() {
  document.querySelectorAll('[data-lines]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.lines) === state.lines)))
  if (document.activeElement !== $('lineBet')) $('lineBet').value = state.lineBet
  const total = state.lineBet * state.lines
  $('total').textContent = fmt(total)
  $('total').style.color = game?.me && !busy && game.chips < total ? '#ff8a8a' : ''
  $('betDown').disabled = state.lineBet <= 1
  paintMarks()
  store.set('bet', JSON.stringify(state))
}
document.querySelectorAll('[data-lines]').forEach(b => b.onclick = () => { state.lines = Number(b.dataset.lines); paintBet(); previewLines() })
$('betUp').onclick = () => { state.lineBet = LADDER.find(v => v > state.lineBet) ?? state.lineBet; paintBet() }
$('betDown').onclick = () => { state.lineBet = [...LADDER].reverse().find(v => v < state.lineBet) ?? 1; paintBet() }
$('lineBet').addEventListener('input', () => {
  const v = Math.floor(Number($('lineBet').value))
  if (Number.isSafeInteger(v) && v >= 1) { state.lineBet = v; paintBet() }
})
$('lineBet').addEventListener('blur', paintBet)

// ---------- 당첨 표시 ----------
let countRaf = 0
function countUp(to) {
  cancelAnimationFrame(countRaf)
  const el = $('win')
  if (!to) { el.textContent = '0'; return }
  const dur = reduced ? 0 : Math.min(1800, 350 + Math.log10(to + 1) * 320)
  const t0 = performance.now()
  let lastTick = 0
  const step = now => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1
    el.textContent = fmt(Math.round(to * (1 - (1 - k) ** 3)))
    if (now - lastTick > 85 && k < 1) { sfx.coin(); lastTick = now }
    if (k < 1) countRaf = requestAnimationFrame(step)
  }
  countRaf = requestAnimationFrame(step)
}

function coinRain() {
  if (reduced) return
  const rain = $('rain')
  for (let i = 0; i < 46; i++) {
    const c = document.createElement('i')
    c.style.left = ((i * 37) % 100) + '%'
    c.style.animationDuration = 1.6 + ((i * 13) % 10) / 8 + 's'
    c.style.animationDelay = ((i * 7) % 16) / 10 + 's'
    rain.append(c)
  }
  setTimeout(() => rain.replaceChildren(), 4800)
}

function showResult(m) {
  const wins = [...m.wins].sort((a, b) => b.pay - a.pay)
  for (const w of m.wins) {
    drawLine(w.line, 'win')
    LINES[w.line].slice(0, w.n).forEach((row, r) => { const c = cellAt(r, row); c.style.setProperty('--lc', LINE_COLORS[w.line]); c.classList.add('hit') })
    document.querySelectorAll(`.sl-marks li[data-line="${w.line}"]`).forEach(li => li.classList.add('hit'))
  }
  countUp(m.back)
  if (!wins.length) { $('msg').textContent = '꽝! 한 번 더?'; return }
  const best = wins[0]
  const jackpot = wins.some(w => w.kind === 'seven3')
  const big = m.back >= m.total * 10
  main.classList.add('win')
  if (big) main.classList.add('big')
  $('msg').textContent = `라인 ${best.line + 1} · ${KIND[best.kind]} ×${best.mult}` + (wins.length > 1 ? ` 외 ${wins.length - 1}줄` : '')
  if (jackpot) { main.classList.add('jackpot'); coinRain(); sfx.jackpot() }
  else sfx.win(big)
  if (jackpot || big) setAuto(false)
}

// ---------- 돌리기 ----------
let game = null, busy = false, queued = false, waitT = null, auto = false
function setBusy(on) {
  busy = on
  $('spin').disabled = on
  $('lever').classList.toggle('locked', on)
  paintBet()
}
function setAuto(on) {
  auto = on
  $('auto').setAttribute('aria-pressed', String(on))
  $('auto').textContent = on ? '자동 멈춤' : '자동'
}

function requestSpin() {
  if (!game) return
  if (!game.me) return game.openBuyIn() // 로그인 화면으로
  if (busy) return
  const bet = checkBet(state.lineBet, state.lines)
  if (bet.error) { setAuto(false); return game.toast(bet.error) }
  if (game.inPlay > 0) { queued = true; return } // 앞 판 정산이 오면 바로
  if (!game.chips) { setAuto(false); return game.openBuyIn() }
  if (bet.total > game.chips) { setAuto(false); return game.toast('칩이 모자라요. 베팅을 줄이거나 칩을 바꿔 주세요.') }
  queued = false
  setBusy(true)
  clearHits()
  countUp(0)
  $('msg').textContent = '행운을 빌어요…'
  sfx.lever()
  game.send({ t: 'spin', lineBet: bet.lineBet, lines: bet.lines })
  clearTimeout(waitT)
  waitT = setTimeout(() => { setBusy(false); setAuto(false); $('msg').textContent = '다시 눌러 주세요' }, 2500) // 서버가 거절하면 (알림으로 옴)
}

async function onSpun(m) {
  clearTimeout(waitT)
  setBusy(true)
  ticking(true)
  await Promise.all(m.stops.map((s, r) => spinTo(r, s, STOP_MS[r], 2 + r)))
  ticking(false)
  showResult(m)
  setBusy(false)
  if (auto) setTimeout(() => { if (auto) requestSpin() }, m.wins.length ? 1300 : 450)
}

// ---------- 레버 ----------
const lever = $('lever'), rod = $('leverRod'), knob = $('leverKnob')
let pull = 0, pivot = 200, reach = 90, springRaf = 0
function layoutLever() {
  const win = document.querySelector('.sl-window'), mach = document.querySelector('.sl-machine')
  pivot = win.getBoundingClientRect().top - mach.getBoundingClientRect().top + win.offsetHeight / 2
  reach = Math.min(110, win.offsetHeight * 0.48)
  lever.style.setProperty('--pivot', pivot + 'px')
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

$('spin').onclick = () => { if (busy) return; animatePull(1, 150, () => animatePull(0, 520)); requestSpin() }
$('auto').onclick = () => { setAuto(!auto); if (auto && !busy) requestSpin() }
function paintSound() { $('sound').setAttribute('aria-pressed', String(soundOn)); $('sound').textContent = soundOn ? '소리 켬' : '소리 끔' }
$('sound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn ? '1' : '0'); paintSound(); if (soundOn) sfx.coin() }
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.target !== document.body || e.repeat) return
  e.preventDefault(); $('spin').click()
})

// ---------- 배당표 ----------
{
  const ic = s => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${s}"/></svg>`
  const any = '<span class="any">·</span>'
  const rows = [
    ['top', ic('seven').repeat(3), PAY3.seven, '777'],
    ['', ic('bar').repeat(3), PAY3.bar, 'BAR 셋'],
    ['', ic('bell').repeat(3), PAY3.bell, '종 셋'],
    ['', ic('melon').repeat(3), PAY3.melon, '수박 셋'],
    ['', ic('lemon').repeat(3), PAY3.lemon, '레몬 셋'],
    ['', ic('cherry').repeat(3), PAY3.cherry, '체리 셋'],
    ['', ic('cherry').repeat(2) + any, PAY_CHERRY2, '체리 둘'],
    ['', ic('cherry') + any + any, PAY_CHERRY1, '체리 하나'],
  ]
  $('paylist').innerHTML = rows.map(([cls, icons, mult, label]) => `<li class="${cls}"><span class="icons" role="img" aria-label="${label}">${icons}</span><b>×${fmt(mult)}</b></li>`).join('')
}

// ---------- 시작 ----------
const sevens = STRIPS.map(s => s.indexOf('seven'))
sevens.forEach((s, r) => setStatic(r, s))
paintBet(); paintSound(); layoutLever()

game = await startGame({
  onLoggedOut() { $('msg').textContent = '로그인하면 돌릴 수 있어요' },
  onReady() { paintBet() },
  onChips({ inPlay }) {
    paintBet()
    if (!inPlay && queued && !busy) requestSpin()
  },
  onMessage(m) {
    if (m.t === 'hello') {
      if (m.stops && !busy) m.stops.forEach((s, r) => setStatic(r, s))
      return
    }
    if (m.t === 'spun') return onSpun(m)
  },
})
paintBet()
