'use strict';
// 저장소. SUPABASE_URL이 있으면 Supabase(PostgREST를 내장 fetch로 호출), 없으면 로컬 SQLite(개발·테스트용).
// 두 구현은 같은 함수 집합을 내보내고, 호출부는 전부 await 한다. 스키마는 supabase/migrations 참고.
const path = require('node:path');

const COLS = ['name', 'region', 'district', 'level', 'instagram', 'contact', 'orientation', 'has_coach', 'coach_info', 'members', 'recruiting', 'note', 'source_url'];

function supabase() {
  const base = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/`;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY가 필요합니다 (service_role 또는 sb_secret_ 키)');
  const q = encodeURIComponent;
  async function rest(method, pathAndQuery, body, prefer) {
    const r = await fetch(base + pathAndQuery, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body && JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`supabase ${method} ${pathAndQuery.split('?')[0]} → ${r.status}: ${await r.text()}`);
    return r;
  }
  const rows = async (pathAndQuery) => (await rest('GET', pathAndQuery)).json();
  const count = async (pathAndQuery) => +(await rest('GET', `${pathAndQuery}&select=id&limit=1`, null, 'count=exact')).headers.get('content-range').split('/')[1];
  return {
    kind: 'supabase',
    teams: () => rows('teams?select=*&order=name'),
    team: async (id) => (await rows(`teams?id=eq.${+id}`))[0],
    addTeam: async (t) => (await (await rest('POST', 'teams', t, 'return=representation')).json())[0].id,
    setTeam: (id, t) => rest('PATCH', `teams?id=eq.${+id}`, { ...t, updated_at: new Date().toISOString() }),
    dropTeam: (id) => rest('DELETE', `teams?id=eq.${+id}`), // 대기 중 요청의 team_id는 FK(on delete set null)로 비워지고, 승인 시 거절 안내가 뜬다
    teamCount: () => count('teams?id=gt.0'),
    recentCount: (ipHash) => count(`requests?ip_hash=eq.${q(ipHash)}&created_at=gt.${q(new Date(Date.now() - 864e5).toISOString())}`),
    pendingCount: () => count('requests?status=eq.pending'),
    isDup: async (p) => (p.instagram
      ? (await count(`teams?instagram=eq.${q(p.instagram)}`)) + (await count(`requests?status=eq.pending&type=eq.add&payload->>instagram=eq.${q(p.instagram)}`))
      : await count(`teams?name=eq.${q(p.name)}&region=eq.${q(p.region)}`)) > 0,
    addRequest: (r) => rest('POST', 'requests', r),
    pending: () => rows('requests?status=eq.pending&order=id&select=*,team:teams(*)'),
    request: async (id) => (await rows(`requests?id=eq.${+id}`))[0],
    setStatus: (id, status) => rest('PATCH', `requests?id=eq.${+id}`, { status }),
  };
}

function sqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data', 'futsal.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, district TEXT, level TEXT,
      instagram TEXT, contact TEXT, orientation TEXT, has_coach INTEGER, coach_info TEXT,
      members INTEGER, recruiting INTEGER, note TEXT, source_url TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, team_id INTEGER, payload TEXT NOT NULL,
      requester TEXT, message TEXT, ip_hash TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const val = (v) => (typeof v === 'boolean' ? +v : v); // node:sqlite는 boolean을 바인딩하지 못한다
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const team = (id) => db.prepare('SELECT * FROM teams WHERE id=?').get(id);
  const parse = (r) => r && { ...r, payload: JSON.parse(r.payload) };
  return {
    kind: 'sqlite',
    teams: () => db.prepare('SELECT * FROM teams ORDER BY name').all(),
    team,
    addTeam: (t) => {
      const cols = COLS.filter((c) => c in t);
      return Number(db.prepare(`INSERT INTO teams (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => val(t[c]))).lastInsertRowid);
    },
    setTeam: (id, t) => {
      const cols = COLS.filter((c) => c in t);
      if (cols.length) db.prepare(`UPDATE teams SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((c) => val(t[c])), id);
    },
    dropTeam: (id) => {
      db.prepare('DELETE FROM teams WHERE id=?').run(id);
      db.prepare("UPDATE requests SET team_id=NULL WHERE team_id=? AND status='pending'").run(id);
    },
    teamCount: () => n('SELECT COUNT(*) n FROM teams'),
    recentCount: (ipHash) => n("SELECT COUNT(*) n FROM requests WHERE ip_hash=? AND created_at > datetime('now','-1 day')", ipHash),
    pendingCount: () => n("SELECT COUNT(*) n FROM requests WHERE status='pending'"),
    isDup: (p) => !!(p.instagram
      ? db.prepare("SELECT 1 FROM teams WHERE instagram=?1 UNION SELECT 1 FROM requests WHERE status='pending' AND type='add' AND json_extract(payload,'$.instagram')=?1").get(p.instagram)
      : db.prepare('SELECT 1 FROM teams WHERE name=? AND region=?').get(p.name, p.region)),
    addRequest: (r) => db.prepare('INSERT INTO requests (type, team_id, payload, requester, message, ip_hash) VALUES (?,?,?,?,?,?)').run(r.type, r.team_id, JSON.stringify(r.payload), r.requester, r.message, r.ip_hash),
    pending: () => db.prepare("SELECT * FROM requests WHERE status='pending' ORDER BY id").all().map((r) => ({ ...parse(r), team: (r.team_id && team(r.team_id)) || null })),
    request: (id) => parse(db.prepare('SELECT * FROM requests WHERE id=?').get(id)),
    setStatus: (id, status) => db.prepare('UPDATE requests SET status=? WHERE id=?').run(status, id),
  };
}

module.exports = process.env.SUPABASE_URL ? supabase() : sqlite();
