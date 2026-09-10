import * as db from './db.js?v=5e8b61ab';
import * as assign from './assign.js?v=5e8b61ab';

const P = 'data/papers/';
const T = 'data/textbooks/';

// Why a question went wrong. Short enough that a student actually picks one;
// "英文没读懂" is separated from the maths so a language gap does not get
// recorded as a topic they cannot do.
const REASONS = [
  ['misread', '看错题'],
  ['slip', '抄错/算错'],
  ['unknown', '知识点不会'],
  ['stuck', '知道方法但卡住'],
  ['english', '英文没读懂'],
  ['time', '时间不够'],
];
const REASON_LABEL = Object.fromEntries(REASONS);
const ROLE_MARK = { core: ['●', '考点'], technique: ['○', '用到'], prereq: ['◇', '前置'] };
const RESULTS = { correct: '全对', partial: '部分对', unknown: '不会' };

let DATA = null;
let me = null;
let attempts = [];
let books = {};

let unit = null;
let topic = null;
let current = null;
let bookSlug = null;
let page = 1;
let pageMax = 1;

// draft state for the question being marked
let draft = null;

const $ = id => document.getElementById(id);
const session = q => (q.session === 'January' ? '1月' : q.session === 'June' ? '6月' : '10月');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2200);
}

// ------------------------------------------------------------------ boot

async function boot() {
  // revalidate rather than serve from cache, so a newly published unit shows up
  // on the next refresh instead of whenever the cached copy happens to expire
  DATA = await (await fetch('data/index.json', { cache: 'no-cache' })).json();

  if (!db.configured) {
    $('gate').hidden = false;
    $('loginErr').textContent = '后台尚未配置，请联系老师';
    return;
  }
  const user = await db.currentUser();
  if (user) return start(user);

  $('gate').hidden = false;
  $('loginBtn').onclick = doLogin;
  // needs a statement body: returning false from onkeydown cancels the
  // keypress, which would stop characters ever reaching the field
  $('password').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
}

async function doLogin() {
  const btn = $('loginBtn');
  const name = $('username').value.trim();
  const pass = $('password').value;
  if (!name || !pass) return ($('loginErr').textContent = '请填用户名和密码');
  btn.disabled = true;
  $('loginErr').textContent = '';
  try {
    const user = await db.signIn(name, pass);
    $('gate').hidden = true;
    await start(user);
  } catch (err) {
    $('loginErr').textContent = /Invalid/i.test(err.message || '')
      ? '用户名或密码不对' : (err.message || '登录失败');
    btn.disabled = false;
  }
}

let ASSIGNMENTS = [];
let active = null;        // the assignment being worked through, if any

async function start(user) {
  me = await db.profile(user.id);
  attempts = await db.myAttempts();
  $('gate').hidden = true;
  $('shell').hidden = false;
  $('who').textContent = me.display_name;
  $('logout').onclick = async () => { await db.signOut(); location.reload(); };
  $('tabPractice').onclick = () => tab('Practice');
  $('tabBook').onclick = () => tab('Book');
  $('tabWork').onclick = () => tab('Work');
  $('tabWrong').onclick = () => tab('Wrong');

  ASSIGNMENTS = await db.myAssignments();
  if (ASSIGNMENTS.some(a => assign.progressOf(a, attempts).done < a.question_ids.length)) {
    $('tabWork').innerHTML = '作业 <b style="color:var(--bad)">•</b>';
  }

  const order = ['P1', 'P2', 'P3', 'P4', 'M1', 'M2', 'S1', 'S2', 'S3'];
  let units = [...new Set(DATA.questions.map(q => q.unit))];
  if (me.units?.length) units = units.filter(u => me.units.includes(u));
  units.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  $('unit').innerHTML = units.map(u => `<option>${u}</option>`).join('');
  $('unit').onchange = () => selectUnit($('unit').value);
  await selectUnit(units[0]);
}

