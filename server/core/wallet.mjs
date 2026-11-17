// 칩 지갑: 코인 ↔ 칩. 모든 게임이 같이 쓴다 (CASINO.md 4장)
// 앉을 때 코인을 맡기고(stake) 자리를 열고, 일어날 때 남은 칩을 돌려준다(cashout). 판마다 /auth를 부르지 않는다.
// 정산은 대기열(pending)에 먼저 적고 보낸다: 실패하면 30초마다 다시, ref가 같아 두 번 들어가지 않음
import { randomBytes } from 'node:crypto'
import * as jmtt from './jmtt.mjs'

export function openWallet(store) {
  // ---------- 정산 대기열 ----------
  let flushing = null, flushAgain = false
  function flush() {
    // 보내는 중에 새 정산이 들어오면 끝난 뒤 바로 한 번 더 돈다 (30초를 기다리지 않게)
    if (flushing) { flushAgain = true; return flushing }
    flushing = (async () => {
      do {
        flushAgain = false
        for (const p of store.pendingAll()) {
          try {
            const r = await jmtt.coin('cashout', p.user_id, p.amount, p.reason, p.ref)
            if (r.status === 200) store.pendingDone(p.ref)
            else { store.pendingTried(p.ref); console.warn('cashout', p.ref, r.status, r.error) }
          } catch (err) { store.pendingTried(p.ref); console.warn('cashout', p.ref, err.message) }
        }
      } while (flushAgain)
    })().finally(() => { flushing = null })
    return flushing
  }
  setInterval(flush, 30000).unref()

  // ---------- 다시 켜졌을 때: 남아 있는 자리를 모두 정산 ----------
  // 맡기는 도중 꺼진 자리는 같은 ref로 다시 맡겨 보며 실제로 맡긴 양을 알아낸다 (이미 반영된 ref는 auth가 그대로 돌려줌)
  // 하우스 게임의 '진행 중인 판에 건 칩'(in_play)은 그 판을 무효로 하고 돌려준다
  async function recover() {
    for (const s of store.openSeats()) {
      let amount = s.stack + (s.in_play || 0)
      if (s.state === 'staking') {
        amount = 0
        for (let i = 0, left = s.intended; left > 0; i++, left -= s.chunk) {
          try {
            const r = await jmtt.coin('stake', s.user_id, Math.min(s.chunk, left), '카지노 입장', `buyin:${s.room}:${s.session}${i ? ':' + i : ''}`)
            if (r.status === 200) amount += Math.min(s.chunk, left)
            else break
          } catch { break }
        }
      }
      store.seatClose(s.session, amount, '카지노 정산 (서버 재시작)', jmtt.MAX_AMOUNT)
      console.log('recovered seat', s.game, s.session, amount)
    }
    return flush()
  }

  // ---------- 자리 열기: 코인을 맡긴다 ----------
  // 반환: { session, staked } · 실패 { error: 'busy', game } (다른 게임에 앉아 있음) | { error: 'stake_failed' }
  // 맡기기 전에 먼저 적어 둔다: 맡기는 도중 꺼지면 recover가 같은 ref로 실제 맡긴 양을 알아낸다
  async function stakeSeat({ game, table, user, name, amount, reason = '카지노 입장' }) {
    const other = store.openSeatOf(user)
    if (other && other.game !== game) return { error: 'busy', game: other.game }
    const session = 's_' + randomBytes(9).toString('base64url')
    store.seatOpen(session, table, user, name, amount, jmtt.MAX_AMOUNT, game)
    let staked = 0
    for (let i = 0, left = amount; left > 0; i++, left -= jmtt.MAX_AMOUNT) {
      const part = Math.min(jmtt.MAX_AMOUNT, left)
      let r
      try { r = await jmtt.coin('stake', user, part, reason, `buyin:${table}:${session}${i ? ':' + i : ''}`) } catch { r = { status: 0 } }
      if (r.status !== 200) break
      staked += part
    }
    store.seatStaked(session, staked)
    if (!staked) { store.seatClose(session, 0, '카지노 정산', jmtt.MAX_AMOUNT); return { error: 'stake_failed' } }
    return { session, staked }
  }

  // 자리를 닫고 남은 칩을 정산 대기열로 → 바로 보내기
  function closeSeat(session, amount, reason = '카지노 정산') {
    const r = store.seatClose(session, amount, reason, jmtt.MAX_AMOUNT)
    flush()
    return r
  }

  return { flush, recover, stakeSeat, closeSeat }
}
