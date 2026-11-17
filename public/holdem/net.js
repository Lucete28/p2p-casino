// 카지노 서버와의 웹소켓 연결 (v1.8.0~). 예전 P2P(Trystero·Nostr)·Firebase 중계는 쓰지 않는다.
// 끊기면 자동으로 다시 연결하고, 다시 연결되면 onOpen에서 같은 방에 다시 들어간다 (서버가 60초 동안 자리를 지켜 줌)
export function connect({ onOpen, onClose, onMessage }) {
  const url = new URL('ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let ws = null, wait = 1000, stopped = false, opened = false
  // 죽은 연결 알아채기: 폰이 망을 바꾸거나 잠깐 꺼지면 브라우저는 한동안 '열림'으로 알고 보낸 것을 조용히 버린다.
  // 20초마다(그리고 화면에 돌아올 때) 서버에 ping을 보내고, 정해진 시간 안에 아무 응답이 없으면 끊고 다시 연결
  let lastSeen = 0, probeAt = 0, probeMs = 0
  const api = {
    ready: false,
    send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); else api.probe(0) },
    close() { stopped = true; ws?.close() },
    // 지금 연결이 살아 있는지 ms 안에 확인 (응답이 없으면 다시 연결)
    probe(ms = 4000) {
      if (stopped || !ws || ws.readyState === 0) return
      if (ws.readyState !== 1) return reconnect()
      if (probeAt && probeMs <= ms) return
      probeAt = Date.now(); probeMs = ms
      ws.send(JSON.stringify({ t: 'ping' }))
    },
  }
  function reconnect() {
    const old = ws
    if (!old) return
    old.onopen = old.onmessage = old.onclose = null
    try { old.close() } catch {}
    closed()
  }
  async function closed() {
    api.ready = false
    probeAt = 0
    if (stopped) return
    // 한 번도 열리지 못하고 끊겼으면 로그인이 풀렸는지 확인 (서버는 로그인 안 한 연결을 받지 않음)
    let auth = false
    if (!opened) {
      try { const r = await fetch('/auth/me?optional=1', { cache: 'no-store' }); auth = r.ok && (await r.json()) === null } catch {}
    }
    onClose?.({ auth })
    if (auth) return
    setTimeout(open, opened ? 300 : wait)
    if (!opened) wait = Math.min(wait * 2, 15000)
    opened = false
  }
  function open() {
    if (stopped) return
    opened = false
    probeAt = 0
    ws = new WebSocket(url)
    ws.onopen = () => { opened = true; wait = 1000; lastSeen = Date.now(); api.ready = true; onOpen?.() }
    ws.onmessage = e => {
      lastSeen = Date.now(); probeAt = 0
      let d; try { d = JSON.parse(e.data) } catch { return }
      if (d.t !== 'pong') onMessage?.(d)
    }
    ws.onclose = closed
  }
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return
    if (probeAt && Date.now() - probeAt > probeMs) return reconnect()
    if (Date.now() - lastSeen > 20000) api.probe(8000)
  }, 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) api.probe(3000) })
  addEventListener('online', () => api.probe(3000))
  open()
  return api
}
