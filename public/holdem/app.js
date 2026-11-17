// 화면 + 카지노 서버 연결. 카드 섞기·판 진행·봇·코인 정산은 서버가 하고, 브라우저는 행동만 보내고 상태만 받는다 (v1.8.0~)
import { connect } from './net.js?v=1.9.1'
import { CONFIG } from './poker.js?v=1.9.1'
import * as cloud from './cloud.js?v=1.9.1'
import { analyze, currentHand, HAND_RANKS, HAND_EXAMPLES, HAND_DESC } from './odds.js?v=1.9.1'

// 카카오톡·라인 같은 앱 안 브라우저는 외부 브라우저로 (Google 로그인이 막혀 있음. 로그인 화면도 따로 안내함)
const UA = navigator.userAgent
const IN_APP = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|DaumApps|everytimeApp|\bLine\//i.test(UA)
const openExternal = () => { location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href) }
if (/KAKAOTALK/i.test(UA)) openExternal()
else if (/\bLine\//i.test(UA) && !new URLSearchParams(location.search).has('openExternalBrowser')) {
  const u = new URL(location.href)
  u.searchParams.set('openExternalBrowser', '1')
  location.replace(u)
}

const VERSION = '1.9.1' // 배포할 때마다 올리기 (README의 버전 기록도 함께)

// 연습 토큰 시절의 브라우저 저장값 정리 (토큰은 코인으로 바뀜. 닉네임만 이어 씀)
const NAME_KEY = 'casino:name'
;(function cleanupOldKeys() {
  try {
    const oldWallet = JSON.parse(localStorage.getItem('casino:wallet') || 'null')
    if (oldWallet?.name && !localStorage.getItem(NAME_KEY)) localStorage.setItem(NAME_KEY, oldWallet.name)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k === 'casino:wallet' || k?.startsWith('casino:visit.') || k?.startsWith('p2pcasino.')) localStorage.removeItem(k)
    }
  } catch {}
})()
const PHASES = { waiting: '대기 중', preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버', showdown: '결과' }
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }
const BETTING = ['preflop', 'flop', 'turn', 'river']
// 인원수별 자리 배치 (6자리 중 최대한 고르게 퍼지도록). 게임 순서는 그대로, 보이는 위치만 정함
const SEAT_LAYOUT = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5] }
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// ---------- 상태 ----------
let account = null        // JMTT 계정 { id, name, picture } (로그인 안 했으면 null)
let coins = null          // 내 코인 (앉아 있지 않을 때의 잔액)
let net = null            // 서버 연결
let selfId = null         // 이 방에서의 내 자리 ID (서버가 정함)
let isHost = false        // 방장: 봇 추가·내보내기
let state = null          // 화면에 그릴 판 상태 (서버가 보냄)
let myHole = null         // 내 카드 (서버가 나에게만 보냄)
let turnDeadline = 0
let raiseTo = 0
let roomCode = ''
let connectStage = ''
let loginDown = false

// ---------- 로비 ----------
const nameInput = $('#name'), codeInput = $('#code')
try { nameInput.value = localStorage.getItem(NAME_KEY) || '' } catch {}
codeInput.value = location.hash.slice(1).toUpperCase()
$('#version').textContent = $('#version-game').textContent = 'v' + VERSION
const inviteCode = location.hash.slice(1).toUpperCase()
if (IN_APP) {
  $('#inapp').hidden = false
  $('#inapp').innerHTML = `앱 안에서 열린 브라우저에서는 <b>Google 로그인이 안 될 수 있어요.</b><br>
    오른쪽 위 메뉴(⋮)에서 <b>다른 브라우저로 열기</b>를 눌러 주세요.
    <div class="inapp-btns">${/KAKAOTALK/i.test(UA) ? '<button id="inapp-open" class="btn gold">외부 브라우저로 열기</button>' : ''}
    <button id="inapp-copy" class="btn">링크 복사</button></div>`
  $('#inapp-open')?.addEventListener('click', openExternal)
  $('#inapp-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('링크를 복사했어요. 크롬이나 사파리에 붙여넣어 주세요.') }
    catch { prompt('이 링크를 복사해서 크롬이나 사파리에서 열어 주세요', location.href) }
  }
}

let autoJoined = false
// 초대 링크(#방코드)로 들어오면 로그인·닉네임이 준비되는 대로 바로 그 방에 입장
function tryAutoJoin() {
  if (!inviteCode || autoJoined || roomCode || !net?.ready) return
  if (!nameInput.value.trim()) { nameInput.focus(); return }
  autoJoined = true
  $('#join').click()
}

function showInvite() {
  const box = $('#invite')
  box.hidden = !inviteCode
  if (!inviteCode) return
  const next = !account ? (loginDown ? '로그인 서버 점검 중이라 지금은 들어갈 수 없어요.' : 'Google로 로그인하면 바로 들어가요.')
    : !nameInput.value.trim() ? '닉네임을 입력하고 <b>참가하기</b>를 눌러 주세요.'
    : '방에 들어가는 중…'
  box.innerHTML = `🎟 <b>${esc(inviteCode)}</b> 방에 초대받았어요<br><small>${next}</small>`
}

function updateLobbyWallet() {
  const ready = !!account && !!net?.ready
  $('#lobby-wallet').hidden = !account
  $('#create').disabled = $('#join').disabled = $('#quick').disabled = !ready
  if (account) {
    $('#lobby-wallet').innerHTML = coins == null ? '코인 불러오는 중…'
      : `보유 코인 <b>${coins.toLocaleString()}</b><br><small>방에 앉으면 가진 코인을 모두 맡기고, 일어나면 남은 칩을 돌려받아요.</small>`
      + (coins === 0 ? '<br><span class="out">코인이 없어요. 오른쪽 아래 JMTT 배지에서 출석하면 코인을 받을 수 있어요.</span>' : '')
  }
  showInvite()
}

function takeName() {
  const n = nameInput.value.trim().slice(0, 12)
  if (!n) { nameInput.focus(); toast('닉네임을 입력하세요.'); return null }
  try { localStorage.setItem(NAME_KEY, n) } catch {}
  return n
}

$('#create').onclick = () => {
  const name = takeName()
  if (name) net.send({ t: 'create', name, public: $('#public-check').checked })
}
$('#join').onclick = () => {
  const name = takeName()
  if (!name) return
  const code = codeInput.value.trim().toUpperCase()
  if (!code) { codeInput.focus(); toast('방 코드를 입력하세요.'); return }
  net.send({ t: 'join', code, name })
}
codeInput.onkeydown = e => { if (e.key === 'Enter') $('#join').click() }
nameInput.onkeydown = e => { if (e.key === 'Enter' && inviteCode) $('#join').click() } // 초대받았으면 닉네임 입력 후 Enter로 바로 입장

