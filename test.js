'use strict';
// node test.js — 요청 접수 → 스팸 방어 → admin 승인 흐름과 필터 점수 확인
process.env.DB_PATH = ':memory:';
process.env.SUPABASE_URL = ''; // 테스트는 항상 로컬 SQLite로
process.env.ADMIN_PASSWORD = 'pw';
const assert = require('node:assert/strict');
const { server, ready } = require('./lib/app');
const { score } = require('./public/shared.js');

(async () => {
  await ready;
  // Slack 알림: 가짜 웹훅 서버로 받는다
  const slack = [];
  const hook = require('node:http').createServer((q, s) => { let d = ''; q.on('data', (c) => (d += c)).on('end', () => { slack.push(JSON.parse(d).text); s.end('ok'); }); });
  await new Promise((r) => hook.listen(0, r));
  process.env.SLACK_WEBHOOK_URL = `http://localhost:${hook.address().port}/`;
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
  assert.ok(slack.length === 1 && slack[0].includes('새 팀 등록 요청') && slack[0].includes('테스트FC'), '등록 요청이 Slack으로 감');
  assert.equal((await add('테스트FC', 'https://instagram.com/test_fc_zz'))[0], 409, '같은 인스타 중복 차단');
  assert.deepEqual((await call('POST', '/api/requests', { type: 'add', payload: { name: 'x', region: '서울', instagram: 'a', level: 'pro' } })).map((x) => x.field || x), [400, 'level'], '잘못된 enum은 어느 칸인지 알려줌');
  assert.equal((await call('POST', '/api/requests', { type: 'add', payload: { name: 'x', region: '서울' } }))[1].field, 'instagram', '연락 수단이 없으면 인스타 칸을 가리킴');
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

  const page = await fetch(base + '/teams/' + encodeURIComponent('서울') + '/' + encodeURIComponent('마포구'));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes('서울 마포구 여자풋살팀') && html.includes('테스트FC'), '지역 페이지에 팀이 서버 렌더링됨');
  assert.equal((await fetch(base + '/teams/' + encodeURIComponent('없는곳'))).status, 404);
  assert.ok((await (await fetch(base + '/sitemap.xml')).text()).includes('/teams/%EC%84%9C%EC%9A%B8</loc>'));

  const sameName = { type: 'add', payload: { name: '테스트FC', region: '서울', contact: 'https://open.kakao.com/o/x' } };
  assert.equal((await call('POST', '/api/requests', sameName))[0], 409, '같은 지역 같은 이름은 기본적으로 막음');
  assert.equal((await call('POST', '/api/requests', { ...sameName, confirm_new: true }))[0], 201, '다른 팀이라고 확인하면 접수');
  assert.equal((await call('POST', '/api/requests', { type: 'add', confirm_new: true, payload: { name: '테스트FC2', region: '서울', instagram: '@test_fc_zz' } }))[0], 409, '인스타가 같으면 확인해도 막음');

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await add(`스팸${i}`, `spam_${i}`))[0]);
  assert.deepEqual(codes, [201, 201, 429, 429, 429, 429], 'IP당 하루 5건');

  const t = { region: '서울', district: '마포구', level: 'beginner', orientation: 'both', has_coach: null, recruiting: true };
  assert.ok(score(t, { region: '서울', level: 'beginner', orientation: 'friendly' }) > 0);
  assert.equal(score(t, { region: '부산' }), -1);
  assert.equal(score(t, { level: 'advanced' }), -1);
  assert.ok(score(t, { coach: true }) >= 0, '정보 없음은 제외하지 않음');
  assert.equal(score({ ...t, recruiting: null }, { recruiting: true }), -1);

  assert.ok(slack.some((t) => t.includes('정보 수정 요청')), '수정 요청도 Slack으로 감');
  hook.close();
  server.close();
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
