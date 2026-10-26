// 텍사스 홀덤 엔진 (네트워크/화면과 무관한 순수 로직)
// 방장(호스트) 브라우저에서만 Table이 돌아가고, 나머지는 결과 상태만 받는다.

export const CONFIG = {
  START_TOKENS: 1000, // 처음 받는 기본 토큰
  DAILY_REFILLS: 10,  // 토큰이 바닥났을 때 하루에 다시 받을 수 있는 횟수
  SB: 10,
  BB: 20,
  MAX_SEATS: 6,
  TURN_MS: 30000,     // 한 사람의 행동 제한 시간
  NEXT_HAND_MS: 6000, // 결과 표시 후 다음 판까지 대기 시간
}

const RANKS = '23456789TJQKA'
const SUITS = 'shdc'
const HAND_NAMES = ['하이카드', '원 페어', '투 페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시']
const BETTING = ['preflop', 'flop', 'turn', 'river']

export function newDeck() {
  const d = []
  for (const r of RANKS) for (const s of SUITS) d.push(r + s)
  return d
}

function secureRandom(n) {
  const buf = new Uint32Array(1)
  globalThis.crypto.getRandomValues(buf)
  return buf[0] % n
}

export function shuffle(deck, rand = secureRandom) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

// 5장 점수: [족보, 비교용 숫자들...] — 배열을 앞에서부터 비교하면 승패가 나온다
function score5(cards) {
  const ranks = cards.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a)
  const flush = cards.every(c => c[1] === cards[0][1])
  let straight = 0
  if (new Set(ranks).size === 5) {
    if (ranks[0] - ranks[4] === 4) straight = ranks[0]
    else if (ranks[0] === 14 && ranks[1] === 5) straight = 5 // A-2-3-4-5
  }
  const counts = {}
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1
  const groups = Object.entries(counts)
    .map(([r, n]) => [n, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1])
  const byGroup = groups.map(g => g[1])

  if (straight && flush) return [8, straight]
  if (groups[0][0] === 4) return [7, ...byGroup]
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup]
  if (flush) return [5, ...ranks]
  if (straight) return [4, straight]
  if (groups[0][0] === 3) return [3, ...byGroup]
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup]
  if (groups[0][0] === 2) return [1, ...byGroup]
  return [0, ...ranks]
}

export function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

// 5~7장 중 가장 좋은 5장 조합
export function evaluate(cards) {
  let best = null, bestCards = null
  const n = cards.length
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]]
            const s = score5(five)
            if (!best || compareScore(s, best) > 0) { best = s; bestCards = five }
          }
  const name = best[0] === 8 && best[1] === 14 ? '로열 플러시' : HAND_NAMES[best[0]]
  return { score: best, name, cards: bestCards }
}

export class Table {
  constructor(cfg = CONFIG, rand) {
    this.cfg = cfg
    this.rand = rand
    this.seats = []
    this.phase = 'waiting'
    this.board = []
    this.pot = 0
    this.currentBet = 0
    this.minRaise = cfg.BB
    this.dealerId = null
    this.toAct = -1
    this.turnSeq = 0
    this.handNo = 0
    this.holes = {}
    this.deck = []
    this.result = null
    this.log = []
    this.lastAction = null // 마지막 행동 (화면 효과용)
    this.actSeq = 0
  }

  seat(id) { return this.seats.find(s => s.id === id) }
  isBetting() { return BETTING.includes(this.phase) }
  toActId() { return this.toAct >= 0 ? this.seats[this.toAct]?.id ?? null : null }

  addLog(msg) {
    this.log.push(msg)
    if (this.log.length > 40) this.log.shift()
  }

  addPlayer(id, name, stack) {
    if (this.seat(id)) return true
    if (this.seats.length >= this.cfg.MAX_SEATS) return false
    this.seats.push({
      id, name, stack: Math.max(0, Math.floor(stack) || 0),
      bet: 0, total: 0, folded: false, allIn: false, acted: false, inHand: false,
      sitOut: false, left: false, last: '',
    })
    this.addLog(`${name} 님이 입장했습니다.`)
    return true
  }

  updateInfo(id, { name, sitOut, tokens }) {
    const s = this.seat(id)
    if (!s) return
    if (name) s.name = name
    if (sitOut != null) s.sitOut = !!sitOut
    // 토큰 재지급: 바닥난 사람이 판에 참여 중이 아닐 때만, 기본 토큰만큼만
    if (tokens > 0 && s.stack === 0 && !(this.isBetting() && s.inHand)) {
      s.stack = Math.min(tokens | 0, this.cfg.START_TOKENS)
      this.addLog(`${s.name} 님이 기본 토큰을 다시 받았습니다.`)
    }
  }

  removePlayer(id, note = '나갔습니다.') {
    const idx = this.seats.findIndex(s => s.id === id)
    if (idx < 0) return
    const s = this.seats[idx]
    this.addLog(`${s.name} 님이 ${note}`)
    if (this.isBetting() && s.inHand) {
      s.left = true
      if (!s.folded) {
        if (idx === this.toAct) return this.act(id, 'fold')
        s.folded = true
        s.last = '나감'
        const live = this.seats.filter(p => p.inHand && !p.folded)
        if (live.length === 1) this._finishFold(live[0])
      }
    } else {
      this.seats.splice(idx, 1)
    }
  }

