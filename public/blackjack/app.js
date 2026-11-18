// 블랙잭 화면 (여러 명 테이블). 판은 서버(딜러)가 돌리고, 여기서는 받은 state를 순서대로 연출해 보여 주기만 한다.
// 딜러의 숨긴 카드는 딜러 차례가 되어야 서버가 보내 준다. 칩 숫자는 서버가 연출 시간(rules.mjs의 *_MS)만큼 늦게 정산한 값.
// 돈은 '보유 칩 · 베팅 · 이번 판' 세 칸으로 보여 준다 (운영자 요청 2026-11-18, 누적 득실은 보여 주지 않음). 처음엔 관전, 빈자리를 누르거나 베팅하면 앉는다
import { startGame } from '../shared/casino.js'
import { nextCard } from './odds.mjs'
import { score, isNatural, SEATS, MIN_BET, DEAL_MS, HIT_MS, DEALER_MS, RESULT_MS, TURN_MS } from './rules.mjs'

const $ = id => document.getElementById(id)
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
const sign = n => n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0'
const tone3 = n => n > 0 ? 'plus' : n < 0 ? 'minus' : 'even'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const store = { // localStorage 키는 casino:blackjack: 로 시작
  get(k) { try { return localStorage.getItem('casino:blackjack:' + k) } catch { return null } },
  set(k, v) { try { localStorage.setItem('casino:blackjack:' + k, v) } catch {} },
}

// ---------- 칩 ----------
const CHIPS = [
  { v: 10, c: '#2a63c4', l: '10' }, { v: 50, c: '#c81e2c', l: '50' }, { v: 100, c: '#26221c', l: '100' },
  { v: 500, c: '#7b3fb5', l: '500' }, { v: 1000, c: '#c98a1a', l: '1천' }, { v: 5000, c: '#1f9b52', l: '5천' },
]
const chipHtml = c => `<span class="chip" style="--chip:${c}"></span>`
function stackOf(amount, max = 8) { // 큰 칩부터 쌓기
  const out = []
  for (let i = CHIPS.length - 1; i >= 0 && out.length < max; i--) {
    while (amount >= CHIPS[i].v && out.length < max) { out.push(CHIPS[i].c); amount -= CHIPS[i].v }
  }
  if (amount > 0 && out.length < max) out.push('#8c8576') // 10 아래 잔돈
  return out
}

