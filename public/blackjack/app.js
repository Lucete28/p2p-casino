// 블랙잭 화면. 카드·결과는 서버가 정하고(state 메시지), 여기서는 받은 카드를 순서대로 놓아 보여 주기만 한다.
// 딜러의 숨긴 카드는 판이 끝나야 서버가 보내 준다. 칩 숫자는 서버가 연출 시간(rules.mjs의 *_MS)만큼 늦게 정산한 값.
import { startGame } from '../shared/casino.js'
import { score, isNatural, advise, DEAL_MS, HIT_MS, DEALER_MS, RESULT_MS } from './rules.mjs'

const $ = id => document.getElementById(id)
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
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
// 슈에서 날아오는 연출 (Web Animations). 앞면 카드는 날아오는 도중에 뒤집힌다
function flyIn(e) {
  if (reduced) return
  const from = $('shoe').getBoundingClientRect(), to = e.getBoundingClientRect()
  const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2)
  const end = getComputedStyle(e).transform
  e.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(-30deg) scale(.55)`, opacity: 0.4 }, { transform: end === 'none' ? 'none' : end, opacity: 1 }],
    { duration: Math.min(320, DEAL_MS - 30), easing: 'cubic-bezier(.2,.7,.3,1)' })
}
async function place(box, c, ms, dbl) {
  const e = cardEl(null, dbl)
  box.append(e)
  flyIn(e); sfx.card()
  if (c) { faceUp(e, c); setTimeout(() => e.classList.remove('down'), reduced ? 0 : 110) }
  await sleep(reduced ? Math.min(ms, 120) : ms)
  return e
}

// ---------- 테이블 그리기 ----------
// shown = 지금 화면에 놓인 카드 (서버 state와 비교해 새 카드만 연출)
let shown = { dealer: [], hands: [] }
const handBoxes = [] // [{ el, cards, total, bet }]
function clearTable() {
  $('dealerCards').innerHTML = ''; $('hands').innerHTML = ''; handBoxes.length = 0
  shown = { dealer: [], hands: [] }
  paintTotals()
}
function addHand() {
  const el = document.createElement('div')
  el.className = 'bj-hand'
  el.innerHTML = '<b class="bj-total" hidden></b><div class="bj-cards"></div><div class="bj-hand-bet"></div>'
  $('hands').append(el)
  const h = { el, cards: el.querySelector('.bj-cards'), total: el.querySelector('.bj-total'), bet: el.querySelector('.bj-hand-bet') }
  handBoxes.push(h)
  return h
}
function totalText(cards, natural) {
  const s = score(cards)
  if (natural) return { t: '블랙잭', cls: 'bj21' }
  if (s.total > 21) return { t: `${s.total} 버스트`, cls: 'bust' }
  return { t: s.soft && s.total < 21 ? `${s.total - 10} / ${s.total}` : String(s.total), cls: '' }
}
function paintTotal(el, cards, natural) {
  const known = cards.filter(Boolean)
  el.hidden = !known.length
  if (!known.length) return
  const x = totalText(known, natural)
  el.textContent = x.t; el.className = 'bj-total' + (x.cls ? ' ' + x.cls : '')
}
function paintTotals() {
  paintTotal($('dealerTotal'), shown.dealer, shown.dealer.length === 2 && shown.dealer.every(Boolean) && isNatural(shown.dealer))
  shown.hands.forEach((cards, i) => handBoxes[i] && paintTotal(handBoxes[i].total, cards, shown.hands.length === 1 && isNatural(cards)))
}
function paintHandMeta(s) {
  s.hands.forEach((h, i) => {
    const b = handBoxes[i]; if (!b) return
    b.bet.innerHTML = `${chipHtml(stackOf(h.bet, 1)[0])}${fmt(h.bet)}${h.doubled ? ' <small>더블</small>' : ''}`
    b.el.classList.toggle('active', s.phase === 'play' && s.hands.length > 1 && i === s.active)
    b.el.classList.toggle('waiting', s.phase === 'play' && s.hands.length > 1 && i !== s.active)
  })
}
// 판 없이 그대로 그리기 (처음 접속·새로고침·두 번 누름 동기화)
function renderStatic(s) {
  clearTable()
  s.dealer.forEach(c => $('dealerCards').append(cardEl(c)))
  shown.dealer = [...s.dealer]
  s.hands.forEach((h, i) => {
    const b = addHand()
    h.cards.forEach((c, j) => b.cards.append(cardEl(c, h.doubled && j === 2)))
    shown.hands[i] = [...h.cards]
  })
  paintHandMeta(s); paintTotals()
  if (s.phase === 'done') showResults(s, true)
}
function centerMsg(text) {
  $('center').innerHTML = ''
  const sp = document.createElement('span'); sp.textContent = text
  $('center').append(sp)
}

// ---------- 결과 ----------
const TAG = { blackjack: '블랙잭!', win: '이김', lose: '짐', bust: '버스트', push: '비김' }
function say(title, amt = '', sub = '', cls = '') {
  $('resTitle').textContent = title
  $('resAmt').textContent = amt
  $('resAmt').className = 'bj-result-amt' + (cls ? ' ' + cls : '')
  $('resSub').textContent = sub
}
function showResults(s, quiet) {
  const dl = score(s.dealer).total, dealerBJ = isNatural(s.dealer)
  s.hands.forEach((h, i) => {
    const b = handBoxes[i]; if (!b || !h.result) return
    b.el.querySelector('.bj-tag')?.remove()
    const tag = document.createElement('b')
    tag.className = 'bj-tag ' + h.result; tag.textContent = TAG[h.result]
    b.el.append(tag)
    if (h.result === 'win' || h.result === 'blackjack') b.cards.querySelectorAll('.card').forEach(c => c.classList.add('win'))
  })
  const bet = s.hands.reduce((a, h) => a + h.bet, 0), net = s.back - bet
  const amt = net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : '±0'
  const cls = net > 0 ? 'plus' : net < 0 ? 'minus' : 'even'
  const me = s.hands.map(h => score(h.cards).total)
  let title, sub
  if (s.hands.length > 1) {
    title = net > 0 ? '이겼어요!' : net < 0 ? '졌어요' : '본전이에요'
    sub = s.hands.map((h, i) => `손${i + 1} ${me[i]} ${TAG[h.result]}`).join(' · ') + ` · 딜러 ${dl > 21 ? dl + ' 버스트' : dl}`
  } else {
    const h = s.hands[0]
    title = { blackjack: '블랙잭!', win: '이겼어요!', lose: '졌어요', bust: '버스트 — 21을 넘었어요', push: '비겼어요' }[h.result]
    sub = h.result === 'blackjack' ? '첫 두 장이 21! 건 칩의 1.5배를 더 받아요'
      : h.result === 'push' ? (dealerBJ ? '둘 다 블랙잭 — 건 칩을 돌려받아요' : `나 ${me[0]} · 딜러 ${dl} — 건 칩을 돌려받아요`)
      : h.result === 'bust' ? `내 카드 합 ${me[0]}`
      : dealerBJ ? '딜러 블랙잭 (A + 10)'
      : h.dealerBust ? `딜러가 ${dl}로 버스트!`
      : `나 ${me[0]} · 딜러 ${dl}`
  }
  say(title, amt, sub, cls)
  $('result').classList.toggle('big', s.hands.some(h => h.result === 'blackjack'))
  if (quiet) return
  if (net > 0) sfx.win(s.hands.some(h => h.result === 'blackjack')); else if (net < 0) sfx.lose(); else sfx.push()
}

// ---------- 서버 state 받기 → 순서대로 연출 ----------
let game = null // startGame이 돌려주는 연결 (아래 '시작'에서)
let state = null, pending = 0, running = Promise.resolve(), turnEnd = 0, waitingAct = null
function enqueue(s) {
  s.at = performance.now()
  pending++
  paintPanel()
  running = running.then(() => apply(s)).catch(err => { console.error(err); renderStatic(s) }).finally(() => { pending--; paintPanel() })
}
async function apply(s) {
  const prev = state
  state = s
  if (s.ev === 'join' || s.ev === 'sync' || !prev) {
    renderStatic(s)
    if (s.phase === 'play') askTurn(s)
    return paintPanel()
  }
  $('spot').classList.add('hide')
  $('result').classList.remove('big')
  if (s.ev === 'deal') {
    clearTable()
    if (s.shoe.shuffled && prev.phase !== 'idle') centerMsg('새 슈 — 카드를 다시 섞었어요')
    say('카드를 받는 중…', '', `베팅 ${fmt(s.hands[0].bet)}`)
    const h = addHand()
    paintHandMeta({ ...s, phase: 'deal' })
    const order = [[h.cards, s.hands[0].cards[0], 'p'], [$('dealerCards'), s.dealer[0], 'd'], [h.cards, s.hands[0].cards[1], 'p'], [$('dealerCards'), null, 'd']]
    shown.hands = [[]]
    for (const [box, c, who] of order) {
      await place(box, c, DEAL_MS)
      if (who === 'p') shown.hands[0].push(c); else shown.dealer.push(c)
      paintTotals()
    }
  } else {
    // 스플릿: 두 번째 카드를 새 손으로 옮긴다
    if (s.hands.length > shown.hands.length && shown.hands.length === 1) {
      const moved = handBoxes[0].cards.lastElementChild
      const b = addHand()
      b.cards.append(moved)
      shown.hands = [[shown.hands[0][0]], [shown.hands[0][1]]]
      paintHandMeta(s); paintTotals()
    }
    for (let i = 0; i < s.hands.length; i++) {
      const h = s.hands[i]
      for (let j = shown.hands[i].length; j < h.cards.length; j++) {
        await place(handBoxes[i].cards, h.cards[j], HIT_MS, h.doubled && j === 2)
        shown.hands[i].push(h.cards[j]); paintTotals()
      }
    }
  }
  paintHandMeta(s)
  if (s.phase === 'done') {
    // 딜러 차례: 숨긴 카드 뒤집기 → 17이 될 때까지 받기
    const hole = $('dealerCards').children[1]
    if (hole && s.dealer[1]) { faceUp(hole, s.dealer[1], true); sfx.flip(); shown.dealer[1] = s.dealer[1]; paintTotals() }
    await sleep(reduced ? 150 : DEALER_MS)
    for (let k = 2; k < s.dealer.length; k++) {
      await place($('dealerCards'), s.dealer[k], DEALER_MS)
      shown.dealer.push(s.dealer[k]); paintTotals()
    }
    showResults(s)
    await sleep(RESULT_MS)
  } else if (s.phase === 'play') askTurn(s)
}
function askTurn(s) {
  const h = s.hands[s.active]
  say(s.hands.length > 1 ? `손${s.active + 1}: 어떻게 할까요?` : '어떻게 할까요?', '', `내 카드 ${totalText(h.cards).t} · 딜러 보이는 카드 ${totalText([s.dealer[0]]).t}`)
}

// ---------- 아래 조작판 ----------
let bet = Number(store.get('bet')) || 100
let hintOn = store.get('hint') !== '0'
const busy = () => pending > 0
function paintBet() {
  const chips = game?.chips ?? 0
  const loggedIn = !!game?.me
  const playing = state?.phase === 'play'
  $('dealAmt').textContent = bet ? fmt(bet) : ''
  const short = loggedIn && bet > chips
  $('deal').classList.toggle('short', short)
  $('deal').querySelector('span').textContent = !loggedIn ? '로그인하고 시작' : !chips && !game?.inPlay ? '칩 바꾸기' : short ? '칩이 모자라요' : '딜'
  $('deal').disabled = busy() || playing
  $('clearBet').disabled = !bet; $('halfBet').disabled = bet < 2; $('dblBet').disabled = !bet || (loggedIn && bet * 2 > chips); $('allBet').disabled = loggedIn && !chips
  // 베팅 자리 (판이 없을 때만)
  const idle = !state || state.phase === 'idle' || !$('hands').children.length
  $('spot').classList.toggle('hide', !idle)
  $('spotStack').innerHTML = stackOf(bet).map((c, i) => `<i style="bottom:${i * 4}px">${chipHtml(c)}</i>`).join('')
  $('spotAmt').textContent = bet ? fmt(bet) : ''
  store.set('bet', String(bet))
}
function paintPanel() {
  const s = state
  const playing = s?.phase === 'play'
  $('betBox').hidden = playing
  $('actBox').hidden = !playing
  $('actBox').classList.toggle('wait', busy())
  if (playing) {
    const h = s.hands[s.active]
    const tip = hintOn && !busy() ? advise(h.cards, s.dealer[0], { canDouble: s.actions.double, canSplit: s.actions.split }) : null
    document.querySelectorAll('.bj-btn').forEach(b => {
      b.disabled = busy() || !s.actions[b.dataset.a]
      b.classList.toggle('advice', b.dataset.a === tip)
    })
    turnEnd = s.at + s.turnMs
  }
  paintBet()
}
function setBet(v) {
  // 결과가 남아 있으면 테이블을 비우고 새 베팅을 보여 준다
  if (state?.phase === 'done' && $('hands').children.length) { clearTable(); say('베팅하고 딜을 눌러요', '', '21에 더 가까우면 이겨요. 21을 넘으면 져요.'); $('result').classList.remove('big') }
  bet = Math.max(0, Math.floor(v))
  paintBet()
}
$('chipBtns').innerHTML = CHIPS.map(c => `<button type="button" class="bj-chip" data-v="${c.v}" aria-label="${fmt(c.v)}칩 더하기" style="--chip:${c.c}">${chipHtml(c.c)}<b>${c.l}</b></button>`).join('')
$('chipBtns').querySelectorAll('button').forEach(b => b.onclick = () => { sfx.chip(); setBet(bet + Number(b.dataset.v)) })
$('clearBet').onclick = () => setBet(0)
$('halfBet').onclick = () => setBet(bet / 2)
$('dblBet').onclick = () => { sfx.chip(); setBet(bet * 2) }
$('allBet').onclick = () => { sfx.chip(); setBet(game?.me ? game.chips : bet) }
$('deal').onclick = () => {
  if (!game?.me) return game?.openBuyIn() // 로그인 화면으로
  if (busy() || state?.phase === 'play') return
  if (!game.chips && !game.inPlay) return game.openBuyIn()
  if (!bet) return game.toast('칩을 눌러 걸 만큼 쌓아 주세요.')
  if (bet > game.chips) { game.toast(`칩이 ${fmt(game.chips)}개 있어요. 베팅을 줄이거나 칩을 더 바꿔 주세요.`); return }
  sfx.chip()
  game.send({ t: 'deal', bet })
}
document.querySelectorAll('.bj-btn').forEach(b => b.onclick = () => {
  if (busy() || !state || state.phase !== 'play' || b.disabled) return
  pending++; paintPanel() // 서버 답이 올 때까지 다시 못 누르게 (답이 오면 enqueue가 이어받음)
  waitingAct = setTimeout(() => { pending--; waitingAct = null; paintPanel() }, 3000)
  game.send({ t: 'act', a: b.dataset.a, seq: state.seq })
})
function releaseAct() { if (waitingAct) { clearTimeout(waitingAct); waitingAct = null; pending-- } }

$('hint').onclick = () => { hintOn = !hintOn; store.set('hint', hintOn ? '1' : '0'); paintHint(); paintPanel() }
function paintHint() { $('hint').setAttribute('aria-pressed', String(hintOn)); $('hint').textContent = hintOn ? '추천 보기' : '추천 끔' }

// 30초 타이머
setInterval(() => {
  if (state?.phase !== 'play' || busy()) { $('timer').classList.remove('hurry'); $('timerFill').style.width = '100%'; $('timerText').textContent = ''; return }
  const left = Math.max(0, turnEnd - performance.now())
  $('timerFill').style.width = (left / 30000 * 100) + '%'
  $('timer').classList.toggle('hurry', left < 10000)
  $('timerText').textContent = left < 10000 ? `${Math.ceil(left / 1000)}초 뒤 자동으로 스탠드` : '천천히 골라도 돼요'
}, 200)

// 키보드: H 히트 · S 스탠드 · D 더블 · P 스플릿 · Enter/Space 딜
document.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || /INPUT|TEXTAREA/.test(e.target.tagName)) return
  const map = { KeyH: 'hit', KeyS: 'stand', KeyD: 'double', KeyP: 'split' }
  if (map[e.code] && state?.phase === 'play') { document.querySelector(`.bj-btn[data-a="${map[e.code]}"]`)?.click(); return }
  if ((e.code === 'Enter' || e.code === 'Space') && e.target === document.body && !$('betBox').hidden) { e.preventDefault(); $('deal').click() }
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

// ---------- 시작 ----------
paintSound(); paintHint(); paintBet()
if (firstVisit) helpDlg.showModal()

game = await startGame({
  autoBuyIn: !firstVisit, // 처음이면 안내를 먼저 보고 '시작하기'에서 칩 바꾸기
  bustDelay: 900, // 정산이 이미 카드 연출 뒤라 짧게
  onToast() { releaseAct(); paintPanel() }, // 거절되면 버튼을 다시 풀기 (알림은 기본대로)
  onLoggedOut() { say('로그인하면 할 수 있어요', '', '로그인하고 코인을 칩으로 바꿔 시작해요'); paintBet() },
  onReady() { paintBet() },
  onChips() { paintBet() },
  onMessage(m) {
    if (m.t !== 'state') return
    releaseAct()
    paintShoe(m.shoe)
    if (m.ev === 'join' && m.lastBet && !store.get('bet')) bet = m.lastBet
    enqueue(m)
  },
})
paintBet()
