'use strict';
// 白鹭哨兵 · 手机确认端（v0.14）
//   端上做三件事：解 CHALLENGE、验 MAC、签 DECISION。服务器只转发，不代签。
//   边界：PSK 对称，验证端也有一份；本页证明的是"确认动作发生在端上"，
//        不构成"证明本人在场"。
(function () {
  const $ = (id) => document.getElementById(id);
  const STORAGE_CODE = 'sfc1.pairing.code';
  const STORAGE_TOKEN = 'sfc1.pairing.token';
  // 演示"错设备"：第二台手机加 ?device=phone-B，用的是同一配对码但设备 ID 不同
  const DEVICE_NAME = new URLSearchParams(location.search).get('device') || 'phone-A';
  const ACTION_LABELS = { 1: '外发', 2: '删除', 3: '打印', 4: '设备控制' };
  const LONG_PRESS_MS = 600;

  const state = {
    key: null,
    deviceId: null,
    pending: null,      // { challengeId, parsed, bad, reason }
    pollTimer: null,
    tickTimer: null,
    polling: false,
    busy: false,
    clockOffset: 0,
    showingResult: false,
  };

  function show(id) {
    for (const section of ['pairing', 'idle', 'challenge', 'result']) {
      $(section).hidden = section !== id;
    }
  }

  // 统一带配对会话；401 = 会话失效 → 回到配对页
  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let token = null;
    try { token = localStorage.getItem(STORAGE_TOKEN); } catch { /* ignore */ }
    if (token) headers['X-Phone-Session'] = token;
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) {
      forget();
      throw new Error('配对会话已失效，请重新输入配对码');
    }
    return res;
  }

  function setError(message) {
    const el = $('error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function setButtons(enabled) {
    $('approve').disabled = !enabled;
    $('cancel').disabled = !enabled;
  }

  function showCryptoMode() {
    $('crypto-mode').textContent = SFC1.hasWebCrypto()
      ? '端上签名 · WebCrypto'
      : '端上签名 · JS 兜底（页面不是安全上下文）';
  }

  async function deriveMaterial(code) {
    const key = await SFC1.deriveKey(code);
    const deviceId = await SFC1.deriveDeviceId(DEVICE_NAME);
    state.key = key;
    state.deviceId = deviceId;
    $('device-id').textContent = SFC1.bytesToHex(deviceId).slice(0, 8);
  }

  // ---------- 轮询 ----------
  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(poll, 1000);
    poll();
  }

  function stopPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function poll() {
    if (state.polling || state.busy || state.showingResult) return;
    state.polling = true;
    try {
      const res = await apiFetch('/api/phone/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.now === 'number') {
        state.clockOffset = data.now - Math.floor(Date.now() / 1000);
      }
      if (data.pending) {
        if (!state.pending || state.pending.challengeId !== data.pending.challengeId) {
          await enterChallenge(data.pending);
        }
      } else if (state.pending) {
        state.pending = null;
        stopTick();
        setError('');
        show('idle');
      }
    } catch (err) {
      setError(`连接控制台失败：${err.message}`);
    } finally {
      state.polling = false;
    }
  }

  // ---------- 进入挑战：端上解帧、验 MAC ----------
  async function enterChallenge(pending) {
    setError('');
    state.pending = { challengeId: pending.challengeId, parsed: null, bad: true, reason: '' };
    show('challenge');
    $('summary').textContent = '正在校验…';
    $('action').textContent = '—';
    $('countdown').textContent = '—';
    $('frame-state').textContent = '';
    $('recipient').textContent = '—';
    $('level').textContent = '—';
    $('consistency').textContent = '';
    $('details').hidden = true;
    setButtons(false);

    let parsed;
    try {
      parsed = await SFC1.decodeFrame(SFC1.base64ToBytes(pending.frame), state.key);
    } catch (err) {
      return rejectFrame(`帧校验失败：${err.message}`);
    }
    if (parsed.type !== 'challenge') return rejectFrame('帧类型不是 CHALLENGE');
    if (SFC1.bytesToHex(parsed.nonce) !== pending.challengeId) {
      return rejectFrame('nonce 与控制台挑战不一致');
    }

    state.pending = { challengeId: pending.challengeId, parsed, bad: false, reason: '' };
    $('summary').textContent = parsed.summary;
    $('action').textContent = ACTION_LABELS[parsed.action] || `未知(${parsed.action})`;

    // 展示详情：先核对"控制台给的详情"与"挑战里的目标哈希"是不是同一个操作
    const details = pending.details || null;
    const frameHash = SFC1.bytesToHex(parsed.operationHash);
    if (details && details.targetHash && details.targetHash.toLowerCase() !== frameHash) {
      return rejectFrame('展示信息与挑战目标哈希不一致，拒绝确认');
    }
    renderDetails(details, frameHash);
    $('frame-state').textContent = `已验签 · 任务 ${SFC1.bytesToHex(parsed.taskId).slice(0, 8)}… · 目标 ${frameHash.slice(0, 12)}…`;
    setButtons(true);
    startTick();
  }

  // 详情来自控制台；端上只校验"它指向的就是挑战里的那条操作"
  function renderDetails(details, frameHash) {
    const box = $('details');
    if (!details) {
      box.hidden = true;
      $('recipient').textContent = '—';
      $('level').textContent = '—';
      $('consistency').textContent = '控制台未提供操作详情';
      return;
    }
    box.hidden = false;
    $('recipient').textContent = details.recipient || '—';
    $('level').textContent = details.level || '—';
    $('body-len').textContent = details.bodyLength ? `共 ${details.bodyLength} 字` : '';
    $('body-preview').textContent = details.bodyPreview || '（空）';
    const files = details.attachments || [];
    const att = $('attachments');
    if (files.length) {
      att.hidden = false;
      att.textContent = '附件：' + files.map((f) => `${f.name}（${(f.size / 1024).toFixed(1)} KB）`).join('、');
    } else {
      att.hidden = true;
      att.textContent = '';
    }
    const same = details.targetHash && details.targetHash.toLowerCase() === frameHash;
    $('consistency').textContent = same
      ? `展示内容与挑战目标哈希一致（${frameHash.slice(0, 12)}…）· 正文内容由控制台提供，端上校验的是目标哈希`
      : '无法核对目标哈希';
    $('details-note').textContent = '正文与附件信息由控制台展示，端上只校验目标哈希；请对照你期望的内容再确认。';
  }

  function rejectFrame(reason) {
    state.pending = { ...(state.pending || {}), bad: true, reason };
    $('summary').textContent = '拒绝：帧不可信';
    $('action').textContent = '—';
    $('countdown').textContent = '—';
    $('frame-state').textContent = reason;
    $('details').hidden = true;
    $('consistency').textContent = '';
    setButtons(false);
  }

  // ---------- 倒计时 ----------
  function startTick() {
    stopTick();
    tick();
    state.tickTimer = setInterval(tick, 250);
  }

  function stopTick() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
  }

  function tick() {
    const pending = state.pending;
    if (!pending || !pending.parsed) return;
    const now = Math.floor(Date.now() / 1000) + state.clockOffset;
    const remaining = pending.parsed.expiresAt - now;
    const el = $('countdown');
    if (remaining <= 0) {
      el.textContent = '已超时';
      el.classList.remove('low');
      setButtons(false);
      $('frame-state').textContent = '已过期：nonce 会被消费，需重新发起';
      stopTick();
      return;
    }
    el.textContent = `${remaining}s`;
    el.classList.toggle('low', remaining <= 5);
  }

  // ---------- 提交 ----------
  async function submit(decisionValue) {
    const pending = state.pending;
    if (!pending || pending.bad || state.busy) return;
    state.busy = true;
    setButtons(false);
    try {
      const frame = await SFC1.encodeDecision({
        taskId: pending.parsed.taskId,
        nonce: pending.parsed.nonce,
        decision: decisionValue,
        deviceId: state.deviceId,
        decidedAt: Math.floor(Date.now() / 1000) + state.clockOffset,
      }, state.key);
      const res = await apiFetch('/api/phone/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: pending.challengeId, frame: SFC1.bytesToBase64(frame) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      showResult(data);
    } catch (err) {
      setError(`提交失败：${err.message}`);
      setButtons(true);
    } finally {
      state.busy = false;
    }
  }

  function showResult(data) {
    stopPoll();
    stopTick();
    state.showingResult = true;
    state.pending = null;

    const mark = $('result-mark');
    const title = $('result-title');
    const detail = $('result-detail');
    mark.classList.remove('bad');

    if (data.ok) {
      mark.textContent = '✓';
      title.textContent = '已确认，动作已发出';
      const cid = (data.approval && data.approval.confirmationId) || '—';
      detail.textContent = `确认号 ${cid.length > 24 ? `${cid.slice(0, 24)}…` : cid}`;
    } else if (data.outcome === 'cancelled') {
      mark.textContent = '—';
      title.textContent = '已取消';
      detail.textContent = '决定已记录，nonce 作废；操作仍冻结。';
    } else if (data.outcome === 'expired') {
      mark.classList.add('bad');
      mark.textContent = '!';
      title.textContent = '已超时';
      detail.textContent = data.message || '超过确认时限，未执行。';
    } else if (data.outcome === 'approved-but-failed') {
      mark.classList.add('bad');
      mark.textContent = '!';
      title.textContent = '已确认，但执行失败';
      detail.textContent = data.message || '';
    } else if (data.outcome === 'approved-but-unknown') {
      mark.classList.add('bad');
      mark.textContent = '!';
      title.textContent = '已确认，但结果待核实';
      detail.textContent = data.message || '发送结果不确定，请回控制台人工核对。';
    } else {
      mark.classList.add('bad');
      mark.textContent = '×';
      title.textContent = '未通过';
      detail.textContent = `${data.code || ''} ${data.message || ''}`.trim();
    }
    show('result');
  }

  function backToIdle() {
    state.showingResult = false;
    setError('');
    show('idle');
    startPoll();
  }

  // ---------- 长按取消 ----------
  function bindLongPress(el, done) {
    let timer = null;
    let raf = null;
    let startedAt = 0;
    const fill = $('cancel-fill');

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      fill.style.width = '0%';
    };

    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (el.disabled) return;
      startedAt = performance.now();
      const step = () => {
        const ratio = Math.min(1, (performance.now() - startedAt) / LONG_PRESS_MS);
        fill.style.width = `${ratio * 100}%`;
        if (ratio < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      timer = setTimeout(() => {
        reset();
        done();
      }, LONG_PRESS_MS);
    });

    for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) {
      el.addEventListener(evt, reset);
    }
  }

  // ---------- 配对 ----------
  async function pair(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) throw new Error('请输入配对码');
    // 先向服务端换会话；服务端没启用配对码（本机演示）时才允许直连
    const res = await fetch('/api/phone/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok && res.status !== 409) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data.error && data.error.message) || '配对码不正确');
    }
    if (res.ok) {
      const data = await res.json();
      try { localStorage.setItem(STORAGE_TOKEN, data.token); } catch { /* ignore */ }
    }
    await deriveMaterial(code);
    try { localStorage.setItem(STORAGE_CODE, code); } catch { /* 隐私模式忽略 */ }
    $('pairing-input').value = '';
    $('pairing-error').hidden = true;
    show('idle');
    startPoll();
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_CODE); localStorage.removeItem(STORAGE_TOKEN); } catch { /* ignore */ }
    stopPoll();
    stopTick();
    state.key = null;
    state.deviceId = null;
    state.pending = null;
    state.showingResult = false;
    setError('');
    show('pairing');
  }

  async function init() {
    showCryptoMode();
    $('approve').addEventListener('click', () => submit(1));
    $('cancel').addEventListener('click', () => {}); // 短按不生效，只认长按
    bindLongPress($('cancel'), () => submit(0));
    $('result-close').addEventListener('click', backToIdle);
    $('re-pair').addEventListener('click', forget);
    $('forget').addEventListener('click', forget);
    $('pairing-submit').addEventListener('click', async () => {
      try {
        await pair($('pairing-input').value);
      } catch (err) {
        $('pairing-error').textContent = err.message;
        $('pairing-error').hidden = false;
      }
    });
    $('pairing-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('pairing-submit').click();
    });

    let saved = null;
    let token = null;
    try { saved = localStorage.getItem(STORAGE_CODE); token = localStorage.getItem(STORAGE_TOKEN); } catch { /* ignore */ }
    if (saved && token) {
      try {
        await deriveMaterial(saved);
        show('idle');
        startPoll();
        return;
      } catch {
        forget();
        return;
      }
    }
    show('pairing');
  }

  init();
})();