// ---------- 소리 (WebAudio, 파일 없음) ----------
let ac = null, soundOn = store.get('sound') !== '0'
function audio() {
  if (!soundOn) return null
  try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume() } catch { return null }
  return ac
}
function tone(freq, at, dur, type = 'sine', vol = 0.05) {
  const a = audio(); if (!a) return
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain()
  o.type = type; o.frequency.setValueAtTime(freq, t)
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02)
}
function swish(vol = 0.08, dur = 0.09) { // 카드가 미끄러지는 소리 (짧은 잡음)
  const a = audio(); if (!a) return
  const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2 // 효과음 잡음이라 Math.random 괜찮음 (게임 결과와 무관)
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain()
  s.buffer = buf; f.type = 'bandpass'; f.frequency.value = 2600; g.gain.value = vol
  s.connect(f).connect(g).connect(a.destination); s.start()
}
const sfx = {
  card: () => swish(),
  flip: () => swish(0.06, 0.06),
  chip() { tone(2400, 0, 0.03, 'square', 0.02); tone(1800, 0.03, 0.04, 'square', 0.015) },
  win(big) { (big ? [659, 784, 988, 1319, 1568] : [659, 880, 1175]).forEach((f, i) => tone(f, i * 0.08, 0.18, 'triangle', 0.07)) },
  lose() { tone(294, 0, 0.14, 'triangle', 0.06); tone(220, 0.13, 0.24, 'triangle', 0.06) },
  push() { tone(523, 0, 0.12, 'triangle', 0.05); tone(523, 0.12, 0.12, 'triangle', 0.04) },
  turn() { tone(880, 0, 0.08, 'sine', 0.05); tone(1175, 0.08, 0.1, 'sine', 0.05) },
  blackjack() { // 팡파르 + 반짝이
    [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => { tone(f, i * 0.09, 0.22, 'square', 0.035); tone(f / 2, i * 0.09, 0.22, 'triangle', 0.05) })
    for (let i = 0; i < 10; i++) tone(2093 + (i % 3) * 300, 0.75 + i * 0.05, 0.08, 'sine', 0.025)
  },
  sparkle() { [1568, 2093, 2637].forEach((f, i) => tone(f, i * 0.06, 0.1, 'sine', 0.03)) },
}
function paintSound() { $('sound').setAttribute('aria-pressed', String(soundOn)); $('sound').textContent = soundOn ? '소리 켬' : '소리 끔' }
$('sound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn ? '1' : '0'); paintSound(); if (soundOn) sfx.chip() }

// ---------- 카드 ----------
const SUIT = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' }
const SUIT_NAME = { s: '스페이드', h: '하트', d: '다이아', c: '클로버' }
const RANK = r => r === 'T' ? '10' : r
function cardEl(c, dbl) {
  const e = document.createElement('div')
  e.className = 'card down' + (dbl ? ' dbl' : '')
  e.innerHTML = '<div class="card-in"><div class="card-face"></div><div class="card-back"></div></div>'
  e.setAttribute('role', 'img'); e.setAttribute('aria-label', '뒤집힌 카드')
  if (c) faceUp(e, c, true)
  return e
}
function faceUp(e, c, now) {
  const r = c[0], s = c[1], f = e.querySelector('.card-face')
  f.classList.toggle('red', s === 'h' || s === 'd')
  const corner = `<b>${RANK(r)}</b><i>${SUIT[s]}</i>`
  f.innerHTML = `<div class="card-corner">${corner}</div><div class="card-pip${'JQK'.includes(r) ? ' face' : ''}">${'JQK'.includes(r) ? r : SUIT[s]}</div><div class="card-corner br">${corner}</div>`
  e.setAttribute('aria-label', `${SUIT_NAME[s]} ${RANK(r)}`)
  if (now) e.classList.remove('down')
}
// 슈에서 날아오는 연출. 앞면 카드는 날아오는 도중에 뒤집힌다
function flyIn(e, ms) {
  if (reduced || ms < 80) return
  const from = $('shoe').getBoundingClientRect(), to = e.getBoundingClientRect()
  const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2)
  const end = getComputedStyle(e).transform
  e.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(-30deg) scale(.55)`, opacity: 0.4 }, { transform: end === 'none' ? 'none' : end, opacity: 1 }],
    { duration: Math.min(320, ms - 20), easing: 'cubic-bezier(.2,.7,.3,1)' })
}
async function place(box, c, ms, dbl) {
  const e = cardEl(null, dbl)
  box.append(e)
  flyIn(e, ms); if (ms >= 80) sfx.card()
  if (c) { faceUp(e, c); setTimeout(() => e.classList.remove('down'), reduced || ms < 200 ? 0 : 110) }
  await sleep(reduced ? Math.min(ms, 120) : ms)
  return e
}
// 칩이 날아감 (이기면 딜러 → 나, 지면 나 → 딜러)
function flyChips(fromEl, toEl, color, n = 4) {
  if (reduced || !fromEl || !toEl) return
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect()
  for (let k = 0; k < n; k++) {
    const c = document.createElement('i')
    c.className = 'bj-fly'; c.innerHTML = chipHtml(color)
    c.style.left = (a.left + a.width / 2 - 15) + 'px'; c.style.top = (a.top + a.height / 2 - 15) + 'px'
    document.body.append(c)
    const dx = b.left + b.width / 2 - (a.left + a.width / 2) + (k - n / 2) * 8, dy = b.top + b.height / 2 - (a.top + a.height / 2)
    c.animate([{ transform: 'translate(0,0) scale(.7)', opacity: 0 }, { opacity: 1, offset: 0.15 }, { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }],
      { duration: 650, delay: k * 70, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' }).finished.then(() => c.remove(), () => c.remove())
  }
}

// ---------- 자리 ----------
// seats: 자리 번호 → 화면 요소. 내 자리는 #mine(크게), 다른 사람은 #others(작게), 빈자리는 점선
const seats = new Map()
let shown = { dealer: [], seats: {} } // 지금 화면에 놓인 카드 (서버 state와 비교해 새 카드만 연출)
function makeSeat(i, mine) {
  const el = document.createElement('div')
  el.className = 'bj-seat'
  el.style.order = i
  el.innerHTML = `<b class="bj-float"></b><div class="bj-seat-hands"></div>${mine ? '<div class="bj-spot"><div class="bj-stack"></div><b class="bj-spot-amt"></b></div>' : ''}
    <div class="bj-seat-info"><span class="bj-avatar"></span><b class="bj-seat-name"></b><span class="bj-seat-status"></span></div>`
  ;(mine ? $('mine') : $('others')).append(el)
  const q = s => el.querySelector(s)
  const e = { i, el, mine, empty: false, hands: [], handsBox: q('.bj-seat-hands'), name: q('.bj-seat-name'), avatar: q('.bj-avatar'), status: q('.bj-seat-status'),
    float: q('.bj-float'), spot: q('.bj-spot'), spotStack: q('.bj-stack'), spotAmt: q('.bj-spot-amt') }
  seats.set(i, e)
  return e
}
function makeEmpty(i, sit) {
  const el = document.createElement(sit ? 'button' : 'div')
  el.className = 'bj-seat empty' + (sit ? ' sit' : ''); el.style.order = i
  if (sit) { el.type = 'button'; el.innerHTML = '<b>앉기</b><small>빈자리</small>'; el.onclick = () => { if (!game?.me) return game?.openBuyIn(); game.send({ t: 'sit', seat: i }) } }
  else el.textContent = '빈자리'
  $('others').append(el)
  seats.set(i, { i, el, empty: true, sit })
}
function dropSeat(i) { seats.get(i)?.el.remove(); seats.delete(i); delete shown.seats[i] }
function syncSeats(S) {
  const watching = S.me < 0
  for (let i = 0; i < SEATS; i++) {
    const s = S.seats[i], e = seats.get(i)
    if (!s) {
      if (!e || !e.empty || e.sit !== watching) { dropSeat(i); makeEmpty(i, watching) }
      continue
    }
    if (!e || e.empty || e.mine !== s.me) { dropSeat(i); makeSeat(i, s.me) }
  }
  // 관전 중이면 내 자리 대신 안내, 다른 사람 자리는 일곱 개 모두 위에
  $('others').classList.toggle('all', watching)
  let w = $('mine').querySelector('.bj-watch')
  if (watching && !w) { w = document.createElement('div'); w.className = 'bj-watch'; $('mine').append(w) }
  if (!watching && w) w.remove()
  if (w) w.innerHTML = `<b>관전 중</b><span>${S.seats.some(x => !x) ? '빈자리를 누르거나 베팅하면 앉아요' : '자리가 다 찼어요. 빈자리가 나면 앉을 수 있어요'}</span>`
  $('tableNo').textContent = `테이블 ${S.table}${S.watching ? ` · 관전 ${S.watching}` : ''}`
}
function addHand(e) {
  const el = document.createElement('div')
  el.className = 'bj-hand'
  el.innerHTML = '<b class="bj-total" hidden></b><div class="bj-cards"></div><div class="bj-hand-bet"></div>'
  e.handsBox.append(el)
  const h = { el, cards: el.querySelector('.bj-cards'), total: el.querySelector('.bj-total'), bet: el.querySelector('.bj-hand-bet') }
  e.hands.push(h)
  return h
}
function clearCards() {
  $('dealerCards').innerHTML = ''
  for (const e of seats.values()) if (!e.empty) { e.handsBox.innerHTML = ''; e.hands = []; e.float.className = 'bj-float'; e.float.textContent = '' }
  shown = { dealer: [], seats: {} }
  paintTotals()
}

function totalText(cards, natural) {
  const s = score(cards)
  if (natural) return { t: '블랙잭', cls: 'bj21' }
  if (s.total > 21) return { t: `${s.total} 버스트`, h: `${s.total}<span class="bj-bust-w"> 버스트</span>`, cls: 'bust' }
  return { t: s.soft && s.total < 21 ? `${s.total - 10}/${s.total}` : String(s.total), cls: '' }
}
function paintTotal(el, cards, natural) {
  const known = (cards || []).filter(Boolean)
  el.hidden = !known.length
  if (!known.length) return
  const x = totalText(known, natural)
  if (x.h) el.innerHTML = x.h; else el.textContent = x.t // x.h는 숫자로만 만든 글자
  el.className = 'bj-total' + (x.cls ? ' ' + x.cls : '')
}
// 다른 사람 줄이 테이블 폭을 넘으면 (꽉 찬 테이블 + 스플릿) 작은 카드를 더 작게, 그래도 넘으면 두 줄로
let fitPending = false
function fitOthers() {
  if (fitPending) return
  fitPending = true
  setTimeout(() => { // 카드가 한 장씩 놓일 때마다 부르므로 한 번으로 모음 (rAF는 가려진 탭에서 멈춰서 setTimeout)
    fitPending = false
    const box = $('others')
    box.style.removeProperty('--cw-mini'); box.classList.remove('wrap')
    const grid = getComputedStyle(box).display === 'grid'
    const kids = [...box.children]
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0
    const need = () => grid ? box.scrollWidth : kids.reduce((a, c) => a + c.getBoundingClientRect().width, 0) + gap * (kids.length - 1)
    let cw = parseFloat(getComputedStyle(box).getPropertyValue('--cw-mini')) || 36
    while (need() > box.clientWidth + 1 && cw > 18) { cw -= 2; box.style.setProperty('--cw-mini', cw + 'px') }
    if (need() > box.clientWidth + 1) box.classList.add('wrap')
  }, 0)
}
addEventListener('resize', fitOthers)
function paintTotals() {
  fitOthers()
  paintTotal($('dealerTotal'), shown.dealer, shown.dealer.length === 2 && shown.dealer.every(Boolean) && isNatural(shown.dealer))
  for (const [i, hands] of Object.entries(shown.seats)) {
    const e = seats.get(Number(i)); if (!e || e.empty) continue
    hands.forEach((cards, k) => e.hands[k] && paintTotal(e.hands[k].total, cards, hands.length === 1 && isNatural(cards)))
  }
}

// 자리마다 이름·베팅·상태 글자
const turnEnd = {} // 자리 → 행동 마감 (performance.now 기준)
function paintMeta() {
  const S = state; if (!S) return
  const now = performance.now()
  for (let i = 0; i < SEATS; i++) {
    const s = S.seats[i], e = seats.get(i)
    if (!s || !e || e.empty) continue
    e.avatar.textContent = (s.name || '?').trim().slice(0, 1)
    e.name.textContent = s.me ? '나' : s.name
    e.el.classList.toggle('away', !s.online)
    e.el.classList.toggle('split', s.hands.length > 1) // 스플릿한 자리는 칸을 넓히거나(PC) 카드를 줄여(휴대폰) 옆 칸을 넘지 않게
    s.hands.forEach((h, k) => {
      const hb = e.hands[k]; if (!hb) return
      hb.bet.innerHTML = `${chipHtml(stackOf(h.bet, 1)[0])}${fmt(h.bet)}${h.doubled ? ' <small>더블</small>' : ''}`
      hb.el.classList.toggle('active', S.phase === 'play' && s.hands.length > 1 && !s.done && k === s.active)
      hb.el.classList.toggle('waiting', S.phase === 'play' && s.hands.length > 1 && !s.done && k !== s.active)
    })
    let text = '', cls = ''
    if (S.phase === 'bet') {
      if (s.ready) { text = `✓ ${fmt(s.bet)} 베팅`; cls = 'ready' } else text = s.me ? '칩을 골라 베팅해요' : '고르는 중'
    } else if (!s.inRound) text = '이번 판 쉬어요'
    else if (S.phase === 'play') {
      if (s.done) text = s.me ? '딜러 차례를 기다려요' : `${fmt(s.staked)} · 다 골랐어요`
      else { const left = Math.max(0, Math.ceil(((turnEnd[i] ?? now) - now) / 1000)); text = s.me ? '' : `${fmt(s.staked)} · 고르는 중 ${left}`; cls = 'think' }
    } else if (revealed) { const n = s.back - s.staked; text = sign(n); cls = 'res ' + tone3(n) }
    e.status.textContent = text; e.status.className = 'bj-seat-status' + (cls ? ' ' + cls : '')
  }
  paintSpot()
}
// 내 베팅 자리 (카드가 없을 때): 걸 칩 더미
function paintSpot() {
  const S = state, my = mySeat(), e = S && seats.get(S.me)
  if (!e || e.empty || !e.spot) return
  const show = !my?.hands.length
  e.spot.hidden = !show
  if (!show) return
  const amount = my?.ready ? my.bet : bet
  e.spot.classList.toggle('ready', !!my?.ready)
  e.spotStack.innerHTML = stackOf(amount).map((c, k) => `<i style="bottom:${k * 4}px">${chipHtml(c)}</i>`).join('')
  e.spotAmt.textContent = amount ? (my?.ready ? `✓ ${fmt(amount)}` : fmt(amount)) : ''
}

// ---------- 결과 ----------
const TAG = { blackjack: '블랙잭!', win: '이김', lose: '짐', bust: '버스트', push: '비김' }
let revealed = false, lastRound = null // lastRound = 지난 판 내 결과 (다음 베팅 때도 보여 줌)
function showResults(S, quiet) {
  revealed = true
  for (let i = 0; i < SEATS; i++) {
    const s = S.seats[i], e = seats.get(i)
    if (!s?.inRound || !e || e.empty) continue
    s.hands.forEach((h, k) => {
      const hb = e.hands[k]; if (!hb || !h.result) return
      hb.el.querySelector('.bj-tag')?.remove()
      const tag = document.createElement('b')
      tag.className = 'bj-tag ' + h.result; tag.textContent = TAG[h.result]
      hb.el.append(tag)
      const good = h.result === 'win' || h.result === 'blackjack', bad = h.result === 'lose' || h.result === 'bust'
      hb.cards.querySelectorAll('.card').forEach(c => { c.classList.toggle('win', good); c.classList.toggle('lost', bad) })
    })
    const net = s.back - s.staked
    e.float.textContent = sign(net)
    e.float.className = 'bj-float show ' + tone3(net)
    if (s.me) {
      lastRound = { net, staked: s.staked, back: s.back }
      if (!quiet) {
        if (s.hands.some(h => h.result === 'blackjack')) { coinRain(e); sfx.win(true); e.float.classList.add('gold') }
        else if (net > 0) { flyChips($('dealerCards'), e.handsBox, '#c98a1a', Math.min(6, 2 + Math.round(net / Math.max(1, s.staked) * 2))); sfx.win(false) }
        else if (net < 0) { flyChips(e.handsBox, $('dealerCards'), '#c81e2c', 4); sfx.lose() }
        else sfx.push()
      }
    }
  }
  paintMeta(); paintMoney()
}


// ---------- 블랙잭 효과 (운영자 요청 2026-11-18: 블랙잭이 뜨면 더 화려하게) ----------
// 효과용 무작위는 Math.random (게임 결과와 무관)
const rnd = (a, b) => a + Math.random() * (b - a)
function burstAt(host, x, y, n, colors, dist = [60, 160]) {
  for (let k = 0; k < n; k++) {
    const i = document.createElement('i')
    const chip = k % 3 !== 2
    i.className = chip ? 'bj-spark coin' : 'bj-spark star'
    i.style.left = x + 'px'; i.style.top = y + 'px'
    i.style.setProperty('--c', colors[k % colors.length])
    host.append(i)
    const a = (k / n) * Math.PI * 2 + rnd(-.2, .2), d = rnd(dist[0], dist[1])
    i.animate([
      { transform: 'translate(-50%,-50%) scale(.3)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(1) rotate(${rnd(-180, 180)}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d * 1.15}px), calc(-50% + ${Math.sin(a) * d + 70}px)) scale(.8) rotate(${rnd(-360, 360)}deg)`, opacity: 0 },
    ], { duration: rnd(1100, 1600), easing: 'cubic-bezier(.15,.7,.35,1)', fill: 'forwards' }).finished.then(() => i.remove(), () => i.remove())
  }
}
const GOLD = ['#ffe39b', '#e8c26a', '#fff6d6', '#c98a1a', '#ffffff']
// 내 블랙잭: 테이블 전체 배너 + 빛줄기 + 칩 터짐 + 번쩍
function blackjackBig(e) {
  sfx.blackjack()
  if (reduced) return
  const table = $('table'), tr = table.getBoundingClientRect()
  table.classList.remove('flash'); void table.offsetWidth; table.classList.add('flash')
  const layer = document.createElement('div')
  layer.className = 'bj-bjfx'
  layer.innerHTML = '<div class="bj-bjfx-rays"></div><div class="bj-bjfx-text"><b>BLACKJACK!</b><small>블랙잭 · 3 : 2</small></div>'
  table.append(layer)
  const hr = (e?.handsBox || table).getBoundingClientRect()
  burstAt(layer, hr.left + hr.width / 2 - tr.left, hr.top + hr.height / 2 - tr.top, 28, GOLD, [70, 190])
  setTimeout(() => burstAt(layer, tr.width / 2, tr.height * 0.45, 18, GOLD, [90, 220]), 250)
  e?.el.classList.add('bjglow')
  setTimeout(() => { layer.classList.add('out'); e?.el.classList.remove('bjglow') }, 2100)
  setTimeout(() => layer.remove(), 2600)
}
// 다른 사람 블랙잭: 그 자리에 작은 금색 팝 + 반짝이
function blackjackSmall(e) {
  if (!e || e.empty) return
  sfx.sparkle()
  const pop = document.createElement('b')
  pop.className = 'bj-bjpop'; pop.textContent = '블랙잭!'
  e.el.append(pop)
  e.el.classList.add('bjglow')
  if (!reduced) { const r = e.handsBox.getBoundingClientRect(), sr = e.el.getBoundingClientRect(); burstAt(e.el, r.left + r.width / 2 - sr.left, r.top + r.height / 2 - sr.top, 10, GOLD, [30, 70]) }
  setTimeout(() => { pop.remove(); e.el.classList.remove('bjglow') }, 2000)
}
// 정산 때 내 블랙잭: 금색 칩이 비처럼 내 자리로
function coinRain(e, n = 16) {
  if (reduced || !e) return
  const tr = $('table').getBoundingClientRect(), to = e.handsBox.getBoundingClientRect()
  for (let k = 0; k < n; k++) {
    const c = document.createElement('i')
    c.className = 'bj-fly'; c.innerHTML = chipHtml(GOLD[k % 4] === '#fff6d6' ? '#c98a1a' : '#d9a13a')
    const x0 = rnd(tr.left + 20, tr.right - 40), y0 = tr.top - 30
    c.style.left = x0 + 'px'; c.style.top = y0 + 'px'
    document.body.append(c)
    const dx = to.left + to.width / 2 - x0 + rnd(-30, 30) - 15, dy = to.top + to.height / 2 - y0 - 15
    c.animate([{ transform: 'translate(0,0) rotate(0) scale(.8)', opacity: 0 }, { opacity: 1, offset: .1 }, { transform: `translate(${dx}px, ${dy}px) rotate(${rnd(-540, 540)}deg) scale(1)`, opacity: 1 }],
      { duration: rnd(700, 1000), delay: k * 55, easing: 'cubic-bezier(.4,.1,.6,1)', fill: 'forwards' }).finished.then(() => c.remove(), () => c.remove())
  }
}

