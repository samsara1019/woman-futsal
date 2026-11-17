'use strict';
try { process.loadEnvFile(); } catch { /* .env 없으면 환경변수만 사용 */ }
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const ROOT = path.join(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'data', 'seed');
const MAX_PER_IP_PER_DAY = 5; // 한 IP가 하루에 보낼 수 있는 요청 수
const MAX_PENDING = 300; // 대기 요청이 이만큼 쌓이면 접수 중단 (admin이 처리할 때까지)
// ponytail: 방어는 IP 제한 + 허니팟 + 중복 차단 + 대기열 상한까지. 봇이 뚫으면 Turnstile 같은 캡차 추가.

const REGIONS = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const ORIENTS = ['competition', 'friendly', 'both'];

const fail = (status, message) => Object.assign(new Error(message), { status });

// 신뢰 경계: 공개 요청·admin 입력·시드 모두 여기를 통과한다. partial=true면 넘어온 키만 검증.
function cleanTeam(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '잘못된 요청입니다');
  const t = {};
  const text = (k, max) => {
    if (!(k in input)) return;
    const v = input[k];
    if (v != null && typeof v !== 'string') throw fail(400, `${k} 형식이 올바르지 않습니다`);
    t[k] = (v && v.trim().slice(0, max)) || null;
  };
  const oneOf = (k, list) => {
    if (!(k in input)) return;
    const v = input[k] || null;
    if (v !== null && !list.includes(v)) throw fail(400, `${k} 값이 올바르지 않습니다`);
    t[k] = v;
  };
  const tri = (k) => {
    if (!(k in input)) return;
    const v = input[k];
    if (v != null && typeof v !== 'boolean') throw fail(400, `${k} 값이 올바르지 않습니다`);
    t[k] = v ?? null;
  };
  text('name', 40); oneOf('region', REGIONS); text('district', 20); oneOf('level', LEVELS);
  text('instagram', 200); text('contact', 200); oneOf('orientation', ORIENTS); tri('has_coach');
  text('coach_info', 100); tri('recruiting'); text('note', 200); text('source_url', 500);
  if (t.instagram) {
    const m = /^(?:https?:\/\/(?:www\.)?instagram\.com\/|@)?([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/.exec(t.instagram);
    if (!m) throw fail(400, '인스타그램 계정 또는 주소를 확인해주세요');
    t.instagram = `https://www.instagram.com/${m[1]}/`;
  }
  if (t.source_url && !/^https?:\/\//.test(t.source_url)) throw fail(400, '출처 주소가 올바르지 않습니다');
  if ('members' in input) {
    const v = input.members;
    if (v == null || v === '') t.members = null;
    else if (!Number.isInteger(v) || v < 1 || v > 999) throw fail(400, '인원은 1~999 사이 숫자여야 합니다');
    else t.members = v;
  }
  if ((!partial || 'name' in t) && !t.name) throw fail(400, '팀 이름이 필요합니다');
  if ((!partial || 'region' in t) && !t.region) throw fail(400, '지역을 선택해주세요');
  return t;
}

const bool = (v) => (v == null ? null : !!v);
const view = (t) => t && { ...t, has_coach: bool(t.has_coach), recruiting: bool(t.recruiting) };

async function seed() {
  if ((await db.teamCount()) || !fs.existsSync(SEED_DIR)) return;
  const seen = new Set();
  let n = 0;
  for (const f of fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json'))) {
    for (const raw of JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'))) {
      try {
        const t = cleanTeam(raw);
        const key = t.instagram || `${t.region}/${t.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await db.addTeam(t);
        n++;
      } catch (e) {
        console.warn(`seed skip (${f}): ${raw && raw.name} — ${e.message}`);
      }
    }
  }
  console.log(`seed: ${n}팀 등록 (${db.kind})`);
}
const ready = seed();

// ---- 공개 요청 접수 ----
async function submit(b, ip) {
  if (!b || typeof b !== 'object') throw fail(400, '잘못된 요청입니다');
  if (b.website) return { ok: true }; // 허니팟: 봇에게는 성공한 척
  if (b.type !== 'add' && b.type !== 'edit') throw fail(400, '잘못된 요청입니다');
  const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
  if ((await db.recentCount(ipHash)) >= MAX_PER_IP_PER_DAY) throw fail(429, '요청이 너무 많아요. 내일 다시 시도해주세요.');
  if ((await db.pendingCount()) >= MAX_PENDING) throw fail(503, '지금은 요청이 많이 밀려 있어요. 며칠 뒤 다시 시도해주세요.');

  const payload = cleanTeam(b.payload, b.type === 'edit');
  delete payload.source_url;
  const str = (v, max) => (typeof v === 'string' && v.trim().slice(0, max)) || null;
  const requester = str(b.requester, 100);
  let teamId = null;
  if (b.type === 'edit') {
    teamId = Number(b.team_id);
    if (!Number.isInteger(teamId) || !(await db.team(teamId))) throw fail(404, '팀을 찾을 수 없습니다');
    if (!Object.keys(payload).length) throw fail(400, '바뀐 내용이 없어요');
    if (!requester) throw fail(400, '확인용 연락처(인스타 계정 등)를 적어주세요');
  } else {
    if (!payload.instagram && !payload.contact) throw fail(400, '인스타그램이나 가입문의 연락처 중 하나는 필요해요');
    if (await db.isDup(payload)) throw fail(409, '이미 등록됐거나 검토 중인 팀이에요');
  }
  await db.addRequest({ type: b.type, team_id: teamId, payload, requester, message: str(b.message, 500), ip_hash: ipHash });
  return { ok: true };
}

// ---- admin ----
const ADMIN_PW = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
function isAdmin(req) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pw = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
  return crypto.timingSafeEqual(sha(pw), sha(ADMIN_PW));
}

// ponytail: 팀 반영과 상태 변경이 한 트랜잭션이 아니다. 관리자 한 명 기준으로는 충분하고, 동시 승인이 생기면 DB 함수(RPC)로 묶을 것.
async function resolveRequest(id, action) {
  const r = await db.request(id);
  if (!r) throw fail(404, '요청을 찾을 수 없습니다');
  if (r.status !== 'pending') throw fail(409, '이미 처리된 요청입니다');
  if (action === 'approve') {
    if (r.type === 'add') await db.addTeam(cleanTeam(r.payload));
    else if (r.team_id && (await db.team(r.team_id))) await db.setTeam(r.team_id, cleanTeam(r.payload, true));
    else throw fail(409, '대상 팀이 삭제되었습니다. 거절해주세요.');
  } else if (action !== 'reject') throw fail(400, '잘못된 요청입니다');
  await db.setStatus(id, action === 'approve' ? 'approved' : 'rejected');
  return { ok: true };
}

// ---- http ----
async function body(req) {
  // JSON만 받는다: Basic 인증이 자동 전송되므로, 교차 출처 폼 전송(CSRF)을 preflight로 막는 역할도 한다.
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw fail(415, 'JSON만 받습니다');
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 20000) throw fail(413, '요청이 너무 큽니다');
  }
  if (!s && req.body && typeof req.body === 'object') return req.body; // Vercel이 본문을 먼저 읽어 파싱해 둔 경우
  try { return JSON.parse(s); } catch { throw fail(400, '잘못된 JSON입니다'); }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
// 프록시 뒤에서는 TRUST_PROXY=1 필수(아니면 모든 사용자가 한 IP로 묶임). 프록시가 덧붙인 마지막 값을 쓴다.
const clientIp = (req) => ((process.env.TRUST_PROXY || process.env.VERCEL) && (req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// 정적 파일. 관리자 화면은 public 밖(admin/)에 둬서 인증 뒤에서만 내려준다.
// Vercel에서는 public/을 CDN이 직접 서빙하고 함수 번들에는 없을 수 있어, 없으면 건너뛴다.
const FILES = { '/admin': 'admin/admin.html', '/admin.js': 'admin/admin.js' };
const PUB = path.join(ROOT, 'public');
for (const f of fs.existsSync(PUB) ? fs.readdirSync(PUB) : []) FILES['/' + f] = 'public/' + f;
FILES['/'] = FILES['/index.html'];

// Google Analytics 4: GA_MEASUREMENT_ID가 있을 때만 켜진다. CSP가 인라인 스크립트를 막으므로 초기화 코드는 /ga.js로 내려준다.
const GA_ID = /^G-[A-Z0-9]{4,20}$/.test(process.env.GA_MEASUREMENT_ID || '') ? process.env.GA_MEASUREMENT_ID : '';
if (process.env.GA_MEASUREMENT_ID && !GA_ID) console.warn('GA_MEASUREMENT_ID 형식이 올바르지 않아 GA를 끕니다 (예: G-ABC123XYZ)');
const GA_JS = GA_ID ? `window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', '${GA_ID}');
document.head.append(Object.assign(document.createElement('script'), { async: true, src: 'https://www.googletagmanager.com/gtag/js?id=${GA_ID}' }));
` : '';
const CSP = "default-src 'self'; frame-ancestors 'none'" + (GA_ID ? "; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com" : '');

async function handle(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (p === '/ga.js' && m === 'GET') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end(GA_JS); }

  if (p === '/api/teams' && m === 'GET') return json(res, 200, (await db.teams()).map(view));
  if (p === '/api/requests' && m === 'POST') return json(res, 201, await submit(await body(req), clientIp(req)));

  if (p.startsWith('/api/admin/') || p.startsWith('/admin')) {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('인증이 필요합니다');
    }
    let mm;
    if (p === '/api/admin/requests' && m === 'GET') {
      return json(res, 200, (await db.pending()).map(({ ip_hash, ...r }) => ({ ...r, team: view(r.team) || null })));
    }
    if ((mm = /^\/api\/admin\/requests\/(\d+)$/.exec(p)) && m === 'POST') return json(res, 200, await resolveRequest(+mm[1], (await body(req)).action));
    if (p === '/api/admin/teams' && m === 'POST') return json(res, 201, { id: await db.addTeam(cleanTeam(await body(req))) });
    if ((mm = /^\/api\/admin\/teams\/(\d+)$/.exec(p))) {
      if (!(await db.team(+mm[1]))) throw fail(404, '팀을 찾을 수 없습니다');
      if (m === 'PUT') { await db.setTeam(+mm[1], cleanTeam(await body(req), true)); return json(res, 200, { ok: true }); }
      if (m === 'DELETE') {
        await db.dropTeam(+mm[1]);
        return json(res, 200, { ok: true });
      }
    }
  }

  const file = FILES[p];
  if (m === 'GET' && file) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(path.join(ROOT, file)));
  }
  throw fail(404, '찾을 수 없습니다');
}

// 요청 리스너. 로컬은 http 서버가, Vercel은 api/index.js가 호출한다.
const listener = (req, res) => {
  ready.then(() => handle(req, res)).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : '서버 오류가 발생했습니다' });
    else res.end();
  });
};
const server = http.createServer(listener);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  ready.then(() => server.listen(port, () => {
    console.log(`http://localhost:${port}  (admin: /admin, 아이디는 아무거나, 저장소: ${db.kind})`);
    if (!process.env.ADMIN_PASSWORD) console.log(`ADMIN_PASSWORD 미설정 → 이번 실행용 임시 비밀번호: ${ADMIN_PW}`);
  }), (e) => { console.error(e); process.exit(1); });
}

module.exports = { server, listener, cleanTeam, ready };
