// HTTP 도우미: 응답 보내기, 정적 파일, 기기 쿠키 (CASINO.md 2장 정적 파일 규칙)
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

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

export async function sendFile(req, res, file) {
  const body = await readFile(file)
  // 페이지를 처음 여는 기기에는 기기 쿠키를 준다
  const extra = file.endsWith('.html') && !deviceOf(req) ? { 'Set-Cookie': deviceCookie(newDevice(), req) } : {}
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra })
  res.end(body)
}
