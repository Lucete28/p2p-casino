// HTTP 도우미: 응답 보내기, 정적 파일, 기기 쿠키 (CASINO.md 2장 정적 파일 규칙)
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

export const BASE = '/casino'

export function send(res, code, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body)
  res.writeHead(code, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(json ? JSON.stringify(body) : body)
}
export const redirect = (res, code, location) => send(res, code, '', { Location: location })

// 기기 표시: 브라우저마다 무작위 번호를 쿠키로 하나 준다 (한 기기에서 여러 계정으로 같은 테이블에 앉지 못하게, 운영자 결정 2026-11-17)
const DEVICE_COOKIE = 'casino_device'
export const deviceOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)casino_device=([A-Za-z0-9_-]{16,40})/)?.[1] || null
export const newDevice = () => randomBytes(16).toString('base64url')
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '')
export const deviceCookie = (id, req) => `${DEVICE_COOKIE}=${id}; Path=${BASE}; Max-Age=${2 * 365 * 86400}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`

// ---------- 정적 파일 ----------
// public/ 아래만, 허용한 확장자만. 점으로 시작하는 이름·'..'·*.md·package.json·test-*는 내보내지 않는다
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
}
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

// rel: '/casino' 뒤의 경로 ('/', '/holdem/', '/holdem/app.js'). 반환: 보낼 파일 경로 · 'dir'(끝에 / 붙여 다시) · null
export async function resolveStatic(publicDir, rel) {
  let path = rel
  if (path.endsWith('/')) path += 'index.html'
  const parts = path.slice(1).split('/')
  if (!parts.every(p => SEGMENT.test(p))) return null
  const name = parts.at(-1)
  const ext = extname(name).toLowerCase()
  if (!ext) {
    // 확장자 없는 주소: 폴더면 끝에 / 를 붙여 다시 오게 (상대 경로가 맞게)
    try { if ((await stat(join(publicDir, ...parts))).isDirectory()) return 'dir' } catch {}
    return null
  }
  if (!TYPES[ext] || name === 'package.json' || /\.md$/i.test(name) || name.startsWith('test-')) return null
  const file = resolve(publicDir, ...parts)
  if (!file.startsWith(publicDir + sep)) return null
  try { if (!(await stat(file)).isFile()) return null } catch { return null }
  return file
}

// 파일은 메모리에 한 번 읽어 두고(바뀌면 다시) ETag로 304. 캐시 머리말 (#부하, 2026-11-20):
//   html = no-cache (매번 확인) · js·css·json = 60초 (배포 뒤 1분 안에 새 파일) · 그림·소리·글꼴 = 하루
const files = new Map() // 경로 → { mtimeMs, body, etag }
const cacheOf = ext => ext === '.html' ? 'no-cache' : /^\.(js|mjs|css|json)$/.test(ext) ? 'public, max-age=60' : 'public, max-age=86400'
export async function sendFile(req, res, file) {
  const st = await stat(file)
  let f = files.get(file)
  if (!f || f.mtimeMs !== st.mtimeMs) {
    const body = await readFile(file)
    f = { mtimeMs: st.mtimeMs, body, etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"' }
    files.set(file, f)
  }
  const ext = extname(file).toLowerCase()
  // 페이지를 처음 여는 기기에는 기기 쿠키를 준다
  const extra = ext === '.html' && !deviceOf(req) ? { 'Set-Cookie': deviceCookie(newDevice(), req) } : {}
  const head = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cacheOf(ext), ETag: f.etag, ...extra }
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, head); return res.end() }
  res.writeHead(200, head)
  res.end(req.method === 'HEAD' ? undefined : f.body)
}

// 없는 주소·아직 열리지 않은 게임: 브라우저면 돌아갈 길이 있는 작은 화면 (#길찾기), 아니면 글자만
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
export function notFound(req, res, msg = '찾는 페이지가 없어요') {
  if (!/text\/html/.test(req.headers.accept || '')) return send(res, 404, 'not found')
  send(res, 404, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(msg)} · JMTT 카지노</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070706;color:#f3ead7;font:16px/1.6 Pretendard,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}h1{color:#e8c26a;font-size:22px;margin:0 0 20px}a{display:inline-block;margin:6px;padding:10px 18px;border-radius:12px;border:1px solid rgba(232,194,106,.4);color:#e8c26a;text-decoration:none;font-weight:700}a.main{background:#e8c26a;color:#1a1408}</style></head>
<body><main><h1>${esc(msg)}</h1><a class="main" href="${BASE}/">카지노 로비로</a><a href="/">JMTT 메인으로</a></main></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' })
}
