// 블랙잭 (관리 모드, CASINO.md 3·5장). 규칙은 public/blackjack/rules.mjs, 한 판 진행은 engine.mjs
// 사람마다 자기 테이블(6덱 슈 하나)에서 딜러와 1:1로 한다.
//
//   브라우저 → { t: 'deal', bet }                       새 판 (칩에서 bet을 건다)
//              { t: 'act', a: 'hit'|'stand'|'double'|'split', seq }   seq = 마지막으로 받은 state의 seq (두 번 누름 막기)
//   서버 → { t: 'state', ev, seq, phase: 'idle'|'play'|'done', hands, active, dealer, actions, turnMs, back, shoe, lastBet }
//          딜러의 숨긴 카드는 판이 끝날 때까지 보내지 않는다 (dealer = [업카드, null])
//
// 칩 흐름: 딜 때 ctx.bet(bet), 더블·스플릿 때 ctx.bet(그 손의 베팅). 판이 끝나면 화면 연출(카드가 다 놓일 때)만큼
// 기다렸다가 ctx.payout — 칩 숫자가 카드보다 먼저 바뀌어 결과가 미리 보이지 않게 (슬롯·룰렛과 같은 방식).
// 30초 동안 아무것도 안 하면 그 손은 스탠드. 나가기·끊김 60초면 남은 손을 모두 스탠드하고 딜러까지 끝내 정산한다.
// 서버가 판 도중 꺼지면 코어가 그 판을 무효로 하고 건 칩을 돌려준다 (이미 끝난 판은 결과대로 정산).
import { deal, act, actions, standAll } from './engine.mjs'
import { SHOE_SIZE, CUT, TURN_MS, DEAL_MS, HIT_MS, DEALER_MS, RESULT_MS } from '../../../public/blackjack/rules.mjs'

const ACTS = new Set(['hit', 'stand', 'double', 'split'])
const tables = new Map() // 사용자 ID → { shoe, pos, shuffled, round, roundId, seq, turn, turnAt, pay, lastBet }

function table(p, ctx) {
  let t = tables.get(p.id)
  if (!t) { t = { shoe: ctx.rng.deck(6), pos: 0, shuffled: true, round: null, roundId: null, seq: 0, turn: null, turnAt: 0, pay: null, lastBet: 0 }; tables.set(p.id, t) }
  return t
}
function drawer(t, ctx) {
  return () => {
    if (t.pos >= t.shoe.length) { t.shoe = ctx.rng.deck(6); t.pos = 0; t.shuffled = true } // 한 판에 78장 넘게 쓸 일은 없지만 혹시 몰라
    return t.shoe[t.pos++]
  }
}

function view(t, p, ev) {
  const r = t.round
  const done = r?.phase === 'done'
  const msg = {
    t: 'state', ev, seq: t.seq,
    phase: r ? r.phase : 'idle',
    hands: r ? r.hands.map((h, i) => ({ cards: h.cards, bet: h.bet, doubled: h.doubled, split: h.split, ...(done ? r.results[i] : {}) })) : [],
    active: r ? r.active : 0,
    dealer: r ? (done ? r.dealer : [r.dealer[0], null]) : [],
    actions: actions(r, p.chips),
    turnMs: r && !done ? Math.max(0, t.turnAt - Date.now()) : 0,
    back: done ? r.back : null,
    shoe: { left: t.shoe.length - t.pos, size: SHOE_SIZE, cut: SHOE_SIZE - CUT, shuffled: t.shuffled },
    lastBet: t.lastBet,
  }
  return msg
}
const send = (t, p, ctx, ev) => ctx.send(p, view(t, p, ev))

function startTurn(t, p, ctx) {
  clearTimeout(t.turn)
  t.turnAt = Date.now() + TURN_MS
  t.turn = setTimeout(() => {
    const r = t.round
    if (!r || r.phase !== 'play') return
    const pos = t.pos
    act(r, 'stand', drawer(t, ctx))
    after(t, p, ctx, 'timeout', pos)
  }, TURN_MS)
}

