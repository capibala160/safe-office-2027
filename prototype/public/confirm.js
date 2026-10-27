'use strict';
// 白鹭哨兵 · 手机确认端（v0.14）
//   端上做三件事：解 CHALLENGE、验 MAC、签 DECISION。服务器只转发，不代签。
//   边界：PSK 对称，验证端也有一份；本页证明的是"确认动作发生在端上"，
//        不构成"证明本人在场"。
(function () {
  const $ = (id) => document.getElementById(id);
  const STORAGE_CODE = 'sfc1.pairing.code';
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
      const res = await fetch('/api/phone/state', { cache: 'no-store' });
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
    $('frame-state').textContent = `已验签 · 任务 ${SFC1.bytesToHex(parsed.taskId).slice(0, 8)}…`;
    setButtons(true);
    startTick();
  }

  function rejectFrame(reason) {
    state.pending = { ...(state.pending || {}), bad: true, reason };
    $('summary').textContent = '拒绝：帧不可信';
    $('action').textContent = '—';
    $('countdown').textContent = '—';
    $('frame-state').textContent = reason;
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
      const res = await fetch('/api/phone/decision', {
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
    await deriveMaterial(code);
    try { localStorage.setItem(STORAGE_CODE, code); } catch { /* 隐私模式忽略 */ }
    $('pairing-input').value = '';
    $('pairing-error').hidden = true;
    show('idle');
    startPoll();
  }

  function forget() {
    try { localStorage.removeItem(STORAGE_CODE); } catch { /* ignore */ }
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
    try { saved = localStorage.getItem(STORAGE_CODE); } catch { /* ignore */ }
    if (saved) {
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
