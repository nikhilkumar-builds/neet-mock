requireRole('admin');
let liveTimer = null, chapterData = [];

const EVENT_LABEL = {
  tab_hidden: 'Switched tab / minimised', tab_return: 'Returned to test', window_blur: 'Clicked outside the window',
  copy: 'Tried to copy', cut: 'Tried to cut', paste: 'Tried to paste', contextmenu: 'Right-click',
  shortcut: 'Blocked shortcut', printscreen: 'Print Screen', fullscreen_exit: 'Left full screen',
  devtools_suspected: 'Dev tools (possible)', resumed: 'Page reopened / refreshed'
};
const flagTotal = c => Object.entries(c || {}).filter(([k]) => k !== 'tab_return').reduce((s, [, n]) => s + n, 0);
function integrityHtml(counts = {}, events = [], full = false) {
  const flags = Object.entries(counts).filter(([k]) => k !== 'tab_return');
  const chips = flags.map(([k, n]) => `<span class="tag ${k === 'resumed' || k === 'devtools_suspected' ? 'warn' : 'bad'}">${esc(EVENT_LABEL[k] || k)}: ${n}</span>`).join(' ');
  const rows = (full ? events : events).map(e =>
    `<li>${new Date(e.at).toLocaleTimeString()} · Q${e.q != null ? e.q + 1 : '?'} · ${esc(EVENT_LABEL[e.kind] || e.kind)}${e.detail ? ' (' + esc(e.detail) + ')' : ''}</li>`).join('');
  const list = !events.length ? '' : full
    ? `<details><summary>Full log (${events.length} events)</summary><ul>${rows}</ul></details>`
    : `<ul>${rows}</ul>`;
  return '<h3>Integrity</h3>' + (flags.length ? `<p>${chips}</p>${list}` : '<p class="muted">No suspicious activity recorded.</p>');
}

function show(id) {
  clearInterval(liveTimer);
  document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== id);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === id));
  if (id === 'tests') loadTests();
  if (id === 'create') loadChapters();
  if (id === 'bank') loadCount();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.t));
$('#logout').onclick = logout;
$('#backLive').onclick = $('#backReport').onclick = () => show('tests');

// ---------- Tests list ----------
const statusTag = s => ({ submitted: 'ok', 'time over': 'ok', 'in progress': 'warn', open: 'warn', scheduled: '' }[s] ?? '');
async function loadTests() {
  const tests = await api('/admin/tests');
  $('#noTests').hidden = tests.length > 0;
  $('#testRows').innerHTML = tests.map(t => `
    <tr>
      <td><strong>${esc(t.title)}</strong><br><span class="muted">${[...new Set(t.chapters.map(c => c.chapter))].map(esc).join(', ')}</span></td>
      <td>${fmt(t.startAt)}</td>
      <td>${t.durationMin} min</td>
      <td><span class="tag ${statusTag(t.status)}">${t.status}</span></td>
      <td class="row">
        <button data-live="${t.id}">Live</button>
        <button data-report="${t.id}" ${['submitted', 'time over'].includes(t.status) ? '' : 'disabled'}>Report</button>
        <button data-now="${t.id}" ${t.status === 'scheduled' ? '' : 'disabled'}>Start now</button>
        <button class="danger" data-del="${t.id}">Delete</button>
      </td>
    </tr>`).join('');
  document.querySelectorAll('[data-live]').forEach(b => b.onclick = () => openLive(b.dataset.live));
  document.querySelectorAll('[data-report]').forEach(b => b.onclick = () => openReport(b.dataset.report));
  document.querySelectorAll('[data-now]').forEach(b => b.onclick = async () => { await api(`/admin/tests/${b.dataset.now}/start-now`, { method: 'POST' }); loadTests(); });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (confirm('Delete this test and the student\'s attempt?')) { await api('/admin/tests/' + b.dataset.del, { method: 'DELETE' }); loadTests(); }
  });
}

