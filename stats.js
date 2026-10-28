// 관리자 전용 사용 통계. 보안 규칙에서 admins/{uid} 문서가 있는 계정만 데이터를 읽을 수 있다.
import * as cloud from './cloud.js?v=1.6.0'

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const DAYS = 14
const num = n => n.toLocaleString()
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—')
const signed = n => (n > 0 ? '+' : '') + n.toLocaleString()

const gate = html => { $('#gate').hidden = false; $('#gate').innerHTML = html; $('#board').hidden = true }

function dayList() {
  return Array.from({ length: DAYS }, (_, i) => cloud.dayKey(Date.now() - (DAYS - 1 - i) * 86400e3))
}

if (!cloud.enabled) gate('Firebase가 설정되지 않아서 통계를 볼 수 없어요.')
else {
  cloud.initCloud(async user => {
    if (!user) {
      $('#who').textContent = ''
      $('#refresh').hidden = true
      gate(`관리자 계정으로 로그인해 주세요.<br><br><button id="login" class="btn big google">G 구글로 로그인</button>`)
      $('#login').onclick = () => cloud.login().catch(err => {
        if (err?.code !== 'auth/popup-closed-by-user') gate('로그인하지 못했어요: ' + esc(err?.code || err))
      })
      return
    }
    $('#who').textContent = user.email || user.displayName || ''
    let admin = false
    try { admin = await cloud.isAdmin() } catch (err) { console.warn(err) }
    if (!admin) {
      gate(`관리자만 볼 수 있는 페이지예요.<br>
        아래 내 계정 ID를 Firebase 콘솔 → Firestore → <b>admins</b> 컬렉션에 문서 ID로 추가하면 볼 수 있어요.
        <code id="my-uid">${esc(user.uid)}</code>
        <button id="copy-uid" class="chip">ID 복사</button>`)
      $('#copy-uid').onclick = () => navigator.clipboard?.writeText(user.uid)
      return
    }
    $('#refresh').hidden = false
    load()
  }).catch(err => { console.warn(err); gate('Firebase에 연결하지 못했어요.') })
}

$('#refresh').onclick = () => load()

async function load() {
  gate('불러오는 중…')
  try {
    const [days, players, season] = await Promise.all([
      cloud.loadStats(dayList()), cloud.loadPlayers(), cloud.loadSeason(cloud.seasonKey(), 10),
    ])
    render(days, players, season)
  } catch (err) {
    console.warn(err)
    gate('통계를 불러오지 못했어요. 잠시 후 새로고침해 주세요.')
  }
}

