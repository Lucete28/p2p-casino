// 블랙잭 (관리 모드, CASINO.md 3·5장). 규칙은 public/blackjack/rules.mjs, 한 판 규칙은 engine.mjs
// 여러 명이 한 테이블(7자리, 6덱 슈 하나)에서 딜러와 한다. 판은 딜러(서버)가 돌린다 (운영자 결정 2026-11-18):
//   베팅 ─ 누가 처음 걸면 BET_MS 뒤 마감 (앉은 사람이 모두 걸면 READY_MS 뒤)
//   딜   ─ 자리 순서대로 두 장씩, 딜러는 업카드 + 숨긴 카드 (숨긴 카드는 딜러 차례까지 보내지 않음)
//   행동 ─ 건 사람 모두 동시에. 한 번 고를 때마다 TURN_MS, 넘으면 스탠드
//   딜러 ─ 모두 끝나면 숨긴 카드 → 17까지 받기 → 정산 (화면 연출이 끝날 때 ctx.payout)
//   결과 ─ SHOW_MS 보여 준 뒤 새 베팅
// 자리와 관전 (운영자 결정 2026-11-18: 관전자는 자리를 차지하지 않음)
//   들어오면 관전자로 테이블 하나를 본다 (빈자리가 있는 테이블 중 사람이 가장 많은 곳, 없으면 새 테이블)
//   빈자리를 누르거나(sit) 베팅하면(bet) 앉는다. 판이 없을 때 일어날 수 있고(stand),
//   앉아서 IDLE_ROUNDS판 연속으로 안 걸면 자동으로 일어나 관전으로 돌아간다
//
//   브라우저 → { t: 'sit', seat } 빈자리에 앉기 · { t: 'stand' } 일어나기
//              { t: 'bet', amount }   베팅 (0 = 취소). 베팅 시간에만. 관전 중이면 빈자리에 앉으면서 건다
//              { t: 'act', a: 'hit'|'stand'|'double'|'split', seq }   seq = 받은 state의 seq (두 번 누름 막기)
//              { t: 'emoji', e }   이모지 (앉은 사람만, EMOJIS 다섯 개만, EMOJI_MS에 한 번) → 테이블 모두에게 { t: 'emoji', seat, e }
//   서버 → { t: 'state', ev, seat?, table, phase: 'bet'|'play'|'dealer'|'result', phaseMs, dealer, seats, me, watching,
//            seq, actions, shoe }      me = 내 자리 (관전 중이면 -1)
//
// 칩: 베팅 마감 때 ctx.bet, 더블·스플릿 때 ctx.bet, 딜러 연출이 끝날 때 ctx.payout.
// 판 도중(행동 시간) 나가기를 누르면 건 칩을 잃는다 (딜러 결과가 아직 없어서. 화면이 먼저 확인을 받음, CASINO.md 4장).
// 연결이 끊기면 자리는 60초 남고, 그사이 행동 시간이 지나 스탠드 → 판이 끝나 정산된다. 딜러 결과가 나온 뒤 나가면 바로 정산.
// 서버가 판 도중 꺼지면 코어가 그 판을 무효로 하고 건 칩을 돌려준다 (결과가 나온 판은 결과대로 정산).
import { dealRound, seatActions, seatAct, dealerPlay, settleSeat } from './engine.mjs'
import { DECKS, SHOE_SIZE, CUT, SEATS, MIN_BET, IDLE_ROUNDS, EMOJIS, EMOJI_MS, BET_MS, READY_MS, TURN_MS, SHOW_MS, DEAL_MS, HIT_MS, DEALER_MS, RESULT_MS } from '../../../public/blackjack/rules.mjs'

const ACTS = new Set(['hit', 'stand', 'double', 'split'])
const SEAT_ORDER = [3, 2, 4, 1, 5, 0, 6] // 가운데 자리부터 채움
const tables = new Map() // 테이블 번호 → 테이블
const seatOf = new Map() // 사용자 ID → 자리 (앉은 사람)
const watchOf = new Map() // 사용자 ID → 테이블 (관전자)
let nextNo = 1

