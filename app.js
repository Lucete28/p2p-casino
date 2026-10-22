// P2P 연결 + 화면. 방을 만든 사람(호스트)이 딜러 역할을 하며 게임 상태를 결정한다.
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm'
import { CONFIG, Table } from './poker.js'
import * as cloud from './cloud.js'

const APP_ID = 'p2p-casino-poker-v1'
const STORE = 'p2pcasino.v1'
const PHASES = { waiting: '대기 중', preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', showdown: '결과' }
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// ---------- 지갑 (토큰 + 오늘 재지급 횟수) ----------
// Firebase를 설정했으면 로그인한 계정(Firestore)에, 아니면 이 브라우저(localStorage)에 저장한다.
// 재지급 횟수는 화면에 보여주지 않고, 다 쓴 사람에게만 "내일 다시"를 알려준다.
const today = () => Math.floor((Date.now() + 9 * 3600e3) / 86400e3) // 한국 시간 기준 날짜 번호
function loadWallet() {
  let w = null
  try { w = JSON.parse(localStorage.getItem(STORE)) } catch {}
  w = w || { name: '', tokens: CONFIG.START_TOKENS, day: today(), refills: 0 }
  return { name: w.name || '', tokens: w.tokens | 0, day: w.day ?? today(), refills: w.refills | 0 }
}
let uid = null, cloudTimer = null, cloudWarned = false, lastSaved = ''
function saveWallet() {
  if (cloud.enabled) {
    if (!uid) return
    clearTimeout(cloudTimer)
    cloudTimer = setTimeout(() => {
      const data = { name: wallet.name, tokens: wallet.tokens, day: wallet.day, refills: wallet.refills }
      const json = JSON.stringify(data)
      if (json === lastSaved) return // 바뀐 게 없으면 저장 생략 (무료 쓰기 한도 절약)
      lastSaved = json
      cloud.savePlayer(uid, data).catch(err => {
        lastSaved = ''
        console.warn('저장 실패', err)
        if (!cloudWarned) { cloudWarned = true; toast('토큰 저장에 실패했어요. 인터넷 연결을 확인하세요.') }
      })
    }, 600)
  } else {
    try { localStorage.setItem(STORE, JSON.stringify(wallet)) } catch {}
  }
}
function rollover() {
  if (wallet.day !== today()) { wallet.day = today(); wallet.refills = 0; saveWallet() }
}
// 토큰이 바닥나면 기본 토큰을 다시 준다 (하루 DAILY_REFILLS번까지)
function refillIfBroke() {
  rollover()
  if (wallet.tokens > 0 || wallet.refills >= CONFIG.DAILY_REFILLS) return false
  wallet.refills++
  wallet.tokens = CONFIG.START_TOKENS
  saveWallet()
  return true
}
const outForToday = () => { rollover(); return wallet.tokens <= 0 && wallet.refills >= CONFIG.DAILY_REFILLS }
const wallet = cloud.enabled
  ? { name: '', tokens: 0, day: today(), refills: 0 }
  : loadWallet()
if (!cloud.enabled) { refillIfBroke(); saveWallet() }

// ---------- 상태 ----------
let room, act, isHost = false, hostId = null
let table = null          // 호스트만 가짐
let state = null          // 화면에 그릴 공개 상태
let myHole = null
let refillPending = false
let sitOut = false
let running = false
let turnTimer = null, timerSeq = -1, turnDeadline = 0, nextTimer = null
let raiseTo = 0
let roomCode = ''

const myInfo = () => ({ name: wallet.name, tokens: wallet.tokens, sitOut })

// ---------- 로비 ----------
const nameInput = $('#name'), codeInput = $('#code')
nameInput.value = wallet.name
codeInput.value = location.hash.slice(1).toUpperCase()
updateLobbyWallet()

function updateLobbyWallet() {
  const needLogin = cloud.enabled && !uid
  $('#lobby-wallet').hidden = needLogin
  $('#create').disabled = $('#join').disabled = needLogin
  if (needLogin) return
  $('#lobby-wallet').innerHTML =
    `보유 토큰 <b>${wallet.tokens.toLocaleString()}</b>` +
    (outForToday() ? '<br><span class="out">오늘 받을 수 있는 토큰을 모두 받았어요.<br>내일 다시 참여할 수 있어요.</span>' : '')
}

function takeName() {
  const n = nameInput.value.trim().slice(0, 12)
  if (!n) { nameInput.focus(); toast('닉네임을 입력하세요.'); return false }
  wallet.name = n
  saveWallet()
  return true
}

$('#create').onclick = () => {
  if (!takeName()) return
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)]
  enter(code, true)
}
$('#join').onclick = () => {
  if (!takeName()) return
  const code = codeInput.value.trim().toUpperCase()
  if (!code) { codeInput.focus(); toast('방 코드를 입력하세요.'); return }
  enter(code, false)
}
codeInput.onkeydown = e => { if (e.key === 'Enter') $('#join').click() }

