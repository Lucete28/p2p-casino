// 블랙잭 규칙·서버 모듈 테스트: node server/games/blackjack/test-rules.mjs
// 슈를 정해 둔 카드로 바꿔서(가짜 rng.deck) 여러 명 테이블에서 칩이 맞게 오가는지 본다. 시간은 가짜 타이머로
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import bj from './index.mjs'
import { score, isNatural, settleHand, MIN_BET, EMOJIS, CUT, SHOE_SIZE, BET_MS, READY_MS, TURN_MS, SHOW_MS, DEAL_MS } from '../../../public/blackjack/rules.mjs'

let n = 0
const ok = async (name, fn) => { await fn(); n++; console.log('✓', name) }
mock.timers.enable({ apis: ['setTimeout', 'Date'] })
const tick = ms => mock.timers.tick(ms)

// 가짜 테이블. cards = 슈 맨 앞 카드들. 딜 순서: 자리 번호 순서로 한 장씩 → 딜러 업 → 다시 한 장씩 → 딜러 숨김
// 들어오면 관전, 베팅하면 가운데부터 3 · 2 · 4 · 1 · 5 · 0 · 6에 앉는다 (첫 사람이 3번, 둘째가 2번 → 둘째가 먼저 받는다)
let uid = 0
function setup(cards, chips = [1000]) {
  const filler = Array.from({ length: SHOE_SIZE - cards.length }, (_, i) => '23456789'[i % 8] + 's')
  const ps = chips.map(c => ({ id: 'u_t' + uid++, name: 't' + uid, chips: c, inPlay: 0, limits: {}, sockets: { size: 1 } }))
  const sent = new Map(ps.map(p => [p.id, []])), log = []
  const ctx = {
    rng: { deck: () => [...cards, ...filler], int: () => 0 },
    send(p, m) { sent.get(p.id)?.push(m) },
    players: () => ps,
    limit: () => true,
    bet(pl, a) { if (!Number.isSafeInteger(a) || a < 1 || a > pl.chips) return false; pl.chips -= a; pl.inPlay += a; return true },
    payout(pl, a, round, detail) { assert.ok(Number.isSafeInteger(a) && a >= 0); pl.chips += a; pl.inPlay = 0; log.push({ id: pl.id, a, round, detail }); return true },
  }
  for (const p of ps) bj.join(p, ctx)
  const last = p => sent.get(p.id).filter(m => m.t === 'state').at(-1)
  const me = p => { const m = last(p); return m.seats[m.me] }
  return {
    ps, ctx, log, last, me, sentAll: p => sent.get(p.id),
    bet: (p, amount) => bj.message(p, { t: 'bet', amount }, ctx),
    act: (p, a) => bj.message(p, { t: 'act', a, seq: last(p).seq }, ctx),
    toasts: p => sent.get(p.id).filter(m => m.t === 'toast').map(m => m.msg),
    leave(p) { bj.leave(p, ctx); if (p.inPlay) ctx.payout(p, 0) }, // 코어처럼: 판이 남아 있으면 건 칩을 거둠
    close() { for (const p of ps) this.leave(p) },
  }
}
// 모두 걸고 마감 → 딜 연출까지
function dealAll(T, bets) {
  T.ps.forEach((p, i) => T.bet(p, bets[i] ?? bets[0]))
  tick(READY_MS)
}
const toResult = () => { for (let i = 0; i < 10; i++) tick(500) } // 딜러 차례 + 연출 + 정산 (가짜 타이머는 한 번에 넘기면 그사이 새로 건 타이머를 안 돌려서 나눠 감)

await ok('점수: 에이스는 11 또는 1, 소프트 표시', () => {
  assert.deepEqual(score(['As', 'Kd']), { total: 21, soft: true })
  assert.deepEqual(score(['As', 'Ad', '9c']), { total: 21, soft: true })
  assert.deepEqual(score(['As', 'Ad', '9c', 'Kh']), { total: 21, soft: false })
  assert.deepEqual(score(['Ks', 'Qd', '5c']), { total: 25, soft: false })
  assert.ok(isNatural(['Ah', 'Ts']) && !isNatural(['7h', '7s', '7d']))
})

await ok('블랙잭 3:2 (홀수 베팅의 반 칩은 버림), 스플릿 뒤 21은 1:1', () => {
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10 }, ['9s', '8d']).back, 25)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 5 }, ['9s', '8d']).back, 12)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10, split: true }, ['9s', '8d']).back, 20)
  assert.equal(settleHand({ cards: ['As', 'Kd'], bet: 10 }, ['Ah', 'Td']).result, 'push')
})