// ---------- 서버 state 받기 → 순서대로 연출 ----------
let game = null // startGame이 돌려주는 연결 (아래 '시작'에서)
let state = null, pending = 0, running = Promise.resolve(), acting = null, phaseEnd = 0
const mySeat = () => state && state.me >= 0 ? state.seats[state.me] : null
function enqueue(S) {
  S.at = performance.now()
  pending++
  running = running.then(() => apply(S, pending > 1 ? 0.3 : 1)) // 밀려 있으면 빨리 감기
    .catch(err => { console.error(err); state = S; renderStatic(S) })
    .finally(() => { pending--; paintPanel() })
}
function renderStatic(S) {
  syncSeats(S)
  clearCards()
  S.dealer.forEach(c => $('dealerCards').append(cardEl(c)))
  shown.dealer = [...S.dealer]
  S.seats.forEach((s, i) => {
    const e = seats.get(i)
    if (!s?.hands.length || !e || e.empty) return
    shown.seats[i] = s.hands.map(h => {
      const hb = addHand(e)
      h.cards.forEach((c, j) => hb.cards.append(cardEl(c, h.doubled && j === 2)))
      return [...h.cards]
    })
  })
  revealed = false
  paintMeta(); paintTotals()
  if (S.dealer.length) dealerByPhase(S); else sayDealer(phaseEnd ? '곧 카드를 나눠요' : '베팅을 기다려요')
  if (S.phase === 'dealer' || S.phase === 'result') showResults(S, true)
}
function times(S) {
  phaseEnd = S.phaseMs ? S.at + S.phaseMs : 0
  S.seats.forEach((s, i) => { if (s?.turnMs) turnEnd[i] = S.at + s.turnMs; else delete turnEnd[i] })
}
async function apply(S, speed) {
  const prev = state
  state = S
  times(S)
  paintShoe(S.shoe)
  const fresh = !prev || prev.table !== S.table || S.ev === 'sync' || (S.ev === 'join' && S.seat === S.me) || (S.phase === 'bet' && prev.phase !== 'bet')
  if (fresh) { renderStatic(S); return }
  if (S.phase === 'bet') sayDealer(phaseEnd ? '곧 카드를 나눠요' : '베팅을 기다려요')
  if (S.ev === 'deal') {
    syncSeats(S); clearCards(); revealed = false
    sayDealer('카드를 나눠요')
    if (S.shoe.shuffled) centerMsg('새 슈 — 카드를 다시 섞었어요', 1600)
    const ins = S.seats.map((s, i) => s?.inRound ? i : -1).filter(i => i >= 0 && seats.get(i) && !seats.get(i).empty)
    for (const i of ins) { addHand(seats.get(i)); shown.seats[i] = [[]] }
    paintMeta()
    for (let k = 0; k < 2; k++) {
      for (const i of ins) {
        const c = S.seats[i].hands[0].cards[k]
        await place(seats.get(i).hands[0].cards, c, DEAL_MS * speed)
        shown.seats[i][0].push(c); paintTotals()
      }
      await place($('dealerCards'), k === 0 ? S.dealer[0] : null, DEAL_MS * speed)
      shown.dealer.push(k === 0 ? S.dealer[0] : null); paintTotals()
    }
    paintMeta()
    dealerByPhase(S)
    for (const i of ins) {
      const c = S.seats[i].hands[0].cards
      if (c.length === 2 && isNatural(c)) (S.seats[i].me ? blackjackBig : blackjackSmall)(seats.get(i))
    }
    if (mySeat()?.inRound && !mySeat().done) sfx.turn()
    return
  }
  syncSeats(S)
  await diffSeats(S, speed)
  paintMeta()
  if (S.ev === 'dealer') {
    // 한 장 놓을 때마다: 더 받을 거면 '16 이하라 한 장 더', 끝이면 '멈춰요 / 버스트'
    const step = () => {
      const t = score(shown.dealer).total
      if (shown.dealer.length < S.dealer.length) sayDealer(`${t} — 16 이하라 한 장 더 받아요`, 'hit')
      else dealerFinal(shown.dealer)
    }
    const hole = $('dealerCards').children[1]
    if (hole && S.dealer[1] && !shown.dealer[1]) {
      faceUp(hole, S.dealer[1], true); sfx.flip()
      shown.dealer[1] = S.dealer[1]; paintTotals(); step()
      await sleep((reduced ? 150 : DEALER_MS) * speed)
    }
    for (let k = shown.dealer.length; k < S.dealer.length; k++) {
      await place($('dealerCards'), S.dealer[k], DEALER_MS * speed)
      shown.dealer.push(S.dealer[k]); paintTotals(); step()
    }
    showResults(S)
    await sleep(RESULT_MS)
  }
}
// 자리마다 새로 받은 카드만 놓기 (스플릿이면 두 번째 카드를 새 손으로 옮김)
async function diffSeats(S, speed) {
  for (let i = 0; i < SEATS; i++) {
    const s = S.seats[i], e = seats.get(i)
    if (!s?.inRound || !e || e.empty) continue
    let sh = shown.seats[i] ||= []
    if (s.hands.length === 2 && sh.length === 1 && e.hands.length === 1 && sh[0].length === 2) {
      const moved = e.hands[0].cards.lastElementChild
      addHand(e).cards.append(moved)
      shown.seats[i] = sh = [[sh[0][0]], [sh[0][1]]]
      paintMeta(); paintTotals()
    }
    while (e.hands.length < s.hands.length) addHand(e)
    for (let k = 0; k < s.hands.length; k++) {
      sh[k] ||= []
      for (let j = sh[k].length; j < s.hands[k].cards.length; j++) {
        const c = s.hands[k].cards[j]
        await place(e.hands[k].cards, c, HIT_MS * speed, s.hands[k].doubled && j === 2)
        sh[k].push(c); paintTotals()
      }
    }
  }
}
// ---------- 딜러 한마디: 지금 무엇을 하는지 (규칙을 따로 적지 않아도 판을 보며 알 수 있게) ----------
function sayDealer(text, tone = '') {
  const el = $('dealerSay')
  el.textContent = text
  el.className = 'bj-dealer-say' + (tone ? ' ' + tone : '')
}
// 딜러 카드가 다 놓인 뒤의 말
function dealerFinal(cards) {
  const t = score(cards).total
  if (isNatural(cards)) return sayDealer('딜러 블랙잭!', 'bj')
  if (t > 21) return sayDealer(`${t} 버스트! 21을 넘었어요`, 'bust')
  if (t < 17) return sayDealer(`${t} — 모두 버스트라 더 받지 않아요`, 'stop')
  sayDealer(`${t} — 17 이상이라 멈춰요`, 'stop')
}
function dealerByPhase(S) {
  if (S.phase === 'bet') return sayDealer(phaseEnd ? '곧 카드를 나눠요' : '베팅을 기다려요')
  if (S.phase === 'play') return sayDealer('') // 행동 중엔 비움 (운영자 요청 2026-11-18)
  dealerFinal(S.dealer)
}
let centerT = null
function centerMsg(text, ms) {
  $('center').innerHTML = `<span>${text}</span>`
  clearTimeout(centerT)
  centerT = setTimeout(() => { centerT = null }, ms)
}