// ---------- 로그인 (Firebase 설정 시) ----------
if (cloud.enabled) {
  $('#auth').hidden = false
  $('#login').onclick = () => cloud.login().catch(err => {
    if (err?.code !== 'auth/popup-closed-by-user') toast('로그인하지 못했어요: ' + (err?.code || err))
  })
  $('#logout').onclick = () => cloud.logout()
  updateLobbyWallet()
  cloud.initCloud(async user => {
    uid = user?.uid || null
    $('#login').hidden = !!uid
    $('#user-line').hidden = !uid
    if (uid) {
      $('#user-name').textContent = user.displayName || user.email || '플레이어'
      try {
        const saved = await cloud.loadPlayer(uid)
        if (saved) Object.assign(wallet, saved)
        else Object.assign(wallet, { name: (user.displayName || '').slice(0, 12), tokens: CONFIG.START_TOKENS, day: today(), refills: 0 })
        rollover()
        refillIfBroke()
        saveWallet()
        nameInput.value = wallet.name
      } catch (err) {
        console.warn(err)
        toast('저장된 정보를 불러오지 못했어요.')
        uid = null
      }
    }
    updateLobbyWallet()
  }).catch(err => { console.warn(err); toast('Firebase에 연결하지 못했어요.') })
}

// ---------- 방 입장 ----------
function enter(code, host) {
  roomCode = code
  isHost = host
  history.replaceState(null, '', '#' + code)
  $('#lobby').hidden = true
  $('#game').hidden = false
  $('#room-code').textContent = code

  room = joinRoom({ appId: APP_ID }, 'poker-' + code)
  act = {
    state: room.makeAction('state'),
    hole: room.makeAction('hole'),
    info: room.makeAction('info'),
    move: room.makeAction('move'),
  }

  if (isHost) {
    hostId = selfId
    table = new Table()
    table.addPlayer(selfId, wallet.name, wallet.tokens)
    act.info.onMessage = (d, { peerId }) => onInfo(peerId, d)
    act.move.onMessage = (d, { peerId }) => hostMove(peerId, d)
    room.onPeerJoin = p => act.state.send(publicState(), { target: p })
    room.onPeerLeave = p => { table.removePlayer(p); afterChange() }
    window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })
    afterChange()
  } else {
    room.onPeerJoin = p => act.info.send(myInfo(), { target: p })
    act.state.onMessage = (d, { peerId }) => {
      if (!d || d.hostId !== peerId || (hostId && hostId !== peerId)) return
      hostId = peerId
      onState(d)
    }
    act.hole.onMessage = (d, { peerId }) => { if (peerId === hostId) onHole(d) }
    room.onPeerLeave = p => { if (p === hostId) showOverlay('방장이 나갔습니다', '방장이 나가면 게임이 끝납니다. 로비로 돌아가 새 방을 만들어 주세요.') }
    render()
    setTimeout(() => { if (!state) $('#status').textContent = '아직 방을 찾지 못했어요. 방 코드가 맞는지, 방장이 접속해 있는지 확인하세요.' }, 15000)
  }
}