// ---------- 공개 방 목록 · 빠른 시작 ----------
let roomsTimer = null
async function refreshRooms() {
  if (roomCode || !account) return
  try {
    const { rooms } = await (await fetch('api/rooms', { cache: 'no-store' })).json()
    $('#public-box').hidden = false
    $('#room-list').innerHTML = rooms.length
      ? rooms.map(r => `<li>
          <div><b>${esc(r.name)}</b> 님의 방 <span class="rstate ${r.playing ? 'on' : ''}">${r.playing ? '게임 중' : '대기 중'}</span><br>
          <small>👥 ${r.humans}명${r.bots ? ` (봇 ${r.bots})` : ''} / ${CONFIG.MAX_SEATS}자리</small></div>
          <button class="btn" data-room="${esc(r.code)}" ${r.humans >= CONFIG.MAX_SEATS ? 'disabled' : ''}>참가</button>
        </li>`).join('')
      : '<li class="empty">지금 열린 방이 없어요.<br><b>⚡ 빠른 시작</b>을 누르면 봇과 바로 시작해요!</li>'
  } catch {}
}
$('#room-list').onclick = e => {
  const b = e.target.closest('[data-room]')
  const name = b && takeName()
  if (name) net.send({ t: 'join', code: b.dataset.room, name })
}
// 빈자리 있는 공개 방에 서버가 자리를 정해 줌 (없으면 봇과 새 공개 방)
$('#quick').onclick = () => {
  const name = takeName()
  if (name) net.send({ t: 'quick', name })
}

// ---------- 로그인: JMTT 계정 (DEV_REFERENCE 2-1) ----------
// 로그인은 JMTT 공통 화면에서. 로비에서는 그 화면으로 갔다가 돌아오고, 방 안·초대 링크처럼 떠나면 안 될 때는 작은 창으로
$('#auth').hidden = false
$('#login').onclick = async () => {
  if (!roomCode && !inviteCode) return cloud.loginRedirect()
  try { await cloud.loginPopup(); location.reload() }
  catch { toast('로그인 창이 막혔어요. 팝업을 허용하고 다시 눌러 주세요.') }
}
$('#logout').onclick = () => cloud.logout()
updateLobbyWallet()

;(async function start() {
  const r = await cloud.me()
  loginDown = r.state === 'down'
  account = r.me
  $('#login').hidden = !!account
  $('#login').disabled = loginDown
  $('#login span').textContent = loginDown ? '로그인 서버 점검 중' : 'Google로 로그인'
  $('#user-line').hidden = !account
  document.querySelector('.login-note').hidden = !!account || loginDown
  if (loginDown) toast('로그인 서버를 점검하고 있어요. 잠시 뒤 다시 들어와 주세요.')
  if (!account) return updateLobbyWallet()
  // 이름은 JMTT 계정 것, 게임 닉네임은 따로 (처음이면 JMTT 이름으로)
  $('#user-name').textContent = account.name || '플레이어'
  $('#user-pic').hidden = !account.picture
  if (account.picture) $('#user-pic').src = account.picture
  if (!nameInput.value) nameInput.value = (account.name || '').slice(0, 12)
  coins = r.coins ?? null
  updateLobbyWallet()
  openNet()
  loadSeasonInto($('#season-lobby'), 5, false)
  refreshRooms()
  roomsTimer = setInterval(refreshRooms, 5000)
})()

// ---------- 서버 연결 ----------
function openNet() {
  net = connect({
    onOpen() {
      connectStage = ''
      updateLobbyWallet()
      if (roomCode) net.send({ t: 'join', code: roomCode, name: nameInput.value.trim() || account?.name }) // 다시 연결되면 같은 자리로
      else tryAutoJoin()
    },
    onClose(info) {
      updateLobbyWallet()
      if (info?.auth) { toast('로그인이 풀렸어요. 다시 로그인해 주세요.'); return setTimeout(() => location.reload(), 1500) }
      if (roomCode) { connectStage = '서버와 다시 연결하는 중…'; render() }
    },
    onMessage: onServer,
  })
}

function onServer(d) {
  switch (d.t) {
    case 'me': coins = d.coins; updateLobbyWallet(); return
    case 'joined': return enterRoom(d)
    case 'state': return onState(d.s)
    case 'hole': myHole = d; return render()
    case 'toast': return toast(d.msg)
    case 'emoji': return showEmoji(d.id, d.e)
    case 'seated':
      coins = 0
      toast(d.pending ? `코인 ${d.staked.toLocaleString()}개를 맡겼어요. 이번 판이 끝나면 봇 대신 앉아요.` : `코인 ${d.staked.toLocaleString()}개를 맡기고 앉았어요.`)
      window.JMTT?.badge?.refresh?.()
      return render()
    case 'cashout':
      toast(`${d.why ? d.why + ' · ' : ''}코인 ${d.amount.toLocaleString()}개를 돌려받았어요.`)
      window.JMTT?.badge?.refresh?.()
      if (!d.amount) offerRefill('칩을 모두 잃었어요') // 파산: 로비 캐셔의 지원금 안내
      return render()
    case 'nocoins':
      offerRefill('코인이 없어요').then(shown => { if (!shown) showOverlay('코인이 없어요', '앉으려면 코인이 필요해요. 지금은 구경만 할 수 있어요.', true) })
      return
    case 'nojoin': toast(d.msg); clearInvite(); return
    case 'kicked': clearInvite(); return showOverlay('방에서 나가게 됐어요', '방장이 이 방에서 내보냈어요. 맡긴 코인은 남은 칩만큼 돌려받았어요.')
    case 'left': return backToLobby()
    case 'restart': connectStage = '서버를 다시 시작하는 중… 잠시 뒤 자동으로 다시 들어가요.'; return render()
  }
}

function enterRoom(d) {
  roomCode = d.code
  selfId = d.seatId
  myHole = null
  clearInterval(roomsTimer)
  history.replaceState(null, '', location.pathname + location.search + '#' + d.code) // 새로고침해도 같은 방·같은 자리로
  $('#lobby').hidden = true
  $('#game').hidden = false
  window.JMTT?.badge?.hide() // 게임 중에는 JMTT 배지를 숨김
  $('#room-code').textContent = d.code
  render()
}

let exitTo = '' // 나간 뒤 갈 곳 ('' = 로비, '/' = JMTT 홈)
function backToLobby() {
  clearInvite()
  if (exitTo) location.href = exitTo
  else location.reload()
}