  eligible() {
    return this.seats.filter(s => !s.left && !s.sitOut && s.stack > 0)
  }

  // 새 핸드 시작. 성공하면 {플레이어id: [카드2장]}을 돌려준다(각자에게 몰래 보내야 함)
  startHand() {
    if (this.isBetting()) return null
    this.seats = this.seats.filter(s => !s.left)
    const elig = this.eligible()
    if (elig.length < 2) { this.phase = 'waiting'; return null }

    for (const s of this.seats) {
      Object.assign(s, { bet: 0, total: 0, folded: false, allIn: false, acted: false, last: '', inHand: elig.includes(s) })
    }
    this.handNo++
    this.board = []
    this.pot = 0
    this.result = null
    this.deck = shuffle(newDeck(), this.rand)

    const prev = this.seats.findIndex(s => s.id === this.dealerId)
    const dealer = this._nextInHand(prev)
    this.dealerId = this.seats[dealer].id
    const headsUp = elig.length === 2
    const sb = headsUp ? dealer : this._nextInHand(dealer)
    const bb = this._nextInHand(sb)
    this._put(this.seats[sb], this.cfg.SB)
    this._put(this.seats[bb], this.cfg.BB)
    this.seats[sb].last = `SB ${this.seats[sb].bet}`
    this.seats[bb].last = `BB ${this.seats[bb].bet}`
    this.currentBet = this.cfg.BB
    this.minRaise = this.cfg.BB

    this.holes = {}
    for (const s of elig) {
      this.holes[s.id] = [this.deck.pop(), this.deck.pop()]
    }
    this.phase = 'preflop'
    this.addLog(`— ${this.handNo}번째 판 시작 (${elig.length}명) —`)
    this._setTurn(this._nextToAct(bb))
    if (this.toAct < 0) this._endRound()
    return this.holes
  }

  act(id, type, amount) {
    if (!this.isBetting()) return { ok: false, error: '지금은 행동할 수 없습니다.' }
    const idx = this.seats.findIndex(s => s.id === id)
    if (idx < 0 || idx !== this.toAct) return { ok: false, error: '내 차례가 아닙니다.' }
    const s = this.seats[idx]
    const toCall = this.currentBet - s.bet

    if (type === 'fold') {
      s.folded = true
      s.last = '폴드'
    } else if (type === 'check' || (type === 'call' && toCall <= 0)) {
      if (toCall > 0) return { ok: false, error: '체크할 수 없습니다. 콜 또는 폴드하세요.' }
      s.last = '체크'
    } else if (type === 'call') {
      this._put(s, toCall)
      s.last = s.allIn ? '올인' : `콜 ${s.bet}`
    } else if (type === 'raise' || type === 'allin') {
      const maxTo = s.bet + s.stack
      let to = type === 'allin' ? maxTo : Math.floor(Number(amount))
      if (!Number.isFinite(to)) return { ok: false, error: '금액이 올바르지 않습니다.' }
      if (to >= maxTo) to = maxTo
      else if (to < this.currentBet + this.minRaise) {
        return { ok: false, error: `최소 ${this.currentBet + this.minRaise}까지 올려야 합니다.` }
      }
      const wasBet = this.currentBet > 0
      if (to > this.currentBet) this._raiseTo(s, to)
      else this._put(s, to - s.bet)
      s.last = s.allIn ? `올인 ${s.bet}` : `${wasBet ? '레이즈' : '벳'} ${s.bet}`
    } else {
      return { ok: false, error: '알 수 없는 행동입니다.' }
    }
    s.acted = true
    const kind = type === 'fold' ? 'fold' : s.allIn ? 'allin'
      : s.last.startsWith('체크') ? 'check' : s.last.startsWith('콜') ? 'call' : s.last.startsWith('벳') ? 'bet' : 'raise'
    this.lastAction = { id, kind, label: s.last, seq: ++this.actSeq }
    this.addLog(`${s.name}: ${s.last}`)
    this._advance()
    return { ok: true }
  }

  publicState() {
    const shown = this.result ? this.result.shown : {}
    return {
      phase: this.phase,
      handNo: this.handNo,
      board: this.board,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerId: this.dealerId,
      toActId: this.toActId(),
      turnSeq: this.turnSeq,
      lastAction: this.lastAction,
      result: this.result,
      log: this.log.slice(-25),
      bb: this.cfg.BB,
      seats: this.seats.map(s => ({
        id: s.id, name: s.name, stack: s.stack, bet: s.bet, folded: s.folded, allIn: s.allIn,
        inHand: s.inHand, sitOut: s.sitOut, left: s.left, last: s.last,
        cards: shown[s.id]?.cards || null,
      })),
    }
  }

