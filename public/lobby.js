// 카지노 로비: 아이소메트릭 카지노 홀을 그리고, 테이블을 누르면 그 게임으로 (CASINO.md 1장)
// 게임 상태·인원은 /casino/api/lobby, 코인은 JMTT(/auth), 파산 지원금은 /casino/api/refill. 게임 목록의 정본은 server/core/registry.mjs
import { earnHtml } from './shared/earn.js'
const $ = id => document.getElementById(id)
$('earn-note').innerHTML = earnHtml()

// ───────── 게임 상태 (API가 오기 전 기본값) ─────────
const games = {
  holdem: { title: '텍사스 홀덤', status: 'live', open: true },
  blackjack: { title: '블랙잭', status: 'wip', open: false },
  baccarat: { title: '바카라', status: 'wip', open: false },
  roulette: { title: '룰렛', status: 'wip', open: false },
  slots: { title: '슬롯머신', status: 'wip', open: false },
}
const ORDER = ['holdem', 'blackjack', 'roulette', 'baccarat', 'slots']
const fmt = n => Number(n || 0).toLocaleString('ko-KR')

// 간판 알약 글자
function pillOf(g) {
  if (g.status === 'down') return { text: '점검 중', live: false }
  if (g.status !== 'live') return { text: g.open ? '오픈 예정 · 미리보기' : '오픈 예정', live: false }
  const parts = []
  if (g.tables) parts.push(`열린 방 ${g.tables}개`)
  if (g.players) parts.push(`${g.players}명`)
  return { text: '● LIVE · ' + (parts.join(' · ') || '바로 시작'), live: true }
}

// ───────── 아이소메트릭 도구 ─────────
// 바닥 좌표 (u, v) 0~1000, 높이 z. 화면 = 아이소메트릭 투영
const C = Math.cos(Math.PI / 6), S = 0.5
// 바닥에서 45° 돌린 물체(화면 가로와 나란한 테이블)는 화면에서 가로 K배, 세로 Q배가 된다
const K = 1.2247, Q = 0.7071
const iso = (u, v, z = 0) => [(u - v) * C, (u + v) * S - z]
const r1 = n => Math.round(n * 10) / 10
const P = (pts, fill, extra = '') => `<polygon points="${pts.map(p => r1(p[0]) + ',' + r1(p[1])).join(' ')}" style="fill:${fill}" ${extra}/>`
const E = (x, y, rx, ry, fill, extra = '') => `<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="${r1(rx)}" ry="${r1(ry)}" style="fill:${fill}" ${extra}/>`
const R = (x, y, w, h, fill, extra = '') => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" style="fill:${fill}" ${extra}/>`
// 원기둥: (x, y)는 윗면 중심
const cyl = (x, y, rx, ry, h, side, top, extra = '') => E(x, y + h, rx, ry, side) + R(x - rx, y, 2 * rx, h, side) + E(x, y, rx, ry, top, extra)
// 테이블 윗면에 그리는 무늬: 바닥 단위 그대로 그리면 원근이 맞는다
const flat = (x, y, inner) => `<g transform="translate(${r1(x)} ${r1(y)}) scale(${K} ${Q})">${inner}</g>`
const spot = (x, y, rx, ry) => E(x, y, rx, ry, 'url(#spot)', 'class="spot"')

