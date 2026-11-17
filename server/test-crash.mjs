// 판 도중 서버가 꺼지는 경우 준비: 두 사람이 앉아 한 판을 끝낸 뒤, 다음 판에서 베팅이 들어간 상태로 멈춰 둔다.
// 이 스크립트가 끝나면 서버를 강제로 끄고 다시 켠 뒤 장부를 본다 (node test-crash.mjs → 서버 재시작 → /auth/_ledger)
import WebSocket from 'ws'
const BASE = 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
function client(user) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/ws', { headers: { Cookie: `jmtt_session=${user}` } })
  const c = { ws, msgs: [], state: null, seatId: null }
  ws.on('message', raw => { const d = JSON.parse(raw); c.msgs.push(d); if (d.t === 'state') c.state = d.s; if (d.t === 'joined') c.seatId = d.seatId })
  c.open = new Promise(r => ws.on('open', r))
  c.send = m => ws.send(JSON.stringify(m))
  c.wait = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) return m; await sleep(50) } return null }
  return c
}
const A = client('u_carol'), B = client('u_dave')
await A.open; await B.open
A.send({ t: 'create', name: '캐롤' }); const j = await A.wait(m => m.t === 'joined'); await A.wait(m => m.t === 'seated')
B.send({ t: 'join', code: j.code, name: '데이브' }); await B.wait(m => m.t === 'seated')
// 첫 판: 끝까지 체크/콜
const act = async until => {
  const t0 = Date.now()
  while (Date.now() - t0 < 20000 && !until()) {
    for (const c of [A, B]) {
      const s = c.state
      if (s && s.toActId === c.seatId) { const me = s.seats.find(p => p.id === c.seatId); c.send({ t: 'move', type: s.currentBet > me.bet ? 'call' : 'check' }); await sleep(150) }
    }
    await sleep(50)
  }
}
await act(() => A.state?.handNo >= 1 && A.state.phase === 'showdown')
const after1 = Object.fromEntries(A.state.seats.map(p => [p.name, p.stack]))
// 둘째 판: 레이즈를 넣어 팟을 키운 채로 멈춤
await act(() => A.state?.handNo >= 2 && A.state.phase === 'preflop')
const s = A.state
const actor = [A, B].find(c => c.seatId === s.toActId)
actor.send({ t: 'move', type: 'raise', amount: 300 })
await sleep(500)
const mid = A.state
console.log(JSON.stringify({ afterHand1: after1, hand2: { phase: mid.phase, pot: mid.pot + mid.seats.reduce((a, p) => a + p.bet, 0), stacks: Object.fromEntries(mid.seats.map(p => [p.name, p.stack + '+' + p.bet])) } }))
process.exit(0)