await ok('들어오면 관전 (자리를 차지하지 않음), 베팅하면 가운데부터 앉고, 일곱 자리가 차면 새 테이블에서 관전', () => {
  const T = setup([], Array(8).fill(100))
  const A = T.ps[0]
  assert.equal(T.last(A).me, -1); assert.equal(T.last(A).seats.filter(Boolean).length, 0); assert.equal(T.last(A).watching, 8)
  for (const p of T.ps.slice(0, 7)) T.bet(p, 10)
  assert.deepEqual(T.ps.slice(0, 7).map(p => T.last(p).me), [3, 2, 4, 1, 5, 0, 6])
  assert.equal(T.last(A).watching, 1)
  T.bet(T.ps[7], 10)
  assert.ok(T.toasts(T.ps[7]).at(-1).includes('빈자리가 없어요'))
  const late = { id: 'u_late' + uid++, name: 'late', chips: 100, inPlay: 0, limits: {}, sockets: { size: 1 } }
  bj.join(late, T.ctx)
  assert.deepEqual(bj.summary(), { players: 9, tables: 2 }, '꽉 찬 테이블 대신 새 테이블에서 관전')
  bj.leave(late, T.ctx)
  T.close()
  assert.deepEqual(bj.summary(), { players: 0, tables: 0 })
})

await ok('빈자리 고르기 · 일어나기 · 3판 안 걸면 자동으로 일어남', () => {
  const T = setup(['Ts', '9d', '9c', '8h'], [1000, 1000])
  const [A, B] = T.ps
  bj.message(A, { t: 'sit', seat: 6 }, T.ctx)
  assert.equal(T.last(A).me, 6); assert.equal(T.last(B).seats[6].name, A.name)
  bj.message(B, { t: 'sit', seat: 6 }, T.ctx)
  assert.equal(T.last(B).me, -1); assert.ok(T.toasts(B).at(-1).includes('앉을 수 없어요'))
  bj.message(B, { t: 'sit', seat: 0 }, T.ctx)
  bj.message(B, { t: 'stand' }, T.ctx)
  assert.equal(T.last(B).me, -1); assert.equal(T.last(A).seats[0], null)
  bj.message(B, { t: 'sit', seat: 0 }, T.ctx)
  for (let r = 0; r < 3; r++) { // A만 건다 (B가 안 걸어서 12초를 다 기다림)
    T.bet(A, 10); tick(BET_MS)
    if (r < 2) assert.equal(T.last(B).me, 0, `${r + 1}판째는 아직 앉아 있음`)
    while (!T.me(A).done) T.act(A, 'stand')
    tick(1000); toResult(); tick(SHOW_MS)
  }
  assert.equal(T.last(B).me, -1); assert.ok(T.toasts(B).at(-1).includes('자리에서 일어났어요'))
  T.bet(A, 10); tick(READY_MS)
  bj.message(A, { t: 'stand' }, T.ctx)
  assert.ok(T.toasts(A).at(-1).includes('판이 끝난 뒤'))
  T.close()
})

await ok('베팅: 첫 베팅부터 12초, 모두 걸면 곧 마감. 숨긴 카드는 보내지 않음', () => {
  const T = setup(['Ts', '5c', '9d', '9h', '6s', '8h'], [1000, 1000]) // B: T 9 · A: 5 6 · 딜러 9 (8) — 순서 B A 딜러 B A 딜러
  const [A, B] = T.ps
  assert.equal(T.last(A).phase, 'bet'); assert.equal(T.last(A).phaseMs, 0, '아무도 안 걸면 기다림')
  bj.message(B, { t: 'sit', seat: 2 }, T.ctx) // B가 앉아 있으면 A 혼자 걸어도 12초를 기다림 (관전자는 기다리지 않음)
  T.bet(A, 100)
  assert.equal(T.last(B).phaseMs, BET_MS); assert.equal(T.last(B).seats[3].ready, true, '다른 사람 베팅도 보임')
  assert.equal(A.chips, 1000, '마감 전에는 칩을 건드리지 않음')
  tick(3000)
  T.bet(B, 50)
  assert.equal(T.last(A).phaseMs, READY_MS)
  tick(READY_MS)
  const s = T.last(A)
  assert.equal(s.phase, 'play'); assert.equal(s.ev, 'deal')
  assert.deepEqual(s.dealer, ['9d', null]); assert.ok(!JSON.stringify(s).includes('8h'))
  assert.deepEqual(s.seats[2].hands[0].cards, ['Ts', '9h']); assert.deepEqual(s.seats[3].hands[0].cards, ['5c', '6s'])
  assert.equal(A.chips, 900); assert.equal(B.chips, 950)
  assert.ok(s.actions.double && s.seats[3].turnMs >= TURN_MS)
  assert.ok(!T.last(B).actions.split)
  T.close()
})

