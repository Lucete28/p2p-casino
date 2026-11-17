// 기기당 한 자리, 봇으로 꽉 찬 방에 들어가면 봇 대신 앉기 (node test-seats.mjs, mock auth 3100 + 카지노 서버)
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
function client(user, device) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/ws', { headers: { Cookie: `jmtt_session=${user}` + (device ? `; casino_device=${device}` : '') } })
  const c = { ws, msgs: [], state: null, seatId: null }
  ws.on('message', raw => { const d = JSON.parse(raw); c.msgs.push(d); if (d.t === 'state') c.state = d.s; if (d.t === 'joined') c.seatId = d.seatId })
  c.open = new Promise(r => ws.on('open', r))
  c.send = m => ws.send(JSON.stringify(m))
  c.wait = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) return m; await sleep(50) } return null }
  return c
}
const seated = (c, s = c.state) => !!s?.seats.find(p => p.id === c.seatId && !p.left)

// 1) 같은 기기 두 계정 → 둘째는 못 앉음 / 다른 기기면 앉음
{
  const A = client('u_dev1', 'DEVICE_AAAAAAAAAAAAAAAA'), B = client('u_dev2', 'DEVICE_AAAAAAAAAAAAAAAA'), C = client('u_dev3', 'DEVICE_BBBBBBBBBBBBBBBB')
  await A.open; await B.open; await C.open
  A.send({ t: 'create', name: 'A' }); const j = await A.wait(m => m.t === 'joined'); await A.wait(m => m.t === 'seated')
  B.send({ t: 'join', code: j.code, name: 'B' }); const tb = await B.wait(m => m.t === 'toast' || m.t === 'seated')
  C.send({ t: 'join', code: j.code, name: 'C' }); const sc = await C.wait(m => m.t === 'seated')
  check('같은 기기의 다른 계정은 못 앉음', tb?.t === 'toast' && /기기/.test(tb.msg), tb?.msg)
  check('다른 기기는 앉음', !!sc)
  for (const c of [A, B, C]) { c.send({ t: 'leave' }); }
  await sleep(800); for (const c of [A, B, C]) c.ws.close()
}

// 2) 판 사이에 봇으로 꽉 찬 방 → 바로 봇 대신 앉음
// 3) 판 도중 봇이 모두 판에 있으면 → 대기 후 판이 끝나면 봇 대신 앉음
{
  const O = client('u_owner'), J = client('u_joiner'), K = client('u_late')
  await O.open; await J.open; await K.open
  O.send({ t: 'create', name: '방장' }); const j = await O.wait(m => m.t === 'joined'); await O.wait(m => m.t === 'seated')
  for (let i = 0; i < 5; i++) { O.send({ t: 'bot' }); await sleep(100) }
  await sleep(400)
  check('방장 + 봇 5 = 6자리', O.state.seats.filter(p => !p.left).length === 6, O.state.seats.map(p => p.name).join(','))
  // 방장이 판 사이에 바로 행동하지 않게, 판이 시작되면 방장 차례에는 체크/콜만
  const auto = setInterval(() => { for (const c of [O, J, K]) { const s = c.state; if (s && s.toActId === c.seatId) { const me = s.seats.find(p => p.id === c.seatId); c.send({ t: 'move', type: s.currentBet > me.bet ? 'call' : 'check' }) } } }, 200)
  // 판이 진행 중인 때를 골라 들어감 (봇이 모두 판에 있음)
  for (let i = 0; i < 100 && !(O.state?.phase && ['preflop', 'flop'].includes(O.state.phase)); i++) await sleep(100)
  const phaseAtJoin = O.state.phase
  J.send({ t: 'join', code: j.code, name: '참가자' })
  const sj = await J.wait(m => m.t === 'seated')
  check('판 도중 들어가면 대기(봇 대신 다음 판)', !!sj?.pending, `들어간 때 ${phaseAtJoin}, pending=${sj?.pending}`)
  check('대기 중 상태에 waitingSeats', J.state?.waitingSeats?.includes(J.seatId))
  // 판이 끝나고 다음 판에 앉았는지
  const t0 = Date.now()
  while (Date.now() - t0 < 40000 && !seated(J)) await sleep(200)
  const s = J.state
  check('판이 끝나면 봇 대신 앉음', seated(J), `사람 ${s.seats.filter(p => !p.bot).length}, 봇 ${s.seats.filter(p => p.bot && !p.left).length}, 자리 ${s.seats.filter(p => !p.left).length}`)
  check('여전히 6자리 이하', s.seats.filter(p => !p.left).length <= 6)
  // 판 사이를 골라 들어가면 바로 앉음
  for (let i = 0; i < 300 && O.state.phase !== 'showdown'; i++) await sleep(100)
  K.send({ t: 'join', code: j.code, name: '늦은이' })
  const sk = await K.wait(m => m.t === 'seated')
  check('판 사이에 들어가면 바로 봇 대신 앉음', sk && !sk.pending, `pending=${sk?.pending}`)
  clearInterval(auto)
  for (const c of [O, J, K]) c.send({ t: 'leave' })
  await sleep(1500)
  const led = await (await fetch(BASE + '/auth/_ledger')).json()
  const net = ['u_owner', 'u_joiner', 'u_late'].map(u => `${u.slice(2)} ${led.ledger[u] - 1000}`).join(', ')
  check('나가면 모두 정산', ['u_owner', 'u_joiner', 'u_late'].every(u => led.log.some(x => x.op === 'cashout' && x.user === u)), net)
  for (const c of [O, J, K]) c.ws.close()
}
console.log(out.join('\n'))
process.exit(0)
