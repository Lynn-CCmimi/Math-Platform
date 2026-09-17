import * as db from './db.js?v=810529b4';
import * as assign from './assign.js?v=810529b4';
import * as photos from './photos.js?v=810529b4';
import * as mock from './mock.js?v=810529b4';

const P = 'data/papers/';

const REASON_LABEL = {
  misread: '看错题', slip: '抄错/算错', unknown: '知识点不会',
  stuck: '知道方法但卡住', working: '跳步', form: '答案形式不对',
  english: '英文没读懂', time: '时间不够', other: '其他',
};
const RESULTS = { correct: '全对', partial: '部分对', unknown: '不会' };

let DATA = null;
let students = [];
let rows = [];
let sets = [];
let papers = [];
let picked = null;
let recFilter = 'all';   // all | set | own - which records the student detail lists

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const session = q => (q.session === 'January' ? '1月' : q.session === 'June' ? '6月' : '10月');
const day = t => new Date(t).toLocaleDateString('zh-CN');

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2200);
}

async function boot() {
  DATA = await (await fetch('data/index.json', { cache: 'no-cache' })).json();
  if (!db.configured) {
    $('gate').hidden = false;
    $('loginErr').textContent = '后台尚未配置';
    return;
  }
  const user = await db.currentUser();
  if (user) return start(user);
  $('gate').hidden = false;
  $('loginBtn').onclick = doLogin;
  $('password').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
}

async function doLogin() {
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginErr').textContent = '';
  try {
    const user = await db.signIn($('username').value.trim(), $('password').value);
    await start(user);
  } catch (err) {
    $('loginErr').textContent = /Invalid/i.test(err.message || '')
      ? '用户名或密码不对' : (err.message || '登录失败');
    btn.disabled = false;
  }
}

async function start(user) {
  const me = await db.profile(user.id);
  if (me.role !== 'teacher') {
    $('gate').hidden = false;
    $('loginErr').textContent = '这个账号不是老师，请到学生页面';
    return;
  }
  $('gate').hidden = true;
  $('shell').hidden = false;
  $('logout').onclick = async () => { await db.signOut(); location.reload(); };
  $('tabClass').onclick = () => tab('Class');
  $('tabWeak').onclick = () => tab('Weak');
  $('tabAssign').onclick = () => tab('Assign');

  [students, rows, sets, papers] = await Promise.all(
    [db.allStudents(), db.attemptsForClass(), db.myAssignments(), db.mockPapersForClass()]);
  renderClass();
  renderWeak();
  mountAssign();
}

function tab(name) {
  for (const key of ['Class', 'Weak', 'Assign']) {
    $('tab' + key).setAttribute('aria-selected', key === name);
    $('view' + key).hidden = key !== name;
  }
}

// ------------------------------------------------------------ class view

function statsFor(id) {
  const mine = rows.filter(r => r.student_id === id);
  const correct = mine.filter(r => r.result === 'correct').length;
  const wrong = mine.length - correct;
  return {
    total: mine.length,
    correct,
    wrong,
    rate: mine.length ? Math.round((correct / mine.length) * 100) : null,
    last: mine[0]?.created_at || null,
  };
}

function renderClass() {
  const active = new Set(rows.map(r => r.student_id)).size;
  $('summary').innerHTML = `
    <span class="badge">${students.length} 名学生</span>
    <span class="badge g">${rows.length} 次练习</span>
    <span class="badge g">${active} 人已开始</span>`;

  $('students').innerHTML = `
    <thead><tr><th>学生</th><th>练习</th><th>正确率</th><th>错题</th><th>最近</th></tr></thead>
    <tbody>${students.map(s => {
      const st = statsFor(s.id);
      return `<tr data-id="${s.id}" style="cursor:pointer">
        <td><strong>${esc(s.display_name)}</strong><br>
            <span class="hint">${esc(s.username)}</span></td>
        <td>${st.total}</td>
        <td>${st.rate === null ? '<span class="hint">—</span>' :
          `<div class="row" style="gap:6px"><div class="bar-gauge">
             <span style="width:${st.rate}%"></span></div>${st.rate}%</div>`}</td>
        <td>${st.wrong || '<span class="hint">0</span>'}</td>
        <td class="hint">${st.last ? day(st.last) : '未开始'}</td>
      </tr>`;
    }).join('')}</tbody>`;

  if (!students.length) {
    $('students').innerHTML =
      '<tbody><tr><td class="empty">还没有学生账号</td></tr></tbody>';
  }
  for (const tr of $('students').querySelectorAll('tr[data-id]')) {
    tr.onclick = () => showStudent(tr.dataset.id);
  }
}