function tab(name) {
  for (const key of ['Practice', 'Book', 'Work', 'Wrong']) {
    $('tab' + key).setAttribute('aria-selected', key === name);
    $('view' + key).hidden = key !== name;
  }
  if (name === 'Wrong') renderWrong();
  if (name === 'Work') {
    assign.renderStudentList($('workList'), {
      assignments: ASSIGNMENTS, attempts, onOpen: openAssignment,
    });
  }
}

// ----------------------------------------------------------- assignments
// An open assignment takes over the practice list: the unit and topic
// choosers step aside so the set is exactly what the teacher picked.

function openAssignment(a) {
  active = a;
  tab('Practice');
  drawAssignBar();
  showAssigned();
}

function closeAssignment() {
  active = null;
  drawAssignBar();
  selectTopic(topic);
}

function drawAssignBar() {
  const bar = $('assignBar');
  bar.innerHTML = '';
  $('topics').hidden = Boolean(active);
  $('unit').hidden = Boolean(active);
  if (active) bar.appendChild(assign.banner(active, attempts, closeAssignment));
}

function showAssigned(keepId) {
  const want = new Set(active.question_ids);
  const rows = DATA.questions.filter(q => want.has(q.id))
    .sort((a, b) => a.unit.localeCompare(b.unit)
      || b.sitting.localeCompare(a.sitting) || a.question - b.question);
  $('qlist').innerHTML = rows.length
    ? rows.map(questionRow).join('')
    : '<div class="empty">这份作业里的题目不在当前题库中</div>';
  for (const el of $('qlist').children) {
    if (el.dataset.id) el.onclick = () => showQuestion(el.dataset.id);
  }
  // stay on the question just answered instead of jumping back to the top
  const focus = rows.some(q => q.id === keepId) ? keepId : rows[0]?.id;
  if (focus) showQuestion(focus);
}

function questionRow(q) {
  const st = statusOf(q.id);
  const dot = st === 'correct' ? 'ok' : st === 'partial' ? 'partial' : st ? 'bad' : '';
  return `<div class="item" data-id="${q.id}">
    <span class="dot ${dot}"></span>
    <span class="q">Q${q.question}</span>
    <span>${active ? q.unit + ' ' : ''}${q.year} ${session(q)}</span>
    <span class="meta">${q.topics.length > 1 ? `跨${q.topics.length}点 · ` : ''}${q.marks}分</span>
  </div>`;
}

// ------------------------------------------------------- attempts helpers

const latest = qid => attempts.find(a => a.question_id === qid) || null;

function statusOf(qid) {
  const a = latest(qid);
  return a ? a.result : null;
}

// ------------------------------------------------------------- practice

async function selectUnit(u) {
  unit = u;
  const counts = {}, names = {}, done = {};
  for (const q of DATA.questions) {
    if (q.unit !== u) continue;
    const seen = statusOf(q.id);
    (q.topics || []).forEach((t, i) => {
      counts[t] = (counts[t] || 0) + 1;
      names[t] = q.topic_titles[i];
      if (seen) done[t] = (done[t] || 0) + 1;
    });
  }
  const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  $('topics').innerHTML = ids.length ? ids.map(t =>
    `<div class="chip" data-t="${t}" role="button" aria-pressed="false">${esc(names[t])}
       <b>${done[t] || 0}/${counts[t]}</b></div>`).join('')
    : '<span class="hint">这个单元还没有题目</span>';
  for (const el of $('topics').children) {
    if (el.dataset.t) el.onclick = () => selectTopic(el.dataset.t);
  }

  bookSlug = DATA.textbooks[u] || bookSlug;
  if (bookSlug) {
    books[bookSlug] = books[bookSlug] ||
      await (await fetch(T + bookSlug + '/meta.json')).json();
    renderChapters(books[bookSlug]);
  }
  if (ids.length) selectTopic(ids[0]);
}

