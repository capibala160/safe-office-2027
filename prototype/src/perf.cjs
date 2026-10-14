'use strict';
// ============================================================
// 时延度量 —— 回答答题要求 #2「响应时延 / 资源占用」
//   对每道闸的每次过闸打点：次数 / 合计 / 均值 / 峰值（毫秒）
//   零依赖、无网络：开销即纯计算开销（上板后可换 ArkTS 计时 API 平移）
// ============================================================
const { performance } = require('node:perf_hooks');

class PerfMeter {
  constructor() {
    this.spans = new Map();
  }

  _record(label, ms) {
    const s = this.spans.get(label) || { label, count: 0, totalMs: 0, maxMs: 0 };
    s.count += 1;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    this.spans.set(label, s);
  }

  measure(label, fn) {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this._record(label, performance.now() - t0);
    }
  }

  async measureAsync(label, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this._record(label, performance.now() - t0);
    }
  }

  report() {
    return [...this.spans.values()].map((s) => ({
      ...s,
      avgMs: s.count > 0 ? s.totalMs / s.count : 0,
    }));
  }

  totalMs() {
    let t = 0;
    for (const s of this.spans.values()) t += s.totalMs;
    return t;
  }
}

module.exports = { PerfMeter };