const online = p => !p.sockets || p.sockets.size > 0 // 코어 플레이어의 연결 (읽기만)
const seated = t => t.seats.filter(Boolean)
const playing = t => seated(t).filter(s => s.inRound)
const people = t => [...seated(t).map(s => s.p), ...t.watchers]
const toast = (ctx, p, msg) => ctx.send(p, { t: 'toast', msg })
const tableOf = p => seatOf.get(p.id)?.t || watchOf.get(p.id)

function newTable(ctx) {
  const t = { no: nextNo++, seats: Array(SEATS).fill(null), watchers: new Set(), shoe: ctx.rng.deck(DECKS), pos: 0, shuffled: true,
    phase: 'bet', endsAt: 0, timer: null, timerFn: null, closing: false, dealer: [], roundId: null, ctx }
  tables.set(t.no, t)
  return t
}
// 빈자리가 있는 테이블 중 앉은 사람이 가장 많은 곳 (없으면 새 테이블)
function pickTable(ctx) {
  let t = null
  for (const x of tables.values()) if (seated(x).length < SEATS && (!t || seated(x).length > seated(t).length)) t = x
  return t || newTable(ctx)
}
function watch(p, t) { watchOf.set(p.id, t); t.watchers.add(p) }
function unwatch(p) { const t = watchOf.get(p.id); if (t) { t.watchers.delete(p); watchOf.delete(p.id) } return t }
function dropIfEmpty(t) {
  if (seated(t).length || t.watchers.size) return false
  unschedule(t)
  tables.delete(t.no)
  return true
}

// 관전자 → 자리 i에 앉기
function sitAt(p, t, i) {
  unwatch(p)
  const s = { p, t, i, bet: 0, ready: false, inRound: false, hands: [], active: 0, done: true, seq: 0, turnAt: 0, turnTimer: null,
    back: null, staked: 0, net: 0, results: null, paid: true, idle: 0 }
  t.seats[i] = s
  seatOf.set(p.id, s)
  return s
}
// 자리 → 관전 (판에 걸려 있지 않을 때만)
function standUp(s) {
  const { t, p } = s
  clearTimeout(s.turnTimer)
  t.seats[s.i] = null
  seatOf.delete(p.id)
  watch(p, t)
}

// 테이블 진행 타이머 (한 번에 하나)
function schedule(t, ms, fn) {
  clearTimeout(t.timer)
  t.timerFn = fn
  t.timer = setTimeout(() => { t.timer = null; t.timerFn = null; fn() }, ms)
}
function unschedule(t) { clearTimeout(t.timer); t.timer = null; t.timerFn = null }
function drawer(t) {
  return () => {
    if (t.pos >= t.shoe.length) { t.shoe = t.ctx.rng.deck(DECKS); t.pos = 0; t.shuffled = true } // 한 판에 78장 넘게 쓸 일은 없지만 혹시 몰라
    return t.shoe[t.pos++]
  }
}

// ---------- 화면에 보낼 상태 (보는 사람마다 me·seq·actions만 다름) ----------
function view(t, viewer, ev, extra) {
  const now = Date.now()
  const open = t.phase === 'dealer' || t.phase === 'result' // 딜러 카드·결과 공개
  const my = seatOf.get(viewer.id)
  const mine = my?.t === t ? my : null
  return {
    t: 'state', ev, ...extra,
    table: t.no, phase: t.phase,
    phaseMs: t.endsAt ? Math.max(0, t.endsAt - now) : 0,
    dealer: !t.dealer.length ? [] : open ? t.dealer : [t.dealer[0], null],
    seats: t.seats.map(s => s && {
      name: s.p.name || '손님', me: s === mine, online: online(s.p),
      bet: s.bet, ready: s.ready, inRound: s.inRound, done: s.done, active: s.active,
      hands: s.inRound ? s.hands.map((h, k) => ({ cards: h.cards, bet: h.bet, doubled: h.doubled, split: h.split, ...(open && s.results ? s.results[k] : {}) })) : [],
      staked: s.inRound ? s.hands.reduce((a, h) => a + h.bet, 0) : 0,
      back: open ? s.back : null,
      turnMs: s.inRound && !s.done && t.phase === 'play' ? Math.max(0, s.turnAt - now) : 0,
    }),
    me: mine ? mine.i : -1,
    watching: t.watchers.size,
    seq: mine ? mine.seq : 0,
    actions: mine && t.phase === 'play' && mine.inRound ? seatActions(mine, viewer.chips) : seatActions(null),
    shoe: { left: t.shoe.length - t.pos, size: SHOE_SIZE, cut: SHOE_SIZE - CUT, shuffled: t.shuffled },
  }
}
function broadcast(t, ev, extra) {
  for (const p of people(t)) t.ctx.send(p, view(t, p, ev, extra))
}

