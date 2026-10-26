// 연결 계층: P2P(WebRTC)로 먼저 연결하고, 직접 연결이 안 되는 상대와는 Firebase(Firestore)로 중계한다.
// 서로 다른 통신사/회사 와이파이처럼 직접 연결이 막히는 경우에도 같은 방에서 게임할 수 있게 하기 위함.
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm'
import * as cloud from './cloud.js'

export { selfId }

const ACTIONS = ['state', 'hole', 'info', 'move', 'kick']
// 서로를 찾을 때 쓰는 공개 Nostr 서버. Trystero 기본 목록에 죽은 서버가 섞여 있어서 잘 되는 곳으로 지정
// (2026-10-23 기준 접속 확인). 모든 사람이 같은 목록을 써야 서로 찾을 수 있음
const SIGNAL_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
]
// 테스트용: ?nop2p 를 붙이면 직접 연결을 끄고 중계만 사용
const NO_P2P = new URLSearchParams(location.search).has('nop2p')

export function createNet(appId, code, { onJoin, onLeave, onMessage }) {
  const p2p = new Set()    // 직접 연결된 상대
  const relay = new Map()  // 중계로 보이는 상대: peerId → uid
  const joined = new Set()

  const announce = id => {
    if (!joined.has(id)) { joined.add(id); onJoin(id) }
  }
  const maybeLeave = id => {
    if (joined.has(id) && !p2p.has(id) && !relay.has(id)) { joined.delete(id); onLeave(id) }
  }

  let room = null
  const acts = {}
  if (!NO_P2P) {
    room = joinRoom({ appId, relayConfig: { urls: SIGNAL_RELAYS, warnOnRelayFailure: false } }, 'poker-' + code)
    for (const a of ACTIONS) {
      acts[a] = room.makeAction(a)
      acts[a].onMessage = (d, { peerId }) => onMessage(a, d, peerId)
    }
    room.onPeerJoin = id => { p2p.add(id); announce(id) }
    room.onPeerLeave = id => { p2p.delete(id); maybeLeave(id) }
  }

  let relayLink = null
  if (cloud.enabled && cloud.uid()) {
    relayLink = cloud.joinRelay(code, selfId, {
      onPeers: peers => {
        for (const [id, uid] of peers) if (!relay.has(id)) { relay.set(id, uid); announce(id) }
        for (const id of [...relay.keys()]) if (!peers.has(id)) { relay.delete(id); maybeLeave(id) }
      },
      onMessage: (a, d, from) => { if (ACTIONS.includes(a)) onMessage(a, d, from) },
    })
  }

  return {
    // target이 없으면 연결된 모두에게. 상대마다 직접 연결이 있으면 직접, 없으면 중계로 보냄
    send(a, data, target) {
      const targets = target ? [target] : [...joined]
      const direct = targets.filter(id => p2p.has(id))
      if (direct.length && acts[a]) acts[a].send(data, { target: direct })
      for (const id of targets) {
        if (!p2p.has(id) && relay.has(id)) relayLink?.send(id, relay.get(id), a, data)
      }
    },
    relayOn: !!relayLink,
    leave() {
      room?.leave()
      relayLink?.leave()
    },
  }
}
