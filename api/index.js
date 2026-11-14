const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { Question, Test, Attempt, LoginFail } = require('../lib/models');

const app = express();

// ---------- Hardening ----------
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// Only the question import may be large. Everything else is capped at 100 KB.
app.use('/api/admin/questions/import', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '100kb' }));

const configError = () => {
  const e = process.env;
  if (!e.MONGODB_URI || !e.JWT_SECRET || !e.ADMIN_PASSWORD || !e.STUDENT_PASSWORD) return 'a required environment variable is missing';
  if (e.JWT_SECRET.length < 32) return 'JWT_SECRET must be at least 32 characters';
  if (e.ADMIN_PASSWORD === e.STUDENT_PASSWORD) return 'ADMIN_PASSWORD and STUDENT_PASSWORD must be different';
  if (e.ADMIN_PASSWORD.length < 8 || e.STUDENT_PASSWORD.length < 8) return 'passwords must be at least 8 characters';
  return null;
};

// ---------- DB (connection is cached between serverless calls) ----------
let conn = null;
app.use(async (req, res, next) => {
  const problem = configError();
  if (problem) {
    console.error('CONFIG ERROR:', problem);
    return res.status(500).json({ error: 'Server is not configured correctly. Check the environment variables.' });
  }
  try {
    if (!conn) conn = mongoose.connect(process.env.MONGODB_URI);
    await conn;
    next();
  } catch (e) {
    conn = null;
    console.error('DB ERROR:', e.message);
    res.status(500).json({ error: 'Database connection failed. Check MONGODB_URI.' });
  }
});

// Never leak internal error details to the browser.
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  if (e.name === 'CastError') return res.status(400).json({ error: 'Invalid request' });
  res.status(500).json({ error: 'Something went wrong on the server' });
});
const idOk = (req, res, next, id) => /^[a-f0-9]{24}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid id' });

// ---------- Auth ----------
const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();

app.post('/api/login', wrap(async (req, res) => {
  const ip = clientIp(req);
  if (await LoginFail.countDocuments({ ip }) >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
  const { role, password } = req.body || {};
  const expected = role === 'admin' ? process.env.ADMIN_PASSWORD : role === 'student' ? process.env.STUDENT_PASSWORD : null;
  if (typeof password !== 'string' || !expected || !safeEqual(password, expected)) {
    await LoginFail.create({ ip });
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: jwt.sign({ role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }) });
}));

const auth = role => (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (p.role !== role) throw new Error('role');
    next();
  } catch { res.status(401).json({ error: 'Please log in again' }); }
};

// ---------- Helpers ----------
const SUBJECT_ORDER = { Physics: 0, Chemistry: 1, Biology: 2 };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Round-robin over every topic of the selected chapters so each topic is covered before any repeats.
function generate(pool, n) {
  const byTopic = {};
  pool.forEach(q => { (byTopic[`${q.subject}|${q.chapter}|${q.topic}`] ||= []).push(q); });
  Object.values(byTopic).forEach(shuffle);
  const keys = shuffle(Object.keys(byTopic));
  const picked = [];
  while (picked.length < n) {
    let added = false;
    for (const k of keys) {
      if (picked.length >= n) break;
      const q = byTopic[k].pop();
      if (q) { picked.push(q); added = true; }
    }
    if (!added) break;
  }
  return picked.sort((a, b) => SUBJECT_ORDER[a.subject] - SUBJECT_ORDER[b.subject]);
}

function buildReport(questions, answers) {
  const rows = {};
  const review = [];
  for (const q of questions) {
    const k = `${q.subject}|${q.chapter}|${q.topic}`;
    const r = (rows[k] ||= { subject: q.subject, chapter: q.chapter, topic: q.topic, total: 0, attempted: 0, correct: 0, wrong: 0, score: 0 });
    const a = answers[String(q._id)];
    r.total++;
    const attempted = a !== undefined && a !== null;
    if (attempted) {
      r.attempted++;
      if (a === q.correct) { r.correct++; r.score += 4; } else { r.wrong++; r.score -= 1; }
    }
    review.push({ subject: q.subject, chapter: q.chapter, topic: q.topic, text: q.text, options: q.options,
      correct: q.correct, chosen: attempted ? a : null, explanation: q.explanation || '' });
  }
  const topics = Object.values(rows);
  const sum = f => topics.reduce((s, r) => s + r[f], 0);
  return { topics, review, totals: { total: sum('total'), attempted: sum('attempted'), correct: sum('correct'), wrong: sum('wrong'), score: sum('score'), maxScore: sum('total') * 4 } };
}

const EVENT_KINDS = ['tab_hidden', 'tab_return', 'window_blur', 'copy', 'cut', 'paste', 'contextmenu',
  'shortcut', 'printscreen', 'fullscreen_exit', 'devtools_suspected', 'resumed'];
const countKinds = (events = []) => events.reduce((c, e) => (c[e.kind] = (c[e.kind] || 0) + 1, c), {});

const orderedQuestions = async test => {
  const qs = await Question.find({ _id: { $in: test.questionIds } }).lean();
  const map = Object.fromEntries(qs.map(q => [String(q._id), q]));
  return test.questionIds.map(id => map[String(id)]).filter(Boolean);
};