function onState(s) {
  state = s
  turnDeadline = s.turnLeft ? Date.now() + s.turnLeft : 0
  isHost = !!selfId && s.hostId === selfId
  const meSeat = s.seats.find(p => p.id === selfId)
  // 자리 비움으로 바뀐 순간 한 번 알림
  if (meSeat && meSeat.sitOut && !wasAway) toast('시간 안에 행동하지 않아 자리 비움이 됐어요. 다시 참여를 누르면 돌아와요.')
  wasAway = !!meSeat?.sitOut
  render()
}
let wasAway = false

function sendMove(type, amount) { net?.send({ t: 'move', type, amount }) }

$('#seats').addEventListener('click', e => {
  const b = e.target.closest('[data-kick]')
  if (!b || !isHost) return
  const p = state?.seats.find(x => x.id === b.dataset.kick)
  if (p && !p.bot && !confirm(`${p.name} 님을 방에서 내보낼까요? (남은 칩은 그 사람에게 코인으로 돌아가요)`)) return
  net.send({ t: 'kick', id: b.dataset.kick })
})
$('#bot-add').onclick = () => net?.send({ t: 'bot' })
$('#sit-btn').onclick = () => { $('#sit-btn').hidden = true; net?.send({ t: 'sit' }) }
// 탭이 뒤로 갔는지 서버에 알림 (자리 비움을 더 빨리 판단)
document.addEventListener('visibilitychange', () => { if (roomCode) net?.send({ t: 'hidden', v: document.hidden }) })

function clearInvite() { history.replaceState(null, '', location.pathname + location.search) }

