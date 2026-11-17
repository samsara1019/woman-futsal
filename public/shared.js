'use strict';
const REGIONS = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const SEOUL_GU = ['강남구', '강동구', '강북구', '강서구', '관악구', '광진구', '구로구', '금천구', '노원구', '도봉구', '동대문구', '동작구', '마포구', '서대문구', '서초구', '성동구', '성북구', '송파구', '양천구', '영등포구', '용산구', '은평구', '종로구', '중구', '중랑구'];
const LEVEL = { beginner: '비기너', intermediate: '인터미디엇', advanced: '어드밴스드' };
const ORIENT = { friendly: '친선 지향', competition: '대회 지향', both: '대회 + 친선' };
const YESNO = { has_coach: { true: '코치 있음', false: '코치 없음' }, recruiting: { true: '적극 모집중', false: '모집 안 함' } };

// [키, 라벨, 타입, 옵션]
const FORM_FIELDS = [
  ['name', '팀 이름', 'text', 40],
  ['region', '지역', 'select', Object.fromEntries(REGIONS.map((r) => [r, r]))],
  ['district', '구/시/군 (서울은 구)', 'text', 20],
  ['level', '실력', 'select', LEVEL],
  ['orientation', '대회/친선 지향', 'select', ORIENT],
  ['instagram', '인스타그램 (@계정 또는 주소)', 'text', 200],
  ['contact', '가입문의 연락처 (오픈채팅 링크 등 · 비우면 인스타로 안내)', 'text', 200],
  ['has_coach', '코치 유무', 'bool', YESNO.has_coach],
  ['coach_info', '코치 정보 (성별, 경력 등)', 'text', 100],
  ['members', '인원', 'number'],
  ['recruiting', '팀원 모집 여부', 'bool', YESNO.recruiting],
  ['note', '한 줄 소개 (활동 요일, 구장 등)', 'text', 200],
];
const ADMIN_FIELDS = [...FORM_FIELDS, ['source_url', '출처 URL', 'text', 500]];
const LABELS = Object.fromEntries(ADMIN_FIELDS.map((f) => [f[0], f[1]]));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(k, v) {
  if (v == null) return '—';
  return (YESNO[k] && YESNO[k][v]) || (k === 'level' && LEVEL[v]) || (k === 'orientation' && ORIENT[v]) || String(v);
}

// 필터 f에 대한 팀 t의 적합도. -1이면 제외. 정보 없음(null)은 제외하지 않고 뒤로 보낸다.
function score(t, f) {
  if (f.region && t.region !== f.region) return -1;
  let s = 0;
  if (f.district) { if (t.district === f.district) s += 2; else if (t.district) return -1; }
  if (f.level) { if (t.level === f.level) s += 1; else if (t.level) return -1; }
  if (f.orientation) { if (t.orientation === f.orientation || t.orientation === 'both') s += 1; else if (t.orientation) return -1; }
  if (f.coach) { if (t.has_coach) s += 1; else if (t.has_coach === false) return -1; }
  if (f.recruiting && t.recruiting !== true) return -1;
  return s + (t.recruiting ? 0.5 : 0);
}

// 팀 카드. 브라우저(결과 목록)와 서버(지역별 페이지)가 같이 쓴다. edit=true면 수정 요청 버튼을 붙인다.
function card(t, edit) {
  const join = /^https?:\/\//.test(t.contact || '') ? t.contact : t.instagram;
  const ext = `target="_blank" rel="noopener noreferrer" data-team="${esc(t.name)}"`;
  const facts = [
    t.recruiting ? '<span class="status on">모집중</span>' : t.recruiting === false ? '<span class="status">모집 안 함</span>' : '',
    LEVEL[t.level], ORIENT[t.orientation], t.has_coach == null ? '' : YESNO.has_coach[t.has_coach],
    t.members ? `<span class="num">${t.members}</span>명` : '',
  ].filter(Boolean);
  return `<article class="card">
    <div class="card-head"><h2>${esc(t.name)}</h2><span class="loc">${esc([t.region, t.district].filter(Boolean).join(' '))}</span></div>
    ${facts.length ? `<p class="facts">${facts.map((x) => `<span>${x}</span>`).join('')}</p>` : ''}
    ${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
    ${t.coach_info ? `<p class="meta">코치 · ${esc(t.coach_info)}</p>` : ''}
    ${t.contact && join !== t.contact ? `<p class="meta">문의 · ${esc(t.contact)}</p>` : ''}
    <div class="card-foot">
      ${join ? `<a class="btn primary" href="${esc(join)}" ${ext}>가입 문의</a>` : t.source_url ? `<a class="btn" href="${esc(t.source_url)}" ${ext}>모집글 보기</a>` : ''}
      ${t.instagram && join !== t.instagram ? `<a class="btn" href="${esc(t.instagram)}" ${ext}>인스타그램</a>` : ''}
      ${edit ? `<button class="link" data-edit="${t.id}">정보 수정 요청</button>` : ''}
    </div>
  </article>`;
}

function teamFormHTML(t = {}, admin = false) {
  return (admin ? ADMIN_FIELDS : FORM_FIELDS).map(([k, label, type, opt]) => {
    const v = t[k];
    const req = k === 'name' || k === 'region' ? ' required' : '';
    let input;
    if (type === 'select' || type === 'bool') {
      input = `<select name="${k}"${req}><option value="">${req ? '선택' : '모름'}</option>${Object.entries(opt)
        .map(([val, l]) => `<option value="${val}"${String(v) === val ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    } else if (type === 'number') {
      input = `<input name="${k}" type="number" min="1" max="999" inputmode="numeric" value="${esc(v)}">`;
    } else {
      input = `<input name="${k}" maxlength="${opt}" value="${esc(v)}"${req}${k === 'district' ? ' list="gu"' : ''}>`;
    }
    return `<label>${label}${input}</label>`;
  }).join('') + `<datalist id="gu">${SEOUL_GU.map((g) => `<option value="${g}">`).join('')}</datalist>`;
}

function readTeamForm(form, admin = false) {
  const o = {};
  for (const [k, , type] of admin ? ADMIN_FIELDS : FORM_FIELDS) {
    const v = form.elements[k].value.trim();
    o[k] = v === '' ? null : type === 'bool' ? v === 'true' : type === 'number' ? Number(v) : v;
  }
  return o;
}

// 팀 폼 다이얼로그. submit(values, form)이 throw하면 메시지를 폼에 표시한다.
function openTeamDialog({ title, intro = '', team = {}, admin = false, extra = '', button = '보내기', submit }) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form><h2>${esc(title)}</h2>${intro ? `<p class="hint">${esc(intro)}</p>` : ''}${teamFormHTML(team, admin)}${extra}
    <p class="status" role="status"></p>
    <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary">${esc(button)}</button></div></form>`;
  const form = dlg.querySelector('form');
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const st = form.querySelector('.status');
    st.textContent = '처리 중…';
    try { await submit(readTeamForm(form, admin), form); } catch (err) { st.textContent = err.message; }
  };
  dlg.showModal();
}

async function api(method, url, data) {
  const r = await fetch(url, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '요청에 실패했어요');
  return j;
}

if (typeof module !== 'undefined') module.exports = { score, card, esc, REGIONS };
