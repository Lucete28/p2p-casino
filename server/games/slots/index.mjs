// 슬롯머신 (관리 모드, CASINO.md 3·5장): 슬롯 네 대 + 크래시 · 코인 푸셔 + 모두의 잭팟. 규칙은 public/slots/rules.mjs (화면과 같이 씀)
//
//   브라우저 → { t: 'spin', machine, lineBet, lines }    machine = classic·diamond·fruit5·lucky·crash·pusher
//              { t: 'crashOut' }                         크래시: 지금 배수로 내리기 (서버 시간 기준)
//              { t: 'spin', machine: 'crash', …, auto }  auto = 이 배수가 되면 서버가 알아서 내림 (선택)
//              { t: 'spin', machine: 'pusher', lineBet, lines: 1, dropX }  코인 푸셔: 떨어뜨리는 자리
//              { t: 'pusherBoard', bet }                코인 푸셔 판 (베팅=코인 값마다 따로)
//              { t: 'skip' }                             긴 연출(프리스핀·연쇄) 건너뛰기 → 정해진 결과로 바로 정산
//   서버 → { t: 'spun', machine, round, stops, lineBet, lines, total, wins, scatter, mreel, steps, back, base, tease, bonus, jackpot }
//            back = 이번 판에 돌려받을 칩 전부 (프리스핀·연쇄·잭팟 포함), base = 첫 화면의 당첨
//            steps = 과일 폭탄 연쇄 (떨어진 새 과일 포함), bonus = 럭키 스타 프리스핀 { spins, total, mult }
//            jackpot = { win, kind: 'mystery' }
//          { t: 'hello', stops: { 머신: 멈춘 자리 }, spinning, jackpot }   접속할 때
//          { t: 'crashStart', round, total, auto, grow }  크래시 시작 (터질 배수는 안 보냄)
//          { t: 'crashCashed', round, mult, win } · { t: 'crashed', round, at }   내렸을 때 · 터졌을 때 (내린 뒤에도 터진 배수를 알려 줌)
//          { t: 'jackpot', pool, last }                  모두의 잭팟이 바뀔 때 (모두에게, 1초에 한 번까지 · 누가 맞히면 바로)
//
// 칩 흐름: 돌리면 바로 ctx.bet(한 판 베팅). 연출이 끝날 즈음 ctx.payout(돌려받을 칩 전부). 화면은 연출이 끝날 때까지
// 늘어난 칩 숫자를 보여 주지 않으므로 결과가 미리 보이지 않는다.
// 결과는 돌리는 순간 모두 정해진다 (프리스핀·연쇄의 새 과일·잭팟 포함). 그사이 나가거나 끊기거나 서버를 꺼도 그 결과대로 바로 정산.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MACHINE_IDS, JACKPOT, machineOf, checkBet, evaluate, freeSpins, teases, TEASE_MS, CRASH_U, crashPoint, crashMultAt, crashTimeFor } from '../../../public/slots/rules.mjs'
import { PB, seedBoard, drop as pushDrop, dropX as cleanDropX, boardHash } from '../../../public/slots/pusher.mjs'

export const SPIN_MS = 2300 // 화면의 릴 연출(마지막 릴 정지 약 2.0초)보다 약간 길게
export const FS_MS = { intro: 2200, spin: 1800, outro: 800 } // 프리스핀 연출 (public/slots/app.js와 같게)
export const CASCADE_MS = 1100 // 과일 폭탄 연쇄 한 번
export const PUSH_MS = Math.round(PB.STEPS / 60 * 1000) + 300 // 코인 푸셔 한 번 (물리 STEPS칸 = 2.5초)
const MIN_GAP_MS = 800 // 스핀 간격 최소 (CASINO.md 5장)
// 로컬에서 미스터리 잭팟 연출을 보려고 확률만 바꿀 때 (사이트에는 이 환경 변수가 없음)
const JP_ODDS = Number(process.env.SLOTS_JP_ODDS) || JACKPOT.odds

