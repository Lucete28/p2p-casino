// 파산 지원금 (로비 캐셔): 코인을 모두 잃으면 1,000코인, 하루 10번까지 (운영자 결정 2026-11-17 — 예전 토큰 재지급처럼, 출석 대신)
// 조건은 서버가 확인한다: 코인 잔액 0 (auth에 물음) + 어느 게임에도 칩이 없음 (자리) + 오늘(한국 날짜) 받은 횟수 < 10
// 코인은 /auth의 earn으로 준다. ref = refill:<사용자>:<날짜>:<몇 번째> → 같은 요청이 겹쳐도 한 번만 들어간다
import * as jmtt from './jmtt.mjs'
import { kstDay } from './store.mjs'

export const REFILL = { amount: 1000, perDay: 10 }

export function refillKit(store, titleOf = id => id) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS refills (
    user_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day, n))`)
  const usedToday = user => store.db.prepare('SELECT COUNT(*) c FROM refills WHERE user_id = ? AND day = ?').get(user, kstDay()).c

  // 캐셔 창에 보일 상태
  async function status(user) {
    const left = Math.max(0, REFILL.perDay - usedToday(user))
    const seat = store.openSeatOf(user)
    const coins = await jmtt.balance(user) // auth 오류면 throw → 503
    let why = null
    if (!left) why = 'daily_limit'
    else if (seat) why = 'seated'
    else if (coins > 0) why = 'has_coins'
    return { amount: REFILL.amount, perDay: REFILL.perDay, left, coins, seat: seat ? { id: seat.game, title: titleOf(seat.game) } : null, can: !why, why }
  }

  const busy = new Set() // 한 사람이 동시에 두 번 누르는 것 막기 (같은 ref라 auth도 한 번만 주지만)
  async function claim(user) {
    if (busy.has(user)) return { code: 429, body: { error: 'busy' } }
    busy.add(user)
    try {
      const day = kstDay()
      const n = usedToday(user) + 1
      if (n > REFILL.perDay) return { code: 429, body: { error: 'daily_limit' } }
      const seat = store.openSeatOf(user)
      if (seat) return { code: 409, body: { error: 'seated', seat: { id: seat.game, title: titleOf(seat.game) } } }
      const coins = await jmtt.balance(user)
      if (coins > 0) return { code: 409, body: { error: 'has_coins', coins } }
      const r = await jmtt.coin('earn', user, REFILL.amount, '카지노 파산 지원', `refill:${user}:${day}:${n}`)
      if (r.status === 403) return { code: 503, body: { error: 'not_ready' } } // 메인(auth)에서 카지노 earn 권한이 아직 없음
      if (r.status !== 200) { console.warn('refill earn', r.status, r.error); return { code: 502, body: { error: 'failed' } } }
      store.db.prepare('INSERT OR IGNORE INTO refills (user_id, day, n, amount, at) VALUES (?, ?, ?, ?, ?)').run(user, day, n, REFILL.amount, Date.now())
      return { code: 200, body: { ok: true, amount: REFILL.amount, balance: r.balance, left: REFILL.perDay - n } }
    } finally { busy.delete(user) }
  }

  return { status, claim }
}