// ---------- 베팅 ----------
function placeBet(s, amount) {
  const { t } = s, { ctx } = t, p = s.p
  if (t.phase !== 'bet') return toast(ctx, p, '지금은 베팅할 수 없어요. 이번 판이 끝나면 걸 수 있어요.')
  if (amount === 0) { s.ready = false; return broadcast(t, 'bet', { seat: s.i }) }
  if (!Number.isSafeInteger(amount) || amount < MIN_BET) return toast(ctx, p, `베팅은 ${MIN_BET}칩 이상 정수로 해 주세요.`)
  if (amount > p.chips) return toast(ctx, p, p.chips ? '칩이 모자라요.' : '먼저 칩을 바꿔 주세요.')
  s.bet = amount
  s.ready = true
  s.idle = 0
  if (!t.endsAt) { t.endsAt = Date.now() + BET_MS; schedule(t, BET_MS, () => closeBetting(t)) }
  allReady(t)
  broadcast(t, 'bet', { seat: s.i })
}
// 앉아 있고(연결됨) 칩이 있는 사람이 모두 걸었으면 곧 마감
function allReady(t) {
  if (t.phase !== 'bet' || !t.endsAt) return
  const can = seated(t).filter(s => online(s.p) && (s.p.chips >= MIN_BET || s.ready)) // 최소 베팅보다 칩이 적은 사람은 기다리지 않음
  if (can.length && can.every(s => s.ready) && t.endsAt - Date.now() > READY_MS) {
    t.endsAt = Date.now() + READY_MS
    schedule(t, READY_MS, () => closeBetting(t))
  }
}

function closeBetting(t) {
  const { ctx } = t
  const roundId = 'b' + t.no + '_' + Date.now().toString(36) + ctx.rng.int(1e6).toString(36)
  const players = []
  for (const s of seated(t)) {
    const was = s.ready
    s.ready = false
    if (!was || !online(s.p)) continue // 끊긴 사람은 이번 판 빠짐 (칩은 그대로)
    if (ctx.bet(s.p, s.bet, roundId)) players.push(s)
    else toast(ctx, s.p, '칩이 모자라 이번 판은 빠졌어요.')
  }
  t.endsAt = 0
  if (!players.length) return broadcast(t, 'bet')
  // 이번 판에 안 건 사람: IDLE_ROUNDS판 연속이면 일어나 관전으로 (자리를 다른 사람에게)
  for (const s of seated(t)) {
    if (players.includes(s)) continue
    if (++s.idle >= IDLE_ROUNDS) { standUp(s); toast(ctx, s.p, `${IDLE_ROUNDS}판 동안 걸지 않아 자리에서 일어났어요. 빈자리를 누르거나 베팅하면 다시 앉아요.`) }
  }
  t.shuffled = false
  if (t.pos >= CUT) { t.shoe = ctx.rng.deck(DECKS); t.pos = 0; t.shuffled = true }
  t.roundId = roundId
  t.closing = false
  for (const s of players) { s.inRound = true; s.paid = false; s.back = null; s.results = null; s.seq++ }
  const { dealer, cards } = dealRound(players, drawer(t))
  t.dealer = dealer
  t.phase = 'play'
  const dealMs = cards * DEAL_MS // 화면이 카드를 다 나눈 뒤부터 행동 시간
  for (const s of players) if (!s.done) startTurn(s, dealMs)
  broadcast(t, 'deal')
  allDone(t, dealMs)
}