function chair(x, y) { return cyl(x, y - 30, 26, 14, 30, 'var(--chair-side)', 'var(--chair)') }
function chips(x, y, color, n = 3) {
  let s = ''
  for (let i = 0; i < n; i++) s += cyl(x, y - 6 - i * 5, 15, 6, 5, '#00000088', color, 'style="fill:' + color + ';stroke:#fff;stroke-width:1.5;stroke-dasharray:4 4"')
  return s
}
function card(x, y, label, red) {
  if (!label) return `<rect x="${x}" y="${y}" width="32" height="44" rx="4" fill="#1f3f8a" stroke="#c9d6ff" stroke-width="1.5"/>`
  return `<rect x="${x}" y="${y}" width="32" height="44" rx="4" fill="#fff8e6"/><text x="${x + 16}" y="${y + 29}" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="800" font-size="17" fill="${red ? '#c81e2c' : '#111'}">${label}</text>`
}
// ── 마우스를 올리면 움직이는 효과 (룰렛 휠처럼. 움직임은 lobby.css) ──
// 뒷면 → 앞면으로 뒤집히는 카드
const flipCard = (x, y, label, red) => `<g class="flip-down">${card(x, y)}</g><g class="flip-up">${card(x, y, label, red)}</g>`
// 통통 튀는 칩 더미 (delay로 하나씩 엇갈리게)
const hop = (inner, delay = 0) => `<g class="hop" style="animation-delay:${delay}s">${inner}</g>`
// 간판: 어두운 판 + 이름 + 상태 알약 (+ 마우스를 올리면 "입장하기")
function sign(x, y, id, { name = true } = {}) {
  const g = games[id], pill = pillOf(g)
  const pillFill = pill.live ? 'var(--live)' : 'rgba(0,0,0,.6)'
  const ink = pill.live ? '#052812' : '#e9e2cf'
  return `<g class="sign">${name ? `<rect class="plate" rx="16"/><text class="sign-t" x="${x}" y="${y}" text-anchor="middle" filter="url(#glowS)">${g.title}</text>` : ''}
    <g class="pill"><rect rx="17" style="fill:${pillFill};stroke:rgba(255,255,255,.3);stroke-width:${pill.live ? 0 : 1.5}"/>
    <text class="pill-t" x="${x}" y="${y + 46}" text-anchor="middle" dominant-baseline="central" style="fill:${ink}">${pill.text}</text></g>
    ${name ? `<text class="enter-t" x="${x}" y="${y + 100}" text-anchor="middle">입장하기 →</text>` : ''}</g>`
}
// 게임 하나를 감싸는 링크
const zone = (id, inner) => {
  const g = games[id]
  return `<a class="g ${g.status === 'live' ? 'live' : 'wip'} ${g.open ? '' : 'closed'}" href="${id}/" data-game="${id}" aria-label="${g.title} (${pillOf(g).text.replace('● ', '')})">${inner}</a>`
}

// ───────── 방 ─────────
const H = 290
function room() {
  let s = ''
  s += P([iso(0, 0), iso(0, 1000), iso(0, 1000, H), iso(0, 0, H)], 'var(--wall-l)')
  s += P([iso(0, 0), iso(1000, 0), iso(1000, 0, H), iso(0, 0, H)], 'var(--wall-r)')
  for (const t of [200, 450, 700, 950]) { // 벽 기둥 장식
    s += P([iso(0, t - 10), iso(0, t + 10), iso(0, t + 10, H), iso(0, t - 10, H)], 'var(--trim)', 'opacity=".28"')
    s += P([iso(t - 10, 0), iso(t + 10, 0), iso(t + 10, 0, H), iso(t - 10, 0, H)], 'var(--trim)', 'opacity=".28"')
  }
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { // 바닥 타일
    const u = i * 100, v = j * 100
    s += P([iso(u, v), iso(u + 100, v), iso(u + 100, v + 100), iso(u, v + 100)], (i + j) % 2 ? 'var(--floor-a)' : 'var(--floor-b)', 'stroke="var(--floor-line)" stroke-width="1.2"')
  }
  // 걸레받이 · 몰딩
  s += P([iso(0, 0), iso(0, 1000), iso(0, 1000, 14), iso(0, 0, 14)], 'var(--trim)', 'opacity=".55"')
  s += P([iso(0, 0), iso(1000, 0), iso(1000, 0, 14), iso(0, 0, 14)], 'var(--trim)', 'opacity=".55"')
  s += P([iso(0, 0, H - 16), iso(0, 1000, H - 16), iso(0, 1000, H), iso(0, 0, H)], 'var(--trim)')
  s += P([iso(0, 0, H - 16), iso(1000, 0, H - 16), iso(1000, 0, H), iso(0, 0, H)], 'var(--trim)')
  const [lx, ly] = iso(0, 860, 210) // 왼쪽 벽 간판
  s += `<g transform="matrix(${C} ${-S} 0 1 ${r1(lx)} ${r1(ly)})"><text class="wall-t" x="0" y="0" filter="url(#glow)">JMTT CASINO</text></g>`
  return s
}

