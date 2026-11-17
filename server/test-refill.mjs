// 로비 캐셔의 파산 지원금 (node test-refill.mjs, 서버는 CASINO_TEST_GAMES=1 → 테스트 게임 coinflip으로 코인을 0으로 만든다)
// 코인이 남았거나·다른 게임에 칩이 있으면 거절, 0이면 1,000, 하루 10번, 동시에 눌러도 한 번만
// 메인에 earn 권한이 없는 상태(mock을 MOCK_NO_EARN=1로)에서는 EXPECT_NO_EARN=1 로 돌려 'not_ready'를 확인
import WebSocket from 'ws'
const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
const U = 'u_refill_' + Date.now().toString(36)
const H = { Cookie: `jmtt_session=${U}` }
const ledger = async () => (await (await fetch(BASE + '/auth/_ledger')).json())
const coins = async () => (await ledger()).ledger[U] ?? 1000
const status = async () => (await fetch(BASE + '/casino/api/refill', { headers: H })).json()
const claim = async () => { const r = await fetch(BASE + '/casino/api/refill', { method: 'POST', headers: H }); return { code: r.status, ...(await r.json()) } }

// 코인플립 테스트 게임으로 칩을 사고(→ 코인 0, 자리 있음) / 판 도중 나가서 모두 잃기(→ 코인 0, 자리 없음)
const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/coinflip/ws', { headers: H })
const msgs = []
ws.on('message', m => msgs.push(JSON.parse(m)))
await new Promise((res, rej) => { ws.on('open', res); ws.on('unexpected-response', (_, r) => rej(new Error('http ' + r.statusCode))) })
const send = m => ws.send(JSON.stringify(m))
const waitFor = async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = msgs.findIndex(pred); if (i >= 0) return msgs.splice(i, 1)[0]; await sleep(30) } return null }
async function buyAll() { const c = await coins(); send({ t: 'buyin', amount: c }); await waitFor(m => m.t === 'chips' && m.chips === c); return c }
async function loseAll() { const c = await buyAll(); send({ t: 'start', bet: c }); await waitFor(m => m.t === 'started'); send({ t: 'leave' }); await sleep(300) }

let r = await fetch(BASE + '/casino/api/refill')
check('로그인 안 하면 401', r.status === 401)

let s = await status()
check('코인이 있으면 받을 수 없음 (상태)', s.can === false && s.why === 'has_coins' && s.left === 10 && s.amount === 1000, JSON.stringify(s))
let c = await claim()
check('코인이 있으면 받을 수 없음 (받기)', c.code === 409 && c.error === 'has_coins', JSON.stringify(c))

const chips = await buyAll()
s = await status()
check('코인 0이어도 게임에 칩이 있으면 거절', s.can === false && s.why === 'seated' && s.seat?.title?.includes('동전'), JSON.stringify(s))
c = await claim()
check('칩이 있을 때 받기 거절', c.code === 409 && c.error === 'seated')
// 칩을 모두 걸고 판 도중 나가기 → 코인 0, 자리 없음
send({ t: 'start', bet: chips }); await waitFor(m => m.t === 'started')
send({ t: 'leave' }); await sleep(300)
check('준비: 코인 0, 자리 없음', (await coins()) === 0 && (await status()).seat === null)

if (process.env.EXPECT_NO_EARN === '1') {
  c = await claim()
  check('메인 권한이 없으면 not_ready (503)', c.code === 503 && c.error === 'not_ready', JSON.stringify(c))
  check('권한이 없을 때 횟수를 쓰지 않음', (await status()).left === 10)
} else {
  s = await status()
  check('코인 0·자리 없음 → 받을 수 있음', s.can === true && s.why === null && s.coins === 0)
  // 동시에 세 번 → 한 번만
  const rs = await Promise.all([claim(), claim(), claim()])
  const ok = rs.filter(x => x.code === 200)
  check('동시에 세 번 눌러도 한 번만', ok.length === 1 && (await coins()) === 1000, rs.map(x => x.code).join(','))
  check('남은 횟수 9', (await status()).left === 9)
  // 하루 10번까지
  for (let i = 2; i <= 10; i++) { await loseAll(); const x = await claim(); if (x.code !== 200) { check(`${i}번째 받기`, false, JSON.stringify(x)); break } }
  await loseAll()
  c = await claim()
  check('하루 10번 다 받으면 거절', c.code === 429 && c.error === 'daily_limit', JSON.stringify(c))
  s = await status()
  check('상태: daily_limit, 남은 0', s.why === 'daily_limit' && s.left === 0)
  const led = (await ledger()).log.filter(x => x.user === U && x.op === 'earn')
  check('장부: 지원금 10번, 각 1,000, 이유 "카지노 파산 지원"', led.length === 10 && led.every(x => x.amount === 1000 && x.reason === '카지노 파산 지원'), `${led.length}번`)
  check('ref가 모두 다름', new Set(led.map(x => x.ref)).size === 10)
}
ws.close()
console.log(out.join('\n'))
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
