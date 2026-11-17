'use strict';
// node test.js — 요청 접수 → 스팸 방어 → admin 승인 흐름과 필터 점수 확인
process.env.DB_PATH = ':memory:';
process.env.SUPABASE_URL = ''; // 테스트는 항상 로컬 SQLite로
process.env.ADMIN_PASSWORD = 'pw';
const assert = require('node:assert/strict');
const { server, ready } = require('./server');
const { score } = require('./public/shared.js');

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('a:pw').toString('base64') };
  const call = async (method, url, data, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data && JSON.stringify(data) });
    return [r.status, await r.json().catch(() => null)];
  };
  const add = (name, ig) => call('POST', '/api/requests', { type: 'add', payload: { name, region: '서울', district: '마포구', instagram: ig, level: 'beginner' } });

  assert.equal((await call('GET', '/api/teams'))[0], 200);
  assert.equal((await add('테스트FC', '@test_fc_zz'))[0], 201);
  assert.equal((await add('테스트FC', 'https://instagram.com/test_fc_zz'))[0], 409, '같은 인스타 중복 차단');
  assert.equal((await call('POST', '/api/requests', { type: 'add', payload: { name: 'x', region: '서울', instagram: 'a', level: 'pro' } }))[0], 400, '잘못된 enum');
  assert.equal((await call('POST', '/api/requests', { type: 'add', website: 'spam', payload: {} }))[0], 201, '허니팟은 조용히 버림');

  assert.equal((await call('GET', '/api/admin/requests'))[0], 401);
  assert.equal((await call('GET', '/admin'))[0], 401);
  assert.equal((await call('GET', '/api/admin/requests', null, { Authorization: 'Basic ' + Buffer.from('a:wrong').toString('base64') }))[0], 401);
  let [, reqs] = await call('GET', '/api/admin/requests', null, auth);
  assert.equal(reqs.length, 1, '허니팟·거부된 요청은 쌓이지 않음');
  assert.equal((await call('POST', `/api/admin/requests/${reqs[0].id}`, { action: 'approve' }, auth))[0], 200);
  let team = (await call('GET', '/api/teams'))[1].find((t) => t.name === '테스트FC');
  assert.equal(team.instagram, 'https://www.instagram.com/test_fc_zz/');

  assert.equal((await call('POST', '/api/requests', { type: 'edit', team_id: team.id, payload: { recruiting: true } }))[0], 400, '수정 요청은 확인용 연락처 필수');
  assert.equal((await call('POST', '/api/requests', { type: 'edit', team_id: team.id, payload: { recruiting: true, members: 14 }, requester: '@test_fc_zz' }))[0], 201);
  [, reqs] = await call('GET', '/api/admin/requests', null, auth);
  await call('POST', `/api/admin/requests/${reqs[0].id}`, { action: 'approve' }, auth);
  team = (await call('GET', '/api/teams'))[1].find((t) => t.id === team.id);
  assert.deepEqual([team.recruiting, team.members, team.level], [true, 14, 'beginner']);

  assert.equal((await call('PUT', `/api/admin/teams/${team.id}`, { level: 'advanced' }, auth))[0], 200);
  assert.equal((await call('PUT', `/api/admin/teams/${team.id}`, { level: 'advanced' }))[0], 401);

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await add(`스팸${i}`, `spam_${i}`))[0]);
  assert.deepEqual(codes, [201, 201, 201, 429, 429, 429], 'IP당 하루 5건');

  const t = { region: '서울', district: '마포구', level: 'beginner', orientation: 'both', has_coach: null, recruiting: true };
  assert.ok(score(t, { region: '서울', level: 'beginner', orientation: 'friendly' }) > 0);
  assert.equal(score(t, { region: '부산' }), -1);
  assert.equal(score(t, { level: 'advanced' }), -1);
  assert.ok(score(t, { coach: true }) >= 0, '정보 없음은 제외하지 않음');
  assert.equal(score({ ...t, recruiting: null }, { recruiting: true }), -1);

  server.close();
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
