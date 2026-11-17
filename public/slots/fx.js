// 슬롯 당첨 연출 (보여 주기만. 결과·칩과는 상관없음 → 여기의 Math.random은 그림 흩뿌리기용)
//   burst(x, y, n, opts)      그 자리에서 동전·색종이가 터져 나옴 (캔버스 하나)
//   fountain(ms, opts)        화면 아래에서 동전이 계속 솟음 (빅윈·잭팟)
//   flyCoins(from, to, n)     당첨 칸에서 윗줄 칩 표시로 동전이 날아감
//   floatText(box, x, y, txt) "+120" 같은 글자가 떠오르며 사라짐
//   shake(el, strength)       화면 흔들기
//   celebrate({...})          BIG WIN · MEGA WIN · JACKPOT 전체 화면

export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const rnd = (a, b) => a + Math.random() * (b - a)

// ---------- 캔버스 입자 ----------
const cv = document.createElement('canvas')
cv.className = 'sl-fx'
cv.setAttribute('aria-hidden', 'true')
document.body.append(cv)
const g = cv.getContext('2d')
let W = 0, H = 0, dpr = 1
function size() {
  dpr = Math.min(2, devicePixelRatio || 1)
  W = innerWidth; H = innerHeight
  cv.width = W * dpr; cv.height = H * dpr
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
}
size()
addEventListener('resize', size)

const parts = []
let raf = 0, last = 0
const CONFETTI = ['#ffd36b', '#ff5a6a', '#4ade80', '#5ac8ff', '#e07bff', '#fff1b8']

function add(p) { parts.push(p); if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick) } }

export function burst(x, y, n = 20, { power = 1, confetti = 0 } = {}) {
  if (reduced) return
  for (let i = 0; i < n; i++) {
    const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05), v = rnd(260, 620) * power
    add({ kind: 'coin', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: rnd(7, 12), spin: rnd(6, 14), t: rnd(0, 6), life: rnd(1.4, 2.2) })
  }
  for (let i = 0; i < confetti; i++) {
    const a = rnd(-Math.PI, 0), v = rnd(200, 700) * power
    add({ kind: 'conf', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: rnd(6, 10), h: rnd(3, 6), rot: rnd(0, 6), vr: rnd(-12, 12), c: CONFETTI[i % CONFETTI.length], life: rnd(2, 3.2), drag: true })
  }
}

let fountainUntil = 0, fountainOpts = {}
export function fountain(ms, opts = {}) {
  if (reduced) return
  fountainUntil = performance.now() + ms
  fountainOpts = opts
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick) }
}
export function stopFountain() { fountainUntil = 0 }

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now
  if (now < fountainUntil) {
    const k = fountainOpts.rate || 3
    for (let i = 0; i < k; i++) {
      const x = rnd(W * 0.1, W * 0.9)
      add({ kind: 'coin', x, y: H + 20, vx: rnd(-120, 120), vy: -rnd(H * 1.1, H * 1.6), r: rnd(8, 14), spin: rnd(6, 14), t: rnd(0, 6), life: 3 })
      if (fountainOpts.confetti && Math.random() < 0.5) add({ kind: 'conf', x: rnd(0, W), y: -10, vx: rnd(-60, 60), vy: rnd(40, 160), w: rnd(6, 10), h: rnd(3, 6), rot: rnd(0, 6), vr: rnd(-10, 10), c: CONFETTI[(Math.random() * 6) | 0], life: 4, drag: true })
    }
  }
  g.clearRect(0, 0, W, H)
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    p.life -= dt
    if (p.life <= 0 || p.y > H + 60) { parts.splice(i, 1); continue }
    if (p.drag) { p.vx *= 0.985; p.vy = Math.min(p.vy + 380 * dt, 180) } else p.vy += 1100 * dt
    p.x += p.vx * dt; p.y += p.vy * dt
    g.globalAlpha = Math.min(1, p.life * 2)
    if (p.kind === 'coin') {
      p.t += p.spin * dt
      const sx = Math.abs(Math.cos(p.t)) * 0.85 + 0.15 // 빙글 도는 동전
      g.save(); g.translate(p.x, p.y); g.scale(sx, 1)
      const gr = g.createRadialGradient(-p.r * 0.35, -p.r * 0.35, 1, 0, 0, p.r)
      gr.addColorStop(0, '#fff3c0'); gr.addColorStop(0.45, '#eec767'); gr.addColorStop(1, '#9c7425')
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, p.r, 0, Math.PI * 2); g.fill()
      g.strokeStyle = 'rgba(122,90,26,.8)'; g.lineWidth = 1.5; g.beginPath(); g.arc(0, 0, p.r * 0.68, 0, Math.PI * 2); g.stroke()
      g.restore()
    } else {
      p.rot += p.vr * dt
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore()
    }
  }
  g.globalAlpha = 1
  if (parts.length || now < fountainUntil) raf = requestAnimationFrame(tick)
  else { raf = 0; g.clearRect(0, 0, W, H) }
}

