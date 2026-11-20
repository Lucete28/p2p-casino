// #부하 (2026-11-20): 로컬에서만 홀덤 소켓 N개를 붙여 본다 (실제 사이트에 하지 않기). node test-load.mjs [N=500] [초=60] [quick|one]
// quick: 빠른 시작으로 방에 흩어져 체크/콜로 계속 플레이 · one: 모두 한 방에 (방 인원 상한 확인). 서버 CPU·메모리는 따로 잼
import WebSocket from 'ws'
const N = +process.argv[2] || 500, SECS = +process.argv[3] || 60, MODE = process.argv[4] || 'quick'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const run = Math.random().toString(36).slice(2, 5)
const errs = {}
let bytes = 0, msgs = 0, seated = 0, refused = 0, opened = 0, code = null
const clients = []
for (let i = 0; i < N; i++) {
  const u = `u_ld${run}${i}`
  const ws = new WebSocket('ws://127.0.0.1:' + (process.env.CASINO_PORT || 3200) + '/casino/holdem/ws', { headers: { Cookie: `jmtt_session=${u}; casino_device=DEV${u}xxxxxxxxxx` } })
  const c = { ws, state: null, seatId: null }
  ws.on('message', raw => {
    bytes += raw.length; msgs++
    const d = JSON.parse(raw)
    if (d.t === 'state') c.state = d.s
    if (d.t === 'joined') { c.seatId = d.seatId; code ||= d.code }
    if (d.t === 'seated') seated++
    if (d.t === 'nojoin' || d.t === 'busy') refused++
  })
  ws.on('open', () => { opened++; if (MODE === 'quick') ws.send(JSON.stringify({ t: 'quick' })) })
  ws.on('error', e => { errs[e.message] = (errs[e.message] || 0) + 1 })
  clients.push(c)
  if (i % 50 === 49) await sleep(200)
}
await sleep(3000)
if (MODE === 'one') { // 한 방에 모두: 첫 사람이 방을 만들고 나머지가 같은 코드로
  clients[0].ws.send(JSON.stringify({ t: 'create', public: false })); await sleep(1500)
  for (const c of clients.slice(1)) c.ws.send(JSON.stringify({ t: 'join', code }))
}
const t0 = Date.now(); bytes = 0; msgs = 0
const auto = setInterval(() => { for (const c of clients) { const s = c.state; if (s && s.toActId === c.seatId) { const me = s.seats.find(p => p.id === c.seatId); c.ws.send(JSON.stringify({ t: 'move', type: s.currentBet > me.bet ? 'call' : 'check' })); c.state = { ...s, toActId: null } } } }, 100)
await sleep(SECS * 1000)
clearInterval(auto)
const dt = (Date.now() - t0) / 1000
console.log(JSON.stringify({ N, mode: MODE, opened, seated, refused, secs: Math.round(dt), msgsPerSec: Math.round(msgs / dt), kbPerSec: Math.round(bytes / dt / 1024), avgMsgBytes: Math.round(bytes / Math.max(1, msgs)), errs }))
for (const c of clients) c.ws.send(JSON.stringify({ t: 'leave' }))
await sleep(3000); process.exit(0)
