// 슬롯머신 (관리 모드, CASINO.md 3·5장): 3릴 · 5라인 · RTP 95.02%. 규칙은 public/slots/rules.mjs (화면과 같이 씀)
//
//   브라우저 → { t: 'spin', lineBet, lines }            lines = 1·3·5
//   서버 → { t: 'spun', round, stops, lineBet, lines, wins, back, tease }   멈출 자리는 ctx.rng.int(24) × 3
//          tease = 마지막 릴을 더 돌리는 연출 (정산도 TEASE_MS 늦게)
//          { t: 'hello', stops, spinMs, spinning }       접속할 때 (마지막으로 멈춘 자리)
//
// 칩 흐름: 돌리면 바로 ctx.bet(lineBet × lines). 릴이 다 멈출 때(SPIN_MS 뒤) ctx.payout(돌려받을 칩).
// 바로 정산하면 윗줄 칩 숫자가 릴이 멈추기 전에 바뀌어 결과가 미리 보이기 때문 (룰렛과 같은 방식).
// 결과는 돌리는 순간 정해지므로, 그사이 나가거나 끊기거나 서버를 꺼도 그 결과대로 바로 정산한다 (건 칩을 잃게 하지 않음).
import { checkBet, evaluate, teases, REEL_LEN, TEASE_MS } from '../../../public/slots/rules.mjs'

export const SPIN_MS = 2300 // 화면의 릴 연출(public/slots/app.js의 마지막 릴 정지 약 2.0초)보다 약간 길게
const MIN_GAP_MS = 800 // 스핀 간격 최소 (CASINO.md 5장)

const pending = new Map() // 사용자 ID → { timer, round, back, result }
const lastStops = new Map() // 사용자 ID → 마지막으로 멈춘 자리 (다시 들어와도 같은 그림)

function finish(p, ctx) {
  const job = pending.get(p.id)
  if (!job) return
  clearTimeout(job.timer)
  pending.delete(p.id)
  ctx.payout(p, job.back, job.round, job.result)
}

export default {
  id: 'slots',
  title: '슬롯머신',
  buyIn: { min: 1 },

  join(p, ctx) {
    ctx.send(p, { t: 'hello', stops: lastStops.get(p.id) || null, spinMs: SPIN_MS, spinning: pending.has(p.id) })
  },

  message(p, d, ctx) {
    if (d.t !== 'spin') return
    if (pending.has(p.id) || p.inPlay) return ctx.send(p, { t: 'toast', msg: '릴이 아직 돌고 있어요.' })
    if (!ctx.limit(p, 'spin', MIN_GAP_MS)) return
    const bet = checkBet(d.lineBet, d.lines)
    if (bet.error) return ctx.send(p, { t: 'toast', msg: bet.error })
    const round = 's_' + Date.now().toString(36) + ctx.rng.int(1e6).toString(36)
    if (!ctx.bet(p, bet.total, round)) return ctx.send(p, { t: 'toast', msg: p.chips ? '칩이 모자라요.' : '먼저 칩을 바꿔 주세요.' })

    const stops = [ctx.rng.int(REEL_LEN), ctx.rng.int(REEL_LEN), ctx.rng.int(REEL_LEN)]
    const r = evaluate(stops, bet.lines, bet.lineBet)
    lastStops.set(p.id, stops)
    const result = { stops, lineBet: bet.lineBet, lines: bet.lines, wins: r.wins.map(w => [w.line, w.kind, w.pay]) } // 판 기록 (30일)
    const tease = teases(stops, bet.lines)
    const timer = setTimeout(() => finish(p, ctx), SPIN_MS + (tease ? TEASE_MS : 0))
    pending.set(p.id, { timer, round, back: r.back, result })
    ctx.send(p, { t: 'spun', round, stops, lineBet: bet.lineBet, lines: bet.lines, total: bet.total, wins: r.wins, back: r.back, tease })
  },

  // 나가기·끊김 60초: 이미 정해진 결과대로 정산 (코어는 그 뒤 남은 칩을 코인으로)
  leave(p, ctx) {
    finish(p, ctx)
    lastStops.delete(p.id)
  },

  // 서버를 끌 때도 정해진 결과대로 정산한 뒤 코어가 칩을 코인으로
  shutdown(ctx) {
    for (const p of ctx.players()) finish(p, ctx)
  },
}