// ───────── 슬롯 (뒷벽) ─────────
function slotFace() {
  let s = `<rect x="6" y="6" width="78" height="16" rx="5" style="fill:var(--slot-trim)"/>`
  for (let i = 0; i < 5; i++) s += `<circle class="bulb ${i % 2 ? 'b2' : ''}" cx="${17 + i * 14}" cy="14" r="4" fill="#fff6c8"/>`
  s += `<rect x="8" y="30" width="74" height="48" rx="5" fill="#0b0912" style="stroke:var(--slot-trim);stroke-width:2.5"/>`
  // 릴: 칸 안에서만 보이는 기호 띠. 마우스를 올리면 띠가 돌아간다 (마지막 7 = 처음 7이라 이어짐)
  const SYM = [['7', '#d0202f'], ['★', '#d39b00'], ['♦', '#2a63c4'], ['♣', '#1f9b52'], ['7', '#d0202f']]
  for (let i = 0; i < 3; i++) {
    s += `<rect x="${12 + i * 23}" y="34" width="20" height="40" rx="3" fill="#fff8e6"/>`
    s += `<svg x="${12 + i * 23}" y="34" width="20" height="40" overflow="hidden"><g class="reel r${i}">${SYM.map((m, k) =>
      `<text x="10" y="${29 + k * 40}" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="900" font-size="24" fill="${m[1]}">${m[0]}</text>`).join('')}</g></svg>`
  }
  s += `<rect x="10" y="88" width="70" height="12" rx="4" fill="#00000066"/><rect x="30" y="112" width="30" height="7" rx="3" fill="#00000088"/>`
  return s
}
function slotRight(u0) { // 오른쪽 뒷벽, 앞면은 +v
  const u1 = u0 + 90, v1 = 62, z = 150
  const [ox, oy] = iso(u0, v1, z)
  return P([iso(u0, 0, z), iso(u1, 0, z), iso(u1, v1, z), iso(u0, v1, z)], 'var(--slot-trim)')
    + P([iso(u1, 0), iso(u1, v1), iso(u1, v1, z), iso(u1, 0, z)], 'var(--slot-side)')
    + P([iso(u0, v1), iso(u1, v1), iso(u1, v1, z), iso(u0, v1, z)], 'var(--slot)')
    + `<g transform="matrix(${C} ${S} 0 1 ${r1(ox)} ${r1(oy)})">${slotFace()}</g>`
}
function slotLeft(v0) { // 왼쪽 뒷벽, 앞면은 +u
  const v1 = v0 + 90, u1 = 62, z = 150
  const [ox, oy] = iso(u1, v1, z)
  return P([iso(0, v0, z), iso(u1, v0, z), iso(u1, v1, z), iso(0, v1, z)], 'var(--slot-trim)')
    + P([iso(0, v1), iso(u1, v1), iso(u1, v1, z), iso(0, v1, z)], 'var(--slot-side)')
    + P([iso(u1, v0), iso(u1, v1), iso(u1, v1, z), iso(u1, v0, z)], 'var(--slot)')
    + `<g transform="matrix(${C} ${-S} 0 1 ${r1(ox)} ${r1(oy)})">${slotFace()}</g>`
}
function slots() {
  let s = ''
  for (const v of [130, 242]) s += slotLeft(v)
  for (const u of [110, 222, 334, 446, 558, 670]) s += slotRight(u)
  // 간판은 다른 테이블과 같은 어두운 판(이름 + 상태). 벽의 네온 글씨는 'JMTT CASINO'와 헷갈려서 쓰지 않음
  const [px, py] = iso(420, 70, 0)
  const [qx, qy] = iso(450, 40, 215) // 슬롯머신 줄 가운데 위
  return zone('slots', `${spot(px + 40, py - 10, 380, 70)}<g class="art">${s}</g>${sign(r1(qx), r1(qy), 'slots')}`)
}

