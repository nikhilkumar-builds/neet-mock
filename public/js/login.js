async function login() {
  $('#err').textContent = '';
  try {
    const role = $('#role').value;
    const d = await api('/login', { method: 'POST', body: { role, password: $('#pw').value } });
    localStorage.setItem('token', d.token); localStorage.setItem('role', role);
    location.href = role === 'admin' ? '/admin.html' : '/student.html';
  } catch (e) { $('#err').textContent = e.message; }
}
$('#go').onclick = login;
$('#pw').addEventListener('keydown', e => e.key === 'Enter' && login());
