'use strict';
(function () {
  const form = document.getElementById('login-form');
  const err = document.getElementById('err');
  const hint = document.getElementById('hint');
  const submit = document.getElementById('submit');

  fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (data && data.user) { location.href = '/'; return; }
    if (data && data.authEnabled === false) {
      hint.textContent = '本机未启用登录（没有用户表），可直接进入控制台。';
      const go = document.createElement('button');
      go.textContent = '进入控制台';
      go.type = 'button';
      go.addEventListener('click', () => { location.href = '/'; });
      go.style.marginTop = '10px';
      form.appendChild(go);
    }
  }).catch(() => {});

  async function login() {
    err.textContent = '';
    submit.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
          code: document.getElementById('totp').value.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      location.href = '/';
    } catch (e) {
      err.textContent = e.message;
      submit.disabled = false;
    }
  }

  // 只用按钮触发；不要用 submit，避免 JS 失效时浏览器把密码拼进 URL
  submit.addEventListener('click', login);
  form.addEventListener('submit', (event) => { event.preventDefault(); login(); });
  document.getElementById('password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); login(); }
  });
})();