// ---------- 칩 그림 ----------
// 금액을 큰 칩부터 나눠 색 칩으로 쌓아 보여 준다 (그림 파일 없이 CSS로 그림)
const CHIPS = [[1000, 'gold'], [500, 'purple'], [100, 'black'], [25, 'green'], [5, 'red'], [1, 'white']]
function chipBreakdown(amount) {
  const out = []
  for (const [v, c] of CHIPS) {
    const n = Math.floor(amount / v)
    if (n) { out.push([c, n]); amount -= n * v }
  }
  return out // [[색, 개수], ...] 큰 칩부터
}
// 한 줄 더미: 큰 칩이 아래로, 최대 max개
function chipStack(amount, max = 5) {
  const chips = []
  for (const [c, n] of chipBreakdown(amount)) for (let i = 0; i < n && chips.length < max; i++) chips.push(c)
  return `<span class="chip-stack" style="--n:${chips.length}" aria-hidden="true">${chips.map((c, i) => `<i class="tchip ${c}" style="--i:${i}"></i>`).join('')}</span>`
}
// 판돈: 색깔별로 따로 쌓은 더미 여러 개 (최대 4더미, 더미당 최대 6개)
function chipColumns(amount) {
  return chipBreakdown(amount).slice(0, 4).map(([c, n]) =>
    `<span class="chip-stack" style="--n:${Math.min(n, 6)}" aria-hidden="true">${Array.from({ length: Math.min(n, 6) }, (_, i) => `<i class="tchip ${c}" style="--i:${i}"></i>`).join('')}</span>`).join('')
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
  $('#my-tokens').textContent = (me ? me.stack + me.bet : 0).toLocaleString() // 테이블에 맡긴 칩

  if (!state) {
    $('#status').innerHTML = connectStage === 'fail'
      ? `<div class="connect-fail"><b>서버에 연결하지 못했어요</b>
          <ul><li>인터넷 연결을 확인하고 다시 시도해 주세요.</li></ul>
          <button class="btn gold" onclick="location.reload()">다시 시도</button></div>`
      : `<span class="connecting">${esc(connectStage || '테이블에 들어가는 중…')}</span>`
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
      p.left ? '<i class="tag">나감</i>' : p.sitOut ? '<i class="tag">자리 비움</i>' : '',
      !p.inHand && p.stack <= 0 ? '<i class="tag">칩 없음</i>' : '',
    ].join('')
    const win = state.result?.winners.find(w => w.id === p.id)
    return `<div class="seat ${turn ? 'turn' : ''} ${p.folded ? 'folded' : ''} ${p.id === selfId ? 'me' : ''} ${win ? 'winner' : ''}"
              data-id="${esc(p.id)}" style="left:${x}%;top:${y}%">
      ${win ? '<b class="crown">👑</b>' : ''}
      <div class="cards">${cards}</div>
      <div class="plate">
        ${p.id === state.dealerId ? '<b class="dealer">D</b>' : ''}
        ${isHost && p.id !== selfId && !p.left ? `<button class="kick-btn" data-kick="${esc(p.id)}" title="${p.bot ? '봇 빼기' : '내보내기'}" aria-label="${esc(p.name)} ${p.bot ? '빼기' : '내보내기'}">✕</button>` : ''}
        <div class="pname">${esc(p.name)}${tags}</div>
        <div class="stack">🪙 ${p.stack.toLocaleString()}</div>
        ${turn ? '<div class="timer"><i></i></div>' : ''}
      </div>
      ${p.last ? `<div class="last">${esc(p.last)}</div>` : ''}
      ${p.bet ? `<div class="bet">${chipStack(p.bet)}<span>${p.bet.toLocaleString()}</span></div>` : ''}
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
  $('#pot').innerHTML = potTotal ? `<span class="pot-chips">${chipColumns(potTotal)}</span><span>팟 ${potTotal.toLocaleString()}</span>` : ''
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
    if (ready < 2) status += ' · 참여 가능한 플레이어가 2명 이상 필요합니다'
    else if (!seats.some(p => !p.bot && !p.left && !p.sitOut && p.stack > 0)) status += ' · 모두 자리를 비워 기다리는 중'
    else if (state.phase === 'showdown') status += ' · 곧 다음 판이 시작됩니다'
  }
  if (connectStage) status = `<span class="connecting">${esc(connectStage)}</span>`
  else if (!me && state.waitingSeats?.includes(selfId)) status += ' · <b>이번 판이 끝나면 봇 대신 앉아요</b>'
  else if (!me) status += ' · 구경 중 · <b>앉기</b>를 누르면 가진 코인을 모두 맡기고 다음 판부터 함께해요'
  else if (me.sitOut && !me.inHand) {
    status = '<span class="out">자리 비움 · 시간 안에 행동하지 않아 다음 판부터 빠졌어요. <b>다시 참여</b>를 누르면 다음 판부터 함께해요.</span>'
  }
  $('#status').innerHTML = status

  $('#start').hidden = true // 판은 서버가 자동으로 시작
  $('#refill-btn').hidden = true
  $('#sit-btn').hidden = !!me || !!connectStage || !!state.waitingSeats?.includes(selfId)
  $('#emoji-btn').hidden = $('#emoji-side').hidden = !me // 앉은 사람만 이모지를 보낼 수 있음 (PC는 확률 창 아래, 좁은 화면은 😀 버튼)
  if (!me) closeEmoji()
  $('#back-btn').hidden = !(me && me.sitOut && !me.left)

  renderActions(me)
  renderOdds(me, hasMyHole)
}

// ---------- 대기 인원 ----------
const WAIT_ICON = { ready: '✅', sitout: '💤', broke: '💸', left: '🚪', bot: '✅' } // 봇도 참가자와 같은 표시

function renderWaiting(seats) {
  const humans = seats.filter(p => !p.bot).length, bots = seats.length - humans
  $('#headcount').textContent = `👥 ${humans + bots} / ${CONFIG.MAX_SEATS}`
  $('#headcount').title = `사람 ${humans}명${bots ? ` · 봇 ${bots}` : ''}`
  $('#bot-add').hidden = !(isHost && seats.length < CONFIG.MAX_SEATS)
  const waiting = !BETTING.includes(state.phase) && state.phase === 'waiting'
  $('#waiting').hidden = !waiting
  $('#board').hidden = waiting
  $('#result').hidden = waiting
  if (!waiting) return
  const kind = p => (p.left ? 'left' : p.bot ? 'bot' : p.sitOut ? 'sitout' : p.stack <= 0 ? 'broke' : 'ready')
  const ready = seats.filter(p => kind(p) === 'ready' || kind(p) === 'bot').length
  const need = Math.max(0, 2 - ready)
  const sub = need > 0 ? `<b>${need}명</b> 더 모이면 시작할 수 있어요`
    : '곧 다음 판이 시작됩니다'
  const label = { ready: '참가', sitout: '자리 비움', broke: '칩 없음', left: '나감', bot: '봇' }
  $('#waiting').innerHTML = `
    <div class="wait-count">👥 <b>${humans}</b><span>명${bots ? ` (봇 ${bots})` : ''} / ${CONFIG.MAX_SEATS}자리</span></div>
    <div class="wait-sub">${sub}</div>
    <div class="wait-list">${seats.map(p => `<span class="wchip ${kind(p)}" title="${label[kind(p)]}">${WAIT_ICON[kind(p)]} ${esc(p.name)}</span>`).join('')}</div>
    ${seats.length < CONFIG.MAX_SEATS ? `<div class="wait-hint">위쪽 <b>초대 링크 복사</b>로 친구를 부르거나${isHost ? ' 아래 <b>봇 추가</b>로 자리를 채워 보세요' : ''}</div>` : ''}`
}

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

// ---------- 이모지 ----------
// server/room.mjs의 EMOJIS와 같게 (정해 둔 것만 오감)
const EMOJIS = ['🥱', '👍', '😂', '😭', '🔥'] // 하품·좋아요·웃음·울음·불
$('#emoji-panel').innerHTML = EMOJIS.map(e => `<button class="emoji-opt" data-e="${e}" role="menuitem" aria-label="${e} 보내기">${e}</button>`).join('')
$('#emoji-side').innerHTML = EMOJIS.map(e => `<button class="emoji-opt" data-e="${e}" aria-label="${e} 보내기" title="${e} 보내기">${e}</button>`).join('')
function closeEmoji() { $('#emoji-panel').hidden = true; $('#emoji-btn').setAttribute('aria-expanded', 'false') }
$('#emoji-btn').onclick = () => {
  const open = $('#emoji-panel').hidden
  $('#emoji-panel').hidden = !open
  $('#emoji-btn').setAttribute('aria-expanded', String(open))
}
let lastEmoji = 0
$('#emoji-panel').onclick = $('#emoji-side').onclick = e => {
  const b = e.target.closest('[data-e]')
  if (!b) return
  closeEmoji()
  if (Date.now() - lastEmoji < 1200) return toast('이모지는 잠깐 쉬었다 보내 주세요.')
  lastEmoji = Date.now()
  net?.send({ t: 'emoji', e: b.dataset.e })
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('.emoji-wrap')) closeEmoji() })
// 보낸 사람 자리 위에 잠깐 떠올랐다 사라짐 (자리 그림은 자주 다시 그려서, 효과 층(#fx)에 띄움)
function showEmoji(id, e) {
  const seat = document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`)
  if (!seat || !EMOJIS.includes(e)) return
  const fx = { '🥱': 'yawn', '👍': 'thumb', '😂': 'laugh', '😭': 'cry', '🔥': 'fire' }[e]
  document.querySelector(`.emoji-pop[data-id="${CSS.escape(id)}"]`)?.remove() // 같은 자리는 새 것으로 교체 (겹치지 않게)
  const pop = document.createElement('div')
  pop.className = 'emoji-pop'
  pop.dataset.id = id
  pop.innerHTML = `<div class="emoji-bubble"><span class="emoji-face fx-${fx}">${e}</span></div>`
  pop.style.left = seat.style.left
  pop.style.top = seat.style.top
  $('#fx').appendChild(pop)
  setTimeout(() => pop.remove(), 2700)
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
try { oddsOpen = localStorage.getItem('casino:odds') !== 'closed' } catch {}

// 깜박이지 않게: 게임이 시작되면 판 사이에도 창을 계속 띄워 두고, 줄(족보 10개)도 항상 같게.
// 새로 계산하는 동안은 이전 숫자를 흐리게 남겨 두고, 내 카드가 없으면 0%로 둔다. 폴드해도 내 카드 기준으로 계속 보여 준다
let oddsCalc = false
const myHandLive = () => !!(myHole && state && myHole.handNo === state.handNo && ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(state.phase))

function renderOdds(me, hasMyHole) {
  const box = $('#odds')
  const show = !!me && state.phase !== 'waiting'
  $('#game').classList.toggle('side', show) // 넓은 PC 화면에서 오른쪽 칸을 쓸지 (게임 전에는 테이블을 가운데로)
  if (!show) { box.hidden = true; return }
  box.hidden = false
  if (hasMyHole && myHandLive()) {
    const opponents = state.seats.filter(p => p.inHand && !p.folded && p.id !== selfId).length
    const key = [myHole.handNo, ...myHole.cards, ...state.board, opponents].join(',')
    if (key !== oddsKey) {
      oddsKey = key
      oddsCalc = true // 이전 결과는 지우지 않고 흐리게
      analyze(myHole.cards, state.board, opponents, () => oddsKey !== key)
        .then(res => { if (res && oddsKey === key) { oddsResult = res; oddsCalc = false; drawOdds() } })
    }
  } else if (oddsKey) { oddsKey = ''; oddsResult = null; oddsCalc = false } // 다음 판 카드를 받기 전: 0%
  drawOdds()
}

