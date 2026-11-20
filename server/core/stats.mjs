// 관리 통계 (#통계, home-server ADMIN_GUIDE). 메인이 세는 것(접속·방문·코인 발행)은 세지 않고 카지노만 아는 숫자만:
//   게임별 하루 판 수 · 건 칩 · 돌려준 칩(→ 하우스 몫) · 판을 한 사람 수, 홀덤 핸드 수, 파산 지원금·기념 칩 횟수, 지금 앉은 사람
// 부하 규칙 (ADMIN_GUIDE 0-1): 판마다 메모리 카운터만 올리고, 1분마다 날짜×게임 한 줄씩 저장. 요약은 1분마다 미리 계산해 둔다
import { kstDay } from './store.mjs'

const MAX = Number.MAX_SAFE_INTEGER
const add = (a, b) => Math.min(MAX, a + b) // 합계도 정확히 셀 수 있는 크기 안에서 (#규모)
const KEEP_DAYS = 400
const USER_CAP = 20000 // 하루 사람 집합 상한 (넘으면 그 뒤로는 사람 수를 더 늘리지 않음)

export function openStats(store, { titleOf, liveSeats, jackpot }) {
  const db = store.db
  db.exec(`CREATE TABLE IF NOT EXISTS daily_stats (
    day TEXT NOT NULL, game TEXT NOT NULL, rounds INTEGER NOT NULL DEFAULT 0, bet INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,
    players INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, game))`)
  const mem = new Map() // 'day|game' → { day, game, rounds, bet, paid, users: Set, saved: 사람 수를 저장한 값 }

  // 하우스 게임 판 끝 (house.mjs의 ctx.payout)
  function round(game, user, bet, paid) {
    const day = kstDay(), k = day + '|' + game
    let m = mem.get(k)
    if (!m) mem.set(k, m = { day, game, rounds: 0, bet: 0, paid: 0, users: new Set() })
    m.rounds++; m.bet = add(m.bet, bet || 0); m.paid = add(m.paid, paid || 0)
    if (m.users.size < USER_CAP) m.users.add(user)
  }

  // 1분마다: 쌓인 만큼 더해 저장 (한 트랜잭션). 사람 수는 그날 집합 크기와 저장된 값 중 큰 쪽 (재시작하면 그날 사람 수는 적게 셀 수 있음)
  const upsert = db.prepare(`INSERT INTO daily_stats (day, game, rounds, bet, paid, players) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, game) DO UPDATE SET rounds = rounds + excluded.rounds, bet = MIN(bet + excluded.bet, ${MAX}), paid = MIN(paid + excluded.paid, ${MAX}),
    players = MAX(players, excluded.players)`)
  function save() {
    if (![...mem.values()].some(m => m.rounds)) return
    db.exec('BEGIN')
    try {
      for (const [k, m] of mem) {
        if (m.rounds) upsert.run(m.day, m.game, m.rounds, m.bet, m.paid, m.users.size)
        m.rounds = 0; m.bet = 0; m.paid = 0
        if (m.day !== kstDay()) mem.delete(k) // 지난 날 집합은 비운다
      }
      db.exec('COMMIT')
    } catch (err) { db.exec('ROLLBACK'); console.warn('stats save', err.message) }
  }

  // 요약 (1분마다 미리 계산). 표 크기는 하루 몇 줄이라 훑어도 가볍다
  let cache = null
  function compute() {
    const today = kstDay(), days = Array.from({ length: 14 }, (_, i) => kstDay(Date.now() - (13 - i) * 86400e3))
    const from = days[0]
    const rows = db.prepare('SELECT day, game, rounds, bet, paid, players FROM daily_stats WHERE day >= ?').all(kstDay(Date.now() - 29 * 86400e3))
    const hands = Object.fromEntries(db.prepare('SELECT day, SUM(hands) n FROM rooms WHERE day >= ? GROUP BY day').all(from).map(r => [r.day, r.n || 0]))
    const countBy = (sql, ...a) => Object.fromEntries(db.prepare(sql).all(...a).map(r => [r.day, r.n]))
    const refills = countBy('SELECT day, COUNT(*) n FROM refills WHERE day >= ? GROUP BY day', from)
    const gifts = {} // 기념 칩 (welcome.at → 한국 날짜)
    for (const r of db.prepare('SELECT at FROM welcome WHERE at >= ?').all(Date.now() - 15 * 86400e3)) { const d = kstDay(r.at); gifts[d] = (gifts[d] || 0) + 1 }
    // 저장 전 메모리 몫도 더해 보여 준다
    const all = rows.map(r => ({ ...r }))
    for (const m of mem.values()) {
      const r = all.find(x => x.day === m.day && x.game === m.game)
      if (r) { r.rounds += m.rounds; r.bet = add(r.bet, m.bet); r.paid = add(r.paid, m.paid); r.players = Math.max(r.players, m.users.size) }
      else if (m.rounds || m.users.size) all.push({ day: m.day, game: m.game, rounds: m.rounds, bet: m.bet, paid: m.paid, players: m.users.size })
    }
    const sum = (day, f) => all.filter(r => r.day === day).reduce((a, r) => add(a, r[f]), 0)
    const yesterday = days[12]
    const roundsOf = d => sum(d, 'rounds') + (hands[d] || 0)
    const edge = d => sum(d, 'bet') - sum(d, 'paid')
    cache = {
      at: Date.now(), today, days, rows: all.sort((a, b) => b.day.localeCompare(a.day) || a.game.localeCompare(b.game)),
      hands, refills, gifts,
      summary: [
        { label: '오늘 판 (모든 게임)', value: roundsOf(today), hint: `어제 ${roundsOf(yesterday).toLocaleString('ko-KR')}` },
        { label: '오늘 홀덤 핸드', value: hands[today] || 0 },
        { label: '오늘 하우스 몫 (칩)', value: edge(today), hint: '건 칩 − 돌려준 칩 (홀덤 빼고)' },
        { label: '지금 앉은 사람', value: liveSeats() },
        { label: '오늘 파산 지원금', value: refills[today] || 0, hint: `어제 ${refills[yesterday] || 0}번` },
        { label: '오늘 슬롯 기념 칩', value: gifts[today] || 0, hint: '처음 온 사람' },
        ...(jackpot() != null ? [{ label: '모두의 잭팟', value: jackpot() }] : []),
      ].slice(0, 8),
      daily: { label: '판 수 (모든 게임)', days, values: days.map(roundsOf) },
      page: '/casino/admin/stats',
    }
    return cache
  }
  const tick = () => { try { save(); compute() } catch (err) { console.warn('stats', err.message) } }
  setInterval(tick, 60000).unref()
  setInterval(() => { try { db.prepare('DELETE FROM daily_stats WHERE day < ?').run(kstDay(Date.now() - KEEP_DAYS * 86400e3)) } catch {} }, 24 * 3600e3).unref()

  return {
    round, save,
    summary: () => { const c = cache || compute(); return { summary: c.summary, daily: c.daily, page: c.page } },
    detail: () => cache || compute(),
    refresh: compute,
  }
}

