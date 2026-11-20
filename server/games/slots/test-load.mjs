// 로컬 부하 시험 (#부하 2026-11-20): 가짜 사용자 N명이 한꺼번에 슬롯에 붙어(재시작 뒤 몰려오는 것처럼) 계속 돌린다.
// ⚠ 로컬(mock-auth)에서만. 실제 사이트에 쓰지 않는다.
//   server 폴더에서: node dev/mock-auth.mjs  +  PORT=… JMTT_AUTH_URL=… node index.mjs  (mock-auth.mjs 맨 위 참고)
//   node games/slots/test-load.mjs [사람 수=500] [초=60] [카지노 주소=http://127.0.0.1:3200] [서버 PID(CPU·메모리 재기, 윈도우)]
// 사람마다: 칩 1,000 바꾸고 → 네 슬롯 중 하나를 골라 줄당 1로 돌림 → 결과(spun)를 받으면 연출 시간(2.6~3.6초)만큼 기다렸다 다시.
// 다섯 명 중 한 명은 바로 건너뛰기(skip)를 눌러 빨리 돌린다. 크래시는 실시간이라 빼고, 같은 서버 경로(rollJackpot·payout)를 쓴다
import WebSocket from 'ws'
import { execSync } from 'node:child_process'

const N = Number(process.argv[2]) || 500
const SEC = Number(process.argv[3]) || 60
const BASE = (process.argv[4] || 'http://127.0.0.1:3200').replace(/\/$/, '')
const PID = process.argv[5]
const WS = BASE.replace(/^http/, 'ws') + '/casino/slots/ws'
const MACHINES = [['classic', 5], ['diamond', 1], ['fruit5', 25], ['lucky', 10]]

const st = { open: 0, failed: 0, closed: 0, spins: 0, spun: 0, toasts: {}, bytes: 0, msgs: 0, lat: [], byType: {} }
const clients = []
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(WS, { headers: { Cookie: `jmtt_session=u_load${i}` } })
  const c = { ws, i, machine: MACHINES[i % 4], fast: i % 5 === 0, sentAt: 0, timer: null, ready: false }
  clients.push(c)
  const spin = () => {
    if (ws.readyState !== 1 || Date.now() - t0 > SEC * 1000) return
    c.sentAt = Date.now(); st.spins++
    ws.send(JSON.stringify({ t: 'spin', machine: c.machine[0], lineBet: 1, lines: c.machine[1] }))
  }
  ws.on('open', () => { st.open++ })
  ws.on('error', () => { st.failed++ })
  ws.on('close', () => { st.closed++ })
  ws.on('message', raw => {
    st.bytes += raw.length; st.msgs++
    const m = JSON.parse(raw)
    st.byType[m.t] = (st.byType[m.t] || [0, 0]); st.byType[m.t][0]++; st.byType[m.t][1] += raw.length
    if (m.t === 'chips' && !c.ready) {
      c.ready = true
      if (!m.chips && !m.inPlay) ws.send(JSON.stringify({ t: 'buyin', amount: 1000 }))
      setTimeout(spin, 500 + Math.random() * 2000)
    }
    if (m.t === 'spun') {
      st.spun++; st.lat.push(Date.now() - c.sentAt)
      if (c.fast) { ws.send(JSON.stringify({ t: 'skip' })); c.timer = setTimeout(spin, 900 + Math.random() * 300) }
      else c.timer = setTimeout(spin, 2600 + Math.random() * 1000)
    }
    if (m.t === 'toast') {
      st.toasts[m.msg] = (st.toasts[m.msg] || 0) + 1
      c.timer = setTimeout(spin, 1500 + Math.random() * 1000) // 거절되면 조금 쉬었다 다시
    }
  })
}

const sample = () => {
  if (!PID) return ''
  try {
    const out = execSync(`powershell -NoProfile -Command "$p = Get-Process -Id ${PID}; '{0} {1}' -f $p.CPU, $p.WorkingSet64"`, { encoding: 'utf8' }).trim().split(' ')
    return { cpu: Number(out[0]), mem: Number(out[1]) }
  } catch { return null }
}
let last = sample(), lastT = Date.now(), lastSpun = 0, lastBytes = 0
const rows = []
const tick = setInterval(() => {
  const now = Date.now(), s = sample(), dt = (now - lastT) / 1000
  const lat = st.lat.splice(0).sort((a, b) => a - b)
  const q = k => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * k))] : 0
  const cpu = s && last ? ((s.cpu - last.cpu) / dt * 100).toFixed(0) + '%' : '-'
  const row = `${((now - t0) / 1000).toFixed(0)}초 · 연결 ${st.open - st.closed}/${N} · 판 ${((st.spun - lastSpun) / dt).toFixed(0)}/초 · 응답 p50 ${q(0.5)}ms p99 ${q(0.99)}ms · 받은 데이터 ${((st.bytes - lastBytes) / dt / 1024).toFixed(0)}KB/초`
    + (s ? ` · 서버 CPU ${cpu} · 메모리 ${(s.mem / 1048576).toFixed(0)}MB` : '')
  console.log(row); rows.push(row)
  last = s; lastT = now; lastSpun = st.spun; lastBytes = st.bytes
}, 5000)

setTimeout(() => {
  clearInterval(tick)
  for (const c of clients) { clearTimeout(c.timer); if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'leave' })) }
  setTimeout(() => {
    for (const c of clients) c.ws.close()
    console.log(`\n합계: 연결 성공 ${st.open}/${N} (실패 ${st.failed}) · 보낸 판 ${st.spins} · 결과 받음 ${st.spun}`)
    console.log('거절·안내:', JSON.stringify(st.toasts))
    console.log('메시지 종류 (개수, 평균 바이트):', Object.entries(st.byType).map(([t, [n, b]]) => `${t} ${n} ${Math.round(b / n)}B`).join(' · '))
    process.exit(0)
  }, 1500)
}, SEC * 1000 + 3000)