function sendInfo() {
  if (isHost) { table.updateInfo(selfId, myInfo()); afterChange() }
  else if (hostId) act.info.send(myInfo(), { target: hostId })
}

// ---------- 호스트 전용 ----------
function publicState() {
  const s = table.publicState()
  s.hostId = selfId
  s.running = running
  s.turnLeft = turnDeadline ? Math.max(0, turnDeadline - Date.now()) : 0
  return s
}

function onInfo(peerId, d) {
  if (!d || typeof d !== 'object') return
  const name = String(d.name || '손님').trim().slice(0, 12) || '손님'
  if (table.seat(peerId)) table.updateInfo(peerId, { name, sitOut: !!d.sitOut, tokens: d.tokens | 0 })
  else {
    table.addPlayer(peerId, name, Math.min(Math.max(0, d.tokens | 0), 1e9))
    table.updateInfo(peerId, { sitOut: !!d.sitOut })
  }
  afterChange()
}

function hostMove(id, d) {
  const r = table.act(id, d?.type, d?.amount)
  if (!r.ok) { if (id === selfId) toast(r.error); return }
  afterChange()
}

// 테이블이 바뀔 때마다: 타이머 관리 → 다음 판 예약 → 모두에게 전송
function afterChange() {
  if (table.turnSeq !== timerSeq) {
    timerSeq = table.turnSeq
    clearTimeout(turnTimer)
    const id = table.toActId()
    if (id) {
      turnDeadline = Date.now() + CONFIG.TURN_MS
      turnTimer = setTimeout(() => timeout(id), CONFIG.TURN_MS)
    } else turnDeadline = 0
  }
  if (running && !table.isBetting()) scheduleNext()
  const s = publicState()
  act.state.send(s)
  onState(s)
}

function timeout(id) {
  const s = table.seat(id)
  if (!s || table.toActId() !== id) return
  table.act(id, table.currentBet > s.bet ? 'fold' : 'check')
  s.last += ' (시간 초과)'
  afterChange()
}

function scheduleNext() {
  if (nextTimer) return
  const delay = table.phase === 'showdown' ? CONFIG.NEXT_HAND_MS : 1500
  nextTimer = setTimeout(() => { nextTimer = null; tryStart() }, delay)
}

function tryStart() {
  const holes = table.startHand()
  if (!holes) { act.state.send(publicState()); onState(publicState()); return }
  for (const [id, cards] of Object.entries(holes)) {
    const msg = { handNo: table.handNo, cards }
    if (id === selfId) onHole(msg)
    else act.hole.send(msg, { target: id }) // 내 카드는 나에게만 전송
  }
  afterChange()
}

// ---------- 모두 ----------
function onState(s) {
  state = s
  turnDeadline = s.turnLeft ? Date.now() + s.turnLeft : 0
  const me = s.seats.find(p => p.id === selfId)
  if (me && !me.left) {
    if (me.stack > 0) refillPending = false
    if (!refillPending) { wallet.tokens = me.stack; saveWallet() }
    const busy = me.inHand && ['preflop', 'flop', 'turn', 'river'].includes(s.phase)
    if (me.stack === 0 && !busy && !refillPending && refillIfBroke()) {
      refillPending = true
      toast(`토큰이 바닥나서 기본 토큰 ${CONFIG.START_TOKENS.toLocaleString()}을 다시 받았어요!`)
      sendInfo()
      if (isHost) return // sendInfo가 이미 새 상태로 다시 그림
    }
  }
  render()
}

function onHole(d) {
  myHole = d
  render()
}

function sendMove(type, amount) {
  if (isHost) hostMove(selfId, { type, amount })
  else act.move.send({ type, amount }, { target: hostId })
}

// ---------- 화면 ----------
function cardHtml(c, cls = '') {
  if (!c) return `<div class="card back ${cls}"></div>`
  const red = c[1] === 'h' || c[1] === 'd'
  const r = c[0] === 'T' ? '10' : c[0]
  return `<div class="card ${red ? 'red' : ''} ${cls}"><span>${r}</span><span>${SUIT[c[1]]}</span></div>`
}

