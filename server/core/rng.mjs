// 게임 결과에 쓰는 난수. crypto 기반이라 예측할 수 없다. 게임 모듈은 Math.random을 쓰지 않는다 (CASINO.md 6장)
import { randomInt } from 'node:crypto'

// 0 ~ n-1 사이 정수
export const int = n => randomInt(n)

// 배열을 제자리에서 섞어 돌려준다 (Fisher–Yates)
export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 섞인 카드 묶음. 카드는 'As'(스페이드 A), 'Td'(다이아 10), 'Kh', '2c' 같은 문자열. decks = 덱 수 (블랙잭 6, 바카라 8)
export const RANKS = 'A23456789TJQK'
export const SUITS = 'shdc'
export function deck(decks = 1) {
  const out = []
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) out.push(r + s)
  return shuffle(out)
}