// ───────── 텍사스 홀덤 (가운데) ─────────
function holdem() {
  const [x, y0] = iso(520, 520); const h = 46, y = y0 - h
  const a = 240, b = 160, rx = a * K, ry = b * Q
  const seats = []
  for (let i = 0; i < 8; i++) { const t = (i + .5) * Math.PI / 4; seats.push([x + Math.cos(t) * (a + 58) * K, y0 + Math.sin(t) * (b + 54) * Q, Math.sin(t)]) }
  let art = seats.filter(c => c[2] < 0).map(c => chair(c[0], c[1])).join('')
  art += cyl(x, y0 - 22, 120, 44, 22, 'var(--rail-side)', 'var(--rail-side)')
  art += cyl(x, y, rx, ry, 26, 'var(--rail-side)', 'var(--rail)')
  art += E(x, y, rx - 6, ry - 3, 'none', 'stroke="var(--rail-trim)" stroke-width="3" fill="none"')
  art += E(x, y, rx - 32, ry - 12, 'var(--felt)')
  art += flat(x, y, `<ellipse rx="188" ry="118" fill="none" style="stroke:var(--felt-line);stroke-width:2"/>
    <text class="felt-t" y="-72" text-anchor="middle">TEXAS HOLD'EM</text>
    ${card(-90, -24, 'K♠')}${card(-54, -24, 'Q♥', 1)}${card(-18, -24, 'J♦', 1)}${flipCard(18, -24, '10♣')}${flipCard(54, -24, 'A♠')}`)
  art += hop(chips(x - 34, y + 46, '#d0283a')) + hop(chips(x + 6, y + 50, '#2a63c4', 2), .15) + hop(chips(x + 40, y + 44, '#1f9b52', 4), .3)
  art += cyl(x + 170, y + 40, 14, 7, 4, '#999', '#fff') + `<text x="${r1(x + 170)}" y="${r1(y + 45)}" text-anchor="middle" font-size="11" font-weight="800" fill="#111">D</text>`
  art += seats.filter(c => c[2] >= 0).map(c => chair(c[0], c[1])).join('')
  return zone('holdem', spot(x, y0 + 10, rx + 120, ry + 80) + `<g class="art">${art}</g>` + sign(x, y - ry - 112, 'holdem'))
}

// ───────── 블랙잭 (오른쪽) ─────────
function blackjack() {
  const [x, y0] = iso(830, 230); const h = 40, y = y0 - h
  const a = 200, b = 150, rx = a * K, ry = b * Q
  const half = (cx, cy, rx, ry) => `M${r1(cx - rx)} ${r1(cy)} A${r1(rx)} ${r1(ry)} 0 0 0 ${r1(cx + rx)} ${r1(cy)} Z`
  let art = cyl(x, y0 - 20, 90, 30, 20, 'var(--rail-side)', 'var(--rail-side)')
  art += `<path d="${half(x, y + 24, rx, ry)}" style="fill:var(--rail-side)"/>` + R(x - rx, y, 2 * rx, 24, 'var(--rail-side)')
  art += `<path d="${half(x, y, rx, ry)}" style="fill:var(--rail)"/>`
  art += `<path d="${half(x, y + 3, rx - 28, ry - 16)}" style="fill:var(--bj-felt)"/>`
  const angs = [18, 54, 90, 126, 162].map(d => d * Math.PI / 180)
  art += flat(x, y, `${angs.map(t => `<circle cx="${r1(Math.cos(t) * 122)}" cy="${r1(Math.sin(t) * 92)}" r="14" fill="none" style="stroke:var(--felt-line);stroke-width:2"/>`).join('')}
    <text class="felt-t" y="56" text-anchor="middle" style="font-size:13px">BLACKJACK PAYS 3 TO 2</text>
    <rect x="-56" y="6" width="112" height="22" rx="4" fill="#00000055"/>
    ${card(-34, 32, 'A', 1)}${flipCard(2, 32, 'K')}`)
  art += cyl(x + 150, y + 6, 22, 10, 18, '#111', '#2b2b2b')
  // 카드 슈에서 손님 자리로 카드가 미끄러져 나감 (마우스를 올렸을 때만 보임)
  art += flat(x, y, `<g class="deal">${card(106, -14)}</g>`)
  art += angs.map(t => chair(x + Math.cos(t) * (a + 52) * K, y0 + Math.sin(t) * (b + 50) * Q)).join('')
  return zone('blackjack', spot(x, y0 + 30, rx + 60, ry + 40) + `<g class="art">${art}</g>` + sign(x, y - 112, 'blackjack'))
}

