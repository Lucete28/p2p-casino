// 큰 금액 (node test-big.mjs, 서버는 CASINO_TEST_GAMES=1 → 테스트 게임 coinflip · 약 40초)
// 21억(2^31)이 넘는 코인을 제대로 읽는지, 한 번에 10만씩 나눠 맡기고 돌려받는 합이 맞는지,
// 한 사람의 큰 정산이 다른 사람의 '코인으로'를 붙잡지 않는지
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
const ledger = async () => (await (await fetch(BASE + '/auth/_ledger')).json())
const coins = async u => (await ledger()).ledger[u] ?? 1000

function client(user, path = '/casino/coinflip/ws') {
  const ws = new WebSocket(BASE.replace('http', 'ws') + path, { headers: { Cookie: `jmtt_session=${user}` } })
  const c = { ws, msgs: [], chips: 0, inPlay: 0 }
  ws.on('message', raw => { const d = JSON.parse(raw); c.msgs.push(d); if (d.t === 'chips') { c.chips = d.chips; c.inPlay = d.inPlay } })
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('unexpected-response', (_, r) => rej(new Error('http ' + r.statusCode))) })
  c.send = m => ws.send(JSON.stringify(m))
  c.wait = async (pred, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = c.msgs.findIndex(pred); if (i >= 0) return c.msgs.splice(i, 1)[0]; await sleep(30) } return null }
  return c
}

const earn = (user, amount) => fetch(BASE + '/auth/internal/coin/earn', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, amount, reason: 'test', ref: 'big-' + user + '-' + amount }) }).then(r => r.json())
const tag = Date.now().toString(36)

// 1) 21억이 넘는 잔액
const B = 'u_big_' + tag
await coins(B); await earn(B, 3_000_000_000)
const want = await coins(B)
const b = client(B); await b.open
const me = await b.wait(m => m.t === 'me')
check('21억이 넘는 코인도 그대로 읽음', me?.coins === want, `${me?.coins} vs ${want}`)

// 2) 큰 칩 바꾸기: 10만씩 나눠 맡김 · 시간이 걸린다는 안내 · 합이 맞음
const BIG = 1_234_567_891
b.send({ t: 'buyin', amount: BIG })
const note = await b.wait(m => m.t === 'toast' && /시간이 걸려요/.test(m.msg), 3000)
check('큰 금액은 시간이 걸린다고 먼저 알림', !!note)
const got = await b.wait(m => m.t === 'chips' && m.chips === BIG, 120000)
check('큰 금액 칩 바꾸기', !!got && got.coins === want - BIG, `coins ${got?.coins}`)
const parts = (await ledger()).log.filter(x => x.user === B && x.op === 'stake')
check('10만씩 나눠 맡김', parts.length === Math.ceil(BIG / 100000) && parts.every(x => x.amount <= 100000) && parts.reduce((a, x) => a + x.amount, 0) === BIG, `${parts.length}번`)

// 3) 큰 정산이 도는 동안 다른 사람의 '코인으로'는 바로 끝남
const C = 'u_small_' + tag
const cStart = await coins(C)
const c = client(C); await c.open; await c.wait(m => m.t === 'me')
c.send({ t: 'buyin', amount: 500 }); await c.wait(m => m.t === 'chips' && m.chips === 500)
b.send({ t: 'cashout' })
await sleep(300)
const t0 = Date.now()
c.send({ t: 'cashout' })
const cOut = await c.wait(m => m.t === 'chips' && m.cashout === 500, 10000)
const ms = Date.now() - t0
check('다른 사람의 큰 정산을 기다리지 않음', !!cOut && ms < 3000 && cOut.coins === cStart, `${ms}ms`)
const bOut = await b.wait(m => m.t === 'chips' && m.cashout === BIG, 180000)
check('큰 금액 코인으로: 전부 돌아옴', !!bOut && (await coins(B)) === want, `${await coins(B)} vs ${want}`)

b.ws.close(); c.ws.close()
console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