// ---------- 돈판: 보유 칩 · 베팅 · 이번 판 ----------
// 보유 칩은 바뀔 때 숫자가 굴러가고 늘면 초록·줄면 빨강으로 반짝인다
let chipsShown = null, chipsAnim = 0
function countChips(n) {
  const el = $('sChips')
  if (chipsShown === null || reduced || document.hidden) { chipsShown = n; chipsAnim++; el.textContent = fmt(n); return }
  if (n === chipsShown) return
  setTimeout(() => { if (chipsShown === n) el.textContent = fmt(n) }, 700) // 탭이 가려져 애니메이션이 멈춰도 마지막 숫자는 맞게
  const from = chipsShown, t0 = performance.now(), id = ++chipsAnim
  $('stChips').classList.remove('up', 'down'); void $('stChips').offsetWidth
  $('stChips').classList.add(n > from ? 'up' : 'down')
  chipsShown = n
  const step = now => {
    if (id !== chipsAnim) return
    const k = Math.min(1, (now - t0) / 600)
    el.textContent = fmt(Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3))))
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
function paintMoney() {
  const S = state, my = mySeat()
  // 보유 칩
  countChips(game?.me ? game.chips : 0)
  $('sChipsSub').textContent = !game?.me ? '로그인 필요' : game.inPlay ? `판에 ${fmt(game.inPlay)} 걸림` : game.coins !== null && game.coins !== undefined ? `코인 ${fmt(game.coins)}` : ''
  // 베팅
  let betV = bet, betSub = '걸 칩'
  if (my?.inRound) { betV = my.staked; betSub = my.hands.some(h => h.doubled) ? '더블 포함' : my.hands.length > 1 ? '스플릿 포함' : '이번 판' }
  else if (my?.ready) { betV = my.bet; betSub = '✓ 걸었어요' }
  else if (S && S.phase !== 'bet') betSub = '다음 판에 걸 칩'
  $('sBet').textContent = fmt(betV); $('sBetSub').textContent = betSub
  // 이번 판 결과만 (누적은 보여 주지 않음). 카드를 받는 중엔 ?, 기다리는 동안엔 지난 판
  const net = my?.inRound && revealed ? my.back - my.staked : null
  if (net !== null) {
    $('sNetL').textContent = '이번 판'; $('sNet').textContent = sign(net)
    $('stNet').className = 'bj-stat net pop ' + tone3(net)
    $('sNetSub').textContent = net > 0 ? '이득' : net < 0 ? '손해' : '본전'
  } else if (my?.inRound) {
    $('sNetL').textContent = '이번 판'; $('sNet').textContent = '?'
    $('stNet').className = 'bj-stat net'; $('sNetSub').textContent = '결과를 기다려요'
  } else {
    $('sNetL').textContent = '지난 판'; $('sNet').textContent = lastRound ? sign(lastRound.net) : '—'
    $('stNet').className = 'bj-stat net' + (lastRound ? ' ' + tone3(lastRound.net) : '')
    $('sNetSub').textContent = lastRound ? (lastRound.net > 0 ? '이득' : lastRound.net < 0 ? '손해' : '본전') : '아직 없어요'
  }
  // 한 줄 안내
  let title = '', sub = ''
  $('money').classList.remove('big')
  if (!game?.me) { title = '로그인하면 할 수 있어요'; sub = '로그인하고 코인을 칩으로 바꿔 시작해요' }
  else if (S && S.me < 0) { title = '관전 중'; sub = S.phase === 'bet' ? '' : '이 판이 끝나면 앉아서 걸 수 있어요' }
  else if (my?.inRound && revealed) {
    const dl = score(S.dealer).total, me = my.hands.map(h => score(h.cards).total)
    if (my.hands.length > 1) {
      title = net > 0 ? '이겼어요!' : net < 0 ? '졌어요' : '본전이에요'
      sub = my.hands.map((h, k) => `손${k + 1} ${me[k]} ${TAG[h.result]}`).join(' · ') + ` · 딜러 ${dl > 21 ? dl + ' 버스트' : dl}`
    } else {
      const h = my.hands[0]
      title = { blackjack: '블랙잭!', win: '이겼어요!', lose: '졌어요', bust: '버스트 — 21을 넘었어요', push: '비겼어요' }[h.result]
      sub = h.result === 'blackjack' ? '첫 두 장이 21! 건 칩의 1.5배를 더 받아요'
        : h.result === 'push' ? (isNatural(S.dealer) ? '둘 다 블랙잭 — 건 칩을 돌려받아요' : `나 ${me[0]} · 딜러 ${dl} — 건 칩을 그대로 돌려받아요`)
        : h.result === 'bust' ? `내 카드 합 ${me[0]}`
        : isNatural(S.dealer) ? '딜러 블랙잭 (A + 10)'
        : h.dealerBust ? `딜러가 ${dl}로 버스트!`
        : `나 ${me[0]} · 딜러 ${dl}`
    }
    sub += ` · 건 칩 ${fmt(my.staked)} → 받은 칩 ${fmt(my.back)}`
    $('money').classList.toggle('big', my.hands.some(h => h.result === 'blackjack'))
  } else if (my?.inRound) {
    const h = my.hands[my.active] || my.hands[0]
    title = my.done ? '딜러 차례를 기다려요' : my.hands.length > 1 ? `손${my.active + 1}: 어떻게 할까요?` : '어떻게 할까요?'
    sub = h ? `내 카드 ${totalText(h.cards).t} · 딜러 보이는 카드 ${S.dealer[0] ? totalText([S.dealer[0]]).t : '-'}` : ''
  } else if (S?.phase === 'bet') {
    title = my?.ready ? '✓ 베팅 완료' : '얼마 걸까요?'
    sub = my?.ready ? '마감되면 보유 칩에서 빠져요 · 마감 전엔 취소할 수 있어요' : ''
  } else { title = '이번 판은 쉬어요'; sub = '이 판이 끝나면 걸 수 있어요' }
  $('mTitle').textContent = title
  $('mSub').textContent = sub
}

