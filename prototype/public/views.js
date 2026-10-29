'use strict';
// 控制台页面（原生 JS，无框架）
//   所有动态文本必须经过 UI.esc 或 textContent；场景素材本身含注入文本。
(function () {
  const {
    esc, short, time, dateTime, badge, kindClass, summarize, toast,
    errorText, statusText,
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

  function downloadText(filename, text) {
    const safe = String(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'draft';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safe.endsWith('.txt') ? safe : `${safe}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const EXPORTABLE = new Set(['confirmed', 'executing', 'executed', 'failed']);

  // ---------- 通用 ----------
  function page(title, sub) {
    return `<div class="spread"><div><h2 class="page-title">${esc(title)}</h2><div class="sub-text">${esc(sub)}</div></div></div>`;
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

  function renderRun(run) {
    return `<section class="card">
      <div class="card-head"><h2>执行结果</h2><span class="sub">${esc(run.runId)} · ${Number(run.durationMs || 0).toFixed(1)} ms · 风险 ${run.risk.score}/${run.risk.threshold}${run.risk.frozen ? ' · 已冻结' : ''}</span></div>
      ${renderGates(run)}
      <div class="lines">${renderLines(run.lines)}</div>
      <div class="run-meta">工具：${esc((run.tools || []).join('、') || '无')} · 文档：${esc((run.documentIds || []).join('、') || '无')}${run.deniedTools && run.deniedTools.length ? ` · 裁剪工具：${esc(run.deniedTools.join('、'))}` : ''}</div>
      ${run.operations && run.operations.length ? `<div class="mt12"><div class="sub-text">本次产生 ${run.operations.length} 条冻结操作：</div><div class="stack mt8">${run.operations.map((op) => operationCard(op)).join('')}</div></div>` : ''}
    </section>`;
  }

  function confirmationLabel(op) {
    if (op.confirmationId === 'auto-full') return '<span class="badge block">全自动批准（未按键）</span>';
    if (op.confirmationId === 'auto-safe') return '<span class="badge warn">低风险自动批准</span>';
    if (op.confirmationId === 'policy-auto') return '<span class="badge info">策略自动确认</span>';
    if (op.requiresNearfield) return '<span class="badge warn">需 WS63 确认</span>';
    return '<span class="badge info">策略自动确认</span>';
  }

  function operationCard(op) {
    return `<article class="op-card" data-op-card="${esc(op.operationId)}">
      <div class="op-head"><span class="tag">${esc(op.protocolLabel)}</span><strong>${esc(op.subject)}</strong>${badge(op.state)}${op.expired ? '<span class="badge block">已过期</span>' : ''}</div>
      <div class="op-meta">目标：${esc(op.recipient)} · 密级：${esc(op.level)} · ${confirmationLabel(op)}</div>
      <div class="op-hash">operationHash ${esc(short(op.operationHash, 28))} · ${op.outbox ? `outbox ${esc(statusText[op.outbox.state] || op.outbox.state)}` : '暂无 outbox'}</div>
      <div class="op-actions">
        ${op.state === 'frozen' ? `<button class="btn small" data-op-action="challenge" data-id="${esc(op.operationId)}">发起 WS63 确认</button><button class="btn ghost small" data-op-action="reject" data-id="${esc(op.operationId)}">拒绝</button>` : ''}
        ${op.state === 'confirmed' ? `<button class="btn small" data-op-action="send" data-id="${esc(op.operationId)}">发送/执行</button>` : ''}
        ${op.outbox && op.outbox.state === 'unknown' ? `<button class="btn small" data-op-action="reconcile" data-outbox="${esc(op.outbox.outboxId)}">人工核对为已发送</button>` : ''}
        ${EXPORTABLE.has(op.state) ? `<button class="btn ghost small" data-op-action="copy" data-id="${esc(op.operationId)}">复制正文</button><button class="btn ghost small" data-op-action="download" data-id="${esc(op.operationId)}">下载 .txt</button>` : ''}
        <button class="btn ghost small" data-op-action="verify" data-id="${esc(op.operationId)}">只读篡改校验</button>
        <button class="btn ghost small" data-op-action="detail" data-id="${esc(op.operationId)}">详情</button>
      </div>
    </article>`;
  }

  function bindOpActions(root, c) {
    root.querySelectorAll('[data-op-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.opAction;
        const id = btn.dataset.id;
        const outboxId = btn.dataset.outbox;
        btn.disabled = true;
        try {
          if (action === 'challenge') {
            const res = await API.post(`/api/operations/${encodeURIComponent(id)}/challenge`);
            c.store.operationId = id;
            c.store.challengeId = res.challenge.challengeId;
            toast('挑战已下发，请在设备页确认', 'ok');
            c.navigate('device');
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
            await API.post(`/api/outbox/${encodeURIComponent(outboxId)}/reconcile`, { state: 'sent', messageId: `manual-${Date.now()}` });
            toast('已人工核对为已发送', 'ok');
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

  function showDocDetail(container, c, id) {
    API.get(`/api/documents/${encodeURIComponent(id)}`).then((res) => {
      const d = res.document;
      if (!d) { container.innerHTML = ''; return; }
      if (!d.body) {
        container.innerHTML = `<section class="card"><div class="card-head"><h2>${esc(d.title)}</h2>${badge(d.level)}</div><div class="notice info">${esc(d.note || '正文尚未进入授权知识库。')}</div></section>`;
        return;
      }
      container.innerHTML = `<section class="card">
        <div class="card-head"><h2>${esc(d.title)}</h2><span>${badge(d.level)} ${d.tainted ? '<span class="badge block">检出注入</span>' : ''}</span></div>
        <pre class="lines">${esc(d.body)}</pre>
        <div class="sub-text mt8">来源：${esc((d.sourceIds || []).join('、') || d.id)} · 状态：${esc(d.status)}</div>
      </section>`;
    }).catch((err) => {
      container.innerHTML = `<div class="notice block">${esc(c.errorText(err))}</div>`;
    });
  }

  // ---------- 工作台 ----------
  async function dashboard(root, c) {
    const state = c.store.state || await c.refreshState();
    const counts = state.counts || {};
    const risk = state.risk || {};
    const events = (state.audit && state.audit.recent) || [];
    const samples = c.store.bootstrap.samples || [];
    const pick = ['normal-minutes', 'external-confirm', 'injection', 'private-mailbox', 'bulk-delete', 'device'];
    root.innerHTML = `
      ${risk.frozen ? `<div class="notice block"><strong>风险已冻结</strong>：风险分 ${esc(risk.score)} ≥ 阈值 ${esc(risk.threshold)}，高危动作会在转交前被拦截。<button class="btn ghost small" id="dash-review">人工复核 clear</button></div>` : ''}
      <div class="stats">
        ${stat('文档 / 图片 / 录音', (counts.documents || 0) + (counts.images || 0) + (counts.audios || 0), '演示数据')}
        ${stat('待确认操作', counts.pendingOperations || 0, '冻结记录')}
        ${stat('风险分', `${risk.score || 0} / ${risk.threshold || 60}`, risk.frozen ? '已冻结' : '正常')}
        ${stat('审计条目', counts.audit || 0, state.audit && state.audit.verified ? '链校验通过' : '链校验异常')}
      </div>
      <div class="two-col">
        <section class="card">
          <div class="card-head"><h2>演示剧本</h2><span class="sub">先正常流，再攻击样例</span></div>
          <div class="stack">
            <a class="sample" href="#/minutes"><strong>1 · 整理会议纪要</strong><small>读取 → 摘要 → 正式稿</small></a>
            <a class="sample" href="#/mail"><strong>2 · 内网发送</strong><small>策略自动确认 → FakeMailer</small></a>
            <a class="sample" href="#/approvals"><strong>3 · 外发确认</strong><small>冻结操作 → WS63 虚拟设备 → 发送</small></a>
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
  }

  // ---------- 命令台 ----------
  async function command(root, c) {
    const b = c.store.bootstrap;
    const sample = c.store.pendingSample || null;
    c.store.pendingSample = null;
    const tools = sample ? (sample.tools || []) : ['readDoc', 'summarize', 'sendInternalEmail'];
    const docs = sample ? (sample.documentIds || []) : ['M2'];
    const domains = ((sample && sample.domains) || []).join(',');
    const text = (sample && sample.command) || '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal';
    const sandbox = (sample && sample.sandboxPreset) || 'default';
    const maxCalls = sample && sample.maxCalls ? String(sample.maxCalls) : '';
    if (sample && sample.nearfieldOnline !== undefined) c.setNearfield(!!sample.nearfieldOnline);

    root.innerHTML = `${page('命令台', '自由指令 + 角色/工具/文档/沙箱；查看五道闸与冻结操作')}
      <section class="card">
        <div class="card-head"><h2>指令</h2><span class="sub">角色 / 模型 / 近场取顶栏</span></div>
        <div class="form-grid">
          <div class="full"><label class="label">指令</label><textarea class="textarea" id="cmd-text">${esc(text)}</textarea></div>
          <div class="full"><label class="label">允许工具</label><div class="checks" id="cmd-tools">${b.tools.map((t) => `<label class="check"><input type="checkbox" value="${esc(t.name)}" ${tools.includes(t.name) ? 'checked' : ''}> ${esc(t.name)} <span class="muted">${esc(t.level)}</span></label>`).join('')}</div></div>
          <div class="full"><label class="label">授权文档</label><div class="checks" id="cmd-docs">${b.documents.map((d) => `<label class="check"><input type="checkbox" value="${esc(d.id)}" ${docs.includes(d.id) ? 'checked' : ''}> ${esc(d.id)} ${esc(d.title)} <span class="muted">${esc(d.level)}</span></label>`).join('')}</div></div>
          <div><label class="label">外部域名（逗号分隔）</label><input class="input" id="cmd-domains" value="${esc(domains)}" placeholder="partner-example.com"></div>
          <div><label class="label">调用上限（空=不限）</label><input class="input" id="cmd-max" type="number" min="1" value="${esc(maxCalls)}"></div>
          <div><label class="label">沙箱</label><select class="select" id="cmd-sandbox"><option value="default" ${sandbox === 'default' ? 'selected' : ''}>默认沙箱（物理通道关闭）</option><option value="physical" ${sandbox === 'physical' ? 'selected' : ''}>开放物理通道</option></select></div>
          <div><label class="label">说明</label><div class="sub-text">外发/删除/打印/设备会转交冻结操作；内网邮件由策略自动确认。</div></div>
        </div>
        <div class="btn-row mt12"><button class="btn" id="cmd-run">执行</button><button class="btn ghost" id="cmd-clear">清空</button></div>
        <div class="hr"></div>
        <div class="sub-text mb8">样例（点击填入表单）：</div>
        <div class="sample-grid">${b.samples.map((s) => `<button class="sample" data-cmd-sample="${esc(s.id)}"><strong>${esc(s.name)}</strong><small>${esc(s.expect)}</small></button>`).join('')}</div>
      </section>
      <div id="cmd-result"></div>`;

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

    root.querySelector('#cmd-run').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const run = await c.runCommand(collect());
        const target = root.querySelector('#cmd-result');
        target.innerHTML = renderRun(run);
        bindOpActions(root, c);
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#cmd-clear').addEventListener('click', () => {
      root.querySelector('#cmd-text').value = '';
      root.querySelectorAll('#cmd-tools input').forEach((x) => { x.checked = false; });
      root.querySelectorAll('#cmd-docs input').forEach((x) => { x.checked = false; });
      root.querySelector('#cmd-result').innerHTML = '';
    });
    root.querySelectorAll('[data-cmd-sample]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = b.samples.find((x) => x.id === btn.dataset.cmdSample);
        if (!s) return;
        c.store.pendingSample = s;
        if (s.nearfieldOnline !== undefined) c.setNearfield(!!s.nearfieldOnline);
        c.rerender();
      });
    });
  }

  // ---------- 纪要中心 ----------
  async function minutes(root, c) {
    const docs = (await API.get('/api/documents')).items;
    const base = docs.filter((d) => d.type === 'document');
    const generated = docs.filter((d) => d.type === 'draft');
    root.innerHTML = `${page('纪要中心', '读取 → 摘要 → 正式稿；正文只在授权读取后显示')}
      <div class="grid-3">${base.map((d) => `<section class="card">
        <div class="spread"><h3>${esc(d.title)}</h3>${badge(d.level)}</div>
        <div class="sub-text">${esc(d.id)} · ${esc(d.status)}</div>
        <div class="btn-row mt12"><button class="btn small" data-minutes="${esc(d.id)}">整理纪要</button><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button></div>
      </section>`).join('')}</div>
      ${generated.length ? `<section class="card"><div class="card-head"><h2>生成稿</h2><span class="sub">${generated.length} 份</span></div><div class="stack">${generated.map((d) => `<div class="spread"><span>${esc(d.title)} ${badge(d.level)} ${d.tainted ? '<span class="badge block">注入</span>' : ''}</span><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button></div>`).join('')}</div></section>` : ''}
      <div id="minutes-detail"></div>
      <div id="minutes-result"></div>`;

    const detail = root.querySelector('#minutes-detail');
    root.querySelectorAll('[data-doc]').forEach((btn) => btn.addEventListener('click', () => showDocDetail(detail, c, btn.dataset.doc)));
    root.querySelectorAll('[data-minutes]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.minutes;
        btn.disabled = true;
        try {
          const payload = id === 'M2'
            ? {
              command: '把周例会纪要整理一下，发到部门内网邮箱 team@corp.internal',
              tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M2'],
            }
            : {
              command: '把昨天的预算评审会纪要整理成正式版，发给 team@corp.internal',
              tools: ['readDoc', 'summarize', 'sendInternalEmail'], documentIds: ['M1', 'M2', 'M3'],
            };
          const run = await c.runCommand({ ...payload, role: c.store.role, nearfieldOnline: c.store.nearfieldOnline });
          root.querySelector('#minutes-result').innerHTML = renderRun(run);
          bindOpActions(root, c);
          await c.refreshState();
        } catch (err) { toast(c.errorText(err), 'error'); }
        finally { btn.disabled = false; }
      });
    });
  }

  // ---------- 邮件 ----------
  async function mail(root, c) {
    const emails = await API.get('/api/emails');
    root.innerHTML = `${page('邮件', '内网邮件策略自动确认；外发需 WS63 虚拟确认')}
      <section class="card">
        <div class="card-head"><h2>写邮件</h2><span class="sub">MockLLM 计划固定演示收件人</span></div>
        <div class="form-grid">
          <div><label class="label">文档</label><select class="select" id="mail-doc"><option value="M2">周例会纪要（草稿）</option><option value="M1">预算评审会纪要（终稿）</option></select></div>
          <div><label class="label">通道</label><select class="select" id="mail-mode"><option value="external">外发（需 WS63）</option><option value="internal">内网（自动确认）</option></select></div>
          <div class="full"><label class="label">收件人</label><input class="input" id="mail-to" value="partner@partner-example.com" readonly></div>
        </div>
        <div class="btn-row mt12"><button class="btn" id="mail-run">生成并发起</button></div>
        <div class="sub-text mt8" id="mail-hint">外发：partner@partner-example.com；内网：team@corp.internal。正文由 Agent 读取文档生成。</div>
      </section>
      <section class="card"><div class="card-head"><h2>邮件记录</h2><span class="sub">${emails.items.length} 条</span></div><div class="stack">${emails.items.length ? emails.items.map(operationCard).join('') : '<div class="empty">还没有邮件记录</div>'}</div></section>
      <div id="mail-result"></div>`;

    const mode = root.querySelector('#mail-mode');
    const to = root.querySelector('#mail-to');
    mode.addEventListener('change', () => {
      const internal = mode.value === 'internal';
      to.value = internal ? 'team@corp.internal' : 'partner@partner-example.com';
      root.querySelector('#mail-hint').textContent = internal
        ? '内网：team@corp.internal；策略自动确认，不弹设备。'
        : '外发：partner@partner-example.com；冻结后需 WS63 确认。';
    });
    bindOpActions(root, c);
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
        const run = await c.runCommand({ ...payload, role: c.store.role, nearfieldOnline: c.store.nearfieldOnline });
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
    root.innerHTML = `${page('日历', '预约动作由 Agent 执行；Mock 计划为固定演示数据')}
      <section class="card">
        <div class="card-head"><h2>日程</h2><span class="sub">${items.length} 条</span></div>
        <div class="stack">${items.map((e) => `<div class="spread"><div><strong>${esc(e.title)}</strong><div class="sub-text">${esc(e.at)} · ${e.source === 'seed' ? '种子数据' : 'Agent 预约'}</div></div><span class="badge info">${esc(e.source)}</span></div>`).join('')}</div>
        <div class="btn-row mt12"><button class="btn" id="cal-run">预约项目对齐会</button><button class="btn ghost" id="cal-refresh">刷新日程</button></div>
        <div class="sub-text mt8">注意：MockLLM 的预约计划固定为“项目对齐会 / 2026-10-20 14:00”，用于演示。</div>
      </section>
      <div id="cal-result"></div>`;
    root.querySelector('#cal-refresh').addEventListener('click', () => c.rerender());
    root.querySelector('#cal-run').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const run = await c.runCommand({
          command: '预约下周一的项目对齐会', role: c.store.role,
          tools: ['scheduleMeeting'], documentIds: [], nearfieldOnline: c.store.nearfieldOnline,
        });
        root.querySelector('#cal-result').innerHTML = renderRun(run);
        bindOpActions(root, c);
        await c.refreshState();
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
  }

  // ---------- 通讯录 ----------
  async function contacts(root, c) {
    const items = (await API.get('/api/contacts')).items;
    root.innerHTML = `${page('通讯录', '仅单条查询；结果默认脱敏；批量/导出不提供')}
      <div class="grid-2">${items.map((p) => `<section class="card">
        <div class="spread"><h3>${esc(p.name)}</h3><span class="badge info">${esc(p.title)}</span></div>
        <div class="sub-text">手机：${esc(p.phone)}</div>
        <div class="sub-text">邮箱：${esc(p.email)}</div>
        <div class="btn-row mt12"><button class="btn small" data-contact="${esc(p.name)}">单条查询</button></div>
      </section>`).join('')}</div>
      <div class="notice info">查询会走完整命令链路并写入审计；批量导出工具不存在，计划校验会移除。</div>
      <div id="contacts-result"></div>`;
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
  async function files(root, c) {
    const docs = (await API.get('/api/documents')).items;
    root.innerHTML = `${page('文件', '文档/图片/录音/生成稿；删除需令牌上限 + 快照 + WS63 确认')}
      <section class="card">
        <div class="card-head"><h2>文件列表</h2><span class="sub">${docs.length} 项</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>类型</th><th>标题</th><th>密级</th><th>状态</th><th>操作</th></tr></thead><tbody>
          ${docs.map((d) => `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.type)}</td><td>${esc(d.title)}</td><td>${badge(d.level)}</td><td>${esc(d.status)}</td><td><button class="btn ghost small" data-doc="${esc(d.id)}">查看</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="btn-row mt12"><button class="btn danger small" id="files-delete">删除周例会纪要（M2）</button><button class="btn ghost small" id="files-rollback">回滚最近快照</button></div>
        <div class="sub-text mt8">MockLLM 的单删计划固定为 M2；批量删除样例在命令台。删除确认后由假执行器标记 deleted。</div>
      </section>
      <div id="files-detail"></div><div id="files-result"></div>`;
    const detail = root.querySelector('#files-detail');
    root.querySelectorAll('[data-doc]').forEach((btn) => btn.addEventListener('click', () => showDocDetail(detail, c, btn.dataset.doc)));
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
  function renderOperationDetail(detail) {
    const op = detail.operation;
    const meta = detail.meta || {};
    return `<section class="card">
      <div class="card-head"><h2>操作详情</h2><span class="sub mono">${esc(op.operationId)}</span></div>
      <div class="grid-2">
        <div>
          <div class="sub-text">动作：${esc(op.protocolLabel)} / ${esc(op.action)}</div>
          <div class="sub-text">目标：${esc(op.recipient)}</div>
          <div class="sub-text">密级：${esc(op.level)}</div>
          <div class="sub-text">状态：${badge(op.state)}</div>
          <div class="sub-text">确认：${confirmationLabel(op)}</div>
        </div>
        <div>
          <div class="sub-text">operationHash</div><div class="mono">${esc(op.operationHash)}</div>
          <div class="sub-text mt8">校验：${op.verify.ok ? '通过' : `失败：${esc(op.verify.reason)}`}</div>
          <div class="sub-text mt8">确认：${esc(op.confirmationId || '—')} · 设备：${esc(op.deviceId || '—')}</div>
        </div>
      </div>
      <div class="mt12"><div class="sub-text">正文预览</div><pre class="lines">${esc(op.body || '（空）')}</pre></div>
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
    if (c.store.operationId) {
      try {
        const detail = await API.get(`/api/operations/${encodeURIComponent(c.store.operationId)}`);
        detailHtml = renderOperationDetail(detail);
      } catch (err) {
        detailHtml = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      }
    }
    root.innerHTML = `${page('审批与确认', '冻结记录 → WS63 确认 → 发送/执行；取消/超时/重放/篡改')}
      <section class="card">
        <div class="spread">
          <div class="tabs">${['', 'frozen', 'confirmed', 'executing', 'executed', 'rejected', 'failed'].map((s) => `<button class="tab ${filter === s ? 'active' : ''}" data-op-filter="${esc(s)}">${s ? esc(statusText[s] || s) : '全部'}${counts[s] ? ` (${counts[s]})` : ''}</button>`).join('')}</div>
          <span class="sub">${ops.items.length} 条</span>
        </div>
        <div class="stack mt12">${ops.items.length ? ops.items.map(operationCard).join('') : '<div class="empty">当前筛选下没有操作</div>'}</div>
      </section>
      ${detailHtml}
      <div id="approvals-result"></div>`;
    bindOpActions(root, c);
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

  function renderDeviceResult(res) {
    const map = {
      approved: ['ok', `已批准 → 操作 ${res.operation ? res.operation.state : ''} → 发送 ${res.send ? res.send.state : ''}`],
      cancelled: ['error', `已取消 → 操作 ${res.operation ? res.operation.state : ''}`],
      expired: ['error', `已超时：nonce 已消费，操作仍 ${res.operation ? res.operation.state : ''}`],
      timeout: ['error', '设备无响应'],
      tampered: ['error', `篡改被拒：${res.code}（pending 保留，可正常批准）`],
      replay: ['error', `重放被拒：${res.code}`],
      rejected: ['error', `拒绝：${res.code} ${res.message || ''}`],
    };
    const [kind, text] = map[res.outcome] || ['error', res.message || res.code || '未知结果'];
    return `<div class="notice ${kind === 'ok' ? 'info' : 'block'}"><strong>${esc(text)}</strong>${res.approval ? `<div class="sub-text mt8">confirmationId：${esc(res.approval.confirmationId)}</div>` : ''}</div>`;
  }

  async function device(root, c) {
    clearInterval(c.store.timer);
    c.store.timer = null;
    const data = await API.get('/api/device');
    const frozen = await API.get('/api/operations?state=frozen');
    const active = data.pending[0] || null;
    const selectedId = c.store.operationId || (frozen.items[0] && frozen.items[0].operationId) || '';
    root.innerHTML = `${page('设备', 'WS63 虚拟确认器：真实 SFC1 帧 / HMAC；批准/取消/超时/篡改/重放')}
      ${c.store.autoMode === 'auto-full' ? '<div class="notice block">当前为全自动演示模式：高危动作已被自动批准，没有待确认挑战。切回“人在环”才能演示设备确认。</div>' : ''}
      ${c.store.autoMode === 'auto-safe' ? '<div class="notice info">低风险自动：仅白名单内部级外发自动确认；外发/删除/打印/设备仍会出现在这里。</div>' : ''}
      ${data.device ? `<div class="notice info">设备 ${esc(data.device.id)} · ${esc(data.device.label)} · 协议 ${esc(data.device.protocol)} · ${esc(data.device.transport)} · ${esc(data.device.note)}</div>` : ''}
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
      root.querySelector('#device-result').innerHTML = renderDeviceResult(res);
    };

    root.querySelector('#dev-op')?.addEventListener('change', (ev) => { c.store.operationId = ev.currentTarget.value; });
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
  }

  // ---------- 治理 ----------
  async function governance(root, c) {
    const gov = await API.get('/api/governance');
    const audit = await API.get('/api/audit?limit=50');
    const risk = gov.risk;
    const policy = gov.policy || {};
    const roles = Object.keys(policy);
    const actionSet = new Set();
    for (const role of roles) for (const action of Object.keys(policy[role] || {})) actionSet.add(action);
    const actions = [...actionSet];
    root.innerHTML = `${page('治理审计', '风险复核 / 双链校验 / 策略矩阵 / 能力表 / 报告')}
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2>风险</h2>${risk.frozen ? badge('frozen') : badge('pass')}</div>
          <div class="spread"><div class="risk-num">${esc(risk.score)}<span class="sub"> / ${esc(risk.threshold)}</span></div><div class="btn-row"><button class="btn small" id="gov-clear">复核 clear</button><button class="btn ghost small" id="gov-escalate">escalate</button></div></div>
          <div class="risk-bar mt8"><span data-risk-width="${Math.min(100, Math.round((risk.score / risk.threshold) * 100))}"></span></div>
          <div class="event-list mt12">${(risk.events || []).slice().reverse().slice(0, 6).map((e) => `<div class="event warn"><div><div class="kind">+${esc(e.points)} ${esc(e.reason)}</div></div><div class="seq">${esc(e.score)}</div></div>`).join('') || '<div class="empty">无风险事件</div>'}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>双链校验</h2></div>
          <div class="stack">
            <div class="spread"><span>审计链</span>${badge(gov.audit.verified ? 'pass' : 'block')}<span class="mono">${esc(gov.audit.count)} 条</span></div>
            <div class="spread"><span>事件链（SQLite）</span>${badge(gov.events.verified ? 'pass' : 'block')}<span class="mono">${esc(gov.events.count)} 条</span></div>
            <div class="btn-row"><button class="btn small" id="gov-tamper">篡改链演示</button><button class="btn ghost small" id="gov-report">生成治理报告</button><button class="btn ghost small" id="gov-reset">重置演示</button></div>
          </div>
          <div id="gov-tamper-result" class="mt12"></div>
        </section>
      </div>
      <section class="card"><div class="card-head"><h2>策略矩阵</h2><span class="sub">未声明 = 拒绝（fail-closed）</span></div><div class="table-wrap"><table class="table"><thead><tr><th>角色</th>${actions.map((a) => `<th>${esc(a)}</th>`).join('')}</tr></thead><tbody>${roles.map((r) => `<tr><td><strong>${esc(r)}</strong></td>${actions.map((a) => `<td>${badge((policy[r] && policy[r][a]) || 'deny')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>办公能力分级</h2><span class="sub">${gov.capabilities.length} 类</span></div><div class="table-wrap"><table class="table"><thead><tr><th>能力</th><th>级别</th><th>工具</th><th>约束</th></tr></thead><tbody>${gov.capabilities.map((cap) => `<tr><td>${esc(cap.name)}</td><td>${badge(cap.level)}</td><td class="mono">${esc(cap.tools.join(', '))}</td><td>${esc(cap.constraints)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>工具注册表</h2><span class="sub">${(gov.tools || []).length} 个</span></div><div class="table-wrap"><table class="table"><thead><tr><th>工具</th><th>能力</th><th>级别</th><th>高危</th><th>转交</th><th>来源</th></tr></thead><tbody>${(gov.tools || []).map((tool) => `<tr><td class="mono">${esc(tool.name)}</td><td>${esc(tool.capability)}</td><td>${badge(tool.level)}</td><td>${tool.highRisk ? '是' : '否'}</td><td>${tool.deferred ? '是' : '否'}</td><td>${esc(tool.source)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>时延</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>阶段</th><th>次数</th><th>合计</th><th>均值</th><th>峰值</th></tr></thead><tbody>${gov.perf.map((p) => `<tr><td>${esc(p.label)}</td><td>${esc(p.count)}</td><td>${esc(Number(p.totalMs).toFixed(2))} ms</td><td>${esc(Number(p.avgMs).toFixed(3))} ms</td><td>${esc(Number(p.maxMs).toFixed(3))} ms</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><div class="card-head"><h2>审计时间线</h2><span class="sub">最近 ${audit.items.length} 条</span></div><div class="event-list">${audit.items.slice().reverse().map(eventItem).join('') || '<div class="empty">暂无审计</div>'}</div></section>`;

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
    root.querySelector('#gov-clear').addEventListener('click', () => review('clear'));
    root.querySelector('#gov-escalate').addEventListener('click', () => review('escalate'));
    root.querySelector('#gov-tamper').addEventListener('click', async () => {
      try {
        const res = await API.post('/api/governance/audit-tamper-demo', {});
        root.querySelector('#gov-tamper-result').innerHTML = `<div class="notice ${res.tampered ? 'info' : 'block'}">原链校验：${res.original ? '通过' : '断裂'}；克隆链篡改后：${res.tampered ? '通过（异常）' : '断裂（预期）'}。<div class="sub-text mt8">${esc(res.note || '')}</div></div>`;
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
    root.querySelector('#gov-report').addEventListener('click', () => {
      window.open('/api/report', '_blank', 'noopener');
    });
    root.querySelector('#gov-reset').addEventListener('click', async () => {
      if (!window.confirm('重置演示会清空审计、操作和风险，确定吗？')) return;
      try {
        await API.post('/api/reset', {});
        await c.refreshBootstrap();
        toast('演示已重置', 'ok');
        c.navigate('dashboard');
      } catch (err) { toast(c.errorText(err), 'error'); }
    });
  }

  window.Views = {
    dashboard, command, minutes, mail, calendar, contacts, files, approvals, device, governance,
  };
})();
