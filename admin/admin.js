'use strict';
const $ = (id) => document.getElementById(id);
let teams = [];
let requests = [];

async function load() {
  [requests, teams] = await Promise.all([api('GET', '/api/admin/requests'), api('GET', '/api/teams')]);
  render();
}

function render() {
  $('reqCount').textContent = `(${requests.length})`;
  $('requests').innerHTML = requests.length ? requests.map((r) => {
    const rows = Object.entries(r.payload).map(([k, v]) => `<tr><th>${esc(LABELS[k] || k)}</th>${r.type === 'edit' ? `<td class="old">${esc(fmt(k, r.team && r.team[k]))}</td>` : ''}<td>${esc(fmt(k, v))}</td></tr>`).join('');
    return `<article class="card">
      <div class="card-head"><h2>${r.type === 'add' ? '등록' : '수정'} · ${esc(r.type === 'add' ? r.payload.name : r.team ? r.team.name : '(삭제된 팀)')}</h2><span class="loc">${esc(r.created_at)}</span></div>
      <table class="diff">${r.type === 'edit' ? '<tr class="diff-head"><th>바뀌는 항목</th><td>변경 전</td><td>변경 후</td></tr>' : ''}${rows}</table>
      ${r.requester ? `<p class="meta">요청자 · ${esc(r.requester)}</p>` : ''}${r.message ? `<p class="note">${esc(r.message)}</p>` : ''}
      <div class="card-foot"><button class="btn primary" data-req="${r.id}" data-action="approve">승인</button><button class="btn" data-req="${r.id}" data-action="reject">거절</button></div>
    </article>`;
  }).join('') : '<p class="empty">대기 중인 요청이 없어요.</p>';

  const q = $('q').value.trim();
  const list = teams.filter((t) => !q || `${t.name} ${t.region} ${t.district || ''}`.includes(q));
  $('teamCount').textContent = `(${teams.length})`;
  $('teams').innerHTML = list.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc([t.region, t.district].filter(Boolean).join(' '))}</td><td>${esc(fmt('recruiting', t.recruiting))}</td><td>${esc(t.updated_at.slice(0, 10))}</td>
    <td class="row-actions"><button class="link" data-edit="${t.id}">수정</button><button class="link danger" data-del="${t.id}">삭제</button></td></tr>`).join('');
}

function teamDialog(team) {
  openTeamDialog({
    title: team ? `${team.name} 수정` : '팀 추가', team: team || {}, admin: true, button: '저장',
    submit: async (vals) => {
      await (team ? api('PUT', `/api/admin/teams/${team.id}`, vals) : api('POST', '/api/admin/teams', vals));
      $('dlg').close();
      await load();
    },
  });
}

// API 응답이 올 때까지 화면의 모든 버튼을 잠근다 (승인 후 바로 거절 같은 중복·충돌 요청 방지).
// 성공하면 목록을 다시 그리고, 성공·실패 모두 잠금을 푼다.
async function withBusy(call) {
  const buttons = [...document.querySelectorAll('button:not(:disabled)')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await call();
    await load();
  } catch (err) {
    alert(err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

document.addEventListener('click', (e) => {
  const d = e.target.dataset;
  if (d.req) withBusy(() => api('POST', `/api/admin/requests/${d.req}`, { action: d.action }));
  else if (d.edit) teamDialog(teams.find((t) => t.id === +d.edit));
  else if (d.del && confirm('이 팀을 삭제할까요? 되돌릴 수 없어요.')) withBusy(() => api('DELETE', `/api/admin/teams/${d.del}`));
});
$('q').oninput = render;
$('newBtn').onclick = () => teamDialog(null);
load().catch((err) => alert(err.message));
