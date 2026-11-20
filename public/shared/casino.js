// 하우스 게임 화면 공통 부품 (CASINO.md 3·6장). 블랙잭·바카라·룰렛·슬롯이 같이 쓴다
//
//   <link rel="stylesheet" href="../shared/casino.css">
//   <script type="module">
//     import { startGame } from '../shared/casino.js'
//     const game = await startGame({
//       onReady(me) {},                    // 접속 완료 (me = { id, name, picture })
//       onChips({ chips, inPlay, coins }) {},// 칩·코인이 바뀔 때마다
//       onMessage(msg) {},                 // 게임이 보낸 메시지 (공통 메시지 me·chips·toast·restart는 여기서 처리)
//       onToast(msg) {},                   // 서버의 알림·거절 { t: 'toast'|'error', msg, ... } — false를 돌려주면 기본 알림을 띄우지 않음
//       bustDelay: 1200,                   // 칩을 모두 잃은 뒤 파산 안내(→ 로비 캐셔)를 띄우기까지 ms (결과 연출 길이에 맞추기)
//       onGift({ chips, title }) {},       // 첫 방문 기념 칩을 받았을 때 (팝업은 이 파일이 띄움. 게임 연출을 더하고 싶을 때만)
//       onLoggedOut() {},                  // 로그인 안 한 사람 (화면은 보여 주고, 칩 바꾸기 때 로그인 안내)
//       leaveMessage(state) {},            // '← 로비'·탭 닫기 때 물을 말 (null이면 묻지 않음). 없으면 판 진행 중(inPlay > 0)일 때 기본 문구
//     })
//     game.send({ t: 'spin', bet: 10 })    // 서버(server/games/<id>)로
//   </script>
//
// 윗줄(← 로비 · 게임 이름 · 코인 · 칩 · 칩 바꾸기 · 코인으로), 칩 바꾸기 창, 알림, 다시 연결을 이 파일이 맡는다.
// 칩 숫자는 서버가 보낸 값만 보여 준다 (브라우저에서 계산하지 않음)

import { earnHtml } from './earn.js'
const fmt = n => Number(n || 0).toLocaleString('ko-KR')
// 윗줄처럼 좁은 칸: 1억 이상은 줄여 쓴다 (12.3억 · 9,007.1조). 정확한 숫자는 title로 (#규모: 최대 9,007,199,254,740,991)
const fmtShort = n => { n = Number(n || 0); return n < 1e8 ? fmt(n) : n < 1e12 ? fmt(Math.floor(n / 1e7) / 10) + '억' : fmt(Math.floor(n / 1e11) / 10) + '조' }
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.innerHTML = html; return e }
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
}

