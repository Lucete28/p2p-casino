// P2P 연결 + 화면. 방을 만든 사람(호스트)이 딜러 역할을 하며 게임 상태를 결정한다.
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm'
import { CONFIG, Table } from './poker.js'
import * as cloud from './cloud.js'
import { analyze, currentHand, HAND_RANKS, HAND_EXAMPLES, HAND_DESC } from './odds.js'

const VERSION = '1.3.0' // 배포할 때마다 올리기 (README의 버전 기록도 함께)
const APP_ID = 'p2p-casino-poker-v1'
const STORE = 'p2pcasino.v1'
const PHASES = { waiting: '대기 중', preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', showdown: '결과' }
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }
const BETTING = ['preflop', 'flop', 'turn', 'river']
// 인원수별 자리 배치 (6자리 중 최대한 고르게 퍼지도록). 게임 순서는 그대로, 보이는 위치만 정함
const SEAT_LAYOUT = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5] }
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

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
const canRefill = () => { rollover(); return wallet.tokens <= 0 && wallet.refills < CONFIG.DAILY_REFILLS }
const wallet = cloud.enabled
  ? { name: '', tokens: 0, day: today(), refills: 0 }
  : loadWallet()
if (!cloud.enabled) saveWallet()

// ---------- 상태 ----------
let room, act, isHost = false, hostId = null
let table = null          // 호스트만 가짐
let state = null          // 화면에 그릴 공개 상태
let myHole = null
let refillPending = false
let bustPrompted = null
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
$('#version').textContent = $('#version-game').textContent = 'v' + VERSION
updateLobbyWallet()
if (!cloud.enabled && canRefill()) openBankrupt()