// ================= ADMIN =================
const admin = express.Router();
admin.use(auth('admin'));
admin.param('id', idOk);

admin.get('/chapters', wrap(async (req, res) => {
  const rows = await Question.aggregate([{ $group: { _id: { s: '$subject', c: '$chapter', t: '$topic' }, n: { $sum: 1 } } }]);
  res.json(rows.map(r => ({ subject: r._id.s, chapter: r._id.c, topic: r._id.t, count: r.n })));
}));

admin.post('/questions/import', wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body.questions;
  if (!Array.isArray(list) || !list.length || list.length > 1000) return res.status(400).json({ error: 'Send a JSON array of 1 to 1000 questions' });
  try {
    const docs = await Question.insertMany(list, { ordered: true });
    res.json({ inserted: docs.length });
  } catch (e) { res.status(400).json({ error: 'Invalid question data: ' + e.message }); }
}));

admin.get('/questions/count', wrap(async (req, res) => res.json({ count: await Question.countDocuments() })));

admin.post('/tests', wrap(async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 100) : '';
  const chapters = Array.isArray(b.chapters)
    ? b.chapters.filter(c => c && typeof c.subject === 'string' && typeof c.chapter === 'string').map(c => ({ subject: c.subject, chapter: c.chapter }))
    : [];
  const startAt = new Date(b.startAt);
  const count = Math.min(Math.max(parseInt(b.count) || 45, 5), 180);
  const durationMin = Math.min(Math.max(parseInt(b.durationMin) || 45, 5), 400);
  if (!title || !chapters.length || isNaN(startAt)) return res.status(400).json({ error: 'Title, chapters and start time are required' });
  const pool = await Question.find({ $or: chapters }).lean();
  const picked = generate(pool, count);
  if (picked.length < count) return res.status(400).json({ error: `Only ${picked.length} questions available for these chapters. Add more questions or select more chapters.` });
  const test = await Test.create({ title, chapters, durationMin, startAt, questionIds: picked.map(q => q._id) });
  res.json({ id: test._id });
}));

admin.get('/tests', wrap(async (req, res) => {
  const tests = await Test.find().sort({ createdAt: -1 }).lean();
  const attempts = await Attempt.find({ testId: { $in: tests.map(t => t._id) } }).lean();
  const byTest = Object.fromEntries(attempts.map(a => [String(a.testId), a]));
  res.json(tests.map(t => {
    const a = byTest[String(t._id)];
    const status = a?.submittedAt ? 'submitted' : a ? (new Date(a.endsAt) < new Date() ? 'time over' : 'in progress') : (new Date(t.startAt) <= new Date() ? 'open' : 'scheduled');
    return { id: t._id, title: t.title, startAt: t.startAt, durationMin: t.durationMin, chapters: t.chapters, status };
  }));
}));

admin.post('/tests/:id/start-now', wrap(async (req, res) => {
  await Test.updateOne({ _id: req.params.id }, { startAt: new Date() });
  res.json({ ok: true });
}));

admin.delete('/tests/:id', wrap(async (req, res) => {
  await Test.deleteOne({ _id: req.params.id });
  await Attempt.deleteMany({ testId: req.params.id });
  res.json({ ok: true });
}));

admin.get('/tests/:id/live', wrap(async (req, res) => {
  const test = await Test.findById(req.params.id).lean();
  if (!test) return res.status(404).json({ error: 'Test not found' });
  const a = await Attempt.findOne({ testId: test._id }).lean();
  const now = Date.now();
  if (!a) return res.json({ title: test.title, state: new Date(test.startAt) <= now ? 'waiting for student to start' : 'scheduled', startAt: test.startAt, total: test.questionIds.length });
  const answered = Object.values(a.answers || {}).filter(v => v !== null && v !== undefined).length;
  res.json({
    title: test.title, total: test.questionIds.length, answered, current: a.current + 1,
    state: a.submittedAt ? 'submitted' : new Date(a.endsAt) < now ? 'time over' : 'in progress',
    online: !a.submittedAt && now - new Date(a.lastSeen).getTime() < 15000,
    lastSeen: a.lastSeen, startedAt: a.startedAt, endsAt: a.endsAt,
    tabSwitches: countKinds(a.events).tab_hidden || 0, counts: countKinds(a.events), recent: (a.events || []).slice(-8).reverse()
  });
}));

admin.get('/tests/:id/report', wrap(async (req, res) => {
  const test = await Test.findById(req.params.id).lean();
  const a = await Attempt.findOne({ testId: req.params.id }).lean();
  if (!a || (!a.submittedAt && new Date(a.endsAt) > new Date())) return res.status(400).json({ error: 'The student has not finished this test yet' });
  const qs = await orderedQuestions(test);
  res.json({ title: test.title, submittedAt: a.submittedAt || a.endsAt, startedAt: a.startedAt, counts: countKinds(a.events), events: a.events || [], ...buildReport(qs, a.answers || {}) });
}));

app.use('/api/admin', admin);

// ================= STUDENT =================
const student = express.Router();
student.use(auth('student'));
student.param('id', idOk);

