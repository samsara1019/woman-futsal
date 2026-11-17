'use strict';
const app = document.getElementById('app');
const track = (name, params) => { if (window.gtag) gtag('event', name, params); }; // GA가 꺼져 있으면 아무 일도 안 함
const blank = () => ({ region: '', district: '', level: '', orientation: '', coach: false, recruiting: false });
let teams = [];
let f = blank();
let step = 0;
let mode = location.hash === '#all' ? 'results' : 'quiz'; // /#all 로 전체 목록 바로 열기
let prevK = 0; // 직전 렌더에서 공이 있던 지점 (전진 애니메이션의 출발점)
let finishing = false;
let q = ''; // 팀 이름 검색어
let showMap = false;

// 타일 지도: 실제 위치 관계대로 칸을 배치한다 (데이터가 시군구 단위라 핀 대신 칸). null은 빈 칸.
const KR_TILES = [
  ['인천', '서울', '경기', '강원'],
  ['충남', '세종', '충북', '경북'],
  ['전북', '대전', '대구', '울산'],
  ['광주', '전남', '경남', '부산'],
  [null, '제주', null, null],
];
const SEOUL_TILES = [
  [null, null, null, '도봉구', '노원구', null],
  [null, '은평구', '강북구', '성북구', '중랑구', null],
  [null, '서대문구', '종로구', '동대문구', '광진구', '강동구'],
  ['강서구', '마포구', '중구', '성동구', '송파구', null],
  ['양천구', '영등포구', '용산구', '강남구', null, null],
  ['구로구', '동작구', '서초구', null, null, null],
  ['금천구', '관악구', null, null, null, null],
];

