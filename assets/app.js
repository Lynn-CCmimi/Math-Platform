import * as db from './db.js?v=d7c5d387';
import * as assign from './assign.js?v=d7c5d387';
import * as photos from './photos.js?v=d7c5d387';
import * as mock from './mock.js?v=d7c5d387';
import * as analysis from './analysis.js?v=d7c5d387';
import * as pdf from './pdf.js?v=d7c5d387';
import * as batch from './batch.js?v=d7c5d387';
import * as history from './history.js?v=d7c5d387';

const P = 'data/papers/';
const T = 'data/textbooks/';

// Why a question went wrong. Short enough that a student actually picks one;
// "英文没读懂" is separated from the maths so a language gap does not get
// recorded as a topic they cannot do.
// Why marks were lost. The first four and last two describe getting a
// question wrong; the two in the middle are how marks leak from a question
// that was essentially right - the losses examiners dock most, and the ones
// a mock paper is meant to surface. A third element is a hint shown with the
// chip, for the option whose name alone is not enough.
const REASONS = [
  ['misread', '看错题'],
  ['slip', '抄错/算错'],
  ['unknown', '知识点不会'],
  ['stuck', '知道方法但卡住'],
  ['working', '跳步'],
  ['form', '答案形式不对', '没化简 · 没排除增根 · 精确度 · 要 exact value'],
  ['english', '英文没读懂'],
  ['time', '时间不够'],
  ['other', '其他'],
];
const REASON_LABEL = Object.fromEntries(REASONS.map(([k, v]) => [k, v]));
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
let MOCKS = [];
let paper = null;         // the mock paper being worked through, if any
const UNIT_ORDER = ['P1', 'P2', 'P3', 'P4', 'M1', 'M2', 'S1', 'S2', 'S3'];

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
  $('tabMock').onclick = () => tab('Mock');
  $('tabWrong').onclick = () => tab('Wrong');
  $('tabAnalysis').onclick = () => tab('Analysis');

  [ASSIGNMENTS, MOCKS] = await Promise.all([db.myAssignments(), db.myMockPapers()]);
  if (ASSIGNMENTS.some(a => assign.progressOf(a, attempts).done < a.question_ids.length)) {
    $('tabWork').innerHTML = '作业 <b style="color:var(--bad)">•</b>';
  }

  let units = [...new Set(DATA.questions.map(q => q.unit))];
  if (me.units?.length) units = units.filter(u => me.units.includes(u));
  units.sort((a, b) => UNIT_ORDER.indexOf(a) - UNIT_ORDER.indexOf(b));

  $('unit').innerHTML = units.map(u => `<option>${u}</option>`).join('');
  $('mockUnit').innerHTML = units.filter(u => DATA.blueprints?.[u])
    .map(u => `<option>${u}</option>`).join('');
  $('mockGen').onclick = generateMock;
  $('unit').onchange = () => selectUnit($('unit').value);
  await selectUnit(units[0]);
}

function tab(name) {
  for (const key of ['Practice', 'Book', 'Work', 'Mock', 'Wrong', 'Analysis']) {
    $('tab' + key).setAttribute('aria-selected', key === name);
    $('view' + key).hidden = key !== name;
  }
  if (name === 'Wrong') renderWrong();
  if (name === 'Mock') renderMock();
  if (name === 'Analysis') renderAnalysis();
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
  paper = null;
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
  $('topics').hidden = Boolean(active || paper);
  $('unit').hidden = Boolean(active || paper);
  if (paper) {
    bar.appendChild(mock.banner(paper, { onExit: closeMock }));
    bar.appendChild(setTools(paper.question_ids, `${paper.unit} 模拟卷 ${new Date(paper.created_at).toLocaleDateString('zh-CN')}`,
      () => openBatch(paper.question_ids, () => { drawAssignBar(); showPaper(); })));
    if (mock.scoreOf(paper).finished) {
      const box = document.createElement('div');
      bar.appendChild(box);
      mock.renderSummary(box, paper, {
        questions: DATA.questions, attempts,
        boundaries: DATA.boundaries,
        topicsOf: q => q.topics.map(String),
        topicName: topicTitle,
        sectionName: sectionTitle,
        reasonLabel: k => REASON_LABEL[k] || k,
        onOpen: id => showQuestion(id),
      });
    }
    return;
  }
  if (active) {
    bar.appendChild(assign.banner(active, attempts, {
      onExit: closeAssignment,
      parts: assign.composition(active, DATA.questions, q => q.topic_titles || []),
    }));
    bar.appendChild(setTools(active.question_ids, `作业 ${active.title}`,
      () => openBatch(active.question_ids, () => { drawAssignBar(); showAssigned(current?.id); })));
  }
}

