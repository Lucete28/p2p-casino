// 슬롯머신 (관리 모드, CASINO.md 3·5장): 머신 네 대 + 모두의 잭팟. 규칙은 public/slots/rules.mjs (화면과 같이 씀)
//
//   브라우저 → { t: 'spin', machine, lineBet, lines }    machine = classic·diamond·fruit5·lucky
//              { t: 'skip' }                             긴 연출(프리스핀·연쇄) 건너뛰기 → 정해진 결과로 바로 정산
//   서버 → { t: 'spun', machine, round, stops, lineBet, lines, total, wins, scatter, mreel, steps, back, base, tease, bonus, jackpot }
//            back = 이번 판에 돌려받을 칩 전부 (프리스핀·연쇄·잭팟 포함), base = 첫 화면의 당첨
//            steps = 과일 폭탄 연쇄 (떨어진 새 과일 포함), bonus = 럭키 스타 프리스핀 { spins, total, mult }
//            jackpot = { win, kind: 'mystery' }
//          { t: 'hello', stops: { 머신: 멈춘 자리 }, spinning, jackpot }   접속할 때
//          { t: 'jackpot', pool, last }                  모두의 잭팟이 바뀔 때 (모두에게, 1초에 한 번까지 · 누가 맞히면 바로)
//
// 칩 흐름: 돌리면 바로 ctx.bet(한 판 베팅). 연출이 끝날 즈음 ctx.payout(돌려받을 칩 전부). 화면은 연출이 끝날 때까지
// 늘어난 칩 숫자를 보여 주지 않으므로 결과가 미리 보이지 않는다.
// 결과는 돌리는 순간 모두 정해진다 (프리스핀·연쇄의 새 과일·잭팟 포함). 그사이 나가거나 끊기거나 서버를 꺼도 그 결과대로 바로 정산.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MACHINE_IDS, JACKPOT, machineOf, checkBet, evaluate, freeSpins, teases, TEASE_MS } from '../../../public/slots/rules.mjs'

export const SPIN_MS = 2300 // 화면의 릴 연출(마지막 릴 정지 약 2.0초)보다 약간 길게
export const FS_MS = { intro: 2200, spin: 1800, outro: 800 } // 프리스핀 연출 (public/slots/app.js와 같게)
export const CASCADE_MS = 1100 // 과일 폭탄 연쇄 한 번
const MIN_GAP_MS = 800 // 스핀 간격 최소 (CASINO.md 5장)
// 로컬에서 미스터리 잭팟 연출을 보려고 확률만 바꿀 때 (사이트에는 이 환경 변수가 없음)
const JP_ODDS = Number(process.env.SLOTS_JP_ODDS) || JACKPOT.odds

const pending = new Map() // 사용자 ID → { timer, round, back, result, jackpot }
const lastStops = new Map() // 사용자 ID → { 머신: 멈춘 자리 } (다시 들어와도 같은 그림)

// ---------- 모두의 잭팟 ----------
// 어느 머신이든 베팅의 1.5%는 잭팟에, 0.5%는 다음 밑돈에. 판마다 베팅 ÷ odds 확률로 잭팟 전부 (미스터리).
// 다 가져가면 밑돈이 새 잭팟 (floor보다 적으면 하우스가 floor까지 채움).
// 금액은 DATA_DIR/slots-jackpot.json에 저장 (서버가 다시 켜져도 이어짐). 코어 저장소에 일반 저장 칸이 없어서 따로 둠
const DATA = process.env.DATA_DIR || join(import.meta.dirname, '..', '..', '..', 'data')
const JP_FILE = join(DATA, 'slots-jackpot.json')
let jp = { pool: JACKPOT.start, reserve: 0, hits: 0, last: null } // last = { name, win, machine, at }
let saveT = null, sendT = null, sendAt = 0
function loadJackpot() {
  try {
    const d = JSON.parse(readFileSync(JP_FILE, 'utf8'))
    if (Number.isFinite(d.pool) && d.pool >= 0 && Number.isFinite(d.reserve) && d.reserve >= 0) jp = { ...jp, ...d }
  } catch {}
}
function saveJackpot() {
  clearTimeout(saveT); saveT = null
  try {
    mkdirSync(DATA, { recursive: true })
    writeFileSync(JP_FILE + '.tmp', JSON.stringify(jp))
    renameSync(JP_FILE + '.tmp', JP_FILE)
  } catch (err) { console.warn('[slots] jackpot save', err.message) }
}
const saveSoon = () => { saveT ||= setTimeout(saveJackpot, 2000); saveT.unref?.() }
const jpMsg = () => ({ t: 'jackpot', pool: Math.floor(jp.pool), last: jp.last })
function announce(ctx, now_ = false) { // 모두에게 잭팟 금액 (1초에 한 번까지, 누가 맞혔을 때는 바로)
  const now = Date.now()
  if (now_ || now - sendAt >= 1000) { clearTimeout(sendT); sendT = null; sendAt = now; ctx.broadcast(ctx.players(), jpMsg()); return }
  sendT ||= setTimeout(() => { sendT = null; sendAt = Date.now(); ctx.broadcast(ctx.players(), jpMsg()) }, 1000 - (now - sendAt))
  sendT.unref?.()
}
// 테스트·시뮬레이션용: 지금 잭팟 상태 (소수점 포함)
export const jackpotState = () => ({ ...jp })