async function showStudent(id) {
  picked = id;
  const s = students.find(x => x.id === id);
  const mine = rows.filter(r => r.student_id === id);
  const st = statsFor(id);

  const myPapers = papers.filter(p => p.student_id === id);
  if (!mine.length) {
    $('detail').innerHTML = `<h2 style="margin:0 0 8px;font-size:16px">${esc(s.display_name)}</h2>
      ${mock.renderTeacherRows(myPapers) || '<div class="empty">还没有练习记录</div>'}`;
    return;
  }

  // what this student keeps flagging as not understood
  const weak = {};
  for (const r of mine) {
    for (const sid of r.weak_sections || []) {
      if (DATA.sections[sid]) weak[sid] = (weak[sid] || 0) + 1;
    }
  }
  const weakTop = Object.entries(weak).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const reasons = {};
  for (const r of mine) for (const k of r.reasons || []) reasons[k] = (reasons[k] || 0) + 1;

  $('detail').innerHTML = `
    <div class="qhead">
      <h2>${esc(s.display_name)}</h2>
      <span class="badge">${st.total} 次练习</span>
      <span class="badge g">正确率 ${st.rate}%</span>
      <span class="badge ${st.wrong ? 'w' : 'g'}">${st.wrong} 道错题</span>
    </div>

    ${weakTop.length ? `<h3 style="font-size:14px;margin:14px 0 6px">自己标记不会的知识点</h3>
      <div class="picks">${weakTop.map(([sid, n]) =>
        `<span class="badge w">${esc(DATA.sections[sid].title)} ×${n}</span>`).join('')}</div>` : ''}

    ${Object.keys(reasons).length ? `<h3 style="font-size:14px;margin:14px 0 6px">错因分布</h3>
      <div class="picks">${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
        `<span class="badge g">${REASON_LABEL[k] || k} ×${n}</span>`).join('')}</div>` : ''}

    ${mock.renderTeacherRows(myPapers)}

    <h3 style="font-size:14px;margin:16px 0 6px">练习记录</h3>
    <div class="chips" style="margin-bottom:8px">${[['all', '全部'], ['set', '作业'], ['own', '自练']].map(([k, v]) =>
      `<button class="chip" data-rf="${k}" aria-pressed="${recFilter === k}">${v}<b>${
        k === 'all' ? mine.length : mine.filter(r => (setOf(r) != null) === (k === 'set')).length}</b></button>`).join('')}</div>
    ${mine.filter(r => recFilter === 'all' || (setOf(r) != null) === (recFilter === 'set')).slice(0, 40).map(r => {
      const q = DATA.questions.find(x => x.id === r.question_id);
      const set = setOf(r);
      return `<details class="qitem" style="margin-left:0">
        <summary>
          <span class="caret">▶</span>
          <strong>${q ? `${q.unit} ${q.year}年${session(q)} 第${q.question}题` : r.question_id}</strong>
          ${set ? `<span class="badge g" title="作业">📝 ${esc(set.title)}</span>` : ''}
          <span class="badge ${r.result === 'correct' ? '' : r.result === 'partial' ? 'w' : 'b'}">${
            r.marks != null && q ? `${r.marks}/${q.marks} 分` : RESULTS[r.result]}</span>
          ${(r.reasons || []).map(k =>
            `<span class="badge g">${k === 'other' && r.reason_note
              ? '其他：' + esc(r.reason_note) : (REASON_LABEL[k] || k)}</span>`).join('')}
          <span class="n">${day(r.created_at)}</span>
        </summary>
        <div class="qbody" data-q="${esc(r.question_id)}" data-a="${r.id}"></div>
      </details>`;
    }).join('')}`;

  for (const el of $('detail').querySelectorAll('.qitem')) {
    el.addEventListener('toggle', () => el.open && fillBody(el), { once: true });
  }
  for (const b of $('detail').querySelectorAll('[data-rf]')) {
    b.onclick = () => { recFilter = b.dataset.rf; showStudent(id); };
  }
}

