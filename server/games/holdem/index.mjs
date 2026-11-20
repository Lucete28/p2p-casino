// 텍사스 홀덤 게임 모듈 (CASINO.md 3장 '소켓 모드': 웹소켓을 직접 다룬다)
// 방 만들기·참가·빠른 시작, 판 진행은 room.mjs. 코인 맡기기·정산은 코어 칩 지갑(ctx.wallet)
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { monthKey } from '../../core/store.mjs'
import * as jmtt from '../../core/jmtt.mjs'
import { roomKit } from './room.mjs'
import { namesOf, reportName } from './names.mjs'

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

// #부하: 한 방에 너무 많이 모이거나(구경꾼 포함) 홀덤 전체 연결이 너무 많으면 죽지 말고 안내
const ROOM_MAX_MEMBERS = 60
const MAX_SOCKETS = 1500
const RATE = { per: 1000, max: 30 } // 연결 하나가 1초에 보낼 수 있는 메시지 (넘으면 버림, 계속 넘치면 끊음)
let sockets = 0

function enterRoom(ws, room, nick) {
  if (!room.members.has(ws.who.id) && room.members.size >= ROOM_MAX_MEMBERS) return out(ws, { t: 'nojoin', msg: '이 방은 사람이 너무 많아요. 다른 방에 들어가 주세요.' })
  if (ws.room && ws.room !== room) { const old = ws.room; const m = old.members.get(ws.who.id); old.detach(ws); if (m && !m.sockets.size) old.leave(m) }
  if (room.kicked.has(ws.who.id)) return out(ws, { t: 'toast', msg: '이 방에서는 내보내졌어요.' })
  const m = room.attach(ws, { ...ws.who, nick: cleanName(ws.who.name) }, ws.device) // 이름은 JMTT 닉네임만 (#닉네임)
  room.rename(m.user, cleanName(ws.who.name)) // 다시 들어올 때 그새 바뀐 닉네임으로
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
        && r.seatsTaken() < CONFIG.MAX_SEATS
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
    case 'ping': return out(ws, { t: 'pong' }) // 브라우저가 죽은 연결을 알아채도록 (net.js)
    case 'rename': { // JMTT 배지에서 닉네임을 바꿨을 때 (브라우저가 보낸 이름은 믿지 않고 메인에게 지금 이름을 받음)
      if (Date.now() - (ws.lastRename || 0) < 3000) return
      ws.lastRename = Date.now()
      const n = (await namesOf([ws.who.id], { fresh: true }))[ws.who.id]
      if (!n) return
      ws.who.name = n
      return room?.rename(ws.who.id, cleanName(n))
    }
    case 'report': { // 이름 신고: 방 참가자(seat) 또는 이번 달 랭킹 순위(rank). 브라우저는 상대 JMTT ID를 모름
      if (Date.now() - (ws.lastReport || 0) < 5000) return out(ws, { t: 'toast', msg: '잠시 뒤 다시 해 주세요.' })
      ws.lastReport = Date.now()
      let target = null
      if (d.seat && room) target = room.userOfSeat(String(d.seat))
      else if (d.rank) {
        const rank = Math.trunc(Number(d.rank))
        if (rank >= 1 && rank <= 20) target = store.season(monthKey(), rank, null).rows[rank - 1]?.user_id || null
      }
      if (!target || target === ws.who.id) return out(ws, { t: 'toast', msg: '신고할 수 없는 이름이에요.' })
      const ok = await reportName(target, ws.who.id, String(d.reason || '')).catch(() => false)
      return out(ws, { t: 'toast', msg: ok ? '이름을 신고했어요. 운영자가 확인해요.' : '신고를 보내지 못했어요. 잠시 뒤 다시 해 주세요.' })
    }
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
    if (sockets >= MAX_SOCKETS) { out(ws, { t: 'busy', msg: '지금 사람이 많아요. 잠시 뒤 다시 들어와 주세요.' }); return ws.close(1013, 'busy') }
    sockets++
    let win = Date.now(), count = 0, strikes = 0
    // 메시지 받는 곳을 먼저 붙인다 (잔액을 묻는 사이 온 메시지를 놓치지 않게)
    ws.on('message', raw => {
      const now = Date.now()
      if (now - win > RATE.per) { win = now; count = 0 }
      if (++count > RATE.max) { if (count === RATE.max + 1 && ++strikes >= 5) ws.close(1008, 'flood'); return }
      let d
      try { d = JSON.parse(raw) } catch { return }
      handle(ws, d).catch(err => { console.error('holdem ws', err); out(ws, { t: 'toast', msg: '서버 오류가 났어요.' }) })
    })
    ws.on('close', () => { sockets--; ws.room?.detach(ws) })
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
      const names = await namesOf(r.rows.map(x => x.user_id)) // 저장된 이름 대신 지금 JMTT 닉네임
      return ctx.send(res, 200, { ...r, rows: r.rows.map(x => ({ name: names[x.user_id] || x.name || '플레이어', net: x.net, hands: x.hands, me: x.user_id === who?.id })) })
    }
    if (path === '/api/stats') {
      if (!who) return ctx.send(res, 401, { error: 'not_logged_in' })
      if (!ctx.isAdmin(who)) return ctx.send(res, 403, { error: 'not_admin', id: who.id })
      const st = store.stats(14)
      const season = store.season(monthKey(), 10, null)
      const names = await namesOf(season.rows.map(x => x.user_id))
      return ctx.send(res, 200, { ...st, season: { ...season, rows: season.rows.map(x => ({ name: names[x.user_id] || x.name || '플레이어', net: x.net, hands: x.hands })) },
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
