// 카지노 서버: 정적 파일 + /casino/ws 웹소켓 + /casino/api/*. 판 진행·카드·봇·코인 정산을 서버가 한다 (DEV_REFERENCE 2-2 카지노)
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { openStore, monthKey } from './store.mjs'
import * as jmtt from './jmtt.mjs'
import { roomKit } from './room.mjs'

const PORT = +process.env.PORT || 3000
const PUBLIC = resolve(process.env.PUBLIC_DIR || join(import.meta.dirname, '..'))
const DATA = process.env.DATA_DIR || join(import.meta.dirname, '..', 'data')
const ADMINS = new Set((process.env.CASINO_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean)) // 관리자 통계를 볼 JMTT 사용자 ID
const BASE = '/casino'

const { Table, CONFIG } = await import(pathToFileURL(join(PUBLIC, 'poker.js')).href)
const { botDecision, BOT_NAMES } = await import(pathToFileURL(join(PUBLIC, 'bot.js')).href)
await import('node:fs').then(fs => fs.mkdirSync(DATA, { recursive: true }))
const store = openStore(join(DATA, 'casino.db'))

// ---------- 정산 대기열: auth에 cashout을 보낸다 (실패하면 30초마다 다시, ref가 같아 두 번 들어가지 않음) ----------
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
for (const s of store.openSeats()) {
  let amount = s.stack
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
  console.log('recovered seat', s.session, amount)
}
flush()

// ---------- 방 ----------
const rooms = new Map() // 방 코드 → Room
const { Room } = roomKit({ Table, CONFIG, botDecision, BOT_NAMES, store, flush, onClose: r => rooms.delete(r.code) })
const newCode = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  for (;;) {
    let c = ''
    for (let i = 0; i < 5; i++) c += chars[randomBytes(1)[0] % chars.length]
    if (!rooms.has(c)) return c
  }
}
setInterval(() => { for (const r of rooms.values()) r.sweep() }, 30000).unref()
setInterval(() => store.pruneHands(), 6 * 3600e3).unref()

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' }
const PUBLIC_FILES = new Set(['index.html', 'stats.html', 'style.css', 'app.js', 'poker.js', 'odds.js', 'bot.js', 'net.js', 'cloud.js', 'stats.js', 'og-image.png'])

function send(res, code, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body)
  res.writeHead(code, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(json ? JSON.stringify(body) : body)
}

// 기기 표시: 브라우저마다 무작위 번호를 쿠키로 하나 준다 (한 기기에서 여러 계정으로 같은 테이블에 앉지 못하게, 운영자 결정 2026-11-17)
const DEVICE_COOKIE = 'casino_device'
const deviceOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)casino_device=([A-Za-z0-9_-]{16,40})/)?.[1] || null
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '')
const deviceCookie = (id, req) => `${DEVICE_COOKIE}=${id}; Path=${BASE}; Max-Age=${2 * 365 * 86400}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`

async function api(req, res, path) {
  let who = null
  try { who = await jmtt.identify(req.headers.cookie) } catch { return send(res, 503, { error: 'auth_unavailable' }) }
  if (path === '/api/rooms') {
    return send(res, 200, { rooms: [...rooms.values()].filter(r => r.isPublic && r.members.size).map(r => r.summary()) })
  }
  if (path === '/api/season') {
    const url = new URL(req.url, 'http://x')
    const month = /^\d{4}-\d{2}-01$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : monthKey()
    const n = Math.min(20, +url.searchParams.get('n') || 10)
    const r = store.season(month, n, who?.id)
    return send(res, 200, { ...r, rows: r.rows.map(x => ({ name: x.name, net: x.net, hands: x.hands, me: x.user_id === who?.id })) })
  }
  if (path === '/api/stats') {
    if (!who) return send(res, 401, { error: 'not_logged_in' })
    if (!ADMINS.has(who.id)) return send(res, 403, { error: 'not_admin', id: who.id })
    const st = store.stats(14)
    const season = store.season(monthKey(), 10, null)
    return send(res, 200, { ...st, season: { ...season, rows: season.rows.map(x => ({ name: x.name, net: x.net, hands: x.hands })) },
      live: { rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.members.size, 0) } })
  }
  return send(res, 404, { error: 'not_found' })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let path = url.pathname
  if (path === '/' ) return send(res, 302, '', { Location: BASE + '/' })
  if (path === BASE) return send(res, 301, '', { Location: BASE + '/' })
  if (!path.startsWith(BASE + '/')) return send(res, 404, 'not found')
  path = path.slice(BASE.length)
  if (path.startsWith('/api/')) return api(req, res, path).catch(err => { console.error(err); send(res, 500, { error: 'server_error' }) })
  if (path === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size })
  const name = path === '/' ? 'index.html' : path.slice(1)
  if (!PUBLIC_FILES.has(name)) return send(res, 404, 'not found') // 개발용 파일·보고.md 등은 내보내지 않음
  const file = resolve(PUBLIC, name)
  if (!file.startsWith(PUBLIC + sep)) return send(res, 404, 'not found')
  try {
    await stat(file)
    const body = await readFile(file)
    const extra = name === 'index.html' && !deviceOf(req) ? { 'Set-Cookie': deviceCookie(randomBytes(16).toString('base64url'), req) } : {}
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra })
    res.end(body)
  } catch { send(res, 404, 'not found') }
})

