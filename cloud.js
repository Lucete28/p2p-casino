// Firebase(구글 로그인 + Firestore) 연결. 토큰과 재지급 횟수를 계정에 저장해서 기기가 바뀌어도 이어진다.
import { firebaseConfig } from './firebase-config.js?v=1.6.0'

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/'
// 로컬 테스트용: localhost에서 ?emu 를 붙이면 Firebase 에뮬레이터에 연결
const EMU = new URLSearchParams(location.search).has('emu') && ['localhost', '127.0.0.1'].includes(location.hostname)

// 로컬 개발용: localhost에서 ?local 을 붙이면 Firebase 없이 브라우저 저장만 사용
const LOCAL = new URLSearchParams(location.search).has('local') && ['localhost', '127.0.0.1'].includes(location.hostname)

export const enabled = !LOCAL && !!(firebaseConfig || EMU)

let A, F, auth, db

export async function initCloud(onUser) {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ])
  A = authMod
  F = fsMod
  const app = initializeApp(EMU ? { apiKey: 'demo', projectId: 'demo-poker', authDomain: 'localhost' } : firebaseConfig)
  auth = A.getAuth(app)
  db = F.getFirestore(app)
  if (EMU) {
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    F.connectFirestoreEmulator(db, '127.0.0.1', 8080)
  }
  A.onAuthStateChanged(auth, onUser)
}

export const login = () => A.signInWithPopup(auth, new A.GoogleAuthProvider())
export const logout = () => A.signOut(auth)

export async function loadPlayer(uid) {
  const snap = await F.getDoc(F.doc(db, 'players', uid))
  return snap.exists() ? snap.data() : null
}

export const savePlayer = (uid, data) => F.setDoc(F.doc(db, 'players', uid), data)

export const uid = () => auth?.currentUser?.uid || null

// ---------- 사용 통계 (관리자만 볼 수 있음) ----------
// stats_days/{YYYY-MM-DD}/users/{uid}: 그날 접속한 사람 (하루 한 번만 기록)
// stats_days/{YYYY-MM-DD}/rooms/{id}: 그날 만든 방 (최대 인원, 플레이한 판 수)
export const dayKey = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10) // 한국 날짜

// isNew: 오늘 처음 가입했는지, via: 초대 링크로 들어왔는지 ('invite' | 'direct')
export async function recordVisit({ isNew = false, via = 'direct' } = {}) {
  const u = uid()
  if (!u) return
  const day = dayKey()
  const key = `p2pcasino.visit.${u}.${day}`
  try { if (localStorage.getItem(key)) return } catch {}
  await F.setDoc(F.doc(db, 'stats_days', day, 'users', u), { at: F.serverTimestamp(), isNew, via })
  try { localStorage.setItem(key, '1') } catch {}
}

// ---------- 공개 방 목록 ----------
// lobby/{방코드}: 방장 닉네임, 사람 수, 봇 수, 게임 중인지, 방에 있는 사람들의 계정(방장 이어받기용), 버전
const LOBBY_FRESH_MS = 75000 // 방장은 30초마다 갱신. 이보다 오래 갱신이 없으면 닫힌 방으로 봄

export function publishRoom(code, info) {
  return F.setDoc(F.doc(db, 'lobby', code), { ...info, at: F.serverTimestamp() })
}
export const unpublishRoom = code => F.deleteDoc(F.doc(db, 'lobby', code))

