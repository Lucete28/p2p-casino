// 동시 접속 부하 시험 (#부하, 로컬 전용 — 실제 사이트에 하지 않는다)
//   mock-auth + 카지노 서버를 띄우고:  SERVER_PID=<카지노 node PID> N=500 SECS=40 node test-load-house.mjs
// N명이 슬롯에 붙어 2초마다 한 번씩 돌린다 (기념 칩 5,000으로). 서버 CPU·메모리, 받은 메시지 크기·횟수, 스핀 응답 시간을 잰다.
// 끝에 재시작 흉내: 모두 끊었다가 화면처럼 무작위 지연으로 다시 붙는 데 걸린 시간
import WebSocket from 'ws'
import { execSync } from 'node:child_process'
const BASE = process.env.BASE || 'http://127.0.0.1:3700'
const N = +process.env.N || 500, SECS = +process.env.SECS || 40, PID = process.env.SERVER_PID
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tag = Date.now().toString(36)

// 서버 프로세스의 CPU 시간(초)·메모리(MB). Windows는 PowerShell, 그 밖은 ps
function usage() {
  if (!PID) return null
  try {
    if (process.platform === 'win32') {
      const j = JSON.parse(execSync(`powershell -NoProfile -Command "Get-Process -Id ${PID} | Select-Object WorkingSet64,@{n='cpu';e={$_.TotalProcessorTime.TotalSeconds}} | ConvertTo-Json"`).toString())
      return { cpu: j.cpu, mb: j.WorkingSet64 / 1048576 }
    }
    const [rss, t] = execSync(`ps -o rss=,time= -p ${PID}`).toString().trim().split(/\s+/)
    const s = t.split(/[:-]/).map(Number).reduce((a, x) => a * 60 + x, 0)
    return { cpu: s, mb: rss / 1024 }
  } catch { return null }
}

const stats = { bytes: 0, msgs: 0, spins: 0, lat: [], fail: 0, full: 0 }
function client(i) {
  return new Promise(res => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/casino/slots/ws', { headers: { Cookie: `jmtt_session=u_load_${tag}_${i}` } })
    const c = { ws, chips: 0, sentAt: 0 }
    ws.on('message', raw => {
      stats.bytes += raw.length; stats.msgs++
      const d = JSON.parse(raw)
      if (d.t === 'chips') c.chips = d.chips
      if (d.t === 'full') stats.full++
      if (d.t === 'spun' || d.t === 'toast') { if (c.sentAt) { stats.lat.push(Date.now() - c.sentAt); c.sentAt = 0 } if (d.t === 'spun') stats.spins++ }
    })
    ws.on('open', () => res(c))
    ws.on('error', () => { stats.fail++; res(null) })
  })
}

const u0 = usage(), t0 = Date.now()
const clients = []
for (let i = 0; i < N; i += 50) clients.push(...await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, k) => client(i + k))))
const live = clients.filter(Boolean)
console.log(`접속 ${live.length}/${N} (${((Date.now() - t0) / 1000).toFixed(1)}초), 실패 ${stats.fail}, 꽉 참 ${stats.full}`)
await sleep(1500)
const u1 = usage(); stats.bytes = 0; stats.msgs = 0; stats.lat = []
const peak = { mb: u1?.mb || 0 }
const t1 = Date.now()
// 2초마다 한 번, 사람마다 시작 시점을 흩는다
const timers = live.map((c, i) => setTimeout(function spin() {
  if (c.ws.readyState === 1 && c.chips >= 5) { c.sentAt = Date.now(); c.ws.send(JSON.stringify({ t: 'spin', machine: 'classic', lineBet: 1, lines: 5 })) }
  c.timer = setTimeout(spin, 2000)
}, (i / live.length) * 2000))
const sampler = setInterval(() => { const u = usage(); if (u && u.mb > peak.mb) peak.mb = u.mb }, 2000)
await sleep(SECS * 1000)
clearInterval(sampler); live.forEach(c => clearTimeout(c.timer)); timers.forEach(clearTimeout)
const u2 = usage(), secs = (Date.now() - t1) / 1000
const lat = stats.lat.sort((a, b) => a - b), pct = p => lat[Math.floor(lat.length * p)] ?? 0
console.log(`${secs.toFixed(0)}초 동안 스핀 ${stats.spins} (초당 ${(stats.spins / secs).toFixed(0)})`)
console.log(`응답(돌림→결과 메시지) 중앙 ${pct(0.5)}ms · 95% ${pct(0.95)}ms · 99% ${pct(0.99)}ms`)
console.log(`받은 메시지: 한 사람당 초당 ${(stats.msgs / live.length / secs).toFixed(2)}개, ${(stats.bytes / live.length / secs / 1024).toFixed(2)}KB/s · 전체 ${(stats.bytes / secs / 1024).toFixed(0)}KB/s`)
if (u1 && u2) {
  console.log(`서버 CPU 평균 ${((u2.cpu - u1.cpu) / secs * 100).toFixed(0)}% (한 코어 = 100%) · 메모리 접속 전 ${u0.mb.toFixed(0)}MB → 최대 ${peak.mb.toFixed(0)}MB (한 사람당 약 ${((peak.mb - u0.mb) / live.length * 1024).toFixed(0)}KB)`)
}

// 재시작 흉내: 모두 끊고, 화면처럼 2~10초 무작위 지연 뒤 다시 붙기
live.forEach(c => c.ws.terminate())
await sleep(1000)
const t3 = Date.now(); stats.fail = 0
const back = await Promise.all(live.map((_, i) => sleep(2000 + Math.random() * 8000).then(() => client(i))))
console.log(`다시 붙기: ${back.filter(Boolean).length}/${live.length}, ${((Date.now() - t3) / 1000).toFixed(1)}초, 실패 ${stats.fail}`)
back.forEach(c => c?.ws.close())
await sleep(500)
process.exit(0)