// ---------- 웹소켓 ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
wss.on('headers', (headers, req) => { if (req.newDevice) headers.push('Set-Cookie: ' + deviceCookie(req.device, req)) })
server.on('upgrade', async (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== BASE + '/ws') return socket.destroy()
  let who = null
  try { who = await jmtt.identify(req.headers.cookie) } catch {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return
  }
  // 로그인한 사람만 (브라우저가 보낸 ID는 쓰지 않음)
  if (!who) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
  // 기기 쿠키가 없으면(처음 온 기기) 이 연결 응답에서 하나 준다
  req.device = deviceOf(req) || randomBytes(16).toString('base64url')
  req.newDevice = !deviceOf(req)
  wss.handleUpgrade(req, socket, head, ws => {
    ws.who = who
    ws.device = req.device
    ws.room = null
    try { store.visit(who.id, who.name) } catch (err) { console.warn('visit', err.message) }
    onConnect(ws)
  })
})

function out(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }

async function onConnect(ws) {
  // 메시지 받는 곳을 먼저 붙인다 (잔액을 묻는 사이 온 메시지를 놓치지 않게)
  ws.on('message', raw => {
    let d
    try { d = JSON.parse(raw) } catch { return }
    handle(ws, d).catch(err => { console.error('ws', err); out(ws, { t: 'toast', msg: '서버 오류가 났어요.' }) })
  })
  ws.on('close', () => ws.room?.detach(ws))
  // 연결이 살아 있는지 30초마다 확인
  ws.alive = true
  ws.on('pong', () => { ws.alive = true })
  let coins = null
  try { coins = await jmtt.balance(ws.who.id) } catch {}
  out(ws, { t: 'me', me: { id: ws.who.id, name: ws.who.name, picture: ws.who.picture }, coins })
}
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue }
    ws.alive = false
    ws.ping()
  }
}, 30000).unref()

const cleanName = (n, fallback) => String(n || '').trim().slice(0, 12) || String(fallback || '손님').slice(0, 12)

function enterRoom(ws, room, nick) {
  if (ws.room && ws.room !== room) { const old = ws.room; const m = old.members.get(ws.who.id); old.detach(ws); if (m && !m.sockets.size) old.leave(m) }
  if (room.kicked.has(ws.who.id)) return out(ws, { t: 'toast', msg: '이 방에서는 내보내졌어요.' })
  const m = room.attach(ws, { ...ws.who, nick: cleanName(nick, ws.who.name) }, ws.device)
  return room.sit(m)
}

async function handle(ws, d) {
  const room = ws.room
  const m = room?.members.get(ws.who.id)
  switch (d.t) {
    case 'create': { // 친구 방: 방 코드로 들어옴 (운영자 결정: 친구 방도 코인)
      const r = new Room({ code: newCode(), isPublic: !!d.public, autoBots: !!d.public, owner: ws.who.id })
      rooms.set(r.code, r)
      return enterRoom(ws, r, d.name)
    }
    case 'join': {
      const r = rooms.get(String(d.code || '').toUpperCase())
      if (!r) return out(ws, { t: 'nojoin', msg: '그 방을 찾지 못했어요. 이미 닫혔을 수 있어요.' })
      return enterRoom(ws, r, d.name)
    }
    case 'quick': { // 빈자리 있는 공개 방에 자동 배정, 없으면 봇과 새 공개 방
      const open = [...rooms.values()].filter(r => r.isPublic && !r.kicked.has(ws.who.id)
        && r.humanSeats() < CONFIG.MAX_SEATS
        && ![...r.members.values()].some(o => o.user !== ws.who.id && o.session && o.device === ws.device))
      open.sort((a, b) => b.summary().humans - a.summary().humans)
      let r = open[0]
      if (!r) { r = new Room({ code: newCode(), isPublic: true, autoBots: true, owner: ws.who.id }); rooms.set(r.code, r) }
      return enterRoom(ws, r, d.name)
    }
    case 'sit': return m && room.sit(m)
    case 'stand': return m && room.standUp(m, '자리에서 일어났어요')
    case 'leave': if (m) room.leave(m, ''); else out(ws, { t: 'left', why: '' }); ws.room = null; return
    case 'move': return m && room.move(m, d)
    case 'bot': return m && room.botAdd(m)
    case 'kick': return m && room.kick(m, String(d.id || ''))
    case 'hidden': if (m) m.hidden = !!d.v; return
    case 'emoji': return m && room.emoji(m, String(d.e || ''))
    case 'name': if (m && !room.seatOf(m)) m.name = cleanName(d.name, m.name); return
  }
}

// ---------- 끌 때: 판 무효 → 정산 (Docker는 SIGTERM 뒤 10초 기다림) ----------
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  console.log('shutting down')
  for (const r of rooms.values()) r.shutdown()
  await Promise.race([flush(), new Promise(r => setTimeout(r, 7000))])
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

server.listen(PORT, () => console.log(`casino listening on ${PORT} (public: ${PUBLIC})`))