// ───────── 룰렛 (왼쪽) ─────────
function roulette() {
  const [x, y0] = iso(230, 830); const h = 40, y = y0 - h
  const hw = 165 * K, hh = 82 * Q
  let art = R(x - hw + 20, y0 - 30, 18, 30, 'var(--rail-side)') + R(x + hw - 38, y0 - 30, 18, 30, 'var(--rail-side)')
  art += R(x - hw, y + hh, 2 * hw, 26, 'var(--rail-side)', 'rx="4"')
  art += R(x - hw, y - hh, 2 * hw, 2 * hh, 'var(--rail)', 'rx="10"')
  let grid = ''
  for (let c = 0; c < 12; c++) for (let r = 0; r < 3; r++) grid += `<rect x="${4 + c * 12.5}" y="${-60 + r * 40}" width="12.5" height="40" fill="${(c + r) % 2 ? '#b3263a' : '#141414'}" style="stroke:var(--felt-line);stroke-width:1"/>`
  art += flat(x, y, `<rect x="-152" y="-72" width="304" height="144" rx="10" style="fill:var(--felt)"/>
    <rect x="-12" y="-60" width="16" height="120" fill="#1f7a3a" style="stroke:var(--felt-line);stroke-width:1"/>${grid}`)
  const wx = x - 84 * K, wy = y - 16 // 휠
  art += cyl(wx, wy, 66 * K, 66 * Q, 16, 'var(--rail-side)', 'var(--rail)')
  let sec = ''
  for (let i = 0; i < 37; i++) {
    const t0 = i / 37 * 2 * Math.PI, t1 = (i + 1) / 37 * 2 * Math.PI
    const p = [[54 * Math.cos(t0), 54 * Math.sin(t0)], [54 * Math.cos(t1), 54 * Math.sin(t1)], [38 * Math.cos(t1), 38 * Math.sin(t1)], [38 * Math.cos(t0), 38 * Math.sin(t0)]]
    sec += `<polygon points="${p.map(q => r1(q[0]) + ',' + r1(q[1])).join(' ')}" fill="${i === 0 ? '#1f9b52' : i % 2 ? '#b3263a' : '#141414'}"/>`
  }
  art += flat(wx, wy, `<g class="spin">${sec}<circle r="37" style="fill:var(--rail)"/><circle r="12" style="fill:var(--trim)"/>
    <g style="stroke:var(--trim)" stroke-width="4" stroke-linecap="round"><line x1="-26" y1="0" x2="26" y2="0"/><line x1="0" y1="-26" x2="0" y2="26"/></g>
    <circle cx="0" cy="-46" r="5" fill="#fff"/></g>`)
  return zone('roulette', spot(x, y0 + 20, hw + 60, hh + 70) + `<g class="art">${art}</g>` + sign(x, y - hh - 105, 'roulette'))
}