// ---------- 행동 ----------
function startTurn(s, delay) {
  clearTimeout(s.turnTimer)
  s.turnAt = Date.now() + delay + TURN_MS
  s.turnTimer = setTimeout(() => {
    s.turnTimer = null
    if (s.t.phase === 'play' && s.inRound && !s.done && s.t.seats[s.i] === s) act(s, 'stand', 'timeout')
  }, delay + TURN_MS)
}
function act(s, a, ev) {
  const t = s.t
  const pos = t.pos
  if (!seatAct(s, a, drawer(t))) return
  s.seq++
  const anim = Math.max(0, t.pos - pos) * HIT_MS
  if (s.done) { clearTimeout(s.turnTimer); s.turnTimer = null } else startTurn(s, anim)
  broadcast(t, ev, { seat: s.i })
  allDone(t, anim)
}
// 건 사람이 모두 끝났으면 (마지막 카드 연출 뒤) 딜러 차례
function allDone(t, anim) {
  if (t.phase !== 'play' || t.closing || !playing(t).every(s => s.done)) return
  t.closing = true
  schedule(t, anim + 150, () => dealerTurn(t))
}

// ---------- 딜러 · 정산 ----------
function dealerTurn(t) {
  const players = playing(t)
  if (!players.length) return newBetting(t) // 건 사람이 모두 나감
  dealerPlay(t.dealer, players, drawer(t))
  for (const s of players) settleSeat(s, t.dealer)
  t.phase = 'dealer'
  broadcast(t, 'dealer')
  const anim = (1 + t.dealer.length - 2) * DEALER_MS + RESULT_MS + 150 // 숨긴 카드 뒤집기 + 받은 카드 + 결과 표시
  schedule(t, anim, () => {
    for (const s of playing(t)) pay(s)
    t.phase = 'result'
    t.endsAt = Date.now() + SHOW_MS
    broadcast(t, 'result')
    schedule(t, SHOW_MS, () => newBetting(t))
  })
}
function pay(s) {
  if (s.paid || s.back === null) return
  s.paid = true
  const t = s.t
  const detail = { table: t.no, seat: s.i, dealer: t.dealer.join(' '),
    hands: s.hands.map((h, k) => ({ cards: h.cards.join(' '), bet: h.bet, result: s.results[k].result })) }
  t.ctx.payout(s.p, s.back, t.roundId, detail)
}
function newBetting(t) {
  t.phase = 'bet'
  t.dealer = []
  t.endsAt = 0
  t.closing = false
  for (const s of seated(t)) { s.inRound = false; s.hands = []; s.done = true; s.results = null; s.back = null; s.ready = false; clearTimeout(s.turnTimer) }
  broadcast(t, 'bet')
}

