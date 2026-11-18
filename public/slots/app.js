// 슬롯머신 화면. 결과(멈출 자리)는 서버가 정하고, 여기서는 받은 자리까지 릴을 돌려 보여 주기만 한다.
// 릴은 rules.mjs의 띠 순서 그대로 흘러가서, 멈춘 그림이 서버의 결과와 같다.
//
// 화면에서는 '라인'을 고르지 않는다. 베팅 금액 하나만 고르고 라인은 거기서 정해진다:
//   베팅 1 → 가운데 줄 1개 · 베팅 3 → 가로 3줄 · 베팅 5 이상(5의 배수) → 5줄 모두, 줄마다 베팅 ÷ 5
import { startGame } from '../shared/casino.js'
import { STRIPS, REEL_LEN, LINES, PAY3, PAY_CHERRY2, PAY_CHERRY1, TEASE_MS, checkBet } from './rules.mjs'
import { burst, flyCoins, floatText, shake, celebrate, celebrating } from './fx.js'

const $ = id => document.getElementById(id)
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
// 좁은 칸용 짧은 숫자: 155,400 → 15.5만 · 31,080,000 → 3,108만 · 2,450,000,000 → 24.5억 (10만 미만은 그대로)
const fmtShort = n => n < 1e5 ? fmt(n) : n < 1e6 ? fmt(Math.floor(n / 1e3) / 10) + '만' : n < 1e8 ? fmt(Math.floor(n / 1e4)) + '만' : fmt(Math.floor(n / 1e7) / 10) + '억'
const mod = n => ((n % REEL_LEN) + REEL_LEN) % REEL_LEN
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const store = { // localStorage 키는 casino:slots: 로 시작
  get(k) { try { return localStorage.getItem('casino:slots:' + k) } catch { return null } },
  set(k, v) { try { localStorage.setItem('casino:slots:' + k, v) } catch {} },
}

const LINE_COLORS = ['#ffd36b', '#ff5a6a', '#4ade80', '#5ac8ff', '#e07bff']
const STOP_MS = reduced ? [300, 420, 540] : [1100, 1500, 1900] // 마지막 릴 정지가 서버 SPIN_MS(2300)보다 짧아야 함
const KIND = {
  seven3: '7 세 개 — 잭팟!', bar3: 'BAR 세 개!', bell3: '종 세 개!', melon3: '수박 세 개!', lemon3: '레몬 세 개!',
  cherry3: '체리 세 개!', cherry2: '체리 두 개!', cherry1: '체리 한 개',
}
const main = document.querySelector('.sl')

// ---------- 베팅: 금액 하나 → 라인 수·라인당 ----------
const BETS = [1, 3]
for (let e = 1; e <= 1e11; e *= 10) BETS.push(5 * e, 10 * e, 20 * e) // 1, 3, 5, 10, 20, 50, 100, 200, …
const split = bet => bet >= 5 ? { lines: 5, lineBet: bet / 5 } : { lines: bet, lineBet: 1 }
const HINT = { 1: '가운데 줄 1개만', 3: '가로 줄 3개', 5: '줄 5개 모두 (가로 3 · 대각선 2)' }
let bet = Number(store.get('bet2'))
if (!BETS.includes(bet)) bet = 5

function paintBet() {
  const { lines } = split(bet)
  $('bet').textContent = bet >= 1e5 ? fmtShort(bet) : fmt(bet) // 200,000 → 20만 (좁은 화면에서 − + 사이에 들어가게)
  $('bet').title = fmt(bet) + '칩'
  $('betHint').textContent = HINT[lines]
  $('betDown').disabled = bet <= BETS[0]
  $('betUp').disabled = bet >= BETS.at(-1)
  $('bet').classList.toggle('short', !!game?.me && !busy && game.chips > 0 && game.chips < bet)
  store.set('bet2', String(bet))
  paintPaytables()
  paintSpin()
}
function changeBet(dir) {
  const i = BETS.indexOf(bet)
  bet = BETS[Math.max(0, Math.min(BETS.length - 1, i + dir))]
  paintBet()
  previewLines()
}
$('betUp').onclick = () => changeBet(1)
$('betDown').onclick = () => changeBet(-1)

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
  return anim.finished.then(() => { anim.cancel(); setStatic(r, target); sfx.stop(); thunk() })
}

