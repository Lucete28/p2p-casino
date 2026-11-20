// JMTT 계정 서비스(/auth)와 이야기하는 부분: 누구인지 확인, 코인 맡기기·돌려주기 (DEV_REFERENCE 2-1, 2-2, LOGIN_GUIDE 5장)
const AUTH = process.env.JMTT_AUTH_URL || 'http://auth:3000'
const KEY = process.env.JMTT_COIN_KEY || ''
// auth가 한 번에 받는 최대 금액. 2026-11-20 메인이 Number.MAX_SAFE_INTEGER로 풀었다 (잔액이 그보다 커지는 요청은 400 too_large)
// 예전에 열린 자리는 seats.chunk(그때 값 100,000)로 복구하므로 바꿔도 괜찮다
export const MAX_AMOUNT = Number.MAX_SAFE_INTEGER

// 브라우저가 보낸 사용자 ID는 믿지 않고, 받은 Cookie로 auth에 물어본다. 같은 쿠키는 30초 동안 캐시
const cache = new Map()
export async function identify(cookie = '') {
  if (!/(?:^|;\s*)jmtt_session=/.test(cookie)) return null
  const hit = cache.get(cookie)
  if (hit && hit.until > Date.now()) return hit.who
  let who = null
  try {
    const r = await fetch(`${AUTH}/auth/internal/me`, { headers: { Cookie: cookie } })
    if (r.ok) { const u = await r.json(); who = { id: u.id, name: u.name, picture: u.picture, ...(u.admin === true ? { admin: true } : {}) } }
  } catch (err) { console.warn('identify', err.message); throw err }
  cache.set(cookie, { who, until: Date.now() + 30000 })
  if (cache.size > 2000) cache.delete(cache.keys().next().value)
  return who
}

async function coinCall(path, init) {
  const r = await fetch(`${AUTH}/auth/internal/coin/${path}`, {
    ...init, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}

export async function balance(user) {
  const { status, body } = await coinCall('balance?user=' + encodeURIComponent(user), { method: 'GET' })
  if (status !== 200) throw new Error('balance ' + status)
  const n = Number(body?.balance)
  return Number.isSafeInteger(n) && n > 0 ? n : 0 // `| 0`은 21억(2^31)을 넘으면 음수가 됨
}

// op: 'stake'(앉을 때 맡기기) | 'cashout'(일어날 때 돌려주기). 같은 ref는 auth가 한 번만 반영한다
export async function coin(op, user, amount, reason, ref) {
  const { status, body } = await coinCall(op, { method: 'POST', body: JSON.stringify({ user, amount, reason, ref }) })
  return { status, ...(body || {}) }
}