function showAssigned(keepId) {
  const keepScroll = $('qlist').scrollTop;
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
  $('qlist').scrollTop = keepScroll;
  // stay on the question just answered instead of jumping back to the top
  const focus = rows.some(q => q.id === keepId) ? keepId : rows[0]?.id;
  if (focus) showQuestion(focus);
}

// ---------------------------------------------------------- sets on paper
// A mock paper and an assignment are both "a list of question ids"; the PDF
// buttons and whole-set scoring work on that list and do not care which.

const reasonBadges = a => (a.reasons || []).map(r =>
  `<span class="badge g">${r === 'other' && a.reason_note
    ? '其他：' + esc(a.reason_note) : (REASON_LABEL[r] || r)}</span>`).join('');

const qLabel = q => `${q.unit} ${q.year}年${session(q)} 第${q.question}题`;

function setSpec(ids, title, kind) {
  const qs = ids.map(id => DATA.questions.find(q => q.id === id)).filter(Boolean);
  const total = qs.reduce((n, q) => n + q.marks, 0);
  return {
    title,
    fileName: `${title.replace(/[\/:*?"<>|]/g, '')}${kind === 'answers' ? '-答案' : ''}.pdf`,
    lines: [`共 ${qs.length} 题 · ${total} 分` + (total === 75 ? ' · 建议 1 小时 30 分' : '')],
    items: qs.map((q, i) => ({
      label: `Q${i + 1}`,
      note: qLabel(q),
      marks: q.marks,
      images: (kind === 'answers' ? q.ms_images : q.images).map(src => P + src),
    })).filter(it => it.images.length),
  };
}

// The row of tools under a set's banner.
function setTools(ids, title, onBatch) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.cssText = 'margin:-4px 0 12px';
  const pdfBox = document.createElement('span');
  pdfBox.className = 'row';
  row.appendChild(pdfBox);
  pdf.buttons(pdfBox, { set: kind => setSpec(ids, title, kind), onError: toast });
  const b = document.createElement('button');
  b.className = 'plain';
  b.textContent = '整套录分';
  b.onclick = onBatch;
  row.appendChild(b);
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '打印出来做，回来一次录完';
  row.appendChild(hint);
  return row;
}