// ---------- 남은 카드 창 (운영자 요청 2026-11-18: 자세한 승률 대신 덱에 남은 카드 위주로) ----------
// 다음 카드가 무엇일지 칸 10개로. 내 차례면 받으면 버스트하는 칸은 빨강, 21이 되는 칸은 금색. 결과를 정해 주지는 않는다
let oddsOpen = (() => { const v = store.get('odds'); return v ? v === 'open' : innerWidth > 600 })() // 처음엔 넓은 화면만 펼침
const pctTxt = p => !p ? '0%' : p >= 0.9995 ? '100%' : p < 0.005 ? '<1%' : Math.round(p * 100) + '%'
function drawOdds() {
  const box = $('odds'), S = state, my = mySeat()
  if (busy() && box.innerHTML) return // 카드가 놓이는 중엔 그대로 (새 카드 결과가 미리 보이지 않게)
  box.hidden = !game?.me || !S
  if (box.hidden) return
  const live = S.phase === 'play' && my?.inRound && !my.done
  const visible = [...S.dealer, ...S.seats.flatMap(s => s ? s.hands.flatMap(h => h.cards) : [])]
  const n = nextCard(visible, live ? my.hands[my.active].cards : null)
  const left = S.shoe?.left ?? 0, toCut = Math.max(0, left - (S.shoe?.cut ?? 0))
  const head = `<button type="button" class="bj-odds-head" id="oddsToggle" aria-expanded="${oddsOpen}">
      <span>남은 카드</span>
      <span class="eq">${live ? `히트하면 버스트 <b class="${n.bust >= 0.5 ? 'hi' : ''}">${pctTxt(n.bust)}</b>` : `슈에 <b class="n">${fmt(left)}장</b>`}</span>
      <span class="caret" aria-hidden="true">${oddsOpen ? '▾' : '▸'}</span>
    </button>`
  let body = ''
  if (oddsOpen) {
    const max = Math.max(...n.buckets.map(b => b.p))
    body = `<div class="bj-deck" role="img" aria-label="다음 카드 확률">${n.buckets.map(b => `
        <span class="bj-deck-col${b.bust ? ' bust' : b.is21 ? ' t21' : ''}">
          <em>${pctTxt(b.p)}</em><i style="height:${Math.max(6, b.p / max * 100)}%"></i><b>${b.label}</b>
        </span>`).join('')}
      </div>
      <p class="bj-odds-note">${live ? '<span class="k bust"></span>받으면 버스트 <span class="k t21"></span>21이 돼요 · ' : ''}다음 카드 확률 · 다시 섞기까지 ${fmt(toCut)}장<br>이번 판에 보이는 카드만 빼고 계산해요 (지난 판 카드는 세지 않아요)</p>`
  }
  box.innerHTML = head + body
  $('oddsToggle').onclick = () => { oddsOpen = !oddsOpen; store.set('odds', oddsOpen ? 'open' : 'closed'); drawOdds() }
}

