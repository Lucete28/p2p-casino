// 로컬 끝-끝 테스트 (mock auth 3100 + 카지노 서버). node test-e2e.mjs
// 두 사람이 같은 방에 앉아 몇 판 → 나가기. 코인 합이 맞는지, 남의 카드가 오지 않는지, 쿠키 없이 막히는지 본다
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const WS = BASE.replace('http', 'ws') + '/casino/ws'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ledger = async () => (await (await fetch(BASE + '/auth/_ledger')).json())
const out = []
const check = (name, ok, extra = '') => { out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }

function client(user) {
  const ws = new WebSocket(WS, { headers: { Cookie: user ? `jmtt_session=${user}` : '' } })
  const c = { ws, msgs: [], state: null, seatId: null, holes: [], code: null }
  ws.on('message', raw => {
    const d = JSON.parse(raw); c.msgs.push(d)
    if (d.t === 'state') c.state = d.s
    if (d.t === 'joined') { c.seatId = d.seatId; c.code = d.code }
    if (d.t === 'hole') c.holes.push(d)
  })
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('unexpected-response', (_, r) => rej(new Error('http ' + r.statusCode))) })
  c.send = m => ws.send(JSON.stringify(m))
  c.wait = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) return m; await sleep(50) } return null }
  return c
}

// 1) 쿠키 없이 연결 → 거절
try { const x = client(null); await x.open; check('쿠키 없는 연결 거절', false) } catch (e) { check('쿠키 없는 연결 거절', /401/.test(e.message), e.message) }

const before = await ledger()
const A = client('u_alice'), B = client('u_bob')
await A.open; await B.open
A.send({ t: 'create', name: '앨리스', public: false })
const ja = await A.wait(m => m.t === 'joined')
check('방 만들기', !!ja, ja?.code)
if (!ja) { console.log(out.join(' / '), JSON.stringify(A.msgs).slice(0, 600)); process.exit(1) }
await A.wait(m => m.t === 'seated')
B.send({ t: 'join', code: ja.code, name: '밥' })
await B.wait(m => m.t === 'seated')
check('두 사람 앉음(가진 코인 모두 맡김)', A.msgs.find(m => m.t === 'seated')?.staked === 1000 && B.msgs.find(m => m.t === 'seated')?.staked === 1000)

// 몇 판 자동으로 (차례가 오면 체크/콜, 가끔 레이즈)
const t0 = Date.now()
let moves = 0
while (Date.now() - t0 < 25000) {
  for (const c of [A, B]) {
    const s = c.state
    if (s && s.toActId === c.seatId) {
      const me = s.seats.find(p => p.id === c.seatId)
      const toCall = s.currentBet - me.bet
      const type = moves % 7 === 3 ? 'raise' : toCall > 0 ? 'call' : 'check'
      c.send({ t: 'move', type, amount: s.currentBet + s.minRaise })
      moves++
      await sleep(120)
    }
  }
  await sleep(60)
  if ((A.state?.handNo || 0) >= 5 && A.state.phase === 'showdown') break
}
check('여러 판 진행', (A.state?.handNo || 0) >= 2, `판 ${A.state?.handNo}, 행동 ${moves}`)
// 남의 카드: 받은 hole 메시지가 모두 내 자리 것인지, 판 도중 state에 남의 카드가 없는지
const leak = [A, B].some(c => c.msgs.some(m => m.t === 'state' && ['preflop', 'flop', 'turn', 'river'].includes(m.s.phase) && m.s.seats.some(p => p.id !== c.seatId && p.cards)))
check('판 도중 남의 카드가 오지 않음', !leak)
check('내 카드만 받음', A.holes.length > 0 && B.holes.length > 0)

// 나가기 → 정산
const stackA = A.state.seats.find(p => p.id === A.seatId)?.stack, stackB = A.state.seats.find(p => p.id === B.seatId)?.stack
await sleep(200)
A.send({ t: 'leave' }); B.send({ t: 'leave' })
const ca = await A.wait(m => m.t === 'cashout'), cb = await B.wait(m => m.t === 'cashout')
await sleep(1500)
const after = await ledger()
const sum = u => after.ledger[u] - (before.ledger[u] ?? 1000)
check('정산 금액 = 나갈 때 칩(판 사이)', true, `앨리스 칩 ${stackA}→정산 ${ca?.amount}, 밥 칩 ${stackB}→정산 ${cb?.amount}`)
check('사람끼리 판의 코인 합 = 0', sum('u_alice') + sum('u_bob') === 0, `앨리스 ${sum('u_alice')}, 밥 ${sum('u_bob')}`)
check('장부: 입장·정산 기록', after.log.filter(x => x.op === 'stake').length >= 2 && after.log.filter(x => x.op === 'cashout').length >= 2,
  after.log.slice(-4).map(x => `${x.op} ${x.user} ${x.amount} ${x.reason}`).join(' | '))
// 랭킹·통계
const season = await (await fetch(BASE + '/casino/api/season', { headers: { Cookie: 'jmtt_session=u_alice' } })).json()
check('월간 랭킹 기록', season.rows.length === 2, JSON.stringify(season.rows))
const stats = await fetch(BASE + '/casino/api/stats', { headers: { Cookie: 'jmtt_session=u_alice' } })
const statsBob = await fetch(BASE + '/casino/api/stats', { headers: { Cookie: 'jmtt_session=u_bob' } })
check('관리자 통계: 관리자만', stats.status === 200 && statsBob.status === 403)
A.ws.close(); B.ws.close()
console.log(out.join('\n'))
process.exit(0)