const pct = p => (!p ? '0%' : p >= 0.9995 ? '100%' : p < 0.001 ? '<0.1%' : (p * 100).toFixed(1) + '%')

function drawOdds() {
  const me = state.seats.find(p => p.id === selfId)
  const live = myHandLive()
  const cur = live ? currentHand(myHole.cards, state.board) : null
  const eq = oddsResult?.equity
  const head = `<button class="odds-head" id="odds-toggle" aria-expanded="${oddsOpen}">
      <span>지금 내 족보 <b>${cur ? esc(cur.detail || HAND_RANKS[cur.cat]) : '—'}</b>${live && me?.folded ? ' <small class="folded-note">폴드함</small>' : ''}</span>
      <span class="eq">예상 승률 <b>${eq != null ? pct(eq) : '0%'}</b></span>
      <span class="caret">${oddsOpen ? '▾' : '▸'}</span>
    </button>`
  let body = ''
  if (oddsOpen) {
    const rows = []
    for (let c = 9; c >= 0; c--) {
      const p = oddsResult?.dist[c] || 0
      const now = cur && c === cur.cat
      rows.push(`<div class="odds-row ${now ? 'now' : ''}">
        <span class="nm">${HAND_RANKS[c]}${now ? ' <i>현재</i>' : ''}</span>
        <span class="bar"><i style="width:${p * 100}%"></i></span>
        <span class="pc">${pct(p)}</span></div>`)
    }
    body = `<div class="odds-rows">${rows.join('')}</div>
      <p class="odds-note">${!live ? '카드를 받으면 계산해요' : state.board.length === 5 ? '최종 족보' : '리버까지 갔을 때 완성될 확률'} · 승률은 상대 패를 모른다고 가정한 추정치</p>`
  }
  $('#odds').classList.toggle('calc', oddsCalc)
  $('#odds').innerHTML = head + body
  $('#odds-toggle').onclick = () => {
    oddsOpen = !oddsOpen
    try { localStorage.setItem('casino:odds', oddsOpen ? 'open' : 'closed') } catch {}
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

// ---------- 월간 시즌 랭킹 ----------
// 랭킹은 카지노 서버가 판마다 코인 순이익을 기록한다 (예전에는 브라우저가 Firestore에 직접 씀)

// 다음 달 1일 0시(한국 시간)
function seasonEnd(key) {
  const d = new Date(key + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + 1)
  return Date.parse(d.toISOString().slice(0, 10) + 'T00:00:00+09:00')
}
function seasonRange(key) {
  const s = new Date(key + 'T00:00:00Z'), e = new Date(seasonEnd(key) + 9 * 3600e3 - 86400e3)
  const f = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  return `${f(s)} ~ ${f(e)}`
}
const seasonMonth = key => `${+key.slice(5, 7)}월`
function seasonLeft() {
  const ms = seasonEnd(cloud.seasonKey()) - Date.now()
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3)
  return d ? `${d}일 ${h}시간` : `${h}시간`
}
const signed = n => (n > 0 ? '+' : '') + n.toLocaleString()
const MEDAL = ['🥇', '🥈', '🥉']

function seasonList(rows) {
  return `<ol class="season-list">${rows.map((r, i) => `
    <li class="${r.me ? 'me' : ''}">
      <span class="rk">${MEDAL[i] || i + 1}</span>
      <span class="nm">${esc(r.name || '이름 없음')}${r.me ? ' <i>나</i>' : ''}</span>
      <span class="net ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}">${signed(r.net || 0)}</span>
      <span class="hd">${(r.hands || 0).toLocaleString()}판</span>
    </li>`).join('')}</ol>`
}

async function loadSeasonInto(el, n, withPrev) {
  if (!account) { el.hidden = true; return }
  el.hidden = false
  el.innerHTML = '<p class="season-note">랭킹 불러오는 중…</p>'
  try {
    const cur = await cloud.loadSeason(cloud.seasonKey(), n)
    let html = `<div class="season-head"><b>🏆 ${seasonMonth(cur.season)} 랭킹</b><span>${seasonRange(cur.season)} · 끝까지 ${seasonLeft()}</span></div>`
    html += cur.rows.length ? seasonList(cur.rows)
      : '<p class="season-note">아직 이번 달 기록이 없어요. 첫 판을 쳐서 1위를 차지해 보세요!</p>'
    if (cur.me && !cur.rows.some(r => r.me)) {
      html += `<p class="season-me">내 순위 <b>${cur.me.rank}위</b> / ${cur.total}명 · ${signed(cur.me.net)}</p>`
    }
    if (withPrev) {
      const prev = await cloud.loadSeason(cloud.prevSeasonKey(), 3)
      if (prev.rows.length) {
        html += `<div class="season-prev"><b>지난달(${seasonMonth(prev.season)}) TOP 3</b><br>${prev.rows.map((r, i) =>
          `${MEDAL[i]} ${esc(r.name || '이름 없음')} ${signed(r.net)}`).join(' · ')}</div>`
      }
      html += '<p class="season-note">이번 달 카지노에서 딴 코인에서 잃은 코인을 뺀 순수익으로 순위를 매겨요. 출석·가입 코인은 들어가지 않아요. 매달 1일 0시(한국 시간)에 새 시즌이 시작돼요.</p>'
    }
    el.innerHTML = html
  } catch (err) {
    console.warn('season', err)
    el.innerHTML = '<p class="season-note">랭킹을 불러오지 못했어요.</p>'
  }
}

function openSeason() {
  $('#season').hidden = false
  loadSeasonInto($('#season-body'), 10, true)
}
$('#season-btn').hidden = false
$('#season-btn').onclick = openSeason
$('#season-close').onclick = () => { $('#season').hidden = true }
$('#season').onclick = e => { if (e.target.id === 'season') $('#season').hidden = true }
addEventListener('keydown', e => { if (e.key === 'Escape') $('#season').hidden = true })
$('#ranks-close').onclick = () => { $('#ranks').hidden = true }
$('#ranks').onclick = e => { if (e.target.id === 'ranks') $('#ranks').hidden = true }
addEventListener('keydown', e => { if (e.key === 'Escape') $('#ranks').hidden = true })

let actionKey = ''
let raisePref = '최소' // 레이즈 버튼을 그냥 눌렀을 때 쓸 옵션 (마지막으로 고른 것)
try { raisePref = localStorage.getItem('casino:raise') || '최소' } catch {}
let customSeq = -1 // '직접 입력'을 연 차례 번호

// ---------- 줄이 바뀐 직후 잠깐 입력 막기 ----------
// 미리 선택 줄 ↔ 내 차례 줄이 바뀌는 순간 누른 손가락이 새 버튼을 누르지 않게 LOCK_MS 동안 클릭을 무시
const LOCK_MS = 500
let barMode = '', lockUntil = 0, lockTimer = 0
function setBarMode(mode) {
  if (mode === barMode) return
  const bar = $('#actions')
  if (barMode && mode) { // 줄이 보이는 상태에서 다른 줄로 바뀔 때만 (새로 나타날 때는 누르던 중이 아님)
    lockUntil = Date.now() + LOCK_MS
    bar.classList.add('locked')
    clearTimeout(lockTimer)
    lockTimer = setTimeout(() => bar.classList.remove('locked'), LOCK_MS)
  }
  barMode = mode
}
for (const type of ['pointerdown', 'pointerup', 'click']) {
  $('#actions').addEventListener(type, e => {
    if (Date.now() < lockUntil) { e.stopPropagation(); e.preventDefault() }
  }, true)
}

// ---------- 미리 선택 (내 차례가 아닐 때 다음 행동을 골라 두기) ----------
// kind: 'checkfold'(체크, 누가 걸면 폴드) / 'check'(체크만, 누가 걸면 취소) / 'call'(그 금액 콜, 금액이 바뀌면 취소) / 'callany'(얼마든 콜)
let pre = null // { hand, kind, amt }
let autoSeq = -1

function preDecision(toCall) {
  if (!pre || pre.hand !== state.handNo) return null
  switch (pre.kind) {
    case 'checkfold': return toCall <= 0 ? 'check' : 'fold'
    case 'check': return toCall <= 0 ? 'check' : null
    case 'call': return toCall === pre.amt ? 'call' : null
    case 'callany': return toCall <= 0 ? 'check' : 'call'
  }
  return null
}

function renderPre(me, bar) {
  const toCall = Math.min(state.currentBet - me.bet, me.stack)
  if (pre && pre.hand !== state.handNo) pre = null
  // 상황이 바뀌어 더는 맞지 않는 선택은 풀어 줌
  if (pre?.kind === 'check' && toCall > 0) pre = null
  if (pre?.kind === 'call' && toCall !== pre.amt) pre = null
  bar.classList.add('pre')
  setBarMode('pre')
  const key = ['pre', state.handNo, toCall, pre?.kind || ''].join(',')
  if (key === actionKey) return
  actionKey = key
  // 버튼 자리를 내 차례 줄과 맞춤: [폴드 자리] [체크·콜 자리] [레이즈·올인 자리 = 비워 둠]
  // 차례가 바뀌는 순간 누르더라도 같은 자리에는 비슷한 행동만 오게 (레이즈·올인이 잘못 눌리지 않게)
  const btn = (k, label) => `<button class="btn pre-btn ${pre?.kind === k ? 'on' : ''}" data-pre="${k}" aria-pressed="${pre?.kind === k}">${label}</button>`
  bar.hidden = false
  bar.innerHTML = `
    <div class="bar-head">미리 선택 <span>내 차례가 되면 바로 실행돼요</span></div>
    <div class="row slots">
      ${btn('checkfold', toCall <= 0 ? '체크/폴드' : '폴드')}
      <div class="slot-split">
        ${toCall <= 0 ? btn('check', '체크') : btn('call', `콜 ${toCall.toLocaleString()}`)}
        ${btn('callany', '아무거나 콜')}
      </div>
      <div class="slot-blank" aria-hidden="true">레이즈 · 올인은 내 차례에</div>
    </div>`
  bar.querySelectorAll('[data-pre]').forEach(b => b.onclick = () => {
    const k = b.dataset.pre
    pre = pre?.kind === k ? null : { hand: state.handNo, kind: k, amt: toCall }
    actionKey = ''
    renderActions(me)
  })
}

function renderActions(me) {
  const bar = $('#actions')
  const myTurn = me && state.toActId === selfId
  bar.classList.remove('pre')
  if (!myTurn) {
    // 판에 남아 있고 아직 행동할 수 있으면 미리 선택 버튼을 보여 줌
    if (me && me.inHand && !me.folded && !me.allIn && me.stack > 0 && BETTING.includes(state.phase)) { renderPre(me, bar); return }
    pre = null
    setBarMode('')
    bar.innerHTML = ''; bar.hidden = true; actionKey = ''; return
  }
  // 내 차례: 미리 고른 행동이 지금 상황에 맞으면 바로 실행
  const auto = preDecision(Math.min(state.currentBet - me.bet, me.stack))
  pre = null
  if (auto && autoSeq !== state.turnSeq) {
    const seq = autoSeq = state.turnSeq
    setBarMode('')
    bar.innerHTML = ''; bar.hidden = true; actionKey = 'auto,' + seq
    setTimeout(() => { if (state.toActId === selfId && state.turnSeq === seq) sendMove(auto) }, 250)
    return
  }
  if (actionKey === 'auto,' + state.turnSeq) return
  setBarMode('turn')
  // 같은 차례 안에서는 다시 그리지 않음 (입력 중인 금액과 포커스 유지)
  const key = [state.turnSeq, me.stack, me.bet, state.currentBet, state.minRaise, state.pot].join(',')
  if (key === actionKey) return
  actionKey = key
  bar.hidden = false

  const bb = state.bb
  const toCall = state.currentBet - me.bet
  const maxTo = me.bet + me.stack
  const minTo = Math.min(maxTo, state.currentBet + state.minRaise)
  const locked = !!me.raiseLocked // 앞 올인이 최소 레이즈보다 적어서 콜·폴드만 가능
  const canRaise = maxTo > minTo && !locked
  const verb = state.currentBet ? '레이즈' : '벳'
  const potTotal = state.pot + state.seats.reduce((a, p) => a + p.bet, 0)
  const clamp = v => Math.min(maxTo, Math.max(minTo, Math.round(v)))
  raiseTo = clamp(raiseTo || minTo)

  // 빠른 금액: [이름, 올릴 총액, 설명]. 금액이 같은 버튼은 하나만 남김
  const potTo = f => state.currentBet + (potTotal + toCall) * f
  const snap = v => clamp(Math.round(v / (bb / 2)) * (bb / 2))
  const presets = [], byName = {}
  for (const [name, v, tip] of [
    ['최소', minTo, '올릴 수 있는 가장 적은 금액'],
    ['따당', state.currentBet * 2, '앞 사람이 건 금액의 두 배'],
    ['쿼터', potTo(0.25), '판돈의 1/4만큼 더'],
    ['하프', potTo(0.5), '판돈의 절반만큼 더'],
    ['풀', potTo(1), '판돈만큼 더'],
  ]) {
    if (v <= 0 || v > maxTo) continue // 가진 토큰보다 크면 안 보여줌 (올인 버튼으로)
    const to = snap(v)
    byName[name] = to
    if (!presets.some(p => p.to === to)) presets.push({ name, to, tip })
  }
  // 레이즈 버튼을 그냥 누르면: 지난번에 고른 옵션(없으면 최소)
  const def = byName[raisePref] ? { name: raisePref, to: byName[raisePref] } : { name: '최소', to: minTo }
  const custom = customSeq === state.turnSeq // 이번 차례에 '직접 입력'을 열었는지
  if (!custom) raiseTo = def.to

  bar.innerHTML = `
    <div class="bar-head turn-head">내 차례예요</div>
    <div class="row slots">
      <button class="btn fold" data-a="fold">폴드</button>
      ${toCall <= 0
        ? '<button class="btn check" data-a="check">체크</button>'
        : `<button class="btn call" data-a="call">콜 ${Math.min(toCall, me.stack).toLocaleString()}</button>`}
      ${canRaise ? `
      <div class="raise-wrap">
        <div class="raise-menu" role="menu" hidden>
          ${presets.map(p => `<button class="rm-opt ${!custom && p.name === def.name ? 'def' : ''}" data-p="${p.to}" data-name="${p.name}" title="${p.tip}" role="menuitem"><b>${p.name}</b><small>${p.to.toLocaleString()}</small></button>`).join('')}
          <button class="rm-opt rm-custom" data-custom role="menuitem"><b>직접</b><small>입력</small></button>
        </div>
        <button class="btn raise" data-a="raise" aria-haspopup="menu"><span class="rv"><em class="rn" id="raise-name"></em> <span id="raise-verb">${verb}</span> <b id="raise-val"></b></span><small class="rhint"><span class="h-mouse">▴ 마우스를 올리면 다른 금액</span><span class="h-touch">▴ 길게 누르면 다른 금액</span></small></button>
      </div>` : `<div class="slot-blank" aria-hidden="true">${locked ? '콜·폴드만 가능' : '레이즈 불가'}</div>`}
      ${locked && maxTo > state.currentBet
        ? '<div class="slot-blank" title="앞 사람의 올인이 최소 레이즈보다 적어서 다시 올릴 수 없어요">올인 불가</div>'
        : `<button class="btn allin" data-a="allin">올인 ${maxTo.toLocaleString()}</button>`}
    </div>
    ${canRaise && custom ? `
    <div class="bet-box">
      <div class="amount-row">
        <button class="step" data-step="-1" aria-label="${bb}만큼 줄이기">−</button>
        <input id="raise-input" class="amt-input" type="number" inputmode="numeric" min="${minTo}" max="${maxTo}" step="${bb}" aria-label="${verb} 금액">
        <button class="step" data-step="1" aria-label="${bb}만큼 늘리기">+</button>
        <span class="extra" id="raise-extra"></span>
      </div>
      <input type="range" id="raise" min="${minTo}" max="${maxTo}" step="1" aria-label="${verb} 금액 슬라이더">
      <div class="range-labels"><span>최소 ${minTo.toLocaleString()}</span><span>최대 ${maxTo.toLocaleString()}</span></div>
    </div>` : ''}`

  let sent = false // 한 차례에 두 번 보내지 않게
  function act(type, amount) {
    if (sent) return
    sent = true
    sendMove(type, amount)
    raiseTo = 0
  }
  bar.querySelectorAll('[data-a]:not([data-a=raise])').forEach(b => b.onclick = () => act(b.dataset.a))
  if (!canRaise) return

  const slider = $('#raise'), input = $('#raise-input')
  const rbtn = bar.querySelector('[data-a=raise]'), menu = bar.querySelector('.raise-menu'), wrap = bar.querySelector('.raise-wrap')
  function setRaise(v, fromInput) {
    raiseTo = clamp(v)
    if (slider) slider.value = raiseTo
    if (input && !fromInput) input.value = raiseTo
    $('#raise-verb').textContent = raiseTo >= maxTo ? '올인' : verb
    $('#raise-val').textContent = raiseTo.toLocaleString()
    // 지금 누르면 어떤 옵션으로 나가는지 버튼 앞에 꼬리표로 (지난번에 고른 옵션)
    $('#raise-name').textContent = custom ? '직접' : raiseTo >= maxTo ? '' : def.name
    $('#raise-name').hidden = !$('#raise-name').textContent
    if (custom) $('#raise-extra').innerHTML = `추가로 <b>${(raiseTo - me.bet).toLocaleString()}</b> 냄`
  }
  setRaise(raiseTo)
  if (custom) {
    slider.oninput = () => setRaise(+slider.value)
    // 직접 입력: 입력 중에는 범위를 강제하지 않고, 칸을 벗어나거나 Enter를 누를 때 맞춤
    input.oninput = () => { if (input.value !== '') setRaise(+input.value, true) }
    input.onchange = () => setRaise(+input.value || minTo)
    input.onkeydown = e => { if (e.key === 'Enter') { setRaise(+input.value || minTo); act('raise', raiseTo) } }
    bar.querySelectorAll('[data-step]').forEach(b => b.onclick = () => setRaise(raiseTo + bb * +b.dataset.step))
  }

  // ---- 레이즈 옵션 메뉴: PC는 마우스를 올리면, 모바일은 길게 누르면 열림 ----
  const hot = el => menu.querySelectorAll('.rm-opt').forEach(b => b.classList.toggle('hot', b === el))
  const openMenu = () => { menu.hidden = false; rbtn.classList.add('open') }
  const closeMenu = () => { menu.hidden = true; rbtn.classList.remove('open'); hot(null) }
  const optAt = (x, y) => document.elementFromPoint(x, y)?.closest('.raise-menu .rm-opt')
  function pick(opt) {
    if (opt.hasAttribute('data-custom')) { customSeq = state.turnSeq; raiseTo = def.to; actionKey = ''; renderActions(me); return }
    raisePref = opt.dataset.name
    try { localStorage.setItem('casino:raise', raisePref) } catch {}
    act('raise', +opt.dataset.p)
  }
  menu.querySelectorAll('.rm-opt').forEach(b => b.onclick = () => pick(b))

  // 짧게 누르기(클릭): 지난번 옵션(또는 직접 입력한 금액)으로 바로 레이즈
  let holdTimer = 0, held = false, skipClick = false
  rbtn.onclick = () => {
    if (skipClick) { skipClick = false; return }
    act('raise', custom ? raiseTo : def.to)
  }
  // 길게 누르기: 옵션이 뜨고, 손가락을 끌어 원하는 옵션 위에서 떼면 선택. 버튼 위에서 떼면 메뉴가 열린 채로 남아 눌러서 고를 수 있음
  rbtn.oncontextmenu = e => e.preventDefault()
  rbtn.onpointerdown = e => {
    if (e.pointerType === 'mouse') return
    held = false
    clearTimeout(holdTimer)
    holdTimer = setTimeout(() => { held = true; openMenu(); navigator.vibrate?.(12) }, 280)
  }
  rbtn.onpointermove = e => { if (held) hot(optAt(e.clientX, e.clientY)) }
  rbtn.onpointerup = e => {
    if (e.pointerType === 'mouse') return
    clearTimeout(holdTimer)
    if (!held) return
    held = false
    skipClick = true
    setTimeout(() => { skipClick = false }, 400)
    const opt = optAt(e.clientX, e.clientY)
    hot(null)
    if (opt) pick(opt)
  }
  rbtn.onpointercancel = () => { clearTimeout(holdTimer); held = false; hot(null) }
  // PC: 마우스를 올리면 열리고, 벗어나면 닫힘
  let leaveTimer = 0
  wrap.onpointerenter = e => { if (e.pointerType === 'mouse') { clearTimeout(leaveTimer); openMenu() } }
  wrap.onpointerleave = e => { if (e.pointerType === 'mouse') leaveTimer = setTimeout(closeMenu, 250) }
  // 키보드: ↑로 메뉴 열기, Esc로 닫기
  rbtn.onkeydown = e => { if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(); menu.querySelector('.rm-opt')?.focus() } }
  menu.onkeydown = e => { if (e.key === 'Escape') { closeMenu(); rbtn.focus() } }
}