// ---------- Create test ----------
async function loadChapters() {
  chapterData = await api('/admin/chapters');
  const tree = {};
  chapterData.forEach(r => {
    const c = ((tree[r.subject] ||= {})[r.chapter] ||= { topics: 0, questions: 0 });
    c.topics++; c.questions += r.count;
  });
  const order = ['Physics', 'Chemistry', 'Biology'];
  $('#chapters').innerHTML = order.filter(s => tree[s]).map(s => `
    <div class="chap-group"><h3>${s}</h3>
      ${Object.entries(tree[s]).sort().map(([ch, v]) => `
        <label class="chap"><input type="checkbox" data-s="${s}" data-c="${esc(ch)}" data-n="${v.questions}">
        <span>${esc(ch)} <span class="muted">(${v.topics} topics, ${v.questions} questions)</span></span></label>`).join('')}
    </div>`).join('') || '<p class="muted">The question bank is empty. Add questions first.</p>';
  document.querySelectorAll('#chapters input').forEach(i => i.onchange = updateAvail);
  updateAvail();
}
function updateAvail() {
  const n = [...document.querySelectorAll('#chapters input:checked')].reduce((s, i) => s + +i.dataset.n, 0);
  $('#avail').textContent = n;
}
$('#makeTest').onclick = async () => {
  $('#createErr').textContent = '';
  const chapters = [...document.querySelectorAll('#chapters input:checked')].map(i => ({ subject: i.dataset.s, chapter: i.dataset.c }));
  try {
    if (!$('#startAt').value) throw new Error('Choose a start time');
    await api('/admin/tests', { method: 'POST', body: {
      title: $('#title').value.trim(), chapters, durationMin: +$('#dur').value, count: +$('#cnt').value,
      startAt: new Date($('#startAt').value).toISOString() } });
    show('tests');
  } catch (e) { $('#createErr').textContent = e.message; }
};

// ---------- Question bank ----------
async function loadCount() { $('#qcount').textContent = (await api('/admin/questions/count')).count; }
$('#importBtn').onclick = async () => {
  const msg = $('#bankMsg'); msg.style.color = ''; msg.textContent = '';
  try {
    const data = JSON.parse($('#json').value);
    const r = await api('/admin/questions/import', { method: 'POST', body: data });
    msg.style.color = 'var(--ok)'; msg.textContent = r.inserted + ' questions added.';
    $('#json').value = ''; loadCount();
  } catch (e) { msg.textContent = e.message; }
};

// ---------- Live monitor ----------
function openLive(id) {
  show('live');
  const draw = async () => {
    try {
      const d = await api(`/admin/tests/${id}/live`);
      $('#liveTitle').textContent = d.title;
      if (!d.startedAt) {
        $('#liveBody').innerHTML = `<p><span class="tag">${d.state}</span></p><p class="muted">Starts ${fmt(d.startAt)}. ${d.total} questions.</p>`;
        return;
      }
      const left = new Date(d.endsAt) - Date.now();
      const ago = Math.round((Date.now() - new Date(d.lastSeen)) / 1000);
      $('#liveBody').innerHTML = `
        <p><span class="dot ${d.online ? 'on' : ''}"></span><strong>${d.state === 'submitted' ? 'Submitted' : d.online ? 'Student is online' : 'Student is offline'}</strong>
           <span class="muted"> · last seen ${ago}s ago</span></p>
        <div class="bar" aria-hidden="true"><span style="width:${d.answered / d.total * 100}%"></span></div>
        <div class="stats">
          <div class="stat"><b>${d.answered}/${d.total}</b>answered</div>
          <div class="stat"><b>Q${d.current}</b>on question</div>
          <div class="stat"><b>${d.state === 'submitted' ? '—' : mmss(left)}</b>time left</div>
          <div class="stat"><b>${d.tabSwitches}</b>times left the test tab</div>
        </div>
        ${integrityHtml(d.counts, d.recent)}
        ${['submitted', 'time over'].includes(d.state) ? '<button class="primary" id="toReport">Open report</button>' : ''}`;
      const b = $('#toReport'); if (b) b.onclick = () => openReport(id);
    } catch (e) { $('#liveBody').textContent = e.message; }
  };
  draw(); liveTimer = setInterval(draw, 3000);
}

