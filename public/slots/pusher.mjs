// 코인 푸셔 물리 (서버 server/games/slots와 화면 app.js가 같은 코드를 돌린다)
// 위에서 본 판: 폭 W, 뒤(y=0)에서 앞(y=FRONT)까지. 뒤쪽 밀대가 앞뒤로 움직이며 코인을 민다.
// 코인끼리 부딪히고 밀려서, 앞 끝을 넘은 코인은 떨어진다(내 것). 양옆은 벽이라 넣은 코인은 결국 앞으로 나온다 (오래 보면 100%).
//
// 같은 결과를 내려고: 덧셈·곱셈·나눗셈·Math.sqrt만 쓴다 (모든 브라우저·Node에서 똑같이 계산됨). 삼각함수·Math.random 안 씀.
// 한 번 떨어뜨리면 STEPS칸(1/60초씩) 돌린다. 서버가 결과(떨어진 수)를 정하고, 화면은 같은 계산을 한 칸씩 그린다.

export const PB = {
  W: 300, FRONT: 330, R: 15, // 판 폭, 앞 끝, 코인 반지름
  PUSH_MIN: 46, PUSH_MAX: 104, CYCLE: 70, // 밀대 앞면이 오가는 범위, 한 번 오가는 칸 수
  DROP_Y: 118, STEPS: 150, // 코인이 떨어지는 자리, 한 판에 돌리는 칸 수 (2.5초)
  DAMP: 0.84, ITER: 3, // 미끄러짐이 줄어드는 정도, 부딪힘 풀기 반복
  SEED: 52, WARM: 120, // 처음 판: 코인을 깔고, 미리 WARM번 떨어뜨려 꽉 찬 판으로 (처음부터 떨어지게)
}

// 밀대 앞면 위치 (칸 번호 → y). 0에서 시작해 PUSH_MAX까지 나갔다 돌아온다 (부드럽게, 다항식만)
export function pusherY(step) {
  const k = (step % PB.CYCLE) / PB.CYCLE
  const tri = k < 0.5 ? 2 * k : 2 - 2 * k
  const e = tri * tri * (3 - 2 * tri)
  return PB.PUSH_MIN + (PB.PUSH_MAX - PB.PUSH_MIN) * e
}

// 결정적인 난수 (처음 판 깔기용): 같은 seed면 같은 판
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }

// 처음 판: 앞쪽에 코인을 깔고 겹침을 푼 뒤, 정해진 자리로 WARM번 떨어뜨려 판을 채워 둔다 (같은 seed면 같은 판)
export function seedBoard(seed = 1) {
  const r = lcg(seed), coins = []
  for (let i = 0; i < PB.SEED; i++) coins.push({ x: PB.R + r() * (PB.W - 2 * PB.R), y: PB.DROP_Y + 20 + r() * (PB.FRONT - PB.DROP_Y - 40), vx: 0, vy: 0 })
  for (let i = 0; i < 40; i++) step(coins, 0, true)
  let board = rest(coins.filter(c => c.y < PB.FRONT - 2))
  for (let i = 0; i < PB.WARM; i++) board = drop(board, dropX(PB.R + r() * (PB.W - 2 * PB.R))).board
  return board
}

// 한 칸: 미끄러짐 → 밀대 → 부딪힘 → 벽. 돌려주는 값: 이번 칸에 앞으로 떨어진 코인들
export function step(coins, s, still = false) {
  const R = PB.R, D = 2 * R, py = still ? PB.PUSH_MIN : pusherY(s), pv = still ? 0 : py - pusherY(s - 1)
  for (const c of coins) { c.vx *= PB.DAMP; c.vy *= PB.DAMP; c.x += c.vx; c.y += c.vy }
  for (let it = 0; it < PB.ITER; it++) {
    // 부딪힘: 겹친 만큼 반씩 밀어내고, 다가오던 속도를 나눠 가짐 (덜 튕기게)
    for (let i = 0; i < coins.length; i++) {
      const a = coins[i]
      for (let j = i + 1; j < coins.length; j++) {
        const b = coins[j], dx = b.x - a.x, dy = b.y - a.y
        if (dx > D || dx < -D || dy > D || dy < -D) continue
        const d2 = dx * dx + dy * dy
        if (d2 >= D * D || d2 < 1e-12) continue
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, ov = (D - d) / 2
        a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
        if (rv < 0) { const imp = -rv * 0.5; a.vx -= nx * imp; a.vy -= ny * imp; b.vx += nx * imp; b.vy += ny * imp }
      }
    }
    // 밀대: 앞면보다 뒤로 못 감, 밀대가 나오는 중이면 그 속도로 밀림
    for (const c of coins) if (c.y - R < py) { c.y = py + R; if (c.vy < pv) c.vy = pv }
    // 양옆 벽
    for (const c of coins) {
      if (c.x < R) { c.x = R; if (c.vx < 0) c.vx = -c.vx * 0.3 }
      else if (c.x > PB.W - R) { c.x = PB.W - R; if (c.vx > 0) c.vx = -c.vx * 0.3 }
    }
  }
  // 앞 끝: 코인 중심이 끝을 넘으면 떨어짐
  const fell = []
  for (let i = coins.length - 1; i >= 0; i--) if (coins[i].y > PB.FRONT) fell.push(coins.splice(i, 1)[0])
  return fell
}

// 멈춘 판: 속도는 0, 자리는 0.01 단위로 (서버·화면이 같은 수에서 시작하게)
export function rest(coins) { return coins.map(c => ({ x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, vx: 0, vy: 0 })) }
export const boardHash = coins => coins.reduce((h, c) => (Math.imul(h, 31) + Math.round(c.x * 100) * 7 + Math.round(c.y * 100)) | 0, 17)

// 떨어뜨리는 자리 (x) 검사·정리
export const dropX = x => { x = Number(x); return Number.isFinite(x) ? Math.round(Math.min(PB.W - PB.R, Math.max(PB.R, x)) * 10) / 10 : null }

// 한 판: 판(멈춘 상태) + 떨어뜨리는 자리 → { board: 다음 판, fell: 떨어진 수, frames? }
//   onStep(coins, s, fellNow) 를 주면 칸마다 불러 준다 (화면이 그리기용)
export function drop(board, x, onStep) {
  const coins = board.map(c => ({ ...c }))
  coins.push({ x, y: PB.DROP_Y, vx: 0, vy: 0.6 })
  let fell = 0
  for (let s = 1; s <= PB.STEPS; s++) {
    const f = step(coins, s)
    fell += f.length
    onStep?.(coins, s, f)
  }
  return { board: rest(coins), fell }
}