// ---------- 아래 조작판 ----------
let bet = Math.max(MIN_BET, Number(store.get('bet')) || 100)
const busy = () => pending > 0 || !!acting
function paintPanel() {
  const S = state, my = mySeat()
  const myTurn = S?.phase === 'play' && my?.inRound && !my.done
  // 내 차례가 시작되면 행동 버튼이 화면 안에 오게 (주소창 때문에 화면이 짧은 휴대폰)
  if (myTurn && $('actBox').hidden && !busy()) requestAnimationFrame(() => $('actBox').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }))
  $('actBox').hidden = !myTurn
  $('betBox').hidden = !!myTurn
  if (myTurn) document.querySelectorAll('.bj-btn').forEach(b => { b.disabled = busy() || !S.actions[b.dataset.a] })
  // 베팅 버튼
  const go = $('betGo'), chips = game?.chips ?? 0
  let text = '베팅하기', amt = bet ? fmt(bet) : '', dis = false, kind = ''
  if (!game?.me) { text = '로그인하고 시작'; amt = '' }
  else if (!chips && !game.inPlay && !my?.ready && !my?.inRound) { text = '칩 바꾸기'; amt = '' }
  else if (S?.phase === 'bet' && S.me < 0 && S.seats.every(Boolean)) { text = '빈자리가 없어요'; dis = true }
  else if (S?.phase === 'bet') {
    if (my?.ready) { text = '베팅 취소'; amt = ''; kind = 'cancel' }
    else if (chips < MIN_BET) { text = `칩이 ${MIN_BET}개보다 적어요`; kind = 'short'; amt = '' }
    else if (bet > chips) { text = '칩이 모자라요'; kind = 'short' }
    else if (bet < MIN_BET) { text = `최소 ${MIN_BET}칩`; kind = 'short' }
  } else { text = my?.inRound ? '이번 판 진행 중' : '다음 판에 베팅'; dis = true }
  if (S?.phase === 'bet' && S.me < 0 && text === '베팅하기') text = '앉아서 베팅하기'
  $('betGoText').textContent = text; $('betGoAmt').textContent = amt
  go.disabled = dis; go.className = 'bj-deal' + (kind ? ' ' + kind : '')
  const lock = !!my?.ready
  document.querySelectorAll('#chipBtns button, .bj-bet-row button').forEach(b => { b.disabled = lock })
  if (!lock) { $('clearBet').disabled = !bet; $('halfBet').disabled = bet <= MIN_BET; $('dblBet').disabled = !bet || (!!game?.me && bet * 2 > chips); $('allBet').disabled = !!game?.me && !chips }
  $('standUp').hidden = !my || my.inRound
  store.set('bet', String(bet))
  paintMoney(); paintSpot(); drawOdds()
}
$('standUp').onclick = () => game?.send({ t: 'stand' })
// 베팅은 0(비움) 또는 최소 베팅 이상. ½·올인도 최소 아래로 내려가지 않음
function setBet(v) { v = Math.floor(v); bet = v <= 0 ? 0 : Math.max(MIN_BET, v); paintPanel() }
$('chipBtns').innerHTML = CHIPS.map(c => `<button type="button" class="bj-chip" data-v="${c.v}" aria-label="${fmt(c.v)}칩 더하기" style="--chip:${c.c}">${chipHtml(c.c)}<b>${c.l}</b></button>`).join('')
$('chipBtns').querySelectorAll('button').forEach(b => b.onclick = () => { sfx.chip(); setBet(bet + Number(b.dataset.v)) })
$('clearBet').onclick = () => setBet(0)
$('halfBet').onclick = () => setBet(bet / 2)
$('dblBet').onclick = () => { sfx.chip(); setBet(bet * 2) }
$('allBet').onclick = () => { sfx.chip(); setBet(game?.me ? game.chips : bet) }
$('betGo').onclick = () => {
  if (!game?.me) return game?.openBuyIn() // 로그인 화면으로
  const my = mySeat()
  if (my?.ready) return game.send({ t: 'bet', amount: 0 })
  if (!game.chips && !game.inPlay && !my?.inRound) return game.openBuyIn()
  if (state?.phase !== 'bet') return
  if (!bet) return game.toast('칩을 눌러 걸 만큼 쌓아 주세요.')
  if (game.chips < MIN_BET) return game.toast(`칩이 ${MIN_BET}개보다 적어 걸 수 없어요. 칩을 더 바꾸거나 '코인으로'를 눌러 돌려받아요.`)
  if (bet < MIN_BET) return game.toast(`베팅은 ${MIN_BET}칩부터예요.`)
  if (bet > game.chips) return game.toast(`칩이 ${fmt(game.chips)}개 있어요. 베팅을 줄이거나 칩을 더 바꿔 주세요.`)
  sfx.chip()
  game.send({ t: 'bet', amount: bet })
}
document.querySelectorAll('.bj-btn').forEach(b => b.onclick = () => {
  if (busy() || state?.phase !== 'play' || b.disabled) return
  acting = setTimeout(() => { acting = null; paintPanel() }, 3000) // 서버 답이 올 때까지 다시 못 누르게
  paintPanel()
  game.send({ t: 'act', a: b.dataset.a, seq: state.seq })
})
function releaseAct() { if (acting) { clearTimeout(acting); acting = null } }

