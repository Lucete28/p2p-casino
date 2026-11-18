// 블랙잭 '남은 카드' 창 (운영자 요청 2026-11-18: 자세한 승률 대신 덱에 남은 카드 위주로)
//   다음 카드가 A·2·…·9·10점일 확률, 내 손에서 받으면 버스트하는 카드 / 21이 되는 카드
// 남은 카드는 '6덱에서 이번 판 테이블에 보이는 카드를 뺀 것'으로 계산한다. 지난 판에 나온 카드는 세지 않는다:
// 실제 슈에 남은 카드를 보여 주면 카드 카운팅(10이 많을 때만 크게 걸기)을 화면이 대신해 하우스 몫이 무너지므로
import { DECKS, valueOf, score } from './rules.mjs'

export const BUCKETS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'] // 10 = 10·J·Q·K
const v1 = c => (valueOf(c) === 11 ? 1 : valueOf(c)) // A = 1
const sample = v => (v === 1 ? 'As' : v === 10 ? 'Ts' : v + 's')

// 다음 카드 비율 p[1..10]
export function remaining(visible) {
  const n = Array(11).fill(0)
  for (let v = 1; v <= 9; v++) n[v] = 4 * DECKS
  n[10] = 16 * DECKS
  for (const c of visible) if (c) n[v1(c)] = Math.max(0, n[v1(c)] - 1)
  const total = n.reduce((a, x) => a + x, 0)
  return n.map(x => x / total)
}

// 다음 카드 한 장: 칸마다 { label, p, bust, is21 }, 합계 bust · to21. cards가 없으면(내 차례가 아니면) 비율만
export function nextCard(visible, cards = null) {
  const p = remaining(visible)
  const buckets = BUCKETS.map((label, i) => {
    const v = i + 1
    const t = cards ? score([...cards, sample(v)]).total : 0
    return { label, p: p[v], bust: !!cards && t > 21, is21: !!cards && t === 21 }
  })
  return {
    buckets,
    bust: buckets.reduce((a, b) => a + (b.bust ? b.p : 0), 0),
    to21: buckets.reduce((a, b) => a + (b.is21 ? b.p : 0), 0),
  }
}