// ───────── 바카라 (앞 왼쪽) ─────────
function baccarat() {
  const [x, y0] = iso(650, 900); const h = 40, y = y0 - h
  const a = 180, b = 112, rx = a * K, ry = b * Q
  const angs = [24, 55, 90, 125, 156].map(d => d * Math.PI / 180)
  let art = cyl(x, y0 - 20, 90, 30, 20, 'var(--rail-side)', 'var(--rail-side)')
  art += cyl(x, y, rx, ry, 24, 'var(--rail-side)', 'var(--rail)')
  art += E(x, y, rx - 26, ry - 10, 'var(--bacc-felt)')
  art += flat(x, y, `<path d="M-120 2 Q0 70 120 2" fill="none" style="stroke:var(--felt-line);stroke-width:2"/>
    <path d="M-100 34 Q0 92 100 34" fill="none" style="stroke:var(--felt-line);stroke-width:2"/>
    <text x="0" y="-38" text-anchor="middle" class="felt-t" style="font-size:13px">TIE 8 : 1</text>
    <text x="0" y="22" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="800" font-size="17" fill="#8cc2ff" letter-spacing="3">PLAYER</text>
    <text x="0" y="62" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="800" font-size="15" fill="#ff9a9a" letter-spacing="3">BANKER</text>
    ${card(-150, -10, '9', 0)}${flipCard(118, -10, '8', 1)}`)
  art += angs.map(t => chair(x + Math.cos(t) * (a + 50) * K, y0 + Math.sin(t) * (b + 48) * Q)).join('')
  return zone('baccarat', spot(x, y0 + 30, rx + 60, ry + 40) + `<g class="art">${art}</g>` + sign(x, y - ry - 82, 'baccarat'))
}

// ───────── 캐셔 (앞 오른쪽): 코인·출석 ─────────
function cashier() {
  const [x, y0] = iso(990, 740)
  let art = R(x - 130, y0 - 196, 260, 136, 'var(--rail-side)', 'rx="6"')
  art += R(x - 130, y0 - 196, 260, 40, 'var(--trim)', 'rx="6"')
  art += `<text x="${r1(x)}" y="${r1(y0 - 167)}" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="900" font-size="25" letter-spacing="6" fill="#1a1205">CASHIER</text>`
  for (let i = 0; i < 9; i++) art += R(x - 110 + i * 27.5, y0 - 148, 3, 70, 'var(--trim)', 'opacity=".55"')
  art += R(x - 150, y0 - 92, 300, 26, 'var(--trim)', 'rx="4"')
  art += R(x - 150, y0 - 66, 300, 66, 'var(--rail)', 'rx="4"')
  art += `<text x="${r1(x)}" y="${r1(y0 - 24)}" text-anchor="middle" font-family="Pretendard,sans-serif" font-weight="800" font-size="25" fill="#ffe39b">코인 · 지원금</text>`
  art += hop(chips(x - 90, y0 - 92, '#e8c26a', 4)) + hop(chips(x - 56, y0 - 92, '#d0283a', 2), .2)
  return `<a class="g cashier" href="#cashier" data-cashier aria-label="캐셔: 코인 확인과 파산 지원금">${spot(x, y0 + 10, 230, 70)}<g class="art">${art}</g></a>`
}

// ───────── 장식: 샹들리에 ─────────
function decor() {
  const cx = 0, cy = 110
  let s = `<line x1="${cx}" y1="-330" x2="${cx}" y2="${cy - 40}" stroke="#c9a24a" stroke-width="2"/>`
  s += E(cx, cy, 90, 22, '#c9a24a') + E(cx, cy - 8, 70, 16, '#ffe6a0')
  s += E(cx, cy - 4, 140, 50, 'rgba(255,214,120,.35)', 'filter="url(#soft)"')
  for (let i = 0; i < 7; i++) {
    const lx = cx + (i - 3) * 24, ly = cy + Math.abs(i - 3) * 4 + 18
    s += `<line x1="${lx}" y1="${cy}" x2="${lx}" y2="${ly}" stroke="#c9a24a" stroke-width="1.5"/><circle cx="${lx}" cy="${ly}" r="5" fill="#fff4cf" filter="url(#glow)"/>`
  }
  return `<g pointer-events="none">${s}</g>`
}