// ---------- Report ----------
async function openReport(id) {
  show('report');
  const box = $('#reportBody'); box.innerHTML = '<p>Loading…</p>';
  try {
    const r = await api(`/admin/tests/${id}/report`);
    const t = r.totals, pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    const bySubject = {};
    r.topics.forEach(x => { ((bySubject[x.subject] ||= {})[x.chapter] ||= []).push(x); });
    const sumRows = rows => rows.reduce((a, x) => ({ total: a.total + x.total, attempted: a.attempted + x.attempted, correct: a.correct + x.correct, wrong: a.wrong + x.wrong, score: a.score + x.score }), { total: 0, attempted: 0, correct: 0, wrong: 0, score: 0 });
    const acc = x => x.attempted ? pct(x.correct, x.attempted) : 0;
    const cls = x => !x.attempted ? 'warn' : acc(x) < 50 ? 'bad' : acc(x) >= 75 ? 'ok' : 'warn';
    const rowHtml = (label, x, strong) => `<tr><td>${strong ? '<strong>' + esc(label) + '</strong>' : esc(label)}</td>
      <td class="num">${x.total}</td><td class="num">${x.attempted}</td><td class="num">${x.correct}</td><td class="num">${x.wrong}</td>
      <td class="num">${x.score}</td><td><span class="tag ${cls(x)}">${x.attempted ? acc(x) + '%' : 'skipped'}</span></td></tr>`;
    let tables = '';
    for (const s of ['Physics', 'Chemistry', 'Biology']) {
      if (!bySubject[s]) continue;
      const sub = sumRows(Object.values(bySubject[s]).flat());
      tables += `<div class="panel scroll"><h2>${s}</h2><table>
        <thead><tr><th>Chapter / topic</th><th class="num">Qs</th><th class="num">Tried</th><th class="num">Right</th><th class="num">Wrong</th><th class="num">Marks</th><th>Accuracy</th></tr></thead><tbody>
        ${rowHtml(s + ' total', sub, true)}
        ${Object.entries(bySubject[s]).map(([ch, topics]) =>
          rowHtml(ch, sumRows(topics), true) + topics.map(x => rowHtml('   ' + x.topic, x)).join('')).join('')}
        </tbody></table></div>`;
    }
    const weak = r.topics.filter(x => x.attempted && acc(x) < 50 || !x.attempted).map(x => `${x.chapter}: ${x.topic}`);
    box.innerHTML = `
      <h1>${esc(r.title)}</h1>
      <p class="muted">Submitted ${fmt(r.submittedAt)} · Marking: +4 correct, −1 wrong · ${flagTotal(r.counts)} integrity flags</p>
      <div class="stats">
        <div class="stat"><b>${t.score}/${t.maxScore}</b>marks</div>
        <div class="stat"><b>${t.attempted}/${t.total}</b>attempted</div>
        <div class="stat"><b>${t.correct}</b>correct</div>
        <div class="stat"><b>${t.wrong}</b>wrong</div>
      </div>
      <div class="panel">${integrityHtml(r.counts, r.events, true)}</div>
      ${weak.length ? `<div class="panel"><h2>Topics to revise</h2><p>${weak.map(esc).join(' · ')}</p></div>` : ''}
      ${tables}
      <div class="panel"><h2>Question review</h2>
        ${r.review.map((q, i) => `<details><summary>Q${i + 1}. ${esc(q.subject)} · ${esc(q.chapter)} · ${esc(q.topic)}
          <span class="tag ${q.chosen === null ? 'warn' : q.chosen === q.correct ? 'ok' : 'bad'}">${q.chosen === null ? 'skipped' : q.chosen === q.correct ? 'correct' : 'wrong'}</span></summary>
          <p>${esc(q.text)}</p>
          ${q.options.map((o, k) => `<div class="review-opt ${k === q.correct ? 'right' : k === q.chosen ? 'wrong' : ''}">${'ABCD'[k]}. ${esc(o)}${k === q.correct ? ' (correct)' : k === q.chosen ? ' (student’s answer)' : ''}</div>`).join('')}
          ${q.explanation ? `<p class="muted">${esc(q.explanation)}</p>` : ''}</details>`).join('')}
      </div>`;
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

show('tests');
