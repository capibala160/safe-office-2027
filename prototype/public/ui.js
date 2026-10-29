'use strict';
// 前端工具：转义、格式化、徽章、toast
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c]);
  }
  function short(value, n = 12) {
    const s = String(value === undefined || value === null ? '' : value);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function time(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function dateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function badge(status) {
    const text = status === undefined || status === null ? '—' : String(status);
    return `<span class="badge ${esc(text)}">${esc(statusText[text] || text)}</span>`;
  }
  function gate(status) {
    return `<span class="gate-chip ${esc(status)}">${esc(statusText[status] || status)}</span>`;
  }
  const statusText = {
    pass: '通过', block: '拦截', warn: '警告', defer: '转交', na: '未触及',
    allow: '放行', confirm: '需确认', deny: '拒绝',
    frozen: '待确认', confirmed: '已确认', executing: '执行中', executed: '已执行',
    rejected: '已拒绝', expired: '已过期', failed: '失败',
    pending: '待发送', sending: '发送中', sent: '已发送', unknown: '待核实',
    approved: '已批准', cancelled: '已取消', tampered: '篡改', timeout: '超时',
  };
  const kindClass = (kind, detail) => {
    if (/拒绝|拦截|失败|冻结/.test(kind)) return 'block';
    if (/脱敏|警告|校正|超时|未知/.test(kind)) return 'warn';
    if (/确认|执行|发送|冻结|复核|生成|读入|转写|识别|快照/.test(kind)) return 'ok';
    return 'info';
  };
  function summarize(detail) {
    if (!detail || typeof detail !== 'object') return String(detail || '');
    const parts = [];
    const keys = ['reason', 'method', 'action', 'outcome', 'message', 'state', 'score', 'command', 'docTitle', 'recipient', 'n'];
    for (const k of keys) {
      if (detail[k] !== undefined && detail[k] !== null && detail[k] !== '') {
        parts.push(`${k}=${typeof detail[k] === 'object' ? JSON.stringify(detail[k]) : detail[k]}`);
      }
    }
    if (Array.isArray(detail.reasons)) parts.push('reasons=' + detail.reasons.join('、'));
    return parts.length ? parts.join(' · ') : short(JSON.stringify(detail), 120);
  }
  let toastTimer = null;
  function toast(message, kind = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
  }
  function errorText(err) {
    if (!err) return '未知错误';
    return err.code ? `${err.message}（${err.code}）` : err.message;
  }

  // 行级 diff（LCS）：草稿版本对比用，够看增量即可，不做词级
  function diffLines(before, after) {
    const a = String(before || '').split('\n');
    const b = String(after || '').split('\n');
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i += 1; }
      else { out.push({ type: 'add', text: b[j] }); j += 1; }
    }
    while (i < a.length) { out.push({ type: 'del', text: a[i] }); i += 1; }
    while (j < b.length) { out.push({ type: 'add', text: b[j] }); j += 1; }
    return out;
  }

  function renderDiff(before, after) {
    const rows = diffLines(before, after);
    const changed = rows.filter((r) => r.type !== 'same').length;
    if (changed === 0) return '<div class="sub-text">与当前版本一致</div>';
    return `<pre class="diff">${rows.map((r) => {
      const mark = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
      const cls = r.type === 'add' ? 'add' : r.type === 'del' ? 'del' : '';
      return `<span class="diff-line ${cls}">${esc(mark + ' ' + r.text)}</span>`;
    }).join('\n')}</pre>`;
  }

  window.UI = {
    esc, short, time, dateTime, badge, gate, kindClass, summarize, toast, errorText,
    diffLines, renderDiff,
    statusText,
  };
})();
