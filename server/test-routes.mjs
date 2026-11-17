// 주소·옛 주소·정적 파일 막기·로비 API (node test-routes.mjs, mock auth + 카지노 서버 — dev/mock-auth.mjs 참고)
// 서버는 CASINO_ADMINS=u_alice, CASINO_TEST_GAMES=1 로 띄운다
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
const get = (path, user) => fetch(BASE + path, { redirect: 'manual', headers: user ? { Cookie: `jmtt_session=${user}` } : {} })
const wsOpen = (path, user) => new Promise(res => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + path, { headers: user ? { Cookie: `jmtt_session=${user}` } : {} })
  ws.on('open', () => { ws.close(); res('open') })
  ws.on('unexpected-response', (_, r) => res('http ' + r.statusCode))
  ws.on('error', e => res('error ' + e.message))
})

// 로비
let r = await get('/casino/')
const lobbyHtml = await r.text()
check('로비 /casino/', r.status === 200 && /카지노/.test(lobbyHtml) && /lobby\.js/.test(lobbyHtml))
check('처음 온 기기에 기기 쿠키', /casino_device=.*Path=\/casino/.test(r.headers.get('set-cookie') || ''))
r = await get('/casino'); check('/casino → /casino/', r.status === 301 && r.headers.get('location') === '/casino/')

// 홀덤 새 주소
r = await get('/casino/holdem/'); const hd = await r.text()
check('홀덤 /casino/holdem/', r.status === 200 && /app\.js/.test(hd) && /canonical" href="https:\/\/justmadethisthat\.com\/casino\/holdem\/"/.test(hd))
r = await get('/casino/holdem'); check('/casino/holdem → 끝에 /', r.status === 301 && r.headers.get('location') === '/casino/holdem/')
r = await get('/casino/holdem/poker.js'); check('홀덤 파일', r.status === 200 && /javascript/.test(r.headers.get('content-type')))
r = await get('/casino/holdem/api/rooms'); check('홀덤 API 새 주소', r.status === 200 && Array.isArray((await r.json()).rooms))

// 옛 주소
r = await get('/casino/api/rooms'); check('옛 API /casino/api/rooms', r.status === 200 && Array.isArray((await r.json()).rooms))
r = await get('/casino/stats.html'); check('옛 통계 → /casino/holdem/stats.html', r.status === 301 && r.headers.get('location') === '/casino/holdem/stats.html')
check('옛 웹소켓 /casino/ws (로그인)', await wsOpen('/casino/ws', 'u_alice') === 'open')
check('새 웹소켓 /casino/holdem/ws (로그인)', await wsOpen('/casino/holdem/ws', 'u_alice') === 'open')
check('웹소켓 로그인 없으면 401', await wsOpen('/casino/holdem/ws', null) === 'http 401')

// 준비 중(wip) 게임: 관리자만
r = await get('/casino/roulette/'); check('wip 게임 주소: 일반 사용자 404', r.status === 404)
r = await get('/casino/roulette/', 'u_bob'); check('wip 게임 주소: 로그인해도 관리자 아니면 404', r.status === 404)
r = await get('/casino/roulette/', 'u_alice'); check('wip 게임 주소: 관리자는 통과 (화면이 아직 없어 404면 정상)', r.status === 404 || r.status === 200, String(r.status))

// 내보내면 안 되는 파일
for (const p of ['/casino/../server/index.mjs', '/casino/%2e%2e/server/index.mjs', '/casino/holdem/package.json', '/casino/README.md', '/casino/.env', '/casino/holdem/.hidden.js', '/casino/test-house.mjs', '/casino/holdem/x.exe']) {
  r = await get(p); check('막힘 ' + p, r.status === 404, String(r.status))
}

// 로비 API
r = await get('/casino/api/lobby'); let j = await r.json()
const byId = Object.fromEntries(j.games.map(g => [g.id, g]))
check('로비 API: 게임 목록', ['holdem', 'blackjack', 'baccarat', 'roulette', 'slots'].every(id => byId[id]), j.games.map(g => `${g.id}:${g.status}`).join(' '))
check('로비 API: 홀덤 live·열림, 룰렛 wip·닫힘', byId.holdem.status === 'live' && byId.holdem.open && byId.roulette.status === 'wip' && !byId.roulette.open)
check('로비 API: 홀덤 인원 숫자', typeof byId.holdem.players === 'number' && typeof byId.holdem.tables === 'number')
r = await get('/casino/api/lobby', 'u_alice'); j = await r.json()
check('로비 API: 관리자는 wip도 열림', j.games.find(g => g.id === 'roulette').open === true)
r = await get('/casino/healthz'); check('healthz', r.status === 200 && (await r.json()).ok)

console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