// The assignment a record was made in, if any (see assign.belongs for the
// fallback on rows older than the stamp).
function setOf(r) {
  return sets.find(a => assign.belongs(a, r)) || null;
}

async function fillBody(item) {
  const body = item.querySelector('.qbody');
  const q = DATA.questions.find(x => x.id === body.dataset.q);
  const a = rows.find(r => String(r.id) === body.dataset.a);
  body.innerHTML =
    (q ? `<img class="paper" loading="lazy" src="${P}${q.images[0]}" alt="题目">` : '')
    + '<div class="ref"><div class="h">学生的订正</div><div data-shots></div></div>';
  if (a) await photos.gallery(body.querySelector('[data-shots]'), a);
}

// ------------------------------------------------------- class weak spots

function renderWeak() {
  // Sections the class flags as not understood. This is student-confirmed, not
  // inferred - they ticked it themselves after seeing the mark scheme.
  const weak = {};
  for (const r of rows) {
    for (const sid of r.weak_sections || []) {
      if (!DATA.sections[sid]) continue;
      weak[sid] = weak[sid] || { n: 0, who: new Set() };
      weak[sid].n += 1;
      weak[sid].who.add(r.student_id);
    }
  }
  const ranked = Object.entries(weak).sort((a, b) => b[1].who.size - a[1].who.size || b[1].n - a[1].n);

  $('weakSections').innerHTML = `
    <h3 style="margin:0 0 4px;font-size:15px">全班薄弱知识点</h3>
    <p class="hint" style="margin:0 0 12px">学生自己标记「没掌握」的小节，按涉及人数排序</p>
    ${ranked.length ? `<table><thead><tr><th>知识点</th><th>人数</th><th>次数</th></tr></thead>
      <tbody>${ranked.slice(0, 25).map(([sid, v]) => {
        const s = DATA.sections[sid];
        return `<tr><td>${esc(s.unit)} · ${esc(s.section)} ${esc(s.title)}</td>
          <td>${v.who.size}</td><td>${v.n}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">还没有数据</div>'}`;

  const reasons = {};
  for (const r of rows) for (const k of r.reasons || []) reasons[k] = (reasons[k] || 0) + 1;
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);

  $('reasonMix').innerHTML = `
    <h3 style="margin:0 0 4px;font-size:15px">错因分布</h3>
    <p class="hint" style="margin:0 0 12px">多是「抄错/算错」是习惯问题，多是「知识点不会」才要回去讲</p>
    ${total ? `<table><tbody>${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
      `<tr><td style="width:34%">${REASON_LABEL[k] || k}</td>
        <td><div class="row" style="gap:8px"><div class="bar-gauge" style="flex:1">
          <span style="width:${Math.round((n / total) * 100)}%"></span></div>
          <span class="hint">${n}</span></div></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">还没有数据</div>'}

    ${(() => {
      // what students typed under 其他 - the raw material for the next
      // category worth adding to the fixed list
      const notes = rows.filter(r => r.reason_note).slice(0, 15);
      if (!notes.length) return '';
      const name = id => students.find(s => s.id === id)?.display_name || '';
      return `<h3 style="margin:18px 0 4px;font-size:15px">学生自己写的「其他」</h3>
        <p class="hint" style="margin:0 0 8px">同一类写法出现多了，就该加成正式选项</p>
        <table><tbody>${notes.map(r =>
          `<tr><td style="width:22%" class="hint">${esc(name(r.student_id))}</td>
           <td>${esc(r.reason_note)}</td>
           <td class="hint" style="width:18%">${day(r.created_at)}</td></tr>`).join('')}
        </tbody></table>`;
    })()}`;
}

// ------------------------------------------------------------- assignments
// Only the board-specific description lives here; the picker itself is shared.

const UNIT_ORDER = ['P1', 'P2', 'P3', 'P4', 'M1', 'M2', 'S1', 'S2', 'S3'];
const band = m => (m <= 3 ? '1-3分' : m <= 6 ? '4-6分' : '7分以上');

function mountAssign() {
  assign.mountPicker($('picker'), {
    questions: DATA.questions,
    students,
    facets: [
      { id: 'unit', name: '单元', values: q => [q.unit], order: UNIT_ORDER },
      { id: 'topic', name: '知识点', values: q => q.topic_titles || [] },
      { id: 'marks', name: '分值', values: q => [band(q.marks)],
        order: ['1-3分', '4-6分', '7分以上'] },
    ],
    label: q => `${q.unit} ${q.year}年${session(q)} 第${q.question}题`,
    note: q => `${q.marks}分`,
    preview: q => (q.images || []).map(src => P + src),
    onSaved: async (row, msg) => {
      toast(msg);
      if (row) { sets = await db.myAssignments(); renderAssignList(); }
    },
  });
  renderAssignList();
}

// The same PDF the student can download, for handing out on paper.
function pdfSpec(a, kind) {
  const qs = a.question_ids.map(id => DATA.questions.find(q => q.id === id)).filter(Boolean);
  const total = qs.reduce((n, q) => n + q.marks, 0);
  return {
    title: `作业 ${a.title}`,
    fileName: `作业-${a.title.replace(/[\\/:*?"<>|]/g, '')}${kind === 'answers' ? '-答案' : ''}.pdf`,
    lines: [`共 ${qs.length} 题 · ${total} 分`],
    items: qs.map((q, i) => ({
      label: `Q${i + 1}`, marks: q.marks,
      note: `${q.unit} ${q.year}年${session(q)} 第${q.question}题`,
      images: (kind === 'answers' ? q.ms_images : q.images).map(src => P + src),
    })).filter(it => it.images.length),
  };
}

// How the grid shows this board's questions and attempts.
const board = {
  marksOf: q => q.marks,
  heading: q => `${q.unit} ${q.year}年${session(q)} 第${q.question}题 · ${q.marks} 分`,
  reasonLabel: k => REASON_LABEL[k] || k,
  question: (el, q) => {
    el.innerHTML = q.images.map(i => `<img class="paper" loading="lazy" src="${P}${i}" alt="题目">`).join('')
      + (q.ms_images.length ? `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">评分标准</summary>${
          q.ms_images.map(i => `<img class="paper" loading="lazy" src="${P}${i}" alt="评分标准">`).join('')}</details>` : '');
  },
  attempt: async (el, a) => {
    if (a.weak_sections?.length) {
      el.innerHTML = `<div class="picks" style="margin-top:6px">${a.weak_sections
        .filter(sid => DATA.sections[sid])
        .map(sid => `<span class="badge w">没掌握：${esc(DATA.sections[sid].title)}</span>`).join('')}</div>`;
    }
    if (photos.pathsOf(a).length) {
      const shots = document.createElement('div');
      shots.style.marginTop = '6px';
      el.appendChild(shots);
      await photos.gallery(shots, a);
    }
  },
};

function renderAssignList() {
  assign.renderTeacherList($('assignList'), {
    assignments: sets, attempts: rows, students,
    questions: DATA.questions, board,
    pdfSpec, onError: toast,
    onDeleted: async err => {
      if (err) return toast('删除失败：' + err);
      sets = await db.myAssignments();
      renderAssignList();
      toast('已删除');
    },
  });
}

boot();
