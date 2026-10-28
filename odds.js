// 내 패 분석: 리버까지 갔을 때 완성될 족보별 확률과 예상 승률.
// 내 카드와 바닥 카드만 사용한다(상대 카드는 모르는 것으로 보고 무작위로 가정).
import { evaluate, newDeck, compareScore } from './poker.js?v=1.6.0'

// 낮은 족보 → 높은 족보 순. 인덱스 9 = 로열 플러시
export const HAND_RANKS = ['하이카드', '원 페어', '투 페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시', '로열 플러시']
export const category = score => (score[0] === 8 && score[1] === 14 ? 9 : score[0])

// 지금 내 족보 (바닥이 3장 미만이면 손패 두 장만으로 판단)
export function currentHand(hole, board) {
  if (board.length >= 3) {
    const e = evaluate([...hole, ...board])
    return { cat: category(e.score), cards: e.cards }
  }
  return { cat: hole[0][0] === hole[1][0] ? 1 : 0, cards: hole }
}

const tick = () => new Promise(r => setTimeout(r, 0))

function sample(pool, k) {
  // 앞에서부터 k장을 무작위로 섞어서 꺼냄 (pool은 매번 복사본)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, k)
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return }
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i])
    yield* combos(arr, k, i + 1, acc)
    acc.pop()
  }
}

// isStale()가 true를 돌려주면 계산을 멈추고 null을 반환 (새 카드가 깔렸을 때 등)
export async function analyze(hole, board, opponents, isStale, opts = {}) {
  const known = new Set([...hole, ...board])
  const deck = newDeck().filter(c => !known.has(c))
  const need = 5 - board.length

  // 1) 족보별 완성 확률
  const counts = new Array(10).fill(0)
  let total = 0
  if (need <= 2) {
    for (const extra of combos(deck, need)) {
      counts[category(evaluate([...hole, ...board, ...extra]).score)]++
      if (++total % 300 === 0) { await tick(); if (isStale()) return null }
    }
  } else {
    const N = opts.handSamples ?? 4000
    for (; total < N; total++) {
      const extra = sample(deck.slice(), need)
      counts[category(evaluate([...hole, ...board, ...extra]).score)]++
      if (total % 300 === 299) { await tick(); if (isStale()) return null }
    }
  }
  const dist = counts.map(c => c / total)

  // 2) 예상 승률: 남은 상대들이 무작위 패를 들고 끝까지 간다고 가정
  let equity = null
  if (opponents > 0) {
    const N = opts.winSamples ?? 1500
    let score = 0
    for (let i = 0; i < N; i++) {
      const drawn = sample(deck.slice(), need + opponents * 2)
      const fullBoard = [...board, ...drawn.slice(0, need)]
      const mine = evaluate([...hole, ...fullBoard]).score
      let beaten = false, ties = 0
      for (let o = 0; o < opponents; o++) {
        const opp = evaluate([drawn[need + o * 2], drawn[need + o * 2 + 1], ...fullBoard]).score
        const cmp = compareScore(mine, opp)
        if (cmp < 0) { beaten = true; break }
        if (cmp === 0) ties++
      }
      if (!beaten) score += 1 / (ties + 1)
      if (i % 200 === 199) { await tick(); if (isStale()) return null }
    }
    equity = score / N
  }
  return { dist, equity }
}

// 족보표에 쓰는 예시 카드
export const HAND_EXAMPLES = {
  9: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
  8: ['9h', '8h', '7h', '6h', '5h'],
  7: ['Ks', 'Kh', 'Kd', 'Kc', '3s'],
  6: ['Qs', 'Qh', 'Qd', '7c', '7s'],
  5: ['Ad', 'Jd', '8d', '5d', '2d'],
  4: ['Ts', '9h', '8d', '7c', '6s'],
  3: ['8s', '8h', '8d', 'Kc', '3s'],
  2: ['Js', 'Jh', '4d', '4c', 'As'],
  1: ['Ts', 'Th', 'Kd', '7c', '2s'],
  0: ['As', 'Qh', '9d', '6c', '3s'],
}
export const HAND_DESC = {
  9: '같은 무늬 A-K-Q-J-10',
  8: '같은 무늬로 이어진 5장',
  7: '같은 숫자 4장',
  6: '트리플 + 원 페어',
  5: '같은 무늬 5장',
  4: '숫자가 이어진 5장',
  3: '같은 숫자 3장',
  2: '페어 두 쌍',
  1: '같은 숫자 2장',
  0: '아무것도 없을 때 가장 높은 카드',
}
