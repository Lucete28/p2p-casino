// 블랙잭 부하 흉내 (#부하, 2026-11-20): 로컬에서만. 소켓 N개를 열고, 한 상태 변경(베팅 하나)이 몇 명에게 몇 바이트로 퍼지는지 잰다
//   BASE=http://127.0.0.1:3100 N=500 node server/games/blackjack/test-load.mjs
// 실제 사이트에는 돌리지 않는다 (주소가 127.0.0.1·localhost가 아니면 멈춤)
import WebSocket from 'ws'

const BASE = process.env.BASE || 'http://127.0.0.1:3100'
const N = Number(process.env.N) || 500
const host = new URL(BASE).hostname
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) { console.error('로컬에서만 돌려요:', BASE); process.exit(1) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tag = Date.now().toString(36)

function client(user) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/blackjack/ws', { headers: { Cookie: `jmtt_session=${user}` } })
  const c = { user, ws, n: 0, bytes: 0, last: null, chips: 0 }
  ws.on('message', raw => {
    const s = raw.toString()
    const d = JSON.parse(s)
    if (d.t === 'chips') c.chips = d.chips
    if (d.t !== 'state') return
    c.n++; c.bytes += Buffer.byteLength(s); c.last = d
  })
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  c.send = m => ws.send(JSON.stringify(m))
  return c
}

const t0 = performance.now()
const all = []
for (let i = 0; i < N; i++) {
  all.push(client(`u_load_${tag}_${i}`))
  if (i % 50 === 49) await Promise.all(all.slice(-50).map(c => c.open)) // 50개씩 열기
}
await Promise.all(all.map(c => c.open))
await sleep(1500)
const openMs = Math.round(performance.now() - t0)

// 사람들이 어떻게 나뉘었나 (테이블마다 인원)
const byTable = new Map()
for (const c of all) if (c.last) byTable.set(c.last.table, (byTable.get(c.last.table) || 0) + 1)
const lobby = await (await fetch(BASE + '/casino/api/lobby')).json()
const bj = lobby.games.find(g => g.id === 'blackjack')

const fan = () => { const got = all.filter(c => c.n > 0); return { people: got.length, msgs: got.reduce((a, c) => a + c.n, 0), bytes: got.reduce((a, c) => a + c.bytes, 0) } }
const line = (name, f) => console.log(`${name}: 받은 사람 ${f.people}명 · 메시지 ${f.msgs}개 · ${(f.bytes / 1024).toFixed(1)}KB (한 개 평균 ${Math.round(f.bytes / Math.max(1, f.msgs))}B)`)

// (1) 한 사람이 더 들어옴 (관전 시작) → 그때 퍼진 메시지
for (const c of all) { c.n = 0; c.bytes = 0 }
const late = client(`u_load_${tag}_late`)
await late.open
await sleep(1000)
const joinFan = fan()

// (2) 한 사람이 칩을 바꾸고 베팅 (앉으면서 베팅 = 상태 변경 1번). 베팅 시간이 될 때까지 기다림
const p = all[0]
p.send({ t: 'buyin', amount: 100 })
for (let i = 0; i < 50 && p.chips < 100; i++) await sleep(100)
for (let i = 0; i < 300 && p.last?.phase !== 'bet'; i++) await sleep(100)
for (const c of all) { c.n = 0; c.bytes = 0 }
p.send({ t: 'bet', amount: 10 })
await sleep(1000)
const betFan = fan()
const sameTable = all.filter(c => c.last?.table === p.last?.table).length

console.log(`소켓 ${N}개 열기 ${openMs}ms · 테이블 ${byTable.size}개 (로비 ${bj.players}명 · ${bj.tables}테이블)`)
console.log(`테이블별 인원: ${[...byTable.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}번 ${n}`).join(', ')}`)
line('한 명 더 들어옴', joinFan)
line(`베팅 1번 (같은 테이블 ${sameTable}명)`, betFan)
console.log(`한 판(상태 변경 약 15번)이면 이 테이블에 약 ${(betFan.bytes * 15 / 1024 / 1024).toFixed(2)}MB`)

late.ws.close()
p.send({ t: 'bet', amount: 0 })
for (const c of all) c.ws.close()
await sleep(500)
process.exit(0)