function selectTopic(t) {
  topic = t;
  for (const el of $('topics').children) {
    if (el.dataset.t) el.setAttribute('aria-pressed', el.dataset.t === t);
  }
  const rows = DATA.questions
    .filter(q => q.unit === unit && (q.topics || []).map(String).includes(String(t)))
    .sort((a, b) => b.sitting.localeCompare(a.sitting) || a.question - b.question);

  $('qlist').innerHTML = rows.length
    ? rows.map(questionRow).join('')
    : '<div class="empty">这个知识点还没有题</div>';

  for (const el of $('qlist').children) {
    if (el.dataset.id) el.onclick = () => showQuestion(el.dataset.id);
  }
  if (rows.length) showQuestion(rows[0].id);
  else $('qpanel').innerHTML = '<div class="empty">从左边选一道题</div>';
}

function pointGroups(q) {
  const byPart = new Map();
  for (const p of q.points || []) {
    for (const lbl of p.parts?.length ? p.parts : ['']) {
      if (!byPart.has(lbl)) byPart.set(lbl, []);
      if (!byPart.get(lbl).some(x => x.section === p.section)) byPart.get(lbl).push(p);
    }
  }
  const marks = Object.fromEntries((q.parts || []).map(p => [p.part, p.marks]));
  return [...byPart.entries()].map(([lbl, pts]) => `
    <div class="h">${lbl && lbl !== '1' ? `(${esc(lbl)})` : '整题'}${
      marks[lbl] ? ` · ${marks[lbl]}分` : ''}</div>
    <div>${pts.map(p => {
      const s = DATA.sections[p.section];
      if (!s) return '';
      const [mark] = ROLE_MARK[p.role] || ROLE_MARK.core;
      const other = s.unit !== q.unit ? `<i>${s.unit}</i> ` : '';
      return `<a data-b="${s.book}" data-p="${s.pdf_page}">${mark} ${other}${
        esc(s.section)} ${esc(s.title)}</a>`;
    }).join('')}</div>`).join('');
}

function showQuestion(id) {
  const q = DATA.questions.find(x => x.id === id);
  current = q;
  draft = { result: null, reasons: new Set(), weak: new Set(), blob: null };

  for (const el of $('qlist').children) {
    if (el.dataset.id) el.setAttribute('aria-current', el.dataset.id === id);
  }

  const prev = latest(id);
  $('qpanel').innerHTML = `
    <div class="qhead">
      <h2>${q.unit} · ${q.year}年${session(q)} · 第${q.question}题</h2>
      <span class="badge">${q.marks} 分</span>
      ${(q.topic_titles || []).map((t, i) =>
        `<span class="badge ${i ? 'g' : ''}">${esc(t)}</span>`).join('')}
      ${prev ? `<span class="badge ${prev.result === 'correct' ? '' : 'w'}">上次：${
        RESULTS[prev.result]}</span>` : ''}
    </div>
    ${q.images.map(i => `<img class="paper" src="${P}${i}" alt="题目">`).join('')}
    <div class="row">
      ${q.ms_images.length
        ? '<button class="act ghost" id="reveal">对答案</button>'
        : '<span class="hint">这份卷子没有评分标准</span>'}
    </div>
    <div id="ms" hidden style="margin-top:12px"></div>
    <div id="assess" hidden></div>
    <div class="ref" id="refs">
      <div class="legend">● 考点　○ 用到的方法　◇ 前置知识</div>
      ${pointGroups(q)}
    </div>`;

  const btn = $('reveal');
  if (btn) {
    btn.onclick = () => {
      $('ms').hidden = false;
      $('ms').innerHTML = q.ms_images
        .map(i => `<img class="paper" src="${P}${i}" alt="评分标准">`).join('');
      btn.remove();
      renderAssess();
    };
  } else {
    renderAssess();
  }
  wireRefs();
}

