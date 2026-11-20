// 관리 통계 (#통계): 요약 API는 앱 열쇠만, 통계 페이지는 운영자만, 판을 하면 숫자가 오른다
// node test-stats.mjs (서버는 CASINO_ADMINS=u_alice, CASINO_TEST_GAMES=1, JMTT_COIN_KEY=test)
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
const get = (p, h = {}) => fetch(BASE + p, { headers: h, redirect: 'manual' })

let r = await get('/casino/api/jmtt/stats')
check('요약 API: 열쇠 없으면 401', r.status === 401)
r = await get('/casino/api/jmtt/stats', { Authorization: 'Bearer wrong' })
check('요약 API: 틀린 열쇠 401', r.status === 401)
const t0 = Date.now()
r = await get('/casino/api/jmtt/stats', { Authorization: 'Bearer test' })
const s = await r.json()
check('요약 API: 열쇠 맞으면 3초 안에 summary·daily·page', r.status === 200 && Date.now() - t0 < 3000 && Array.isArray(s.summary) && s.summary.length <= 8 && s.daily?.days?.length === 14 && s.page === '/casino/admin/stats', JSON.stringify(s.summary?.map(x => x.label)))
check('요약에 사람 ID·이름 없음', !/u_[a-z]/.test(JSON.stringify(s)))

r = await get('/casino/admin/stats')
check('통계 페이지: 로그인 안 하면 로그인으로', r.status === 302 && /\/auth\/login/.test(r.headers.get('location')))
r = await get('/casino/admin/stats', { Cookie: 'jmtt_session=u_bob', Accept: 'text/html' })
check('통계 페이지: 운영자 아니면 404', r.status === 404)

// 동전 던지기 몇 판 → 페이지에 판 수
const U = 'u_stats_' + Date.now().toString(36)
const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/coinflip/ws', { headers: { Cookie: `jmtt_session=${U}` } })
await new Promise(res => ws.on('open', res))
ws.send(JSON.stringify({ t: 'buyin', amount: 100 })); await sleep(400)
for (let i = 0; i < 5; i++) { ws.send(JSON.stringify({ t: 'flip', bet: 10, side: 'H' })); await sleep(150) }
await sleep(300); ws.close()
r = await get('/casino/admin/stats', { Cookie: 'jmtt_session=u_alice' })
const html = await r.text()
check('통계 페이지: 운영자는 열림 + ← JMTT 관리', r.status === 200 && html.includes('href="/admin"') && html.includes('← JMTT 관리'))
const flips = +((html.match(/동전 던지기[^<]*<\/td><td>([\d,]+)/) || [])[1] || '0').replace(/,/g, '')
check('판 수가 페이지에 (동전 던지기 5판 이상)', flips >= 5, `${flips}판`)

console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