// ───────── 그리기 (뒤 → 앞 순서) ─────────
const world = $('world')
function render() {
  world.innerHTML = room() + slots() + roulette() + blackjack() + holdem() + baccarat() + cashier() + decor()
    + `<rect x="-880" y="-330" width="1760" height="1230" fill="url(#vig)" pointer-events="none"/>`
  // 알약 크기를 글자에 맞춘다
  world.querySelectorAll('.pill').forEach(p => {
    const t = p.querySelector('text').getBBox(), r = p.querySelector('rect')
    r.setAttribute('x', t.x - 18); r.setAttribute('y', t.y - 7); r.setAttribute('width', t.width + 36); r.setAttribute('height', t.height + 14)
  })
  // 간판 판: 이름과 알약을 감싸는 어두운 판. "입장하기"는 판 바로 아래
  world.querySelectorAll('.sign').forEach(g => {
    const plate = g.querySelector('.plate'); if (!plate) return
    const a = g.querySelector('.sign-t').getBBox(), b = g.querySelector('.pill rect').getBBox()
    const x0 = Math.min(a.x, b.x) - 26, x1 = Math.max(a.x + a.width, b.x + b.width) + 26
    const y0 = a.y - 10, y1 = b.y + b.height + 14
    plate.setAttribute('x', x0); plate.setAttribute('y', y0); plate.setAttribute('width', x1 - x0); plate.setAttribute('height', y1 - y0)
    g.querySelector('.enter-t').setAttribute('y', y1 + 30)
  })
  // 좁은 화면용 목록: 열린 게임이 위로
  const list = ORDER.slice().sort((a, b) => (games[b].status === 'live') - (games[a].status === 'live'))
  $('game-list').innerHTML = list.map((id, i) => {
    const g = games[id], pill = pillOf(g)
    return `<a class="gl ${pill.live ? 'live' : ''} ${i === 0 ? 'first' : ''}" href="${id}/" data-game="${id}"><b>${id === 'holdem' ? '♠ ' : ''}${g.title}</b><span>${pill.text}</span></a>`
  }).join('')
}

// ───────── 게임으로 들어가기 ─────────
const toastEl = $('toast'); let toastT
const toast = m => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2400) }
document.addEventListener('click', e => {
  const a = e.target.closest('[data-game], [data-cashier]')
  if (!a) return
  if (a.hasAttribute('data-cashier')) { e.preventDefault(); return openCashier() }
  const g = games[a.dataset.game]
  if (!g?.open) { e.preventDefault(); toast(g?.status === 'down' ? `${g.title}은(는) 잠시 점검 중이에요` : `${g?.title || '이 게임'}은(는) 곧 열려요`) }
  // 열린 게임은 링크 그대로 이동 (/casino/<id>/)
})