function wireRefs() {
  for (const a of $('qpanel').querySelectorAll('.ref a')) {
    a.onclick = () => { tab('Book'); openPage(+a.dataset.p, a.dataset.b); };
  }
}

// --------------------------------------------------------- self-marking

function renderAssess() {
  const q = current;
  const box = $('assess');
  box.hidden = false;
  box.className = 'assess';
  box.innerHTML = `
    <h3>对照评分标准，你做得怎么样？</h3>
    <div class="opts">
      <button class="opt" data-r="correct" aria-pressed="false">全对</button>
      <button class="opt warn" data-r="partial" aria-pressed="false">部分对</button>
      <button class="opt bad" data-r="unknown" aria-pressed="false">不会</button>
    </div>
    <div id="followUp"></div>`;

  for (const el of box.querySelectorAll('.opt')) {
    el.onclick = () => {
      draft.result = el.dataset.r;
      for (const o of box.querySelectorAll('.opt')) {
        o.setAttribute('aria-pressed', o === el);
      }
      renderFollowUp();
    };
  }
}

function renderFollowUp() {
  const q = current;
  const wrap = $('followUp');
  if (draft.result === 'correct') {
    wrap.innerHTML = `<div style="margin-top:14px">
      <button class="act" id="save">记录下来</button>
      <span class="hint" style="margin-left:9px">做对了，不用拍照</span></div>`;
    $('save').onclick = save;
    return;
  }

  const sections = [];
  for (const p of q.points || []) {
    const s = DATA.sections[p.section];
    if (s && !sections.some(x => x.id === p.section)) {
      sections.push({ id: p.section, label: `${s.section} ${s.title}`, role: p.role });
    }
  }

  wrap.innerHTML = `
    <h3 style="margin-top:16px">哪里出了问题？<span class="hint">可多选</span></h3>
    <div class="picks" id="reasons">
      ${REASONS.map(([k, v]) =>
        `<div class="pick" data-k="${k}" role="button" aria-pressed="false">${v}</div>`).join('')}
    </div>

    <h3 style="margin-top:16px">哪些知识点没掌握？<span class="hint">点亮你不会的</span></h3>
    <div class="picks" id="weak">
      ${sections.map(s =>
        `<div class="pick ${s.role === 'prereq' ? 'sec' : ''}" data-k="${s.id}"
              role="button" aria-pressed="false">${esc(s.label)}</div>`).join('')}
    </div>

    <h3 style="margin-top:16px">订正后拍张照 <span class="hint">照着评分标准改对，再拍</span></h3>
    <div class="drop" id="drop">点这里拍照或选图片</div>
    <input type="file" id="file" accept="image/*" capture="environment" hidden>
    <div id="preview"></div>

    <div style="margin-top:16px">
      <button class="act" id="save">存进错题本</button>
    </div>`;

  for (const el of wrap.querySelectorAll('#reasons .pick')) {
    el.onclick = () => toggle(el, draft.reasons);
  }
  for (const el of wrap.querySelectorAll('#weak .pick')) {
    el.onclick = () => toggle(el, draft.weak);
  }
  $('drop').onclick = () => $('file').click();
  $('file').onchange = onPhoto;
  $('save').onclick = save;
}

function toggle(el, set) {
  const on = el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', on);
  on ? set.add(el.dataset.k) : set.delete(el.dataset.k);
}

async function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    draft.blob = await db.shrink(file);
    const url = URL.createObjectURL(draft.blob);
    $('preview').innerHTML = `<div class="shot">
      <img src="${url}" alt="订正">
      <button class="plain" id="drop-photo">删掉</button></div>`;
    $('drop-photo').onclick = () => {
      draft.blob = null;
      $('preview').innerHTML = '';
      $('file').value = '';
    };
  } catch (err) {
    toast(err.message || '照片处理失败');
  }
}

