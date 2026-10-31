'use strict';
// 控制台壳：路由、顶栏、右栏、轮询、命令调用
(function () {
  const { esc, badge, kindClass, summarize, time, statusText, toast, errorText } = window.UI;
  const API = window.API;

  const PAGES = [
    { route: 'dashboard', label: '工作台', icon: '◈' },
    { route: 'command', label: '命令台', icon: '⌘' },
    { divider: '办公' },
    { route: 'minutes', label: '纪要中心', icon: '▤' },
    { route: 'mail', label: '邮件', icon: '✉' },
    { route: 'calendar', label: '日历', icon: '▦' },
    { route: 'contacts', label: '通讯录', icon: '☏' },
    { route: 'files', label: '文件', icon: '▣' },
    { divider: '安全' },
    { route: 'approvals', label: '审批与确认', icon: '⛨' },
    { route: 'device', label: '设备', icon: '◉' },
    { route: 'governance', label: '治理审计', icon: '◎' },
  ];
  const TITLES = {
    dashboard: '工作台', command: '命令台', minutes: '纪要中心', mail: '邮件',
    calendar: '日历', contacts: '通讯录', files: '文件', approvals: '审批与确认',
    device: '设备', governance: '治理审计',
  };

  const store = {
    bootstrap: null,
    state: null,
    role: '员工',
    modelLocation: 'local',
    nearfieldOnline: true,
    autoMode: 'manual',
    autoSafe: null,
    route: 'dashboard',
    pendingSample: null,
    opFilter: '',
    operationId: null,
    challengeId: null,
    timer: null,
    offline: false,
  };

  const ctx = {
    store,
    setRole(role) {
      store.role = role;
      const el = document.getElementById('role-select');
      if (el) el.value = role;
    },
    setNearfield(value) {
      store.nearfieldOnline = !!value;
      const el = document.getElementById('nearfield-toggle');
      if (el) el.checked = !!value;
    },
    async setAutoMode(mode) {
      const res = await API.post('/api/mode', { mode });
      store.autoMode = res.autoMode;
      store.autoSafe = res.autoSafe;
      const el = document.getElementById('auto-mode');
      if (el) el.value = res.autoMode;
      renderChrome();
      return res;
    },
    async refreshState() {
      const state = await API.get('/api/state');
      store.state = state;
      if (state.autoMode) store.autoMode = state.autoMode;
      if (state.autoSafe) store.autoSafe = state.autoSafe;
      store.offline = false;
      renderChrome();
      return state;
    },
    async refreshBootstrap() {
      const bootstrap = await API.get('/api/bootstrap');
      store.bootstrap = bootstrap;
      store.state = bootstrap.state;
      if (bootstrap.state.autoMode) store.autoMode = bootstrap.state.autoMode;
      if (bootstrap.state.autoSafe) store.autoSafe = bootstrap.state.autoSafe;
      renderRoleOptions();
      renderChrome();
      return bootstrap;
    },
    async runCommand(payload) {
      const body = { ...payload };
      if (body.role === undefined) body.role = store.role;
      if (body.modelLocation === undefined) body.modelLocation = store.modelLocation;
      if (body.nearfieldOnline === undefined) body.nearfieldOnline = store.nearfieldOnline;
      const run = await API.post('/api/commands', body);
      store.lastRun = run;
      try { await ctx.refreshState(); } catch { /* chrome refresh is best-effort */ }
      return run;
    },
    // 异步任务：起跑后轮询阶段，离开页面任务继续跑（runId 存 localStorage）
    async startRun(payload) {
      const body = { ...payload };
      if (body.role === undefined) body.role = store.role;
      if (body.modelLocation === undefined) body.modelLocation = store.modelLocation;
      if (body.nearfieldOnline === undefined) body.nearfieldOnline = store.nearfieldOnline;
      const res = await API.post('/api/commands/async', body);
      store.activeRunId = res.runId;
      try { localStorage.setItem('safe-office.activeRun', res.runId); } catch { /* 隐私模式 */ }
      return res;
    },
    async pollRun(runId, onUpdate, { intervalMs = 900 } = {}) {
      for (;;) {
        const snap = await API.get(`/api/commands/${encodeURIComponent(runId)}`);
        if (onUpdate) onUpdate(snap);
        if (snap.status !== 'running') {
          if (store.activeRunId === runId) {
            store.activeRunId = null;
            try { localStorage.removeItem('safe-office.activeRun'); } catch { /* ignore */ }
          }
          return snap;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    async cancelRun(runId) {
      return API.post(`/api/commands/${encodeURIComponent(runId)}/cancel`, {});
    },
    navigate(route) {
      const target = `#/${route}`;
      if (location.hash === target) renderRoute();
      else location.hash = target;
    },
    rerender() { renderRoute(); },
    toast,
    errorText,
  };

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = PAGES.map((p) => {
      if (p.divider) return `<div class="nav-divider">${esc(p.divider)}</div>`;
      return `<a class="nav-item ${store.route === p.route ? 'active' : ''}" href="#/${p.route}"><span class="ico">${esc(p.icon)}</span><span>${esc(p.label)}</span></a>`;
    }).join('');
  }

  function renderRoleOptions() {
    const select = document.getElementById('role-select');
    if (!select || !store.bootstrap) return;
    const roles = store.bootstrap.roles || [];
    const locked = store.bootstrap.authUser || null;
    if (locked) store.role = locked.role;
    if (!roles.some((r) => r.name === store.role)) store.role = roles[0] ? roles[0].name : '员工';
    select.innerHTML = roles.map((r) => `<option value="${esc(r.name)}" ${r.name === store.role ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    // 登录后角色由会话绑定，不能靠下拉切换（服务端也会 403）
    select.disabled = !!locked;
    select.title = locked ? `已登录为「${locked.role}」，角色已锁定` : '';
  }

  // 顶栏模型状态以服务端实际部署为准（配置了真实模型就不能再显示"本地 Mock"）
  function modelLabel(model) {
    if (!model) return '未知';
    const who = model.model || model.name || '模型';
    return `${who}（${model.location === 'cloud' ? '云' : '本地'}）`;
  }

  function renderChrome() {
    const state = store.state;
    const modeSelect = document.getElementById('auto-mode');
    if (modeSelect) modeSelect.value = store.autoMode;
    const banner = document.getElementById('mode-banner');
    if (banner) {
      if (store.autoMode === 'auto-full') {
        banner.hidden = false;
        banner.className = 'mode-banner danger';
        banner.textContent = '全自动演示模式：所有转交动作自动批准，设备确认被绕过——仅用于对照演示，不要作为默认模式。';
      } else if (store.autoMode === 'auto-safe') {
        const safe = store.autoSafe || { quota: 3, used: 0, domains: ['partner-example.com'] };
        banner.hidden = false;
        banner.className = 'mode-banner safe';
        banner.textContent = `低风险自动：仅 ${safe.domains.join('、')} 的内部级外发自动确认（配额 ${safe.quota} 次，已用 ${safe.used} 次）；其他高危仍需 WS63。`;
      } else {
        banner.hidden = true;
        banner.textContent = '';
        banner.className = 'mode-banner';
      }
    }
    const top = document.getElementById('top-status');
    if (top) {
      if (!state) {
        top.innerHTML = '<span class="pill warn">连接中…</span>';
      } else {
        const risk = state.risk || {};
        top.innerHTML = [
          `<span class="pill ${risk.frozen ? 'block' : (risk.score > 0 ? 'warn' : 'ok')}">风险 ${esc(risk.score || 0)}/${esc(risk.threshold || 60)}</span>`,
          `<span class="pill ${state.audit && state.audit.verified ? 'ok' : 'block'}">审计链 ${state.audit && state.audit.verified ? '✓' : '异常'} · ${esc(state.counts ? state.counts.audit : 0)}</span>`,
          `<span class="pill ${state.counts && state.counts.pendingOperations ? 'warn' : 'info'}">待确认 ${esc(state.counts ? state.counts.pendingOperations : 0)}</span>`,
          `<span class="pill info" title="${esc(state.model ? state.model.mode : '')}">模型 ${esc(modelLabel(state.model))}</span>`,
          store.offline ? '<span class="pill block">连接中断</span>' : '',
        ].join('');
      }
    }

    const riskEl = document.getElementById('rail-risk');
    if (riskEl) {
      if (!state) { riskEl.innerHTML = '<h3>风险</h3><div class="empty">加载中…</div>'; return; }
      const risk = state.risk || {};
      riskEl.innerHTML = `<h3>风险</h3>
        <div class="spread"><div class="risk-num">${esc(risk.score || 0)}<span class="sub"> / ${esc(risk.threshold || 60)}</span></div>${risk.frozen ? badge('frozen') : '<span class="badge pass">正常</span>'}</div>
        <div class="risk-bar mt8"><span id="rail-risk-bar"></span></div>
        <div class="sub-text mt8">冻结次数：${esc(risk.freezeCount || 0)}</div>`;
      const bar = document.getElementById('rail-risk-bar');
      if (bar) bar.style.width = `${Math.min(100, Math.round(((risk.score || 0) / (risk.threshold || 60)) * 100))}%`;
    }

    const chainEl = document.getElementById('rail-chain');
    if (chainEl) {
      if (!state) { chainEl.innerHTML = '<h3>链状态</h3><div class="empty">加载中…</div>'; return; }
      chainEl.innerHTML = `<h3>链状态</h3>
        <div class="spread"><span class="sub-text">审计链</span>${state.audit && state.audit.verified ? '<span class="badge pass">校验通过</span>' : '<span class="badge block">异常</span>'}</div>
        <div class="spread mt8"><span class="sub-text">条目</span><span class="mono">${esc(state.audit ? state.audit.count : 0)}</span></div>
        <div class="spread mt8"><span class="sub-text">待确认挑战</span><span class="mono">${esc(state.counts ? state.counts.pendingChallenges : 0)}</span></div>`;
    }

    const eventsEl = document.getElementById('rail-events');
    if (eventsEl) {
      if (!state) { eventsEl.innerHTML = '<h3>安全事件</h3><div class="empty">加载中…</div>'; return; }
      const events = (state.audit && state.audit.recent) || [];
      eventsEl.innerHTML = `<h3>安全事件</h3>
        <div class="event-list">${events.slice().reverse().map((e) => `<div class="event ${kindClass(e.kind, e.detail)}"><div><div class="kind">${esc(e.kind)}</div><div class="detail">${esc(summarize(e.detail))}</div></div><div class="seq">#${esc(e.seq)}<br>${esc(time(e.ts))}</div></div>`).join('') || '<div class="empty">暂无事件</div>'}</div>`;
    }
  }

  function updateCrumbs() {
    const el = document.getElementById('crumbs');
    if (el) el.textContent = TITLES[store.route] || '工作台';
    document.querySelectorAll('.nav-item').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === `#/${store.route}`);
    });
  }

  async function renderRoute() {
    clearInterval(store.timer);
    store.timer = null;
    const route = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
    store.route = window.Views[route] ? route : 'dashboard';
    updateCrumbs();
    const root = document.getElementById('view');
    if (!root) return;
    root.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await window.Views[store.route](root, ctx);
    } catch (err) {
      root.innerHTML = `<div class="notice block"><strong>页面加载失败</strong><div class="sub-text mt8">${esc(errorText(err))}</div></div>`;
      toast(errorText(err), 'error');
    }
  }

  async function resetDemo() {
    if (!window.confirm('重置演示会清空审计、操作和风险，确定吗？')) return;
    try {
      await API.post('/api/reset', {});
      await ctx.refreshBootstrap();
      toast('演示已重置', 'ok');
      ctx.navigate('dashboard');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  // 改密弹窗：用原生 dialog；失败信息就地显示，不触发 API 的 401 跳转
  function bindPasswordDialog() {
    const dialog = document.getElementById('password-dialog');
    const error = document.getElementById('password-error');
    const save = document.getElementById('password-save');
    const fields = ['old-password', 'new-password', 'confirm-password'];
    if (!dialog || !error || !save) return;
    const value = (id) => document.getElementById(id).value;

    document.getElementById('btn-password').addEventListener('click', () => {
      error.textContent = '';
      for (const id of fields) document.getElementById(id).value = '';
      dialog.showModal();
      document.getElementById('old-password').focus();
    });
    document.getElementById('password-cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

    save.addEventListener('click', async () => {
      const oldPassword = value('old-password');
      const newPassword = value('new-password');
      const confirmPassword = value('confirm-password');
      error.textContent = '';
      if (newPassword.length < 8) { error.textContent = '新密码至少 8 位'; return; }
      if (newPassword !== confirmPassword) { error.textContent = '两次输入的新密码不一致'; return; }
      save.disabled = true;
      try {
        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPassword, newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
        dialog.close();
        toast('密码已修改；该账号在其他设备上的登录已失效', 'ok');
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });
  }

  function bindChrome() {
    document.getElementById('auto-mode').addEventListener('change', async (e) => {
      const mode = e.currentTarget.value;
      try {
        await ctx.setAutoMode(mode);
        toast(
          mode === 'auto-full' ? '已切换到全自动演示模式（危险，仅对照）' : mode === 'auto-safe' ? '已切换到低风险自动' : '已切换回人在环',
          mode === 'auto-full' ? 'error' : 'ok',
        );
        renderRoute();
      } catch (err) {
        toast(errorText(err), 'error');
        e.currentTarget.value = store.autoMode;
      }
    });
    document.getElementById('role-select').addEventListener('change', (e) => { store.role = e.currentTarget.value; });
    document.getElementById('model-select').addEventListener('change', (e) => { store.modelLocation = e.currentTarget.value; renderChrome(); });
    document.getElementById('nearfield-toggle').addEventListener('change', (e) => { store.nearfieldOnline = e.currentTarget.checked; });
    document.getElementById('btn-reset').addEventListener('click', resetDemo);
    // 顶部显示登录用户（未启用登录时隐藏）
    document.getElementById('btn-logout').addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
      location.href = '/login.html';
    });
    bindPasswordDialog();
    fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (data && data.user) {
        const label = document.getElementById('current-user');
        label.textContent = `${data.user.username}（${data.user.role}）`;
        label.hidden = false;
        document.getElementById('btn-logout').hidden = false;
        document.getElementById('btn-password').hidden = false;
      }
    }).catch(() => { /* ignore */ });
  }

  async function boot() {
    bindChrome();
    if (!location.hash) history.replaceState(null, '', '#/dashboard');
    try {
      await ctx.refreshBootstrap();
    } catch (err) {
      toast('无法连接控制台服务：' + errorText(err), 'error');
    }
    renderNav();
    renderChrome();
    await renderRoute();

    let polling = false;
    setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        await ctx.refreshState();
      } catch {
        store.offline = true;
        renderChrome();
      } finally {
        polling = false;
      }
    }, 5000);
  }

  window.addEventListener('hashchange', renderRoute);
  boot().catch((err) => {
    const root = document.getElementById('view');
    if (root) root.innerHTML = `<div class="notice block">启动失败：${esc(errorText(err))}</div>`;
  });
})();
