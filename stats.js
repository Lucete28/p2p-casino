// 관리자 전용 사용 통계 (v1.8.0~: 카지노 서버가 모은 숫자). 서버의 CASINO_ADMINS에 있는 JMTT 사용자만 볼 수 있다
import * as cloud from './cloud.js?v=1.8.4'

const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const num = n => (n || 0).toLocaleString()
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—')
const signed = n => (n > 0 ? '+' : '') + n.toLocaleString()

const gate = html => { $('#gate').hidden = false; $('#gate').innerHTML = html; $('#board').hidden = true }

;(async () => {
  const r = await cloud.me()
  if (r.state === 'down') return gate('로그인 서버를 점검하고 있어요. 잠시 뒤 다시 열어 주세요.')
  if (!r.me) {
    $('#who').textContent = ''
    $('#refresh').hidden = true
    gate(`관리자 계정으로 로그인해 주세요.<br><br><button id="login" class="jmtt-google dark" type="button"><img src="/google-g.svg" alt="" width="18" height="18"><span>Google로 로그인</span></button>`)
    $('#login').onclick = () => cloud.loginRedirect()
    return
  }
  $('#who').textContent = r.me.name || ''
  load(r.me)
})()

$('#refresh').onclick = () => load()

async function load(me) {
  gate('불러오는 중…')
  try {
    const st = await cloud.loadStats()
    $('#refresh').hidden = false
    render(st)
  } catch (err) {
    if (err.status === 403) {
      const id = err.body?.id || me?.id || ''
      gate(`관리자만 볼 수 있는 페이지예요.<br>
        아래 내 JMTT 계정 ID를 서버 세션에 알려 카지노 서버의 <b>CASINO_ADMINS</b>에 넣으면 볼 수 있어요.
        <code id="my-uid">${esc(id)}</code>
        <button id="copy-uid" class="chip">ID 복사</button>`)
      $('#copy-uid').onclick = () => navigator.clipboard?.writeText(id)
      return
    }
    console.warn(err)
    gate('통계를 불러오지 못했어요. 잠시 후 새로고침해 주세요.')
  }
}

function render(st) {
  const rows = st.days.map(d => ({ ...d, label: d.day.slice(5).replace('-', '/'), returning: d.users - d.fresh, avg: d.avgPlayers }))
  const today = rows[rows.length - 1]
  const week = rows.slice(-7)
  const sum = (list, k) => list.reduce((a, r) => a + r[k], 0)

  $('#tiles').innerHTML = [
    ['오늘 접속', num(today.users), `명 · 신규 ${today.fresh}명`],
    ['최근 7일 접속', num(st.week), '명 · 중복 제외'],
    ['재방문율', pct(st.cameBack, st.lastWeek), `지난주 ${st.lastWeek}명 중 ${st.cameBack}명이 이번 주에도 옴`],
    ['지금 접속', num(st.live.players), `명 · 열린 방 ${st.live.rooms}개`],
    ['총 가입자', num(st.totalUsers), `명 · 최근 7일 신규 ${sum(week, 'fresh')}명`],
    ['오늘 플레이', num(today.hands), `판 · 방 ${today.rooms}개`],
  ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')

  barChart($('#chart-users'), rows, [
    { key: 'returning', name: '기존', color: 'var(--bar)' },
    { key: 'fresh', name: '신규', color: 'var(--bar-2)' },
  ], '명')
  barChart($('#chart-hands'), rows, [{ key: 'hands', name: '플레이', color: 'var(--bar)' }], '판')

  $('#table').innerHTML = `<thead><tr><th>날짜</th><th>접속</th><th>신규</th><th>방</th><th>판</th><th>방 평균 인원</th></tr></thead><tbody>` +
    rows.slice().reverse().map(r => `<tr><td>${r.day}</td><td>${num(r.users)}</td><td>${num(r.fresh)}</td><td>${num(r.rooms)}</td><td>${num(r.hands)}</td><td>${r.rooms ? r.avg.toFixed(1) + '명' : '—'}</td></tr>`).join('') +
    `</tbody>`

  const season = st.season
  $('#top').innerHTML = season.rows.length
    ? season.rows.map((p, i) => `<li><span class="r">${i + 1}</span><span>${esc(p.name || '이름 없음')} <span class="muted">${num(p.hands)}판</span></span><span class="t">${signed(p.net || 0)}</span></li>`).join('')
    : '<li class="muted">아직 이번 달 기록이 없어요.</li>'
  $('#season-title').textContent = `${+season.season.slice(5, 7)}월 시즌 랭킹 (참가 ${season.total}명, 코인 순이익)`
  $('#season-top').innerHTML = $('#top').innerHTML

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
