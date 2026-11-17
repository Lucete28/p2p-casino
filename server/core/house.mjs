// 하우스 게임 '관리 모드' (CASINO.md 3장): 블랙잭·바카라·룰렛·슬롯
// 코어가 플레이어·칩·바이인·캐시아웃·연결 끊김·재시작을 맡고, 게임 모듈은 판 규칙만 짠다.
// 칩은 ctx.bet / ctx.payout / ctx.settle로만 바뀐다. 판마다 저장소에 적어서 서버가 꺼져도 잃지 않는다
import * as rng from './rng.mjs'
import * as jmtt from './jmtt.mjs'

const DISCONNECT_MS = 60000 // 연결이 모두 끊긴 뒤 이만큼 지나면 칩을 코인으로 돌려주고 나감
const isInt = n => Number.isSafeInteger(n)

export function houseKit({ store, wallet, titleOf }) {
  // game = 게임 모듈 (export default 객체). 반환: { attach(ws), summary(), shutdown() }
  return function host(game) {
    const players = new Map() // 사용자 ID → 플레이어

    const sendRaw = (p, s) => { for (const ws of p.sockets) if (ws.readyState === 1) ws.send(s) }
    const send = (p, msg) => sendRaw(p, JSON.stringify(msg))
    const persist = p => { if (p.session) store.seatPlay(p.session, p.chips, p.inPlay) }
    const coinsOf = async user => { try { return await jmtt.balance(user) } catch { return null } }
    const chipsMsg = (p, coins) => ({ t: 'chips', chips: p.chips, inPlay: p.inPlay, ...(coins !== undefined ? { coins } : {}) })
    const toast = (p, msg) => send(p, { t: 'toast', msg })

    // 게임 모듈에 주는 도구
    const ctx = {
      game: game.id,
      send,
      broadcast(list, msg) { const s = JSON.stringify(msg); for (const p of list) sendRaw(p, s) },
      players: () => [...players.values()],
      chips: p => p.chips,
      // 베팅: 칩에서 빼고 '진행 중'으로 적는다. 칩이 모자라거나 금액이 이상하면 false
      bet(p, amount, roundId) {
        if (!p.session || !isInt(amount) || amount < 1 || amount > p.chips) return false
        p.chips -= amount
        p.inPlay += amount
        p.round = roundId ?? p.round
        persist(p)
        send(p, chipsMsg(p))
        return true
      },
      // 판 끝: 받을 칩(원금 포함)을 더하고 '진행 중'을 비운다. 판 기록을 남긴다
      payout(p, amount, roundId, detail) {
        if (!isInt(amount) || amount < 0) throw new Error(`${game.id}: payout은 0 이상 정수여야 해요 (${amount})`)
        const bet = p.inPlay
        p.chips += amount
        p.inPlay = 0
        persist(p)
        try { store.logRound(game.id, p.id, String(roundId ?? p.round ?? ''), bet, amount, detail) } catch (err) { console.warn('round log', err.message) }
        p.round = null
        send(p, chipsMsg(p))
        return true
      },
      // 한 번에 끝나는 판 (슬롯·룰렛): 베팅과 지급을 한 번에
      settle(p, bet, payout, roundId, detail) {
        if (!ctx.bet(p, bet, roundId)) return false
        return ctx.payout(p, payout, roundId, detail)
      },
      rng,
      // 너무 빠른 요청 막기: key마다 ms 안에 다시 오면 false
      limit(p, key, ms) {
        const now = Date.now()
        if (now - (p.limits[key] || 0) < ms) return false
        p.limits[key] = now
        return true
      },
      log: (...a) => console.log(`[${game.id}]`, ...a),
    }

    // ---------- 칩 바꾸기 ----------
    async function buyIn(p, amount) {
      if (!isInt(amount) || amount < (game.buyIn?.min || 1)) return toast(p, `칩은 ${game.buyIn?.min || 1}개 이상 바꿀 수 있어요.`)
      if (p.busy) return
      if (p.inPlay) return toast(p, '판이 끝난 뒤에 칩을 더 바꿀 수 있어요.')
      p.busy = true
      try {
        let total = amount
        // 이미 칩이 있으면: 지금 칩을 정산하고 합친 만큼 다시 맡긴다 (자리 하나 = 맡긴 기록 하나라 복구가 단순)
        if (p.session) {
          const had = p.chips
          wallet.closeSeat(p.session, had, '카지노 정산 · ' + game.title)
          p.session = null; p.chips = 0
          await wallet.flush()
          total += had
        }
        const coins = await coinsOf(p.id)
        if (coins !== null && coins < total) {
          if (total > amount) { // 합치기 실패: 원래 칩만 다시 맡긴다
            const back = await wallet.stakeSeat({ game: game.id, table: game.id, user: p.id, name: p.name, amount: total - amount, reason: '카지노 입장 · ' + game.title })
            if (!back.error) { p.session = back.session; p.chips = back.staked }
          }
          send(p, chipsMsg(p, await coinsOf(p.id)))
          return toast(p, '코인이 모자라요.')
        }
        const st = await wallet.stakeSeat({ game: game.id, table: game.id, user: p.id, name: p.name, amount: total, reason: '카지노 입장 · ' + game.title })
        if (st.error === 'busy') { send(p, chipsMsg(p)); return toast(p, `${titleOf(st.game)}에 앉아 있어요. 그 게임에서 일어난 뒤 칩을 바꿀 수 있어요.`) }
        if (st.error) { send(p, chipsMsg(p, await coinsOf(p.id))); return toast(p, '코인을 칩으로 바꾸지 못했어요. 잠시 뒤 다시 해 주세요.') }
        p.session = st.session
        p.chips = st.staked
        p.inPlay = 0
        send(p, chipsMsg(p, await coinsOf(p.id)))
        game.chipsChanged?.(p, ctx)
      } finally { p.busy = false }
    }

    // 칩 → 코인 (판이 끝난 뒤에만)
    async function cashOut(p, why) {
      if (!p.session) return
      if (p.inPlay) return toast(p, '판이 끝난 뒤에 칩을 코인으로 바꿀 수 있어요.')
      const amount = p.chips
      wallet.closeSeat(p.session, amount, '카지노 정산 · ' + game.title)
      p.session = null; p.chips = 0
      await wallet.flush()
      send(p, { ...chipsMsg(p, await coinsOf(p.id)), cashout: amount, why: why || '' })
    }

    // 나가기 (나가기 버튼·연결 끊김 60초): 게임이 진행 중인 판을 마무리할 기회를 준다 (예: 블랙잭은 스탠드 처리 후 payout).
    // 그래도 판이 남아 있으면 건 칩은 잃는다 — 카드를 보고 나가서 베팅을 돌려받는 꼼수를 막기 위해.
    // (서버 재시작으로 끊긴 판만 무효로 하고 돌려준다: shutdown·wallet.recover)
    function leave(p) {
      clearTimeout(p.dropTimer)
      try { game.leave?.(p, ctx) } catch (err) { console.error(`${game.id} leave`, err) }
      if (p.inPlay) ctx.payout(p, 0, p.round, { forfeit: true })
      if (p.session) { wallet.closeSeat(p.session, p.chips, '카지노 정산 · ' + game.title); p.session = null; p.chips = 0 }
      players.delete(p.id)
    }

    // 이 연결의 플레이어 (나가기 뒤 같은 탭에서 다시 하면 새로 만든다)
    function ensure(ws) {
      const who = ws.who
      let p = players.get(who.id)
      if (!p) {
        p = { id: who.id, name: who.name, picture: who.picture, device: ws.device, sockets: new Set(),
          session: null, chips: 0, inPlay: 0, round: null, limits: {}, busy: false, dropTimer: null }
        players.set(who.id, p)
      }
      clearTimeout(p.dropTimer)
      p.sockets.add(ws)
      return p
    }

    async function attach(ws) {
      const who = ws.who
      ensure(ws)
      ws.on('close', () => {
        const p = players.get(who.id)
        if (!p || !p.sockets.delete(ws) || p.sockets.size) return
        p.dropTimer = setTimeout(() => { if (!p.sockets.size && players.get(p.id) === p) leave(p) }, DISCONNECT_MS)
      })
      ws.on('message', raw => {
        let d
        try { d = JSON.parse(raw) } catch { return }
        if (!d || typeof d.t !== 'string') return
        const p = ensure(ws)
        const run = async () => {
          if (d.t === 'buyin') return buyIn(p, Number(d.amount)) // 정수가 아니면 buyIn이 거절 (반올림하지 않음)
          if (d.t === 'cashout') return cashOut(p)
          if (d.t === 'leave') return leave(p)
          return game.message?.(p, d, ctx)
        }
        Promise.resolve(run()).catch(err => { console.error(`${game.id} ws`, err); toast(p, '서버 오류가 났어요.') })
      })
      const coins = await coinsOf(who.id)
      if (ws.readyState !== 1) return
      const p = ensure(ws)
      ws.send(JSON.stringify({ t: 'me', me: { id: who.id, name: who.name, picture: who.picture }, coins,
        game: { id: game.id, title: game.title, buyIn: game.buyIn || { min: 1 } } }))
      ws.send(JSON.stringify(chipsMsg(p, coins)))
      try { await game.join?.(p, ctx) } catch (err) { console.error(`${game.id} join`, err) }
    }

    return {
      attach,
      summary() {
        try { if (game.summary) return game.summary(ctx) } catch {}
        return { players: [...players.values()].filter(p => p.session).length, tables: 0 }
      },
      // 서버를 끌 때: 진행 중인 판은 무효(건 칩 돌려줌), 칩은 모두 코인으로
      shutdown() {
        try { game.shutdown?.(ctx) } catch (err) { console.error(`${game.id} shutdown`, err) }
        for (const p of players.values()) {
          if (p.session) store.seatClose(p.session, p.chips + p.inPlay, '카지노 정산 · ' + game.title, jmtt.MAX_AMOUNT)
          send(p, { t: 'restart' })
        }
      },
    }
  }
}