// 레이즈 메뉴 밖을 누르면 닫기
document.addEventListener('pointerdown', e => {
  const m = document.querySelector('.raise-menu:not([hidden])')
  if (m && !e.target.closest('.raise-wrap')) { m.hidden = true; document.querySelector('.btn.raise')?.classList.remove('open') }
})

// 차례 타이머 막대
setInterval(() => {
  const bar = document.querySelector('.timer i')
  if (bar && turnDeadline) bar.style.width = Math.max(0, (turnDeadline - Date.now()) / CONFIG.TURN_MS * 100) + '%'
}, 200)

$('#back-btn').onclick = () => { $('#back-btn').hidden = true; sendMove('back') } // 자리 비움에서 돌아오기
$('#copy').onclick = async () => {
  const url = location.href.split('#')[0] + '#' + roomCode
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!') }
  catch { prompt('이 링크를 친구에게 보내세요', url) }
}
// 나가기: 남은 칩은 코인으로 돌려받음. 판 도중이면 이번 판에 건 칩은 잃음 (올인했으면 판이 끝난 뒤 정산)
function leaveTable(dest = '') {
  const meSeat = state?.seats.find(p => p.id === selfId)
  if (meSeat?.inHand && !meSeat.folded && BETTING.includes(state.phase)
    && !confirm('게임 중에 나가면 이번 판에 건 칩은 잃어요. 남은 칩은 코인으로 돌려받아요. 나갈까요?')) return
  exitTo = dest
  if (!net?.ready) return backToLobby()
  net.send({ t: 'leave' }) // 자리에서 일어나 남은 칩을 코인으로 정산한 뒤 'left'가 오면 이동
  setTimeout(backToLobby, 3000) // 서버 답이 늦어도 이동
}
$('#leave').onclick = () => leaveTable()
// 게임 화면에서 JMTT 홈으로: 먼저 자리에서 일어나 정산하고 이동 (배지는 게임 중에 숨겨서 대신 위쪽 버튼으로)
$('#to-jmtt').onclick = e => { e.preventDefault(); leaveTable('/') }

