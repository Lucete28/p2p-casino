// 카지노 서버 저장소 (/app/data/casino.db, SQLite 하나). 서버가 꺼졌다 켜져도 코인이 사라지거나 두 번 들어가지 않게
// 자리(맡긴 칩)·정산 대기·판 기록(30일)·월간 랭킹·사용 통계를 둔다
import { DatabaseSync } from 'node:sqlite'

export const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10)
export const monthKey = (t = Date.now()) => kstDay(t).slice(0, 8) + '01'

export function openStore(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    -- 앉아 있는 자리: 판이 끝날 때마다 칩을 적어 둔다 (판 도중 꺼지면 이 값 = 그 판 무효)
    CREATE TABLE IF NOT EXISTS seats (
      session TEXT PRIMARY KEY, room TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT,
      intended INTEGER NOT NULL DEFAULT 0, chunk INTEGER NOT NULL DEFAULT 100000,
      staked INTEGER NOT NULL, stack INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
    -- state: staking(맡기는 중) → seated(앉음) → closed(정산 대기열로 넘김)
    -- auth에 아직 못 보낸 정산 (보낼 때까지 다시 시도, ref가 같아 두 번 들어가지 않음)
    CREATE TABLE IF NOT EXISTS pending (
      ref TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, tries INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS hands (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, hand_no INTEGER, at INTEGER, data TEXT);
    CREATE INDEX IF NOT EXISTS hands_at ON hands (at);
    CREATE TABLE IF NOT EXISTS season (
      month TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, net INTEGER DEFAULT 0, hands INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
      PRIMARY KEY (month, user_id));
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, name TEXT, first_day TEXT);
    CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, user_id TEXT NOT NULL, fresh INTEGER DEFAULT 0, PRIMARY KEY (day, user_id));
    CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, day TEXT, max_players INTEGER DEFAULT 1, hands INTEGER DEFAULT 0);
    -- 하우스 게임(블랙잭·바카라·룰렛·슬롯) 판 기록 (운영자 확인용, 30일)
    CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT, user_id TEXT, round TEXT, bet INTEGER, payout INTEGER, at INTEGER, data TEXT);
    CREATE INDEX IF NOT EXISTS rounds_at ON rounds (at);
    -- 게임별 첫 방문 기념 칩을 받은 기록 (계정당 게임마다 한 번)
    CREATE TABLE IF NOT EXISTS welcome (user_id TEXT NOT NULL, game TEXT NOT NULL, chips INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, game));
  `)
  // v1.9.0 (카지노 로비): 자리에 게임 이름과 '진행 중인 판에 건 칩'을 더한다. 예전 행은 홀덤
  const cols = new Set(db.prepare('PRAGMA table_info(seats)').all().map(c => c.name))
  if (!cols.has('game')) db.exec("ALTER TABLE seats ADD COLUMN game TEXT NOT NULL DEFAULT 'holdem'")
  if (!cols.has('in_play')) db.exec('ALTER TABLE seats ADD COLUMN in_play INTEGER NOT NULL DEFAULT 0')
  const q = sql => db.prepare(sql)

  return {
    db,
    // ---- 자리와 정산 ----
    // 맡기기 전에 먼저 적어 둔다: 맡기는 도중 꺼지면 다시 켜질 때 같은 ref로 다시 물어 실제 맡긴 양을 알아낸다
    seatOpen(session, room, user, name, intended, chunk, game = 'holdem') {
      q('INSERT INTO seats (session, room, user_id, name, intended, chunk, staked, stack, state, at, game) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)')
        .run(session, room, user, name, intended, chunk, 'staking', Date.now(), game)
    },
    // 하우스 게임: 판마다 칩과 '진행 중인 판에 건 칩'을 함께 적는다 (판 도중 꺼지면 건 칩은 돌려줌)
    seatPlay(session, stack, inPlay) { q("UPDATE seats SET stack = ?, in_play = ?, at = ? WHERE session = ? AND state = 'seated'").run(stack, inPlay, Date.now(), session) },
    // 첫 방문 기념 칩: 받았는지, 받은 것으로 적기 (처음 적은 쪽만 true → 동시에 두 번 들어와도 한 번)
    welcomeGiven: (user, game) => !!q('SELECT 1 FROM welcome WHERE user_id = ? AND game = ?').get(user, game),
    welcomeMark: (user, game, chips) => q('INSERT OR IGNORE INTO welcome (user_id, game, chips, at) VALUES (?, ?, ?, ?)').run(user, game, chips, Date.now()).changes === 1,
    // 기념 칩만으로 자리를 연다 (맡긴 코인 0, 칩 = 기념 칩). 나갈 때 칩은 다른 칩처럼 코인으로 정산
    seatOpenGift(session, table, user, name, chips, game) {
      q('INSERT INTO seats (session, room, user_id, name, intended, chunk, staked, stack, state, at, game) VALUES (?, ?, ?, ?, 0, 100000, 0, ?, ?, ?, ?)')
        .run(session, table, user, name, chips, 'seated', Date.now(), game)
    },
    // 이 사람이 지금 앉아 있는 자리 (한 번에 한 게임만). 칩을 모두 잃은 하우스 게임 자리(칩 0, 진행 중 0)는 빈 자리로 본다
    openSeatOf: user => q(`SELECT * FROM seats WHERE user_id = ? AND (state = 'staking' OR (state = 'seated' AND (stack > 0 OR in_play > 0)))
      ORDER BY at DESC`).get(user) || null,
    seatStaked(session, staked) {
      q("UPDATE seats SET staked = ?, stack = ?, state = 'seated', at = ? WHERE session = ? AND state = 'staking'").run(staked, staked, Date.now(), session)
    },
    seatStack(session, stack) { q("UPDATE seats SET stack = ?, at = ? WHERE session = ? AND state = 'seated'").run(stack, Date.now(), session) },
    // 자리를 닫고 정산할 금액을 대기열에 넣는다 (한 트랜잭션). 이미 닫힌 자리면 null
    seatClose(session, stack, reason, chunk) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const s = q("SELECT * FROM seats WHERE session = ? AND state IN ('seated', 'staking')").get(session)
        if (!s) { db.exec('COMMIT'); return null }
        const amount = Math.max(0, stack ?? s.stack)
        q("UPDATE seats SET stack = ?, state = 'closed', at = ? WHERE session = ?").run(amount, Date.now(), session)
        for (let i = 0, left = amount; left > 0; i++, left -= chunk) {
          q('INSERT OR IGNORE INTO pending (ref, user_id, amount, reason, at) VALUES (?, ?, ?, ?, ?)')
            .run(`cashout:${s.room}:${session}${i ? ':' + i : ''}`, s.user_id, Math.min(chunk, left), reason, Date.now())
        }
        db.exec('COMMIT')
        return { ...s, amount }
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    openSeats: () => q("SELECT * FROM seats WHERE state IN ('seated', 'staking')").all(),
    pendingAll: () => q('SELECT * FROM pending ORDER BY at').all(),
    pendingOf: user => q('SELECT * FROM pending WHERE user_id = ? ORDER BY at').all(user),
    pendingDone: ref => q('DELETE FROM pending WHERE ref = ?').run(ref),
    pendingTried: ref => q('UPDATE pending SET tries = tries + 1 WHERE ref = ?').run(ref),
    seatStats: room => q('SELECT staked, stack FROM seats WHERE room = ?').all(room),

    // ---- 판 기록 (운영자 확인용, 30일) ----
    logHand(room, handNo, data) { q('INSERT INTO hands (room, hand_no, at, data) VALUES (?, ?, ?, ?)').run(room, handNo, Date.now(), JSON.stringify(data)) },
    pruneHands() {
      q('DELETE FROM hands WHERE at < ?').run(Date.now() - 30 * 86400e3)
      q('DELETE FROM rounds WHERE at < ?').run(Date.now() - 30 * 86400e3)
    },
    logRound(game, user, round, bet, payout, data) {
      q('INSERT INTO rounds (game, user_id, round, bet, payout, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(game, user, round, bet, payout, Date.now(), JSON.stringify(data ?? null))
    },

    // ---- 월간 랭킹 (코인 순이익) ----
    seasonAdd(user, name, delta, won) {
      q(`INSERT INTO season (month, user_id, name, net, hands, wins) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (month, user_id) DO UPDATE SET name = excluded.name, net = net + excluded.net, hands = hands + 1, wins = wins + excluded.wins`)
        .run(monthKey(), user, name, delta, won ? 1 : 0)
    },
    season(month, n, me) {
      const rows = q('SELECT user_id, name, net, hands FROM season WHERE month = ? ORDER BY net DESC LIMIT ?').all(month, n)
      const total = q('SELECT COUNT(*) c FROM season WHERE month = ?').get(month).c
      let mine = null
      if (me) {
        const r = q('SELECT net, hands FROM season WHERE month = ? AND user_id = ?').get(month, me)
        if (r) mine = { ...r, rank: q('SELECT COUNT(*) c FROM season WHERE month = ? AND net > ?').get(month, r.net).c + 1 }
      }
      return { season: month, rows, total, me: mine }
    },

    // ---- 사용 통계 ----
    visit(user, name) {
      const day = kstDay()
      const known = q('SELECT 1 FROM users WHERE user_id = ?').get(user)
      if (!known) q('INSERT INTO users (user_id, name, first_day) VALUES (?, ?, ?)').run(user, name, day)
      else q('UPDATE users SET name = ? WHERE user_id = ?').run(name, user)
      q('INSERT OR IGNORE INTO visits (day, user_id, fresh) VALUES (?, ?, ?)').run(day, user, known ? 0 : 1)
    },
    roomOpened(room) { q('INSERT OR IGNORE INTO rooms (room, day) VALUES (?, ?)').run(room, kstDay()) },
    roomHand(room, players) {
      q('UPDATE rooms SET hands = hands + 1, max_players = MAX(max_players, ?) WHERE room = ?').run(players, room)
    },
    stats(days) {
      const list = []
      for (let i = days - 1; i >= 0; i--) {
        const day = kstDay(Date.now() - i * 86400e3)
        const v = q('SELECT COUNT(*) users, SUM(fresh) fresh FROM visits WHERE day = ?').get(day)
        const r = q('SELECT COUNT(*) rooms, SUM(hands) hands, AVG(max_players) avg FROM rooms WHERE day = ?').get(day)
        list.push({ day, users: v.users, fresh: v.fresh || 0, rooms: r.rooms, hands: r.hands || 0, avgPlayers: r.avg || 0 })
      }
      const usersIn = (from, to) => new Set(q('SELECT user_id FROM visits WHERE day >= ? AND day <= ?').all(from, to).map(x => x.user_id))
      const thisWeek = usersIn(kstDay(Date.now() - 6 * 86400e3), kstDay())
      const lastWeek = usersIn(kstDay(Date.now() - 13 * 86400e3), kstDay(Date.now() - 7 * 86400e3))
      return {
        days: list,
        totalUsers: q('SELECT COUNT(*) c FROM users').get().c,
        week: thisWeek.size, lastWeek: lastWeek.size, cameBack: [...lastWeek].filter(u => thisWeek.has(u)).length,
      }
    },
  }
}