function finish(p, ctx) {
  const job = pending.get(p.id)
  if (!job) return
  clearTimeout(job.timer)
  pending.delete(p.id)
  ctx.payout(p, job.back, job.round, job.result)
  if (job.jackpot) { jp.last = { name: p.name || '누군가', win: job.jackpot.win, machine: job.machine, at: Date.now() }; saveJackpot(); announce(ctx, true) }
  else saveSoon()
}

const randStops = (m, ctx) => {
  const s = m.strips.map(st => ctx.rng.int(st.length))
  if (m.mstrip) s.push(ctx.rng.int(m.mstrip.length)) // 다이아몬드 배수 릴
  return s
}
const compactWins = wins => wins.map(w => [w.line ?? w.sym, w.kind, w.pay])

export default {
  id: 'slots',
  title: '슬롯머신',
  buyIn: { min: 1 },

  init() { loadJackpot() },

  join(p, ctx) {
    ctx.send(p, { t: 'hello', stops: lastStops.get(p.id) || {}, spinMs: SPIN_MS, fsMs: FS_MS, spinning: pending.has(p.id), jackpot: jpMsg() })
  },

  message(p, d, ctx) {
    if (d.t === 'skip') return finish(p, ctx) // 정해진 결과로 바로 정산 (연출만 건너뜀)
    if (d.t !== 'spin') return
    if (pending.has(p.id) || p.inPlay) return ctx.send(p, { t: 'toast', msg: '릴이 아직 돌고 있어요.' })
    if (!ctx.limit(p, 'spin', MIN_GAP_MS)) return
    if (d.machine !== undefined && !MACHINE_IDS.includes(d.machine)) return ctx.send(p, { t: 'toast', msg: '없는 머신이에요.' })
    const m = machineOf(d.machine)
    const bet = checkBet(m, d.lineBet, d.lines)
    if (bet.error) return ctx.send(p, { t: 'toast', msg: bet.error })
    const round = 's_' + Date.now().toString(36) + ctx.rng.int(1e6).toString(36)
    if (!ctx.bet(p, bet.total, round)) return ctx.send(p, { t: 'toast', msg: p.chips ? '칩이 모자라요.' : '먼저 칩을 바꿔 주세요.' })

    const stops = randStops(m, ctx)
    const draw = r => m.strips[r][ctx.rng.int(m.strips[r].length)] // 연쇄로 떨어질 새 과일
    const r = evaluate(m, stops, bet.lines, bet.lineBet, 1, draw)
    let back = r.back, delay = SPIN_MS
    const tease = teases(m, stops, bet.lines)
    if (tease) delay += TEASE_MS
    const result = { machine: m.id, stops, lineBet: bet.lineBet, lines: bet.lines } // 판 기록 (30일)
    if (r.wins) result.wins = compactWins(r.wins)
    if (r.scatter?.pay) result.scatter = [r.scatter.count, r.scatter.pay]
    if (r.mreel) result.mreel = r.mreel.value
    if (r.steps) { result.steps = r.steps.map(s => [s.chain, s.pay]); delay += r.steps.length * CASCADE_MS }

    // 럭키 스타 프리스핀: 지금 다 정한다 (별이 뜰 때마다 배수 +1, 별 셋이면 +3번)
    let bonus = null
    if (r.bonus) {
      bonus = freeSpins(m, bet.lines, bet.lineBet, () => randStops(m, ctx))
      back += bonus.total
      delay += FS_MS.intro + bonus.spins.length * FS_MS.spin + FS_MS.outro
      result.fs = { total: bonus.total, spins: bonus.spins.length, mult: bonus.mult }
    }

    // 모두의 잭팟: 쌓고, 미스터리(베팅 비례 확률)로 터지면 전부
    jp.pool += bet.total * JACKPOT.contribute
    jp.reserve += bet.total * JACKPOT.reserve
    let jackpot = null
    const mystery = ctx.rng.int(JP_ODDS) < bet.total
    if (mystery) {
      const win = Math.floor(jp.pool)
      jp.pool = Math.max(jp.pool - win + jp.reserve, JACKPOT.floor)
      jp.reserve = 0
      jp.hits++
      jackpot = { win, kind: 'mystery' }
      back += win
      result.jp = [jackpot.kind, win]
      delay += 2500
    }
    announce(ctx)

    const all = lastStops.get(p.id) || {}
    all[m.id] = stops
    lastStops.set(p.id, all)
    const timer = setTimeout(() => finish(p, ctx), delay)
    pending.set(p.id, { timer, round, back, result, jackpot, machine: m.id })
    ctx.send(p, {
      t: 'spun', machine: m.id, round, stops, lineBet: bet.lineBet, lines: bet.lines, total: bet.total,
      wins: r.wins || [], scatter: r.scatter, mreel: r.mreel, steps: r.steps, back, base: r.back, tease, bonus, jackpot,
    })
  },

  // 나가기·끊김 60초: 이미 정해진 결과대로 정산 (코어는 그 뒤 남은 칩을 코인으로)
  leave(p, ctx) {
    finish(p, ctx)
    lastStops.delete(p.id)
  },

  // 서버를 끌 때도 정해진 결과대로 정산한 뒤 코어가 칩을 코인으로
  shutdown(ctx) {
    for (const p of ctx.players()) finish(p, ctx)
    saveJackpot()
  },
}