student.get('/tests', wrap(async (req, res) => {
  const tests = await Test.find().sort({ startAt: -1 }).lean();
  const attempts = await Attempt.find({ testId: { $in: tests.map(t => t._id) } }).lean();
  const byTest = Object.fromEntries(attempts.map(a => [String(a.testId), a]));
  res.json({
    now: Date.now(),
    tests: tests.map(t => {
      const a = byTest[String(t._id)];
      return { id: t._id, title: t.title, startAt: t.startAt, durationMin: t.durationMin, questions: t.questionIds.length,
        state: a?.submittedAt || (a && new Date(a.endsAt) < new Date()) ? 'submitted' : a ? 'in progress' : 'new' };
    })
  });
}));

student.post('/tests/:id/start', wrap(async (req, res) => {
  const test = await Test.findById(req.params.id).lean();
  if (!test) return res.status(404).json({ error: 'Test not found' });
  if (new Date(test.startAt) > new Date()) return res.status(403).json({ error: 'This test has not started yet' });
  let a = await Attempt.findOne({ testId: test._id });
  if (a?.submittedAt) return res.status(400).json({ error: 'You have already submitted this test' });
  if (a && Date.now() > new Date(a.endsAt).getTime() + GRACE_MS) {
    await Attempt.updateOne({ _id: a._id }, { $set: { submittedAt: a.endsAt } });
    return res.status(400).json({ error: 'Time is up for this test' });
  }
  if (!a) {
    const now = new Date();
    a = await Attempt.create({ testId: test._id, startedAt: now, endsAt: new Date(now.getTime() + test.durationMin * 60000), lastSeen: now });
  } else {
    await Attempt.updateOne({ _id: a._id }, { $push: { events: { $each: [{ kind: 'resumed', detail: 'page reopened or refreshed', q: a.current, at: new Date() }], $slice: -300 } } });
  }
  const qs = await orderedQuestions(test);
  res.json({
    title: test.title, endsAt: a.endsAt, now: Date.now(), answers: a.answers || {}, current: a.current,
    questions: qs.map(q => ({ id: q._id, subject: q.subject, text: q.text, options: q.options }))
  });
}));

const GRACE_MS = 5000;
const openAttempt = async testId => {
  const a = await Attempt.findOne({ testId });
  if (!a || a.submittedAt) return null;
  return a;
};

student.post('/tests/:id/answer', wrap(async (req, res) => {
  const a = await openAttempt(req.params.id);
  if (!a) return res.status(400).json({ error: 'Test is closed' });
  if (Date.now() > new Date(a.endsAt).getTime() + GRACE_MS) return res.status(400).json({ error: 'Time is up' });
  const { qid, option, current } = req.body || {};
  const test = await Test.findById(req.params.id, 'questionIds').lean();
  if (typeof qid !== 'string' || !test || !test.questionIds.some(id => String(id) === qid)) return res.status(400).json({ error: 'Bad question' });
  const opt = option === undefined ? null : option;
  if (opt !== null && !(Number.isInteger(opt) && opt >= 0 && opt <= 3)) return res.status(400).json({ error: 'Bad option' });
  const cur = Number.isInteger(current) ? Math.min(Math.max(current, 0), test.questionIds.length - 1) : a.current;
  await Attempt.updateOne({ _id: a._id }, { $set: { [`answers.${qid}`]: opt, current: cur, lastSeen: new Date() } });
  res.json({ ok: true });
}));

student.post('/tests/:id/ping', wrap(async (req, res) => {
  const a = await openAttempt(req.params.id);
  if (!a) return res.json({ closed: true });
  await Attempt.updateOne({ _id: a._id }, { $set: { lastSeen: new Date(), current: Number.isInteger(req.body.current) ? req.body.current : a.current } });
  res.json({ ok: true, now: Date.now() });
}));

student.post('/tests/:id/events', wrap(async (req, res) => {
  const a = await openAttempt(req.params.id);
  if (!a) return res.json({ closed: true });
  const raw = Array.isArray(req.body.events) ? req.body.events.slice(0, 20) : [];
  const list = raw.filter(e => EVENT_KINDS.includes(e.kind)).map(e => ({
    kind: e.kind,
    detail: String(e.detail || '').slice(0, 80),
    q: Number.isInteger(e.q) ? e.q : null,
    at: new Date(Math.min(Math.max(Number(e.at) || Date.now(), new Date(a.startedAt).getTime()), Date.now()))
  }));
  if (list.length) await Attempt.updateOne({ _id: a._id }, { $push: { events: { $each: list, $slice: -300 } }, $set: { lastSeen: new Date() } });
  res.json({ ok: true });
}));

student.post('/tests/:id/submit', wrap(async (req, res) => {
  const a = await openAttempt(req.params.id);
  if (a) await Attempt.updateOne({ _id: a._id }, { $set: { submittedAt: new Date() } });
  res.json({ ok: true });
}));

app.use('/api/student', student);

app.use((err, req, res, next) => {
  res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: err.type === 'entity.too.large' ? 'Request too large' : 'Bad request' });
});

module.exports = app;
