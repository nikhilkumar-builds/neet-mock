const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { logout(); return; }
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
function requireRole(role) { if (localStorage.getItem('role') !== role) location.href = '/'; }
function logout() { localStorage.clear(); location.href = '/'; }
const mmss = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600);
  return (h ? h + ':' : '') + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
