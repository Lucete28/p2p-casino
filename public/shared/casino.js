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
//       onLoggedOut() {},                  // 로그인 안 한 사람 (화면은 보여 주고, 칩 바꾸기 때 로그인 안내)
//     })
//     game.send({ t: 'spin', bet: 10 })    // 서버(server/games/<id>)로
//   </script>
//
// 윗줄(← 로비 · 게임 이름 · 코인 · 칩 · 칩 바꾸기 · 코인으로), 칩 바꾸기 창, 알림, 다시 연결을 이 파일이 맡는다.
// 칩 숫자는 서버가 보낸 값만 보여 준다 (브라우저에서 계산하지 않음)

const fmt = n => Number(n || 0).toLocaleString('ko-KR')
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

  function paint() {
    q('[data-coins]').textContent = fmt(state.coins)
    q('[data-chips]').textContent = fmt(state.chips)
    q('[data-coins-pill]').hidden = !state.me
    q('[data-chips-pill]').hidden = !state.me
    q('[data-buyin]').hidden = !state.me
    q('[data-cashout]').hidden = !state.me || !state.chips
    q('[data-cashout]').disabled = state.inPlay > 0
    q('[data-login]').hidden = !!state.me
  }
  q('[data-buyin]').onclick = openBuyIn
  q('[data-cashout]').onclick = () => api.send({ t: 'cashout' })
  // 로비로: 판이 진행 중이면 확인 (나가면 건 칩을 잃는다), 아니면 칩을 코인으로 돌려받고 이동
  q('[data-back]').onclick = e => {
    if (!state.me || !ws || ws.readyState !== 1) return
    e.preventDefault()
    if (state.inPlay > 0 && !confirm('판이 진행 중이에요. 지금 나가면 건 칩을 잃어요. 나갈까요?')) return
    api.send({ t: 'leave' })
    setTimeout(() => { location.href = '../' }, 200)
  }

  // ---------- 서버 연결 ----------
  let ws = null, wait = 1000, everOpened = false
  const api = {
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
      if (d.t === 'restart') return toast('서버가 다시 시작돼요. 진행 중이던 판은 무효, 칩은 코인으로 돌아갔어요.')
      opts.onMessage?.(d)
    }
    ws.onclose = async () => {
      if (!everOpened) {
        // 한 번도 열리지 않았으면 로그인이 풀렸는지 확인
        try { const r = await fetch('/auth/me?optional=1', { cache: 'no-store' }); if (r.ok && (await r.json()) === null) { state.me = null; paint(); opts.onLoggedOut?.(); return } } catch {}
      }
      everOpened = false
      setTimeout(connect, wait)
      wait = Math.min(wait * 2, 15000)
    }
  }
  connect()
  return api
}
