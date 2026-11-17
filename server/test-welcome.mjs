// 첫 방문 기념 칩 (registry의 welcome: 슬롯 5,000). node test-welcome.mjs
// 슬롯이 wip이면 관리자만 들어갈 수 있으므로 서버를 CASINO_ADMINS=u_w1,u_w2,u_w3 (와 기존 관리자)로 띄운다
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
const ledger = async () => (await (await fetch(BASE + '/auth/_ledger')).json())
const coins = async u => (await ledger()).ledger[u] ?? 1000
const tag = Date.now().toString(36)

function client(user, path = '/casino/slots/ws') {
  const ws = new WebSocket(BASE.replace('http', 'ws') + path, { headers: { Cookie: `jmtt_session=${user}` } })
  const c = { ws, msgs: [] }
  ws.on('message', m => c.msgs.push(JSON.parse(m)))
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('unexpected-response', (_, r) => rej(new Error('http ' + r.statusCode))) })
  c.send = m => ws.send(JSON.stringify(m))
  c.wait = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) return m; await sleep(30) } return null }
  c.close = () => new Promise(r => { ws.once('close', r); ws.close() })
  return c
}

// 1) 처음 들어오면 칩 5,000 + gift 메시지, 코인은 그대로
const U1 = 'u_w1'
const before = await coins(U1)
let A = client(U1); await A.open
const g = await A.wait(m => m.t === 'gift')
const ch = A.msgs.find(m => m.t === 'chips')
check('처음 들어오면 기념 칩 5,000 (gift 메시지)', g?.chips === 5000 && /기념/.test(g.title), JSON.stringify(g))
check('칩 숫자가 처음부터 5,000 (칩 바꾸기 창이 먼저 뜨지 않게)', ch?.chips === 5000, JSON.stringify(ch))
check('코인은 그대로 (맡기지 않음)', (await coins(U1)) === before)
await A.close()

// 2) 다시 들어오면 선물 없음, 칩은 그대로
A = client(U1); await A.open
await A.wait(m => m.t === 'chips')
await sleep(300)
check('다시 들어오면 선물 없음', !A.msgs.some(m => m.t === 'gift') && A.msgs.find(m => m.t === 'chips')?.chips === 5000)

// 3) 칩 → 코인: 기념 칩도 코인으로
A.send({ t: 'cashout' })
const co = await A.wait(m => m.t === 'chips' && m.cashout !== undefined)
await sleep(300)
check('기념 칩을 코인으로 바꿀 수 있음', co?.cashout === 5000 && (await coins(U1)) === before + 5000, `코인 ${before} → ${await coins(U1)}`)
const led = (await ledger()).log.filter(x => x.user === U1)
check('장부: 정산 5,000 (맡긴 것 없이)', led.length === 1 && led[0].op === 'cashout' && led[0].amount === 5000, led.map(x => `${x.op} ${x.amount}`).join(','))
await A.close()
A = client(U1); await A.open; await A.wait(m => m.t === 'chips'); await sleep(300)
check('코인으로 바꾼 뒤에도 다시 받지 않음', !A.msgs.some(m => m.t === 'gift') && A.msgs.find(m => m.t === 'chips')?.chips === 0)
await A.close()

// 4) 홀덤에 앉아 있으면(한 번에 한 게임) 이번엔 안 주고, 일어난 뒤에 줌
const U2 = 'u_w2'
const H = client(U2, '/casino/holdem/ws'); await H.open
H.send({ t: 'create', name: 'w2' }); await H.wait(m => m.t === 'seated')
let B = client(U2); await B.open
const later = await B.wait(m => m.t === 'toast')
await sleep(300)
check('다른 게임에 앉아 있으면 나중에', !B.msgs.some(m => m.t === 'gift') && /일어난 뒤/.test(later?.msg || ''), later?.msg)
await B.close()
H.send({ t: 'leave' }); await H.wait(m => m.t === 'left'); await sleep(300); await H.close()
B = client(U2); await B.open
check('일어난 뒤 들어오면 받음', (await B.wait(m => m.t === 'gift'))?.chips === 5000)
await B.close()

// 5) 처음에 탭 두 개가 동시에 → 한 번만
const U3 = 'u_w3'
const [C1, C2] = [client(U3), client(U3)]
await Promise.all([C1.open, C2.open]); await sleep(600)
const gifts = [C1, C2].flatMap(c => c.msgs.filter(m => m.t === 'gift'))
const lastChips = [C1, C2].map(c => c.msgs.filter(m => m.t === 'chips').at(-1)?.chips)
check('동시에 두 탭이어도 선물은 한 번', gifts.length === 1 && lastChips.every(v => v === 5000), `gift ${gifts.length}, 칩 ${lastChips}`)
await C1.close(); await C2.close()

console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