export async function startGame(opts = {}) {
  const gameId = location.pathname.split('/').filter(Boolean).at(-1) || 'game'
  const state = { me: null, coins: null, chips: 0, inPlay: 0, game: { id: gameId, title: opts.title || document.title, buyIn: { min: 1 } }, ready: false }
  const KEY = `casino:${gameId}:buyin` // localStorage 키는 casino:<게임>: 로 시작 (DEV_REFERENCE 1-3)

  // ---------- 윗줄 ----------
  const top = el('header', { class: 'casino-top' }, `
    <a class="casino-back" href="../" data-back>← 로비</a>
    <span class="casino-title" data-title></span>
    <button class="casino-jgift" type="button" data-jgift hidden aria-label="받을 선물" title="받을 선물">🎁<b data-jgift-n></b></button>
    <span class="casino-pill" title="JMTT 코인" data-coins-pill hidden><i class="casino-coin"></i><small>코인</small> <b data-coins>0</b></span>
    <span class="casino-pill" title="이 게임의 칩" data-chips-pill hidden><i class="casino-chip"></i><small>칩</small> <b data-chips>0</b></span>
    <button class="casino-btn" type="button" data-buyin hidden>칩 바꾸기</button>
    <button class="casino-btn ghost" type="button" data-cashout hidden>코인으로</button>
    <a class="jmtt-google" data-login hidden href="/auth/login?next=${encodeURIComponent(location.pathname)}"><img src="/google-g.svg" alt="" width="18" height="18">Google로 로그인</a>`)
  document.body.prepend(top)
  const q = s => top.querySelector(s)
  q('[data-title]').textContent = state.game.title

  const toastEl = el('div', { class: 'casino-toast', role: 'status' })
  document.body.append(toastEl)
  let toastT
  const toast = msg => { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600) }

  // ---------- 칩 바꾸기 창 ----------
  const dlg = el('dialog', { class: 'casino-dialog' }, `
    <form method="dialog">
      <h2>코인을 칩으로</h2>
      <p>가진 코인 <b data-dlg-coins>0</b> · 칩은 이 게임에서만 써요. 나가면 남은 칩은 코인으로 돌아가요.</p>
      <input type="number" inputmode="numeric" min="1" step="1" data-amount aria-label="바꿀 코인">
      <div class="casino-presets"><button type="button" data-p="100">100</button><button type="button" data-p="1000">1,000</button><button type="button" data-p="10000">10,000</button><button type="button" data-p="all">전부</button></div>
      <div class="row"><button class="casino-btn ghost" type="button" data-cancel>닫기</button><button class="casino-btn" type="submit" data-ok>바꾸기</button></div>
      <p class="note">코인은 게임용이며 현금이나 상품으로 바꿀 수 없어요.</p>
    </form>`)
  document.body.append(dlg)
  const amountIn = dlg.querySelector('[data-amount]')
  dlg.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { amountIn.value = b.dataset.p === 'all' ? (state.coins || 0) : b.dataset.p })
  // '바꾸기'(Enter 포함)는 폼 제출로 받는다. dialog의 close 이벤트는 브라우저에 따라 늦게 오거나 오지 않아 쓰지 않음
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault()
    const amount = Number(amountIn.value)
    if (!Number.isSafeInteger(amount) || amount < (state.game.buyIn?.min || 1)) return toast('바꿀 코인을 1 이상 정수로 적어 주세요.')
    if (state.coins !== null && amount > state.coins) return toast('코인이 모자라요.')
    dlg.close()
    store.set(KEY, String(amount))
    api.send({ t: 'buyin', amount })
  })
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close()
  function openBuyIn() {
    if (!state.me) { location.href = q('[data-login]').href; return }
    dlg.querySelector('[data-dlg-coins]').textContent = fmt(state.coins)
    const last = Number(store.get(KEY)) || 1000
    amountIn.value = state.coins !== null ? Math.max(1, Math.min(last, state.coins)) : last
    dlg.showModal()
  }

  // ---------- 파산 안내: 칩을 모두 잃었고 코인도 얼마 없으면 로비 캐셔의 파산 지원금으로 ----------
  // 받을 수 있는지는 서버가 정한다 (/casino/api/refill: 코인 500 이하, 칩 없음, 하루 10번)
  const bk = el('dialog', { class: 'casino-dialog' }, `
    <h2 data-bk-title>칩을 모두 잃었어요</h2>
    <p data-bk-msg></p>
    <p class="casino-earn">${earnHtml()}</p>
    <div class="row"><button class="casino-btn ghost" type="button" data-bk-close>닫기</button><button class="casino-btn" type="button" data-bk-go>캐셔로 가기</button></div>`)
  document.body.append(bk)
  bk.querySelector('[data-bk-close]').onclick = () => bk.close()
  bk.querySelector('[data-bk-go]').onclick = () => {
    bk.close()
    if (ws?.readyState === 1) api.send({ t: 'leave' }) // 칩이 0이라 정산할 것은 없지만 자리를 정리
    setTimeout(() => { location.href = '../?cashier' }, 200)
  }
  async function offerRefill() {
    let s = null
    try { const r = await fetch('../api/refill', { cache: 'no-store' }); if (r.ok) s = await r.json() } catch {}
    if (!s || s.why === 'has_coins' || dlg.open) return false
    bk.querySelector('[data-bk-msg]').innerHTML = s.can ? `로비 캐셔에서 <b>파산 지원금 ${fmt(s.amount)}코인</b>을 받을 수 있어요. (오늘 ${s.left}번 남음)`
      : s.why === 'daily_limit' ? `오늘 받을 수 있는 파산 지원금(하루 ${s.perDay}번)을 다 받았어요. 내일 다시 받을 수 있어요.`
      : `<b>${s.seat?.title || '다른 게임'}</b>에 칩이 남아 있어요. 그 칩을 코인으로 바꾸면 캐셔에서 받을 수 있어요.`
    bk.querySelector('[data-bk-go]').hidden = s.why === 'daily_limit'
    bk.showModal()
    return true
  }

  // ---------- 첫 방문 기념 칩 팝업 (서버가 { t: 'gift', chips, title }을 보낼 때, registry의 welcome) ----------
  // 빛 + 칩이 사방으로 튀는 효과 + 숫자가 올라감. 칩은 서버가 이미 넣었고(chips 메시지), 이 창은 알려 주기만 한다
  function showGift(d) {
    if (dlg.open) dlg.close()
    // 게임의 처음 안내 같은 다른 창이 열려 있으면 닫힌 뒤에 띄운다 (창 밑에 깔려 효과가 안 보이는 것을 막기)
    if (document.querySelector('dialog[open]')) return setTimeout(() => showGift(d), 300)
    const n = Number(d.chips) || 0
    const layer = el('div', { class: 'casino-gift', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${d.title || '기념'} 칩 ${fmt(n)}개` }, `
      <div class="casino-gift-rays" aria-hidden="true"></div>
      <div class="casino-gift-burst" aria-hidden="true">${Array.from({ length: 16 }, (_, i) =>
        `<i style="--a:${i * 22.5}deg;--d:${(i % 4) * 0.06}s;--c:${['#c81e2c', '#e8c26a', '#2a63c4', '#1f9b52'][i % 4]}"></i>`).join('')}</div>
      <div class="casino-gift-box">
        <div class="casino-gift-icon">🎁</div>
        <small>${d.title || '기념 선물'}</small>
        <h2>칩 <b data-count>0</b>개</h2>
        <p>${state.game.title}에 처음 오신 걸 환영해요! 바로 쓸 수 있어요.<br>남은 칩은 나갈 때 코인으로 바뀌어요.</p>
        <button class="casino-btn" type="button" data-gift-ok>시작하기</button>
      </div>`)
    document.body.append(layer)
    const count = layer.querySelector('[data-count]')
    const t0 = performance.now(), dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1100
    const tick = now => { const k = dur ? Math.min(1, (now - t0) / dur) : 1; count.textContent = fmt(Math.round(n * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const close = () => { layer.classList.add('out'); setTimeout(() => layer.remove(), 250) }
    layer.querySelector('[data-gift-ok]').onclick = close
    layer.addEventListener('click', e => { if (e.target === layer) close() })
    layer.querySelector('[data-gift-ok]').focus()
    opts.onGift?.(d)
  }

  // ---------- JMTT 접속 신호·선물 (#접속 #선물알림) ----------
  // 배지가 없는 하우스 게임 화면에서 메인의 /jmtt-presence.js·/jmtt-gift.js를 불러온다.
  // 게임 중에는 팝업을 저절로 띄우지 않는다: 숨긴 배지 자리를 두면 jmtt-gift.js가 '게임 중'으로 보고 기다린다.
  // 대신 윗줄에 작은 🎁(받을 선물 수)를 두고, 누르면 JMTT.gift.open()
  if (!document.querySelector('script[src*="jmtt-badge"]')) {
    if (!document.querySelector('jmtt-badge')) { const hold = document.createElement('jmtt-badge'); hold.hidden = true; document.body.append(hold) }
    for (const src of ['/jmtt-presence.js', '/jmtt-gift.js']) if (!document.querySelector(`script[src="${src}"]`)) document.head.append(el('script', { src, defer: '' }))
  }
  const jgift = q('[data-jgift]')
  const paintGift = n => { jgift.hidden = !(n > 0); q('[data-jgift-n]').textContent = n > 1 ? n : '' }
  addEventListener('jmtt:gift', e => paintGift(e.detail?.count || 0))
  addEventListener('jmtt:coins', e => { if (e.detail?.balance != null) { state.coins = e.detail.balance; paint() } }) // 선물 코인을 받으면
  jgift.onclick = () => window.JMTT?.gift?.open()
  if (window.JMTT?.gift?.count) paintGift(window.JMTT.gift.count)

  function paint() {
    q('[data-coins]').textContent = fmtShort(state.coins)
    q('[data-coins-pill]').title = `JMTT 코인 ${fmt(state.coins)}`
    q('[data-chips]').textContent = fmtShort(state.chips)
    q('[data-chips-pill]').title = `이 게임의 칩 ${fmt(state.chips)}`
    q('[data-coins-pill]').hidden = !state.me
    q('[data-chips-pill]').hidden = !state.me
    q('[data-buyin]').hidden = !state.me
    q('[data-cashout]').hidden = !state.me || !state.chips
    q('[data-cashout]').disabled = state.inPlay > 0
    q('[data-login]').hidden = !!state.me
  }
  q('[data-buyin]').onclick = openBuyIn

  // 판 도중 나가기는 한 번 묻는다 (#길찾기). 판이 없으면 바로. 게임이 opts.leaveMessage로 문구·때를 정할 수 있다 (null = 묻지 않음)
  let leaving = false
  const leaveMsg = () => opts.leaveMessage ? opts.leaveMessage(state) : state.inPlay > 0 ? '이번 판이 아직 끝나지 않았어요. 지금 나가면 남은 판은 자동으로 마무리돼요. 나갈까요?' : null
  const askLeave = () => { if (leaving) return true; const m = leaveMsg(); return !m || (leaving = confirm(m)) }
  q('[data-back]').addEventListener('click', e => { if (!askLeave()) { e.preventDefault(); e.stopImmediatePropagation() } })
  addEventListener('beforeunload', e => { if (!leaving && leaveMsg()) { e.preventDefault(); e.returnValue = '' } })
  q('[data-cashout]').onclick = () => api.send({ t: 'cashout' })
  // 로비로: 판이 진행 중이면 확인 (나가면 건 칩을 잃는다), 아니면 칩을 코인으로 돌려받고 이동
  q('[data-back]').onclick = e => {
    if (!state.me || !ws || ws.readyState !== 1) return
    e.preventDefault() // 판 중 확인은 위의 click 리스너(askLeave)가 이미 했다
    api.send({ t: 'leave' })
    setTimeout(() => { location.href = '../' }, 200)
  }

  // ---------- 서버 연결 ----------
  let ws = null, wait = 1000, everOpened = false
  const api = {
    askLeave: () => askLeave(), // 게임이 윗줄에 덧붙인 링크(JMTT 등)도 같은 확인을 쓰게: false면 머무름. true면 떠나도 됨 (페이지 떠나기 확인은 다시 안 뜸)
    get me() { return state.me }, get coins() { return state.coins }, get chips() { return state.chips }, get inPlay() { return state.inPlay },
    get game() { return state.game },
    send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); else toast('서버에 다시 연결하는 중이에요.') },
    toast, openBuyIn,
  }

  // 로그인 확인 (안 했으면 연결하지 않고 화면만)
  try {
    const r = await fetch('/auth/me?optional=1', { credentials: 'same-origin', cache: 'no-store' })
    state.me = r.ok ? await r.json() : null
    if (state.me) state.coins = state.me.coins ?? null
  } catch { state.me = null }
  paint()
  if (!state.me) { opts.onLoggedOut?.(); return api }

  function connect() {
    const url = new URL('ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(url)
    ws.onopen = () => { wait = 1000; everOpened = true }
    ws.onmessage = e => {
      let d
      try { d = JSON.parse(e.data) } catch { return }
      if (d.t === 'me') {
        state.me = d.me; state.coins = d.coins ?? state.coins
        if (d.game) { state.game = d.game; q('[data-title]').textContent = d.game.title }
        paint()
        if (!state.ready) { state.ready = true; opts.onReady?.(d.me) }
        return
      }
      if (d.t === 'chips') {
        const busted = state.chips + state.inPlay > 0 && d.chips === 0 && d.inPlay === 0 && d.cashout === undefined
        state.chips = d.chips; state.inPlay = d.inPlay
        if (busted) setTimeout(offerRefill, opts.bustDelay ?? 1200) // 결과 연출을 본 뒤에 (게임이 bustDelay로 조절)
        if (d.coins !== undefined && d.coins !== null) state.coins = d.coins
        paint()
        opts.onChips?.({ chips: state.chips, inPlay: state.inPlay, coins: state.coins })
        if (d.cashout !== undefined) { toast(`칩 ${fmt(d.cashout)}개를 코인으로 돌려받았어요.`); window.JMTT?.badge?.refresh?.() }
        if (opts.autoBuyIn !== false && !state.chips && !state.inPlay && state.ready && !dlg.open && d.cashout === undefined && !api._askedOnce) { api._askedOnce = true; openBuyIn() }
        return
      }
      // 서버의 알림·거절: 게임이 알 수 있게 onToast로 먼저 넘기고, false를 돌려주지 않으면 기본 알림을 띄운다
      if (d.t === 'toast' || d.t === 'error') { if (opts.onToast?.(d) === false) return; return toast(d.msg) }
      if (d.t === 'restart') { wait = 2000 + Math.random() * 8000; return toast('서버가 다시 시작돼요. 진행 중이던 판은 무효, 칩은 코인으로 돌아갔어요.') } // 모두 한꺼번에 다시 붙지 않게 (#부하)
      if (d.t === 'full') { wait = 20000 + Math.random() * 20000; return toast(d.msg || '지금 사람이 많아요. 잠시 뒤 다시 연결할게요.') }
      if (d.t === 'gift') return showGift(d)
      opts.onMessage?.(d)
    }
    ws.onclose = async () => {
      if (!everOpened) {
        // 한 번도 열리지 않았으면 로그인이 풀렸는지 확인
        try { const r = await fetch('/auth/me?optional=1', { cache: 'no-store' }); if (r.ok && (await r.json()) === null) { state.me = null; paint(); opts.onLoggedOut?.(); return } } catch {}
      }
      everOpened = false
      setTimeout(connect, wait * (0.5 + Math.random())) // 무작위로 흩어서 다시 붙기 (#부하)
      wait = Math.min(wait * 2, 30000)
    }
  }
  connect()
  return api
}
