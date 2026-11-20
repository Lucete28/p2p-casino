// 로컬 테스트용: JMTT /auth 흉내 + 카지노 서버 앞단 프록시 (실제 auth와 같은 규칙: ref 중복 무시, 잔액 0 밑으로 안 감)
// 쓰는 법 (server 폴더에서):
//   node dev/mock-auth.mjs                       ← 3100에서 /auth 흉내, 나머지는 3200 카지노로
//   PORT=3200 JMTT_AUTH_URL=http://127.0.0.1:3100 JMTT_COIN_KEY=test DATA_DIR=../data-dev node index.mjs
//   브라우저: http://127.0.0.1:3100/auth/login?as=alice&next=/casino/   (가짜 사용자 u_alice로 로그인)
// 사이트 이미지에는 들어가지 않는다 (.dockerignore)
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'

const PORT = +process.env.MOCK_PORT || 3100
const CASINO = +process.env.CASINO_PORT || 3200
const ledger = new Map()   // user → balance
const refs = new Map()     // ref → result
const log = []
// JMTT 선물 흉내 (/auth/gift, /auth/presence). 만들기: GET /auth/_gift?amount=500&title=...
const gifts = []           // { id, title, message, amount, claimedBy: Set }
const bal = u => ledger.has(u) ? ledger.get(u) : (ledger.set(u, 1000), 1000)
const cookieUser = req => (req.headers.cookie || '').match(/(?:^|;\s*)jmtt_session=([^;]+)/)?.[1] || null
const json = (res, code, body, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(body)) }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p.startsWith('/auth/')) {
    const u = cookieUser(req)
    if (p === '/auth/login') {
      const id = 'u_' + (url.searchParams.get('as') || 'alice')
      const next = url.searchParams.get('next') || '/casino/'
      if (url.searchParams.get('popup') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `jmtt_session=${id}; Path=/` })
        return res.end(`<script>opener&&opener.postMessage({type:'jmtt:login'},location.origin);setTimeout(()=>close(),200)</script>`)
      }
      res.writeHead(302, { Location: next, 'Set-Cookie': `jmtt_session=${id}; Path=/` }); return res.end()
    }
    if (p === '/auth/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': 'jmtt_session=; Path=/; Max-Age=0' })
    if (p === '/auth/me') return u ? json(res, 200, { id: u, name: u.slice(2), picture: null, coins: bal(u), checkedIn: false })
      : url.searchParams.get('optional') === '1' ? json(res, 200, null) : json(res, 401, { error: 'not_logged_in' })
    if (p === '/auth/coin/attendance' && req.method === 'POST') {
      if (!u) return json(res, 401, { error: 'not_logged_in' })
      ledger.set(u, bal(u) + 100); return json(res, 200, { ok: true, balance: bal(u), gained: 100, already: false })
    }
    if (p === '/auth/internal/me') return u ? json(res, 200, { id: u, sub: 'sub-' + u, name: u.slice(2), picture: null }) : json(res, 401, {})
    if (p === '/auth/_ledger') return json(res, 200, { ledger: Object.fromEntries(ledger), log })
    if (p === '/auth/_gift') { const g = { id: 'g' + (gifts.length + 1), title: url.searchParams.get('title') || '운영자 선물', message: '', amount: +url.searchParams.get('amount') || 500, claimedBy: new Set() }; gifts.push(g); return json(res, 200, { id: g.id }) }
    const giftsFor = who => gifts.filter(g => !g.claimedBy.has(who)).map(({ claimedBy, ...g }) => g)
    if (p === '/auth/presence') return json(res, 200, { gifts: giftsFor(u).map(g => g.id) })
    if (p === '/auth/gift') return json(res, 200, { gifts: giftsFor(u), gift: giftsFor(u)[0] || null, loggedIn: !!u })
    if (p === '/auth/gift/claim' && req.method === 'POST') {
      if (!u) return json(res, 401, { error: 'not_logged_in' })
      let body = ''; req.on('data', c => body += c)
      req.on('end', () => { const g = gifts.find(x => x.id === JSON.parse(body || '{}').id); if (!g || g.claimedBy.has(u)) return json(res, 409, { error: 'claimed' })
        g.claimedBy.add(u); ledger.set(u, bal(u) + g.amount); json(res, 200, { ok: true, amount: g.amount, balance: bal(u) }) })
      return
    }
    if (p.startsWith('/auth/internal/coin/')) {
      if (req.headers.authorization !== 'Bearer test') return json(res, 403, { error: 'forbidden' })
      const op = p.slice('/auth/internal/coin/'.length)
      if (op.startsWith('balance')) return json(res, 200, { balance: bal(url.searchParams.get('user')) })
      // 메인에서 카지노 earn 권한이 아직 없는 상태 흉내: MOCK_NO_EARN=1
      if (op === 'earn' && process.env.MOCK_NO_EARN === '1') return json(res, 403, { error: 'earn_not_allowed' })
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        const b = JSON.parse(body)
        if (refs.has(b.ref)) return json(res, 200, { ...refs.get(b.ref), duplicate: true })
        const delta = op === 'stake' ? -b.amount : b.amount
        const next = bal(b.user) + delta
        if (!Number.isSafeInteger(b.amount) || b.amount <= 0) return json(res, 400, { error: 'bad_amount' })
        if (!Number.isSafeInteger(next)) return json(res, 400, { error: 'too_large', balance: bal(b.user) }) // 실제 auth와 같음 (2026-11-20)
        if (next < 0) return json(res, 409, { error: 'insufficient', balance: bal(b.user) })
        ledger.set(b.user, next)
        const r = { ok: true, balance: next, delta }
        refs.set(b.ref, r)
        log.push({ op, user: b.user, amount: b.amount, ref: b.ref, reason: b.reason })
        json(res, 200, r)
      })
      return
    }
    return json(res, 404, {})
  }
  // 로컬에서 JMTT 배지·구글 G 로고 (실제 사이트에서는 JMTT 메인이 줌)
  // 메인의 접속 신호·선물 팝업: MOCK_JMTT_DIR(home-server의 home 폴더)가 있으면 진짜 파일, 없으면 빈 스크립트
  if (p === '/jmtt-presence.js' || p === '/jmtt-gift.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    try { return res.end(process.env.MOCK_JMTT_DIR ? fs.readFileSync(process.env.MOCK_JMTT_DIR + p) : '') } catch { return res.end('') }
  }
  if (p === '/jmtt-badge.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('window.JMTT={badge:{hide(){},show(){},refresh(){},setPosition(){}}}') }
  // 나머지는 카지노 서버로
  const up = http.request({ host: '127.0.0.1', port: CASINO, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res)
  })
  up.on('error', () => { res.writeHead(502); res.end('casino down') })
  req.pipe(up)
})
// 웹소켓도 그대로 넘김
server.on('upgrade', (req, sock, head) => {
  const up = net.connect(CASINO, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
    up.write(head); sock.pipe(up); up.pipe(sock)
  })
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
})
server.listen(PORT, () => console.log(`mock auth + proxy on ${PORT} → casino ${CASINO}`))
