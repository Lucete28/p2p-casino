// 테이블 하나. 서버가 카드를 섞어 나누고 판을 진행한다 (예전에는 방장 브라우저가 하던 일).
// 사람은 앉을 때 가진 코인을 모두 맡기고(stake), 일어날 때 남은 칩을 돌려받는다(cashout). 봇의 칩은 하우스 몫
import { randomBytes, randomInt } from 'node:crypto'
import * as jmtt from '../../core/jmtt.mjs'

const rid = (p, n = 6) => p + randomBytes(n).toString('base64url')
const DISCONNECT_MS = 60000      // 연결이 끊긴 뒤 이만큼 지나면 자리에서 일으켜 정산
const AWAY_STAND_MS = 10 * 60000 // 자리 비움이 이만큼 이어지면 자리에서 일으켜 정산
const AWAY_AFTER = 2             // 시간 초과 자동 행동이 연속 이만큼이면 자리 비움 (탭이 뒤에 있으면 1번)
const EMPTY_CLOSE_MS = 30000     // 사람이 아무도 없으면 이만큼 뒤 방을 닫음
// 게임 중 이모지 (app.js의 EMOJIS와 같게). 정해 둔 것만 보낼 수 있어서 글자 채팅 같은 내용은 오가지 않음
export const EMOJIS = new Set(['🥱', '👍', '😂', '😭', '🔥'])

// 봇이 들고 앉는 칩: 1,000~50,000 사이 100 단위로 무작위 (운영자 결정 2026-11-19, 상한 5만 2026-11-20)
const botBuyIn = () => 1000 + 100 * randomInt(0, 491)