export default {
  id: 'blackjack',
  title: '블랙잭',
  buyIn: { min: MIN_BET }, // 칩 바꾸기도 최소 베팅만큼부터

  // 접속할 때마다 (새로고침·다른 탭 포함). 처음이면 관전자로 테이블 하나를 본다
  join(p, ctx) {
    const t = tableOf(p)
    if (t) return ctx.send(p, view(t, p, 'join'))
    const nt = pickTable(ctx)
    watch(p, nt)
    broadcast(nt, 'watch')
  },

  message(p, d, ctx) {
    const s = seatOf.get(p.id)
    if (d.t === 'sit') {
      const t = watchOf.get(p.id)
      if (!t) return
      const i = Number(d.seat)
      if (!Number.isInteger(i) || i < 0 || i >= SEATS || t.seats[i]) return toast(ctx, p, '그 자리에는 앉을 수 없어요.')
      sitAt(p, t, i)
      return broadcast(t, 'sit', { seat: i })
    }
    if (d.t === 'stand') {
      if (!s) return
      if (s.inRound) return toast(ctx, p, '이 판이 끝난 뒤에 일어날 수 있어요.')
      standUp(s)
      allReady(s.t)
      return broadcast(s.t, 'stand', { seat: s.i })
    }
    if (d.t === 'bet') {
      if (!ctx.limit(p, 'bet', 150)) return
      const amount = Number(d.amount)
      if (s) return placeBet(s, amount)
      // 관전 중에 베팅: 빈자리(가운데부터)에 앉으면서 건다
      const t = watchOf.get(p.id)
      if (!t || amount === 0) return
      if (t.phase !== 'bet') return toast(ctx, p, '지금은 베팅할 수 없어요. 이번 판이 끝나면 걸 수 있어요.')
      if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > p.chips) return toast(ctx, p, !p.chips ? '먼저 칩을 바꿔 주세요.' : amount > p.chips ? '칩이 모자라요.' : `베팅은 ${MIN_BET}칩 이상 정수로 해 주세요.`)
      const i = SEAT_ORDER.find(k => !t.seats[k])
      if (i === undefined) return toast(ctx, p, '빈자리가 없어요. 자리가 나면 앉을 수 있어요.')
      return placeBet(sitAt(p, t, i), amount)
    }
    if (d.t === 'emoji') {
      if (!s || !EMOJIS.includes(d.e) || !ctx.limit(p, 'emoji', EMOJI_MS)) return
      for (const o of people(s.t)) ctx.send(o, { t: 'emoji', seat: s.i, e: d.e })
      return
    }
    if (d.t === 'act') {
      if (!s) return
      const t = s.t
      if (t.phase !== 'play' || !s.inRound || s.done || !ACTS.has(d.a)) return
      if (d.seq !== s.seq) return ctx.send(p, view(t, p, 'sync')) // 이미 처리한 화면에서 누른 것 (두 번 누름)
      if (!seatActions(s, p.chips)[d.a]) return toast(ctx, p, d.a === 'double' || d.a === 'split' ? '칩이 모자라 지금은 할 수 없어요.' : '지금은 할 수 없어요.')
      if ((d.a === 'double' || d.a === 'split') && !ctx.bet(p, s.hands[s.active].bet, t.roundId)) return toast(ctx, p, '칩이 모자라요.')
      return act(s, d.a, 'act')
    }
  },

  // 칩을 바꾼 직후: 내 화면을 다시 보내고 '모두 걸었나'를 다시 본다
  chipsChanged(p, ctx) {
    const t = tableOf(p)
    if (t) { ctx.send(p, view(t, p, 'sync')); allReady(t) }
  },

  // 나가기·끊김 60초: 결과가 나온 판은 바로 정산. 행동 시간에 나가면 코어가 건 칩을 거둔다 (위 설명)
  leave(p) {
    const s = seatOf.get(p.id)
    if (!s) {
      const t = unwatch(p)
      if (t && !dropIfEmpty(t)) broadcast(t, 'watch')
      return
    }
    const t = s.t
    seatOf.delete(p.id)
    clearTimeout(s.turnTimer)
    if (t.phase === 'dealer' || t.phase === 'result') pay(s)
    t.seats[s.i] = null
    if (dropIfEmpty(t)) return
    broadcast(t, 'leave', { seat: s.i })
    allDone(t, 0)
    allReady(t)
  },

  // 로비 숫자: 앉은 사람 + 관전자 (들어와 있는 사람 모두)
  summary() {
    return { players: seatOf.size + watchOf.size, tables: tables.size }
  },

  // 서버를 끌 때: 결과가 나온 판은 결과대로 정산. 행동 중인 판은 코어가 무효로 하고 건 칩을 돌려준다
  shutdown() {
    for (const t of tables.values()) {
      unschedule(t)
      for (const s of seated(t)) {
        clearTimeout(s.turnTimer)
        if (t.phase === 'dealer' || t.phase === 'result') pay(s)
      }
    }
  },
}

// 테스트·시뮬레이션용: 이 사람 테이블의 다음 진행(베팅 마감·딜러·정산·새 베팅)을 기다리지 않고 바로
export function _advance(p) {
  const t = tableOf(p)
  if (!t?.timerFn) return false
  const fn = t.timerFn
  unschedule(t)
  fn()
  return true
}
export const _tables = tables
