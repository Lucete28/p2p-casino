// Firebase(구글 로그인 + Firestore) 연결. 토큰과 재지급 횟수를 계정에 저장해서 기기가 바뀌어도 이어진다.
import { firebaseConfig } from './firebase-config.js'

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
