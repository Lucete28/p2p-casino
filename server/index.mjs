// JMTT 카지노 서버 (v1.9.0~ 로비 구조, CASINO.md)
// /casino/ 로비 · /casino/<게임>/ 각 게임 (정적 파일 + /casino/<게임>/ws + /casino/<게임>/api/*)
// 판 진행·카드·봇·코인 정산은 서버가 한다 (DEV_REFERENCE 2-2 카지노). 게임 코드는 server/games/<id>/
import http from 'node:http'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { openStore } from './core/store.mjs'
import * as jmtt from './core/jmtt.mjs'
import { openWallet } from './core/wallet.mjs'
import { houseKit } from './core/house.mjs'
import { GAMES } from './core/registry.mjs'
import { refillKit } from './core/refill.mjs'
import { BASE, send, redirect, deviceOf, newDevice, deviceCookie, resolveStatic, sendFile } from './core/http.mjs'

const PORT = +process.env.PORT || 3000
const PUBLIC = resolve(process.env.PUBLIC_DIR || join(import.meta.dirname, '..', 'public'))
const DATA = process.env.DATA_DIR || join(import.meta.dirname, '..', 'data')
const ADMINS = new Set((process.env.CASINO_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean)) // 관리자 JMTT 사용자 ID
const isAdmin = who => !!who && ADMINS.has(who.id)

mkdirSync(DATA, { recursive: true })
const store = openStore(join(DATA, 'casino.db'))
const wallet = openWallet(store)
await wallet.recover() // 다시 켜졌을 때: 남아 있는 자리를 모두 정산
setInterval(() => store.pruneHands(), 6 * 3600e3).unref()

// ---------- 게임 불러오기 ----------
// 게임 하나가 불러오기·준비에서 오류를 내도 카지노 전체가 죽지 않게, 그 게임만 'down'(점검 중)으로 둔다
const titleOf = id => GAMES.find(g => g.id === id)?.title || id
const house = houseKit({ store, wallet, titleOf })
const games = new Map() // id → { meta, mod, mode, host, status }
for (const meta of GAMES) {
  const g = { meta, mod: null, mode: null, host: null, status: meta.status }
  games.set(meta.id, g)
  const file = join(import.meta.dirname, 'games', meta.dir || meta.id, 'index.mjs')
  if (!existsSync(file)) continue // 아직 서버 코드가 없는 게임 (화면만 있거나 아무것도 없음)
  try {
    const mod = (await import(pathToFileURL(file).href)).default
    if (!mod || mod.id !== meta.id) throw new Error(`export default의 id가 '${meta.id}'가 아니에요`)
    await mod.init?.({ store, wallet, jmtt, publicDir: PUBLIC, titleOf, isAdmin, send })
    g.mod = mod
    g.mode = mod.mode === 'socket' ? 'socket' : 'house'
    if (g.mode === 'house') g.host = house(mod, meta)
  } catch (err) {
    console.error(`game ${meta.id} failed to load:`, err)
    g.status = 'down'
  }
}
const refill = refillKit(store, titleOf) // 로비 캐셔의 파산 지원금
const summaryOf = g =>{ try { return g.host ? g.host.summary() : g.mod?.summary?.() || null } catch { return null } }

// 이 사람이 이 게임 주소를 열 수 있나 (wip·down은 관리자만)
const canOpen = (g, who) => g.status === 'live' || isAdmin(who)
const identify = async req => { try { return await jmtt.identify(req.headers.cookie) } catch { return undefined } } // undefined = auth 오류

