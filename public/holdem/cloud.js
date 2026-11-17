// JMTT 계정(로그인·코인)과 카지노 서버 API. Firebase는 v1.8.0부터 쓰지 않는다 (판 진행·코인 정산·랭킹·통계는 카지노 서버가 함)

export const dayKey = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10) // 한국 날짜
export const seasonKey = (t = Date.now()) => dayKey(t).slice(0, 8) + '01'                      // 월간 시즌 = 그 달 1일
export function prevSeasonKey(key = seasonKey()) {
  const d = new Date(key + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 10)
}

// 로그인 상태: { state: 'in'|'out'|'down', me: { id, name, picture } | null, coins }
export async function me() {
  try {
    const r = await fetch('/auth/me?optional=1', { credentials: 'same-origin', cache: 'no-store' })
    if (!r.ok) return { state: 'down', me: null }
    const u = await r.json()
    return u ? { state: 'in', me: { id: u.id, name: u.name, picture: u.picture }, coins: u.coins ?? null } : { state: 'out', me: null }
  } catch { return { state: 'down', me: null } }
}

// 로비처럼 페이지를 떠나도 되는 곳: JMTT 로그인 화면으로 갔다가 이 화면으로 돌아옴 (초대 코드 #ABCDE도 그대로)
export function loginRedirect() {
  location.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)
}
// 방 안이나 초대 링크처럼 페이지를 떠나면 안 되는 곳: 작은 창으로 로그인
export function loginPopup() {
  return new Promise((resolve, reject) => {
    const w = window.open('/auth/login?popup=1', 'jmtt-login', 'width=480,height=640')
    if (!w) return reject(new Error('popup_blocked'))
    const done = e => {
      if (e.origin !== location.origin || e.data?.type !== 'jmtt:login') return
      removeEventListener('message', done)
      clearInterval(closed)
      resolve(true)
    }
    addEventListener('message', done)
    const closed = setInterval(() => { if (w.closed) { clearInterval(closed); setTimeout(() => { removeEventListener('message', done); resolve(false) }, 500) } }, 500)
  })
}
// 로그아웃은 JMTT 전체에 적용
export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
  location.reload()
}

// ---------- 카지노 서버 API ----------
async function api(path) {
  const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(body.error || 'http_' + r.status); e.status = r.status; e.body = body; throw e }
  return body
}
// 월간 랭킹 (코인 순이익): { season, rows: [{ name, net, hands, me }], me: { rank, net, hands } | null, total }
export const loadSeason = (month = seasonKey(), n = 10) => api(`api/season?month=${month}&n=${n}`)
// 관리자 통계 (CASINO_ADMINS에 있는 JMTT 사용자만)
export const loadStats = () => api('api/stats')