// stay: 확인을 누르면 창만 닫고 지금 화면에 남음 (예: 코인이 없어 구경할 때)
let overlayStay = false
function showOverlay(title, msg, stay = false) {
  overlayStay = stay
  $('#overlay').hidden = false
  $('#overlay-title').textContent = title
  $('#overlay-msg').textContent = msg
  $('#overlay-btn').textContent = stay ? '확인' : '로비로'
}
$('#overlay-btn').onclick = () => {
  $('#overlay').hidden = true
  if (overlayStay) return
  net?.send({ t: 'leave' })
  backToLobby()
}

// 파산 안내 (v1.9.1, 로비 세션): 받을 수 있는지는 카지노 서버가 정한다 (/casino/api/refill — 코인 500 이하, 칩 없음, 하루 10번)
// 받을 수 있으면 "캐셔로 가기" → 자리에서 일어나 로비로 가서 캐셔를 연다 (/casino/?cashier). 코인이 넉넉하면 아무것도 안 띄움
async function offerRefill(title) {
  let s = null
  try { const r = await fetch('../api/refill', { cache: 'no-store' }); if (r.ok) s = await r.json() } catch {}
  if (!s || s.why === 'has_coins') return false
  $('#bk-title').textContent = title
  const n = v => Number(v).toLocaleString()
  $('#bk-msg').innerHTML = s.can ? `카지노 로비의 캐셔에서 <b>파산 지원금 ${n(s.amount)}코인</b>을 받을 수 있어요. (오늘 ${s.left}번 남음)`
    : s.why === 'daily_limit' ? `오늘 받을 수 있는 파산 지원금(하루 ${s.perDay}번)을 다 받았어요. 내일 다시 받을 수 있어요.`
    : `<b>${s.seat?.title || '다른 게임'}</b>에 칩이 남아 있어요. 그 칩을 코인으로 바꾸면 캐셔에서 파산 지원금을 받을 수 있어요.`
  $('#bk-go').hidden = s.why === 'daily_limit'
  $('#bankrupt').hidden = false
  return true
}
$('#bk-later').onclick = () => { $('#bankrupt').hidden = true }
$('#bk-go').onclick = () => { $('#bankrupt').hidden = true; leaveTable('../?cashier') }

let toastTimer
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
}