// ---------- 동전이 칩 표시로 날아감 ----------
export function flyCoins(fromRects, toEl, n = 8, onArrive) {
  if (!toEl || reduced) { onArrive?.(); return }
  const to = toEl.getBoundingClientRect()
  const tx = to.left + to.width * 0.25, ty = to.top + to.height / 2
  let done = 0
  for (let i = 0; i < n; i++) {
    const f = fromRects[i % fromRects.length]
    const sx = f.left + f.width / 2 + rnd(-f.width * 0.25, f.width * 0.25), sy = f.top + f.height / 2 + rnd(-10, 10)
    const c = document.createElement('i')
    c.className = 'sl-fly'
    document.body.append(c)
    const mx = (sx + tx) / 2 + rnd(-80, 80), my = Math.min(sy, ty) - rnd(40, 140) // 위로 휘어서
    const a = c.animate([
      { transform: `translate(${sx}px, ${sy}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${mx}px, ${my}px) scale(1.15)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${tx}px, ${ty}px) scale(.5)`, opacity: 0.9 },
    ], { duration: rnd(650, 900), delay: i * 45, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' })
    a.finished.then(() => {
      c.remove()
      toEl.classList.remove('sl-bump'); void toEl.offsetWidth; toEl.classList.add('sl-bump')
      if (++done === n) onArrive?.()
    })
  }
}

// ---------- 떠오르는 글자 ----------
export function floatText(box, xPct, yPct, text, color = '#ffd36b', big = false) {
  const s = document.createElement('span')
  s.className = 'sl-float' + (big ? ' big' : '')
  s.textContent = text
  s.style.left = xPct + '%'; s.style.top = yPct + '%'; s.style.color = color
  box.append(s)
  setTimeout(() => s.remove(), 1700)
}

export function shake(el, strength = 1) {
  if (reduced) return
  el.animate([0, 1, 2, 3, 4, 5, 6].map(i => ({ transform: i === 6 ? 'none' : `translate(${rnd(-6, 6) * strength}px, ${rnd(-4, 4) * strength}px) rotate(${rnd(-0.6, 0.6) * strength}deg)` })), { duration: 420 })
}

// ---------- 전체 화면 축하 ----------
const cele = document.createElement('div')
cele.className = 'sl-cele'
cele.hidden = true
cele.innerHTML = `<div class="sl-cele-rays"></div><div class="sl-cele-box"><p class="sl-cele-kind"></p><b class="sl-cele-amt">0</b><p class="sl-cele-sub"></p><p class="sl-cele-skip">아무 데나 누르면 닫혀요</p></div>`
document.body.append(cele)
let celeDone = null, celeRaf = 0, celeT = 0
function closeCele() {
  if (cele.hidden) return
  cancelAnimationFrame(celeRaf); clearTimeout(celeT); stopFountain()
  cele.classList.add('out')
  setTimeout(() => { cele.hidden = true; cele.classList.remove('out') }, 250)
  const d = celeDone; celeDone = null; d?.()
}
cele.addEventListener('pointerdown', closeCele)
addEventListener('keydown', e => { if (!cele.hidden && (e.code === 'Space' || e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); closeCele() } })
export const celebrating = () => !cele.hidden

// tier: 'big' | 'mega' | 'jackpot'
export function celebrate({ tier, amount, sub, fmt, onTick, onDone }) {
  cele.className = 'sl-cele ' + tier
  cele.querySelector('.sl-cele-kind').textContent = tier === 'jackpot' ? 'JACKPOT 777' : tier === 'mega' ? 'MEGA WIN' : 'BIG WIN'
  cele.querySelector('.sl-cele-sub').textContent = sub
  const amt = cele.querySelector('.sl-cele-amt')
  cele.hidden = false
  celeDone = onDone
  const dur = reduced ? 0 : tier === 'jackpot' ? 4200 : tier === 'mega' ? 3200 : 2400
  fountain(dur + 600, { rate: tier === 'big' ? 2 : 4, confetti: tier !== 'big' })
  const t0 = performance.now()
  let lastTick = 0
  const step = now => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1
    amt.textContent = '+' + fmt(Math.round(amount * (1 - (1 - k) ** 2.2)))
    if (now - lastTick > 70 && k < 1) { onTick?.(k); lastTick = now }
    if (k < 1) celeRaf = requestAnimationFrame(step)
    else { amt.classList.remove('land'); void amt.offsetWidth; amt.classList.add('land'); celeT = setTimeout(closeCele, 2200) }
  }
  celeRaf = requestAnimationFrame(step)
}
