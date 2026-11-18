// 슬롯머신 (관리 모드, CASINO.md 3·5장): 머신 다섯 대, 모두 RTP 약 99%. 규칙은 public/slots/rules.mjs (화면과 같이 씀)
//
//   브라우저 → { t: 'spin', machine, lineBet, lines }    machine = classic·diamond·fruit5·lucky·jackpot
//              { t: 'skip' }                             프리스핀 연출 건너뛰기 → 정해진 결과로 바로 정산
//   서버 → { t: 'spun', machine, round, stops, lineBet, lines, total, wins, scatter, back, tease, bonus, jackpot }
//            back = 이번 판에 돌려받을 칩 전부 (프리스핀·잭팟 포함). bonus = { mult, spins: [{ stops, wins, scatter, back }], total }
//          { t: 'hello', stops: { 머신: 멈춘 자리 }, spinning, jackpot }   접속할 때
//          { t: 'jackpot', pool, last }                  누적 잭팟이 바뀔 때 (모두에게, 1초에 한 번까지)
//
// 칩 흐름: 돌리면 바로 ctx.bet(한 판 베팅). 연출이 끝날 때(릴 + 두근두근 + 프리스핀) ctx.payout(돌려받을 칩 전부).
// 결과는 돌리는 순간 모두 정해진다 (프리스핀 10번 포함). 그사이 나가거나 끊기거나 서버를 꺼도 그 결과대로 바로 정산한다.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MACHINES, MACHINE_IDS, machineOf, checkBet, evaluate, teases, TEASE_MS } from '../../../public/slots/rules.mjs'

export const SPIN_MS = 2300 // 화면의 릴 연출(마지막 릴 정지 약 2.0초)보다 약간 길게
export const FS_MS = { intro: 2200, spin: 1800, outro: 800 } // 프리스핀 연출 (public/slots/app.js와 같게)
const MIN_GAP_MS = 800 // 스핀 간격 최소 (CASINO.md 5장)

const pending = new Map() // 사용자 ID → { timer, round, back, result, jackpot }
const lastStops = new Map() // 사용자 ID → { 머신: 멈춘 자리 } (다시 들어와도 같은 그림)

// ---------- 누적 잭팟 (메가 잭팟 머신) ----------
// 베팅의 contribute만큼 잭팟에, reserve만큼 다음 밑돈에 쌓는다. 가운데 줄 잭팟 셋이면
// 베팅이 fullBet 이상일 때 잭팟 전부, 적으면 베팅 비율만큼 가져가고 나머지는 남는다.
// 다 가져가면 밑돈이 새 잭팟이 된다 (floor보다 적으면 하우스가 floor까지 채움).
// 금액은 DATA_DIR/slots-jackpot.json에 저장 (서버가 다시 켜져도 이어짐). 코어 저장소에 일반 저장 칸이 없어서 따로 둠
const JP = MACHINES.jackpot.jackpot
const DATA = process.env.DATA_DIR || join(import.meta.dirname, '..', '..', '..', 'data')
const JP_FILE = join(DATA, 'slots-jackpot.json')
let jp = { pool: JP.start, reserve: 0, hits: 0, last: null } // last = { name, win, at }
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
}

function finish(p, ctx) {
  const job = pending.get(p.id)
  if (!job) return
  clearTimeout(job.timer)
  pending.delete(p.id)
  ctx.payout(p, job.back, job.round, job.result)
  if (job.jackpot) { jp.last = { name: p.name || '누군가', win: job.jackpot.win, at: Date.now() }; saveJackpot(); announce(ctx, true) }
  else if (job.machine === 'jackpot') saveSoon()
}

// 테스트·시뮬레이션용: 지금 잭팟 상태 (소수점 포함)
export const jackpotState = () => ({ ...jp })

const randStops = (m, ctx) => m.strips.map(st => ctx.rng.int(st.length))
const compactWins = wins => wins.map(w => [w.line, w.kind, w.pay])

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
    const r = evaluate(m, stops, bet.lines, bet.lineBet)
    let back = r.back, delay = SPIN_MS
    const tease = teases(m, stops, bet.lines)
    if (tease) delay += TEASE_MS
    const result = { machine: m.id, stops, lineBet: bet.lineBet, lines: bet.lines, wins: compactWins(r.wins) } // 판 기록 (30일)
    if (r.scatter?.pay) result.scatter = [r.scatter.count, r.scatter.pay]

    // 프리스핀: 열 번을 지금 다 정한다 (다시 걸리지 않음)
    let bonus = null
    if (r.bonus) {
      const { freeSpins, mult } = m.scatter
      const spins = []
      let total = 0
      for (let i = 0; i < freeSpins; i++) {
        const st = randStops(m, ctx)
        const e = evaluate(m, st, bet.lines, bet.lineBet, mult)
        spins.push({ stops: st, wins: e.wins, scatter: e.scatter, back: e.back })
        total += e.back
      }
      bonus = { mult, spins, total }
      back += total
      delay += FS_MS.intro + freeSpins * FS_MS.spin + FS_MS.outro
      result.fs = { total, stops: spins.map(s => s.stops) }
    }

    // 누적 잭팟: 쌓고, 맞으면 가져감
    let jackpot = null
    if (m.jackpot) {
      jp.pool += bet.total * JP.contribute
      jp.reserve += bet.total * JP.reserve
      if (r.jackpot) {
        const share = Math.min(1, bet.total / JP.fullBet)
        const win = Math.floor(jp.pool * share)
        jp.pool -= win
        if (share >= 1) { jp.pool = Math.max(jp.pool + jp.reserve, JP.floor); jp.reserve = 0 }
        jp.hits++
        jackpot = { win, share }
        back += win
        result.jp = win
      }
      announce(ctx)
    }

    const all = lastStops.get(p.id) || {}
    all[m.id] = stops
    lastStops.set(p.id, all)
    const timer = setTimeout(() => finish(p, ctx), delay)
    pending.set(p.id, { timer, round, back, result, jackpot, machine: m.id })
    ctx.send(p, {
      t: 'spun', machine: m.id, round, stops, lineBet: bet.lineBet, lines: bet.lines, total: bet.total,
      wins: r.wins, scatter: r.scatter, back, base: r.back, tease, bonus, jackpot,
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