// ---------- HTTP ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  if (path === '/') return redirect(res, 302, BASE + '/')
  if (path === BASE) return redirect(res, 301, BASE + '/')
  if (!path.startsWith(BASE + '/')) return send(res, 404, 'not found')
  const rel = path.slice(BASE.length) // '/...'
  if (rel === '/healthz') return send(res, 200, { ok: true, games: Object.fromEntries([...games].map(([id, g]) => [id, g.status])) })

  // 로비가 읽는 게임 목록
  if (rel === '/api/lobby') {
    const who = await identify(req)
    const seat = who ? store.openSeatOf(who.id) : null
    return send(res, 200, {
      games: [...games.values()].map(g => ({ id: g.meta.id, title: g.meta.title, status: g.status, open: canOpen(g, who), ...(summaryOf(g) || {}) })),
      seat: seat ? seat.game : null,
    })
  }

  // 로비 캐셔: 파산 지원금 상태(GET)·받기(POST). 로그인한 사람만
  if (rel === '/api/refill') {
    const who = await identify(req)
    if (who === undefined) return send(res, 503, { error: 'auth_unavailable' })
    if (!who) return send(res, 401, { error: 'not_logged_in' })
    try {
      if (req.method === 'POST') { const r = await refill.claim(who.id); return send(res, r.code, r.body) }
      return send(res, 200, await refill.status(who.id))
    } catch (err) { console.warn('refill', err.message); return send(res, 503, { error: 'auth_unavailable' }) }
  }

  // 옛 주소 (v1.8 홀덤이 /casino/에 있던 때). 한 달쯤 뒤 지운다
  const old = rel.match(/^\/api\/(rooms|season|stats)$/)
  if (old) return gameApi(req, res, games.get('holdem'), '/api/' + old[1])
  if (rel === '/stats.html') return redirect(res, 301, BASE + '/holdem/stats.html')

  // 게임 주소: /<id> · /<id>/ · /<id>/api/*
  const seg = rel.split('/')[1]
  const g = games.get(seg)
  if (g) {
    if (g.status !== 'live') {
      const who = await identify(req)
      if (!canOpen(g, who)) return send(res, 404, 'not found')
    }
    if (rel === '/' + seg) return redirect(res, 301, `${BASE}/${seg}/`)
    if (rel.startsWith(`/${seg}/api/`)) return gameApi(req, res, g, rel.slice(seg.length + 1))
  }

  const file = await resolveStatic(PUBLIC, rel)
  if (file === 'dir') return redirect(res, 301, BASE + rel + '/')
  if (!file) return send(res, 404, 'not found')
  return sendFile(req, res, file)
}

async function gameApi(req, res, g, path) {
  if (!g?.mod?.api) return send(res, 404, { error: 'not_found' })
  const who = await identify(req)
  if (who === undefined) return send(res, 503, { error: 'auth_unavailable' })
  return g.mod.api(req, res, path, who, { send, isAdmin, store })
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => { console.error(err); if (!res.headersSent) send(res, 500, { error: 'server_error' }) })
})

// ---------- 웹소켓: /casino/<게임>/ws (옛 주소 /casino/ws = 홀덤) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
wss.on('headers', (headers, req) => { if (req.newDevice) headers.push('Set-Cookie: ' + deviceCookie(req.device, req)) })
server.on('upgrade', async (req, socket, head) => {
  const path = new URL(req.url, 'http://x').pathname
  const m = path === BASE + '/ws' ? ['', 'holdem'] : path.match(new RegExp(`^${BASE}/([a-z0-9_-]+)/ws$`))
  const g = m && games.get(m[1])
  if (!g || !g.mod) return socket.destroy()
  const who = await identify(req)
  if (who === undefined) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
  // 로그인한 사람만 (브라우저가 보낸 ID는 쓰지 않음)
  if (!who) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
  if (!canOpen(g, who)) return socket.destroy()
  // 기기 쿠키가 없으면(처음 온 기기) 이 연결 응답에서 하나 준다
  req.device = deviceOf(req) || newDevice()
  req.newDevice = !deviceOf(req)
  wss.handleUpgrade(req, socket, head, ws => {
    ws.who = who
    ws.device = req.device
    ws.game = g.meta.id
    ws.alive = true
    ws.on('pong', () => { ws.alive = true })
    try { store.visit(who.id, who.name) } catch (err) { console.warn('visit', err.message) }
    const run = g.mode === 'socket' ? g.mod.connect(ws) : g.host.attach(ws)
    Promise.resolve(run).catch(err => { console.error(`${g.meta.id} connect`, err); ws.close() })
  })
})
// 연결이 살아 있는지 30초마다 확인
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue }
    ws.alive = false
    ws.ping()
  }
}, 30000).unref()

// ---------- 끌 때: 판 무효 → 정산 (Docker는 SIGTERM 뒤 10초 기다림) ----------
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  console.log('shutting down')
  for (const g of games.values()) {
    try { g.host ? g.host.shutdown() : g.mod?.shutdown?.() } catch (err) { console.error(`${g.meta.id} shutdown`, err) }
  }
  await Promise.race([wallet.flush(), new Promise(r => setTimeout(r, 7000))])
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

server.listen(PORT, () => console.log(`casino listening on ${PORT} (public: ${PUBLIC}) games: ${[...games].map(([id, g]) => `${id}:${g.status}${g.mod ? '' : '(no code)'}`).join(' ')}`))
