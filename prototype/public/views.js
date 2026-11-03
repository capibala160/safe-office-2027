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
    if (op.confirmationId === 'policy-auto-reply') return '<span class="badge info">自动回信策略（绕过 WS63）</span>';
    if (op.requiresNearfield) {
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
        ${stat('审计条目', counts.audit || 0, state.audit && !state.audit.verified ? '链校验异常' : (state.audit && state.audit.persisted === false ? '链有效 · 落盘失败' : '链校验通过'))}
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
          <div class="full"><label class="label">附件（最多 5 个，单个 ≤5MB；随外发邮件一起冻结）</label><input type="file" id="cmd-files" multiple /></div>
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

    // —— 任务进度：排队 → 规划 → 执行 i/n → 待确认/完成 ——
    const stageText = (snap) => {
      const last = (snap.stageLog || []).slice(-1)[0] || {};
      if (snap.stage === '执行' && last.step) return `执行 ${last.step}/${last.total}`;
      return snap.stage;
    };
    const progressHtml = (snap) => `<section class="card">
      <div class="card-head"><h2>任务 ${esc(snap.runId)}</h2><span class="sub" id="run-stage">${esc(stageText(snap))}</span></div>
      <div class="sub-text" id="run-log">${esc((snap.stageLog || []).map((s) => (s.step ? `${s.stage} ${s.step}/${s.total}` : s.stage)).join(' → '))}</div>
      <div class="btn-row mt8"><button class="btn ghost small" id="run-cancel">取消任务</button></div>
      <div class="sub-text mt8">离开本页任务不受影响；回来会接着显示进度。</div>
    </section>`;
    const finish = async (snap) => {
      const target = root.querySelector('#cmd-result');
      if (snap.status === 'error') {
        target.innerHTML = `<div class="notice block">任务失败：${esc(snap.error || '未知错误')}</div>`;
        return;
      }
      if (snap.result) {
        target.innerHTML = renderRun(snap.result);
        bindOpActions(root, c);
      }
      if (snap.cancelRequested) toast('已取消：已执行的步骤保留记录，后续步骤未执行', 'info');
      try { await c.refreshState(); } catch { /* best effort */ }
    };
    const watch = async (runId) => {
      const target = root.querySelector('#cmd-result');
      target.innerHTML = progressHtml({ runId, stage: '排队', stageLog: [] });
      const snap = await c.pollRun(runId, (s) => {
        const st = root.querySelector('#run-stage');
        const lg = root.querySelector('#run-log');
        if (st) st.textContent = stageText(s);
        if (lg) lg.textContent = (s.stageLog || []).map((x) => (x.step ? `${x.stage} ${x.step}/${x.total}` : x.stage)).join(' → ');
        const cancelBtn = root.querySelector('#run-cancel');
        if (cancelBtn) cancelBtn.disabled = s.status !== 'running' || s.cancelRequested;
      });
      await finish(snap);
    };
    root.querySelector('#cmd-run').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
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
        if (attachments.length) payload.attachments = attachments;
        const started = await c.startRun(payload);
        await watch(started.runId);
      } catch (err) { toast(c.errorText(err), 'error'); }
      finally { btn.disabled = false; }
    });
    root.querySelector('#cmd-result').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('#run-cancel');
      if (!btn) return;
      btn.disabled = true;
      try {
        await c.cancelRun(c.store.activeRunId);
        toast('已请求取消：当前步骤结束后停止，已执行步骤保留记录', 'info');
      } catch (err) { toast(c.errorText(err), 'error'); btn.disabled = false; }
    });
    // 回到本页时恢复未跑完的任务
    let resumeId = c.store.activeRunId;
    if (!resumeId) { try { resumeId = localStorage.getItem('safe-office.activeRun'); } catch { resumeId = null; } }
    if (resumeId) {
      try {
        const snap = await API.get(`/api/commands/${encodeURIComponent(resumeId)}`).catch(() => null);
        if (snap && snap.status === 'running') { c.store.activeRunId = resumeId; await watch(resumeId); }
        else if (snap) await finish(snap);
      } catch (err) {
        toast(`恢复任务失败：${c.errorText(err)}`, 'error');
      }
    }
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
    const accounts = (c.store.bootstrap && c.store.bootstrap.mailAccounts) || [];
    const autoReply = (c.store.bootstrap && c.store.bootstrap.autoReply) || { enabled: false };
    const authUser = c.store.bootstrap && c.store.bootstrap.authUser;
    const canScanAutoReply = !authUser || ['管理员', '审计员'].includes(authUser.role);
    root.innerHTML = `${page('邮件', '内网邮件策略自动确认；外发需 WS63 虚拟确认')}
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
    root.innerHTML = `${page('日历', '预约动作由 Agent 执行；Mock 计划为固定演示数据')}
      <section class="card">
        <div class="card-head"><h2>日程</h2><span class="sub">${items.length} 条</span></div>
        <div class="stack">${items.map((e) => `<div class="spread"><div><strong>${esc(e.title)}</strong><div class="sub-text">${esc(e.at)} · ${e.source === 'seed' ? '种子数据' : (e.real ? `Agent 预约 · .ics 已落盘` : 'Agent 预约 · 模拟')}${e.file ? ` · ${esc(e.file)}` : ''}</div></div><span class="badge ${e.real ? 'pass' : 'info'}">${esc(e.source === 'seed' ? e.source : (e.real ? '已落盘' : '模拟'))}</span></div>`).join('')}</div>
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
    root.innerHTML = `${page('文件', '文档/图片/录音/生成稿；删除需令牌上限 + 快照 + WS63 确认')}
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
  function renderOperationDetail(detail, revisions = null) {
    const op = detail.operation;
    const versionBlock = revisions && revisions.revisions && revisions.revisions.length
      ? `<div class="mt12"><div class="sub-text">版本历史（当前 v${esc(revisions.current.revision)}）</div>
          ${revisions.revisions.slice().reverse().map((r) => `<details class="rev"><summary>v${esc(r.revision)} · ${esc(dateTime(r.createdAt))} · ${esc(r.editor)} · ${esc(short(r.operationHash, 10))}</summary>${renderDiff(r.body, revisions.current.body)}</details>`).join('')}
        </div>`
      : '';
    const bodyBlock = op.state === 'frozen'
      ? `<div class="mt12"><div class="sub-text">编辑正文：保存后重新计算 bodyHash / operationHash，旧挑战与确认作废，需要重新确认</div>
          <textarea class="textarea" id="op-body-edit" rows="10">${esc(op.body || '')}</textarea>
          <div class="btn-row mt8"><button class="btn" id="op-body-save">保存并重新冻结</button><button class="btn ghost" id="op-body-reset">还原</button></div>
        </div>`
      : `<div class="mt12"><div class="sub-text">正文预览</div><pre class="lines">${esc(op.body || '（空）')}</pre></div>`;
    return `<section class="card">
      <div class="card-head"><h2>操作详情</h2><span class="sub mono">${esc(op.operationId)}</span></div>
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
    if (c.store.operationId) {
      try {
        const id = encodeURIComponent(c.store.operationId);
        const [detail, revisions] = await Promise.all([
          API.get(`/api/operations/${id}`),
          API.get(`/api/operations/${id}/revisions`).catch(() => null),
        ]);
        detailHtml = renderOperationDetail(detail, revisions);
      } catch (err) {
        detailHtml = `<div class="notice block">${esc(c.errorText(err))}</div>`;
      }
    }
    const virtualConfirm = !(c.store.bootstrap && c.store.bootstrap.virtualConfirm === false);
    root.innerHTML = `${page('审批与确认', '冻结记录 → WS63 确认 → 发送/执行；取消/超时/重放/篡改')}
      ${virtualConfirm ? '' : '<div class="notice block">已启用真实动作，<b>虚拟设备批准入口已关闭</b>。高危确认请用手机确认端（npm run start:lan）；本机演示可设 <span class="mono">SAFE_OFFICE_ALLOW_VIRTUAL_CONFIRM=1</span> 后重启。</div>'}
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
    const editBox = root.querySelector('#op-body-edit');
    if (editBox) {
      const original = editBox.value;
      root.querySelector('#op-body-reset').addEventListener('click', () => { editBox.value = original; });
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

  function renderDeviceResult(res) {
    const map = {
      approved: ['ok', `已批准 → 操作 ${res.operation ? res.operation.state : ''} → 发送 ${res.send ? res.send.state : ''}`],
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
    const authUser = c.store.bootstrap && c.store.bootstrap.authUser;
    const roleName = authUser ? authUser.role : null;
    const canReview = !authUser || ['管理员', '审计员'].includes(roleName);
    const canAdmin = !authUser || roleName === '管理员';
    const canReport = !authUser || ['管理员', '审计员'].includes(roleName);
    const audit = canReport ? await API.get('/api/audit?limit=50').catch(() => null) : null;
    const users = canAdmin ? await API.get('/api/users').catch(() => null) : null;
    const risk = gov.risk;
    const policy = gov.policy || {};
    const roles = Object.keys(policy);
    const actionSet = new Set();
    for (const role of roles) for (const action of Object.keys(policy[role] || {})) actionSet.add(action);
    const actions = [...actionSet];
    root.innerHTML = `${page('治理审计', '风险复核 / 双链校验 / 策略矩阵 / 能力表 / 报告 · 租户=登录用户名（非组织多租户）')}
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
            ${gov.audit.external && gov.audit.external.configured ? `<div class="sub-text mt8">外部存储：${esc(gov.audit.external.dir)} · ${esc(gov.audit.external.snapshots || 0)} 个快照${gov.audit.external.latest ? ` · 最新 ${esc(gov.audit.external.latest.name)}（${esc(gov.audit.external.latest.files)} 个文件）` : ''}${gov.audit.external.lastVerify ? ` · 上次校验 ${gov.audit.external.lastVerify.ok ? '通过' : '失败'}` : ''}<br>清单只证明副本与导出时一致，不抵抗同时改写文件与清单的人；防篡改以本地独立检查点为准。</div>` : ''}
            <div class="sub-text mt8">检查点签名：${gov.audit.signing && gov.audit.signing.alg ? `${esc(gov.audit.signing.alg)}（keyId ${esc(gov.audit.signing.keyId || '-')}）· 公钥可交第三方用 \`npm run verify:audit\` 复核` : '未配置（可设 SAFE_OFFICE_AUDIT_ED25519_PRIVATE_KEY_FILE）'}</div>
            <div class="btn-row">${canAdmin ? '<button class="btn small" id="gov-tamper">篡改链演示</button>' : ''}${canAdmin ? '<button class="btn ghost small" id="gov-rotate">轮转审计</button>' : ''}${canAdmin && gov.audit.external && gov.audit.external.configured ? '<button class="btn ghost small" id="gov-export">导出外部快照</button>' : ''}${canReport && gov.audit.external && gov.audit.external.configured ? '<button class="btn ghost small" id="gov-verify-export">校验外部快照</button>' : ''}${canReport ? '<button class="btn ghost small" id="gov-report">生成治理报告</button>' : ''}${canAdmin ? '<button class="btn ghost small" id="gov-reset">重置演示</button>' : ''}</div>
          </div>
          <div id="gov-tamper-result" class="mt12"></div>
          <div id="gov-export-result" class="mt12"></div>
        </section>
      </div>
      ${users ? `<section class="card"><div class="card-head"><h2>用户管理</h2><span class="sub">${users.items.length} 个</span></div>
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
    root.querySelector('#gov-clear')?.addEventListener('click', () => review('clear'));
    root.querySelector('#gov-escalate')?.addEventListener('click', () => review('escalate'));
    root.querySelector('#gov-tamper')?.addEventListener('click', async () => {
      try {
        const res = await API.post('/api/governance/audit-tamper-demo', {});
        root.querySelector('#gov-tamper-result').innerHTML = `<div class="notice ${res.tampered ? 'info' : 'block'}">原链校验：${res.original ? '通过' : '断裂'}；克隆链篡改后：${res.tampered ? '通过（异常）' : '断裂（预期）'}。<div class="sub-text mt8">${esc(res.note || '')}</div></div>`;
      } catch (err) { toast(c.errorText(err), 'error'); }
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

  window.Views = {
    dashboard, command, minutes, mail, calendar, contacts, files, approvals, device, governance,
  };
})();