await ok('모두 동시에 행동 → 다 끝나면 딜러 → 연출 뒤 정산', () => {
  const T = setup(['Ts', '5c', '9d', '9h', '6s', '8h', 'Th'], [1000, 1000]) // A: 11 + T = 21, B: 19, 딜러 17
  const [A, B] = T.ps
  dealAll(T, [100, 100])
  T.act(A, 'hit')
  assert.equal(T.me(A).done, true, '21이면 자동 스탠드')
  assert.equal(T.last(A).phase, 'play', 'B가 남아 있어 아직 딜러 차례 아님')
  T.act(B, 'stand')
  tick(1000)
  const d = T.last(A)
  assert.equal(d.phase, 'dealer'); assert.deepEqual(d.dealer, ['9d', '8h'])
  assert.deepEqual([d.seats[3].hands[0].result, d.seats[2].hands[0].result], ['win', 'win'])
  assert.equal(d.seats[3].back, 200); assert.equal(d.seats[3].staked, 100)
  assert.equal(A.inPlay, 100, '연출 전에는 아직 진행 중')
  toResult()
  assert.equal(A.chips, 1100); assert.equal(B.chips, 1100); assert.equal(A.inPlay, 0)
  assert.equal(T.last(A).phase, 'result'); assert.equal(T.last(A).total, undefined, '누적 득실은 보내지 않음')
  assert.equal(T.log[0].detail.dealer, '9d 8h')
  tick(SHOW_MS)
  const b = T.last(A)
  assert.equal(b.phase, 'bet'); assert.deepEqual(b.dealer, []); assert.deepEqual(b.seats[3].hands, [])
  T.close()
})

await ok('20초 동안 안 고르면 스탠드 (딜 연출 시간은 빼고)', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  const [A] = T.ps
  dealAll(T, [100])
  tick(4 * DEAL_MS + TURN_MS - 1); assert.equal(T.last(A).phase, 'play')
  tick(1); assert.equal(T.last(A).ev, 'timeout')
  toResult(); assert.equal(A.chips, 1100) // 19 vs 17
  T.close()
})

await ok('더블: 베팅 두 배, 한 장만. 칩이 모자라면 못 함', () => {
  const T = setup(['5s', '9d', '6c', '7h', 'Td', 'Ts']) // 11 vs 16 → 더블 T = 21, 딜러 16 + T 버스트
  const [A] = T.ps
  dealAll(T, [100])
  T.act(A, 'double')
  assert.equal(A.inPlay, 200); assert.equal(T.me(A).hands[0].doubled, true)
  tick(1000); assert.equal(T.me(A).hands[0].result, 'win')
  toResult(); assert.equal(A.chips, 1200)
  T.close()
  const U = setup(['8s', '9d', '8c', '7h'], [150])
  dealAll(U, [100])
  assert.deepEqual(U.last(U.ps[0]).actions, { hit: true, stand: true, double: false, split: false })
  U.act(U.ps[0], 'double')
  assert.equal(U.ps[0].inPlay, 100); assert.ok(U.toasts(U.ps[0]).some(m => /칩이 모자라/.test(m)))
  U.close()
})

await ok('스플릿 8·8 → 첫 손 더블(스플릿 뒤 더블), 둘째 손 스탠드, 딜러 버스트', () => {
  const T = setup(['8s', '6d', '8c', 'Th', '3d', 'Ts', 'Tc', 'Td'])
  const [A] = T.ps
  dealAll(T, [100])
  T.act(A, 'split')
  let me = T.me(A)
  assert.equal(me.hands.length, 2); assert.deepEqual(me.hands[1].cards, ['8c'], '둘째 손 카드는 차례가 올 때')
  assert.equal(T.last(A).actions.split, false, '스플릿은 한 번만')
  T.act(A, 'double')
  me = T.me(A); assert.equal(me.active, 1); assert.deepEqual(me.hands[1].cards, ['8c', 'Tc'])
  T.act(A, 'stand')
  tick(1000)
  assert.deepEqual(T.me(A).hands.map(h => h.result), ['win', 'win']); assert.equal(A.inPlay, 300)
  toResult(); assert.equal(A.chips, 1300)
  T.close()
})