function render() {
  const me = state?.seats.find(p => p.id === selfId)
  $('#my-tokens').textContent = (me ? me.stack + me.bet : wallet.tokens).toLocaleString()

  if (!state) {
    $('#status').textContent = '방장에게 연결하는 중…'
    return
  }

  // 자리 배치: 내가 항상 아래쪽
  const seats = state.seats
  const n = seats.length
  const mine = Math.max(0, seats.findIndex(p => p.id === selfId))
  const hasMyHole = myHole && myHole.handNo === state.handNo
  $('#seats').innerHTML = seats.map((p, i) => {
    const pos = (i - mine + n) % n
    const ang = Math.PI / 2 + (pos * 2 * Math.PI) / Math.max(n, 2)
    const x = 50 + 44 * Math.cos(ang), y = 50 + 42 * Math.sin(ang)
    let cards = ''
    if (p.id === selfId && hasMyHole && p.inHand) cards = myHole.cards.map(c => cardHtml(c)).join('')
    else if (p.cards) cards = p.cards.map(c => cardHtml(c)).join('')
    else if (p.inHand && !p.folded) cards = cardHtml(null) + cardHtml(null)
    const turn = p.id === state.toActId
    const tags = [
      p.id === state.hostId ? '<i class="tag">방장</i>' : '',
      p.left ? '<i class="tag">나감</i>' : p.sitOut ? '<i class="tag">쉬는 중</i>' : '',
      !p.inHand && p.stack <= 0 ? '<i class="tag">토큰 없음</i>' : '',
    ].join('')
    const win = state.result?.winners.find(w => w.id === p.id)
    return `<div class="seat ${turn ? 'turn' : ''} ${p.folded ? 'folded' : ''} ${p.id === selfId ? 'me' : ''} ${win ? 'winner' : ''}"
              style="left:${x}%;top:${y}%">
      <div class="cards">${cards}</div>
      <div class="plate">
        ${p.id === state.dealerId ? '<b class="dealer">D</b>' : ''}
        <div class="pname">${esc(p.name)}${tags}</div>
        <div class="stack">🪙 ${p.stack.toLocaleString()}</div>
        ${turn ? '<div class="timer"><i></i></div>' : ''}
      </div>
      ${p.last ? `<div class="last">${esc(p.last)}</div>` : ''}
      ${p.bet ? `<div class="bet">${p.bet}</div>` : ''}
    </div>`
  }).join('')

  $('#board').innerHTML = [0, 1, 2, 3, 4].map(i => state.board[i] ? cardHtml(state.board[i], 'deal') : '<div class="card slot"></div>').join('')
  const potTotal = state.pot + seats.reduce((a, p) => a + p.bet, 0)
  $('#pot').textContent = potTotal ? `팟 ${potTotal.toLocaleString()}` : ''

  // 결과 / 상태 문구
  const r = state.result
  $('#result').innerHTML = r && !['preflop', 'flop', 'turn', 'river'].includes(state.phase)
    ? r.winners.map(w => `🏆 <b>${esc(w.name)}</b> +${w.amount.toLocaleString()}${w.hand ? ` <small>${esc(w.hand)}</small>` : ''}`).join('<br>')
    : ''
  const actor = seats.find(p => p.id === state.toActId)
  let status = PHASES[state.phase] || ''
  if (actor) status += ` · ${actor.id === selfId ? '내 차례!' : esc(actor.name) + ' 님 차례'}`
  else if (state.phase === 'waiting' || state.phase === 'showdown') {
    const ready = seats.filter(p => !p.left && !p.sitOut && p.stack > 0).length
    if (!state.running) status += isHost ? ` · ${ready}명 준비됨 — 시작 버튼을 누르세요` : ' · 방장이 시작하길 기다리는 중'
    else if (ready < 2) status += ' · 참여 가능한 플레이어가 2명 이상 필요합니다'
    else if (state.phase === 'showdown') status += ' · 곧 다음 판이 시작됩니다'
  }
  if (!me) status += ' · 자리가 꽉 차서 관전 중'
  else if (me.stack === 0 && !me.inHand && outForToday()) {
    status = '<span class="out">오늘 받을 수 있는 토큰을 모두 썼어요. 내일 다시 참여할 수 있어요. (관전은 계속 가능)</span>'
  }
  $('#status').innerHTML = status

  $('#start').hidden = !(isHost && !state.running)
  $('#sitout').checked = sitOut
  $('#sitout-wrap').hidden = !me
  $('#log').innerHTML = state.log.map(l => `<div>${esc(l)}</div>`).join('')
  $('#log').scrollTop = 1e9

  renderActions(me)
}