// 카운트다운 (베팅 마감 · 내 차례 · 다음 판)
setInterval(() => {
  const S = state; if (!S) return
  const now = performance.now(), left = Math.max(0, phaseEnd - now), sec = Math.ceil(left / 1000)
  if (!centerT) {
    let t = ''
    if (S.phase === 'bet') t = phaseEnd ? `베팅 마감 ${sec}초` : S.seats.some(s => s?.ready) ? '' : '누가 베팅하면 판이 시작돼요'
    else if (S.phase === 'play') t = mySeat()?.inRound && !mySeat().done ? '' : '다른 사람이 고르는 중'
    else if (S.phase === 'dealer') t = '딜러 차례'
    else if (S.phase === 'result') t = `다음 판 ${sec}초`
    const hurry = S.phase === 'bet' && phaseEnd && left < 4000
    $('center').innerHTML = t ? `<span class="${hurry ? 'hurry' : ''}">${t}</span>` : ''
  }
  if (S.phase === 'play') paintMeta()
  const my = mySeat()
  if (S.phase === 'play' && my?.inRound && !my.done && !busy()) {
    const l = Math.max(0, (turnEnd[S.me] ?? now) - now)
    $('timerFill').style.width = Math.min(100, l / TURN_MS * 100) + '%'
    $('timer').classList.toggle('hurry', l < 7000)
    $('timerText').textContent = l < 7000 ? `${Math.ceil(l / 1000)}초 뒤 자동으로 스탠드` : `${Math.ceil(l / 1000)}초 안에 골라요`
  } else { $('timerFill').style.width = '100%'; $('timer').classList.remove('hurry'); $('timerText').textContent = '' }
}, 200)