await ok('에이스 스플릿: 한 장씩만, 21이어도 1:1', () => {
  const T = setup(['As', '5d', 'Ac', 'Th', 'Kd', 'Qc', '7s'])
  const [A] = T.ps
  dealAll(T, [100])
  T.act(A, 'split')
  assert.equal(T.me(A).done, true)
  tick(1000); assert.deepEqual(T.me(A).hands.map(h => h.result), ['win', 'win'])
  toResult(); assert.equal(A.chips, 1200)
  T.close()
})

await ok('딜러 피크 블랙잭: 바로 딜러 차례, 블랙잭끼리는 비김', () => {
  const T = setup(['As', 'Ts', 'Ad', 'Kc', '9c', 'Kh'], [1000, 1000]) // B: A K (블랙잭) · A: T 9 · 딜러 A K
  const [A, B] = T.ps
  dealAll(T, [100, 100])
  assert.equal(T.me(A).done, true); assert.equal(T.me(B).done, true)
  tick(6 * DEAL_MS + 200)
  assert.equal(T.last(A).phase, 'dealer')
  assert.equal(T.me(A).hands[0].result, 'lose'); assert.equal(T.me(B).hands[0].result, 'push')
  toResult(); assert.equal(A.chips, 900); assert.equal(B.chips, 1000)
  T.close()
})

await ok('내 블랙잭은 다른 사람이 끝날 때까지 기다렸다 3:2', () => {
  const T = setup(['Ts', 'As', '9d', '6c', 'Kd', '8h', '9s'], [1000, 1000]) // B: T 6 · A: A K · 딜러 9 8
  const [A, B] = T.ps
  dealAll(T, [100, 100])
  assert.equal(T.me(A).done, true); assert.equal(T.me(B).done, false)
  T.act(B, 'hit') // 16 + 9 버스트
  tick(1000); toResult()
  assert.equal(A.chips, 1150); assert.equal(B.chips, 900)
  T.close()
})

await ok('행동 중 나가면 건 칩을 잃고, 남은 사람은 계속', () => {
  const T = setup(['Ts', '9c', '9d', '9h', '9s', '8h'], [1000, 1000])
  const [A, B] = T.ps
  dealAll(T, [100, 100])
  T.leave(A)
  assert.equal(A.chips, 900); assert.equal(A.inPlay, 0)
  assert.equal(T.last(B).seats[3], null)
  T.act(B, 'stand'); tick(1000); toResult()
  assert.equal(B.chips, 1100)
  T.close()
})

await ok('딜러 결과가 나온 뒤(연출 중) 나가면 결과대로 바로 정산', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  const [A] = T.ps
  dealAll(T, [100]); T.act(A, 'stand'); tick(1000)
  assert.equal(A.inPlay, 100)
  T.leave(A)
  assert.equal(A.chips, 1100); assert.equal(A.inPlay, 0)
  T.close()
})

await ok('끊긴 사람의 베팅은 이번 판에서 빠짐, 이상한 베팅·취소', () => {
  const T = setup(['Ts', '9d', '9c', '8h'], [1000, 1000])
  const [A, B] = T.ps
  for (const bad of [-5, 1.5, 'abc', 1e20, 1001, 1, MIN_BET - 1]) T.bet(A, bad) // 최소 베팅 10 미만도 거절
  assert.equal(T.last(A).me, -1); assert.equal(T.toasts(A).length, 7)
  assert.ok(T.toasts(A).at(-1).includes('10칩 이상'))
  T.bet(A, 100); T.bet(A, 0)
  assert.equal(T.last(B).seats[3].ready, false, '취소')
  T.bet(A, 100); T.bet(B, 100)
  B.sockets.size = 0
  tick(READY_MS)
  assert.equal(T.last(A).seats[2].inRound, false); assert.equal(B.chips, 1000)
  T.bet(A, 50); assert.ok(T.toasts(A).at(-1).includes('이번 판이 끝나면'))
  T.close()
})