async function save() {
  if (!draft.result) return toast('先选一个结果');
  const btn = $('save');
  btn.disabled = true;
  try {
    let photo = null;
    if (draft.blob) photo = await db.uploadPhoto(me.id, current.id, draft.blob);
    const row = await db.saveAttempt({
      student_id: me.id,
      question_id: current.id,
      unit: current.unit,
      result: draft.result,
      reasons: [...draft.reasons],
      weak_sections: [...draft.weak],
      photo_path: photo,
    });
    attempts.unshift(row);
    toast(draft.result === 'correct' ? '已记录' : '已存进错题本');
    if (active) {
      drawAssignBar();
      showAssigned(current?.id);
    } else {
      selectTopic(topic);
    }
  } catch (err) {
    toast(err.message || '保存失败');
    btn.disabled = false;
  }
}

// ------------------------------------------------------------- textbook

function renderChapters(book) {
  pageMax = book.page_count;
  $('chapters').innerHTML = book.chapters.map(c => `
    <div class="ch">第${c.chapter}章 ${esc(c.title)}</div>
    ${c.sections.map(s => `<div class="sec" data-p="${s.pdf_page}">
      <span class="n">${esc(s.section || '·')}</span>${esc(s.title || s.label || '')}
    </div>`).join('')}`).join('');
  for (const el of $('chapters').querySelectorAll('.sec')) {
    el.onclick = () => openPage(+el.dataset.p);
  }
}

async function openPage(p, book) {
  if (book && book !== bookSlug) {
    bookSlug = book;
    books[book] = books[book] || await (await fetch(T + book + '/meta.json')).json();
    renderChapters(books[book]);
  }
  pageMax = DATA.books[bookSlug] || pageMax;
  page = Math.min(Math.max(1, p), pageMax);
  const n = String(page).padStart(4, '0');
  $('bpanel').innerHTML = `
    <img class="paper" src="${T}${bookSlug}/pages/${n}.webp" alt="教材第${page}页">
    <div class="pager">
      <button class="plain" id="prev" ${page <= 1 ? 'disabled' : ''}>← 上一页</button>
      <span class="hint">${bookSlug.replace('edexcel-ial-', '').toUpperCase()} · ${page} / ${pageMax}</span>
      <button class="plain" id="next" ${page >= pageMax ? 'disabled' : ''}>下一页 →</button>
    </div>`;
  if ($('prev')) $('prev').onclick = () => openPage(page - 1);
  if ($('next')) $('next').onclick = () => openPage(page + 1);
}

// ---------------------------------------------------------- error notebook

let reasonFilter = null;