// 키보드: H 히트 · S 스탠드 · D 더블 · P 스플릿 · Enter 베팅
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || /INPUT|TEXTAREA/.test(e.target.tagName)) return
  const map = { KeyH: 'hit', KeyS: 'stand', KeyD: 'double', KeyP: 'split' }
  if (map[e.code] && !$('actBox').hidden) { document.querySelector(`.bj-btn[data-a="${map[e.code]}"]`)?.click(); return }
  if (e.code === 'Enter' && e.target === document.body && !$('betBox').hidden) { e.preventDefault(); $('betGo').click() }
})

// 슈 남은 양
function paintShoe(sh) {
  if (!sh) return
  const k = Math.max(0, (sh.left - sh.cut) / (sh.size - sh.cut))
  $('shoeFill').style.width = (k * 100) + '%'
  $('shoeFill').classList.toggle('low', k < 0.15)
  $('shoe').title = `카드 슈 (6덱) · 남은 카드 ${sh.left}장 · 다시 섞기까지 ${Math.max(0, sh.left - sh.cut)}장`
}

// ---------- 하는 법 (처음 한 번 자동으로) ----------
const helpDlg = $('helpDlg')
$('help').onclick = () => helpDlg.showModal()
$('helpOk').onclick = () => {
  helpDlg.close()
  store.set('guide', '1')
  if (game?.me && !game.chips && !game.inPlay) game.openBuyIn()
}
const firstVisit = !store.get('guide')

// 로컬에서만: ?demo=full (행동 중) · ?demo=result (결과) — 7자리가 꽉 차고 여러 명이 스플릿한 테이블을 서버 없이 그려 화면 점검
const demoKind = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? new URLSearchParams(location.search).get('demo') : null
function demoState(result) {
  const H = (cards, bet, o = {}) => ({ cards, bet, doubled: false, split: false, ...o })
  const R = (h, res, back, extra = {}) => result ? { ...h, result: res, back, ...extra } : h
  const seat = (name, hands, o = {}) => ({ name, me: false, online: true, bet: hands[0].bet, ready: false, inRound: true, done: result || !!o.done, active: o.active ?? 0,
    hands, staked: hands.reduce((a, h) => a + h.bet, 0), back: result ? hands.reduce((a, h) => a + (h.back || 0), 0) : null, turnMs: result || o.done ? 0 : 14000, ...o })
  const seats = [
    seat('민수', [R(H(['8s', '3d', 'Kc', '2h'], 50, { split: true }), 'win', 100), R(H(['8h', 'Tc', '5d'], 50, { split: true }), 'lose', 0)], { active: 1 }),
    seat('지은', [R(H(['2s', '3c', '4d', '2h', '5s'], 100), 'lose', 0)]),
    seat('가나다라마바사아자차', [R(H(['As', 'Kd'], 200, { split: true }), 'win', 400), R(H(['Ac', '9h'], 200, { split: true }), 'push', 200)], { done: true, active: 1 }),
    { ...seat('나', [R(H(['9s', '2c', 'Td'], 200, { split: true, doubled: true }), 'push', 200), R(H(['9d', 'Ah', '3c', '4s', '2d'], 100, { split: true }), 'lose', 0)], { active: 1 }), me: true },
    seat('bob', [R(H(['Ks', 'Ad'], 50), 'blackjack', 125)], { done: true }),
    seat('carol', [R(H(['7s', '4d', 'Th'], 100, { split: true, doubled: true }), 'push', 100), R(H(['7c', '4h', 'Js'], 100, { split: true, doubled: true }), 'push', 100)], { done: true, active: 1 }),
    seat('dave', [R(H(['Ts', '5d', '4c', '9h'], 1000), 'bust', 0)], { done: true }),
  ]
  return { t: 'state', ev: 'sync', table: 1, phase: result ? 'result' : 'play', phaseMs: result ? 3000 : 0, dealer: result ? ['Ts', '6d', '5h'] : ['Ts', null],
    seats, me: 3, watching: 4, seq: 1, actions: { hit: true, stand: true, double: false, split: false }, shoe: { left: 180, size: 312, cut: 78, shuffled: false }, at: performance.now() }
}
function showDemo() {
  const S = demoState(demoKind === 'result')
  state = S; times(S); renderStatic(S); paintShoe(S.shoe); paintPanel()
}

// ---------- 시작 ----------
paintSound(); paintPanel()
if (firstVisit) helpDlg.showModal()
// 로컬에서만: ?demo=blackjack 으로 블랙잭 효과 미리 보기 (실제 사이트에서는 동작하지 않음)
if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && new URLSearchParams(location.search).get('demo') === 'blackjack') {
  setTimeout(() => { blackjackBig(seats.get(state?.me) || null); setTimeout(() => coinRain(seats.get(state?.me) || { handsBox: $('mine') }), 2600) }, 2500)
}

game = await startGame({
  autoBuyIn: !firstVisit, // 처음이면 안내를 먼저 보고 '시작하기'에서 칩 바꾸기
  bustDelay: 900, // 정산이 이미 카드 연출 뒤라 짧게
  onToast() { releaseAct(); paintPanel() }, // 거절되면 버튼을 다시 풀기 (알림은 기본대로)
  onLoggedOut() { paintPanel() },
  onReady() { paintPanel() },
  onChips() { paintPanel() },
  onMessage(m) {
    if (m.t !== 'state' || demoKind === 'full' || demoKind === 'result') return // 미리 보기 중엔 서버 상태를 그리지 않음
    if (m.ev !== 'act' || m.seat === m.me) releaseAct()
    enqueue(m)
  },
})
paintPanel()
if (demoKind === 'full' || demoKind === 'result') showDemo()