function render(days, players, season) {
  const rows = days.map(d => {
    const hands = d.rooms.reduce((a, r) => a + (r.hands || 0), 0)
    const avg = d.rooms.length ? d.rooms.reduce((a, r) => a + (r.maxPlayers || 1), 0) / d.rooms.length : 0
    const fresh = d.users.filter(u => u.isNew).length
    return {
      day: d.day, label: d.day.slice(5).replace('-', '/'),
      users: d.users.length, fresh, returning: d.users.length - fresh,
      invite: d.users.filter(u => u.via === 'invite').length,
      rooms: d.rooms.length, hands, avg,
    }
  })
  const today = rows[rows.length - 1]
  const ids = list => new Set(list.flatMap(d => d.users.map(u => u.uid)))
  const lastWeek = ids(days.slice(0, 7)), thisWeek = ids(days.slice(-7))
  const cameBack = [...lastWeek].filter(id => thisWeek.has(id)).length
  const week = rows.slice(-7)
  const sum = (list, k) => list.reduce((a, r) => a + r[k], 0)

  $('#tiles').innerHTML = [
    ['오늘 접속', num(today.users), `명 · 신규 ${today.fresh}명`],
    ['최근 7일 접속', num(thisWeek.size), '명 · 중복 제외'],
    ['재방문율', pct(cameBack, lastWeek.size), `지난주 ${lastWeek.size}명 중 ${cameBack}명이 이번 주에도 옴`],
    ['초대로 들어옴', num(sum(week, 'invite')), '명 · 최근 7일'],
    ['총 가입자', num(players.total), `명 · 최근 7일 신규 ${sum(week, 'fresh')}명`],
    ['오늘 플레이', num(today.hands), `판 · 방 ${today.rooms}개`],
  ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')

  barChart($('#chart-users'), rows, [
    { key: 'returning', name: '기존', color: 'var(--bar)' },
    { key: 'fresh', name: '신규', color: 'var(--bar-2)' },
  ], '명')
  barChart($('#chart-hands'), rows, [{ key: 'hands', name: '플레이', color: 'var(--bar)' }], '판')

  $('#table').innerHTML = `<thead><tr><th>날짜</th><th>접속</th><th>신규</th><th>초대</th><th>방</th><th>판</th><th>방 평균 인원</th></tr></thead><tbody>` +
    rows.slice().reverse().map(r => `<tr><td>${r.day}</td><td>${num(r.users)}</td><td>${num(r.fresh)}</td><td>${num(r.invite)}</td><td>${num(r.rooms)}</td><td>${num(r.hands)}</td><td>${r.rooms ? r.avg.toFixed(1) + '명' : '—'}</td></tr>`).join('') +
    `</tbody>`

  $('#top').innerHTML = players.top.length
    ? players.top.map((p, i) => `<li><span class="r">${i + 1}</span><span>${esc(p.name || '이름 없음')}</span><span class="t">🪙 ${num(p.tokens || 0)}</span></li>`).join('')
    : '<li class="muted">아직 가입자가 없어요.</li>'

  $('#season-title').textContent = `이번 주 시즌 랭킹 (${season.season.slice(5).replace('-', '/')} 시작 · 참가 ${season.total}명)`
  $('#season-top').innerHTML = season.rows.length
    ? season.rows.map((p, i) => `<li><span class="r">${i + 1}</span><span>${esc(p.name || '이름 없음')} <span class="muted">${num(p.hands || 0)}판</span></span><span class="t">${signed(p.net || 0)}</span></li>`).join('')
    : '<li class="muted">아직 이번 주 기록이 없어요.</li>'

  $('#gate').hidden = true
  $('#board').hidden = false
}

// 막대 차트. series가 둘 이상이면 아래에서부터 쌓고 범례를 붙임. 마우스를 올리거나 누르면 그날 숫자
function barChart(el, rows, series, unit) {
  const total = r => series.reduce((a, s) => a + r[s.key], 0)
  const max = Math.max(1, ...rows.map(total))
  const top = max <= 5 ? max : Math.ceil(max / 5) * 5
  const legend = series.length > 1
    ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>` : ''
  el.innerHTML = legend + `<div class="chart">
      <div class="yaxis"><span>${num(top)}</span><span>${num(Math.round(top / 2))}</span><span>0</span></div>
      <div class="plot">${rows.map((r, i) => {
        const v = total(r)
        const showX = i % 2 === (rows.length - 1) % 2 // 오늘 포함 하루 걸러 날짜 표시
        const detail = series.length > 1 ? ' (' + series.map(s => `${s.name} ${num(r[s.key])}`).join(', ') + ')' : ''
        const segs = series.slice().reverse().filter(s => r[s.key])
          .map(s => `<div class="seg" style="height:${(r[s.key] / top) * 100}%;background:${s.color}"></div>`).join('')
        return `<div class="col ${v ? '' : 'zero'}" tabindex="0" data-tip="${r.label} · <b>${num(v)}${unit}</b>${detail}">
          <div class="b">${segs}</div>
          <span class="x ${showX ? '' : 'hide'}">${r.label}</span></div>`
      }).join('')}</div>
    </div>`
  const plot = el.querySelector('.plot')
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true
  plot.appendChild(tip)
  const show = col => {
    tip.innerHTML = col.dataset.tip
    tip.hidden = false
    const bar = (col.querySelector('.seg') || col.querySelector('.b')).getBoundingClientRect(), box = plot.getBoundingClientRect()
    tip.style.left = Math.min(Math.max(bar.left - box.left + bar.width / 2, 70), box.width - 70) + 'px'
    tip.style.top = Math.max(bar.top - box.top - 6, 24) + 'px'
  }
  plot.querySelectorAll('.col').forEach(col => {
    col.onmouseenter = col.onfocus = col.onclick = () => show(col)
    col.onmouseleave = col.onblur = () => { tip.hidden = true }
  })
}