function renderActions(me) {
  const bar = $('#actions')
  if (!me || state.toActId !== selfId) { bar.innerHTML = ''; bar.hidden = true; return }
  bar.hidden = false
  const toCall = state.currentBet - me.bet
  const maxTo = me.bet + me.stack
  const minTo = Math.min(maxTo, state.currentBet + state.minRaise)
  const canRaise = maxTo > state.currentBet
  raiseTo = Math.min(maxTo, Math.max(minTo, raiseTo))
  const potTotal = state.pot + state.seats.reduce((a, p) => a + p.bet, 0)
  const preset = f => Math.min(maxTo, Math.max(minTo, state.currentBet + Math.round((potTotal + toCall) * f)))

  bar.innerHTML = `
    <div class="row">
      <button class="btn fold" data-a="fold">폴드</button>
      ${toCall <= 0
        ? '<button class="btn check" data-a="check">체크</button>'
        : `<button class="btn call" data-a="call">콜 ${Math.min(toCall, me.stack).toLocaleString()}</button>`}
      ${canRaise && maxTo > minTo ? `<button class="btn raise" data-a="raise">${state.currentBet ? '레이즈' : '벳'} <b id="raise-val">${raiseTo}</b></button>` : ''}
      <button class="btn allin" data-a="allin">올인 ${maxTo.toLocaleString()}</button>
    </div>
    ${canRaise && maxTo > minTo ? `
    <div class="row slider">
      <input type="range" id="raise" min="${minTo}" max="${maxTo}" step="${state.bb / 2}" value="${raiseTo}">
      <button class="chip" data-p="${minTo}">최소</button>
      <button class="chip" data-p="${preset(0.5)}">½팟</button>
      <button class="chip" data-p="${preset(1)}">팟</button>
    </div>` : ''}`

  const slider = $('#raise')
  if (slider) slider.oninput = () => { raiseTo = +slider.value; $('#raise-val').textContent = raiseTo }
  bar.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    raiseTo = +b.dataset.p; slider.value = raiseTo; $('#raise-val').textContent = raiseTo
  })
  bar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const a = b.dataset.a
    sendMove(a, a === 'raise' ? (raiseTo >= maxTo ? maxTo : raiseTo) : undefined)
    raiseTo = 0
  })
}

// 차례 타이머 막대
setInterval(() => {
  const bar = document.querySelector('.timer i')
  if (bar && turnDeadline) bar.style.width = Math.max(0, (turnDeadline - Date.now()) / CONFIG.TURN_MS * 100) + '%'
}, 200)

$('#start').onclick = () => { running = true; tryStart() }
$('#sitout').onchange = e => { sitOut = e.target.checked; sendInfo() }
$('#copy').onclick = async () => {
  const url = location.href.split('#')[0] + '#' + roomCode
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!') }
  catch { prompt('이 링크를 친구에게 보내세요', url) }
}
$('#leave').onclick = () => {
  if (state?.toActId && !confirm('게임 중에 나가면 이번 판에 건 토큰은 잃습니다. 나갈까요?')) return
  room?.leave()
  location.hash = ''
  location.reload()
}

function showOverlay(title, msg) {
  $('#overlay').hidden = false
  $('#overlay-title').textContent = title
  $('#overlay-msg').textContent = msg
}
$('#overlay-btn').onclick = () => { room?.leave(); location.hash = ''; location.reload() }

let toastTimer
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
}
