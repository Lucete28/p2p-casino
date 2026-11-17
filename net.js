// 카지노 서버와의 웹소켓 연결 (v1.8.0~). 예전 P2P(Trystero·Nostr)·Firebase 중계는 쓰지 않는다.
// 끊기면 자동으로 다시 연결하고, 다시 연결되면 onOpen에서 같은 방에 다시 들어간다 (서버가 60초 동안 자리를 지켜 줌)
export function connect({ onOpen, onClose, onMessage }) {
  const url = new URL('ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let ws = null, wait = 1000, stopped = false, opened = false
  const api = {
    ready: false,
    send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)) },
    close() { stopped = true; ws?.close() },
  }
  function open() {
    opened = false
    ws = new WebSocket(url)
    ws.onopen = () => { opened = true; wait = 1000; api.ready = true; onOpen?.() }
    ws.onmessage = e => { let d; try { d = JSON.parse(e.data) } catch { return } onMessage?.(d) }
    ws.onclose = async () => {
      api.ready = false
      if (stopped) return
      // 한 번도 열리지 못하고 끊겼으면 로그인이 풀렸는지 확인 (서버는 로그인 안 한 연결을 받지 않음)
      let auth = false
      if (!opened) {
        try { const r = await fetch('/auth/me?optional=1', { cache: 'no-store' }); auth = r.ok && (await r.json()) === null } catch {}
      }
      onClose?.({ auth })
      if (auth) return
      setTimeout(open, wait)
      wait = Math.min(wait * 2, 15000)
    }
  }
  open()
  return api
}