// Whole-set scoring: one attempt per filled row, the same record the
// one-at-a-time flow writes, then a list of what lost marks to follow up on.
function openBatch(ids, afterSave) {
  const host = $('assignBar');
  const box = document.createElement('div');
  host.appendChild(box);
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const qs = ids.map(id => DATA.questions.find(q => q.id === id)).filter(Boolean);
  batch.render(box, {
    items: qs.map(q => ({ id: q.id, label: qLabel(q), max: q.marks,
                          prev: paper?.scores?.[q.id] })),
    onCancel: () => box.remove(),
    onSave: async entries => {
      if (!entries.length) return toast('一题都没填');
      const lost = [];
      try {
        for (const e of entries) {
          const row = await db.saveAttempt({
            student_id: me.id, question_id: e.id,
            unit: qs.find(q => q.id === e.id).unit,
            result: e.marks >= e.max ? 'correct' : e.marks === 0 ? 'unknown' : 'partial',
            marks: e.marks, assignment_id: active?.id ?? null,
            reasons: [], weak_sections: [], photo_paths: [],
          });
          attempts.unshift(row);
          if (paper) await mock.score(paper, e.id, e.marks);
          if (e.marks < e.max) {
            lost.push({ attemptId: row.id, lost: e.max - e.marks,
                        label: `Q${ids.indexOf(e.id) + 1} ${qLabel(qs.find(q => q.id === e.id))}` });
          }
        }
      } catch (err) {
        toast(err.message || '保存失败');
        return;
      }
      toast(`已录入 ${entries.length} 题`);
      afterSave();
      const follow = document.createElement('div');
      $('assignBar').appendChild(follow);
      batch.renderFollowUp(follow, { lost, onOpen: openWrongItem });
      follow.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  });
}

// Jump to one record in the notebook, opened.
function openWrongItem(attemptId) {
  tab('Wrong');
  const body = $('wrongList').querySelector(`.qbody[data-a="${attemptId}"]`);
  if (!body) return;
  const item = body.closest('details.qitem');
  const grp = item.closest('details.grp');
  grp.open = true;
  item.open = true;
  item.dispatchEvent(new Event('toggle'));
  item.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ------------------------------------------------------------ mock papers
// The blueprint comes with the data; generation happens here in the browser,
// and the paper is saved the moment it exists so a refresh cannot lose it.

let topicNames = null;
const topicTitle = id => {
  if (!topicNames) {
    topicNames = new Map();
    for (const q of DATA.questions) q.topics.forEach((t, i) => topicNames.set(String(t), q.topic_titles[i]));
  }
  return topicNames.get(String(id)) || id;
};
const sectionTitle = id => DATA.sections[id]
  ? `${DATA.sections[id].section} ${DATA.sections[id].title}` : id;

function renderAnalysis() {
  analysis.render($('analysis'), {
    attempts, papers: MOCKS,
    questions: DATA.questions,
    topicsOf: q => q.topics.map(String),
    topicName: topicTitle,
    sectionName: sectionTitle,
    reasonLabel: k => REASON_LABEL[k] || k,
    gradeOf: mock.gradeOf,
    boundaries: DATA.boundaries,
    onOpenQuestion: id => { tab('Practice'); showQuestion(id); },
  });
}

function renderMock() {
  mock.renderList($('mockList'), {
    papers: MOCKS,
    onOpen: openMock,
    onDelete: async p => {
      if (!confirm('删掉这套模拟卷？做过的题仍会留在练习记录里。')) return;
      try {
        await db.deleteMockPaper(p.id);
        MOCKS = MOCKS.filter(x => x.id !== p.id);
        if (paper?.id === p.id) closeMock();
        renderMock();
      } catch (err) { toast(err.message || '删除失败'); }
    },
  });
}

async function generateMock() {
  const unit = $('mockUnit').value;
  const bp = DATA.blueprints?.[unit];
  if (!bp) return toast('这个单元还没有蓝图');
  const btn = $('mockGen');
  btn.disabled = true;
  $('mockHint').textContent = '正在从真题里挑…';
  try {
    const done = new Set(attempts.map(a => a.question_id));
    const pick = mock.generate(bp, DATA.questions.filter(q => q.unit === unit), {
      marksOf: q => q.marks,
      topicsOf: q => q.topics.map(String),
      paperOf: q => q.paper,
      doneIds: done,
    });
    if (!pick) throw new Error('这个单元的题不够拼出一套完整的卷子');
    const row = await db.saveMockPaper({
      unit, question_ids: pick.ids, max_marks: bp.total,
    });
    MOCKS.unshift(row);
    $('mockHint').textContent = '';
    openMock(row);
  } catch (err) {
    $('mockHint').textContent = '';
    toast(err.message || '生成失败');
  }
  btn.disabled = false;
}

function openMock(p) {
  paper = p;
  active = null;
  tab('Practice');
  drawAssignBar();
  showPaper();
}

function closeMock() {
  paper = null;
  drawAssignBar();
  selectTopic(topic);
}

// The paper's own order is the order to work in: it climbs in marks the way
// a real paper does. Lands on the first question not yet scored.
function showPaper(keepId) {
  const keepScroll = $('qlist').scrollTop;
  const rows = paper.question_ids
    .map(id => DATA.questions.find(q => q.id === id)).filter(Boolean);
  $('qlist').innerHTML = rows.length
    ? rows.map((q, i) => questionRow(q, i + 1)).join('')
    : '<div class="empty">这套卷子的题目不在当前题库中</div>';
  for (const el of $('qlist').children) {
    if (el.dataset.id) el.onclick = () => showQuestion(el.dataset.id);
  }
  $('qlist').scrollTop = keepScroll;
  const scores = paper.scores || {};
  const next = rows.find(q => !(q.id in scores));
  const focus = rows.some(q => q.id === keepId) ? keepId : (next || rows[0])?.id;
  if (focus) showQuestion(focus);
}

function questionRow(q, slot) {
  const st = statusOf(q.id);
  const dot = st === 'correct' ? 'ok' : st === 'partial' ? 'partial' : st ? 'bad' : '';
  const scored = paper && q.id in (paper.scores || {}) ? paper.scores[q.id] : null;
  return `<div class="item" data-id="${q.id}">
    <span class="dot ${dot}"></span>
    <span class="q">Q${slot || q.question}</span>
    <span>${active || paper ? q.unit + ' ' : ''}${q.year} ${session(q)}</span>
    <span class="meta">${scored !== null ? `<b>${scored}</b>/` : ''}${q.marks}分</span>
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

function selectTopic(t, keepId = null) {
  const sameTopic = topic === t;
  topic = t;
  const keepScroll = sameTopic ? $('qlist').scrollTop : 0;
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
  $('qlist').scrollTop = keepScroll;
  // after saving, stay on the question just done rather than jumping to the
  // first in the topic
  const focus = rows.some(q => q.id === keepId) ? keepId : rows[0]?.id;
  if (focus) showQuestion(focus);
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
  draft = { result: null, marks: null, reasons: new Set(), weak: new Set(), up: null };

  for (const el of $('qlist').children) {
    if (el.dataset.id) el.setAttribute('aria-current', el.dataset.id === id);
  }

  $('qpanel').innerHTML = `
    <div class="qhead">
      <h2>${q.unit} · ${q.year}年${session(q)} · 第${q.question}题</h2>
      <span class="badge">${q.marks} 分</span>
      ${(q.topic_titles || []).map((t, i) =>
        `<span class="badge ${i ? 'g' : ''}">${esc(t)}</span>`).join('')}
    </div>
    <div id="hist" hidden></div>
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

  history.render($('hist'), attempts.filter(a => a.question_id === id),
                 { max: q.marks, reasonLabel: k => REASON_LABEL[k] || k });

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
  if (paper || active) return renderMarksEntry(q, box);
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

// In a mock paper or an assignment the three verdicts are not enough: a total
// out of 75, or the teacher's grid, needs the marks themselves. The verdict is
// derived from the marks so the error notebook keeps working the same way.
function renderMarksEntry(q, box) {
  const prev = paper?.scores?.[q.id];
  box.innerHTML = `
    <h3>对照评分标准，这题拿了几分？<span class="hint">满分 ${q.marks} 分</span></h3>
    <div class="row">
      <button class="plain" id="mDown">−</button>
      <input class="spr" id="mVal" type="number" inputmode="numeric" min="0" max="${q.marks}"
             value="${prev ?? ''}" style="width:84px;text-align:center" placeholder="?">
      <button class="plain" id="mUp">+</button>
      <span style="width:8px"></span>
      <button class="plain" id="mZero">0 分</button>
      <button class="plain" id="mFull">满分</button>
    </div>
    <div id="followUp"></div>`;

  const input = $('mVal');
  const set = v => {
    if (v === '' || v === null || Number.isNaN(Number(v))) { draft.result = null; return; }
    v = Math.max(0, Math.min(q.marks, Math.round(Number(v))));
    input.value = v;
    draft.marks = v;
    draft.result = v === q.marks ? 'correct' : v === 0 ? 'unknown' : 'partial';
    renderFollowUp();
  };
  input.oninput = () => set(input.value);
  input.onkeydown = e => { if (e.key === 'Enter') { set(input.value); $('save')?.click(); } };
  $('mDown').onclick = () => set((Number(input.value) || 0) - 1);
  $('mUp').onclick = () => set(input.value === '' ? 0 : Number(input.value) + 1);
  $('mZero').onclick = () => set(0);
  $('mFull').onclick = () => set(q.marks);
  if (prev !== undefined) set(prev);
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
      ${REASONS.map(([k, v, hint]) =>
        `<div class="pick" data-k="${k}" role="button" aria-pressed="false">${v}${
          hint ? `<span class="hint" style="margin-left:7px">${hint}</span>` : ''}</div>`).join('')}
    </div>
    <input class="spr" id="otherNote" hidden placeholder="写一下是什么问题"
           style="width:100%;max-width:480px;margin-top:8px;font-size:14px" maxlength="120">

    <h3 style="margin-top:16px">哪些知识点没掌握？<span class="hint">点亮你不会的</span></h3>
    <div class="picks" id="weak">
      ${sections.map(s =>
        `<div class="pick ${s.role === 'prereq' ? 'sec' : ''}" data-k="${s.id}"
              role="button" aria-pressed="false">${esc(s.label)}</div>`).join('')}
    </div>

    <h3 style="margin-top:16px">订正后拍张照 <span class="hint">照着评分标准改对，再拍。写了两页就传两张，最多 6 张</span></h3>
    <div id="shots"></div>

    <div style="margin-top:16px">
      <button class="act" id="save">存进错题本</button>
    </div>`;

  for (const el of wrap.querySelectorAll('#reasons .pick')) {
    el.onclick = () => {
      toggle(el, draft.reasons);
      if (el.dataset.k === 'other') {
        $('otherNote').hidden = !draft.reasons.has('other');
        if (!$('otherNote').hidden) $('otherNote').focus();
      }
    };
  }
  for (const el of wrap.querySelectorAll('#weak .pick')) {
    el.onclick = () => toggle(el, draft.weak);
  }
  draft.up = photos.uploader($('shots'), { onError: toast });
  $('save').onclick = save;
}

function toggle(el, set) {
  const on = el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', on);
  on ? set.add(el.dataset.k) : set.delete(el.dataset.k);
}


async function save() {
  if (!draft.result) return toast(paper ? '先填这题拿了几分' : '先选一个结果');
  const btn = $('save');
  btn.disabled = true;
  try {
    const shots = draft.up?.blobs.length
      ? await photos.uploadAll(me.id, current.id, draft.up.blobs) : [];
    const row = await db.saveAttempt({
      student_id: me.id,
      question_id: current.id,
      unit: current.unit,
      result: draft.result,
      marks: draft.marks,
      assignment_id: active?.id ?? null,
      reasons: [...draft.reasons],
      reason_note: draft.reasons.has('other') ? ($('otherNote')?.value.trim() || null) : null,
      weak_sections: [...draft.weak],
      photo_paths: shots,
    });
    attempts.unshift(row);
    if (paper) {
      const sc = await mock.score(paper, current.id, draft.marks);
      toast(sc.finished
        ? `做完了，总分 ${sc.earned} / ${sc.max}`
        : `记 ${draft.marks} 分，目前 ${sc.earned} 分`);
      drawAssignBar();
      showPaper();                 // moves on to the next unscored question
    } else {
      toast(draft.result === 'correct' ? '已记录' : '已存进错题本');
      if (active) {
        drawAssignBar();
        showAssigned(current?.id);
      } else {
        selectTopic(topic, current?.id);
      }
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

// Reasons can be added or changed after the fact - a set scored in one go
// has none, and a student may only work out why later.
function wireReasonEdit(body, a) {
  const box = body.querySelector('[data-reasons]');
  const btn = body.querySelector('[data-edit-reasons]');
  const show = () => { box.innerHTML = `<div class="picks">${reasonBadges(a) || '<span class="hint">没有标错因</span>'}</div>`; };
  show();
  btn.onclick = () => {
    const picked = new Set(a.reasons || []);
    box.innerHTML = `
      <div class="picks">${REASONS.map(([k, v, hint]) =>
        `<div class="pick" data-k="${k}" role="button" aria-pressed="${picked.has(k)}">${v}${
          hint ? `<span class="hint" style="margin-left:7px">${hint}</span>` : ''}</div>`).join('')}</div>
      <input class="spr" data-note ${picked.has('other') ? '' : 'hidden'} placeholder="写一下是什么问题"
             value="${esc(a.reason_note || '')}" style="width:100%;max-width:480px;margin-top:8px;font-size:14px" maxlength="120">
      <div class="row" style="margin-top:10px">
        <button class="act" data-save>保存</button>
        <button class="plain" data-cancel>取消</button></div>`;
    for (const el of box.querySelectorAll('.pick')) {
      el.onclick = () => {
        toggle(el, picked);
        if (el.dataset.k === 'other') box.querySelector('[data-note]').hidden = !picked.has('other');
      };
    }
    box.querySelector('[data-cancel]').onclick = show;
    box.querySelector('[data-save]').onclick = async () => {
      const patch = {
        reasons: [...picked],
        reason_note: picked.has('other') ? (box.querySelector('[data-note]').value.trim() || null) : null,
      };
      try {
        await db.updateAttempt(a.id, patch);
        Object.assign(a, patch);
        const badges = $('wrongList').querySelector(`[data-reason-badges="${a.id}"]`);
        if (badges) badges.innerHTML = reasonBadges(a);
        btn.textContent = a.reasons.length ? '修改' : '补充';
        toast('错因已保存');
        show();
      } catch (err) { toast(err.message || '保存失败'); }
    };
  };
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
              <span data-reason-badges="${a.id}">${reasonBadges(a)}</span>
              <span class="n">${new Date(a.created_at).toLocaleDateString('zh-CN')}</span>
            </summary>
            ${a.weak_sections?.length ? `<div class="tags">${
              a.weak_sections.map(s => DATA.sections[s]
                ? `<span class="badge w">没掌握：${esc(DATA.sections[s].title)}</span>` : '').join('')
            }</div>` : ''}
            <div class="qbody" data-q="${esc(q.id)}" data-a="${a.id}"></div>
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
  const q = DATA.questions.find(x => x.id === body.dataset.q);
  const a = attempts.find(x => String(x.id) === body.dataset.a);
  if (!q || !a) return;

  body.innerHTML = `
    <img class="paper" loading="lazy" src="${P}${q.images[0]}" alt="题目">
    <div class="ref"><div class="h">错因 <button class="plain" data-edit-reasons
        style="margin-left:8px;padding:2px 9px;font-size:12px">${a.reasons?.length ? '修改' : '补充'}</button></div>
      <div data-reasons></div></div>
    <div class="ref"><div class="h">我的订正</div><div data-shots></div></div>
    <div class="ref">${pointGroups(q)}</div>`;
  wireReasonEdit(body, a);

  for (const link of body.querySelectorAll('.ref a')) {
    link.onclick = () => { tab('Book'); openPage(+link.dataset.p, link.dataset.b); };
  }
  // editable: a blurry shot or a second page should not mean redoing the
  // question just to attach a better photo
  await photos.gallery(body.querySelector('[data-shots]'), a, {
    editable: true,
    userId: me.id,
    onChange: (paths, err, action) =>
      toast(err || (action === 'remove' ? '照片已删除' : '照片已保存')),
  });
}

boot();