// key(region|district)별 팀 수를 칸에 표시. base는 이 지도가 고르는 항목을 뺀 나머지 필터.
function tilesHTML(rows, cls, key, base) {
  const counts = {};
  for (const t of teams) if (t[key] && score(t, base) >= 0) counts[t[key]] = (counts[t[key]] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  return `<div class="tiles ${cls}">${rows.flat().map((name) => {
    if (!name) return '<span></span>';
    const n = counts[name] || 0;
    const label = name.length > 2 ? name.replace(/구$/, '') : name;
    // 색 단계는 제곱근 척도: 서울·경기만 진하고 나머지가 전부 같은 색이 되는 걸 막는다
    return `<button class="tile" id="tile-${name}" data-tile="${key}" data-v="${name}" data-l="${n ? Math.ceil(4 * Math.sqrt(n / max)) : 0}" aria-pressed="${f[key] === name}" aria-label="${name} ${n}팀"${n ? '' : ' disabled'}><span>${label}</span><span class="num">${n || ''}</span></button>`;
  }).join('')}</div>`;
}

const mapHTML = () => `<div class="map">
    <div><h2>시도별 팀 수</h2>${tilesHTML(KR_TILES, 'kr', 'region', { ...f, region: '', district: '' })}</div>
    ${f.region === '서울' ? `<div><h2>서울 구별 팀 수</h2>${tilesHTML(SEOUL_TILES, 'seoul', 'district', { ...f, district: '' })}</div>` : ''}
  </div>`;

// opts: [값, 라벨, 설명, 코트 위에 적을 짧은 라벨]
const STEPS = [
  { key: 'region', q: '어디서 뛰고 싶나요?', opts: REGIONS.map((r) => [r, r]) },
  { key: 'district', q: '서울 어느 구가 편한가요?', when: (f) => f.region === '서울', opts: [['', '서울 전체'], ...SEOUL_GU.map((g) => [g, g])] },
  { key: 'level', q: '풋살 경험이 어느 정도인가요?', opts: [
    ['beginner', '처음이에요', '공을 차본 적이 거의 없어요', '처음'],
    ['intermediate', '조금 해봤어요', '기본기가 있고 경기도 뛰어봤어요', '조금 해봄'],
    ['advanced', '꽤 해요', '대회 경험이 있어요', '꽤 함'],
  ] },
  { key: 'orientation', q: '어떤 분위기의 팀을 원하나요?', opts: [['friendly', '즐겁게, 친선 위주', '', '친선'], ['competition', '대회에 도전하는 팀', '', '대회'], ['', '상관없어요', '', '상관없음']] },
  { key: 'coach', q: '코치가 있는 팀을 원하나요?', opts: [[true, '네, 코치가 있으면 좋겠어요'], [false, '상관없어요']] },
];
const active = (i) => !STEPS[i].when || STEPS[i].when(f);

// ---- 코트: 답할 때마다 공이 골대 쪽으로 전진한다. (진행 방향 a, 폭 방향 c) 0~1 좌표 ----
const PTS = [[0.12, 0.5], [0.3, 0.24], [0.47, 0.7], [0.63, 0.3], [0.79, 0.66]];
const GOAL = [1.03, 0.5];

function courtSVG(v, picks, from, to) {
  const L = 400, W = v ? 200 : 152, pad = 16, il = L - 2 * pad, iw = W - 2 * pad;
  const m = ([a, c]) => (v ? [pad + c * iw, L - pad - a * il] : [pad + a * il, pad + c * iw]);
  const box = (a1, c1, a2, c2) => {
    const [x1, y1] = m([a1, c1]), [x2, y2] = m([a2, c2]);
    return `x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}"`;
  };
  const seg = (p, q) => { const [x1, y1] = m(p), [x2, y2] = m(q); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; };
  const dot = (p, r) => { const [x, y] = m(p); return `<circle cx="${x}" cy="${y}" r="${r}"/>`; };
  const tr = (p) => { const [x, y] = m(p); return `translate(${x}px, ${y}px)`; };
  const pt = (k) => (k === 'goal' ? GOAL : PTS[k]);
  const d = 0.3 * iw, da = d / il, id = v ? 'cv' : 'ch';
  const [cx, cy] = m([0.5, 0.5]);
  const stripes = [1, 3, 5, 7].map((i) => `<rect ${box(i / 8, 0, (i + 1) / 8, 1)}/>`).join('');
  const marks = picks.map((label, i) => {
    const p = PTS[i + 1], [x, y] = m(p);
    const text = v
      ? `<text class="pick" x="${x + (p[1] > 0.5 ? -14 : 14)}" y="${y + 4}" text-anchor="${p[1] > 0.5 ? 'end' : 'start'}">${esc(label)}</text>`
      : `<text class="pick" x="${x}" y="${y + (p[1] < 0.5 ? -15 : 25)}" text-anchor="middle">${esc(label)}</text>`;
    return `<circle class="player" cx="${x}" cy="${y}" r="9"/><text class="no" x="${x}" y="${y + 3.5}" text-anchor="middle">${i + 1}</text>${text}`;
  }).join('');
  const passes = [PTS[0], ...picks.map((_, i) => PTS[i + 1])].map((p) => m(p).join(',')).join(' ');
  return `<svg class="court ${v ? 'v' : 'h'}" viewBox="0 0 ${v ? W : L} ${v ? L : W}" aria-hidden="true">
    <defs><clipPath id="${id}"><rect ${box(0, 0, 1, 1)}/></clipPath></defs>
    <rect class="turf" width="100%" height="100%" rx="12"/>
    <g class="mow">${stripes}</g>
    <g class="lines">
      <rect ${box(0, 0, 1, 1)}/>${seg([0.5, 0], [0.5, 1])}<circle cx="${cx}" cy="${cy}" r="${0.16 * iw}"/>
      <g clip-path="url(#${id})"><rect ${box(-da, 0.125, da, 0.875)} rx="${d}"/><rect ${box(1 - da, 0.125, 1 + da, 0.875)} rx="${d}"/></g>
      <rect ${box(-0.03, 0.42, 0, 0.58)}/><rect ${box(1, 0.42, 1.03, 0.58)}/>
    </g>
    <g class="spots">${dot([0.5, 0.5], 2)}${dot([da * 0.66, 0.5], 1.5)}${dot([1 - da * 0.66, 0.5], 1.5)}</g>
    <polyline class="passes" points="${passes}"/>
    ${marks}
    <circle class="ball" r="5" data-from="${tr(pt(from))}" data-to="${tr(pt(to))}"/>
  </svg>`;
}

function render() {
  const focusId = document.activeElement && document.activeElement.id;
  app.innerHTML = mode === 'quiz' ? quizHTML() : resultsHTML();
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  // 이전 위치에 둔 뒤 다음 프레임에 목표 위치로 옮겨 CSS transition을 태운다 (CSP가 인라인 style 속성을 막으므로 JS로 지정)
  app.querySelectorAll('.ball').forEach((b) => { b.style.transform = b.dataset.from; });
  requestAnimationFrame(() => requestAnimationFrame(() => app.querySelectorAll('.ball').forEach((b) => { b.style.transform = b.dataset.to; })));
}

function quizHTML() {
  const s = STEPS[step];
  const shown = STEPS.filter((_, i) => active(i));
  const picks = STEPS.slice(0, step).filter((st) => active(STEPS.indexOf(st))).map((st) => { const o = st.opts.find((o) => o[0] === f[st.key]); return o[3] || o[1]; });
  const from = prevK, to = finishing ? 'goal' : picks.length;
  prevK = picks.length;
  return `<section class="quiz${finishing ? ' finishing' : ''}">
    <div class="pitch">${courtSVG(false, picks, from, to)}${courtSVG(true, picks, from, to)}</div>
    <div class="ask">
      ${step === 0 ? '<p class="lead">질문 몇 개로 나에게 맞는 여자 풋살팀을 찾아요</p>' : ''}
      <p class="step"><span class="num">${shown.indexOf(s) + 1}</span><span class="of">/ ${shown.length}</span></p>
      <h1>${s.q}</h1>
      <div class="chips${s.opts.length > 6 ? ' many' : ''}">${s.opts.map((o, i) => `<button class="chip" data-opt="${i}">${esc(o[1])}${o[2] ? `<small>${esc(o[2])}</small>` : ''}</button>`).join('')}</div>
      <p class="quiz-nav">${step ? '<button class="link" data-act="back">이전 질문</button>' : '<span></span>'}<button class="link" data-act="all">건너뛰고 전체 팀 보기</button></p>
    </div>
  </section>`;
}

const sel = (id, label, value, opts) => `<label>${label}<select id="${id}"><option value="">전체</option>${opts.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
const check = (id, label, on) => `<label class="check"><input type="checkbox" id="${id}"${on ? ' checked' : ''}>${label}</label>`;

const norm = (s) => s.toLowerCase().replace(/\s/g, '');

// 검색 입력 중에는 이 부분만 다시 그린다 (입력창을 다시 그리면 한글 조합이 끊긴다)
function listHTML() {
  const byName = norm(q);
  // 이름 검색은 다른 필터를 무시하고 전체 팀에서 찾는다
  const list = (byName ? teams.filter((t) => norm(t.name).includes(byName)).map((t) => [0, t]) : teams.map((t) => [score(t, f), t]).filter((x) => x[0] >= 0))
    .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'ko')).map((x) => x[1]);
  const filtered = byName || Object.values(f).some(Boolean);
  return `<p class="count"><span class="total"><span class="num">${list.length}</span>팀</span><span class="count-note">${byName ? '이름 검색 결과 · 전체 지역' : filtered ? '조건에 맞는 팀' : '전체'}</span>
      ${filtered ? '<button class="link" data-act="all">전체 보기</button>' : ''}<button class="link" data-act="quiz">질문 다시 하기</button></p>
    ${list.length ? `<div class="cards">${list.map((t) => card(t, true)).join('')}</div>`
      : `<p class="empty">${byName ? '그 이름의 팀을 찾지 못했어요. 아직 목록에 없다면 위의 팀 등록 요청으로 알려주세요.' : '조건에 딱 맞는 팀을 아직 찾지 못했어요. 조건을 줄이거나 전체 팀을 둘러보세요.<br>아는 팀이 있다면 위의 팀 등록 요청으로 알려주세요.'}</p>`}`;
}

function resultsHTML() {
  return `<section class="results">
    <div class="filters">
      <label class="search">팀 이름<input type="search" id="f-q" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></label>
      ${sel('f-region', '지역', f.region, REGIONS.map((r) => [r, r]))}
      ${f.region === '서울' ? sel('f-district', '구', f.district, SEOUL_GU.map((g) => [g, g])) : ''}
      ${sel('f-level', '실력', f.level, Object.entries(LEVEL))}
      ${sel('f-orientation', '지향', f.orientation, [['friendly', '친선'], ['competition', '대회']])}
      ${check('f-coach', '코치 있는 팀', f.coach)}
      ${check('f-recruiting', '모집중만', f.recruiting)}
      <button class="btn map-toggle" data-act="map" aria-expanded="${showMap}">${showMap ? '지도 닫기' : '지도로 보기'}</button>
    </div>
    ${showMap ? mapHTML() : ''}
    <div id="list">${listHTML()}</div>
  </section>`;
}

// 요청 폼 공통 부가 필드. website는 허니팟(사람에겐 안 보임).
const extra = (who) => `<label>${who}<input name="requester" maxlength="100"${who.includes('필수') ? ' required' : ''}></label>
  <label>남길 말 (선택)<textarea name="message" maxlength="500" rows="2"></textarea></label>
  <label class="hp" aria-hidden="true">website<input name="website" tabindex="-1" autocomplete="off"></label>`;

function requestDialog(team) {
  openTeamDialog({
    title: team ? `${team.name} 정보 수정 요청` : '팀 등록 요청',
    intro: team ? '바꾸고 싶은 항목만 고쳐서 보내주세요. 운영자가 확인한 뒤 반영해요.' : '운영자가 확인한 뒤 목록에 올려요. 모르는 항목은 비워두세요.',
    team: team || {},
    extra: extra(team ? '확인용 연락처 — 팀 인스타 계정 등 (필수)' : '요청하는 분 연락처 (선택)'),
    submit: async (vals, form) => {
      const payload = team ? Object.fromEntries(Object.entries(vals).filter(([k, v]) => v !== (team[k] ?? null))) : vals;
      await api('POST', '/api/requests', {
        type: team ? 'edit' : 'add', team_id: team && team.id, payload,
        requester: form.elements.requester.value, message: form.elements.message.value, website: form.elements.website.value,
      });
      track('request_submit', { request_type: team ? 'edit' : 'add' });
      document.getElementById('dlg').close();
      alert('요청을 보냈어요. 운영자 확인 후 반영됩니다.');
    },
  });
}

function showResults() { q = ''; finishing = false; prevK = 0; step = 0; mode = 'results'; render(); window.scrollTo(0, 0); }

app.addEventListener('click', (e) => {
  const out = e.target.closest('a[data-team]');
  if (out) return track('team_link_click', { team: out.dataset.team, link: out.textContent });
  const el = e.target.closest('[data-opt],[data-act],[data-edit],[data-tile]');
  if (!el || finishing) return;
  if (el.dataset.opt) {
    f[STEPS[step].key] = STEPS[step].opts[el.dataset.opt][0];
    let next = step + 1;
    while (next < STEPS.length && !active(next)) next++;
    if (next >= STEPS.length) {
      // 마지막 답: 공이 골대로 들어간 뒤 결과로 넘어간다
      finishing = true;
      track('quiz_complete', { region: f.region, district: f.district, level: f.level, orientation: f.orientation || 'any', coach: f.coach });
      render();
      return setTimeout(showResults, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 560);
    }
    step = next;
  } else if (el.dataset.tile) {
    // 지도 칸: 다시 누르면 선택 해제. 스크롤 위치는 그대로 둔다.
    const key = el.dataset.tile;
    f[key] = f[key] === el.dataset.v ? '' : el.dataset.v;
    if (key === 'region') f.district = '';
    q = '';
    return render();
  } else if (el.dataset.act === 'map') {
    showMap = !showMap;
    return render();
  } else if (el.dataset.act === 'back') {
    do step--; while (!active(step));
  } else if (el.dataset.act === 'all') {
    f = blank();
    return showResults();
  } else if (el.dataset.act === 'quiz') {
    f = blank(); q = ''; step = 0; prevK = 0; mode = 'quiz';
  } else if (el.dataset.edit) {
    return requestDialog(teams.find((t) => t.id === +el.dataset.edit));
  }
  render();
  window.scrollTo(0, 0);
});

app.addEventListener('input', (e) => {
  if (e.target.id !== 'f-q') return;
  q = e.target.value;
  document.getElementById('list').innerHTML = listHTML();
});

app.addEventListener('change', (e) => {
  const key = e.target.id.replace('f-', '');
  if (!(key in f)) return;
  f[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f.region !== '서울') f.district = '';
  render();
});

document.getElementById('addBtn').onclick = () => requestDialog(null);

api('GET', '/api/teams').then((t) => { teams = t; render(); }, () => { app.innerHTML = '<p class="empty">팀 정보를 불러오지 못했어요. 새로고침 해주세요.</p>'; });