// ───────── 게임 상태 · 인원 ─────────
async function loadLobby() {
  try {
    const r = await fetch('api/lobby', { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    for (const g of d.games) if (games[g.id]) Object.assign(games[g.id], g)
    const banner = $('seat-banner')
    if (d.seat && games[d.seat]) {
      banner.innerHTML = `지금 <b>${games[d.seat].title}</b>에 앉아 있어요.<a href="${d.seat}/">이어서 하기 →</a>`
      banner.hidden = false
    } else banner.hidden = true
    render()
  } catch {}
}

// ───────── 코인 · 로그인 (JMTT) ─────────
let me = null
const setCoins = n => { if (me) me.coins = n; document.querySelectorAll('.bal-v').forEach(b => { b.textContent = fmt(n) }) }
async function loadMe() {
  try {
    const r = await fetch('/auth/me?optional=1', { credentials: 'same-origin', cache: 'no-store' })
    me = r.ok ? await r.json() : null
  } catch { me = null }
  $('coins').hidden = !me
  $('login').hidden = !!me
  setCoins(me?.coins)
}

// ───────── 캐셔: 파산 지원금 (코인을 모두 잃으면 1,000코인, 하루 10번) ─────────
// 받을 수 있는지는 서버가 정한다 (GET/POST api/refill). 화면은 서버가 준 상태만 보여 준다
let refillState = null
async function loadRefill() {
  refillState = null
  try {
    const r = await fetch('api/refill', { cache: 'no-store' })
    if (r.ok) refillState = await r.json()
  } catch {}
  if (refillState) setCoins(refillState.coins)
  return refillState
}
function paintRefill() {
  const btn = $('refill'), note = $('refill-note'), s = refillState
  btn.hidden = !me; note.hidden = !me
  if (!me) return
  if (!s) { btn.disabled = true; note.textContent = '지금은 지원금 상태를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.'; return }
  btn.textContent = `${fmt(s.amount)}코인 받기`
  btn.disabled = !s.can
  const left = `오늘 <b>${s.left}번</b> 남았어요`
  note.innerHTML = s.why === 'daily_limit' ? `오늘 받을 수 있는 지원금을 다 받았어요 (하루 ${s.perDay}번). 내일 다시 받을 수 있어요.`
    : s.why === 'seated' ? `<b>${s.seat.title}</b>에 칩이 남아 있어요. 그 게임에서 칩을 코인으로 바꾼 뒤 받을 수 있어요. · ${left}`
    : s.why === 'has_coins' ? `코인이 <b>${fmt(s.maxCoins)} 이하</b>가 되면 여기서 파산 지원금 <b>${fmt(s.amount)}코인</b>을 받을 수 있어요. · ${left}`
    : `코인이 얼마 안 남았네요. 파산 지원금 <b>${fmt(s.amount)}코인</b>을 받아 다시 해 보세요. · ${left}`
}
async function openCashier() {
  $('cashier-bal').hidden = !me
  $('cashier-login').hidden = !!me
  $('cashier-note').textContent = me ? '모든 게임이 같은 JMTT 코인을 써요' : '로그인하면 코인을 받고 게임에 앉을 수 있어요'
  if (me) { $('refill').disabled = true; $('refill-note').hidden = false; $('refill-note').textContent = '확인하는 중…' }
  $('cashier').showModal()
  if (me) { await loadRefill(); paintRefill() } else paintRefill()
}
$('coins').onclick = openCashier
$('close-cashier').onclick = () => $('cashier').close()
$('refill').onclick = async e => {
  e.target.disabled = true
  let d = null, r = null
  try { r = await fetch('api/refill', { method: 'POST' }); d = await r.json() } catch {}
  if (r?.ok && d?.ok) {
    setCoins(d.balance)
    toast(`+${fmt(d.amount)} 코인 지원금을 받았어요`)
    window.JMTT?.badge?.refresh?.()
  } else {
    toast(d?.error === 'not_ready' ? '지원금은 곧 열려요. 조금만 기다려 주세요.'
      : d?.error === 'daily_limit' ? '오늘 받을 수 있는 지원금을 다 받았어요.'
      : d?.error === 'has_coins' ? `코인이 ${fmt(d.maxCoins ?? 500)} 이하일 때 받을 수 있어요.`
      : d?.error === 'seated' ? `${d.seat?.title || '다른 게임'}에 칩이 남아 있어요.`
      : '지원금을 받지 못했어요. 잠시 뒤 다시 해 주세요.')
  }
  await loadRefill(); paintRefill()
}

// 옛 홀덤 초대 링크(/casino/#방코드): 처음 열 때는 index.html이 바로 넘기고, 열린 로비에 붙여 넣은 경우는 여기서
addEventListener('hashchange', () => { if (/^#[A-Za-z0-9]{4,8}$/.test(location.hash)) location.replace('holdem/' + location.hash) })

render()
loadLobby()
// 캐셔를 바로 연다: 게임에서 "캐셔로 가기"로 온 경우(/casino/?cashier), 또는 지원금을 받을 수 있는 사람이 처음 들어온 경우(탭마다 한 번)
const wantCashier = new URLSearchParams(location.search).has('cashier')
if (wantCashier) history.replaceState(null, '', location.pathname) // 새로고침해도 다시 열리지 않게
loadMe().then(async () => {
  if (wantCashier) return openCashier()
  if (!me) return
  let shown = false
  try { shown = sessionStorage.getItem('casino:cashier-shown') === '1' } catch {}
  if (shown) return
  const s = await loadRefill()
  if (s?.can) { try { sessionStorage.setItem('casino:cashier-shown', '1') } catch {} ; openCashier() }
})
setInterval(loadLobby, 20000) // 인원 숫자 새로고침
