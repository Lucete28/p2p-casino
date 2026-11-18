// 블랙잭 확률 (화면의 '확률' 창, 홀덤의 예상 승률처럼). 화면에 보이는 정보만 쓴다:
//   내 카드 · 딜러 업카드 · 이번 판 테이블에 보이는 카드. 딜러의 뒤집힌 카드는 모른다고 본다
// 남은 카드는 '6덱에서 이번 판에 보이는 카드를 뺀 것'으로 추정한다. 지난 판에 나온 카드는 세지 않는다
// (카드 카운팅을 도와주면 하우스 몫이 무너지므로). 그다음 카드들은 그 비율로 나온다고 보는 근사(복원 추출)라 ±1%p 정도 오차가 있다
import { DECKS, valueOf, score } from './rules.mjs'

const v1 = c => (valueOf(c) === 11 ? 1 : valueOf(c)) // A = 1, 10·J·Q·K = 10

// 남은 카드 비율: p[1..10] (p[10] = 10·J·Q·K)
export function remaining(visible) {
  const n = Array(11).fill(0)
  for (let v = 1; v <= 9; v++) n[v] = 4 * DECKS
  n[10] = 16 * DECKS
  for (const c of visible) if (c) n[v1(c)] = Math.max(0, n[v1(c)] - 1)
  const total = n.reduce((a, x) => a + x, 0)
  return n.map(x => x / total)
}

// 딜러 최종 점수 분포 { 17, 18, 19, 20, 21, bust } — 소프트 17 스탠드.
// peeked = 딜러가 블랙잭이 아니라고 이미 확인됨 (A·10 업카드인데 판이 계속되면): 숨긴 카드에서 그 경우를 뺀다
export function dealerDist(up, p, peeked = true) {
  const memo = new Map()
  // sum = A를 1로 센 합, ace = A가 있나
  const go = (sum, ace) => {
    const best = ace && sum + 10 <= 21 ? sum + 10 : sum
    if (sum > 21) return { bust: 1 }
    if (best >= 17) return { [best]: 1 }
    const key = sum * 2 + (ace ? 1 : 0)
    if (memo.has(key)) return memo.get(key)
    const out = {}
    for (let v = 1; v <= 10; v++) {
      if (!p[v]) continue
      const r = go(sum + v, ace || v === 1)
      for (const k in r) out[k] = (out[k] || 0) + p[v] * r[k]
    }
    memo.set(key, out)
    return out
  }
  const u = v1(up)
  // 숨긴 카드: 피크로 블랙잭이 아님이 확인됐으면 (A 업카드면 10을, 10 업카드면 A를) 빼고 다시 비율
  const hole = p.slice()
  if (peeked && u === 1) hole[10] = 0
  if (peeked && u === 10) hole[1] = 0
  const hs = hole.reduce((a, x) => a + x, 0)
  const out = { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 }
  for (let v = 1; v <= 10; v++) {
    if (!hole[v]) continue
    const r = go(u + v, u === 1 || v === 1)
    for (const k in r) out[k] += (hole[v] / hs) * r[k]
  }
  return out
}

// 내 점수 m으로 멈췄을 때 { win, push, lose }
function versus(m, d) {
  if (m > 21) return { win: 0, push: 0, lose: 1 }
  let win = d.bust, push = 0, lose = 0
  for (let t = 17; t <= 21; t++) { if (t < m) win += d[t]; else if (t === m) push += d[t]; else lose += d[t] }
  return { win, push, lose }
}

// 지금 손의 확률. cards = 내 손, up = 딜러 업카드, visible = 이번 판 테이블에 보이는 카드 전부
export function handOdds(cards, up, visible) {
  const p = remaining(visible)
  const d = dealerDist(up, p)
  const s = score(cards)
  const stand = versus(s.total, d)
  // 한 장 더 받고 멈추면 (히트 한 번 · 더블)
  const one = { win: 0, push: 0, lose: 0, bust: 0 }
  for (let v = 1; v <= 10; v++) {
    if (!p[v]) continue
    const t = score([...cards, v === 1 ? 'As' : v === 10 ? 'Ts' : String(v) + 's']).total
    if (t > 21) { one.bust += p[v]; one.lose += p[v]; continue }
    const r = versus(t, d)
    one.win += p[v] * r.win; one.push += p[v] * r.push; one.lose += p[v] * r.lose
  }
  return { total: s.total, soft: s.soft, stand, one, dealer: d }
}