await ok('두 번 누름(지난 seq)은 무시', () => {
  const T = setup(['Ts', '9d', '2c', '8h', '3d', '4c'])
  const [A] = T.ps
  dealAll(T, [100])
  const seq = T.last(A).seq
  bj.message(A, { t: 'act', a: 'hit', seq }, T.ctx)
  bj.message(A, { t: 'act', a: 'hit', seq }, T.ctx)
  assert.equal(T.me(A).hands[0].cards.length, 3)
  T.close()
})

await ok('서버를 끌 때: 결과가 나온 판은 결과대로 정산 (행동 중인 판은 코어가 무효 처리)', () => {
  const T = setup(['Ts', '9d', '9c', '8h'])
  const [A] = T.ps
  dealAll(T, [100]); T.act(A, 'stand'); tick(1000)
  bj.shutdown(T.ctx)
  assert.equal(A.chips, 1100); assert.equal(A.inPlay, 0)
  T.close()
})

await ok(`슈: 312장 중 ${CUT}장 넘게 쓰면 다음 딜 전에 다시 섞음`, () => {
  const T = setup([])
  const [A] = T.ps
  let shuffled = 0
  for (let i = 0; i < 120; i++) {
    dealAll(T, [MIN_BET])
    if (T.last(A).shoe.shuffled) shuffled++
    else assert.ok(SHOE_SIZE - T.last(A).shoe.left <= CUT + 20)
    while (!T.me(A).done) T.act(A, 'stand')
    tick(1000); toResult(); tick(SHOW_MS)
  }
  assert.ok(shuffled >= 2, String(shuffled))
  T.close()
})

await ok('남은 카드 창: 다음 카드 비율 합 1, 이번 판에 보이는 카드만 뺌, 버스트·21 칸', async () => {
  const { nextCard, remaining } = await import('../../../public/blackjack/odds.mjs')
  const full = remaining([])
  assert.ok(Math.abs(full.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  assert.ok(Math.abs(full[10] - 4 / 13) < 1e-9 && Math.abs(full[1] - 1 / 13) < 1e-9)
  const seen = remaining(['Ts', 'Kd', 'Qh', 'Jc'])
  assert.ok(seen[10] < full[10], '보이는 10점 카드는 빠짐')
  const n = nextCard(['Ts', '6d', 'Th'], ['Ts', '6d'])
  assert.deepEqual(n.buckets.filter(b => b.bust).map(b => b.label), ['6', '7', '8', '9', '10'])
  assert.deepEqual(n.buckets.filter(b => b.is21).map(b => b.label), ['5'])
  assert.ok(Math.abs(n.bust - 8 / 13) < 0.01, '16에서 버스트 약 61.5%')
  const soft = nextCard([], ['As', '6d'])
  assert.equal(soft.bust, 0, '소프트 17은 한 장으로 버스트하지 않음')
  assert.equal(nextCard([]).bust, 0, '내 차례가 아니면 비율만')
})

await ok('이모지: 앉은 사람만, 다섯 개만, 1.2초에 한 번 → 테이블 모두(관전자 포함)에게', () => {
  const T = setup([], [1000, 1000])
  const [A, B] = T.ps
  let last = {}
  T.ctx.limit = (p, key, ms) => { const now = Date.now(); if (now - (last[p.id + key] || -1e9) < ms) return false; last[p.id + key] = now; return true }
  const emojis = p => T.sentAll(p).filter(m => m.t === 'emoji')
  bj.message(A, { t: 'emoji', e: '👍' }, T.ctx) // 관전 중엔 못 보냄
  bj.message(A, { t: 'sit', seat: 3 }, T.ctx)
  bj.message(A, { t: 'emoji', e: '안녕' }, T.ctx) // 정해 둔 것만
  bj.message(A, { t: 'emoji', e: '🔥' }, T.ctx)
  bj.message(A, { t: 'emoji', e: '😂' }, T.ctx) // 1.2초 안에 또
  tick(1200)
  bj.message(A, { t: 'emoji', e: '😭' }, T.ctx)
  assert.deepEqual(emojis(B).map(m => [m.seat, m.e]), [[3, '🔥'], [3, '😭']], '관전자 B도 받음')
  assert.deepEqual(emojis(A).map(m => m.e), ['🔥', '😭'])
  assert.equal(EMOJIS.length, 5)
  T.close()
})

mock.timers.reset()
console.log(`통과 ${n}개`)