function updateLobbyWallet() {
  const needLogin = cloud.enabled && !uid
  $('#lobby-wallet').hidden = needLogin
  $('#create').disabled = $('#join').disabled = needLogin
  if (needLogin) return
  $('#lobby-wallet').innerHTML =
    `보유 토큰 <b>${wallet.tokens.toLocaleString()}</b>` +
    (canRefill() ? `<br><button id="lobby-refill" class="btn gold">🪙 기본 토큰 ${CONFIG.START_TOKENS.toLocaleString()} 받기</button>` : '') +
    (outForToday() ? '<br><span class="out">오늘 받을 수 있는 토큰을 모두 받았어요.<br>내일 다시 참여할 수 있어요.</span>' : '')
  const btn = $('#lobby-refill')
  if (btn) btn.onclick = openBankrupt
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
        saveWallet()
        nameInput.value = wallet.name
        if (canRefill()) openBankrupt()
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
  if (table.lastAction?.id === id) table.lastAction.label = s.last
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
    const busy = me.inHand && BETTING.includes(s.phase)
    // 파산: 판이 끝난 뒤 한 번 안내창을 띄운다 ("나중에"를 누르면 아래 버튼으로 다시 열 수 있음)
    if (me.stack === 0 && !busy && !refillPending && bustPrompted !== s.handNo) {
      bustPrompted = s.handNo
      openBankrupt()
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
  const n = CONFIG.MAX_SEATS
  const hasMyHole = myHole && myHole.handNo === state.handNo
  // 결과 화면: 이긴 사람의 족보 5장은 빛나게, 나머지는 흐리게
  const r = state.result
  const hi = r && !BETTING.includes(state.phase) && r.winners.some(w => w.best)
    ? new Set(r.winners.flatMap(w => w.best || [])) : null
  const mark = c => (hi ? (hi.has(c) ? 'hi' : 'dim') : '')
  const layout = SEAT_LAYOUT[Math.min(seats.length, n)] || [0]
  const slots = Array(n).fill(null)
  layout.forEach((slot, k) => { if (seats[k]) slots[slot] = seats[k] })
  const mySlot = layout[Math.max(0, seats.findIndex(p => p.id === selfId))] ?? 0
  $('#seats').innerHTML = slots.map((p, i) => {
    const pos = (i - mySlot + n) % n
    const ang = Math.PI / 2 + (pos * 2 * Math.PI) / n
    const x = 50 + 44 * Math.cos(ang), y = 50 + 42 * Math.sin(ang)
    if (!p) return `<div class="seat empty" style="left:${x}%;top:${y}%"><div class="plate"><div class="pname">빈 자리</div></div></div>`
    let cards = ''
    if (p.id === selfId && hasMyHole && p.inHand) cards = myHole.cards.map(c => cardHtml(c, p.cards ? mark(c) : '')).join('')
    else if (p.cards) cards = p.cards.map(c => cardHtml(c, mark(c))).join('')
    else if (p.inHand && !p.folded) cards = cardHtml(null) + cardHtml(null)
    const turn = p.id === state.toActId
    const tags = [
      p.id === state.hostId ? '<i class="tag">방장</i>' : '',
      p.left ? '<i class="tag">나감</i>' : p.sitOut ? '<i class="tag">쉬는 중</i>' : '',
      !p.inHand && p.stack <= 0 ? '<i class="tag">토큰 없음</i>' : '',
    ].join('')
    const win = state.result?.winners.find(w => w.id === p.id)
    return `<div class="seat ${turn ? 'turn' : ''} ${p.folded ? 'folded' : ''} ${p.id === selfId ? 'me' : ''} ${win ? 'winner' : ''}"
              data-id="${esc(p.id)}" style="left:${x}%;top:${y}%">
      ${win ? '<b class="crown">👑</b>' : ''}
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

  // 누가 무엇을 했는지 그 사람 자리에 효과로 표시 (처음 받은 상태는 건너뜀)
  const la = state.lastAction
  if (la && la.seq !== actShown) {
    if (actShown !== null) showActionFx(la)
    actShown = la.seq
  } else if (actShown === null) actShown = la ? la.seq : 0

  const fresh = boardSeen.hand === state.handNo ? boardSeen.len : 0
  boardSeen = { hand: state.handNo, len: state.board.length }
  $('#board').innerHTML = [0, 1, 2, 3, 4].map(i => state.board[i]
    ? cardHtml(state.board[i], `${i >= fresh ? 'deal' : ''} ${mark(state.board[i])}`)
    : '<div class="card slot"></div>').join('')
  const potTotal = state.pot + seats.reduce((a, p) => a + p.bet, 0)
  $('#pot').textContent = potTotal ? `팟 ${potTotal.toLocaleString()}` : ''
  renderWaiting(seats)

  // 결과 배너 (내용이 바뀔 때만 다시 그려서 애니메이션이 한 번만 나오게)
  const showResult = r && !BETTING.includes(state.phase)
  const resultKey = showResult ? state.handNo : 0
  if (resultKey !== resultShown) {
    resultShown = resultKey
    const iWon = showResult && r.winners.some(w => w.id === selfId)
    $('#result').className = 'result' + (showResult ? ' big' : '') + (iWon ? ' mine' : '')
    $('#result').innerHTML = showResult
      ? (iWon ? '<div class="win-title">승리!</div>' : '') +
        r.winners.map(w => `🏆 <b>${esc(w.name)}</b> <span class="amt">+${w.amount.toLocaleString()}</span>${w.hand ? ` <small>${esc(w.hand)}</small>` : ''}`).join('<br>')
      : ''
    if (showResult && state.handNo !== celebrated) { celebrated = state.handNo; celebrate(r) }
  }
  const actor = seats.find(p => p.id === state.toActId)
  let status = PHASES[state.phase] || ''
  if (actor) status += ` · ${actor.id === selfId ? '내 차례!' : esc(actor.name) + ' 님 차례'}`
  else if (state.phase === 'waiting' || state.phase === 'showdown') {
    const ready = seats.filter(p => !p.left && !p.sitOut && p.stack > 0).length
    if (!state.running) status += ready < 2 ? '' : isHost ? ' · 시작 버튼을 누르세요' : ' · 방장이 시작하길 기다리는 중'
    else if (ready < 2) status += ' · 참여 가능한 플레이어가 2명 이상 필요합니다'
    else if (state.phase === 'showdown') status += ' · 곧 다음 판이 시작됩니다'
  }
  if (!me) status += ' · 자리가 꽉 차서 관전 중'
  else if (me.stack === 0 && !me.inHand && outForToday()) {
    status = '<span class="out">오늘 받을 수 있는 토큰을 모두 썼어요. 내일 다시 참여할 수 있어요. (관전은 계속 가능)</span>'
  }
  $('#status').innerHTML = status

  $('#start').hidden = !(isHost && !state.running)
  const busyMe = me && me.inHand && BETTING.includes(state.phase)
  $('#refill-btn').hidden = !(me && me.stack === 0 && !busyMe && !refillPending && canRefill())
  $('#sitout').checked = sitOut
  $('#sitout-wrap').hidden = !me
  $('#log').innerHTML = state.log.map(l => `<div>${esc(l)}</div>`).join('')
  $('#log').scrollTop = 1e9

  renderActions(me)
  renderOdds(me, hasMyHole)
}

// ---------- 대기 인원 ----------
const WAIT_ICON = { ready: '✅', sitout: '💤', broke: '💸', left: '🚪' }

function renderWaiting(seats) {
  $('#headcount').textContent = `👥 ${seats.length}/${CONFIG.MAX_SEATS}`
  const waiting = !BETTING.includes(state.phase) && (state.phase === 'waiting' || !state.running)
  $('#waiting').hidden = !waiting
  $('#board').hidden = waiting
  $('#result').hidden = waiting
  if (!waiting) return
  const kind = p => (p.left ? 'left' : p.sitOut ? 'sitout' : p.stack <= 0 ? 'broke' : 'ready')
  const ready = seats.filter(p => kind(p) === 'ready').length
  const need = Math.max(0, 2 - ready)
  const sub = need > 0 ? `<b>${need}명</b> 더 모이면 시작할 수 있어요`
    : !state.running ? (isHost ? '준비됐어요! 아래 <b>게임 시작</b>을 눌러 주세요' : '방장이 시작하길 기다리는 중')
    : '곧 다음 판이 시작됩니다'
  const label = { ready: '참가', sitout: '쉬는 중', broke: '토큰 없음', left: '나감' }
  $('#waiting').innerHTML = `
    <div class="wait-count">👥 <b>${seats.length}</b><span>/ ${CONFIG.MAX_SEATS}명</span></div>
    <div class="wait-sub">${sub}</div>
    <div class="wait-list">${seats.map(p => `<span class="wchip ${kind(p)}" title="${label[kind(p)]}">${WAIT_ICON[kind(p)]} ${esc(p.name)}</span>`).join('')}</div>
    ${seats.length < CONFIG.MAX_SEATS ? '<div class="wait-hint">위쪽 <b>초대 링크 복사</b>로 친구를 불러 보세요</div>' : ''}`
}

// ---------- 파산 안내 ----------
function openBankrupt() {
  const box = $('#bankrupt')
  if (canRefill()) {
    $('#bk-icon').textContent = '💸'
    $('#bk-title').textContent = '토큰을 모두 잃었어요'
    $('#bk-msg').innerHTML = `괜찮아요! 기본 토큰 <b>${CONFIG.START_TOKENS.toLocaleString()}</b>개를 받아서 다시 도전할 수 있어요.`
    $('#bk-claim').hidden = false
    $('#bk-later').textContent = '나중에'
  } else if (outForToday()) {
    $('#bk-icon').textContent = '🌙'
    $('#bk-title').textContent = '오늘은 여기까지'
    $('#bk-msg').innerHTML = '오늘 받을 수 있는 토큰을 모두 받았어요.<br>내일 다시 참여할 수 있어요. 관전은 계속 할 수 있어요.'
    $('#bk-claim').hidden = true
    $('#bk-later').textContent = '확인'
  } else return
  box.hidden = false
  $(canRefill() ? '#bk-claim' : '#bk-later').focus()
}

function claimRefill() {
  $('#bankrupt').hidden = true
  if (!refillIfBroke()) return
  toast(`🪙 기본 토큰 ${CONFIG.START_TOKENS.toLocaleString()}개를 받았어요!`)
  updateLobbyWallet()
  if (room) { refillPending = true; sendInfo() }
  if (state) render()
}
$('#bk-claim').onclick = claimRefill
$('#bk-later').onclick = () => { $('#bankrupt').hidden = true; if (state) render() }
$('#refill-btn').onclick = openBankrupt

// ---------- 행동 효과 ----------
let actShown = null
const ACT_ICON = { fold: '✖', check: '✔', call: '●', bet: '▲', raise: '▲', allin: '🔥' }

function showActionFx(a) {
  const seat = document.querySelector(`.seat[data-id="${CSS.escape(a.id)}"]`)
  if (!seat) return
  const sx = parseFloat(seat.style.left), sy = parseFloat(seat.style.top)
  const fx = $('#fx')
  // 자리에서 퍼지는 고리
  const ring = document.createElement('div')
  ring.className = `act-ring ${a.kind}`
  ring.style.left = sx + '%'
  ring.style.top = sy + '%'
  fx.appendChild(ring)
  setTimeout(() => ring.remove(), 900)
  // 자리 앞(테이블 안쪽)에 행동 말풍선
  const bub = document.createElement('div')
  bub.className = `act-fx ${a.kind}`
  bub.textContent = `${ACT_ICON[a.kind] || ''} ${a.label}`
  bub.style.left = 50 + (sx - 50) * 0.45 + '%'
  bub.style.top = 50 + (sy - 50) * 0.45 + '%'
  fx.appendChild(bub)
  setTimeout(() => bub.remove(), 1800)
}

// ---------- 승리 연출 ----------
let boardSeen = { hand: 0, len: 0 }, resultShown = 0, celebrated = 0

function celebrate(r) {
  const fx = $('#fx')
  const iWon = r.winners.some(w => w.id === selfId)
  for (const w of r.winners) {
    const seat = document.querySelector(`.seat[data-id="${CSS.escape(w.id)}"]`)
    if (!seat) continue
    const x = seat.style.left, y = seat.style.top
    // +금액 떠오르기
    const amt = document.createElement('div')
    amt.className = 'float-amt'
    amt.textContent = '+' + w.amount.toLocaleString()
    amt.style.left = x
    amt.style.top = y
    fx.appendChild(amt)
    setTimeout(() => amt.remove(), 2200)
    if (reduceMotion) continue
    // 팟에서 승자에게 칩이 날아감
    for (let i = 0; i < 10; i++) {
      const chip = document.createElement('div')
      chip.className = 'fly-chip'
      chip.style.left = 50 + (Math.random() * 8 - 4) + '%'
      chip.style.top = 50 + (Math.random() * 8 - 4) + '%'
      fx.appendChild(chip)
      setTimeout(() => { chip.style.left = x; chip.style.top = y; chip.style.opacity = '0.2' }, 40 + i * 60)
      setTimeout(() => chip.remove(), 1400 + i * 60)
    }
  }
  if (iWon && !reduceMotion) confetti()
}

function confetti() {
  const cv = document.createElement('canvas')
  cv.className = 'confetti'
  cv.width = innerWidth
  cv.height = innerHeight
  document.body.appendChild(cv)
  const ctx = cv.getContext('2d')
  const colors = ['#e3b341', '#f2c94c', '#3fb950', '#d1342f', '#58a6ff', '#ffffff']
  const parts = Array.from({ length: 160 }, () => ({
    x: cv.width / 2, y: cv.height * 0.45,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 14 - 4,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 5,
    rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colors[Math.floor(Math.random() * colors.length)],
  }))
  const start = performance.now()
  ;(function frame(now) {
    const t = now - start
    ctx.clearRect(0, 0, cv.width, cv.height)
    for (const p of parts) {
      p.vy += 0.35
      p.x += p.vx
      p.y += p.vy
      p.rot += p.vr
      ctx.save()
      ctx.globalAlpha = Math.max(0, 1 - t / 2600)
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.c
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      ctx.restore()
    }
    if (t < 2600) requestAnimationFrame(frame)
    else cv.remove()
  })(start)
}

// ---------- 내 패 분석 (족보 + 확률) ----------
let oddsKey = '', oddsResult = null
let oddsOpen = true
try { oddsOpen = localStorage.getItem('p2pcasino.odds') !== 'closed' } catch {}

function renderOdds(me, hasMyHole) {
  const box = $('#odds')
  const active = me && hasMyHole && me.inHand && !me.folded && BETTING.includes(state.phase)
  if (!active) { box.hidden = true; oddsKey = ''; return }
  box.hidden = false
  const opponents = state.seats.filter(p => p.inHand && !p.folded && p.id !== selfId).length
  const key = [myHole.handNo, ...myHole.cards, ...state.board, opponents].join(',')
  if (key !== oddsKey) {
    oddsKey = key
    oddsResult = null
    analyze(myHole.cards, state.board, opponents, () => oddsKey !== key)
      .then(res => { if (res && oddsKey === key) { oddsResult = res; drawOdds() } })
  }
  drawOdds()
}

const pct = p => (p >= 0.9995 ? '100%' : p > 0 && p < 0.001 ? '<0.1%' : (p * 100).toFixed(1) + '%')

function drawOdds() {
  const cur = currentHand(myHole.cards, state.board)
  const head = `<button class="odds-head" id="odds-toggle" aria-expanded="${oddsOpen}">
      <span>지금 내 족보 <b>${HAND_RANKS[cur.cat]}</b></span>
      <span class="eq">${oddsResult ? (oddsResult.equity != null ? `예상 승률 <b>${pct(oddsResult.equity)}</b>` : '') : '계산 중…'}</span>
      <span class="caret">${oddsOpen ? '▾' : '▸'}</span>
    </button>`
  let body = ''
  if (oddsOpen && oddsResult) {
    const rows = []
    for (let c = 9; c >= 0; c--) {
      const p = oddsResult.dist[c]
      if (!p) continue
      rows.push(`<div class="odds-row ${c === cur.cat ? 'now' : ''}">
        <span class="nm">${HAND_RANKS[c]}${c === cur.cat ? ' <i>현재</i>' : ''}</span>
        <span class="bar"><i style="width:${Math.max(1, p * 100)}%"></i></span>
        <span class="pc">${pct(p)}</span></div>`)
    }
    body = `<div class="odds-rows">${rows.join('')}</div>
      <p class="odds-note">${state.board.length === 5 ? '최종 족보' : '리버까지 갔을 때 완성될 확률'} · 승률은 상대 패를 모른다고 가정한 추정치</p>`
  }
  $('#odds').innerHTML = head + body
  $('#odds-toggle').onclick = () => {
    oddsOpen = !oddsOpen
    try { localStorage.setItem('p2pcasino.odds', oddsOpen ? 'open' : 'closed') } catch {}
    drawOdds()
  }
}

// ---------- 족보표 ----------
function openRanks() {
  const me = state?.seats.find(p => p.id === selfId)
  const live = me && myHole && myHole.handNo === state.handNo && me.inHand && !me.folded
  const cur = live ? currentHand(myHole.cards, state.board).cat : -1
  const rows = []
  for (let c = 9; c >= 0; c--) {
    rows.push(`<li class="${c === cur ? 'now' : ''}">
      <span class="rk">${10 - c}</span>
      <div class="rinfo"><b>${HAND_RANKS[c]}</b>${c === cur ? ' <i>내 족보</i>' : ''}<small>${HAND_DESC[c]}</small></div>
      <div class="mini-cards">${HAND_EXAMPLES[c].map(x => cardHtml(x, 'mini')).join('')}</div>
    </li>`)
  }
  $('#ranks-list').innerHTML = rows.join('')
  $('#ranks').hidden = false
}
$('#ranks-btn').onclick = openRanks
$('#ranks-close').onclick = () => { $('#ranks').hidden = true }
$('#ranks').onclick = e => { if (e.target.id === 'ranks') $('#ranks').hidden = true }
addEventListener('keydown', e => { if (e.key === 'Escape') $('#ranks').hidden = true })

let actionKey = ''

function renderActions(me) {
  const bar = $('#actions')
  if (!me || state.toActId !== selfId) { bar.innerHTML = ''; bar.hidden = true; actionKey = ''; return }
  // 같은 차례 안에서는 다시 그리지 않음 (입력 중인 금액과 포커스 유지)
  const key = [state.turnSeq, me.stack, me.bet, state.currentBet, state.minRaise, state.pot].join(',')
  if (key === actionKey) return
  actionKey = key
  bar.hidden = false

  const bb = state.bb
  const toCall = state.currentBet - me.bet
  const maxTo = me.bet + me.stack
  const minTo = Math.min(maxTo, state.currentBet + state.minRaise)
  const canRaise = maxTo > minTo
  const verb = state.currentBet ? '레이즈' : '벳'
  const potTotal = state.pot + state.seats.reduce((a, p) => a + p.bet, 0)
  const clamp = v => Math.min(maxTo, Math.max(minTo, Math.round(v)))
  raiseTo = clamp(raiseTo || minTo)

  // 빠른 금액: [이름, 올릴 총액]
  const potTo = f => state.currentBet + (potTotal + toCall) * f
  const presets = [
    ['최소', minTo],
    [state.currentBet ? '3배' : '3BB', state.currentBet ? state.currentBet * 3 : bb * 3],
    ['½팟', potTo(0.5)],
    ['¾팟', potTo(0.75)],
    ['팟', potTo(1)],
  ]

  bar.innerHTML = `
    <div class="row">
      <button class="btn fold" data-a="fold">폴드</button>
      ${toCall <= 0
        ? '<button class="btn check" data-a="check">체크</button>'
        : `<button class="btn call" data-a="call">콜 ${Math.min(toCall, me.stack).toLocaleString()}</button>`}
      ${canRaise ? `<button class="btn raise" data-a="raise"><span id="raise-verb">${verb}</span> <b id="raise-val"></b></button>` : ''}
      <button class="btn allin" data-a="allin">올인 ${maxTo.toLocaleString()}</button>
    </div>
    ${canRaise ? `
    <div class="bet-box">
      <div class="amount-row">
        <button class="step" data-step="-1" aria-label="${bb}만큼 줄이기">−</button>
        <input id="raise-input" class="amt-input" type="number" inputmode="numeric" min="${minTo}" max="${maxTo}" step="${bb}" aria-label="${verb} 금액">
        <button class="step" data-step="1" aria-label="${bb}만큼 늘리기">+</button>
        <span class="extra" id="raise-extra"></span>
      </div>
      <input type="range" id="raise" min="${minTo}" max="${maxTo}" step="1" aria-label="${verb} 금액 슬라이더">
      <div class="range-labels"><span>최소 ${minTo.toLocaleString()}</span><span>최대 ${maxTo.toLocaleString()}</span></div>
      <div class="presets">
        ${presets.map(([name, v]) => `<button class="chip" data-p="${clamp(Math.round(v / (bb / 2)) * (bb / 2))}" ${v > maxTo ? 'disabled' : ''}>${name}</button>`).join('')}
      </div>
    </div>` : ''}`

  const slider = $('#raise'), input = $('#raise-input')
  function setRaise(v, fromInput) {
    raiseTo = clamp(v)
    if (slider) slider.value = raiseTo
    if (input && !fromInput) input.value = raiseTo
    const allIn = raiseTo >= maxTo
    $('#raise-verb').textContent = allIn ? '올인' : verb
    $('#raise-val').textContent = raiseTo.toLocaleString()
    $('#raise-extra').innerHTML = `추가로 <b>${(raiseTo - me.bet).toLocaleString()}</b> 냄`
    let marked = false // 같은 금액인 빠른 버튼이 여럿이면 첫 번째만 표시
    bar.querySelectorAll('[data-p]').forEach(b => {
      const on = !marked && +b.dataset.p === raiseTo
      if (on) marked = true
      b.classList.toggle('active', on)
    })
  }
  if (canRaise) {
    setRaise(raiseTo)
    slider.oninput = () => setRaise(+slider.value)
    // 직접 입력: 입력 중에는 범위를 강제하지 않고, 칸을 벗어나거나 Enter를 누를 때 맞춤
    input.oninput = () => { if (input.value !== '') setRaise(+input.value, true) }
    input.onchange = () => setRaise(+input.value || minTo)
    input.onkeydown = e => { if (e.key === 'Enter') { setRaise(+input.value || minTo); bar.querySelector('[data-a=raise]').click() } }
    bar.querySelectorAll('[data-step]').forEach(b => b.onclick = () => setRaise(raiseTo + bb * +b.dataset.step))
    bar.querySelectorAll('[data-p]').forEach(b => b.onclick = () => setRaise(+b.dataset.p))
  }
  bar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const a = b.dataset.a
    sendMove(a, a === 'raise' ? raiseTo : undefined)
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