// 앱 통계 페이지 (운영자만, 서버가 저장된 합계로 그린다 — 브라우저 스크립트 없음)
export function statsPage(d, titleOf) {
  const n = v => Number(v || 0).toLocaleString('ko-KR')
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const tiles = d.summary.map(s => `<div class="t"><small>${esc(s.label)}</small><b>${typeof s.value === 'number' ? n(s.value) : esc(s.value)}</b>${s.hint ? `<span>${esc(s.hint)}</span>` : ''}</div>`).join('')
  const max = Math.max(1, ...d.daily.values)
  const bars = d.daily.days.map((day, i) => `<div class="bar" title="${day} · ${n(d.daily.values[i])}판"><i style="height:${Math.round(d.daily.values[i] / max * 100)}%"></i><small>${day.slice(5)}</small></div>`).join('')
  const rows = d.rows.map(r => `<tr><td>${r.day}</td><td>${esc(titleOf(r.game))}</td><td>${n(r.rounds)}</td><td>${n(r.players)}</td><td>${n(r.bet)}</td><td>${n(r.paid)}</td><td>${n(r.bet - r.paid)}</td><td>${r.bet ? ((1 - r.paid / r.bet) * 100).toFixed(2) + '%' : '—'}</td></tr>`).join('')
  const other = d.days.slice().reverse().map(day => `<tr><td>${day}</td><td>${n(d.hands[day])}</td><td>${n(d.refills[day])}</td><td>${n(d.gifts[day])}</td></tr>`).join('')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>카지노 통계 · JMTT</title>
<style>body{margin:0;background:#070706;color:#f3ead7;font:14px/1.5 Pretendard,system-ui,sans-serif;padding:16px}a{color:#e8c26a}h1{font-size:20px;color:#e8c26a;margin:12px 0}h2{font-size:16px;margin:24px 0 8px}
.nav{display:flex;gap:16px;flex-wrap:wrap}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.t{border:1px solid rgba(232,194,106,.3);border-radius:12px;padding:10px 12px}.t small{display:block;color:#a99f8a}.t b{font-size:20px}.t span{display:block;color:#a99f8a;font-size:12px}
.chart{display:flex;align-items:flex-end;gap:4px;height:140px;border-bottom:1px solid rgba(255,255,255,.15)}.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;text-align:center}.bar i{display:block;background:#e8c26a;border-radius:3px 3px 0 0;min-height:1px}.bar small{color:#a99f8a;font-size:10px}
.wrap{overflow-x:auto}table{border-collapse:collapse;min-width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:right;white-space:nowrap}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{color:#a99f8a;font-weight:600}.note{color:#a99f8a;font-size:12px}</style></head><body>
<div class="nav"><a href="/admin">← JMTT 관리</a><a href="/casino/">카지노 로비</a><a href="/casino/holdem/stats.html">홀덤 자세한 통계 →</a></div>
<h1>카지노 통계</h1><div class="tiles">${tiles}</div>
<h2>${esc(d.daily.label)} · 최근 14일</h2><div class="chart">${bars}</div>
<h2>하우스 게임 (최근 30일, 날짜 × 게임)</h2><div class="wrap"><table><tr><th>날짜</th><th>게임</th><th>판</th><th>사람</th><th>건 칩</th><th>돌려준 칩</th><th>하우스 몫</th><th>몫 %</th></tr>${rows || '<tr><td colspan="8">아직 기록이 없어요</td></tr>'}</table></div>
<h2>홀덤·캐셔 (최근 14일)</h2><div class="wrap"><table><tr><th>날짜</th><th>홀덤 핸드</th><th>파산 지원금</th><th>슬롯 기념 칩</th></tr>${other}</table></div>
<p class="note">1분마다 모아 저장한 합계예요. 접속·방문·코인 발행은 JMTT 관리 페이지에 있어요. 서버가 다시 켜진 날은 '사람' 수가 적게 나올 수 있어요.</p>
</body></html>`
}
