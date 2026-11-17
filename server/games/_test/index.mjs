// 테스트 전용 하우스 게임 (CASINO_TEST_GAMES=1일 때만 불러옴, 사이트 이미지에는 들어가지 않음)
// 새 게임 세션이 참고할 가장 작은 '관리 모드' 예시이기도 하다.
//   { t: 'flip', bet, side: 'H'|'T' }  한 번에 끝나는 판 (ctx.settle)
//   { t: 'start', bet } → { t: 'finish' }  여러 단계 판 (ctx.bet → ctx.payout). 'start' 뒤 나가면 건 칩을 잃는다
export default {
  id: 'coinflip',
  title: '동전 던지기 (테스트)',
  buyIn: { min: 1 },

  join(p, ctx) { ctx.send(p, { t: 'hello', game: 'coinflip' }) },

  message(p, d, ctx) {
    if (d.t === 'flip') {
      if (!ctx.limit(p, 'flip', 100)) return
      const bet = Number(d.bet) // 정수·범위 검사는 ctx.bet이 한다
      const side = ctx.rng.int(2) ? 'H' : 'T'
      const win = side === d.side
      const round = 'f_' + Date.now().toString(36) + ctx.rng.int(1e6)
      if (!ctx.settle(p, bet, win ? bet * 2 : 0, round, { pick: d.side, side })) return ctx.send(p, { t: 'toast', msg: '베팅할 수 없어요.' })
      return ctx.send(p, { t: 'flipped', side, win })
    }
    if (d.t === 'start') {
      const bet = Number(d.bet)
      if (p.inPlay || !ctx.bet(p, bet, 's_' + Date.now().toString(36))) return ctx.send(p, { t: 'toast', msg: '베팅할 수 없어요.' })
      return ctx.send(p, { t: 'started', bet })
    }
    if (d.t === 'finish') {
      if (!p.inPlay) return
      const win = ctx.rng.int(2) === 1
      ctx.payout(p, win ? p.inPlay * 2 : 0, null, { win })
      return ctx.send(p, { t: 'finished', win })
    }
  },
}
