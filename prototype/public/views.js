'use strict';
// 控制台页面（原生 JS，无框架）
//   所有动态文本必须经过 UI.esc 或 textContent；场景素材本身含注入文本。
(function () {
  const {
    esc, short, time, dateTime, badge, kindClass, summarize, toast,
    errorText, statusText, renderDiff,
  } = window.UI;
  const API = window.API;

  // ---------- 导出已批准正文 ----------
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }

  function downloadFile(filename, text, mime = 'text/plain;charset=utf-8') {
    const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'download';
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safe;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadText(filename, text) {
    const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'draft';
    downloadFile(safe.endsWith('.txt') ? safe : `${safe}.txt`, text);
  }

  const EXPORTABLE = new Set(['confirmed', 'executing', 'executed', 'failed']);

  const TOOL_LABELS = {
    readDoc: '读取资料', summarize: '生成摘要', sendInternalEmail: '发内网邮件',
    sendExternalEmail: '对外发邮件', deleteDoc: '删除文件', printDoc: '打印',
    scheduleMeeting: '预约会议', readContact: '查联系人', transcribeAudio: '录音转写',
    recognizeImage: '图片识别', shareScreen: '屏幕共享', deviceControl: '设备控制',
    uploadToCloud: '上传云端',
  };
  function toolLabel(name) {
    return TOOL_LABELS[name] || name;
  }

  // 命令台的权限建议：只是提示，勾选与最终授权仍由用户和服务端决定
  function recommendTools(text) {
    const s = String(text || '');
    const out = new Set();
    if (/删除|删掉|清理/.test(s)) { out.add('readDoc'); out.add('deleteDoc'); }
    if (/打印/.test(s)) { out.add('readDoc'); out.add('printDoc'); }
    if (/会议|预约|日程/.test(s)) out.add('scheduleMeeting');
    if (/联系人|通讯录/.test(s)) out.add('readContact');
    if (/转写|录音/.test(s)) out.add('transcribeAudio');
    if (/图片|识别|OCR/i.test(s)) out.add('recognizeImage');
    if (/共享|投屏/.test(s)) out.add('shareScreen');
    if (/门锁|开锁|门禁|设备|空调|灯/.test(s)) out.add('deviceControl');
    if (/发|邮件|邮箱|通知|外发/.test(s) && /外部|合作方|客户|partner|@[^\s]*\.(com|cn|net|org)/i.test(s)) {
      out.add('readDoc'); out.add('sendExternalEmail');
    } else if (/发|邮件|邮箱|通知/.test(s)) {
      out.add('readDoc'); out.add('sendInternalEmail');
    }
    if (/整理|摘要|总结|纪要|草稿|正式稿/.test(s)) { out.add('readDoc'); out.add('summarize'); }
    if (!out.size) { out.add('readDoc'); out.add('summarize'); }
    return [...out];
  }

  // ---------- 任务内确认抽屉（虚拟设备） ----------
  function removeConfirmDrawer() {
    const old = document.getElementById('confirm-drawer-backdrop');
    if (old) old.remove();
  }

  function renderApprovalFields(op, { hash = op.operationHash, attachmentNames } = {}) {
    const names = attachmentNames ?? (op.attachments || []).map((file) => file.name || file.filename).filter(Boolean);
    return `<dl class="approval-fields">
      <div><dt>动作</dt><dd>${esc(TOOL_LABELS[op.action] || op.protocolLabel || op.action || '—')}</dd></div>
      <div class="confirm-target"><dt>${op.action === 'sendExternalEmail' ? '收件人' : '目标'}</dt><dd>${esc(op.recipient || '—')}</dd></div>
      <div><dt>附件（${names.length}）</dt><dd>${names.length ? `<ul class="review-files">${names.map((name) => `<li>${esc(name)}</li>`).join('')}</ul>` : '无附件'}</dd></div>
      <div><dt>版本指纹</dt><dd class="mono">${esc(hash || '—')}</dd></div>
    </dl>`;
  }

  function mountConfirmDrawer(ch, detail, c) {
    removeConfirmDrawer();
    const trigger = document.activeElement;
    const op = (detail && detail.operation) || ch.operation || {};
    const subject = op.subject || ch.summary || '待确认操作';
    const body = (detail && detail.operation && detail.operation.body) || '';
    const expires = ch.expiresAt ? new Date(ch.expiresAt).getTime() : Date.now() + (Number(ch.remainingSec) || 30) * 1000;
    const authUser = (c.store.bootstrap && c.store.bootstrap.authUser) || null;
    const role = authUser ? authUser.role : null;
    const canDecide = !role || ['设备助手', '管理员'].includes(role);
    const wrap = document.createElement('div');
    wrap.id = 'confirm-drawer-backdrop';
    wrap.className = 'drawer-backdrop';
    wrap.innerHTML = `<aside class="drawer" id="confirm-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div class="drawer-head">
        <div>
          <div class="sub-text">请确认这次操作</div>
          <h2 id="drawer-title">${esc(subject)}</h2>
        </div>
        <button class="btn ghost small" id="drawer-close" type="button">关闭</button>
      </div>
      <div class="drawer-body">
        ${renderApprovalFields(op, { hash: op.operationHash || ch.targetHash })}
        <div class="kv"><span>密级</span><strong>${esc(op.level || '—')}</strong></div>
        <div class="kv"><span>剩余时间</span><strong class="countdown" id="drawer-countdown">${esc(ch.remainingSec === undefined ? '—' : `${ch.remainingSec}s`)}</strong></div>
        ${ch.summary && ch.summary !== subject ? `<section class="drawer-summary"><h3>内容摘要</h3><div>${esc(ch.summary)}</div></section>` : ''}
        <details class="mt8"><summary class="sub-text">查看完整正文</summary>
          <pre class="drawer-body-text mt8">${esc(body || '正文不可用，请到审批页查看详情。')}</pre>
        </details>
        <div class="notice info mt8">批准后将按上面的目标、正文和附件执行；内容一旦改动，旧确认会自动作废。</div>
        ${canDecide ? '' : `<div class="notice block mt8">已发起确认。你的角色是「${esc(role)}」，不能代替设备助手批准；请让设备助手登录后在工作台或审批页完成确认。</div>`}
        <div id="drawer-result" aria-live="polite"></div>
      </div>
      <div class="drawer-actions" id="drawer-actions">
        ${canDecide
          ? '<button class="btn ghost" id="drawer-reject" type="button">拒绝</button><button class="btn" id="drawer-approve" type="button">批准并执行</button>'
          : '<button class="btn" id="drawer-close-ok" type="button">关闭</button>'}
      </div>
    </aside>`;
    document.body.appendChild(wrap);

    const countdown = wrap.querySelector('#drawer-countdown');
    const approve = wrap.querySelector('#drawer-approve');
    const reject = wrap.querySelector('#drawer-reject');
    const result = wrap.querySelector('#drawer-result');
    const actions = wrap.querySelector('#drawer-actions');
    let deciding = false;
    let timer = null;
    const close = () => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (trigger?.isConnected) trigger.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const tick = () => {
      const left = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      if (countdown) countdown.textContent = `${left}s`;
      if (left === 0) {
        clearInterval(timer);
        if (approve) approve.disabled = true;
        if (reject) reject.disabled = true;
        if (result && !result.innerHTML) result.innerHTML = '<div class="notice block">确认已过期，请关闭后重新发起。</div>';
      }
    };
    tick();
    timer = setInterval(tick, 1000);

    wrap.querySelector('#drawer-close').addEventListener('click', close);
    wrap.querySelector('#drawer-close-ok')?.addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    result.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
    const decide = async (decision) => {
      if (deciding) return;
      deciding = true;
      if (approve) approve.disabled = true;
      if (reject) reject.disabled = true;
      try {
        const res = await API.post(`/api/device/challenges/${encodeURIComponent(ch.challengeId)}/decide`, { decision });
        clearInterval(timer);
        if (result) result.innerHTML = renderDeviceResult(res, c);
        if (actions) actions.innerHTML = '<button class="btn" id="drawer-done" type="button">完成</button>';
        wrap.querySelector('#drawer-done').addEventListener('click', () => {
          close();
          c.refreshState().catch(() => {}).then(() => c.rerender());
        });
        c.refreshState().then(() => c.rerender()).catch(() => {});
      } catch (err) {
        deciding = false;
        if (approve) approve.disabled = false;
        if (reject) reject.disabled = false;
        if (result) result.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      }
      result.scrollIntoView({ block: 'nearest' });
      wrap.querySelector('#drawer-done')?.focus({ preventScroll: true });
    };
    approve?.addEventListener('click', () => decide('approve'));
    reject?.addEventListener('click', () => decide('cancel'));
    wrap.querySelector('#drawer-close').focus();
  }

  // 返回 true 表示已在当前页打开抽屉；false 表示已转到设备页或给出提示
  async function openConfirm(operationId, c) {
    const review = await API.get(`/api/operations/${encodeURIComponent(operationId)}`).catch(() => null);
    if (review?.operation.mailApprover) {
      c.store.operationId = operationId;
      c.navigate('approvals');
      return false;
    }
    const b = c.store.bootstrap || {};
    const virtualConfirm = !(b.virtualConfirm === false);
    const serialMode = !!b.nearfieldSerial;
    const role = (b.authUser && b.authUser.role) || null;
    const canInitiate = !role || ['员工', '管理员'].includes(role);
    const id = encodeURIComponent(operationId);
    // 设备助手不能发起挑战，但可以接住发起人已经下发的挑战：先查有没有现成的待确认
    let challenge = null;
    try {
      const dev = await API.get('/api/device');
      challenge = (dev.pending || []).find((p) => p.operationId === operationId) || null;
    } catch { /* 设备状态读不到就按新挑战处理 */ }
    if (!virtualConfirm || serialMode) {
      if (!challenge) {
        if (!canInitiate) { toast('这条操作还没有发起确认，请让发起人先发起', 'info'); return false; }
        const res = await API.post(`/api/operations/${id}/challenge`);
        challenge = res.challenge;
      }
      c.store.operationId = operationId;
      c.store.challengeId = challenge.challengeId;
      toast(serialMode ? '挑战已下发，请在设备 OLED 上按键确认' : '挑战已下发，请在确认端完成', 'ok');
      c.navigate('device');
      return false;
    }
    if (!challenge) {
      if (!canInitiate) { toast('这条操作还没有发起确认，请让发起人先发起', 'info'); return false; }
      const res = await API.post(`/api/operations/${id}/challenge`);
      challenge = res.challenge;
    }
    const detail = review;
    c.store.operationId = operationId;
    c.store.challengeId = challenge.challengeId;
    mountConfirmDrawer(challenge, detail, c);
    return true;
  }

  // ---------- 通用 ----------
  function page(title, sub, actions = '') {
    return `<header class="page-heading">
      <div><h1 class="page-title">${esc(title)}</h1><p>${esc(sub)}</p></div>
      ${actions ? `<div class="btn-row">${actions}</div>` : ''}
    </header>`;
  }

  function stat(label, value, hint) {
    return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
  }

  function renderLines(lines) {
    return (lines || []).map((line) => {
      let cls = 'line';
      if (line.includes('⛔')) cls += ' line-block';
      else if (line.includes('⚠️')) cls += ' line-warn';
      else if (line.includes('⇥')) cls += ' line-defer';
      else if (line.includes('✓')) cls += ' line-ok';
      else if (line.includes('〔')) cls += ' line-note';
      return `<div class="${cls}">${esc(line)}</div>`;
    }).join('');
  }

  function renderGates(run) {
    return `<div class="gates">${(run.gateSummary || []).map((g) => (
      `<span class="gate-chip ${esc(g.status)}" title="${esc((g.notes || []).join('；'))}">${esc(g.label)} · ${esc(statusText[g.status] || g.status)}</span>`
    )).join('')}</div>`;
  }

  function renderRun(run, original = null) {
    const operations = run.operations || [];
    const actionable = operations.filter((operation) => operation.state === 'frozen').length;
    const attention = (run.gateSummary || []).filter((gate) => ['block', 'warn'].includes(gate.status));
    const evidence = run.riskEvidence || [];
    return `<section class="card review-workspace" aria-label="执行结果">
      <div class="card-head"><h2>执行结果</h2><span class="sub">${esc(run.runId)} · 风险 ${esc(run.risk.score)}/${esc(run.risk.threshold)}${run.risk.frozen ? ' · 已冻结' : ''}</span></div>
      <div class="review-layout">
        <aside class="review-panel"><h3>任务步骤</h3>${renderGates(run)}<a class="btn ghost small mt12" href="${replayHref(run.runId)}">查看本任务回放</a></aside>
        <div class="review-main"><h3>草稿与执行记录</h3>
          ${(run.archives || []).map((archive) => `<article class="op-card"><div class="op-head"><strong>${esc(archive.title)}</strong>${badge(archive.level)}</div><div class="btn-row mt8"><button type="button" class="btn small" data-review-doc="${esc(archive.id)}">查看归档稿</button><a class="btn ghost small" href="#/minutes?archive=${esc(encodeURIComponent(archive.id))}">在纪要中心打开</a></div></article>`).join('')}
          ${operations.length ? `<div class="stack">${operations.map((op) => `${original && op.action === 'sendExternalEmail' ? renderMailComparison(original, op) : ''}${operationCard(op)}`).join('')}</div>` : run.archives?.length ? '' : '<div class="sub-text">此任务没有生成待确认草稿。</div>'}
          <details class="advanced mt12" ${operations.length ? '' : 'open'}><summary>查看步骤记录</summary><div class="lines mt8">${renderLines(run.lines)}</div></details>
        </div>
        <aside class="review-panel"><h3>当前待办</h3><p>${actionable ? `${actionable} 项待核对并确认` : '暂无待确认操作'}</p>
          ${attention.length ? `<details open><summary>为什么有步骤被暂停或调整？</summary><ul class="list">${attention.map((gate) => `<li><strong>${esc(gate.label)}</strong><div>${esc((gate.notes || []).join('；') || '见步骤记录')}</div></li>`).join('')}</ul></details>` : ''}
          ${evidence.length ? `<ul class="list risk-evidence">${evidence.map((item) => item.type === 'source'
            ? `<li><strong>已隔离资料 ${esc(item.docId)}</strong><div>${esc(item.reason)}</div><button type="button" class="btn ghost small" data-review-doc="${esc(item.docId)}" data-risk-evidence="${esc(JSON.stringify({ documentHash: item.documentHash, ranges: item.ranges }))}">查看命中原文</button></li>`
            : `<li><strong>已移除动作 · ${esc(toolLabel(item.action) || '未识别动作')}</strong><div>${esc(item.reason)}</div></li>`).join('')}</ul>` : ''}
          ${run.documentIds?.length ? `<h4>任务资料</h4><div class="btn-row">${run.documentIds.map((id) => `<button type="button" class="btn ghost small" data-review-doc="${esc(id)}">查看 ${esc(id)}</button>`).join('')}</div>` : ''}
        </aside>
      </div>
      <div class="review-source" data-review-source aria-live="polite"></div>
    </section>`;
  }

  function replayHref(runId) {
    return `#/replay?run=${esc(encodeURIComponent(runId))}`;
  }

  function routeRunId() {
    return routeParams().get('run');
  }

  function routeParams() {
    return new URLSearchParams(location.hash.split('?')[1] || '');
  }

  function renderMailComparison(original, next) {
    const oldFiles = original.attachments || [];
    const newFiles = next.attachments || [];
    const changes = Boolean(next.operationId);
    const files = (items, other, side) => items.length
      ? `<ul class="review-files">${items.map((file) => {
        const same = changes && file.sha256 && other.some((entry) => entry.name === file.name && entry.sha256 === file.sha256);
        const label = changes ? (same ? '未变' : side) : '';
        return `<li>${esc(file.name)}${label ? ` <span class="badge ${same ? 'info' : 'warn'}">${label}</span>` : ''}</li>`;
      }).join('')}</ul>`
      : '<span class="sub-text">无附件</span>';
    const panel = (title, operation, attachments) => `<section class="compare-panel">
      <h4>${title}</h4>
      <div class="sub-text">收件人${operation === next && next.recipient && original.recipient !== next.recipient ? ' · 已变更' : ''}</div><strong>${esc(operation.recipient || '—')}</strong>
      <div class="sub-text mt8">附件（${attachments.length}）</div>${files(attachments, operation === original ? newFiles : oldFiles, operation === original ? '已移除' : '已加入')}
      ${operation.operationHash ? `<div class="sub-text mt8">版本指纹 <span class="mono" title="${esc(operation.operationHash)}">${esc(short(operation.operationHash, 18))}</span></div>` : ''}
    </section>`;
    const notice = changes
      ? (next.state === 'frozen' ? '请核对实际草稿，确认仅绑定右侧所示版本。' : '右侧显示这次任务实际生成的版本和回执。')
      : '重新选择本次附件。提交后可核对实际生成的草稿。';
    return `<section class="mail-comparison" aria-label="外发版本对照"><h3>外发版本对照</h3>
      <div class="compare-grid">${panel('原版本', original, oldFiles)}${panel(changes ? '新版本' : '新任务预览', next, newFiles)}</div>
      <div class="sub-text mt8">${notice}</div>
    </section>`;
  }

  function confirmationLabel(op) {
    if (op.mailApprover) return '企业独立审批';
    if (op.confirmationId === 'auto-full') return '<span class="badge block">全自动批准（未按键）</span>';
    if (op.confirmationId === 'auto-safe') return '<span class="badge warn">低风险自动批准</span>';
    if (op.confirmationId === 'policy-auto') return '<span class="badge info">策略自动确认</span>';
    if (op.confirmationId === 'policy-auto-reply') return '<span class="badge info">自动回信策略（绕过 WS63）</span>';
    if (op.state === 'rejected') return '<span class="badge info">未确认（已拒绝）</span>';
    if (String(op.confirmationId || '').startsWith('ws63-')) {
      return '<span class="badge info">WS63 真板已确认</span>';
    }
    if (op.requiresNearfield) {
      if (op.confirmationTransport === 'ws63-serial') {
        return '<span class="badge warn">需 WS63 真板确认</span>';
      }
      if (op.confirmationTransport === 'virtual-loopback') {
        return '<span class="badge warn">需近场确认（虚拟设备）</span>';
      }
      if (op.confirmationTransport === 'phone-lan') {
        return '<span class="badge warn">需近场确认（手机，非硬件）</span>';
      }
      return '<span class="badge warn">需 WS63 确认</span>';
    }
    return '<span class="badge info">策略自动确认</span>';
  }

  function operationCard(op) {
    return `<article class="op-card" data-op-card="${esc(op.operationId)}">
      <div class="op-head"><span class="tag">${esc(op.protocolLabel)}</span><strong>${esc(op.subject)}</strong>${badge(op.state)}${op.expired ? '<span class="badge block">已过期</span>' : ''}</div>
      <div class="op-meta">目标：${esc(op.recipient)} · 密级：${esc(op.level)} · ${confirmationLabel(op)}${op.mailAccount ? ` · 发件账号：${esc(op.mailAccount)}` : ''}${op.mailAlias ? ` · 别名：${esc(op.mailAlias)}` : ''}${op.createdBy ? ` · 发起人：${esc(op.createdBy)}` : ''}</div>
      <div class="op-hash">operationHash ${esc(short(op.operationHash, 28))} · ${op.outbox ? `outbox ${esc(statusText[op.outbox.state] || op.outbox.state)}` : '暂无 outbox'}</div>
      ${op.attachments && op.attachments.length ? `<div class="op-meta">附件（${op.attachments.length}）：${op.attachments.map((a) => (EXPORTABLE.has(op.state)
        ? `<a href="/api/operations/${encodeURIComponent(op.operationId)}/attachments/${esc(a.sha256)}" download="${esc(a.name)}">${esc(a.name)}</a>`
        : esc(a.name))).join('、')}</div>` : ''}
      <div class="op-actions">
        ${op.state === 'frozen' && !op.mailApprover ? `<button class="btn small" data-op-action="challenge" data-id="${esc(op.operationId)}">发起 WS63 确认</button><button class="btn ghost small" data-op-action="reject" data-id="${esc(op.operationId)}">拒绝</button>` : ''}
        ${op.state === 'confirmed' && !op.mailApprover ? `<button class="btn small" data-op-action="send" data-id="${esc(op.operationId)}">发送/执行</button>` : ''}
        ${op.outbox && op.outbox.state === 'unknown' ? `<button class="btn small" data-op-action="reconcile" data-enterprise="${Boolean(op.mailApprover)}" data-outbox="${esc(op.outbox.outboxId)}">${op.mailApprover ? '记录人工核对' : '人工核对为已发送'}</button>` : ''}
        ${EXPORTABLE.has(op.state) ? `<button class="btn ghost small" data-op-action="copy" data-id="${esc(op.operationId)}">复制正文</button><button class="btn ghost small" data-op-action="download" data-id="${esc(op.operationId)}">下载 .txt</button>` : ''}
        <button class="btn ghost small" data-op-action="verify" data-id="${esc(op.operationId)}">只读篡改校验</button>
        <button class="btn ghost small" data-op-action="detail" data-id="${esc(op.operationId)}">详情</button>
      </div>
    </article>`;
  }

  function bindOpActions(root, c) {
    root.querySelectorAll('[data-review-doc]').forEach((button) => {
      button.onclick = async () => {
        const source = button.closest('.review-workspace').querySelector('[data-review-source]');
        const destination = document.createElement('div');
        destination.textContent = '正在读取资料…';
        source.replaceChildren(destination);
        const evidence = button.dataset.riskEvidence ? JSON.parse(button.dataset.riskEvidence) : null;
        await showDocDetail(destination, c, button.dataset.reviewDoc, evidence);
        if (!destination.isConnected) return;
        const match = destination.querySelector('mark') || destination.querySelector('h2, .notice');
        if (match) {
          match.tabIndex = -1;
          match.focus({ preventScroll: true });
          match.scrollIntoView({ block: 'center' });
        }
      };
    });
    root.querySelectorAll('[data-op-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.opAction;
        const id = btn.dataset.id;
        const outboxId = btn.dataset.outbox;
        btn.disabled = true;
        try {
          if (action === 'challenge') {
            await openConfirm(id, c);
          } else if (action === 'reject') {
            await API.post(`/api/operations/${encodeURIComponent(id)}/reject`);
            toast('操作已拒绝', 'ok');
            await c.refreshState();
            c.rerender();
          } else if (action === 'send') {
            const res = await API.post(`/api/operations/${encodeURIComponent(id)}/send`);
            toast(`发送状态：${statusText[res.send.state] || res.send.state}`, res.send.state === 'sent' ? 'ok' : 'info');
            await c.refreshState();
            c.rerender();
          } else if (action === 'reconcile') {
            const payload = { state: 'sent', messageId: `manual-${Date.now()}` };
            if (btn.dataset.enterprise === 'true') {
              const state = window.prompt('输入核对结论：sent（已发送）或 failed（确认未发送）。仍不确定请取消。');
              if (!['sent', 'failed'].includes(state)) return;
              const note = window.prompt('填写邮件系统里的核对依据（例如查询记录或事件编号）');
              if (!note?.trim()) return;
              const messageId = state === 'sent' ? window.prompt('填写真实邮件追踪编号') : null;
              if (state === 'sent' && !messageId?.trim()) return;
              Object.assign(payload, { state, note, messageId });
            }
            await API.post(`/api/outbox/${encodeURIComponent(outboxId)}/reconcile`, payload);
            toast('已记录人工核对结果', 'ok');
            await c.refreshState();
            c.rerender();
          } else if (action === 'copy' || action === 'download') {
            const res = await API.get(`/api/operations/${encodeURIComponent(id)}/body`);
            const text = `${res.subject}\n收件人：${res.recipient}\n\n${res.body}`;
            if (action === 'copy') {
              await copyText(text);
              toast('已复制已批准的正文', 'ok');
            } else {
              downloadText(res.subject || 'draft', text);
              toast('已下载已批准的正文', 'ok');
            }
          } else if (action === 'verify') {
            const res = await API.post(`/api/operations/${encodeURIComponent(id)}/verify-tamper`);
            toast(`原记录校验：${res.original.ok ? '通过' : '失败'}；改动副本：${res.tampered.ok ? '通过' : '拒绝'}`, res.original.ok && !res.tampered.ok ? 'ok' : 'error');
          } else if (action === 'detail') {
            c.store.operationId = id;
            c.navigate('approvals');
          }
        } catch (err) {
          toast(c.errorText(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function eventItem(e) {
    const cls = kindClass(e.kind, e.detail);
    return `<div class="event ${cls}">
      <div><div class="kind">${esc(e.kind)}</div><div class="detail">${esc(summarize(e.detail))}</div></div>
      <div class="seq">#${esc(e.seq || '')}<br>${esc(time(e.ts || e.createdAt))}</div>
    </div>`;
  }

  function showDocDetail(container, c, id, evidence = null) {
    return API.get(`/api/documents/${encodeURIComponent(id)}`).then((res) => {
      const d = res.document;
      if (!d) { container.innerHTML = ''; return; }
      if (!d.body) {
        container.innerHTML = `<section class="card"><div class="card-head"><h2>${esc(d.title)}</h2>${badge(d.level)}</div><div class="notice info">${esc(d.note || '正文尚未进入授权知识库。')}</div></section>`;
        return;
      }
      let original = esc(d.originalBody || '');
      let evidenceNote = '';
      if (evidence && evidence.documentHash && evidence.documentHash === d.documentHash && evidence.ranges?.length) {
        let end = 0;
        original = '';
        for (const range of evidence.ranges) {
          original += esc(d.originalBody.slice(end, range.start));
          original += `<mark class="risk-match">${esc(d.originalBody.slice(range.start, range.end))}</mark>`;
          end = range.end;
        }
        original += esc(d.originalBody.slice(end));
      } else if (evidence) {
        evidenceNote = '<div class="notice info">这条记录缺少与当前文档版本匹配的原文定位。</div>';
      }
      container.innerHTML = `<section class="card">
        <div class="card-head"><h2>${esc(d.title)}</h2><span>${badge(d.level)} ${d.tainted ? '<span class="badge block">检出注入</span>' : ''}</span></div>
        ${evidenceNote}
        <pre class="lines">${esc(d.body)}</pre>
        ${d.originalBody && (d.originalBody !== d.body || evidence) ? `<details class="advanced mt12" ${evidence ? 'open' : ''}><summary>查看原始资料</summary><pre class="lines">${original}</pre></details>` : ''}
        <div class="sub-text mt8">来源：${esc((d.sourceIds || []).join('、') || d.id)} · 状态：${d.archived ? '已归档' : esc(d.status)}</div>
      </section>`;
    }).catch((err) => {
      container.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
    });
  }

  // ---------- 文档共享（v0.41） ----------
  async function showSharePanel(container, c, id) {
    try {
      const [detail, targets] = await Promise.all([
        API.get(`/api/documents/${encodeURIComponent(id)}/shares`),
        API.get('/api/share-targets'),
      ]);
      const doc = detail.document;
      const shares = detail.shares || [];
      const users = (targets.items || []);
      const roleOf = (name) => {
        const u = users.find((item) => item.username === name);
        return u ? u.role : '—';
      };
      const shared = new Set(shares.map((s) => s.grantee));
      const me = c.store.authUser ? c.store.authUser.username : null;
      const candidates = users.filter((u) => u.username !== doc.owner && u.username !== me && !shared.has(u.username));
      container.innerHTML = `<section class="card">
        <div class="card-head"><h2>共享「${esc(doc.title)}」</h2><span class="sub">所有者 ${esc(doc.owner)} · ${esc(doc.level)}</span></div>
        <div class="btn-row">
          <select class="select" id="share-target">
            ${candidates.length
              ? `<option value="">选择用户…</option>${candidates.map((u) => `<option value="${esc(u.username)}">${esc(u.username)}（${esc(u.role)}）</option>`).join('')}`
              : '<option value="">没有可共享的用户</option>'}
          </select>
          <button class="btn small" id="share-add" ${candidates.length ? '' : 'disabled'}>共享</button>
          <button class="btn ghost small" id="share-close">收起</button>
        </div>
        <div class="table-wrap mt12"><table class="table"><thead><tr><th>被授权人</th><th>角色</th><th>授权人</th><th>时间</th><th></th></tr></thead><tbody>
          ${shares.length
            ? shares.map((s) => `<tr><td>${esc(s.grantee)}</td><td>${esc(roleOf(s.grantee))}</td><td>${esc(s.grantedBy || '—')}</td><td>${esc(dateTime(s.grantedAt))}</td><td class="row-actions"><button class="btn ghost small" data-share-revoke="${esc(s.grantee)}">撤销</button></td></tr>`).join('')
            : '<tr><td colspan="5">还没有共享给任何人</td></tr>'}
        </tbody></table></div>
        <div class="sub-text mt8">共享只授予读取权限，不改变所有者与密级；撤销后对方立即失去访问权。共享与撤销都会写入审计链。</div>
      </section>`;
      container.querySelector('#share-close').addEventListener('click', () => { container.innerHTML = ''; });
      const add = container.querySelector('#share-add');
      if (add) add.addEventListener('click', async () => {
        const grantee = container.querySelector('#share-target').value;
        if (!grantee) { toast('先选择用户', 'info'); return; }
        add.disabled = true;
        try {
          await API.post(`/api/documents/${encodeURIComponent(id)}/share`, { grantee });
          toast(`已共享给 ${grantee}`, 'ok');
          await c.refreshBootstrap();
          await showSharePanel(container, c, id);
        } catch (err) { toast(errorText(err), 'error'); add.disabled = false; }
      });
      container.querySelectorAll('[data-share-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await API.post(`/api/documents/${encodeURIComponent(id)}/share/revoke`, { grantee: btn.dataset.shareRevoke });
          toast(`已撤销 ${btn.dataset.shareRevoke} 的共享`, 'ok');
          await c.refreshBootstrap();
          await showSharePanel(container, c, id);
        } catch (err) { toast(errorText(err), 'error'); btn.disabled = false; }
      }));
    } catch (err) {
      container.innerHTML = `<div class="notice block">${esc(errorText(err))}</div>`;
    }
  }

  // ---------- 工作台（任务入口） ----------
  function dayLabel(date) {
    const [, month, day] = date.split('-');
    return `${Number(month)}/${Number(day)}`;
  }

  function dailyChart(days, label) {
    const peak = Math.max(1, ...days.map(({ count }) => count));
    return `<div class="trend-chart" role="img" aria-label="${esc(`${label}：${days.map((day) => `${day.label} ${day.count} 项`).join('，')}`)}">
      ${days.map((day) => `<div class="trend-column${day.today ? ' is-today' : ''}">
        <span class="trend-value">${day.count}</span>
        <div class="trend-track">${day.count ? `<span class="trend-fill" data-height="${day.count / peak * 100}"></span>` : ''}</div>
        <span class="trend-label">${esc(day.label)}</span>
      </div>`).join('')}
    </div>`;
  }

  function sizeDailyChart(root) {
    root.querySelectorAll('.trend-fill').forEach((fill) => { fill.style.height = `${fill.dataset.height}%`; });
  }

  function renderDashboardChat(root, chat, chatReady) {
    const log = root.querySelector('#dash-chat-log');
    if (!log) return;
    const messages = chat.pending ? [...chat.messages, { role: 'user', content: chat.pending }] : chat.messages;
    log.hidden = !messages.length;
    root.querySelector('#dash-chat-empty').hidden = Boolean(messages.length);
    log.innerHTML = messages.map(({ role, content }, index) => {
      const isUser = role === 'user';
      const showQuick = !isUser && chatReady && !chat.pending && index === messages.length - 1;
      return `<div class="chat-message${isUser ? ' chat-user' : ''}">
        <span class="chat-avatar" aria-hidden="true">${isUser ? '你' : '助'}</span>
        <div class="chat-message-body">
          <div class="chat-bubble"><span class="sr-only">${isUser ? '你' : '办公助手'}：</span><div class="chat-content">${esc(content)}</div></div>
          ${showQuick ? `<div class="chat-quick" id="dash-chat-quick" role="group" aria-label="快捷改稿">
            ${['再短一点', '分条列出', '更正式一些'].map((label) => `<button class="chat-chip" type="button" data-chat-quick="${label}">${label}</button>`).join('')}
          </div>` : ''}
        </div>
      </div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
    const status = root.querySelector('#dash-chat-status');
    status.textContent = chat.pending ? '正在回复…' : chat.error;
    status.classList.toggle('chat-error', Boolean(chat.error));
    root.querySelector('#dash-send').disabled = Boolean(chat.pending) || !chatReady;
    root.querySelector('#dash-chat-clear').disabled = Boolean(chat.pending) || (!messages.length && !chat.error);
  }

  async function dashboard(root, c) {
    const state = c.store.state || await c.refreshState();
    const risk = state.risk || {};
    const [opsRes, runsRes] = await Promise.all([
      API.get('/api/operations?state=frozen').catch(() => null),
      API.get('/api/commands').catch(() => null),
    ]);
    const pending = opsRes?.items || [];
    const runs = (runsRes?.items || []).slice(0, 5);
    const trendDays = (runsRes?.dailyCounts || []).map(({ date, count }) => ({ label: dayLabel(date), count }));
    const trendTotal = trendDays.reduce((sum, day) => sum + day.count, 0);
    const draft = c.store.pendingCommand || '';
    const authUser = (c.store.bootstrap && c.store.bootstrap.authUser) || null;
    const role = authUser ? authUser.role : null;
    const canDecide = !role || ['设备助手', '管理员'].includes(role);
    const model = state.model || {};
    // 老服务端没有 chat 字段时按可用处理；助手只走真实模型，Mock 不伪造回复
    const chatReady = model.chat !== false;
    const chatHint = chatReady
      ? (model.location === 'cloud' ? `对话会发送给 ${esc(model.model || '云端模型')}，请勿输入敏感信息。` : '')
      : '未配置真实模型，仍可开始任务。';
    root.innerHTML = `
      ${risk.frozen ? `<div class="notice block"><strong>风险已冻结</strong>：风险分 ${esc(risk.score)} ≥ 阈值 ${esc(risk.threshold)}，高危动作会在转交前被拦截。<a href="#/governance">去人工复核</a></div>` : ''}
      <section class="card hero" aria-labelledby="dash-title">
        <div class="hero-compose">
          <header class="workbench-heading">
            <div class="workbench-identity"><span class="chat-avatar" aria-hidden="true">助</span><h1 id="dash-title">办公助手</h1></div>
            <details class="workbench-menu" id="dash-chat-menu">
              <summary aria-label="对话选项">⋯</summary>
              <div class="workbench-menu-panel"><button class="btn ghost small" id="dash-chat-clear" type="button" disabled>清空对话</button></div>
            </details>
          </header>
          <p class="chat-empty" id="dash-chat-empty">今天要做什么？可以问我问题，或在下方描述任务。</p>
          <div id="dash-chat-log" class="chat-log" role="log" aria-label="对话记录" tabindex="0" hidden></div>
          <div id="dash-chat-status" class="chat-status" role="status"></div>
          <div class="workbench-composer">
            <textarea class="hero-input" id="dash-command" aria-label="输入消息或任务" ${chatHint ? 'aria-describedby="dash-chat-hint"' : ''} placeholder="说点什么…">${esc(draft)}</textarea>
            <div class="hero-actions">
              <button class="btn${chatReady ? ' ghost' : ''}" id="dash-start" type="button">开始任务</button>
              <button class="btn${chatReady ? '' : ' ghost'}" id="dash-send" type="button" ${chatReady ? '' : 'disabled'}>发送</button>
            </div>
          </div>
          ${chatHint ? `<p class="chat-hint" id="dash-chat-hint">${chatHint}</p>` : ''}
        </div>
      </section>
      <section class="dashboard-templates" aria-labelledby="dashboard-templates-title">
        <h2 id="dashboard-templates-title">快捷模板</h2>
        <div class="quick-row">
          <button class="quick" data-quick="纪要" type="button"><span class="quick-icon" aria-hidden="true">▤</span><strong>整理会议纪要</strong><span>汇总周例会要点并归档</span></button>
          <button class="quick" data-quick="外发" type="button"><span class="quick-icon" aria-hidden="true">✉</span><strong>合作材料外发</strong><span>准备草稿并核对收件人</span></button>
          <button class="quick" data-quick="日程" type="button"><span class="quick-icon" aria-hidden="true">▦</span><strong>安排来访日程</strong><span>填写会议主题与时间</span></button>
          <button class="quick" data-quick="设备" type="button"><span class="quick-icon" aria-hidden="true">◇</span><strong>设备联动演示</strong><span>体验门锁确认与回执</span></button>
        </div>
      </section>
      <div class="two-col dashboard-lists">
        <section class="card">
          <div class="card-head"><h2>待你处理${opsRes ? ` <span class="sub">${pending.length} 条</span>` : ''}</h2><a href="#/approvals">全部审批</a></div>
          <div class="stack">
            ${pending.length ? pending.slice(0, 4).map((op) => `<article class="task-row">
              <div><strong>${esc(op.subject)}</strong><div class="sub-text">${esc(op.protocolLabel)} · 目标 ${esc(op.recipient)} · ${confirmationLabel(op)}</div></div>
              <div class="btn-row"><button class="btn small" data-op-action="challenge" data-id="${esc(op.operationId)}" type="button">${canDecide ? '现在确认' : '发起确认'}</button><button class="btn ghost small" data-op-action="detail" data-id="${esc(op.operationId)}" type="button">详情</button></div>
            </article>`).join('') : `<div class="dashboard-empty">
              <strong>${opsRes ? '暂无待确认操作' : '待办暂不可用'}</strong>
              <span>${opsRes ? '需要确认的动作会列在这里，可先核对操作目标和详情。' : '可前往审批页重新查询。'}</span>
              ${opsRes ? '<a class="btn ghost small" href="#/command">发起一个任务</a>' : '<a class="btn ghost small" href="#/approvals">去审批页</a>'}
            </div>`}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>最近任务</h2>${runsRes ? `<span class="sub">${runs.length} 条</span>` : ''}</div>
          <div class="stack">
            ${runs.length ? runs.map((r) => `<div class="task-row">
              <div><strong>${esc(short(r.command || r.runId, 42))}</strong><div class="sub-text">${esc(dateTime(r.at))} · ${(r.operations || []).length} 个动作 · 风险 ${esc((r.risk && r.risk.score) || 0)}</div></div>
              <a class="btn ghost small" href="${replayHref(r.runId)}">回放</a>
            </div>`).join('') : `<div class="dashboard-empty">
              <strong>${runsRes ? '还没有任务记录' : '任务记录暂不可用'}</strong>
              <span>${runsRes ? '可用快捷模板运行第一个任务，之后从这里打开回放。' : '连接恢复后，刷新页面即可重新查询。'}</span>
              <a class="btn ghost small" href="#/command">去命令台</a>
            </div>`}
          </div>
        </section>
      </div>
      <details class="card dashboard-more">
        <summary>任务统计与使用指南</summary>
        <div class="dashboard-insights">
          <section aria-labelledby="dashboard-trend-title">
            <div class="card-head"><h2 id="dashboard-trend-title">近 7 天任务</h2>${trendDays.length ? `<span class="sub">${trendTotal} 项 · 北京时间</span>` : ''}</div>
            ${trendDays.length ? dailyChart(trendDays, '近 7 天每日任务数量') : '<div class="empty">任务统计暂时不可用</div>'}
          </section>
          <section aria-labelledby="dashboard-help-title">
            <div class="card-head"><h2 id="dashboard-help-title">任务怎么走</h2></div>
            <ol><li>选模板或描述任务，在命令台核对计划。</li><li>涉及外发、打印或设备的操作，按当前模式确认。</li><li>在最近任务中打开回放，查看结果和回执。</li></ol>
            <div class="btn-row"><a class="btn ghost small" href="#/demo">演示场景</a><a class="btn ghost small" href="#/office">办公现场</a></div>
          </section>
        </div>
      </details>`;
    sizeDailyChart(root);
    const quickText = {
      纪要: '整理周例会纪要并内部归档',
      外发: '把周例会纪要发给外部参会方 partner@partner-example.com',
      日程: '预约项目对齐会，安排来访接待日程',
      设备: '打开 3 号会议室的门锁',
    };
    const quickSamples = { 外发: 'external-confirm', 设备: 'device' };
    const input = root.querySelector('#dash-command');
    const chat = c.store.chat;
    const updateChat = () => {
      if (c.store.chat === chat && c.store.route === 'dashboard') renderDashboardChat(root, chat, chatReady);
    };
    updateChat();
    // override 用于“快捷提要求”按钮：发固定要求，不动输入框里正在写的任务描述
    async function sendChat(override) {
      if (chat.pending) return;
      if (!chatReady) {
        chat.error = '未配置真实模型，助手暂不可用。';
        updateChat();
        return;
      }
      const typed = override === undefined;
      const content = String(typed ? input.value : override).trim();
      if (!content || content.length > 4000) {
        chat.error = content ? '单条消息不能超过 4000 字。' : '先输入要发送的消息。';
        updateChat();
        input.focus();
        return;
      }
      const message = { role: 'user', content };
      chat.pending = content;
      chat.error = '';
      if (typed) {
        input.value = '';
        delete input.dataset.sampleId;
        c.store.pendingCommand = null;
        c.store.pendingSample = null;
      }
      updateChat();
      try {
        const result = await API.post('/api/chat', { messages: [...chat.messages.slice(-14), message] });
        chat.messages = [...chat.messages, message, { role: 'assistant', content: result.reply }].slice(-40);
      } catch (err) {
        chat.error = c.errorText(err);
        const activeInput = c.store.route === 'dashboard' && root.querySelector('#dash-command');
        if (typed && c.store.chat === chat && activeInput && !activeInput.value) {
          activeInput.value = content;
          c.store.pendingCommand = content;
        }
      } finally {
        chat.pending = null;
        updateChat();
      }
    }
    root.querySelector('#dash-send').addEventListener('click', () => { void sendChat(); });
    root.querySelector('#dash-chat-log').addEventListener('click', (event) => {
      const button = event.target.closest('[data-chat-quick]');
      if (button) {
        input.focus();
        void sendChat(button.dataset.chatQuick);
      }
    });
    input.addEventListener('keydown', (event) => {
      if (!chatReady || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void sendChat();
    });
    const chatMenu = root.querySelector('#dash-chat-menu');
    chatMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && chatMenu.open) {
        chatMenu.open = false;
        chatMenu.querySelector('summary').focus();
      }
    });
    chatMenu.addEventListener('focusout', (event) => {
      if (!chatMenu.contains(event.relatedTarget)) chatMenu.open = false;
    });
    root.querySelector('#dash-chat-clear').addEventListener('click', () => {
      chatMenu.open = false;
      chat.messages = [];
      chat.error = '';
      updateChat();
      input.focus();
    });
    root.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = quickText[btn.dataset.quick] || '';
        input.dataset.sampleId = quickSamples[btn.dataset.quick] || '';
        const kind = btn.dataset.quick;
        c.store.pendingSample = kind === '日程' ? { calendarTemplate: true, tools: ['scheduleMeeting'], documentIds: [] }
          : kind === '纪要' ? { minutesSource: 'M2', tools: ['readDoc', 'summarize'], documentIds: [] } : null;
        c.store.pendingCommand = input.value;
        input.focus();
      });
    });
    input?.addEventListener('input', () => { c.store.pendingCommand = input.value; });
    root.querySelector('#dash-start')?.addEventListener('click', () => {
      const text = String(input.value || '').trim();
      if (!text) { toast('先描述一下要完成的任务', 'info'); input.focus(); return; }
      c.store.pendingCommand = text;
      const sampleId = input.dataset.sampleId;
      if (sampleId) {
        const selected = (c.store.bootstrap?.samples || []).find((sample) => sample.id === sampleId);
        if (selected) c.store.pendingSample = { ...selected, nearfieldOnline: undefined, sandboxPreset: undefined };
      }
      c.navigate('command');
    });
    bindOpActions(root, c);
  }

  // ---------- 演示场景（答辩用，和日常工作台分开） ----------
  async function demo(root, c) {
    const state = c.store.state || await c.refreshState();
    const counts = state.counts || {};
    const risk = state.risk || {};
    const events = (state.audit && state.audit.recent) || [];
    const samples = c.store.bootstrap.samples || [];
    const pick = ['normal-minutes', 'external-confirm', 'injection', 'private-mailbox', 'bulk-delete', 'device'];
    root.innerHTML = `${page('演示场景', '按场景体验任务执行、安全拦截、硬件确认和审计回溯。')}
      ${risk.frozen ? `<div class="notice block"><strong>风险已冻结</strong>：风险分 ${esc(risk.score)} ≥ 阈值 ${esc(risk.threshold)}，高危动作会在转交前被拦截。<button class="btn ghost small" id="dash-review" type="button">人工复核</button></div>` : ''}
      <div class="stats">
        ${stat('文档 / 图片 / 录音', (counts.documents || 0) + (counts.images || 0) + (counts.audios || 0), '演示数据')}
        ${stat('待确认操作', counts.pendingOperations || 0, '冻结记录')}
        ${stat('风险分', `${risk.score || 0} / ${risk.threshold || 60}`, risk.frozen ? '已冻结' : '正常')}
        ${stat('审计条目', counts.audit || 0, state.audit && !state.audit.verified ? '链校验异常' : (state.audit && state.audit.persisted === false ? '链有效 · 落盘失败' : '链校验通过'))}
      </div>
      <div class="two-col">
        <section class="card">
          <div class="card-head"><h2>演示剧本</h2><span class="sub">先正常流，再攻击样例</span></div>
          <div class="stack">
            <a class="sample" href="#/minutes"><strong>1 · 整理会议纪要</strong><small>读取 → 摘要 → 正式稿</small></a>
            <a class="sample" href="#/mail"><strong>2 · 内网发送</strong><small>策略自动确认 → FakeMailer</small></a>
            <a class="sample" href="#/approvals"><strong>3 · 外发确认</strong><small>冻结操作 → WS63 确认 → 发送</small></a>
            <a class="sample" href="#/device"><strong>4 · 设备控制</strong><small>门锁 → 物理通道 → 设备确认</small></a>
            <a class="sample" href="#/command"><strong>5 · 攻击样例</strong><small>注入 / 私人邮箱 / 批量删除 / 绕过审批</small></a>
            <a class="sample" href="#/governance"><strong>6 · 治理回溯</strong><small>审计链 / 风险 / 报告</small></a>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>一键样例</h2><span class="sub">直接走完整命令链路</span></div>
          <div class="sample-grid">
            ${pick.map((id) => {
              const s = samples.find((x) => x.id === id);
              return s ? `<button class="sample" data-sample="${esc(s.id)}"><strong>${esc(s.name)}</strong><small>${esc(s.expect)}</small></button>` : '';
            }).join('')}
          </div>
          <div class="sub-text mt8">攻击样例可能触发风险冻结；可在治理页复核 clear。</div>
        </section>
      </div>
      ${(c.store.bootstrap.authUser && c.store.bootstrap.authUser.role === '管理员') ? `<section class="card">
        <div class="card-head"><h2>演示前自检</h2><span class="sub">只读检查 · 管理员可见</span></div>
        <div id="preflight-box" class="sub-text">检查中…</div>
        <div class="btn-row mt12"><button class="btn ghost small" id="preflight-run">重新检查</button></div>
      </section>` : ''}
      <section class="card">
        <div class="card-head"><h2>最近安全事件</h2><span class="sub">${events.length} 条</span></div>
        <div class="event-list">${events.slice().reverse().map(eventItem).join('') || '<div class="empty">还没有事件，先跑一条命令</div>'}</div>
      </section>
      <div id="dash-result"></div>`;

    root.querySelector('#dash-review')?.addEventListener('click', async () => {
      try {
        await API.post('/api/governance/review', { outcome: 'clear', note: '工作台复核' });
        toast('已人工复核并解冻', 'ok');
        await c.refreshState();
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelectorAll('[data-sample]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const s = samples.find((x) => x.id === btn.dataset.sample);
        if (!s) return;
        btn.disabled = true;
        try {
          const run = await c.runCommand(s);
          const target = root.querySelector('#dash-result');
          if (target) target.innerHTML = renderRun(run);
          bindOpActions(root, c);
          await c.refreshState();
          toast('样例执行完成', 'ok');
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });
    const pfBox = root.querySelector('#preflight-box');
    if (pfBox) {
      const renderPreflight = (pf) => {
        if (!pf) return;
        const rows = pf.checks.map((x) => {
          const mark = x.status === 'ok' ? '✓' : (x.status === 'warn' ? '!' : '✗');
          return `<div class="spread"><span>${mark} ${esc(x.label)}</span><span class="sub-text">${esc(x.detail)}</span></div>`;
        }).join('');
        pfBox.innerHTML = `<div class="notice ${pf.ok ? 'info' : 'block'}">${pf.ok ? '通过' : '有阻塞项'}：${esc(pf.counts.ok)} 通过 / ${esc(pf.counts.warn)} 提醒 / ${esc(pf.counts.fail)} 失败</div><div class="stack mt8">${rows}</div>`;
      };
      const runPreflight = async () => {
        pfBox.textContent = '检查中…';
        try {
          const res = await API.get('/api/preflight');
          renderPreflight(res.preflight);
        } catch (err) {
          pfBox.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
        }
      };
      root.querySelector('#preflight-run')?.addEventListener('click', runPreflight);
      runPreflight();
    }
  }

  // ---------- 命令台 ----------
  async function command(root, c) {
    const b = c.store.bootstrap;
    const params = routeParams();
    const resumedTemplate = params.get('run') ? params.get('template') : null;
    const sample = c.store.pendingSample || (resumedTemplate === 'calendar'
      ? { calendarTemplate: true, tools: ['scheduleMeeting'], documentIds: [] }
      : resumedTemplate === 'minutes' ? { minutesSource: 'M2', tools: ['readDoc', 'summarize'], documentIds: [] } : null);
    const calendarTemplate = sample?.calendarTemplate;
    const minutesTemplate = Boolean(sample?.minutesSource);
    const structuredTemplate = calendarTemplate || minutesTemplate;
    const minutesDocs = minutesTemplate ? b.documents.filter((document) => document.type === 'document' && !document.deleted) : [];
    c.store.pendingSample = null;
    const pendingText = c.store.pendingCommand || '';
    c.store.pendingCommand = null;
    const replacement = sample?.replacement || null;
    const comparisonId = replacement?.operationId || routeParams().get('compare');
    const tools = sample ? (sample.tools || []) : ['readDoc', 'summarize', 'sendInternalEmail'];
    const docs = sample ? (sample.documentIds || []) : ['M2'];
    const domains = ((sample && sample.domains) || []).join(',');
    const text = pendingText || (sample && sample.command) || '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal';
    const sandbox = (sample && sample.sandboxPreset) || 'default';
    const maxCalls = sample && sample.maxCalls ? String(sample.maxCalls) : '';
    if (sample && sample.nearfieldOnline !== undefined) c.setNearfield(!!sample.nearfieldOnline);

    root.innerHTML = `${page('命令台', '描述任务、选择资料，再核对计划、确认要求和执行结果。')}
      <section class="card">
        <div class="card-head"><h2>${calendarTemplate ? '安排来访日程' : minutesTemplate ? '会议纪要归档' : '任务'}</h2>${structuredTemplate ? '' : '<span class="sub">角色 / 模型 / 近场取顶栏</span>'}</div>
        <div class="form-grid">
          ${calendarTemplate ? `<div><label class="label" for="visit-title">来访主题</label><input class="input" id="visit-title" maxlength="120" value="合作方来访交流" required></div>
          <div><label class="label" for="visit-time">开始时间（本机时区）</label><input class="input" id="visit-time" type="datetime-local" required></div>` : ''}
          ${minutesTemplate ? `<div class="full"><label class="label" for="minutes-source">纪要原件</label><select class="select" id="minutes-source" required><option value="">选择有权读取的文档</option>${minutesDocs.map((document) => `<option value="${esc(document.id)}" ${document.id === sample.minutesSource ? 'selected' : ''}>${esc(document.title)} · ${esc(document.level)}</option>`).join('')}</select><div class="sub-text mt8">每次生成独立归档稿，保留来源和密级。</div></div>` : ''}
          <div class="full" ${structuredTemplate ? 'hidden' : ''}><label class="label" for="cmd-text">想让 Agent 完成什么？</label><textarea class="textarea" id="cmd-text">${esc(text)}</textarea></div>
          <div class="full" ${structuredTemplate ? 'hidden' : ''}><label class="label">选择本次可用的资料</label><div class="checks" id="cmd-docs">${b.documents.map((d) => `<label class="check"><input type="checkbox" value="${esc(d.id)}" ${docs.includes(d.id) ? 'checked' : ''}> ${esc(d.id)} ${esc(d.title)} <span class="muted">${esc(d.level)}</span></label>`).join('')}</div></div>
          <div class="full" ${structuredTemplate ? 'hidden' : ''}><label class="label">附件（可选，最多 5 个，单个 ≤5MB）</label><input type="file" id="cmd-files" multiple /></div>
          <div class="full cmd-rec" ${structuredTemplate ? 'hidden' : ''}>
            <div><div class="sub-text">建议权限</div><strong id="cmd-rec-text">读取资料、生成摘要、发内网邮件</strong></div>
            <button class="btn ghost small" id="cmd-rec-apply" type="button">按建议勾选</button>
          </div>
        </div>
        <details class="advanced" id="cmd-advanced" ${structuredTemplate ? 'hidden' : ''}>
          <summary>高级设置（工具、域名、调用次数、执行范围）</summary>
          <div class="form-grid mt12">
            <div class="full"><label class="label">本次可用工具</label><div class="checks" id="cmd-tools">${b.tools.map((t) => `<label class="check"><input type="checkbox" value="${esc(t.name)}" ${tools.includes(t.name) ? 'checked' : ''}> ${esc(toolLabel(t.name))} <span class="muted">${esc(t.level)}</span></label>`).join('')}</div></div>
            <div><label class="label">允许外发域名（逗号分隔）</label><input class="input" id="cmd-domains" value="${esc(domains)}" placeholder="partner-example.com"></div>
            <div><label class="label">最多调用次数（空=不限）</label><input class="input" id="cmd-max" type="number" min="1" value="${esc(maxCalls)}"></div>
            <div class="full"><label class="label">执行范围</label><select class="select" id="cmd-sandbox"><option value="default" ${sandbox === 'default' ? 'selected' : ''}>默认（物理通道关闭）</option><option value="physical" ${sandbox === 'physical' ? 'selected' : ''}>开放物理通道</option></select></div>
          </div>
          <div class="sub-text mt8">外发、删除、打印和设备动作会转交确认；内网邮件按策略自动确认。这里的勾选只是本次授权，服务端策略始终优先。</div>
        </details>
        ${replacement ? `<div class="mt12" id="cmd-comparison" aria-live="polite">${renderMailComparison(replacement, { recipient: replacement.nextRecipient })}</div>` : ''}
        <div class="btn-row mt12"><button class="btn" id="cmd-run">${calendarTemplate ? '创建日程' : minutesTemplate ? '生成归档稿' : replacement ? '生成新草稿' : '执行'}</button><button class="btn ghost" id="cmd-clear" ${structuredTemplate ? 'hidden' : ''}>清空</button>${calendarTemplate ? '<a class="btn ghost" href="#/calendar">查看日历</a>' : minutesTemplate ? '<a class="btn ghost" href="#/minutes">纪要中心</a>' : ''}</div>
        <div class="hr" ${structuredTemplate ? 'hidden' : ''}></div>
        ${structuredTemplate ? '' : `<div class="sub-text mb8">样例（点击填入表单）：</div><div class="sample-grid">${b.samples.map((s) => `<button class="sample" data-cmd-sample="${esc(s.id)}"><strong>${esc(s.name)}</strong><small>${esc(s.expect)}</small></button>`).join('')}</div>`}
      </section>
      <div id="cmd-result"></div>`;

    const recEl = root.querySelector('#cmd-rec-text');
    const recApply = root.querySelector('#cmd-rec-apply');
    let recTools = [];
    const syncRecommendation = () => {
      const available = new Set((b.tools || []).map((t) => t.name));
      recTools = recommendTools(root.querySelector('#cmd-text').value).filter((name) => available.has(name));
      if (!recTools.length) recTools = ['readDoc', 'summarize'].filter((name) => available.has(name));
      if (recEl) recEl.textContent = recTools.map(toolLabel).join('、') || '按默认';
      if (recApply) recApply.disabled = recTools.length === 0;
    };
    root.querySelector('#cmd-text').addEventListener('input', syncRecommendation);
    syncRecommendation();
    recApply?.addEventListener('click', () => {
      root.querySelectorAll('#cmd-tools input').forEach((x) => { x.checked = recTools.includes(x.value); });
      toast(`已按建议勾选 ${recTools.length} 个工具`, 'ok');
    });

    const collect = () => ({
      command: root.querySelector('#cmd-text').value,
      role: c.store.role,
      tools: [...root.querySelectorAll('#cmd-tools input:checked')].map((x) => x.value),
      documentIds: [...root.querySelectorAll('#cmd-docs input:checked')].map((x) => x.value),
      domains: root.querySelector('#cmd-domains').value.split(',').map((x) => x.trim()).filter(Boolean),
      maxCalls: root.querySelector('#cmd-max').value ? Number(root.querySelector('#cmd-max').value) : undefined,
      modelLocation: c.store.modelLocation,
      nearfieldOnline: c.store.nearfieldOnline,
      sandboxPreset: root.querySelector('#cmd-sandbox').value,
    });

    // —— 任务进度：排队 → 规划 → 执行 i/n → 待确认/完成 ——
    const stageText = (snap) => {
      const last = (snap.stageLog || []).slice(-1)[0] || {};
      if (snap.stage === '执行' && last.step) return `${toolLabel(last.action) || '执行'} ${last.step}/${last.total}`;
      return snap.stage;
    };
    const progressHtml = (snap) => `<section class="card">
      <div class="card-head"><h2>任务 ${esc(snap.runId)}</h2><span class="sub" id="run-stage" role="status">${esc(stageText(snap))}</span></div>
      <div class="sub-text" id="run-log">${esc((snap.stageLog || []).map((s) => (s.step ? `${s.stage} ${s.step}/${s.total}` : s.stage)).join(' → '))}</div>
      <div class="notice info mt8" id="run-connection" role="status" hidden></div>
      <div class="btn-row mt8"><button class="btn ghost small" id="run-cancel" disabled>取消任务</button></div>
      <div class="sub-text mt8">离开本页任务不受影响；回来会接着显示进度。</div>
    </section>`;
    const target = root.querySelector('#cmd-result');
    const runButton = root.querySelector('#cmd-run');
    const clearButton = root.querySelector('#cmd-clear');
    let watchedRunId = null;
    let cancelling = false;
    let submissionUncertain = false;
    let retryPaused = false;
    const comparison = root.querySelector('#cmd-comparison');
    const prior = comparisonId
      ? API.get(`/api/operations/${encodeURIComponent(comparisonId)}`).then((detail) => detail.operation).catch(() => null)
      : Promise.resolve(null);
    if (comparison) {
      const updateComparison = () => {
        const address = root.querySelector('#cmd-text').value.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0];
        const files = [...root.querySelector('#cmd-files').files].map((file) => ({ name: file.name }));
        comparison.innerHTML = renderMailComparison(replacement, { recipient: address, attachments: files });
      };
      root.querySelector('#cmd-files').addEventListener('change', updateComparison);
      root.querySelector('#cmd-text').addEventListener('change', updateComparison);
      root.querySelector('#cmd-clear').hidden = true;
    }
    const finish = async (snap) => {
      if (!target.isConnected) return;
      if (resumedTemplate === 'minutes') {
        const sourceId = /^纪要归档：([\w-]+)$/.exec(snap.command)?.[1];
        if (sourceId) root.querySelector('#minutes-source').value = sourceId;
      }
      if (resumedTemplate === 'calendar') {
        const fields = /^来访日程：([^\r\n]+)\n开始时间：(\S+)$/.exec(snap.command);
        if (fields) {
          const start = new Date(fields[2]);
          if (Number.isFinite(start.getTime())) {
            root.querySelector('#visit-title').value = fields[1];
            const localTime = new Date(start.getTime() - start.getTimezoneOffset() * 60_000);
            root.querySelector('#visit-time').value = localTime.toISOString().slice(0, 16);
          }
        }
      }
      if (snap.status === 'error') {
        target.innerHTML = `<div class="notice block" role="alert">任务失败：${esc(snap.error || '未知错误')}。请检查任务参数后再试。</div>`;
        return;
      }
      if (snap.result) {
        const fresh = await Promise.all((snap.result.operations || []).map(async (operation) => {
          const detail = await API.get(`/api/operations/${encodeURIComponent(operation.operationId)}`).catch(() => null);
          return detail?.operation || operation;
        }));
        const original = await prior;
        if (!target.isConnected) return;
        if (comparison && fresh.some((operation) => operation.action === 'sendExternalEmail')) comparison.hidden = true;
        const outcomeNotice = snap.result.cancelled
          ? '<div class="notice info" role="status">任务已取消，后续步骤已停止。请在任务记录核对已执行的步骤。</div>'
          : snap.result.failure
            ? `<div class="notice block" role="alert">${esc(snap.result.failure.phase)}阶段中止（${esc(snap.result.failure.category)}）。后续步骤未执行。请先查看步骤记录，再决定是否重试。</div>`
            : snap.result.nextAction ? `<div class="notice info" role="status">${esc(snap.result.nextAction)}</div>` : '';
        target.innerHTML = outcomeNotice + renderRun({ ...snap.result, operations: fresh }, original);
        bindOpActions(root, c);
      }
      try { await c.refreshState(); } catch { /* best effort */ }
    };
    const watch = async (runId) => {
      if (!target.isConnected) return;
      watchedRunId = runId;
      runButton.disabled = true;
      clearButton.disabled = true;
      target.innerHTML = progressHtml({ runId, stage: '正在获取进度', stageLog: [] });
      const stage = target.querySelector('#run-stage');
      const log = target.querySelector('#run-log');
      const connection = target.querySelector('#run-connection');
      const cancelButton = target.querySelector('#run-cancel');
      retryPaused = false;
      try {
        const snapshot = await c.pollRun(runId, (status) => {
          connection.hidden = true;
          stage.textContent = stageText(status);
          log.textContent = (status.stageLog || []).map((entry) => (entry.step ? `${entry.stage} ${entry.step}/${entry.total}` : entry.stage)).join(' → ');
          cancelButton.disabled = cancelling || status.status !== 'running' || status.cancelRequested;
        }, {
          isCurrent: () => target.isConnected,
          onRetry: ({ attempt } = {}) => {
            connection.textContent = attempt
              ? `暂时无法获取进度（第 ${attempt} 次重试），连接恢复后会继续查询此任务。`
              : '暂时无法获取进度，连接恢复后会继续查询此任务。';
            connection.hidden = false;
            cancelButton.disabled = true;
          },
        });
        if (snapshot) await finish(snapshot);
      } catch (err) {
        if (err.code === 'RETRY_LIMIT' && target.isConnected) {
          retryPaused = true;
          connection.textContent = '多次无法获取进度，自动重连已暂停；已保留最后收到的进度。可继续查询，或到工作台查看最近任务。';
          connection.hidden = false;
          if (!connection.querySelector('#run-retry')) {
            const retry = document.createElement('button');
            retry.className = 'btn ghost small mt8';
            retry.id = 'run-retry';
            retry.type = 'button';
            retry.dataset.runId = runId;
            retry.textContent = '继续查询';
            connection.appendChild(retry);
          }
        } else if (target.isConnected) {
          target.innerHTML = `<div class="notice block" role="alert">无法查看任务 ${esc(runId)}：${esc(c.errorText(err))}</div>`;
        }
      } finally {
        watchedRunId = null;
        runButton.disabled = submissionUncertain || retryPaused;
        clearButton.disabled = submissionUncertain || retryPaused;
      }
    };
    runButton.addEventListener('click', async () => {
      runButton.disabled = true;
      clearButton.disabled = true;
      submissionUncertain = false;
      try {
        root.querySelector('#cmd-result').innerHTML = '<div class="notice info" role="status">正在提交任务…</div>';
        const allFiles = [...(root.querySelector('#cmd-files').files || [])];
        if (allFiles.length > 5) throw new Error(`附件最多 5 个（当前选了 ${allFiles.length} 个），请先删减`);
        const attachments = [];
        for (const file of allFiles) {
          if (file.size > 5 * 1024 * 1024) throw new Error(`附件「${file.name}」超过 5MB`);
          attachments.push({
            filename: file.name,
            mime: file.type || 'application/octet-stream',
            contentBase64: await fileToBase64(file),
          });
        }
        const payload = collect();
        if (minutesTemplate) {
          const source = root.querySelector('#minutes-source');
          if (!source.reportValidity()) { target.innerHTML = ''; return; }
          payload.command = `纪要归档：${source.value}`;
          payload.documentIds = [source.value];
        }
        if (calendarTemplate) {
          const titleField = root.querySelector('#visit-title');
          const timeField = root.querySelector('#visit-time');
          if (!titleField.reportValidity() || !timeField.reportValidity()) { target.innerHTML = ''; return; }
          const start = new Date(timeField.value);
          const title = titleField.value.trim();
          if (!title) throw new Error('请输入来访主题');
          if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) throw new Error('请选择未来的开始时间');
          payload.command = `来访日程：${title}\n开始时间：${start.toISOString()}`;
        }
        if (attachments.length) payload.attachments = attachments;
        submissionUncertain = true;
        const started = await c.startRun(payload);
        submissionUncertain = false;
        if (target.isConnected) {
          const params = new URLSearchParams({ run: started.runId });
          if (structuredTemplate) params.set('template', calendarTemplate ? 'calendar' : 'minutes');
          if (replacement && comparisonId) params.set('compare', comparisonId);
          history.replaceState(null, '', `#/command?${params}`);
        }
        await watch(started.runId);
      } catch (err) {
        submissionUncertain = submissionUncertain && (err.code === 'NETWORK' || err.status >= 500);
        if (target.isConnected) target.innerHTML = submissionUncertain
          ? '<div class="notice block" role="alert">未收到提交回执。请在连接恢复后查看工作台的最近任务及待办，核对是否已经接收。<a class="btn ghost small mt8" href="#/dashboard">前往工作台</a></div>'
          : `<div class="notice block" role="alert">${esc(c.errorText(err))}</div>`;
      }
      finally {
        runButton.disabled = submissionUncertain || retryPaused;
        clearButton.disabled = submissionUncertain || retryPaused;
      }
    });
    root.querySelector('#cmd-result').addEventListener('click', async (ev) => {
      const retryBtn = ev.target.closest('#run-retry');
      if (retryBtn) {
        const id = retryBtn.dataset.runId;
        retryBtn.disabled = true;
        if (id) void watch(id);
        return;
      }
      const btn = ev.target.closest('#run-cancel');
      if (!btn || !watchedRunId || cancelling) return;
      cancelling = true;
      btn.disabled = true;
      try {
        await c.cancelRun(watchedRunId);
        toast('已请求取消：当前步骤结束后停止，已执行步骤保留记录', 'info');
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { cancelling = false; }
    });
    // 回到本页时恢复未跑完的任务
    let resumeId = routeRunId() || (sample?.replacement ? null : c.store.activeRunId);
    if (!resumeId && !sample?.replacement) { try { resumeId = localStorage.getItem('safe-office.activeRun'); } catch { resumeId = null; } }
    if (resumeId) void watch(resumeId);
    root.querySelector('#cmd-clear').addEventListener('click', () => {
      root.querySelector('#cmd-text').value = '';
      c.store.pendingCommand = null;
      root.querySelectorAll('#cmd-tools input').forEach((x) => { x.checked = false; });
      root.querySelectorAll('#cmd-docs input').forEach((x) => { x.checked = false; });
      root.querySelector('#cmd-result').innerHTML = '';
      history.replaceState(null, '', '#/command');
      syncRecommendation();
    });
    root.querySelectorAll('[data-cmd-sample]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = b.samples.find((x) => x.id === btn.dataset.cmdSample);
        if (!s) return;
        c.store.pendingSample = s;
        history.replaceState(null, '', '#/command');
        if (s.nearfieldOnline !== undefined) c.setNearfield(!!s.nearfieldOnline);
        c.rerender();
      });
    });
  }

  // ---------- 纪要中心 ----------
  async function minutes(root, c) {
    const docs = (await API.get('/api/documents')).items;
    const base = docs.filter((d) => d.type === 'document' && !d.deleted);
    const generated = docs.filter((d) => d.type === 'draft');
    root.innerHTML = `${page('纪要中心', '从可访问的资料生成会议纪要，或查看已整理的稿件。', '<a class="btn ghost" href="#/files">导入资料</a>')}
      <div class="card collection-panel">
        <div class="collection-list">
          <div class="card-head"><h2>来源资料</h2><span class="sub">${base.length} 份</span></div>
          ${base.length ? `<div class="collection-items">${base.map((d) => `<section class="card">
        <div class="spread"><h3>${esc(d.title)}</h3>${badge(d.level)}</div>
        <div class="sub-text">${esc(d.id)} · ${esc(d.status)}</div>
        <div class="btn-row mt12"><button class="btn small" data-minutes="${esc(d.id)}">整理纪要</button><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button></div>
          </section>`).join('')}</div>` : '<div class="empty">暂无可用于整理纪要的资料，可先导入文档。</div>'}
          ${generated.length ? `<section class="card mt12"><div class="card-head"><h2>生成稿</h2><span class="sub">${generated.length} 份</span></div><div class="stack">${generated.map((d) => `<div class="spread"><span>${esc(d.title)} ${badge(d.level)} ${d.tainted ? '<span class="badge block">注入</span>' : ''}</span><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button></div>`).join('')}</div></section>` : ''}
        </div>
        <section class="card collection-detail">
          <div class="card-head"><h2>资料详情</h2></div>
          <div id="minutes-detail"><div class="empty">选择一份资料，点击「查看」即可预览。</div></div>
        </section>
      </div>`;

    const detail = root.querySelector('#minutes-detail');
    const archiveId = routeParams().get('archive');
    if (archiveId) await showDocDetail(detail, c, archiveId);
    root.querySelectorAll('[data-doc]').forEach((btn) => btn.addEventListener('click', () => showDocDetail(detail, c, btn.dataset.doc)));
    root.querySelectorAll('[data-minutes]').forEach((btn) => {
      btn.addEventListener('click', () => {
        c.store.pendingSample = { minutesSource: btn.dataset.minutes, tools: ['readDoc', 'summarize'], documentIds: [] };
        c.navigate('command');
      });
    });
  }

  // ---------- 邮件 ----------
  async function mail(root, c) {
    const emails = await API.get('/api/emails');
    const accounts = (c.store.bootstrap && c.store.bootstrap.mailAccounts) || [];
    const autoReply = (c.store.bootstrap && c.store.bootstrap.autoReply) || { enabled: false };
    const authUser = c.store.bootstrap && c.store.bootstrap.authUser;
    const canScanAutoReply = !authUser || ['管理员', '审计员'].includes(authUser.role);
    root.innerHTML = `${page('邮件', '从办公资料生成邮件草稿，核对收件人和通道，并查看发送记录。')}
      <section class="card">
        <div class="card-head"><h2>写邮件</h2><span class="sub">MockLLM 计划固定演示收件人</span></div>
        <div class="form-grid">
          <div><label class="label">文档</label><select class="select" id="mail-doc"><option value="M2">周例会纪要（草稿）</option><option value="M1">预算评审会纪要（终稿）</option></select></div>
          <div><label class="label">通道</label><select class="select" id="mail-mode"><option value="external">外发（需 WS63）</option><option value="internal">内网（自动确认）</option></select></div>
          ${accounts.length ? `<div><label class="label">发件账号</label><select class="select" id="mail-account">${accounts.map((a) => `<option value="${esc(a.name)}" ${a.default ? 'selected' : ''}>${esc(a.name)}${a.default ? '（默认）' : ''}</option>`).join('')}</select></div>` : ''}
          ${accounts.some((a) => (a.aliases || []).length) ? '<div><label class="label">发件身份</label><select class="select" id="mail-alias"></select></div>' : ''}
          <div class="full"><label class="label">收件人</label><input class="input" id="mail-to" value="partner@partner-example.com" readonly></div>
        </div>
        <div class="btn-row mt12"><button class="btn" id="mail-run">生成并发起</button></div>
        <div class="sub-text mt8" id="mail-hint">外发：partner@partner-example.com；内网：team@corp.internal。正文由 Agent 读取文档生成。</div>
      </section>
      <section class="card"><div class="card-head"><h2>邮件记录</h2><span class="sub">${emails.items.length} 条${emails.counts && emails.counts.bounced ? ` · 退信 ${emails.counts.bounced}` : ''}</span></div><div class="stack">${emails.items.length ? emails.items.map(operationCard).join('') : '<div class="empty">还没有邮件记录</div>'}</div></section>
      <section class="card"><div class="card-head"><h2>收件箱（只读）</h2><span class="sub">不标已读 / 不执行邮件内容</span></div>
        <div class="btn-row"><button class="btn ghost small" id="inbox-load">读取最近 10 封</button>${autoReply.enabled && canScanAutoReply ? '<button class="btn small" id="auto-reply-scan">按策略自动回信</button>' : ''}</div>
        <div class="sub-text mt8">自动回信：${autoReply.enabled ? `已启用（白名单 ${esc((autoReply.config.allow || []).join('、'))} · 每发件人 ${esc(autoReply.config.perSenderHours)}h 一次 · 每小时 ${esc(autoReply.config.maxPerHour)} 封 · 固定模板 · 配置层预授权，绕过 WS63）` : '未启用'}</div>
        <div id="inbox-result" class="mt12"></div>
        <div id="auto-reply-result" class="mt12"></div>
      </section>
      <div id="mail-result"></div>`;

    const mode = root.querySelector('#mail-mode');
    const to = root.querySelector('#mail-to');
    const accountSelect = root.querySelector('#mail-account');
    const aliasSelect = root.querySelector('#mail-alias');
    // 别名下拉跟着账号走；空值 = 用账号主地址
    const fillAliases = () => {
      if (!aliasSelect) return;
      const account = accounts.find((a) => a.name === (accountSelect ? accountSelect.value : ''));
      const list = (account && account.aliases) || [];
      aliasSelect.innerHTML = `<option value="">主地址${account && account.from ? `（${esc(account.from)}）` : ''}</option>`
        + list.map((x) => `<option value="${esc(x.address)}">${esc(x.name ? `${x.name} <${x.address}>` : x.address)}</option>`).join('');
    };
    fillAliases();
    if (accountSelect) accountSelect.addEventListener('change', fillAliases);
    mode.addEventListener('change', () => {
      const internal = mode.value === 'internal';
      to.value = internal ? 'team@corp.internal' : 'partner@partner-example.com';
      root.querySelector('#mail-hint').textContent = internal
        ? '内网：team@corp.internal；策略自动确认，不弹设备。'
        : '外发：partner@partner-example.com；冻结后需 WS63 确认。';
    });
    bindOpActions(root, c);
    root.querySelector('#auto-reply-scan')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const box = root.querySelector('#auto-reply-result');
      btn.disabled = true;
      try {
        const res = await API.post('/api/mail/auto-reply/scan', {});
        const reasons = Object.entries(res.reasons || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
        box.innerHTML = `<div class="notice info">扫描 ${esc(res.scanned)} 封 · 已回 ${esc(res.replied)} 封 · 跳过 ${esc(res.skipped)} 封${res.errors ? ` · 失败 ${esc(res.errors)} 封` : ''}${reasons ? `<div class="sub-text mt8">跳过原因：${esc(reasons)}</div>` : ''}</div>`;
        await c.refreshState();
      } catch (err) {
        box.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      } finally { btn.disabled = false; }
    });
    root.querySelector('#inbox-load')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const box = root.querySelector('#inbox-result');
      btn.disabled = true;
      try {
        const res = await API.get('/api/mail/inbox?limit=10');
        if (!res.configured) {
          box.innerHTML = `<div class="notice block">IMAP 未配置${res.error ? `：${esc(res.error)}` : ''}</div>`;
          return;
        }
        box.innerHTML = res.items.length
          ? `<div class="stack">${res.items.map((it) => `<div class="event"><div><div class="kind">${esc(it.subject)}</div><div class="sub-text">${esc(it.from)} · ${esc(it.date || '')} · ${it.seen ? '已读' : '未读'}</div><div class="sub-text mt8">${esc(it.preview)}</div></div><div class="seq">${esc(it.uid)}<div class="mt8"><button class="btn ghost small" data-reply-uid="${esc(it.uid)}">起草回复</button></div></div></div>`).join('')}</div><div class="sub-text mt8">${esc(res.note || '')}</div>`
          : '<div class="empty">最近没有邮件</div>';
        box.querySelectorAll('[data-reply-uid]').forEach((replyBtn) => {
          replyBtn.addEventListener('click', async () => {
            replyBtn.disabled = true;
            try {
              const draft = await API.post('/api/mail/reply-draft', { uid: Number(replyBtn.dataset.replyUid) });
              const card = document.createElement('div');
              card.className = 'notice info mt8';
              card.innerHTML = `<div><strong>回信草稿（未发送）</strong></div><div class="sub-text mt8">收件人：${esc(draft.draft.to || '(未识别)')} · 主题：${esc(draft.draft.subject)}</div><textarea class="textarea mt8" rows="5">${esc(draft.draft.body)}</textarea><div class="sub-text mt8">${esc(draft.note || '')}</div>`;
              box.appendChild(card);
            } catch (err) {
              box.insertAdjacentHTML('beforeend', `<div class="notice block mt8">${esc(c.errorText(err))}</div>`);
            } finally { replyBtn.disabled = false; }
          });
        });
      } catch (err) {
        box.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      } finally { btn.disabled = false; }
    });
    root.querySelector('#mail-run').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const doc = root.querySelector('#mail-doc').value;
        const title = doc === 'M1' ? '预算评审会纪要' : '周例会纪要';
        const payload = mode.value === 'external'
          ? {
            command: `把${title}发给外部参会方 partner@partner-example.com`,
            tools: ['readDoc', 'sendExternalEmail'], documentIds: [doc],
            domains: ['partner-example.com'],
          }
          : {
            command: `把${title}整理一下，发到部门内网邮箱 team@corp.internal`,
            tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: [doc],
          };
        const account = root.querySelector('#mail-account')?.value;
        const alias = root.querySelector('#mail-alias')?.value;
        const run = await c.runCommand({
          ...payload, role: c.store.role, nearfieldOnline: c.store.nearfieldOnline,
          ...(account ? { mailAccount: account } : {}),
          ...(alias ? { mailAlias: alias } : {}),
        });
        root.querySelector('#mail-result').innerHTML = renderRun(run);
        bindOpActions(root, c);
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
  }

  // ---------- 日历 ----------
  async function calendar(root, c) {
    const items = (await API.get('/api/calendar')).items;
    const today = new Date();
    const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
    const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      return { date: date.toDateString(), label, shortDate: `${date.getMonth() + 1}/${date.getDate()}`, today: date.toDateString() === today.toDateString(), count: 0 };
    });
    const weekByDate = new Map(weekDays.map((day) => [day.date, day]));
    for (const item of items) {
      if (typeof item.at !== 'string' || item.status === 'failed') continue;
      const at = item.at.trim().replace(' ', 'T');
      const date = new Date(at.length === 10 ? `${at}T00:00:00` : at);
      const day = weekByDate.get(date.toDateString());
      if (day) day.count += 1;
    }
    const weekTotal = weekDays.reduce((sum, day) => sum + day.count, 0);
    const labels = { written: '已生成 .ics', caldav: '已写入 CalDAV', simulated: '模拟', failed: '写入失败' };
    root.innerHTML = `${page('日历', '查看会议预约及其写入结果。', '<button class="btn" id="cal-run">安排来访日程</button><button class="btn ghost" id="cal-refresh">刷新日程</button>')}
      <section class="card calendar-week">
        <div class="card-head"><h2>本周安排</h2><span class="sub">${weekDays[0].shortDate}–${weekDays.at(-1).shortDate} · ${weekTotal} 项</span></div>
        ${dailyChart(weekDays, '本周每日安排')}
        ${weekTotal ? '' : '<p class="sub calendar-week-empty">本周暂无安排</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>日程</h2><span class="sub">${items.length} 条</span></div>
        <div class="stack">${items.map((e) => `<div class="task-row"><div><strong>${esc(e.title)}</strong><div class="sub-text">${esc(e.at?.endsWith('Z') ? dateTime(e.at) : e.at)}${e.file ? ` · ${esc(e.file)}` : ''}</div></div><span class="badge ${e.real ? 'pass' : e.status === 'failed' ? 'block' : 'info'}">${esc(e.source === 'seed' ? '示例' : labels[e.status] || '记录')}</span></div>`).join('') || '<div class="empty">暂无预约。可以从安排来访日程开始。</div>'}</div>
      </section>`;
    sizeDailyChart(root);
    root.querySelector('#cal-refresh').addEventListener('click', () => c.rerender());
    root.querySelector('#cal-run').addEventListener('click', () => {
      c.store.pendingSample = { calendarTemplate: true, tools: ['scheduleMeeting'], documentIds: [] };
      c.navigate('command');
    });
  }

  // ---------- 通讯录 ----------
  async function contacts(root, c) {
    const items = (await API.get('/api/contacts')).items;
    const roleCount = new Set(items.map((person) => person.title).filter(Boolean)).size;
    const departments = new Map();
    for (const person of items) {
      const department = person.department || '未标注部门';
      departments.set(department, (departments.get(department) || 0) + 1);
    }
    const departmentRows = [...departments].sort(([, count], [, otherCount]) => otherCount - count);
    root.innerHTML = `${page('通讯录', '按姓名或关键字查询单个联系人，结果默认脱敏。')}
      <div class="card collection-panel">
        <div class="collection-list">
          <div class="card-head"><h2>联系人</h2><span class="sub">${items.length} 人</span></div>
          <div class="collection-items">${items.map((p) => `<section class="card">
        <div class="contact-heading">
          <span class="contact-avatar" aria-hidden="true">${esc(Array.from(p.name)[0] || '?')}</span>
          <div><h3>${esc(p.name)}</h3><div class="sub-text">${esc([p.department, p.title].filter(Boolean).join(' · '))}</div></div>
        </div>
        <div class="sub-text">手机：${esc(p.phone)}</div>
        <div class="sub-text">邮箱：${esc(p.email)}</div>
        <div class="btn-row mt12"><button class="btn small" data-contact="${esc(p.name)}">单条查询</button></div>
          </section>`).join('') || '<div class="empty">暂无联系人。</div>'}</div>
          <div class="notice info mt12">查询记录会写入审计，仅支持单条查询。</div>
        </div>
        <div class="stack collection-detail-stack">
          <section class="card collection-detail">
            <div class="card-head"><h2>查询结果</h2></div>
            <div id="contacts-result"><div class="empty">点击联系人卡片上的「单条查询」，在这里查看结果。</div></div>
          </section>
          <section class="card">
            <div class="card-head"><h2>部门人数</h2><span class="sub">${departments.size} 组</span></div>
            <div class="stack">${departmentRows.map(([name, count]) => `<div class="department-row">
              <div class="spread"><strong>${esc(name)}</strong><span class="sub">${count} 人</span></div>
              <meter min="0" max="${items.length}" value="${count}" aria-label="${esc(`${name}：${count} 人，共 ${items.length} 人`)}"></meter>
            </div>`).join('') || '<div class="empty">暂无部门人数</div>'}</div>
          </section>
        </div>
      </div>
      <section class="stats contact-stats" aria-label="通讯录概览">
        <article class="stat"><span>联系人</span><strong>${items.length}</strong><small>可单条查询</small></article>
        <article class="stat"><span>岗位类别</span><strong>${roleCount}</strong><small>按联系人资料统计</small></article>
        <article class="stat"><span>隐私保护</span><strong>默认脱敏</strong><small>查询结果写入审计</small></article>
      </section>`;
    root.querySelectorAll('[data-contact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const run = await c.runCommand({
            command: `查一下${btn.dataset.contact}的联系方式`, role: c.store.role,
            tools: ['readContact'], documentIds: [], nearfieldOnline: c.store.nearfieldOnline,
          });
          root.querySelector('#contacts-result').innerHTML = renderRun(run);
          bindOpActions(root, c);
          await c.refreshState();
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });
  }

  // ---------- 文件 ----------
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function files(root, c) {
    const docs = (await API.get('/api/documents')).items;
    root.innerHTML = `${page('文件', '导入资料、转写录音，并按密级管理共享与访问。删除操作需要确认。')}
      <section class="card">
        <div class="card-head"><h2>导入真实资料</h2><span class="sub">.txt / .md / .docx，单个 ≤5MB</span></div>
        <div class="btn-row">
          <input type="file" id="doc-file" accept=".txt,.md,.markdown,.docx" />
          <select id="doc-level" class="select"><option value="内部">内部</option><option value="公开">公开</option><option value="机密">机密</option></select>
          <button class="btn small" id="doc-import">导入</button>
        </div>
        <div class="sub-text mt8">密级由你指定，模型不能改；导入后按密级进入角色可读集合。资料只存本机，不进仓库。</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>录音转写</h2><span class="sub">腾讯云一句话识别 · ≤60 秒 · wav/mp3/m4a</span></div>
        <div class="btn-row">
          <input type="file" id="audio-file" accept=".wav,.mp3,.m4a" />
          <input class="input" id="audio-title" placeholder="录音标题（可选）" style="max-width:240px" maxlength="64">
          <button class="btn small" id="audio-transcribe">上传并转写</button>
        </div>
        <div class="sub-text mt8">音频会发送到腾讯云 ASR（只限「公开」级）；转写文本按不可信输入过闸1（注入隔离）后入知识库，并写审计。未配置 ASR 时会明确报错。</div>
        <div id="audio-result" class="mt12"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>文件列表</h2><span class="sub">${docs.length} 项</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>类型</th><th>标题</th><th>密级</th><th>归属</th><th>状态</th><th>操作</th></tr></thead><tbody>
          ${docs.map((d) => {
            const canShare = d.type === 'document' && d.owner && !d.deleted && c.store.authUser
              && (d.owner === c.store.authUser.username || c.store.authUser.role === '管理员');
            const ownerLabel = d.sharedWithMe ? `${d.owner}（共享给我）` : (d.owner || '共享');
            return `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.type)}</td><td>${esc(d.title)}</td><td>${badge(d.level)}</td><td>${esc(ownerLabel)}</td><td>${esc(d.status)}</td><td class="row-actions"><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button>${d.type === 'document' && !d.deleted ? `<button class="btn ghost small" data-doc-task="minutes" data-id="${esc(d.id)}" data-title="${esc(d.title)}">整理纪要</button><button class="btn ghost small" data-doc-task="email" data-id="${esc(d.id)}" data-title="${esc(d.title)}">起草邮件</button>` : ''}${canShare ? `<button class="btn ghost small" data-share="${esc(d.id)}">共享</button>` : ''}</td></tr>`;
          }).join('')}
        </tbody></table></div>
        <div class="btn-row mt12"><button class="btn danger small" id="files-delete">删除周例会纪要（M2）</button><button class="btn ghost small" id="files-rollback">回滚最近快照</button></div>
        <div class="sub-text mt8">MockLLM 的单删计划固定为 M2；批量删除样例在命令台。删除确认后由假执行器标记 deleted。</div>
      </section>
      <div id="files-detail"></div><div id="files-result"></div>`;
    const detail = root.querySelector('#files-detail');
    root.querySelectorAll('[data-doc]').forEach((btn) => btn.addEventListener('click', () => showDocDetail(detail, c, btn.dataset.doc)));
    root.querySelectorAll('[data-share]').forEach((btn) => btn.addEventListener('click', () => showSharePanel(detail, c, btn.dataset.share)));
    // 从文件页直接发起任务：带上当前文档授权跳转到命令台
    root.querySelectorAll('[data-doc-task]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const title = btn.dataset.title || id;
      const isEmail = btn.dataset.docTask === 'email';
      c.store.pendingSample = isEmail
        ? {
            command: `把「${title}」整理成正式纪要，发到部门内网邮箱 team@corp.internal`,
            tools: ['readDoc', 'summarize', 'sendInternalEmail'],
            documentIds: [id],
          }
        : {
            command: `把「${title}」整理成正式纪要`,
            tools: ['readDoc', 'summarize'],
            documentIds: [id],
          };
      c.navigate('command');
    }));
    root.querySelector('#doc-import').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const input = root.querySelector('#doc-file');
      const level = root.querySelector('#doc-level').value;
      const file = input.files && input.files[0];
      if (!file) { toast('先选一个文件', 'info'); return; }
      if (file.size > 5 * 1024 * 1024) { toast('文件超过 5MB', 'error'); return; }
      btn.disabled = true;
      try {
        const contentBase64 = await fileToBase64(file);
        const res = await API.post('/api/documents/import', { filename: file.name, level, contentBase64 });
        toast(`已导入 ${res.document.id}：${res.document.title}`, 'ok');
        // 导入后必须刷新全局 bootstrap，否则命令台的授权文档列表看不到新资料
        await c.refreshBootstrap();
        c.rerender();
      } catch (err) {
        toast(c.errorText(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
    root.querySelector('#audio-transcribe').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const input = root.querySelector('#audio-file');
      const box = root.querySelector('#audio-result');
      const file = input.files && input.files[0];
      if (!file) { toast('先选一个音频文件', 'info'); return; }
      if (file.size > 5 * 1024 * 1024) { toast('音频超过 5MB', 'error'); return; }
      btn.disabled = true;
      box.innerHTML = '<div class="sub-text">上传中…</div>';
      try {
        const data = await fileToBase64(file);
        const title = String(root.querySelector('#audio-title').value || '').trim() || file.name;
        const saved = await API.post('/api/audios', { filename: file.name, data, title, level: '公开' });
        box.innerHTML = '<div class="sub-text">云端转写中…</div>';
        const res = await API.post(`/api/audios/${encodeURIComponent(saved.audio.id)}/transcribe`, {});
        box.innerHTML = `<div class="notice ${res.tainted ? 'block' : 'info'}">
          <strong>${esc(saved.audio.title)}</strong>${res.requestId ? ` · <span class="mono">${esc(res.requestId)}</span>` : ''}
          <div class="mt8">${esc(res.text || '（空）')}</div>
          ${res.tainted ? `<div class="sub-text mt8">⚠️ 检出注入内容已隔离：${esc((res.reasons || []).join('、'))}</div>` : ''}
          <div class="sub-text mt8">转写稿已入知识库（${esc(res.transcriptId || '')}），过闸1 后可用。</div>
        </div>`;
        toast('转写完成', 'ok');
        await c.refreshState();
      } catch (err) {
        box.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
        toast(c.errorText(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
    root.querySelector('#files-delete').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const run = await c.runCommand({
          command: '删掉周例会纪要', role: c.store.role,
          tools: ['readDoc', 'deleteDoc'], documentIds: ['M2'], nearfieldOnline: c.store.nearfieldOnline,
        });
        root.querySelector('#files-result').innerHTML = renderRun(run);
        bindOpActions(root, c);
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#files-rollback').addEventListener('click', async () => {
      try {
        const res = await API.post('/api/rollback', {});
        if (res.ok) {
          toast(`已回滚快照 #${res.snapshot.seq}（${res.snapshot.label}）`, 'ok');
          c.rerender();
        } else {
          toast(res.message || '没有可回滚的快照', 'error');
        }
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
  }

  // ---------- 审批与确认 ----------
  function renderOperationDetail(detail, revisions = null, canEdit = false, username = null) {
    const op = detail.operation;
    const canApprove = op.mailApprover && username === op.mailApprover && username !== op.createdBy && op.state === 'frozen' && !op.expired;
    const versionBlock = revisions && revisions.revisions && revisions.revisions.length
      ? `<div class="mt12"><div class="sub-text">版本历史（当前 v${esc(revisions.current.revision)}）</div>
          ${revisions.revisions.slice().reverse().map((r) => `<details class="rev"><summary>v${esc(r.revision)} · ${esc(dateTime(r.createdAt))} · ${esc(r.editor)} · ${esc(short(r.operationHash, 10))}</summary>${renderDiff(r.body, revisions.current.body)}</details>`).join('')}
        </div>`
      : '';
    const bodyBlock = canEdit && op.state === 'frozen'
      ? `<div class="mt12"><label class="label" for="op-body-edit">编辑正文</label><div class="sub-text">保存后，待确认挑战作废。请对新版本重新发起确认。</div>
          <textarea class="textarea" id="op-body-edit" rows="10">${esc(op.body || '')}</textarea><div id="op-body-diff"></div>
          <div class="btn-row mt8"><button class="btn" id="op-body-save">保存并重新冻结</button><button class="btn ghost" id="op-body-reset">还原</button></div>
        </div>`
      : `<div class="mt12"><div class="sub-text">正文预览</div><pre class="lines">${esc(op.body || '（空）')}</pre></div>`;
    return `<section class="card" id="operation-detail" tabindex="-1">
      <div class="card-head"><h2>操作详情</h2><span class="sub mono">${esc(op.operationId)}</span></div>
      <div class="btn-row">${op.runId ? `<a class="btn ghost small" href="${replayHref(op.runId)}">查看本任务回放</a>` : ''}${!op.mailApprover && op.state === 'frozen' && !op.expired ? `<button type="button" class="btn small" data-op-action="challenge" data-id="${esc(op.operationId)}">发起确认</button>` : ''}</div>
      <div class="grid-2">
        <div>
          <div class="sub-text">动作：${esc(op.protocolLabel)} / ${esc(op.action)}</div>
          <div class="sub-text">目标：${esc(op.recipient)}</div>
          <div class="sub-text">密级：${esc(op.level)}</div>
          <div class="sub-text">发起人：${esc(op.createdBy || '—')}</div>
          <div class="sub-text">状态：${badge(op.state)}</div>
          <div class="sub-text">确认：${confirmationLabel(op)}</div>
        </div>
        <div>
          <div class="sub-text">operationHash</div><div class="mono">${esc(op.operationHash)}</div>
          <div class="sub-text mt8">校验：${op.verify.ok ? '通过' : `失败：${esc(op.verify.reason)}`}</div>
          <div class="sub-text mt8">确认：${esc(op.confirmationId || '—')} · 设备：${esc(op.deviceId || '—')}</div>
        </div>
      </div>
      ${bodyBlock}
      ${op.mailApprover ? `<section class="mt12"><h3>企业邮件审核</h3><p>指定审批人：${esc(op.mailApprover)}</p>${renderApprovalFields(op)}${canApprove ? '<label><input type="checkbox" id="mail-review-ack"> 我已核对收件人、正文及附件版本</label><button type="button" class="btn" id="mail-review-submit" disabled>批准并发送</button>' : ''}</section>` : ''}
      ${canEdit && ['frozen', 'executed'].includes(op.state) && op.action === 'sendExternalEmail' ? `<details class="advanced mt12"><summary>${op.state === 'frozen' ? '修改收件人与附件' : '以此为参考新建外发任务'}</summary>
        <p>${op.state === 'frozen' ? '继续后会撤销当前草稿，待确认挑战随即失效。' : '原任务已执行，原回执保留。继续后会创建另一条外发任务，须单独确认。'}</p>
        <div id="op-replace-preview" aria-live="polite"></div>
        <form id="op-replace" class="btn-row mt12"><label for="op-replace-to">新任务收件人</label><input class="input" id="op-replace-to" type="email" value="${esc(op.recipient)}" maxlength="254" required><button type="submit" class="btn ghost">${op.state === 'frozen' ? '撤销旧草稿并继续' : '继续填写新任务'}</button></form>
      </details>` : ''}
      ${versionBlock}
      <div class="mt12"><div class="sub-text">操作事件（SQLite 事件链）</div>
        <div class="event-list">${(detail.events || []).slice().reverse().map((e) => `<div class="event info"><div><div class="kind">${esc(e.kind)}</div><div class="detail">${esc(summarize(e.detail))}</div></div><div class="seq">${esc(time(e.createdAt))}</div></div>`).join('') || '<div class="empty">无</div>'}</div>
      </div>
      <div class="sub-text mt8">本次命令审计轨迹 ${(detail.auditTrail || []).length} 条（治理页看全量）</div>
    </section>`;
  }

  async function approvals(root, c) {
    const filter = c.store.opFilter || '';
    const ops = await API.get('/api/operations' + (filter ? `?state=${encodeURIComponent(filter)}` : ''));
    const counts = ops.counts || {};
    let detailHtml = '';
    let selectedOperation = null;
    if (c.store.operationId) {
      try {
        const id = encodeURIComponent(c.store.operationId);
        const [detail, revisions] = await Promise.all([
          API.get(`/api/operations/${id}`),
          API.get(`/api/operations/${id}/revisions`).catch(() => null),
        ]);
        selectedOperation = detail.operation;
        const role = c.store.bootstrap?.authUser?.role || c.store.role;
        const username = c.store.bootstrap?.authUser?.username;
        detailHtml = renderOperationDetail(detail, revisions, ['员工', '管理员'].includes(role)
          && (!selectedOperation.mailApprover || username === selectedOperation.createdBy), username);
      } catch (err) {
        detailHtml = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      }
    }
    const virtualConfirm = !(c.store.bootstrap && c.store.bootstrap.virtualConfirm === false);
    const serialMode = !!(c.store.bootstrap && c.store.bootstrap.nearfieldSerial);
    root.innerHTML = `${page('审批与确认', '核对冻结记录里的操作目标和内容，并跟踪审批与执行结果。')}
      ${virtualConfirm ? '' : '<div class="notice block">已启用真实动作，<b>虚拟设备批准入口已关闭</b>。高危确认请用手机确认端（npm run start:lan）；本机演示可设 <span class="mono">SAFE_OFFICE_ALLOW_VIRTUAL_CONFIRM=1</span> 后重启。</div>'}
      ${serialMode ? '<div class="notice block">已接真板（串口）：挑战会显示在设备 OLED 上，<b>请在板端按键确认</b>——短按 = 批准，长按 ≥0.6s = 取消；页面上的批准/取消按钮只负责发起挑战。</div>' : ''}
      <section class="card">
        <div class="spread">
          <div class="tabs">${['', 'frozen', 'confirmed', 'executing', 'executed', 'rejected', 'failed'].map((s) => `<button class="tab ${filter === s ? 'active' : ''}" data-op-filter="${esc(s)}">${s ? esc(statusText[s] || s) : '全部'}${counts[s] ? ` (${counts[s]})` : ''}</button>`).join('')}</div>
          <span class="sub">${ops.items.length} 条</span>
        </div>
        <div class="stack mt12">${ops.items.length ? ops.items.map(operationCard).join('') : `<div class="empty">${filter ? '当前筛选下没有操作，可以切换到全部。' : '暂无审批记录。任务中的待确认动作会列在这里。'}</div>`}</div>
      </section>
      ${detailHtml}
      <div id="approvals-result"></div>`;
    bindOpActions(root, c);
    root.querySelector('#operation-detail')?.focus();
    const reviewAck = root.querySelector('#mail-review-ack');
    const reviewSubmit = root.querySelector('#mail-review-submit');
    reviewAck?.addEventListener('change', () => { reviewSubmit.disabled = !reviewAck.checked; });
    reviewSubmit?.addEventListener('click', async () => {
      reviewSubmit.disabled = true;
      reviewAck.disabled = true;
      try {
        const res = await API.post(`/api/operations/${encodeURIComponent(selectedOperation.operationId)}/approve-mail`, {
          operationHash: selectedOperation.operationHash,
        });
        toast(`发送状态：${statusText[res.send.state] || res.send.state}`, res.send.state === 'sent' ? 'ok' : 'info');
        await c.refreshState();
        c.rerender();
      } catch (err) {
        toast(c.errorText(err), 'error');
        c.rerender();
      }
    });
    const replaceInput = root.querySelector('#op-replace-to');
    if (replaceInput) {
      const preview = root.querySelector('#op-replace-preview');
      const updatePreview = () => { preview.innerHTML = renderMailComparison(selectedOperation, { recipient: replaceInput.value.trim() }); };
      updatePreview();
      replaceInput.addEventListener('change', updatePreview);
    }
    root.querySelector('#op-replace')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      const recipient = form.querySelector('input').value.trim();
      button.disabled = true;
      try {
        if (selectedOperation.state === 'frozen') {
          const result = await API.post(`/api/operations/${encodeURIComponent(selectedOperation.operationId)}/reject`);
          toast(result.voidedChallenges ? '旧草稿已撤销，旧挑战已作废' : '旧草稿已撤销', 'ok');
        }
        c.store.pendingCommand = `把选中的资料发给外部合作方 ${recipient}`;
        c.store.pendingSample = {
          replacement: { ...selectedOperation, nextRecipient: recipient },
          tools: ['readDoc', 'sendExternalEmail'],
          documentIds: selectedOperation.sourceDocIds || [],
          domains: [recipient.split('@').at(-1)],
        };
        c.navigate('command');
      } catch (err) { toast(c.errorText(err), 'error'); button.disabled = false; }
    });
    const editBox = root.querySelector('#op-body-edit');
    if (editBox) {
      const original = editBox.value;
      const diff = root.querySelector('#op-body-diff');
      const updateDiff = () => {
        diff.innerHTML = original === editBox.value ? '' : `<details class="advanced mt8"><summary>核对本次正文差异</summary>${renderDiff(original, editBox.value)}</details>`;
      };
      editBox.addEventListener('change', updateDiff);
      root.querySelector('#op-body-reset').addEventListener('click', () => { editBox.value = original; updateDiff(); });
      root.querySelector('#op-body-save').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const res = await API.post(`/api/operations/${encodeURIComponent(c.store.operationId)}/body`, {
            body: editBox.value, editor: c.store.role,
          });
          if (res.changed) {
            toast(`已保存 v${res.revisions ? res.revisions.length + 1 : ''}：哈希已重算${res.voidedChallenges ? `，${res.voidedChallenges} 个待确认挑战作废` : ''}`, 'ok');
            await c.refreshState();
          } else {
            toast('正文未变化', 'info');
          }
          c.rerender();
        } catch (err) { toast(c.errorText(err), 'error'); btn.disabled = false; }
      });
    }
    root.querySelectorAll('[data-op-filter]').forEach((btn) => {
      btn.addEventListener('click', () => { c.store.opFilter = btn.dataset.opFilter; c.rerender(); });
    });
  }

  // ---------- 设备 ----------
  function renderOled(ch) {
    return `<div class="oled">
      <div class="oled-top"><span>WS63 CONFIRM</span><span>${esc(ch.device.id)}</span></div>
      <div class="oled-summary">${esc(ch.summary)}</div>
      <div class="oled-meta">目标哈希 ${esc(short(ch.targetHash, 24))}<br>操作 ${esc((ch.operation && ch.operation.recipient) || '')} · 密级 ${esc((ch.operation && ch.operation.level) || '')}<br>剩余 <span class="countdown" id="dev-countdown">${esc(ch.remainingSec)}s</span></div>
      <div class="oled-actions">
        <button class="btn approve" data-dev-decide="approve">确认</button>
        <button class="btn cancel" data-dev-decide="cancel">取消</button>
      </div>
    </div>`;
  }

  function renderDeviceResult(res, c) {
    const messageId = res.send?.messageId;
    const user = c.store.bootstrap?.authUser;
    const canReplay = !user || ['管理员', '审计员'].includes(user.role) || user.username === res.operation?.createdBy;
    const map = {
      approved: ['ok', res.send?.state === 'sent' ? '已批准 · 已记录执行回执' : '已批准'],
      'approved-but-failed': ['error', `已批准，但执行失败：${res.message || ''}`],
      'approved-but-unknown': ['error', `已批准，但结果待核实：${res.message || ''}`],
      cancelled: ['error', `已取消 → 操作 ${res.operation ? res.operation.state : ''}`],
      expired: ['error', `已超时：nonce 已消费，操作仍 ${res.operation ? res.operation.state : ''}`],
      timeout: ['error', '设备无响应'],
      tampered: ['error', `篡改被拒：${res.code}（pending 保留，可正常批准）`],
      replay: ['error', `重放被拒：${res.code}`],
      rejected: ['error', `拒绝：${res.code} ${res.message || ''}`],
    };
    const [kind, text] = map[res.outcome] || ['error', res.message || res.code || '未知结果'];
    return `<div class="notice ${kind === 'ok' ? 'info' : 'block'}"><strong>${esc(text)}</strong>${messageId ? `<div class="sub-text mt8">回执编号：${esc(messageId)}</div>` : ''}${res.approval ? `<div class="sub-text mt8">确认编号：${esc(res.approval.confirmationId)}</div>` : ''}${res.operation?.runId && canReplay ? `<a class="btn ghost small mt8" href="${replayHref(res.operation.runId)}">查看本任务回放</a>` : ''}</div>`;
  }

  async function device(root, c) {
    clearInterval(c.store.timer);
    c.store.timer = null;
    const data = await API.get('/api/device');
    const frozen = await API.get('/api/operations?state=frozen');
    const active = data.pending[0] || null;
    const selectedId = c.store.operationId || (frozen.items[0] && frozen.items[0].operationId) || '';
    root.innerHTML = `${page('设备', '查看 WS63 连接方式和确认挑战，核对设备返回的决定与回执。')}
      ${c.store.autoMode === 'auto-full' ? '<div class="notice block">当前为全自动演示模式：高危动作已被自动批准，没有待确认挑战。切回“人在环”才能演示设备确认。</div>' : ''}
      ${c.store.autoMode === 'auto-safe' ? '<div class="notice info">低风险自动：仅白名单内部级外发自动确认；外发/删除/打印/设备仍会出现在这里。</div>' : ''}
      ${data.device ? `<div class="notice info">设备 ${esc(data.device.id)} · ${esc(data.device.label)} · 协议 ${esc(data.device.protocol)} · ${esc(data.device.transport)} · ${esc(data.device.note)}</div>` : ''}
      ${data.actuator && data.actuator.configured ? `<div class="notice info">设备联动：${esc(data.actuator.note)}——确认通过后由板端验签执行（unlock/lock → 继电器或 LED，beep/silence → 蜂鸣器）</div>` : ''}
      <section class="card">
        <div class="card-head"><h2>确认设备</h2><span class="sub">${(data.devices || []).length} 台</span></div>
        <label class="label">当前设备</label>
        <select class="select" id="dev-switch">${(data.devices || []).length
          ? (data.devices || []).map((d) => `<option value="${esc(d.label)}" ${d.label === data.selected ? 'selected' : ''}>${esc(d.label)} · ${esc(short(d.deviceId, 12))}</option>`).join('')
          : '<option value="">设备表为空（先 npm run provision）</option>'}</select>
        <div class="btn-row mt12"><button class="btn" id="dev-switch-btn" ${(data.devices || []).length ? '' : 'disabled'}>切换</button></div>
        <div class="sub-text mt8">切换会同时更换设备身份与密钥；有未决挑战时不允许切换。</div>
      </section>
      <div class="device-panel">
        <section class="card">${active ? renderOled(active) : '<div class="empty">当前没有待确认挑战。<br>选择一条冻结操作并点击“发起挑战”。</div>'}</section>
        <section class="card">
          <div class="card-head"><h2>发起确认</h2></div>
          <label class="label">冻结操作</label>
          <select class="select" id="dev-op">${frozen.items.length ? frozen.items.map((o) => `<option value="${esc(o.operationId)}" ${o.operationId === selectedId ? 'selected' : ''}>${esc(o.protocolLabel)} · ${esc(o.subject)} · ${esc(short(o.operationHash, 10))}</option>`).join('') : '<option value="">没有冻结操作</option>'}</select>
          <div class="btn-row mt12">
            <button class="btn" id="dev-challenge" ${frozen.items.length ? '' : 'disabled'}>发起挑战</button>
            <button class="btn ghost" id="dev-expire" ${active ? '' : 'disabled'}>模拟超时</button>
            <button class="btn ghost" id="dev-tamper" ${active ? '' : 'disabled'}>篡改帧</button>
            <button class="btn ghost" id="dev-replay">重放上一条决定</button>
          </div>
          <div class="sub-text mt8">挑战 TTL ${active ? esc(active.ttlSec) : 30}s；同一时间只允许一个 pending。</div>
        </section>
      </div>
      <section class="card"><div class="card-head"><h2>决定历史</h2><span class="sub">${data.history.length} 条</span></div><div class="device-history">${data.history.length ? data.history.map((h) => `<div class="history-item"><span>${esc(h.actionLabel || '')} · ${esc(short(h.summary || '', 42))}</span><span>${badge(h.outcome || h.state)} ${esc((h.result && h.result.code) || '')}</span></div>`).join('') : '<div class="empty">还没有决定</div>'}</div></section>
      <section class="card">
        <div class="card-head"><h2>屏幕共享</h2><span class="sub">真实投屏 · getDisplayMedia</span></div>
        <label class="label">共享目标</label>
        <input class="input" id="share-target" value="会议室大屏" maxlength="64">
        <div class="btn-row mt12">
          <button class="btn" id="share-start">开始共享</button>
          <button class="btn ghost" id="share-stop" disabled>停止共享</button>
        </div>
        <div class="sub-text mt8">仅在 localhost 或 HTTPS 下可用；画面留在本机，服务端只记录开始/结束、目标与分辨率，并写审计链。</div>
        <video id="share-video" class="share-video" autoplay muted playsinline hidden></video>
        <div id="share-status" class="sub-text mt8"></div>
      </section>
      <div id="device-result"></div>`;

    if (active) {
      const expires = new Date(active.expiresAt).getTime();
      const tick = () => {
        const el = root.querySelector('#dev-countdown');
        if (!el) return;
        const remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
        el.textContent = `${remaining}s`;
        if (remaining === 0) clearInterval(c.store.timer);
      };
      tick();
      c.store.timer = setInterval(tick, 1000);
    }

    const showResult = (res) => {
      root.querySelector('#device-result').innerHTML = renderDeviceResult(res, c);
    };

    root.querySelector('#dev-op')?.addEventListener('change', (ev) => { c.store.operationId = ev.currentTarget.value; });
    root.querySelector('#dev-switch-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const label = root.querySelector('#dev-switch')?.value;
      if (!label) return;
      btn.disabled = true;
      try {
        await API.post('/api/devices/select', { label });
        await device(root, c);
      } catch (err) {
        btn.disabled = false;
        const box = root.querySelector('#device-result');
        if (box) box.innerHTML = `<div class="notice block">切换失败：${esc(c.errorText(err))}</div>`;
      }
    });
    root.querySelector('#dev-challenge')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const id = root.querySelector('#dev-op').value;
        if (!id) return;
        const res = await API.post(`/api/operations/${encodeURIComponent(id)}/challenge`);
        c.store.operationId = id;
        c.store.challengeId = res.challenge.challengeId;
        toast('挑战已下发', 'ok');
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });

    root.querySelectorAll('[data-dev-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!active) return;
        btn.disabled = true;
        try {
          const res = await API.post(`/api/device/challenges/${encodeURIComponent(active.challengeId)}/decide`, { decision: btn.dataset.devDecide });
          showResult(res);
          await c.refreshState();
          toast(res.outcome === 'approved' ? '设备已批准并执行' : `设备${res.outcome}`, res.ok ? 'ok' : 'error');
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });

    root.querySelector('#dev-expire')?.addEventListener('click', async () => {
      if (!active) return;
      try {
        const res = await API.post(`/api/device/challenges/${encodeURIComponent(active.challengeId)}/expire`);
        showResult({ ...res, outcome: 'expired' });
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#dev-tamper')?.addEventListener('click', async () => {
      if (!active) return;
      try {
        const res = await API.post(`/api/device/challenges/${encodeURIComponent(active.challengeId)}/tamper`);
        showResult({ ...res, outcome: 'tampered' });
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#dev-replay')?.addEventListener('click', async () => {
      try {
        const res = await API.post('/api/device/replay', {});
        showResult({ ...res, outcome: 'replay' });
      } catch (err) { toast(c.errorText(err), 'error'); }
    });

    // —— 屏幕共享（真实投屏；离开页面/浏览器结束都会停采集并写结束审计）——
    const shareVideo = root.querySelector('#share-video');
    const shareStatus = root.querySelector('#share-status');
    const shareStartBtn = root.querySelector('#share-start');
    const shareStopBtn = root.querySelector('#share-stop');
    let shareStream = null;
    let shareSession = null;
    const setShareStatus = (text, kind = 'info') => {
      if (shareStatus) shareStatus.innerHTML = text ? `<span class="badge ${kind}">${esc(text)}</span>` : '';
    };
    const stopScreenShare = async (reason = '') => {
      if (!shareStream && !shareSession) return;
      const stream = shareStream; shareStream = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (shareVideo) { shareVideo.srcObject = null; shareVideo.hidden = true; }
      if (shareSession) {
        const id = shareSession; shareSession = null;
        try { await API.post('/api/screenshare/stop', { sessionId: id }); } catch { /* 结束审计失败不阻塞本地停止 */ }
      }
      if (shareStartBtn) shareStartBtn.disabled = false;
      if (shareStopBtn) shareStopBtn.disabled = true;
      setShareStatus(reason ? `已停止（${reason}）` : '已停止', 'info');
    };
    c.store.screenShareCleanup = () => stopScreenShare('离开页面');
    shareStartBtn?.addEventListener('click', async () => {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        setShareStatus('当前环境不支持投屏（需 localhost 或 HTTPS）', 'warn');
        return;
      }
      const target = String(root.querySelector('#share-target')?.value || '').trim();
      if (!target) { setShareStatus('请填写共享目标', 'warn'); return; }
      shareStartBtn.disabled = true;
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = stream.getVideoTracks()[0];
        const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
        const surface = settings.displaySurface || 'unknown';
        shareStream = stream;
        if (shareVideo) { shareVideo.srcObject = stream; shareVideo.hidden = false; }
        const res = await API.post('/api/screenshare/start', { target, surface });
        shareSession = res.sessionId;
        if (track) track.addEventListener('ended', () => { stopScreenShare('浏览器结束'); });
        shareStopBtn.disabled = false;
        setShareStatus(`共享中：${target} · ${surface}`, 'pass');
        toast('屏幕共享已开始（服务端已记审计）', 'ok');
      } catch (err) {
        // 启动接口失败：停掉已经拿到的画面，避免「页面说失败、系统还在采集」
        if (shareStream) { shareStream.getTracks().forEach((t) => t.stop()); shareStream = null; }
        if (shareVideo) { shareVideo.srcObject = null; shareVideo.hidden = true; }
        shareSession = null;
        shareStartBtn.disabled = false;
        if (shareStopBtn) shareStopBtn.disabled = true;
        setShareStatus(c.errorText(err), 'warn');
      }
    });
    shareStopBtn?.addEventListener('click', () => { stopScreenShare('手动停止'); });
  }

  // ---------- 治理 ----------
  async function governance(root, c) {
    const gov = await API.get('/api/governance');
    const authUser = c.store.bootstrap && c.store.bootstrap.authUser;
    const roleName = authUser ? authUser.role : null;
    const canReview = !authUser || ['管理员', '审计员'].includes(roleName);
    const canAdmin = !authUser || roleName === '管理员';
    const canReport = !authUser || ['管理员', '审计员'].includes(roleName);
    const audit = canReport ? await API.get('/api/audit?limit=50').catch(() => null) : null;
    const users = canAdmin ? await API.get('/api/users').catch(() => null) : null;
    const mailPause = roleName === '管理员' ? await API.get('/api/governance/mail-pause').catch(() => null) : null;
    const mailPaused = mailPause?.status?.paused === true;
    const risk = gov.risk;
    const policy = gov.policy || {};
    const roles = Object.keys(policy);
    const actionSet = new Set();
    for (const role of roles) for (const action of Object.keys(policy[role] || {})) actionSet.add(action);
    const actions = [...actionSet];
    root.innerHTML = `${page('治理审计', '复核风险、检查策略与审计链。租户范围按登录用户名划分。')}
      ${mailPause?.enabled ? `<section class="card"><div class="card-head"><h2>企业邮件停发</h2><span role="status">${mailPaused ? '已暂停' : '允许发送'}</span></div>
        <p>暂停仅拦截新的投递，不撤回已交给邮件服务器的邮件。恢复不会自动发送待审邮件。</p>
        ${mailPause.status ? `<p class="sub-text">最近操作：${esc(mailPause.status.actor)} · ${esc(dateTime(mailPause.status.at))} · ${esc(mailPause.status.reason)}</p>` : ''}
        <form id="gov-mail-pause" class="btn-row"><label for="gov-mail-pause-reason">操作原因</label><input class="input" id="gov-mail-pause-reason" required maxlength="500"><button class="btn ${mailPaused ? '' : 'danger'}" type="submit">${mailPaused ? '恢复发送' : '紧急停发'}</button></form>
        <p id="gov-mail-pause-result" role="status"></p></section>` : ''}
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2>风险</h2>${risk.frozen ? badge('frozen') : badge('pass')}</div>
          <div class="spread"><div class="risk-num">${esc(risk.score)}<span class="sub"> / ${esc(risk.threshold)}</span></div><div class="btn-row">${canReview ? '<button class="btn small" id="gov-clear">复核 clear</button><button class="btn ghost small" id="gov-escalate">escalate</button>' : '<span class="sub">仅审计员/管理员可复核</span>'}</div></div>
          <div class="risk-bar mt8"><span data-risk-width="${Math.min(100, Math.round((risk.score / risk.threshold) * 100))}"></span></div>
          <div class="event-list mt12">${(risk.events || []).slice().reverse().slice(0, 6).map((e) => `<div class="event warn"><div><div class="kind">+${esc(e.points)} ${esc(e.reason)}</div></div><div class="seq">${esc(e.score)}</div></div>`).join('') || '<div class="empty">无风险事件</div>'}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>双链校验</h2></div>
          ${gov.audit.restoreError ? `<div class="notice block">审计恢复失败：${esc(gov.audit.restoreError)}${gov.audit.quarantine && gov.audit.quarantine.isolated && gov.audit.quarantine.isolated.length ? `；原文件已隔离到 ${esc(gov.audit.quarantine.isolated.map((c) => c.to).join('、'))}` : ''}${gov.audit.persistBlocked ? '；已停止落盘以保护原文件' : ''}</div>` : ''}
          <div class="stack">
            <div class="spread"><span>审计链</span>${badge(gov.audit.verified ? 'pass' : 'block')}<span class="mono">${esc(gov.audit.count)} 条</span></div>
            <div class="spread"><span>事件链（SQLite）</span>${badge(gov.events.verified ? 'pass' : 'block')}<span class="mono">${esc(gov.events.count)} 条</span></div>
            ${(gov.audit.tenants || []).length ? `<div class="sub-text mt8">租户链：${gov.audit.tenants.map((t) => `${esc(t.tenant)} ${esc(t.count)} 条`).join(' · ')}</div>` : ''}
            ${gov.audit.archiveDir ? `<div class="sub-text mt8">归档目录：${esc(gov.audit.archiveDir)}${gov.audit.rotation && gov.audit.rotation.lastAt ? ` · 上次轮转 ${esc(gov.audit.rotation.lastAt)}` : ''} · 保留 ${esc(gov.audit.archiveKeep || 14)} 份</div>` : ''}
            ${gov.audit.external && gov.audit.external.configured ? `<div class="sub-text mt8">外部存储：${esc(gov.audit.external.dir)} · ${esc(gov.audit.external.snapshots || 0)} 个快照${gov.audit.external.latest ? ` · 最新 ${esc(gov.audit.external.latest.name)}（${esc(gov.audit.external.latest.files)} 个文件）` : ''}${gov.audit.external.lastVerify ? ` · 上次校验 ${gov.audit.external.lastVerify.ok ? '通过' : '失败'}` : ''}${gov.audit.external.schedule && gov.audit.external.schedule.intervalMs ? ` · 定时每 ${Math.round(gov.audit.external.schedule.intervalMs / 60000)} 分钟导出，保留 ${esc(gov.audit.external.schedule.keep)} 份` : ' · 未启用定时导出'}<br>清单只证明副本与导出时一致，不抵抗同时改写文件与清单的人；防篡改以本地独立检查点为准。</div>` : ''}
            <div class="sub-text mt8">检查点签名：${gov.audit.signing && gov.audit.signing.alg ? `${esc(gov.audit.signing.alg)}（keyId ${esc(gov.audit.signing.keyId || '-')}）· 公钥可交第三方用 \`npm run verify:audit\` 复核` : '未配置（可设 SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY_FILE）'}</div>
            <div class="btn-row">${canAdmin ? '<button class="btn small" id="gov-tamper">篡改链演示</button>' : ''}${canAdmin ? '<button class="btn ghost small" id="gov-rotate">轮转审计</button>' : ''}${canAdmin && gov.audit.external && gov.audit.external.configured ? '<button class="btn ghost small" id="gov-export">导出外部快照</button>' : ''}${canReport && gov.audit.external && gov.audit.external.configured ? '<button class="btn ghost small" id="gov-verify-export">校验外部快照</button>' : ''}${canReport ? '<button class="btn ghost small" id="gov-report">生成治理报告</button>' : ''}${canAdmin ? '<button class="btn ghost small" id="gov-reset">重置演示</button>' : ''}</div>
          </div>
          <div id="gov-tamper-result" class="mt12"></div>
          <div id="gov-export-result" class="mt12"></div>
        </section>
      </div>
      ${users ? `<section class="card"><div class="card-head"><h2>用户管理</h2><span class="sub">${users.items.length} 个</span></div>
        <div class="form-grid">
          <div><label class="label">用户名</label><input class="input" id="new-user-name" placeholder="2–32 位字母/数字/_.@-" autocomplete="off"></div>
          <div><label class="label">角色</label><select class="select" id="new-user-role">${roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
          <div><label class="label">初始密码（至少 8 位）</label><input class="input" id="new-user-pass" type="password" autocomplete="new-password"></div>
        </div>
        <div class="btn-row mt12"><button class="btn small" id="gov-create-user">新增用户</button><span class="sub">仅管理员；账号即建即用，请让本人首次登录后改密</span></div>
        <div id="gov-create-user-result" class="mt12"></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>两步验证</th><th>操作</th></tr></thead><tbody>
          ${users.items.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.disabled ? '已禁用' : '正常'}</td><td>${u.totpEnabled ? '已启用' : '未启用'}</td><td class="row-actions"><button class="btn ghost small" data-reset-user="${esc(u.username)}">重置密码</button><button class="btn ghost small" data-toggle-user="${esc(u.username)}" data-disabled="${u.disabled ? 'true' : 'false'}">${u.disabled ? '启用' : '禁用'}</button><button class="btn danger small" data-delete-user="${esc(u.username)}">删除</button></td></tr>`).join('')}
        </tbody></table></div>
      </section>` : ''}
      ${canReview ? `<section class="card"><div class="card-head"><h2>退信处理</h2><span class="sub">粘贴 .eml 原文，按 Message-ID 回填；不自动重发</span></div>
        <div class="form-grid"><div class="full"><label class="label">退信原文（DSN）</label><textarea class="textarea" id="bounce-eml" rows="6" placeholder="粘贴原始退信邮件（含 message/delivery-status 段）"></textarea></div></div>
        <div class="btn-row mt12"><input type="file" id="bounce-file" accept=".eml,message/rfc822,text/plain"><button class="btn small" id="bounce-ingest">解析并回填</button>${gov.bouncePoll && gov.bouncePoll.configured ? '<button class="btn ghost small" id="bounce-poll">立即轮询邮箱</button>' : ''}</div>
        <div class="sub-text mt8">${gov.bouncePoll && gov.bouncePoll.configured
    ? `IMAP：${esc(gov.bouncePoll.mailbox)} · ${gov.bouncePoll.polling ? '轮询中' : '未启动'}${gov.bouncePoll.lastAt ? ` · 上次 ${esc(gov.bouncePoll.lastAt)}` : ''}${gov.bouncePoll.lastError ? ` · 错误：${esc(gov.bouncePoll.lastError)}` : ''}`
    : `IMAP 未配置${gov.bouncePoll && gov.bouncePoll.error ? `（${esc(gov.bouncePoll.error)}）` : ''}——只能手动导入 .eml`}</div>
        <div id="bounce-result" class="mt12"></div>
      </section>` : ''}
      ${canReview ? `<section class="card"><div class="card-head"><h2>自动回信</h2><span class="sub">默认关闭；白名单 + 固定模板 + 去重限速；策略预授权，绕过 WS63</span></div>
        <div class="sub-text">${gov.autoReply && gov.autoReply.enabled
    ? `已启用：白名单 ${esc((gov.autoReply.config.allow || []).join('、'))} · 每小时 ${esc(gov.autoReply.config.maxPerHour)} 封 · 每发件人 ${esc(gov.autoReply.config.perSenderHours)}h 一次 · 只回 ${esc(gov.autoReply.config.maxAgeHours)}h 内邮件${gov.autoReply.polling ? ' · 轮询中' : ''}${gov.autoReply.lastAt ? ` · 上次 ${esc(gov.autoReply.lastAt)}` : ''}`
    : `未启用${gov.autoReply && gov.autoReply.error ? `（配置错误：${esc(gov.autoReply.error)}）` : '（SAFE_OFFICE_AUTOREPLY=1 + 白名单）'}`}</div>
        <div class="btn-row mt12"><button class="btn small" id="gov-auto-reply">立即扫描并回信</button></div>
        <div id="auto-reply-gov-result" class="mt12"></div>
      </section>` : ''}
      ${(gov.mailAccounts || []).length ? `<section class="card"><div class="card-head"><h2>发件账号</h2><span class="sub">${gov.mailAccounts.length} 个</span></div><div class="table-wrap"><table class="table"><thead><tr><th>账号</th><th>发件人</th><th>别名</th><th>签名</th><th>服务器</th><th>默认</th></tr></thead><tbody>${gov.mailAccounts.map((a) => `<tr><td class="mono">${esc(a.name)}</td><td>${esc(a.from)}${a.fromName ? `（${esc(a.fromName)}）` : ''}</td><td>${(a.aliases || []).length ? esc(a.aliases.map((x) => x.address).join('、')) : '—'}</td><td>${a.hasSignature ? '已配置' : '—'}</td><td class="mono">${esc(a.host)}</td><td>${a.default ? '是' : ''}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      <section class="card"><div class="card-head"><h2>策略矩阵</h2><span class="sub">未声明 = 拒绝（fail-closed）</span></div><div class="table-wrap"><table class="table"><thead><tr><th>角色</th>${actions.map((a) => `<th>${esc(a)}</th>`).join('')}</tr></thead><tbody>${roles.map((r) => `<tr><td><strong>${esc(r)}</strong></td>${actions.map((a) => `<td>${badge((policy[r] && policy[r][a]) || 'deny')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>办公能力分级</h2><span class="sub">${gov.capabilities.length} 类</span></div><div class="table-wrap"><table class="table"><thead><tr><th>能力</th><th>级别</th><th>工具</th><th>约束</th></tr></thead><tbody>${gov.capabilities.map((cap) => `<tr><td>${esc(cap.name)}</td><td>${badge(cap.level)}</td><td class="mono">${esc(cap.tools.join(', '))}</td><td>${esc(cap.constraints)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>工具注册表</h2><span class="sub">${(gov.tools || []).length} 个</span></div><div class="table-wrap"><table class="table"><thead><tr><th>工具</th><th>能力</th><th>级别</th><th>高危</th><th>转交</th><th>来源</th></tr></thead><tbody>${(gov.tools || []).map((tool) => `<tr><td class="mono">${esc(tool.name)}</td><td>${esc(tool.capability)}</td><td>${badge(tool.level)}</td><td>${tool.highRisk ? '是' : '否'}</td><td>${tool.deferred ? '是' : '否'}</td><td>${esc(tool.source)}</td></tr>`).join('')}</tbody></table></div></section>
      ${canAdmin ? `<section class="card"><div class="card-head"><h2>接入 MCP 服务</h2><span class="sub">仅管理员；注册后按角色策略生效（未声明 = 拒绝）</span></div>
        <div class="form-grid">
          <div class="full"><label class="label">服务地址</label><input class="input" id="mcp-url" value="http://127.0.0.1:7899" placeholder="http://127.0.0.1:7899"></div>
          <div><label class="label">Token（可选）</label><input class="input" id="mcp-token" type="password" autocomplete="off"></div>
          <div><label class="label">工具级别</label><select class="select" id="mcp-level"><option>L1</option><option>L2</option><option selected>L3</option><option>L4</option></select></div>
          <div class="full"><label class="label">允许角色（至少一个）</label><div class="checks" id="mcp-roles">${roles.map((r) => `<label class="check"><input type="checkbox" value="${esc(r)}" ${r === '员工' ? 'checked' : ''}> ${esc(r)}</label>`).join('')}</div></div>
        </div>
        <div class="btn-row mt12"><button class="btn small" id="mcp-discover">发现工具</button><button class="btn ghost small" id="mcp-register">注册所选</button></div>
        <div class="sub-text mt8">${(gov.mcpServers || []).length ? `已持久化 ${gov.mcpServers.length} 个服务（重启自动重连）：${esc(gov.mcpServers.map((s) => s.url).join('、'))}` : '尚未持久化 MCP 服务（注册成功后写入 data/mcp-servers.json）'}</div>
        ${gov.mcpConfigError ? `<div class="notice block mt8">MCP 配置读取失败：${esc(gov.mcpConfigError)}</div>` : ''}
        ${(gov.mcpRestore && gov.mcpRestore.failed && gov.mcpRestore.failed.length) ? `<div class="notice block mt8">上次重启有 ${gov.mcpRestore.failed.length} 个 MCP 服务恢复失败：${esc(gov.mcpRestore.failed.map((f) => `${f.url}（${f.error}）`).join('；'))}</div>` : ''}
        <div id="mcp-tools" class="mt12"></div>
        <div id="mcp-result" class="mt12"></div>
      </section>` : ''}
      <section class="card"><div class="card-head"><h2>时延</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>阶段</th><th>次数</th><th>合计</th><th>均值</th><th>峰值</th></tr></thead><tbody>${gov.perf.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc(p.count)}</td><td>${esc(Number(p.totalMs).toFixed(2))} ms</td><td>${esc(Number(p.avgMs).toFixed(3))} ms</td><td>${esc(Number(p.maxMs).toFixed(3))} ms</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>审计时间线</h2>${audit ? `<span class="sub">最近 ${audit.items.length} 条</span>` : '<span class="sub">需要审计员/管理员权限</span>'}</div>${audit ? `<div class="event-list">${audit.items.slice().reverse().map(eventItem).join('') || '<div class="empty">暂无审计</div>'}</div>` : '<div class="notice block">当前角色不可读取完整审计日志。</div>'}</section>`;

    const bar = root.querySelector('[data-risk-width]');
    if (bar) bar.style.width = `${bar.dataset.riskWidth}%`;

    const review = async (outcome) => {
      try {
        await API.post('/api/governance/review', { outcome, note: '治理页操作' });
        toast(outcome === 'clear' ? '已复核解冻' : '已升级，保持冻结', 'ok');
        await c.refreshState();
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
    };
    root.querySelector('#gov-mail-pause')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      const result = root.querySelector('#gov-mail-pause-result');
      const reason = form.querySelector('input').value.trim();
      if (!reason) {
        result.textContent = '请填写操作原因。';
        return;
      }
      if (mailPaused && !window.confirm('确认恢复企业邮件发送？待审邮件不会自动发送。')) return;
      button.disabled = true;
      try {
        await API.post('/api/governance/mail-pause', { paused: !mailPaused, reason });
        toast(mailPaused ? '已恢复发送' : '已紧急停发', 'ok');
        c.rerender();
      } catch (err) {
        result.textContent = c.errorText(err);
        button.disabled = false;
      }
    });
    root.querySelector('#gov-clear')?.addEventListener('click', () => review('clear'));
    root.querySelector('#gov-escalate')?.addEventListener('click', () => review('escalate'));
    root.querySelector('#gov-tamper')?.addEventListener('click', async () => {
      try {
        const res = await API.post('/api/governance/audit-tamper-demo', {});
        root.querySelector('#gov-tamper-result').innerHTML = `<div class="notice ${res.tampered ? 'info' : 'block'}">原链校验：${res.original ? '通过' : '断裂'}；克隆链篡改后：${res.tampered ? '通过（异常）' : '断裂（预期）'}。<div class="sub-text mt8">${esc(res.note || '')}</div></div>`;
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#gov-create-user')?.addEventListener('click', async () => {
      const username = String(root.querySelector('#new-user-name')?.value || '').trim();
      const role = String(root.querySelector('#new-user-role')?.value || '');
      const password = String(root.querySelector('#new-user-pass')?.value || '');
      if (!username || !role || !password) { toast('用户名 / 角色 / 初始密码都要填', 'error'); return; }
      const btn = root.querySelector('#gov-create-user');
      btn.disabled = true;
      try {
        const res = await API.post('/api/users', { username, role, password });
        toast(`已新增「${res.username}」（${res.role}）`, 'ok');
        await c.refreshState();
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelectorAll('[data-reset-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.resetUser;
        const password = window.prompt(`为「${username}」设置新密码（至少 8 位）`);
        if (!password) return;
        btn.disabled = true;
        try {
          await API.post(`/api/users/${encodeURIComponent(username)}/reset-password`, { newPassword: password });
          toast(`已重置「${username}」的密码；其现有会话已失效`, 'ok');
        } catch (err) {
          toast(c.errorText(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('[data-toggle-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.toggleUser;
        const disabling = btn.dataset.disabled !== 'true';
        if (disabling && !window.confirm(`禁用「${username}」？其现有会话会立即失效。`)) return;
        btn.disabled = true;
        try {
          await API.post(`/api/users/${encodeURIComponent(username)}/${disabling ? 'disable' : 'enable'}`, {});
          toast(disabling ? `已禁用「${username}」` : `已启用「${username}」`, 'ok');
          await c.refreshState();
          c.rerender();
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });
    root.querySelectorAll('[data-delete-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.deleteUser;
        if (!window.confirm(`删除「${username}」？该账号将无法登录，不可恢复。`)) return;
        btn.disabled = true;
        try {
          await API.del(`/api/users/${encodeURIComponent(username)}`);
          toast(`已删除「${username}」`, 'ok');
          await c.refreshState();
          c.rerender();
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });
    root.querySelector('#gov-rotate')?.addEventListener('click', async () => {
      if (!window.confirm('轮转会归档当前审计链并开始新链，继续？')) return;
      try {
        const res = await API.post('/api/audit/rotate', { reason: 'manual' });
        toast(res.rotated ? `已归档到 ${res.archive.audit}` : '审计为空，无需轮转', 'ok');
        await c.refreshState();
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#gov-export')?.addEventListener('click', async () => {
      try {
        const res = await API.post('/api/audit/export', { includeArchives: true });
        root.querySelector('#gov-export-result').innerHTML = `<div class="notice info">已导出 ${esc(res.files.length)} 个文件到 ${esc(res.dir)}<div class="sub-text mt8">检查点 ${esc(res.checkpoint.count)} 条 · ${esc(res.checkpoint.head.slice(0, 16))}…</div></div>`;
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#gov-verify-export')?.addEventListener('click', async () => {
      try {
        const res = await API.post('/api/audit/external/verify', {});
        root.querySelector('#gov-export-result').innerHTML = `<div class="notice ${res.ok ? 'info' : 'block'}">外部快照校验：${res.ok ? '通过' : '失败'} · 检查 ${esc(res.checked || 0)}/${esc(res.files || 0)} 个文件${(res.missing || []).length ? ` · 缺失 ${esc(res.missing.length)}` : ''}${(res.mismatches || []).length ? ` · 不一致 ${esc(res.mismatches.length)}` : ''}${res.reason ? `<div class="sub-text mt8">${esc(res.reason)}</div>` : ''}</div>`;
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#gov-report')?.addEventListener('click', () => {
      window.open('/api/report', '_blank', 'noopener');
    });
    const bounceFile = root.querySelector('#bounce-file');
    bounceFile?.addEventListener('change', async () => {
      const file = bounceFile.files && bounceFile.files[0];
      if (!file) return;
      try {
        root.querySelector('#bounce-eml').value = await file.text();
        toast(`已读入 ${file.name}`, 'info');
      } catch (err) { toast(`读取失败：${err.message}`, 'error'); }
    });
    root.querySelector('#gov-auto-reply')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await API.post('/api/mail/auto-reply/scan', {});
        const reasons = Object.entries(res.reasons || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
        root.querySelector('#auto-reply-gov-result').innerHTML = `<div class="notice ${res.errors ? 'block' : 'info'}">扫描 ${esc(res.scanned)} 封 · 已回 ${esc(res.replied)} 封 · 跳过 ${esc(res.skipped)} 封 · 失败 ${esc(res.errors)} 封${reasons ? `<div class="sub-text mt8">跳过原因：${esc(reasons)}</div>` : ''}</div>`;
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#bounce-poll')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await API.post('/api/bounce/poll', {});
        const r = res.result || {};
        root.querySelector('#bounce-result').innerHTML = `<div class="notice ${r.bounced ? 'info' : 'block'}">邮箱扫描 ${esc(r.scanned || 0)} 封 · 退信 ${esc(r.dsn || 0)} · 回填 ${esc(r.bounced || 0)} · 重复 ${esc(r.duplicate || 0)} · 未匹配 ${esc(r.unmatched || 0)} · 忽略 ${esc(r.ignored || 0)} · 错误 ${esc(r.errors || 0)}</div>`;
        toast(r.bounced ? `已回填 ${r.bounced} 条退信` : '本轮没有可回填的退信', r.bounced ? 'ok' : 'info');
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#bounce-ingest')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const eml = root.querySelector('#bounce-eml').value;
      if (!eml.trim()) { toast('先粘贴退信原文或选择 .eml 文件', 'info'); return; }
      btn.disabled = true;
      try {
        const res = await API.post('/api/bounce', { eml });
        const rows = res.results.map((r) => `<div class="event ${r.outcome === 'bounced' ? 'warn' : ''}"><div><div class="kind">${esc(r.outcome === 'bounced' ? `已回填退信：${r.recipient || '未知收件人'}` : `未回填（${r.outcome}）：${r.recipient || '未知收件人'}`)}</div><div class="sub-text">${esc([r.status, r.diagnostic, r.reason].filter(Boolean).join(' · '))}</div></div><div class="seq">${esc(r.status || '')}</div></div>`).join('');
        root.querySelector('#bounce-result').innerHTML = `<div class="notice ${res.summary.bounced ? 'info' : 'block'}">回填 ${res.summary.bounced} · 重复 ${res.summary.duplicate} · 跳过 ${res.summary.skipped} · 未匹配 ${res.summary.unmatched} · 忽略 ${res.summary.ignored}</div><div class="event-list mt8">${rows}</div>`;
        toast(res.summary.bounced ? `已回填 ${res.summary.bounced} 条退信` : '没有可回填的记录', res.summary.bounced ? 'ok' : 'info');
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    const mcpUrl = root.querySelector('#mcp-url');
    const mcpToken = () => root.querySelector('#mcp-token').value || null;
    root.querySelector('#mcp-discover')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await API.post('/api/mcp/discover', { url: mcpUrl.value, token: mcpToken() });
        root.querySelector('#mcp-tools').innerHTML = res.tools.length
          ? `<div class="stack">${res.tools.map((t) => `<label class="spread"><span class="check"><input type="checkbox" data-mcp-tool="${esc(t.name)}" checked> <span class="mono">${esc(t.name)}</span></span><span class="sub-text">${esc(t.description || '')}${t.required && t.required.length ? ` · 参数 ${esc(t.required.join(', '))}` : ''}</span></label>`).join('')}</div>`
          : '<div class="empty">服务端没有工具</div>';
        root.querySelector('#mcp-result').innerHTML = `<div class="notice info">已连接 ${esc((res.server && res.server.name) || res.url)} · 发现 ${res.tools.length} 个工具</div>`;
        toast(`发现 ${res.tools.length} 个工具`, 'ok');
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#mcp-register')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const tools = [...root.querySelectorAll('[data-mcp-tool]:checked')].map((x) => x.dataset.mcpTool);
      const roles = [...root.querySelectorAll('#mcp-roles input:checked')].map((x) => x.value);
      const level = root.querySelector('#mcp-level').value;
      if (!tools.length) { toast('先发现并勾选工具', 'info'); return; }
      if (!roles.length) { toast('至少选择一个允许角色（未声明 = 拒绝）', 'info'); return; }
      btn.disabled = true;
      try {
        const res = await API.post('/api/mcp/register', { url: mcpUrl.value, token: mcpToken(), tools, roles, level });
        const persistFailed = res.persistEnabled && res.persisted === false;
        const persistNote = persistFailed
          ? `<div class="notice block mt8">工具已注册到内存，但配置落盘失败：${esc(res.persistError || '未知错误')}——重启后需重新注册</div>`
          : '';
        root.querySelector('#mcp-result').innerHTML = `<div class="notice info">已注册 ${res.registered.length} 个：${esc(res.registered.join('、'))}<div class="sub-text mt8">级别 ${esc(level)} · 允许角色 ${esc(roles.join(' / '))} · 沙箱 local${res.persistEnabled ? '' : ' · 未启用持久化（仅内存）'}</div></div>${persistNote}`;
        toast(persistFailed ? '已注册，但配置落盘失败' : 'MCP 工具已注册', persistFailed ? 'error' : 'ok');
        await c.refreshState();
        c.rerender();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#gov-reset')?.addEventListener('click', async () => {
      if (!window.confirm('重置演示会清空审计、操作和风险，确定吗？')) return;
      try {
        await API.post('/api/reset', {});
        await c.refreshBootstrap();
        toast('演示已重置', 'ok');
        c.navigate('dashboard');
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
  }

  // ---------- 任务回放（2026-11-17） ----------
  async function replay(root, c) {
    let runs = [];
    try { runs = (await API.get('/api/commands')).items || []; } catch { runs = []; }
    const requested = routeRunId();
    const options = runs.map((r) => `<option value="${esc(r.runId)}" ${r.runId === requested ? 'selected' : ''}>${esc(r.runId)} · ${esc(String(r.command || '').slice(0, 36))}</option>`).join('');
    root.innerHTML = `
      ${page('任务回放', '按任务核对原始要求、计划、审批、实际调用与执行回执。')}
      <div class="card">
        <div class="row">
          <select id="replay-run" class="input">${options || '<option value="">暂无已完成任务</option>'}</select>
          <button class="btn" id="replay-load">载入回放</button>
          <button class="btn ghost small" id="replay-export-json">导出 JSON</button>
          <button class="btn ghost small" id="replay-export-text">导出文本</button>
        </div>
        <div id="replay-out" class="mt12"></div>
      </div>`;

    const out = root.querySelector('#replay-out');
    let loadVersion = 0;
    async function load(runId) {
      const version = ++loadVersion;
      if (!runId) {
        out.innerHTML = '<div class="empty"><strong>暂无可回放任务</strong><div class="mt8"><a class="btn ghost small" href="#/dashboard">去工作台开始任务</a></div></div>';
        return;
      }
      out.innerHTML = '<div class="sub-text">载入中…</div>';
      try {
        const r = await API.get(`/api/runs/${encodeURIComponent(runId)}/replay`);
        if (version !== loadVersion || !out.isConnected) return;
        const auditOk = Boolean(r.integrity && r.integrity.auditVerified);
        const approvals = (r.approvals || []).length
          ? `<div class="receipt-list">${r.approvals.map((record) => `<article class="receipt-item">
              <div class="spread"><strong>确认记录</strong>${badge(record.state)}</div>
              ${renderApprovalFields(record, { attachmentNames: record.attachmentNames })}
              <dl class="receipt-meta"><dt>确认编号</dt><dd>${esc(record.confirmationId || '—')}</dd>
                <dt>设备</dt><dd>${esc(record.deviceId || '—')}</dd>
                <dt>执行回执</dt><dd>${record.receipt ? `${badge(record.receipt.state)} ${esc(record.receipt.messageId || '')}` : '暂无'}</dd>
              </dl>
              <div class="sub-text mt8">操作编号 ${esc(record.operationId)}</div>
            </article>`).join('')}</div>`
          : '<div class="sub-text">没有冻结操作</div>';
        const calls = (r.calls || []).length
          ? `<ul class="list">${r.calls.map((x) => `<li>[${esc(x.n)}] ${esc(x.action)} → ${esc(String(x.outcome || '').slice(0, 100))}</li>`).join('')}</ul>`
          : '<div class="sub-text">没有执行记录</div>';
        const gates = (r.gates || []).length
          ? `<ul class="list">${r.gates.slice(0, 30).map((g) => `<li>#${esc(g.seq)} ${esc(g.kind)}：${esc(summarize(g.detail))}</li>`).join('')}</ul>`
          : '<div class="sub-text">无</div>';
        const warnings = (r.warnings || []).length
          ? `<div class="notice block mt12">${r.warnings.map((w) => esc(w)).join('<br>')}</div>`
          : '';
        out.innerHTML = `
          <div class="spread">
            <div><h3>${esc(r.runId)}</h3><div class="sub-text">${esc(r.command)}</div><div class="sub-text mt8">发起人：${esc(r.operator || '—')}</div></div>
            <div><span class="badge ${auditOk ? 'executed' : 'failed'}">审计链${auditOk ? '通过' : '未通过'}</span></div>
          </div>
          <h4 class="mt12">批准与回执</h4>${approvals}
          <details class="advanced mt12"><summary>实际调用</summary>${calls}</details>
          <details class="advanced mt12"><summary>闸与风险事件</summary>${gates}</details>
          ${warnings}`;
      } catch (err) {
        if (version === loadVersion) out.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      }
    }
    root.querySelector('#replay-load')?.addEventListener('click', () => load(root.querySelector('#replay-run').value));
    async function exportReplay(kind) {
      const runId = root.querySelector('#replay-run').value;
      if (!runId) { toast('先选择一条已完成任务', 'info'); return; }
      try {
        if (kind === 'json') {
          const data = await API.get(`/api/runs/${encodeURIComponent(runId)}/replay`);
          downloadFile(`${runId}-replay.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
        } else {
          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/replay?format=text`, { credentials: 'include' });
          if (!res.ok) throw new Error(`导出失败：HTTP ${res.status}`);
          downloadText(`${runId}-replay.txt`, await res.text());
        }
        toast('已导出回放', 'ok');
      } catch (err) { toast(c.errorText(err), 'error'); }
    }
    root.querySelector('#replay-export-json')?.addEventListener('click', () => exportReplay('json'));
    root.querySelector('#replay-export-text')?.addEventListener('click', () => exportReplay('text'));
    if (requested) {
      const select = root.querySelector('#replay-run');
      if (select.value !== requested) select.add(new Option(requested, requested, true, true));
      void load(requested);
    } else if (runs[0]) void load(runs[0].runId);
  }

  function office(root) {
    root.innerHTML = page('三维办公场景', '查看办公楼层布局，观察虚拟人物在各区域之间走动。');
    window.OfficeScene.mount(root);
  }

  window.Views = {
    dashboard, demo, command, minutes, mail, calendar, contacts, files, approvals, device, governance, replay, office,
  };
})();
