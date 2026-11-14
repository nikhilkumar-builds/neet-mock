const mongoose = require('mongoose');
const { Schema } = mongoose;

const Question = mongoose.models.Question || mongoose.model('Question', new Schema({
  subject: { type: String, enum: ['Physics', 'Chemistry', 'Biology'], required: true, index: true },
  chapter: { type: String, required: true, index: true },
  topic: { type: String, required: true },
  text: { type: String, required: true },
  options: { type: [String], validate: v => v.length === 4 },
  correct: { type: Number, min: 0, max: 3, required: true },
  explanation: String
}));

const Test = mongoose.models.Test || mongoose.model('Test', new Schema({
  title: String,
  chapters: [{ subject: String, chapter: String }],
  questionIds: [Schema.Types.ObjectId],
  durationMin: { type: Number, default: 45 },
  startAt: Date,
  createdAt: { type: Date, default: Date.now }
}));

const Attempt = mongoose.models.Attempt || mongoose.model('Attempt', new Schema({
  testId: { type: Schema.Types.ObjectId, index: true },
  answers: { type: Schema.Types.Mixed, default: {} },   // { questionId: optionIndex }
  startedAt: Date,
  endsAt: Date,
  submittedAt: Date,
  lastSeen: Date,
  current: { type: Number, default: 0 },
  tabSwitches: { type: Number, default: 0 },
  events: [{ _id: false, kind: String, detail: String, q: Number, at: Date }]   // proctoring log
}, { minimize: false }));

// Wrong-password log used to rate-limit login attempts. MongoDB deletes each entry after 15 minutes.
const LoginFail = mongoose.models.LoginFail || mongoose.model('LoginFail', new Schema({
  ip: { type: String, index: true },
  at: { type: Date, default: Date.now, expires: 900 }
}));

module.exports = { Question, Test, Attempt, LoginFail };
