// 다른 JMTT 게임에서 코인 벌기 안내 (파산 안내창·로비 캐셔에 보여 줌). 로비 세션이 관리
// 운영자 결정 2026-11-18: 게임을 하나씩 나열하지 않고 JMTT 메인으로 보낸다 (게임이 늘어도 고칠 필요 없음)
// "다른 JMTT 게임에서도 코인을 벌 수 있어요 · JMTT 메인으로 가기 →" — cls로 모양은 쓰는 곳이 정한다
export const earnHtml = (cls = 'jmtt-earn') =>
  `<span class="${cls}">다른 JMTT 게임에서도 코인을 벌 수 있어요 · <a href="/">JMTT 메인으로 가기 →</a></span>`