// 행동 뒤: 판이 끝났으면 화면 연출만큼 늦게 정산, 아니면 다음 차례 30초
function after(t, p, ctx, ev, pos) {
  const r = t.round
  t.seq++
  if (r.phase === 'done') {
    clearTimeout(t.turn); t.turn = null
    const dealerDraws = r.dealer.length - 2
    const mine = Math.max(0, t.pos - pos - dealerDraws - (ev === 'deal' ? 2 : 0)) // 이번에 플레이어가 받은 카드
    const ms = (ev === 'deal' ? 4 * DEAL_MS : mine * HIT_MS) + (1 + dealerDraws) * DEALER_MS + RESULT_MS + 150
    const detail = { hands: r.hands.map((h, i) => ({ cards: h.cards.join(' '), bet: h.bet, result: r.results[i].result })), dealer: r.dealer.join(' ') }
    const job = { back: r.back, round: t.roundId, detail, timer: null }
    job.timer = setTimeout(() => pay(t, p, ctx), ms)
    t.pay = job
  } else startTurn(t, p, ctx)
  send(t, p, ctx, ev)
}

function pay(t, p, ctx) {
  const job = t.pay
  if (!job) return
  clearTimeout(job.timer)
  t.pay = null
  ctx.payout(p, job.back, job.round, job.detail)
}

export default {
  id: 'blackjack',
  title: '블랙잭',
  buyIn: { min: 1 },

  join(p, ctx) {
    send(table(p, ctx), p, ctx, 'join')
  },

  message(p, d, ctx) {
    const t = table(p, ctx)
    if (d.t === 'deal') {
      if (t.round?.phase === 'play') return ctx.send(p, { t: 'toast', msg: '판이 진행 중이에요.' })
      if (!ctx.limit(p, 'deal', 400)) return
      if (t.pay) pay(t, p, ctx) // 지난 판 결과 연출을 건너뛰고 바로 새 판
      if (p.inPlay) return ctx.send(p, { t: 'toast', msg: '판이 진행 중이에요.' })
      const bet = Number(d.bet) // 정수·범위·칩 잔액은 ctx.bet이 본다
      const roundId = 'b_' + Date.now().toString(36) + ctx.rng.int(1e6).toString(36)
      if (!ctx.bet(p, bet, roundId)) return ctx.send(p, { t: 'toast', msg: !p.chips ? '먼저 칩을 바꿔 주세요.' : bet > p.chips ? '칩이 모자라요.' : '베팅은 1칩 이상 정수로 해 주세요.' })
      t.shuffled = false
      if (t.pos >= CUT) { t.shoe = ctx.rng.deck(6); t.pos = 0; t.shuffled = true }
      const pos = t.pos
      t.round = deal(bet, drawer(t, ctx))
      t.roundId = roundId
      t.lastBet = bet
      return after(t, p, ctx, 'deal', pos)
    }
    if (d.t === 'act') {
      const r = t.round
      if (!r || r.phase !== 'play' || !ACTS.has(d.a)) return
      if (d.seq !== t.seq) return send(t, p, ctx, 'sync') // 이미 처리한 화면에서 누른 것 (두 번 누름)
      if (!actions(r, p.chips)[d.a]) return ctx.send(p, { t: 'toast', msg: d.a === 'double' || d.a === 'split' ? '칩이 모자라 지금은 할 수 없어요.' : '지금은 할 수 없어요.' })
      if ((d.a === 'double' || d.a === 'split') && !ctx.bet(p, r.hands[r.active].bet, t.roundId)) return ctx.send(p, { t: 'toast', msg: '칩이 모자라요.' })
      const pos = t.pos
      act(r, d.a, drawer(t, ctx))
      return after(t, p, ctx, d.a, pos)
    }
  },

  // 나가기·끊김 60초: 남은 손을 모두 스탠드하고 딜러까지 끝낸 뒤 바로 정산 (건 칩을 잃게 하지 않음)
  leave(p, ctx) {
    const t = tables.get(p.id)
    if (!t) return
    clearTimeout(t.turn)
    if (t.round?.phase === 'play') {
      const pos = t.pos
      standAll(t.round, drawer(t, ctx))
      after(t, p, ctx, 'leave', pos)
    }
    pay(t, p, ctx)
    tables.delete(p.id)
  },

  // 서버를 끌 때: 이미 끝난 판은 결과대로 정산. 진행 중인 판은 코어가 무효로 하고 건 칩을 돌려준다
  shutdown(ctx) {
    for (const p of ctx.players()) {
      const t = tables.get(p.id)
      if (!t) continue
      clearTimeout(t.turn)
      pay(t, p, ctx)
    }
  },
}