// 릴이 멈출 때 몸체가 살짝 덜컹
const cabinet = document.querySelector('.sl-cabinet')
function thunk() { if (!reduced) cabinet.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(0)' }], { duration: 120 }) }

// ---------- 줄 그리기 ----------
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
// 베팅을 바꾸면 어느 줄이 걸리는지 잠깐 보여 줌
let previewT
function previewLines() {
  if (busy) return
  clearHits()
  for (let i = 0; i < split(bet).lines; i++) drawLine(i, 'preview')
  previewT = setTimeout(() => { if (!busy) $('paylines').replaceChildren() }, 1400)
}
function clearHits() {
  clearTimeout(previewT)
  $('paylines').replaceChildren()
  document.querySelectorAll('.sl-cell.hit').forEach(c => c.classList.remove('hit'))
  main.classList.remove('win', 'big', 'jackpot', 'lose', 'tier-small', 'tier-win', 'tier-nice', 'tier-big', 'tier-mega', 'tier-jackpot')
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
function countUp(to) {
  cancelAnimationFrame(countRaf)
  const el = $('resAmt')
  const dur = reduced ? 0 : Math.min(1800, 350 + Math.log10(to + 1) * 320)
  const t0 = performance.now()
  let lastTick = 0
  const step = now => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1
    el.textContent = '+' + fmt(Math.round(to * (1 - (1 - k) ** 3)))
    if (now - lastTick > 85 && k < 1) { sfx.coin(); lastTick = now }
    if (k < 1) countRaf = requestAnimationFrame(step)
  }
  countRaf = requestAnimationFrame(step)
}

// 당첨 크기에 따라 연출 단계: 손해(돌려받음) < 당첨 < 나이스 < 빅윈 < 메가 < 잭팟
function tierOf(m) {
  if (m.wins.some(w => w.kind === 'seven3')) return 'jackpot'
  const k = m.back / m.total
  return k >= 50 ? 'mega' : k >= 10 ? 'big' : k >= 3 ? 'nice' : k >= 1 ? 'win' : k > 0 ? 'small' : 'lose'
}
let streak = 0
const chipPill = () => $('credit') // 당첨 동전이 날아가는 곳: 몸체의 '남은 칩'

function showResult(m) {
  return new Promise(resolve => {
    const wins = [...m.wins].sort((a, b) => b.pay - a.pay)
    const tier = tierOf(m)
    const net = m.back - m.total
    streak = net > 0 ? streak + 1 : 0
    const winRect = $('reels').getBoundingClientRect()
    const hitRects = []
    for (const w of m.wins) {
      drawLine(w.line, 'win')
      LINES[w.line].slice(0, w.n).forEach((row, r) => {
        const c = cellAt(r, row); c.style.setProperty('--lc', LINE_COLORS[w.line]); c.classList.add('hit')
        hitRects.push(c.getBoundingClientRect())
      })
      // 줄 끝에 그 줄이 받은 칩
      const lastReel = w.n - 1, row = LINES[w.line][lastReel]
      if (tier !== 'small') setTimeout(() => floatText($('fxText'), (lastReel * 2 + 1) / 6 * 100, (row * 2 + 1) / 6 * 100, '+' + fmt(w.pay), LINE_COLORS[w.line]), 150)
    }
    if (tier === 'lose') {
      main.classList.add('lose')
      say('꽝', '', `${fmt(m.total)}칩을 잃었어요 · 다시 해 볼까요?`)
      sfx.lose()
      return resolve()
    }
    main.classList.add('win', 'tier-' + tier)
    if (['big', 'mega', 'jackpot'].includes(tier)) main.classList.add('big')
    if (tier === 'jackpot') main.classList.add('jackpot')
    say(KIND[wins[0].kind] + (wins.length > 1 ? ` 외 ${wins.length - 1}줄` : ''), '', '')
    const sub = `${fmt(m.total)}칩 걸고 ${fmt(m.back)}칩 받음 · ` + (net > 0 ? `${fmt(net)}칩 이득` : net === 0 ? '본전' : `${fmt(-net)}칩 손해`)
      + (streak >= 2 ? ` · 🔥 ${streak}연속!` : '')
    $('resSub').textContent = sub
    const center = r => [r.left + r.width / 2, r.top + r.height / 2]

    if (tier === 'small') { countUp(m.back); sfx.coin(); return resolve() }

    // 당첨 칸에서 동전이 튀고, 윗줄 칩으로 날아감
    const uniq = hitRects.slice(0, 6)
    const power = tier === 'win' ? 0.7 : 1
    uniq.forEach(r => burst(...center(r), tier === 'win' ? 6 : 12, { power, confetti: tier === 'win' ? 0 : 8 }))
    flyCoins(uniq, chipPill(), tier === 'win' ? 6 : 12)

    if (tier === 'win') { countUp(m.back); sfx.win(false); return resolve() }
    if (tier === 'nice') {
      countUp(m.back); sfx.nice()
      floatText($('fxText'), 50, 50, 'NICE!', '#fff1b8', true)
      shake(document.querySelector('.sl-machine'), 0.5)
      return resolve()
    }

    // 빅윈 이상: 줄을 잠깐 보여 준 뒤 전체 화면
    setAuto(false)
    shake(document.querySelector('.sl-machine'), tier === 'big' ? 1 : 1.6)
    burst(winRect.left + winRect.width / 2, winRect.top + winRect.height / 2, 30, { power: 1.3, confetti: 30 })
    if (tier === 'jackpot') sfx.jackpot(); else sfx.win(true)
    $('resAmt').textContent = '+' + fmt(m.back)
    setTimeout(() => celebrate({
      tier, amount: m.back, sub: `${KIND[wins[0].kind]} · ${fmt(m.total)}칩 걸고 ${fmt(m.back)}칩!`, fmt,
      onTick: () => sfx.coin(),
      onDone: resolve,
    }), 650)
  })
}

// ---------- 배당표 (지금 베팅으로 받는 칩) ----------
const PAY_ROWS = [
  ['seven', 3, PAY3.seven], ['bar', 3, PAY3.bar], ['bell', 3, PAY3.bell], ['melon', 3, PAY3.melon],
  ['lemon', 3, PAY3.lemon], ['cherry', 3, PAY3.cherry], ['cherry', 2, PAY_CHERRY2], ['cherry', 1, PAY_CHERRY1],
]
const NAME = { seven: '7', bar: 'BAR', bell: '종', melon: '수박', lemon: '레몬', cherry: '체리' }
function lineMini(i, on) {
  const [a, b, c] = LINES[i]
  const dots = [0, 1, 2].flatMap(x => [0, 1, 2].map(y => `<rect x="${x * 10 + 1}" y="${y * 10 + 1}" width="8" height="8" rx="1.5" fill="${LINES[i][x] === y ? LINE_COLORS[i] : '#3a3428'}"/>`)).join('')
  return `<svg viewBox="0 0 30 30" class="${on ? '' : 'off'}" aria-hidden="true">${dots}<polyline points="0,${a * 10 + 5} 5,${a * 10 + 5} 15,${b * 10 + 5} 25,${c * 10 + 5} 30,${c * 10 + 5}" stroke="${LINE_COLORS[i]}" stroke-width="1.6" fill="none"/></svg>`
}
function paintPaytables() {
  const { lines, lineBet } = split(bet)
  const ic = s => `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#sym-${s}"/></svg>`
  const rows = PAY_ROWS.map(([s, n, mult]) => {
    const icons = ic(s).repeat(n) + '<span class="any">?</span>'.repeat(3 - n)
    const label = n === 3 ? `${NAME[s]} 3개` : n === 2 ? '체리 2개 (왼쪽부터)' : '체리 1개 (맨 왼쪽)'
    return `<li class="${s === 'seven' ? 'top' : ''}"><span class="icons" role="img" aria-label="${label}">${icons}</span><span class="lbl">${label}</span><b title="${fmt(lineBet * mult)}칩">${fmtShort(lineBet * mult)}칩</b></li>`
  }).join('')
  const html = `<ul class="sl-paylist">${rows}</ul>
    <p class="sl-lines-title">당첨되는 줄 <small>(지금 베팅: ${HINT[lines]})</small></p>
    <div class="sl-lines">${[0, 1, 2, 3, 4].map(i => lineMini(i, i < lines)).join('')}</div>
    <p class="sl-note">같은 그림이 걸린 줄 위에 <b>왼쪽부터</b> 나란히 서면 당첨. 여러 줄이 함께 맞으면 모두 더해 받아요.
    한 줄에서는 가장 큰 것 하나만. 이론 환급률(RTP) 99% · 결과는 서버가 정해요. 코인은 게임용이며 현금이나 상품으로 바꿀 수 없어요.</p>`
  document.querySelectorAll('[data-paytable]').forEach(el => { el.innerHTML = html })
  $('payFor').textContent = $('helpFor').textContent = `베팅 ${fmt(bet)}칩일 때 받는 칩`
}

// ---------- 남은 칩 (몸체 숫자판). 숫자는 서버가 보낸 칩만, 늘어날 때는 굴러 올라가게 ----------
let creditShown = null, creditRaf = 0
function paintCredit(chips) {
  const el = $('credit')
  $('creditBar').hidden = !game?.me
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

// ---------- 돌리기 ----------
let game = null, busy = false, queued = false, waitT = null, awaiting = false, auto = false
function setBusy(on) {
  busy = on
  $('lever').classList.toggle('locked', on)
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
  const { lines, lineBet } = split(bet)
  const ok = checkBet(lineBet, lines)
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
  game.send({ t: 'spin', lineBet, lines })
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
  clearTimeout(waitT)
  awaiting = false
  setBusy(true)
  ticking(true)
  const times = [...STOP_MS]
  if (m.tease) times[2] += TEASE_MS // 서버도 정산을 그만큼 늦춤 (rules.mjs teases)
  const spins = m.stops.map((s, r) => spinTo(r, s, times[r], r === 2 && m.tease ? 6 : 2 + r))
  if (m.tease) {
    // 두 릴이 맞았을 때: 마지막 릴만 금빛으로 두근두근
    await spins[1]
    ticking(false)
    reels[2].el.classList.add('tease'); main.classList.add('teasing')
    say('두근두근…', '', '마지막 하나만 맞으면!')
    let k = 0
    const beat = setInterval(() => sfx.heart(Math.min(1, k++ / 8)), 330)
    await spins[2]
    clearInterval(beat)
    reels[2].el.classList.remove('tease'); main.classList.remove('teasing')
  }
  await Promise.all(spins)
  ticking(false)
  await showResult(m)
  setBusy(false)
  if (auto && !celebrating()) setTimeout(() => { if (auto) requestSpin() }, m.wins.length ? 1300 : 450)
}

// ---------- 레버 ----------
const lever = $('lever'), rod = $('leverRod'), knob = $('leverKnob')
let pull = 0, pivot = 200, reach = 90, springRaf = 0
function layoutLever() {
  const win = document.querySelector('.sl-window'), mach = document.querySelector('.sl-machine')
  pivot = win.getBoundingClientRect().top - mach.getBoundingClientRect().top + win.offsetHeight / 2
  reach = Math.min(110, win.offsetHeight * 0.48)
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
const sevens = STRIPS.map(s => s.indexOf('seven'))
sevens.forEach((s, r) => setStatic(r, s))
paintSound(); paintBet(); layoutLever()
if (firstVisit) helpDlg.showModal()

game = await startGame({
  autoBuyIn: !firstVisit, // 처음이면 안내를 먼저 보고 '시작하기'에서 칩 바꾸기
  bustDelay: 1500, // 칩을 다 잃었을 때 파산 안내는 릴이 멈추고 결과를 본 뒤에 (정산은 서버 SPIN_MS 뒤)
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
      if (m.stops && !busy) m.stops.forEach((s, r) => setStatic(r, s))
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
