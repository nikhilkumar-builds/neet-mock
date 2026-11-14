const fs = require('fs');
if (fs.existsSync('.env')) {
  fs.readFileSync('.env', 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}
console.log('Loaded:', ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_PASSWORD', 'STUDENT_PASSWORD']
  .map(k => k + ': ' + (process.env[k] ? 'set' : 'MISSING')).join(', '));

const express = require('express');
const app = require('./api/index.js');
const root = express();
root.use(express.static('public'));
root.use(app);
root.listen(3000, () => console.log('Open http://localhost:3000'));
