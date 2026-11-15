requireRole('student');
$('#logout').onclick = logout;
let testId, qs = [], answers = {}, cur = 0, endsAt = 0, offset = 0;
let tick = null, pinger = null, listTimer = null, listPoll = null, pending = {}, finished = false;
const now = () => Date.now() + offset;

function view(id) {
  ['list', 'exam', 'done', 'report'].forEach(s => $('#' + s).hidden = s !== id);
  $('#timer').hidden = id !== 'exam';
  $('#head').textContent = id === 'exam' ? '' : 'Your tests';
}

// ---------- Test list ----------
let listData = null;
async function loadList() {
  const d = await api('/student/tests');
  offset = d.now - Date.now(); listData = d.tests;
  $('#none').hidden = d.tests.length > 0;
  drawList();
}
function drawList() {
  if (!listData) return;
  $('#cards').innerHTML = listData.map(t => {
    const wait = new Date(t.startAt) - now();
    let action;
    if (t.state === 'submitted') action = `<button class="primary" data-report="${t.id}">View report</button>`;
    else if (wait > 0) action = `<button disabled>Starts in ${mmss(wait)}</button>`;
    else action = `<button class="primary" data-start="${t.id}">${t.state === 'in progress' ? 'Resume test' : 'Start test'}</button>`;
    return `<div class="panel row" style="justify-content:space-between"><div><h2>${esc(t.title)}</h2>
      <p class="muted" style="margin:0">${fmt(t.startAt)} · ${t.questions} questions · ${t.durationMin} minutes</p></div>${action}</div>`;
  }).join('');
  document.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startTest(b.dataset.start));
  document.querySelectorAll('[data-report]').forEach(b => b.onclick = () => openReport(b.dataset.report));
}
function showList() {
  view('list'); loadList().catch(() => {});
  clearInterval(listTimer);
  listTimer = setInterval(() => { if (!$('#list').hidden) { drawList(); } }, 1000);
  clearInterval(listPoll);
  listPoll = setInterval(() => { if (!$('#list').hidden) loadList().catch(() => {}); }, 10000);
}
$('#home').onclick = showList;

// ---------- Exam ----------
async function startTest(id) {
  if (!confirm('Start now? The timer begins immediately and cannot be paused. Switching tabs, copying, pasting and leaving full screen are recorded and shown to your teacher.')) return;
  Proctor.goFullscreen();
  try {
    const d = await api(`/student/tests/${id}/start`, { method: 'POST' });
    testId = id; qs = d.questions; answers = d.answers || {}; cur = Math.min(d.current || 0, qs.length - 1);
    endsAt = new Date(d.endsAt).getTime(); offset = d.now - Date.now(); finished = false; pending = {};
    $('#head').textContent = ''; view('exam'); document.title = d.title;
    draw();
    Proctor.start(testId, () => cur);
    clearInterval(tick); tick = setInterval(onTick, 500);
    clearInterval(pinger); pinger = setInterval(ping, 5000);
  } catch (e) { alert(e.message); loadList(); }
}
function onTick() {
  const left = endsAt - now();
  const el = $('#timer'); el.textContent = mmss(left); el.classList.toggle('low', left < 5 * 60000);
  if (left <= 0 && !finished) submit(true);
}
function draw() {
  const q = qs[cur];
  $('#qmeta').textContent = `Question ${cur + 1} of ${qs.length} · ${q.subject}`;
  $('#qtext').textContent = q.text;
  $('#opts').innerHTML = q.options.map((o, i) =>
    `<button class="opt ${answers[q.id] === i ? 'sel' : ''}" data-i="${i}" aria-pressed="${answers[q.id] === i}"><b>${'ABCD'[i]}</b><span>${esc(o)}</span></button>`).join('');
  document.querySelectorAll('.opt').forEach(b => b.onclick = () => choose(+b.dataset.i));
  $('#prev').disabled = cur === 0;
  $('#next').textContent = cur === qs.length - 1 ? 'Save' : 'Save and next';
  $('#palette').innerHTML = qs.map((x, i) =>
    `<button class="${answers[x.id] != null ? 'done' : ''} ${i === cur ? 'now' : ''}" data-n="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`).join('');
  document.querySelectorAll('#palette button').forEach(b => b.onclick = () => go(+b.dataset.n));
  const n = qs.filter(x => answers[x.id] != null).length;
  $('#legend').textContent = `${n} answered, ${qs.length - n} left. Filled = answered.`;
}
function go(i) { cur = i; draw(); ping(); }
async function save(qid, option) {
  pending[qid] = option;
  try {
    await api(`/student/tests/${testId}/answer`, { method: 'POST', body: { qid, option, current: cur } });
    delete pending[qid]; $('#sync').textContent = '';
  } catch (e) { $('#sync').textContent = 'Not saved yet. Retrying…'; }
}
function choose(i) { const q = qs[cur]; answers[q.id] = i; draw(); save(q.id, i); }
$('#clear').onclick = () => { const q = qs[cur]; delete answers[q.id]; draw(); save(q.id, null); };
$('#next').onclick = () => go(Math.min(cur + 1, qs.length - 1));
$('#prev').onclick = () => go(Math.max(cur - 1, 0));
async function ping() {
  for (const [qid, option] of Object.entries(pending)) await save(qid, option);
  api(`/student/tests/${testId}/ping`, { method: 'POST', body: { current: cur } }).catch(() => {});
}