const pending = new Map() // 사용자 ID → { timer, round, back, result, jackpot }
const lastStops = new Map() // 사용자 ID → { 머신: 멈춘 자리 } (다시 들어와도 같은 그림)
// 코인 푸셔 판: 사용자 ID → Map(코인 값 → 코인들). 서버가 켜져 있는 동안 이어진다 (다시 켜지면 처음 판)
const boards = new Map(), seeds = new Map()
function boardOf(uid, bet) {
  let my = boards.get(uid)
  if (!my) boards.set(uid, my = new Map())
  if (!my.has(bet)) { if (!seeds.has(1)) seeds.set(1, seedBoard(1)); my.set(bet, seeds.get(1).map(c => ({ ...c }))) } // 처음 판은 한 번만 만들어 두고 (1초쯤 걸림) 코인 값마다 복사
  return my
}
const boardMsg = (uid, bet) => ({ t: 'pusherBoard', bet, coins: boardOf(uid, bet).get(bet).map(c => [c.x, c.y, c.z]) })

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
  if (job.crash) return crashOut(p, ctx, 'leave') // 크래시: 나가기·종료면 지금 배수로 내림 (안 터졌으면)
  clearTimeout(job.timer)
  pending.delete(p.id)
  ctx.payout(p, job.back, job.round, job.result)
  if (job.jackpot) finishJackpot(p, ctx, job.jackpot, job.machine)
  else saveSoon()
}

// ---------- 크래시 ----------
// 시작할 때 터질 배수(c)와 시각을 정한다. 내리기는 서버 시각으로 배수를 계산 (브라우저가 보낸 값은 안 씀).
// 터지는 시각이 되면 건 칩을 잃고(payout 0) 터진 배수를 알려 준다. auto가 있으면 그 배수에 서버가 내림.
function crashOut(p, ctx, why) {
  const job = pending.get(p.id)
  if (!job?.crash) return
  const k = job.crash, elapsed = Date.now() - k.t0
  const mult = k.autoAt !== null && elapsed >= k.autoAt ? k.auto : crashMultAt(k.m, elapsed)
  if (elapsed >= k.tc || mult >= k.c) { if (why === 'leave' || why === 'shutdown') crashBoom(p, ctx); return } // 이미 터짐
  clearTimeout(job.timer); clearTimeout(k.autoT)
  pending.delete(p.id)
  const win = Math.floor(k.total * mult)
  ctx.payout(p, win + (k.jackpot?.win || 0), job.round, { ...job.result, out: mult, why })
  if (k.jackpot) finishJackpot(p, ctx, k.jackpot, 'crash')
  ctx.send(p, { t: 'crashCashed', round: job.round, mult, win })
  // 내린 뒤에도 로켓은 날다가 터진다: 터진 배수를 나중에 알려 줌 (그 판은 이미 끝)
  const left = k.tc - elapsed
  if (why !== 'shutdown') setTimeout(() => ctx.send(p, { t: 'crashed', round: job.round, at: k.c, after: true }), Math.min(left, 60000)).unref?.()
  saveSoon()
}
function crashBoom(p, ctx) {
  const job = pending.get(p.id)
  if (!job?.crash) return
  clearTimeout(job.crash.autoT)
  pending.delete(p.id)
  ctx.payout(p, job.crash.jackpot?.win || 0, job.round, { ...job.result, out: null })
  if (job.crash.jackpot) finishJackpot(p, ctx, job.crash.jackpot, 'crash')
  ctx.send(p, { t: 'crashed', round: job.round, at: job.crash.c })
  saveSoon()
}
function finishJackpot(p, ctx, j, machine) {
  jp.last = { name: p.name || '누군가', win: j.win, machine, at: Date.now() }
  saveJackpot(); announce(ctx, true)
}

