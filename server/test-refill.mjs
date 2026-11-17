// 로비 캐셔의 파산 지원금 (node test-refill.mjs, 서버는 CASINO_TEST_GAMES=1 → 테스트 게임 coinflip으로 코인을 0으로 만든다)
// 코인이 500 넘거나·다른 게임에 칩이 있으면 거절, 500 이하면 1,000, 하루 10번, 동시에 눌러도 한 번만
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
// 칩을 코인으로 돌려받고, 코인을 501 → 500으로 맞춰 경계 확인 (500 이하일 때만)
send({ t: 'cashout' }); await waitFor(m => m.t === 'chips' && m.cashout === chips)
async function burn(n) { send({ t: 'buyin', amount: n }); await waitFor(m => m.t === 'chips' && m.chips === n); send({ t: 'start', bet: n }); await waitFor(m => m.t === 'started'); send({ t: 'leave' }); await sleep(300) }
await burn(499)
s = await status()
check('코인 501이면 받을 수 없음', (await coins()) === 501 && s.why === 'has_coins' && s.maxCoins === 500, JSON.stringify(s))
c = await claim()
check('코인 501이면 받기 거절', c.code === 409 && c.error === 'has_coins')
await burn(1)
s = await status()
check('코인 500이면 받을 수 있음', (await coins()) === 500 && s.can === true, JSON.stringify(s))

// 하우스 게임에서 칩을 모두 잃은 자리(칩 0)는 "칩이 남아 있음"으로 치지 않음
send({ t: 'buyin', amount: 10 }); await waitFor(m => m.t === 'chips' && m.chips === 10)
for (let i = 0, ch = 10; i < 40 && ch > 0; i++) { // 가진 칩을 모두 걸어 질 때까지 (매번 1/2)
  send({ t: 'flip', bet: ch, side: 'H' }); const f = await waitFor(m => m.t === 'flipped'); await sleep(130)
  ch = f?.win ? ch * 2 : 0
}
s = await status()
check('칩을 모두 잃은 하우스 자리는 빈 자리로 봄', s.seat === null && s.can === true, JSON.stringify(s))
const base = await coins()
check('준비: 코인 500 이하, 자리 없음', base <= 500 && s.seat === null, `코인 ${base}`)

if (process.env.EXPECT_NO_EARN === '1') {
  c = await claim()
  check('메인 권한이 없으면 not_ready (503)', c.code === 503 && c.error === 'not_ready', JSON.stringify(c))
  check('권한이 없을 때 횟수를 쓰지 않음', (await status()).left === 10)
} else {
  s = await status()
  check('코인 500 이하·자리 없음 → 받을 수 있음', s.can === true && s.why === null && s.coins === base)
  // 동시에 세 번 → 한 번만
  const rs = await Promise.all([claim(), claim(), claim()])
  const ok = rs.filter(x => x.code === 200)
  check('동시에 세 번 눌러도 한 번만', ok.length === 1 && (await coins()) === base + 1000, rs.map(x => x.code).join(','))
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