async function submit(auto) {
  if (!auto) {
    const left = qs.filter(x => answers[x.id] == null).length;
    Proctor.pause();
    const ok = confirm(left ? `${left} questions are unanswered. Submit anyway?` : 'Submit your test?');
    Proctor.resume();
    if (!ok) return;
  }
  finished = true; clearInterval(tick); clearInterval(pinger); Proctor.stop();
  for (const [qid, option] of Object.entries(pending)) await save(qid, option);
  try { await api(`/student/tests/${testId}/submit`, { method: 'POST' }); } catch (e) {}
  document.title = 'Mock test'; view('done');
}
$('#submit').onclick = () => submit(false);
window.addEventListener('beforeunload', e => { if (!finished && !$('#exam').hidden) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Report (after the test is finished) ----------
async function openReport(id) {
  view('report');
  const box = $('#reportBody'); box.innerHTML = '<p>Loading…</p>';
  try {
    const r = await api(`/student/tests/${id}/report`);
    const t = r.totals;
    const acc = x => x.attempted ? Math.round(x.correct / x.attempted * 100) : null;
    const tag = x => acc(x) === null ? '<span class="tag warn">skipped</span>'
      : `<span class="tag ${acc(x) < 50 ? 'bad' : acc(x) >= 75 ? 'ok' : 'warn'}">${acc(x)}%</span>`;
    const bySubject = {};
    r.topics.forEach(x => (bySubject[x.subject] ||= []).push(x));
    const tables = ['Physics', 'Chemistry', 'Biology'].filter(s => bySubject[s]).map(s => `
      <div class="panel scroll"><h2>${s}</h2><table>
        <thead><tr><th>Chapter · topic</th><th class="num">Qs</th><th class="num">Right</th><th class="num">Wrong</th><th class="num">Marks</th><th>Accuracy</th></tr></thead>
        <tbody>${bySubject[s].map(x => `<tr><td>${esc(x.chapter)} · ${esc(x.topic)}</td><td class="num">${x.total}</td><td class="num">${x.correct}</td><td class="num">${x.wrong}</td><td class="num">${x.score}</td><td>${tag(x)}</td></tr>`).join('')}</tbody>
      </table></div>`).join('');
    const weak = r.topics.filter(x => acc(x) === null || acc(x) < 50).map(x => `${x.chapter}: ${x.topic}`);
    box.innerHTML = `
      <h1>${esc(r.title)}</h1>
      <p class="muted">Finished ${fmt(r.submittedAt)} · Marking: +4 for a correct answer, −1 for a wrong one</p>
      <div class="stats">
        <div class="stat"><b>${t.score}/${t.maxScore}</b>marks</div>
        <div class="stat"><b>${t.attempted}/${t.total}</b>attempted</div>
        <div class="stat"><b>${t.correct}</b>correct</div>
        <div class="stat"><b>${t.wrong}</b>wrong</div>
      </div>
      ${weak.length ? `<div class="panel"><h2>Topics to revise</h2><p>${weak.map(esc).join(' · ')}</p></div>` : ''}
      ${tables}
      <div class="panel"><h2>Question review</h2>
        ${r.review.map((q, i) => `<details><summary>Q${i + 1}. ${esc(q.chapter)} · ${esc(q.topic)}
          <span class="tag ${q.chosen === null ? 'warn' : q.chosen === q.correct ? 'ok' : 'bad'}">${q.chosen === null ? 'skipped' : q.chosen === q.correct ? 'correct' : 'wrong'}</span></summary>
          <p>${esc(q.text)}</p>
          ${q.options.map((o, k) => `<div class="review-opt ${k === q.correct ? 'right' : k === q.chosen ? 'wrong' : ''}">${'ABCD'[k]}. ${esc(o)}${k === q.correct ? ' (correct answer)' : k === q.chosen ? ' (your answer)' : ''}</div>`).join('')}
          ${q.explanation ? `<p class="muted">${esc(q.explanation)}</p>` : ''}</details>`).join('')}
      </div>`;
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('#viewReport').onclick = () => openReport(testId);
$('#backReport').onclick = showList;

showList();