const lobbyQuery = () => F.query(F.collection(db, 'lobby'), F.orderBy('at', 'desc'), F.limit(30))
const freshRooms = snap => snap.docs
  .map(d => ({ code: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
  .filter(r => Date.now() - (r.at?.toMillis?.() ?? Date.now()) < LOBBY_FRESH_MS)

export function watchLobby(cb) {
  return F.onSnapshot(lobbyQuery(), snap => cb(freshRooms(snap)), err => console.warn('lobby', err))
}
export async function listRooms() {
  return freshRooms(await F.getDocs(lobbyQuery()))
}

// ---------- 주간 시즌 랭킹 ----------
// seasons/{그 주 월요일 날짜}/players/{uid}: 이번 주 순수익(net), 판 수, 이긴 판 수
export function seasonKey(t = Date.now()) {
  const kst = new Date(t + 9 * 3600e3)
  const dow = (kst.getUTCDay() + 6) % 7 // 월요일 = 0
  return new Date(kst.getTime() - dow * 86400e3).toISOString().slice(0, 10)
}

export async function recordHandResult(name, delta) {
  const u = uid()
  if (!u) return
  await F.setDoc(F.doc(db, 'seasons', seasonKey(), 'players', u), {
    name: String(name || '').slice(0, 12),
    net: F.increment(delta),
    hands: F.increment(1),
    wins: F.increment(delta > 0 ? 1 : 0),
    at: F.serverTimestamp(),
  }, { merge: true })
}

export async function loadSeason(season = seasonKey(), n = 10) {
  const col = F.collection(db, 'seasons', season, 'players')
  const top = await F.getDocs(F.query(col, F.orderBy('net', 'desc'), F.limit(n)))
  const rows = top.docs.map(d => ({ uid: d.id, ...d.data() }))
  let me = null
  const u = uid()
  if (u) {
    const mine = await F.getDoc(F.doc(col, u))
    if (mine.exists()) {
      const ahead = await F.getCountFromServer(F.query(col, F.where('net', '>', mine.data().net)))
      me = { ...mine.data(), rank: ahead.data().count + 1 }
    }
  }
  const total = (await F.getCountFromServer(col)).data().count
  return { season, rows, me, total }
}

export async function recordRoom(code) {
  if (!uid()) return null
  return F.addDoc(F.collection(db, 'stats_days', dayKey(), 'rooms'),
    { by: uid(), code, at: F.serverTimestamp(), maxPlayers: 1, hands: 0 })
}
export const recordHand = ref => F.updateDoc(ref, { hands: F.increment(1) })
export const recordPlayers = (ref, n) => F.updateDoc(ref, { maxPlayers: n })

export async function isAdmin() {
  const u = uid()
  return !!u && (await F.getDoc(F.doc(db, 'admins', u))).exists()
}

export async function loadStats(days) {
  return Promise.all(days.map(async day => {
    const [users, rooms] = await Promise.all([
      F.getDocs(F.collection(db, 'stats_days', day, 'users')),
      F.getDocs(F.collection(db, 'stats_days', day, 'rooms')),
    ])
    return { day, users: users.docs.map(d => ({ uid: d.id, ...d.data() })), rooms: rooms.docs.map(d => d.data()) }
  }))
}

export async function loadPlayers() {
  const col = F.collection(db, 'players')
  const [count, top] = await Promise.all([
    F.getCountFromServer(col),
    F.getDocs(F.query(col, F.orderBy('tokens', 'desc'), F.limit(10))),
  ])
  return { total: count.data().count, top: top.docs.map(d => d.data()) }
}

// ---------- 중계 (직접 연결이 안 될 때) ----------
// rooms/{방코드}/peers/{peerId}: 방에 있는 사람 (주기적으로 갱신, 오래되면 나간 것으로 봄)
// rooms/{방코드}/msgs/{id}: 받는 사람(toUid)만 읽을 수 있는 메시지. 받으면 바로 지움
const BEAT_MS = 45000
const STALE_MS = 120000

export function joinRelay(code, selfId, { onPeers, onMessage }) {
  const { doc, setDoc, deleteDoc, collection, onSnapshot, query, where, addDoc, serverTimestamp } = F
  const me = auth.currentUser.uid
  const peersCol = collection(db, 'rooms', code, 'peers')
  const msgsCol = collection(db, 'rooms', code, 'msgs')
  const myPeer = doc(peersCol, selfId)

  const beat = () => setDoc(myPeer, { uid: me, at: serverTimestamp() }).catch(err => console.warn('relay beat', err))
  beat()
  const beatTimer = setInterval(beat, BEAT_MS)

  let lastPeers = []
  const emitPeers = () => {
    const now = Date.now()
    const fresh = new Map()
    for (const p of lastPeers) if (p.id !== selfId && now - p.at < STALE_MS) fresh.set(p.id, p.uid)
    onPeers(fresh)
  }
  const unsubPeers = onSnapshot(peersCol, snap => {
    lastPeers = snap.docs.map(d => {
      const v = d.data({ serverTimestamps: 'estimate' })
      return { id: d.id, uid: v.uid, at: v.at?.toMillis?.() ?? Date.now() }
    })
    emitPeers()
  }, err => console.warn('relay peers', err))
  const staleTimer = setInterval(emitPeers, 20000)

  const lastState = {}
  const unsubMsgs = onSnapshot(query(msgsCol, where('toUid', '==', me)), snap => {
    const mine = []
    for (const c of snap.docChanges()) {
      if (c.type !== 'added') continue
      const m = c.doc.data({ serverTimestamps: 'estimate' })
      if (m.to === selfId) { mine.push(m); deleteDoc(c.doc.ref).catch(() => {}) }
      // 같은 계정의 예전 접속으로 온 오래된 메시지는 정리
      else if (Date.now() - (m.t?.toMillis?.() ?? Date.now()) > STALE_MS) deleteDoc(c.doc.ref).catch(() => {})
    }
    mine.sort((a, b) => a.n - b.n)
    for (const m of mine) {
      if (m.a === 'state') {
        if (m.n <= (lastState[m.from] ?? 0)) continue // 늦게 도착한 옛 상태는 버림
        lastState[m.from] = m.n
      }
      let data
      try { data = JSON.parse(m.d) } catch { continue }
      onMessage(m.a, data, m.from)
    }
  }, err => console.warn('relay msgs', err))

  let n = 0
  return {
    send(toId, toUid, a, data) {
      addDoc(msgsCol, { to: toId, toUid, from: selfId, fromUid: me, a, d: JSON.stringify(data), n: ++n, t: serverTimestamp() })
        .catch(err => console.warn('relay send', err))
    },
    leave() {
      clearInterval(beatTimer)
      clearInterval(staleTimer)
      unsubPeers()
      unsubMsgs()
      deleteDoc(myPeer).catch(() => {})
    },
  }
}
