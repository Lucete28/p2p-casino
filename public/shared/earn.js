// 코인을 벌 수 있는 다른 JMTT 게임 (파산 안내·캐셔에 보여 줌). 로비 세션이 관리
// 기준: home-server auth/coin.js의 EARN_APPS = mine, snowman, button (2026-11-17). 메인에서 바뀌면 여기만 고친다
export const EARN_GAMES = [
  { id: 'mine', name: '지뢰찾기 대전', href: '/mine' },
  { id: 'snowman', name: '데굴데굴 눈사람', href: '/snowman' },
  { id: 'button', name: '~싶을 때 누르는 버튼', href: '/button' },
]

// "다른 JMTT 게임에서도 코인을 벌 수 있어요: 지뢰찾기 대전 · …" (링크). cls로 모양은 쓰는 곳이 정한다
export const earnHtml = (cls = 'jmtt-earn') =>
  `<span class="${cls}">다른 JMTT 게임에서도 코인을 벌 수 있어요: ${EARN_GAMES.map(g => `<a href="${g.href}">${g.name}</a>`).join(' · ')}</span>`