export function roomKit({ Table, CONFIG, botDecision, BOT_NAMES, store, wallet, titleOf = id => id, onClose }) {
  class Room {
    constructor({ code, isPublic = false, autoBots = false, owner = null }) {
      this.code = code
      this.id = rid('t_', 8)               // ref에 쓰는 고유 번호 (서버를 다시 켜도 겹치지 않게)
      this.isPublic = isPublic
      this.autoBots = autoBots
      this.owner = owner                   // 방장 사용자 ID (봇 추가·내보내기 권한)
      this.table = new Table()
      this.members = new Map()             // 사용자 ID → { user, name, seatId, session, sockets:Set, device, hidden, ... }
      this.kicked = new Set()
      this.seq = 0
      this.turnTimer = null; this.timerSeq = -1; this.turnDeadline = 0
      this.nextTimer = null; this.botTimerSeq = -1
      this.handDone = 0                    // 정산을 마친 판 번호
      this.startStack = {}                 // 판 시작 때 각 자리의 칩 (랭킹·기록용)
      this.handLog = null
      this.timeouts = {}
      this.closeTimer = null
      this.waiting = []                    // 봇 대신 앉으려고 판이 끝나길 기다리는 사람
      store.roomOpened(this.id)
    }

    // ---------- 사람 들어오고 나가기 ----------
    seatOf(m) { return m?.seatId ? this.table.seat(m.seatId) : null }
    humans() { return [...this.members.values()] }
    hostSeatId() { return this.members.get(this.owner)?.seatId || null }

    // 연결 하나를 이 방에 붙인다. 이미 있던 사람이면(새로고침·다른 탭) 그 자리 그대로
    attach(ws, who, device) {
      clearTimeout(this.closeTimer)
      let m = this.members.get(who.id)
      if (!m) {
        m = { user: who.id, name: who.nick || who.name, picture: who.picture, seatId: rid('p_', 6), session: null,
          sockets: new Set(), device, hidden: false, disconnectedAt: 0, awaySince: 0, pendingLeave: null, sitting: false }
        this.members.set(who.id, m)
        if (!this.owner || !this.members.has(this.owner)) this.owner = who.id
      }
      m.sockets.add(ws)
      m.device = device
      m.disconnectedAt = 0
      ws.room = this
      this.send(ws, { t: 'joined', code: this.code, seatId: m.seatId, isPublic: this.isPublic })
      this.sendState(ws)
      // 지금 판에 앉아 있으면 내 카드를 다시 보내 줌
      const s = this.seatOf(m)
      if (s && s.inHand && this.table.holes[m.seatId]) this.send(ws, { t: 'hole', handNo: this.table.handNo, cards: this.table.holes[m.seatId] })
      return m
    }

    detach(ws) {
      for (const m of this.members.values()) {
        if (!m.sockets.delete(ws)) continue
        if (m.sockets.size) return
        m.disconnectedAt = Date.now()
        setTimeout(() => {
          if (m.sockets.size || !this.members.has(m.user)) return
          this.leave(m, '연결이 끊겨 자리에서 일어났어요')
        }, DISCONNECT_MS)
        return
      }
    }

    // 가진 코인을 모두 맡기고 앉는다 (운영자 결정: 상한 없이 전부)
    async sit(m) {
      if (m.session || m.sitting) return
      if (this.seatOf(m)) return
      // 한 기기(브라우저)는 한 테이블에 한 자리 (여러 계정으로 몰아주기 막기). 같은 와이파이의 다른 기기는 괜찮음
      const sameDevice = m.device && this.humans().some(o => o !== m && o.session && o.device === m.device)
      if (sameDevice) return this.tell(m, '이 기기에서는 이미 다른 계정이 이 테이블에 앉아 있어요. 한 기기에서는 한 명만 앉을 수 있어요.')
      // 사람으로 꽉 찼으면 구경만. 봇이 있으면 봇 하나를 치우고 앉는다 (봇이 판 중이면 그 판이 끝난 뒤)
      if (this.humanSeats() >= CONFIG.MAX_SEATS) return this.tell(m, '자리가 꽉 찼어요. 구경하다가 자리가 나면 앉을 수 있어요.')
      m.sitting = true
      try {
        let bal
        try { bal = await jmtt.balance(m.user) } catch { return this.tell(m, '코인 서버에 연결하지 못했어요. 잠시 뒤 다시 앉아 주세요.') }
        if (bal <= 0) { this.sendTo(m, { t: 'nocoins' }); return }
        // 코인 맡기기는 공통 칩 지갑이 한다 (한 번에 한 게임: 다른 게임에 앉아 있으면 거절)
        const st = await wallet.stakeSeat({ game: 'holdem', table: this.id, user: m.user, name: m.name, amount: bal })
        if (st.error === 'busy') return this.tell(m, `${titleOf(st.game)}에 앉아 있어요. 그 게임에서 일어난 뒤 앉을 수 있어요.`)
        if (st.error) return this.tell(m, '코인을 맡기지 못했어요. 잠시 뒤 다시 앉아 주세요.')
        const { session, staked } = st
        if (!this.members.has(m.user)) { this.closeSeat(m, session, staked); return } // 맡기는 사이 나감
        m.session = session
        m.staked = staked
        if (this.placeHuman(m)) this.sendTo(m, { t: 'seated', staked })
        else if (this.waiting.includes(m)) this.sendTo(m, { t: 'seated', staked, pending: true })
        else { this.closeSeat(m, session, staked); return this.tell(m, '자리가 꽉 찼어요.') }
        this.after()
      } finally { m.sitting = false }
    }

    // 앉은 사람 수 (봇 빼고, 봇 대신 앉으려고 기다리는 사람 포함)
    humanSeats() { return this.table.seats.filter(p => !p.bot && !p.left).length + this.waiting.length }

    // 맡긴 칩으로 자리에 앉힌다. 빈자리가 없으면 봇을 치우고, 봇이 모두 판 중이면 그 판이 끝날 때 앉힘(대기)
    placeHuman(m) {
      const t = this.table
      if (t.seats.length >= CONFIG.MAX_SEATS) this.removeBot()
      if (t.seats.length < CONFIG.MAX_SEATS) {
        this.waiting = this.waiting.filter(x => x !== m)
        return t.addPlayer(m.seatId, m.name, m.staked)
      }
      if (this.waiting.includes(m)) return false
      const target = t.seats.find(p => p.bot && !p.left && !p.leaveAfterHand)
      // 봇이 없어도 이번 판에 나간 사람 자리가 있으면 판이 끝날 때 앉을 수 있음
      const freeing = t.seats.filter(p => p.left).length > this.waiting.filter(w => !w.botFor).length
      if (!target && !freeing) return false
      if (target) target.leaveAfterHand = true
      m.botFor = target?.id || null
      this.waiting.push(m)
      t.addLog(target ? `${m.name} 님이 이번 판이 끝나면 ${target.name} 대신 앉아요.` : `${m.name} 님이 이번 판이 끝나면 앉아요.`)
      return false
    }

    closeSeat(m, session, amount) {
      const r = wallet.closeSeat(session, amount, '카지노 정산')
      if (m.session === session) m.session = null
      return r
    }

    // 자리에서 일어나 남은 칩을 정산. 올인한 채로 판이 진행 중이면 판이 끝난 뒤에
    standUp(m, why) {
      const s = this.seatOf(m)
      // 봇 대신 앉으려고 기다리던 중이면 맡긴 코인 그대로 돌려줌
      if (!s && m.session && this.waiting.includes(m)) {
        this.waiting = this.waiting.filter(x => x !== m)
        const bot = this.table.seat(m.botFor)
        if (bot) bot.leaveAfterHand = false
        const amount = m.staked
        this.closeSeat(m, m.session, amount)
        this.sendTo(m, { t: 'cashout', amount, why: why || '' })
        return this.after()
      }
      if (!s || !m.session) return
      if (this.table.isBetting() && s.inHand && !s.folded && s.allIn) { m.pendingLeave = why || 'leave'; return 'later' }
      this.table.removePlayer(m.seatId, '자리에서 일어났습니다.') // 판 도중이면 폴드 처리, 건 칩은 팟에 남음
      const amount = s.stack
      const session = m.session
      this.closeSeat(m, session, amount)
      this.sendTo(m, { t: 'cashout', amount, why: why || '' })
      this.after()
    }

    leave(m, why) {
      if (!m) return
      if (this.standUp(m, why) === 'later') { m.leaving = true; return }
      for (const ws of m.sockets) { this.send(ws, { t: 'left', why: why || '' }); ws.room = null }
      m.sockets.clear()
      this.members.delete(m.user)
      if (this.owner === m.user) this.owner = this.humans()[0]?.user || null
      this.after()
      this.maybeClose()
    }

    maybeClose() {
      if (this.members.size) return
      clearTimeout(this.closeTimer)
      this.closeTimer = setTimeout(() => {
        if (this.members.size) return
        clearTimeout(this.turnTimer); clearTimeout(this.nextTimer)
        onClose(this)
      }, EMPTY_CLOSE_MS)
    }

    // 내보내기: 결과를 방장에게 꼭 알려 준다 (말없이 무시되면 눌렀는지 안 됐는지 알 수 없어서)
    kick(by, seatId) {
      const s = this.table.seat(seatId)
      const m = s && !s.bot ? this.humans().find(x => x.seatId === seatId) : null
      console.log(`[holdem ${this.code}] kick by=${by.user} owner=${by.user === this.owner} seat=${seatId} found=${!!s} bot=${!!s?.bot} member=${m?.user || '-'} phase=${this.table.phase}`)
      if (by.user !== this.owner) return this.sendTo(by, { t: 'kickResult', ok: false, msg: '방장만 내보낼 수 있어요.' })
      if (!s || s.left) return this.sendTo(by, { t: 'kickResult', ok: false, msg: '이미 자리에서 나간 사람이에요.' })
      if (s.bot) { this.autoBots = false; this.table.removePlayer(seatId, '자리를 비켜줬어요.'); this.sendTo(by, { t: 'kickResult', ok: true, msg: '' }); return this.after() }
      if (!m) return this.sendTo(by, { t: 'kickResult', ok: false, msg: '그 사람을 찾지 못했어요. 잠시 뒤 다시 해 주세요.' })
      if (m === by) return this.sendTo(by, { t: 'kickResult', ok: false, msg: '나 자신은 내보낼 수 없어요.' })
      const name = s.name
      this.kicked.add(m.user)
      // 판에 남아 있는 사람(폴드 안 함)은 이 판을 끝까지 하고 나감: 방장이 좋은 패를 쥔 사람을 내보내 강제로 폴드시키지 못하게
      if (this.table.isBetting() && s.inHand && !s.folded) {
        if (m.kickPending) return this.sendTo(by, { t: 'kickResult', ok: true, msg: `${name} 님은 이번 판이 끝나면 나가요.` })
        m.kickPending = true
        m.pendingLeave = '방장이 이 방에서 내보냈어요'
        m.leaving = true
        this.table.addLog(`방장이 ${name} 님을 내보내기로 했어요. 이번 판이 끝나면 나가요.`)
        this.tell(m, '방장이 내보내기로 했어요. 이번 판은 끝까지 할 수 있고, 판이 끝나면 남은 칩을 코인으로 돌려받아요.')
        this.sendTo(by, { t: 'kickResult', ok: true, msg: `${name} 님은 판에 남아 있어서 이번 판이 끝나면 나가요.` })
        return this.broadcast()
      }
      this.sendTo(m, { t: 'kicked' })
      this.leave(m, '방장이 이 방에서 내보냈어요')
      this.sendTo(by, { t: 'kickResult', ok: true, msg: `${name} 님을 내보냈어요.` })
    }

    // ---------- 이모지 (앉은 사람만, 정해 둔 것만, 1.2초에 한 번) ----------
    emoji(m, e) {
      if (!EMOJIS.has(e) || !this.seatOf(m)) return
      const now = Date.now()
      if (now - (m.lastEmoji || 0) < 1200) return
      m.lastEmoji = now
      const msg = JSON.stringify({ t: 'emoji', id: m.seatId, e })
      for (const o of this.members.values()) for (const ws of o.sockets) if (ws.readyState === 1) ws.send(msg)
    }

    // ---------- 행동 ----------
    move(m, d) {
      if (d?.type === 'back') return this.comeBack(m)
      const r = this.table.act(m.seatId, d?.type, d?.amount)
      if (!r.ok) return this.tell(m, r.error)
      this.timeouts[m.seatId] = 0
      this.logAction(m.seatId, d.type, d.amount)
      this.after()
    }

    comeBack(m) {
      const s = this.seatOf(m)
      if (!s || !s.sitOut) return
      s.sitOut = false
      m.awaySince = 0
      this.timeouts[m.seatId] = 0
      this.table.addLog(`${s.name} 님이 돌아왔어요.`)
      this.after()
    }

    markAway(s) {
      if (s.bot || s.sitOut) return
      this.timeouts[s.id] = (this.timeouts[s.id] || 0) + 1
      const m = this.humans().find(x => x.seatId === s.id)
      if (this.timeouts[s.id] < (m?.hidden || !m?.sockets.size ? 1 : AWAY_AFTER)) return
      s.sitOut = true
      this.timeouts[s.id] = 0
      if (m) m.awaySince = Date.now()
      this.table.addLog(`${s.name} 님이 자리를 비워 다음 판부터 빠져요.`)
    }

    timeout(id) {
      const s = this.table.seat(id)
      if (!s || this.table.toActId() !== id) return
      this.table.act(id, this.table.currentBet > s.bet ? 'fold' : 'check')
      s.last += ' (시간 초과)'
      if (this.table.lastAction?.id === id) this.table.lastAction.label = s.last
      this.logAction(id, 'timeout')
      this.markAway(s)
      this.after()
    }

    // ---------- 봇 (서버에서 돎, 칩은 하우스 몫) ----------
    addBot() {
      if (this.table.seats.filter(s => !s.left).length >= CONFIG.MAX_SEATS) return false
      const used = new Set(this.table.seats.map(p => p.name))
      const name = BOT_NAMES.find(n => !used.has(n)) || '봇'
      this.table.addPlayer(rid('bot-', 4), name, botBuyIn(), { bot: true })
      return true
    }
    removeBot() {
      const b = [...this.table.seats].reverse().find(p => p.bot && !p.left && !(p.inHand && this.table.isBetting()))
      if (b) this.table.removePlayer(b.id, '자리를 비켜줬어요.')
      return !!b
    }
    // 공개 방: 사람이 3명이 안 되면 봇으로 3자리를 채우고, 사람이 늘면 봇이 비켜줌 (판 사이에만)
    maintainBots() {
      if (!this.autoBots || this.table.isBetting()) return
      const humans = this.humanSeats()
      const want = humans ? Math.max(0, 3 - humans) : 0
      let bots = this.table.seats.filter(p => p.bot && !p.left).length
      while (bots < want && this.addBot()) bots++
      while (bots > want && this.removeBot()) bots--
    }
    botAdd(by) {
      if (by.user !== this.owner) return
      this.autoBots = false
      if (!this.addBot()) this.tell(by, '자리가 꽉 찼어요.')
      this.after()
    }
    runBots() {
      const id = this.table.toActId()
      if (!id || !this.table.seat(id)?.bot || this.botTimerSeq === this.table.turnSeq) return
      const seq = this.botTimerSeq = this.table.turnSeq
      setTimeout(() => {
        if (this.table.turnSeq !== seq || this.table.toActId() !== id) return
        const d = botDecision(this.table, id)
        let r = this.table.act(id, d.type, d.amount)
        if (!r.ok) { const s = this.table.seat(id); r = this.table.act(id, this.table.currentBet > s.bet ? 'call' : 'check') }
        if (!r.ok) this.table.act(id, 'fold')
        this.logAction(id, d.type, d.amount)
        this.after()
      }, 700 + Math.random() * 1100)
    }

    // ---------- 판 진행 ----------
    after() {
      const t = this.table
      if (t.turnSeq !== this.timerSeq) {
        this.timerSeq = t.turnSeq
        clearTimeout(this.turnTimer)
        const id = t.toActId()
        if (id) { this.turnDeadline = Date.now() + CONFIG.TURN_MS; this.turnTimer = setTimeout(() => this.timeout(id), CONFIG.TURN_MS) }
        else this.turnDeadline = 0
      }
      if (t.phase === 'showdown' && this.handDone !== t.handNo) this.endHand()
      if (!t.isBetting()) this.scheduleNext()
      this.runBots()
      this.broadcast()
    }

    scheduleNext() {
      if (this.nextTimer) return
      const delay = this.table.phase === 'showdown' ? CONFIG.NEXT_HAND_MS : 1500
      this.nextTimer = setTimeout(() => { this.nextTimer = null; this.startHand() }, delay)
    }

    startHand() {
      const t = this.table
      for (const p of t.seats) if (p.bot && p.stack <= 0) p.stack = botBuyIn() // 봇은 하우스가 다시 채움
      // 봇 대신 앉기로 한 사람: 판이 끝났으니 그 봇을 치우고 앉힘
      for (const m of [...this.waiting]) {
        const bot = t.seat(m.botFor)
        if (bot) t.removePlayer(bot.id, `${m.name} 님에게 자리를 비켜줬어요.`)
        t.seats = t.seats.filter(p => !p.left)
        if (this.placeHuman(m)) this.sendTo(m, { t: 'seated', staked: m.staked })
      }
      this.maintainBots()
      // 사람이 모두 자리를 비웠거나 없으면 봇끼리 돌리지 않고 기다림
      if (!t.seats.some(p => !p.bot && !p.left && !p.sitOut && p.stack > 0)) return this.broadcast()
      const holes = t.startHand()
      if (!holes) return this.broadcast()
      this.startStack = {}
      for (const s of t.seats) if (s.inHand) this.startStack[s.id] = s.stack + s.total
      this.handLog = { room: this.id, hand: t.handNo, at: Date.now(), dealer: t.dealerId,
        seats: t.seats.filter(s => s.inHand).map(s => ({ id: s.id, name: s.name, bot: !!s.bot, user: this.userOfSeat(s.id), stack: this.startStack[s.id] })),
        holes, actions: [] }
      for (const m of this.members.values()) {
        if (holes[m.seatId]) this.sendTo(m, { t: 'hole', handNo: t.handNo, cards: holes[m.seatId] })
      }
      store.roomHand(this.id, t.seats.filter(s => !s.bot && s.inHand).length)
      this.after()
    }

    userOfSeat(seatId) { return this.humans().find(m => m.seatId === seatId)?.user || null }

    logAction(id, type, amount) {
      if (!this.handLog) return
      const s = this.table.seat(id)
      this.handLog.actions.push({ id, type, amount: amount ?? null, label: s?.last || '', phase: this.table.phase, at: Date.now() })
    }

    // 판이 끝나면: 칩을 저장소에 적고(서버가 꺼져도 이 값으로 정산), 랭킹·기록을 남기고, 일어날 사람을 정산
    endHand() {
      const t = this.table
      this.handDone = t.handNo
      for (const m of this.members.values()) {
        const s = this.seatOf(m)
        if (!s || !m.session) continue
        if (s.id in this.startStack) {
          const delta = s.stack - this.startStack[s.id]
          store.seasonAdd(m.user, m.name, delta, delta > 0)
        }
        store.seatStack(m.session, s.stack)
      }
      if (this.handLog) {
        this.handLog.board = t.board
        this.handLog.result = t.result
        try { store.logHand(this.id, t.handNo, this.handLog) } catch (err) { console.warn('hand log', err.message) }
        this.handLog = null
      }
      for (const m of [...this.members.values()]) {
        const s = this.seatOf(m)
        if (!s || !m.session) continue
        if (m.pendingLeave) { const why = m.pendingLeave; m.pendingLeave = null; if (m.kickPending) this.sendTo(m, { t: 'kicked' }); m.leaving ? this.leave(m, why) : this.standUp(m, why); continue }
        if (s.stack <= 0) { this.standUp(m, '칩을 모두 잃었어요'); continue }
        if (s.sitOut && m.awaySince && Date.now() - m.awaySince > AWAY_STAND_MS) this.standUp(m, '자리를 오래 비워서 일어났어요')
      }
    }

    // 서버를 끌 때: 진행 중인 판은 무효로 하고 건 칩을 돌려준 뒤, 앉은 사람 모두 정산 대기열로
    shutdown() {
      const t = this.table
      if (t.isBetting()) for (const s of t.seats) if (s.inHand) { s.stack += s.total; s.bet = 0; s.total = 0 }
      for (const m of this.members.values()) {
        const s = this.seatOf(m)
        if (m.session) store.seatClose(m.session, s ? s.stack : undefined, '카지노 정산', jmtt.MAX_AMOUNT)
        for (const ws of m.sockets) this.send(ws, { t: 'restart' })
      }
      clearTimeout(this.turnTimer); clearTimeout(this.nextTimer)
    }

    // 자리 비움이 오래된 사람 (판이 멈춰 있을 때도 정리)
    sweep() {
      for (const m of [...this.members.values()]) {
        const s = this.seatOf(m)
        if (s?.sitOut && m.awaySince && Date.now() - m.awaySince > AWAY_STAND_MS && !(this.table.isBetting() && s.inHand)) this.standUp(m, '자리를 오래 비워서 일어났어요')
      }
    }

    // ---------- 보내기 ----------
    publicState() {
      const s = this.table.publicState()
      s.hostId = this.hostSeatId()
      s.running = true
      s.turnLeft = this.turnDeadline ? Math.max(0, this.turnDeadline - Date.now()) : 0
      s.seq = ++this.seq
      s.public = this.isPublic
      s.autoBots = this.autoBots
      s.code = this.code
      s.watching = this.humans().filter(m => !this.seatOf(m)).length
      s.waitingSeats = this.waiting.map(m => m.seatId)
      return s
    }
    broadcast() {
      const s = JSON.stringify({ t: 'state', s: this.publicState() })
      for (const m of this.members.values()) for (const ws of m.sockets) if (ws.readyState === 1) ws.send(s)
    }
    sendState(ws) { this.send(ws, { t: 'state', s: this.publicState() }) }
    send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
    sendTo(m, msg) { for (const ws of m.sockets) this.send(ws, msg) }
    tell(m, msg) { this.sendTo(m, { t: 'toast', msg }) }

    summary() {
      const seats = this.table.seats.filter(s => !s.left)
      const humans = seats.filter(s => !s.bot)
      return { code: this.code, name: this.members.get(this.owner)?.name || '방장', humans: humans.length, bots: seats.length - humans.length,
        seats: seats.length, playing: this.table.isBetting() }
    }
  }
  return { Room }
}
