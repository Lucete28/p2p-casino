// 텍사스 홀덤 게임 모듈 (CASINO.md 3장 '소켓 모드': 웹소켓을 직접 다룬다)
// 방 만들기·참가·빠른 시작, 판 진행은 room.mjs. 코인 맡기기·정산은 코어 칩 지갑(ctx.wallet)
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { monthKey } from '../../core/store.mjs'
import * as jmtt from '../../core/jmtt.mjs'
import { roomKit } from './room.mjs'

const rooms = new Map() // 방 코드 → Room
let Room, CONFIG, store

const newCode = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  for (;;) {
    let c = ''
    for (let i = 0; i < 5; i++) c += chars[randomBytes(1)[0] % chars.length]
    if (!rooms.has(c)) return c
  }
}
const out = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
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

export default {
  id: 'holdem',
  title: '텍사스 홀덤',
  mode: 'socket',

  async init(ctx) {
    store = ctx.store
    // poker.js·bot.js는 브라우저와 같은 파일을 서버에서도 쓴다
    const dir = join(ctx.publicDir, 'holdem')
    const poker = await import(pathToFileURL(join(dir, 'poker.js')).href)
    const bot = await import(pathToFileURL(join(dir, 'bot.js')).href)
    CONFIG = poker.CONFIG
    ;({ Room } = roomKit({ Table: poker.Table, CONFIG, botDecision: bot.botDecision, BOT_NAMES: bot.BOT_NAMES,
      store, wallet: ctx.wallet, titleOf: ctx.titleOf, onClose: r => rooms.delete(r.code) }))
    setInterval(() => { for (const r of rooms.values()) r.sweep() }, 30000).unref()
  },

  // 로그인 확인이 끝난 웹소켓 (ws.who, ws.device는 코어가 붙임)
  async connect(ws) {
    ws.room = null
    // 메시지 받는 곳을 먼저 붙인다 (잔액을 묻는 사이 온 메시지를 놓치지 않게)
    ws.on('message', raw => {
      let d
      try { d = JSON.parse(raw) } catch { return }
      handle(ws, d).catch(err => { console.error('holdem ws', err); out(ws, { t: 'toast', msg: '서버 오류가 났어요.' }) })
    })
    ws.on('close', () => ws.room?.detach(ws))
    let coins = null
    try { coins = await jmtt.balance(ws.who.id) } catch {}
    out(ws, { t: 'me', me: { id: ws.who.id, name: ws.who.name, picture: ws.who.picture }, coins })
  },

  // /casino/holdem/api/* (옛 주소 /casino/api/rooms·season·stats도 여기로)
  async api(req, res, path, who, ctx) {
    if (path === '/api/rooms') {
      return ctx.send(res, 200, { rooms: [...rooms.values()].filter(r => r.isPublic && r.members.size).map(r => r.summary()) })
    }
    if (path === '/api/season') {
      const url = new URL(req.url, 'http://x')
      const month = /^\d{4}-\d{2}-01$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : monthKey()
      const n = Math.min(20, +url.searchParams.get('n') || 10)
      const r = store.season(month, n, who?.id)
      return ctx.send(res, 200, { ...r, rows: r.rows.map(x => ({ name: x.name, net: x.net, hands: x.hands, me: x.user_id === who?.id })) })
    }
    if (path === '/api/stats') {
      if (!who) return ctx.send(res, 401, { error: 'not_logged_in' })
      if (!ctx.isAdmin(who)) return ctx.send(res, 403, { error: 'not_admin', id: who.id })
      const st = store.stats(14)
      const season = store.season(monthKey(), 10, null)
      return ctx.send(res, 200, { ...st, season: { ...season, rows: season.rows.map(x => ({ name: x.name, net: x.net, hands: x.hands })) },
        live: { rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.members.size, 0) } })
    }
    return ctx.send(res, 404, { error: 'not_found' })
  },

  // 로비에 보일 숫자: 공개 방 수와 앉아 있는 사람 수
  summary() {
    let players = 0, tables = 0
    for (const r of rooms.values()) { const s = r.summary(); players += s.humans; if (r.isPublic && r.members.size) tables++ }
    return { players, tables }
  },

  // 서버를 끌 때: 진행 중인 판은 무효로 하고 건 칩을 돌려준 뒤 정산 대기열로 (room.shutdown)
  shutdown() { for (const r of rooms.values()) r.shutdown() },
}