// 모두의 잭팟: 베팅의 2%를 쌓고, 베팅 ÷ odds 확률로 전부 (미스터리). 터지면 { win, kind }
function rollJackpot(ctx, total) {
  jp.pool += total * JACKPOT.contribute
  jp.reserve += total * JACKPOT.reserve
  let jackpot = null
  if (ctx.rng.int(JP_ODDS) < total) {
    const win = Math.floor(jp.pool)
    jp.pool = Math.max(jp.pool - win + jp.reserve, JACKPOT.floor)
    jp.reserve = 0
    jp.hits++
    jackpot = { win, kind: 'mystery' }
  }
  announce(ctx)
  return jackpot
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
    if (d.t === 'crashOut') return crashOut(p, ctx, 'click')
    if (d.t === 'pusherBoard') { const b = Number(d.bet); if (Number.isSafeInteger(b) && b >= 1) ctx.send(p, boardMsg(p.id, b)); return }
    if (d.t === 'skip') { if (!pending.get(p.id)?.crash) finish(p, ctx); return } // 정해진 결과로 바로 정산 (연출만 건너뜀). 크래시는 건너뛰기 없음
    if (d.t !== 'spin') return
    if (pending.has(p.id) || p.inPlay) return ctx.send(p, { t: 'toast', msg: '릴이 아직 돌고 있어요.' })
    if (!ctx.limit(p, 'spin', MIN_GAP_MS)) return
    if (d.machine !== undefined && !MACHINE_IDS.includes(d.machine)) return ctx.send(p, { t: 'toast', msg: '없는 머신이에요.' })
    const m = machineOf(d.machine)
    const bet = checkBet(m, d.lineBet, d.lines)
    if (bet.error) return ctx.send(p, { t: 'toast', msg: bet.error })
    const round = 's_' + Date.now().toString(36) + ctx.rng.int(1e6).toString(36)
    if (!ctx.bet(p, bet.total, round)) return ctx.send(p, { t: 'toast', msg: p.chips ? '칩이 모자라요.' : '먼저 칩을 바꿔 주세요.' })

    // 모두의 잭팟은 어느 머신이든 같은 규칙 (쌓고, 베팅 비례 확률로 미스터리)
    const jackpot = rollJackpot(ctx, bet.total)

    if (m.type === 'crash') {
      const c = crashPoint(m, ctx.rng.int(CRASH_U)), tc = crashTimeFor(m, c)
      const auto = Number(d.auto) >= 1.01 ? Math.floor(Number(d.auto) * 100) / 100 : null
      const k = { m, c, tc, t0: Date.now(), total: bet.total, auto, autoAt: auto ? crashTimeFor(m, auto) : null, jackpot }
      const job = { crash: k, round, result: { machine: m.id, total: bet.total, c, auto, ...(jackpot ? { jp: jackpot.win } : {}) } }
      job.timer = setTimeout(() => crashBoom(p, ctx), tc)
      if (auto && auto < c) k.autoT = setTimeout(() => crashOut(p, ctx, 'auto'), k.autoAt)
      pending.set(p.id, job)
      return ctx.send(p, { t: 'crashStart', machine: m.id, round, total: bet.total, auto, grow: m.grow, jackpot })
    }

    if (m.type === 'pusher') {
      // 진짜 물리: 이 사람의 이 코인 값 판에 코인을 떨어뜨려 앞으로 떨어진 수만큼
      const x = cleanDropX(d.dropX) ?? PB.W / 2
      const my = boardOf(p.id, bet.total), before = my.get(bet.total)
      const r = pushDrop(before, x)
      my.set(bet.total, r.board)
      const coins = r.fell
      const back = coins * bet.total + (jackpot?.win || 0)
      const result = { machine: m.id, total: bet.total, x, coins, left: r.board.length, ...(jackpot ? { jp: jackpot.win } : {}) }
      const timer = setTimeout(() => finish(p, ctx), PUSH_MS + (jackpot ? 2500 : 0))
      pending.set(p.id, { timer, round, back, result, jackpot, machine: m.id })
      return ctx.send(p, { t: 'spun', machine: m.id, round, total: bet.total, lineBet: bet.lineBet, lines: 1, dropX: x, coins, hash: boardHash(r.board), base: coins * bet.total, back, jackpot, wins: [] })
    }

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

    if (jackpot) { back += jackpot.win; result.jp = [jackpot.kind, jackpot.win]; delay += 2500 }

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
    for (const p of ctx.players()) { if (pending.get(p.id)?.crash) crashOut(p, ctx, 'shutdown'); else finish(p, ctx) }
    saveJackpot()
  },
}