function renderWrong() {
  const all = attempts.filter(a => a.result !== 'correct');
  if (!all.length) {
    $('wrongFilter').innerHTML = '';
    $('wrongList').innerHTML = '<div class="empty">还没有错题。做错的题会自动收进来。</div>';
    return;
  }

  // Filter by why it went wrong: a run of "抄错/算错" is a habit to fix, a run
  // of "知识点不会" is material to relearn - worth being able to see separately.
  const counts = {};
  for (const a of all) for (const r of a.reasons || []) counts[r] = (counts[r] || 0) + 1;
  $('wrongFilter').innerHTML =
    `<div class="chip" data-r="" role="button" aria-pressed="${!reasonFilter}">全部<b>${all.length}</b></div>`
    + REASONS.filter(([k]) => counts[k]).map(([k, v]) =>
        `<div class="chip" data-r="${k}" role="button" aria-pressed="${reasonFilter === k}">${v}<b>${counts[k]}</b></div>`
      ).join('');
  for (const el of $('wrongFilter').children) {
    el.onclick = () => { reasonFilter = el.dataset.r || null; renderWrong(); };
  }

  const wrong = reasonFilter
    ? all.filter(a => (a.reasons || []).includes(reasonFilter))
    : all;
  if (!wrong.length) {
    $('wrongList').innerHTML = '<div class="empty">这个错因下没有题</div>';
    return;
  }

  // Grouped by the sections the student flagged as "I don't know this" - the
  // most precise signal there is, and it only ever contains things they
  // actually struggle with. Falls back to the question's topics when nothing
  // was flagged, so a question is never lost.
  const groups = new Map();
  for (const a of wrong) {
    const q = DATA.questions.find(x => x.id === a.question_id);
    if (!q) continue;
    let keys = (a.weak_sections || [])
      .filter(s => DATA.sections[s])
      .map(s => [s, `${DATA.sections[s].section} ${DATA.sections[s].title}`,
                 DATA.sections[s].unit]);
    if (!keys.length) {
      keys = (q.topics || []).map((t, i) => [`${q.unit}:${t}`, q.topic_titles[i], q.unit]);
    }
    for (const [key, title, u] of keys.length ? keys : [['other', '未标注', q.unit]]) {
      if (!groups.has(key)) groups.set(key, { title, unit: u, rows: [] });
      groups.get(key).rows.push({ a, q });
    }
  }

  const keys = [...groups.keys()].sort((x, y) => groups.get(y).rows.length - groups.get(x).rows.length);
  const distinct = new Set(wrong.map(a => a.question_id)).size;

  $('wrongList').innerHTML =
    `<p class="hint" style="margin:2px 0 12px">${distinct} 道错题，按知识点分组，错得最多的排在前面</p>`
    + keys.map(k => {
      const { title, unit: u, rows } = groups.get(k);
      return `<details class="grp">
        <summary><span class="caret">▶</span>${esc(u)} · ${esc(title)}
          <span class="n">${rows.length} 题</span></summary>
        ${rows.map(({ a, q }) => `
          <details class="qitem">
            <summary>
              <span class="caret">▶</span>
              <strong>${q.year}年${session(q)} 第${q.question}题</strong>
              <span class="badge ${a.result === 'partial' ? 'w' : 'b'}">${RESULTS[a.result]}</span>
              ${(a.reasons || []).map(r =>
                `<span class="badge g">${REASON_LABEL[r] || r}</span>`).join('')}
              <span class="n">${new Date(a.created_at).toLocaleDateString('zh-CN')}</span>
            </summary>
            ${a.weak_sections?.length ? `<div class="tags">${
              a.weak_sections.map(s => DATA.sections[s]
                ? `<span class="badge w">没掌握：${esc(DATA.sections[s].title)}</span>` : '').join('')
            }</div>` : ''}
            <div class="qbody" data-load="${esc(q.id)}|${esc(a.photo_path || '')}"></div>
          </details>`).join('')}
      </details>`;
    }).join('');

  // images are attached only when a question is actually opened
  for (const el of $('wrongList').querySelectorAll('.qitem')) {
    el.addEventListener('toggle', () => el.open && fillWrongBody(el), { once: true });
  }
}

async function fillWrongBody(item) {
  const body = item.querySelector('.qbody');
  const [qid, photo] = body.dataset.load.split('|');
  const q = DATA.questions.find(x => x.id === qid);
  if (!q) return;

  body.innerHTML = `
    <img class="paper" loading="lazy" src="${P}${q.images[0]}" alt="题目">
    ${photo ? '<div class="hint" id="ph-' + qid + '">订正照片加载中…</div>' : ''}
    <div class="ref">${pointGroups(q)}</div>`;

  for (const a of body.querySelectorAll('.ref a')) {
    a.onclick = () => { tab('Book'); openPage(+a.dataset.p, a.dataset.b); };
  }
  if (photo) {
    const slot = body.querySelector('#ph-' + CSS.escape(qid));
    const url = await db.photoUrl(photo);
    if (slot) {
      slot.outerHTML = url
        ? `<img class="paper" loading="lazy" src="${url}" alt="我的订正">`
        : '<div class="hint">订正照片打不开了</div>';
    }
  }
}

boot();
