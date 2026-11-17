// 하우스 게임 '관리 모드'와 칩 지갑 (node test-house.mjs, 서버는 CASINO_TEST_GAMES=1 → 테스트 게임 coinflip)
// 칩 바꾸기·판·코인 돌려받기의 코인 합, 이상한 금액 막기, 판 도중 나가면 건 칩을 잃음, 한 번에 한 게임
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

const U = 'u_house_' + Date.now().toString(36)
const start = await coins(U)
const A = client(U)
await A.open
const me = await A.wait(m => m.t === 'me')
check('접속하면 me·코인·게임 정보', me?.coins === start && me.game?.id === 'coinflip', JSON.stringify(me?.game))

// 이상한 금액
for (const bad of [0, -5, 1.5, 'abc', 1e20]) { // 다섯 개 모두 거절되어야 함
  A.send({ t: 'buyin', amount: bad })
}
await sleep(400)
check('이상한 칩 바꾸기 금액은 거절', A.chips === 0 && (await coins(U)) === start && A.msgs.filter(m => m.t === 'toast').length === 5)
A.msgs.length = 0

// 칩 바꾸기
A.send({ t: 'buyin', amount: 300 })
const ch = await A.wait(m => m.t === 'chips' && m.chips === 300)
check('코인 300 → 칩 300', !!ch && ch.coins === start - 300, `coins ${ch?.coins}`)

// 칩보다 많이 걸기 · 0 걸기
A.send({ t: 'flip', bet: 301, side: 'H' }); A.send({ t: 'flip', bet: 0, side: 'H' })
await sleep(300)
check('칩보다 많이·0개 베팅 거절', A.chips === 300)
A.msgs.length = 0

// 여러 판 (0.1초 제한이 있어 간격을 둠)
let flips = 0
for (let i = 0; i < 20; i++) { A.send({ t: 'flip', bet: 10, side: 'H' }); await sleep(130); flips++ }
await sleep(300)
const results = A.msgs.filter(m => m.t === 'flipped')
check('판 진행', results.length === flips, `${results.length}/${flips}판, 칩 ${A.chips}`)
const expectChips = 300 + results.reduce((a, r) => a + (r.win ? 10 : -10), 0)
check('칩 = 300 + 판 결과 합', A.chips === expectChips, `${A.chips} vs ${expectChips}`)

// 너무 빠른 요청은 무시
const before = A.msgs.length
A.send({ t: 'flip', bet: 1, side: 'H' }); A.send({ t: 'flip', bet: 1, side: 'H' }); A.send({ t: 'flip', bet: 1, side: 'H' })
await sleep(400)
check('0.1초 안의 연속 요청은 하나만', A.msgs.slice(before).filter(m => m.t === 'flipped').length === 1)

// 여러 단계 판 도중에는 칩을 코인으로 못 바꿈
A.send({ t: 'start', bet: 50 })
await A.wait(m => m.t === 'started')
A.send({ t: 'cashout' })
const busyCash = await A.wait(m => m.t === 'toast')
check('판 도중 칩→코인 거절', /판이 끝난 뒤/.test(busyCash?.msg || ''), busyCash?.msg)
A.send({ t: 'finish' }); await A.wait(m => m.t === 'finished')
await sleep(200)

// 다른 게임(홀덤)에 앉으려 하면: 한 번에 한 게임
const H = client(U, '/casino/holdem/ws'); await H.open
H.send({ t: 'create', name: '테스트' })
const ht = await H.wait(m => m.t === 'toast' && /앉아 있어요/.test(m.msg))
check('칩을 들고 있으면 홀덤에 못 앉음', !!ht, ht?.msg)
H.send({ t: 'leave' }); await sleep(200); H.ws.close()

// 칩 → 코인
const chipsNow = A.chips
A.send({ t: 'cashout' })
const co = await A.wait(m => m.t === 'chips' && m.cashout !== undefined)
await sleep(300)
const after = await coins(U)
check('칩 → 코인', co?.cashout === chipsNow && after === start - 300 + chipsNow, `칩 ${chipsNow}, 코인 ${start}→${after}`)

// 판 도중 나가면 건 칩을 잃는다 (꼼수 막기)
A.send({ t: 'buyin', amount: 100 }); await A.wait(m => m.t === 'chips' && m.chips === 100)
A.send({ t: 'start', bet: 40 }); await A.wait(m => m.t === 'started')
A.send({ t: 'leave' })
await sleep(600)
const afterLeave = await coins(U)
check('판 도중 나가면 건 칩만 잃고 나머지는 코인으로', afterLeave === after - 40, `${after} → ${afterLeave}`)

// 장부 이유에 게임 이름
const led = await ledger()
const mine = led.log.filter(x => x.user === U)
check('장부 이유에 게임 이름', mine.every(x => /동전 던지기/.test(x.reason)), mine.map(x => `${x.op} ${x.amount} ${x.reason}`).join(' | '))

// 다시 칩 바꿔 판 도중에 멈춤 → (test-house-crash 단계에서 서버를 강제로 끄고 다시 켜면 건 칩까지 돌려받아야 함)
if (process.env.CRASH === '1') {
  A.send({ t: 'buyin', amount: 200 }); await A.wait(m => m.t === 'chips' && m.chips === 200)
  A.send({ t: 'start', bet: 70 }); await A.wait(m => m.t === 'started')
  console.log(JSON.stringify({ crashUser: U, coinsBefore: await coins(U), chips: A.chips, inPlay: A.inPlay }))
}
A.ws.close()
console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
