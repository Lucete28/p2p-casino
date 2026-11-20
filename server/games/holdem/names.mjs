// JMTT 닉네임 (LOGIN_GUIDE 3장): 이름은 저장하지 않고 보여 줄 때 메인에게 지금 이름을 받는다. 이름 신고도 메인으로 넘긴다
const AUTH = process.env.JMTT_AUTH_URL || 'http://auth:3000'
const KEY = process.env.JMTT_COIN_KEY || ''
const TTL = 3 * 60 * 1000 // 몇 분 캐시 (메인 부담 줄이기)
const cache = new Map() // JMTT ID → { name, until }

// ids의 지금 이름 { id: name }. fresh면 캐시를 건너뜀. 메인이 응답하지 않으면 캐시에 있던 이름만
export async function namesOf(ids, { fresh = false } = {}) {
  const now = Date.now(), out = {}, need = []
  for (const id of new Set(ids.filter(Boolean))) {
    const hit = cache.get(id)
    if (hit && (hit.until > now && !fresh)) out[id] = hit.name
    else need.push(id)
  }
  for (let i = 0; i < need.length; i += 500) {
    const chunk = need.slice(i, i + 500)
    try {
      const r = await fetch(`${AUTH}/auth/internal/names`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk }), signal: AbortSignal.timeout(3000),
      })
      if (!r.ok) throw new Error('names ' + r.status)
      const { names = {} } = await r.json()
      for (const id of chunk) if (names[id]) { cache.set(id, { name: names[id], until: now + TTL }); out[id] = names[id] }
    } catch (err) {
      console.warn('names', err.message)
      for (const id of chunk) if (cache.has(id)) out[id] = cache.get(id).name
    }
  }
  if (cache.size > 5000) for (const [k, v] of cache) if (v.until < now) cache.delete(k)
  return out
}

// 이름 신고: 같은 신고자·대상은 메인이 하루 한 번만 센다
export async function reportName(target, reporter, reason = '') {
  const r = await fetch(`${AUTH}/auth/internal/nickname-report`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, reporter, reason: String(reason).slice(0, 100) }), signal: AbortSignal.timeout(5000),
  })
  return r.ok
}
