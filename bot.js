// 컴퓨터 플레이어(봇). 방장 브라우저에서만 돌아가며, 대략적인 승률과 팟 오즈로 행동을 정한다.
import { evaluate, newDeck, compareScore } from './poker.js?v=1.6.0'

export const BOT_NAMES = ['포카봇', '블러프봇', '신중봇', '럭키봇', '올인봇', '계산봇']

// 상대들이 무작위 패를 들었다고 보고, 끝까지 갔을 때 이길 확률 (가볍게 n번 시뮬레이션)
function equity(hole, board, opponents, n = 200) {
  const known = new Set([...hole, ...board])
  const deck = newDeck().filter(c => !known.has(c))
  const need = 5 - board.length
  const draw = need + opponents * 2
  let score = 0
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < draw; k++) {
      const j = k + Math.floor(Math.random() * (deck.length - k))
      ;[deck[k], deck[j]] = [deck[j], deck[k]]
    }
    const full = [...board, ...deck.slice(0, need)]
    const mine = evaluate([...hole, ...full]).score
    let lost = false, ties = 0
    for (let o = 0; o < opponents; o++) {
      const cmp = compareScore(mine, evaluate([deck[need + o * 2], deck[need + o * 2 + 1], ...full]).score)
      if (cmp < 0) { lost = true; break }
      if (cmp === 0) ties++
    }
    if (!lost) score += 1 / (ties + 1)
  }
  return score / n
}

// 반환: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount? }
export function botDecision(table, id) {
  const s = table.seat(id)
  const opponents = Math.max(1, table.seats.filter(p => p.inHand && !p.folded && p.id !== id).length)
  const eq = equity(table.holes[id], table.board, opponents)
  const toCall = table.currentBet - s.bet
  const pot = table.pot + table.seats.reduce((a, p) => a + p.bet, 0)
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0
  const maxTo = s.bet + s.stack
  const minTo = table.currentBet + table.minRaise
  const step = table.cfg.BB / 2
  const raiseTo = f => Math.min(maxTo, Math.max(minTo, Math.round((table.currentBet + (pot + toCall) * f) / step) * step))
  const r = Math.random()
  // 이길 확률이 상대 수 대비 얼마나 좋은지 (1명일 때 0.5가 보통)
  const edge = eq * (opponents + 1)

  if (edge > 1.6 && r < 0.85) {
    if (maxTo <= minTo || (edge > 2.2 && r < 0.25)) return { type: 'allin' }
    return { type: 'raise', amount: raiseTo(edge > 2 ? 1 : 0.6) }
  }
  if (toCall === 0) {
    if (edge > 1.15 && r < 0.45) return { type: 'raise', amount: raiseTo(0.5) }
    if (r < 0.07) return { type: 'raise', amount: raiseTo(0.5) } // 가끔 블러프
    return { type: 'check' }
  }
  if (eq > potOdds + 0.05 || (toCall <= table.cfg.BB && edge > 0.7)) return { type: 'call' }
  if (r < 0.04) return { type: 'call' } // 가끔 끈질기게
  return { type: 'fold' }
}