  // ---- 내부 ----
  _put(s, x) {
    x = Math.min(x, s.stack)
    s.stack -= x
    s.bet += x
    s.total += x
    if (s.stack === 0) s.allIn = true
  }

  _raiseTo(s, to) {
    const size = to - this.currentBet
    this._put(s, to - s.bet)
    if (size >= this.minRaise) this.minRaise = size
    this.currentBet = to
    for (const p of this.seats) if (p !== s && p.inHand && !p.folded && !p.allIn) p.acted = false
  }

  _setTurn(i) {
    this.toAct = i
    this.turnSeq++
  }

  _nextInHand(from) {
    const n = this.seats.length
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n
      if (this.seats[i].inHand) return i
    }
    return -1
  }

  _needsAct(s) {
    return s.inHand && !s.folded && !s.allIn && (!s.acted || s.bet < this.currentBet)
  }

  _nextToAct(from) {
    const n = this.seats.length
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n
      if (this._needsAct(this.seats[i])) return i
    }
    return -1
  }

  _advance() {
    const live = this.seats.filter(s => s.inHand && !s.folded)
    if (live.length === 1) return this._finishFold(live[0])
    const next = this._nextToAct(this.toAct)
    if (next >= 0) return this._setTurn(next)
    this._endRound()
  }

  _collect() {
    for (const s of this.seats) {
      this.pot += s.bet
      s.bet = 0
      s.acted = false
    }
    this.currentBet = 0
    this.minRaise = this.cfg.BB
  }

  _endRound() {
    this._collect()
    if (this.phase === 'river') return this._showdown()
    const canAct = this.seats.filter(s => s.inHand && !s.folded && !s.allIn)
    if (canAct.length <= 1) {
      // 더 베팅할 사람이 없으면 남은 카드를 모두 깔고 승부
      while (this.board.length < 5) this.board.push(this.deck.pop())
      return this._showdown()
    }
    if (this.phase === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.phase = 'flop' }
    else if (this.phase === 'flop') { this.board.push(this.deck.pop()); this.phase = 'turn' }
    else if (this.phase === 'turn') { this.board.push(this.deck.pop()); this.phase = 'river' }
    for (const s of this.seats) if (s.inHand && !s.folded && !s.allIn) s.last = ''
    const dealer = this.seats.findIndex(s => s.id === this.dealerId)
    this._setTurn(this._nextToAct(dealer))
    if (this.toAct < 0) this._endRound()
  }

  _finishFold(winner) {
    this._collect()
    winner.stack += this.pot
    this.result = { winners: [{ id: winner.id, name: winner.name, amount: this.pot, hand: null }], shown: {} }
    this.addLog(`${winner.name} 님이 ${this.pot} 토큰을 가져갑니다.`)
    this._endHand()
  }

  _showdown() {
    const inHand = this.seats.filter(s => s.inHand)
    const live = inHand.filter(s => !s.folded)
    const evals = {}
    const shown = {}
    for (const s of live) {
      evals[s.id] = evaluate([...this.holes[s.id], ...this.board])
      shown[s.id] = { cards: this.holes[s.id], hand: evals[s.id].name }
    }
    // 딜러 다음 자리부터 순서대로(나머지 칩 배분 순서)
    const dealer = this.seats.findIndex(s => s.id === this.dealerId)
    const order = live.slice().sort((a, b) => this._dist(dealer, a) - this._dist(dealer, b))

    // 사이드팟: 각자 낸 총액 기준으로 층을 나눠 정산
    const levels = [...new Set(inHand.map(s => s.total))].filter(v => v > 0).sort((a, b) => a - b)
    const won = {}
    let prev = 0
    for (const lvl of levels) {
      let amount = 0
      for (const s of inHand) amount += Math.min(s.total, lvl) - Math.min(s.total, prev)
      prev = lvl
      if (!amount) continue
      let elig = order.filter(s => s.total >= lvl)
      if (!elig.length) elig = order
      let best = null
      for (const s of elig) if (!best || compareScore(evals[s.id].score, best) > 0) best = evals[s.id].score
      const winners = elig.filter(s => compareScore(evals[s.id].score, best) === 0)
      const share = Math.floor(amount / winners.length)
      let rest = amount - share * winners.length
      for (const w of winners) {
        won[w.id] = (won[w.id] || 0) + share + (rest > 0 ? 1 : 0)
        if (rest > 0) rest--
      }
    }
    const winners = []
    for (const s of order) {
      if (!won[s.id]) continue
      s.stack += won[s.id]
      winners.push({ id: s.id, name: s.name, amount: won[s.id], hand: evals[s.id].name, best: evals[s.id].cards })
      this.addLog(`${s.name} 님이 ${evals[s.id].name}(으)로 ${won[s.id]} 토큰 획득!`)
    }
    this.result = { winners, shown }
    this._endHand()
  }

  _dist(from, s) {
    const n = this.seats.length
    return ((this.seats.indexOf(s) - from + n) % n) || n
  }

  _endHand() {
    this.phase = 'showdown'
    this.pot = 0
    this._setTurn(-1)
  }
}
