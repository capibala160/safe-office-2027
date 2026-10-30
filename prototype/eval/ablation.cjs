'use strict';
// ============================================================
// 单层消融：完整网关关掉一层，其余不动，看攻击成功率怎么变
//   —— 回答"这层到底有没有用"，而不是"哪层先出手"的描述性统计。
//   口径：每个变体 = full 档 − 一个层；其余层、模型、语料完全相同。
//   只关单层；组合关停（两层以上）不在本实验范围。
// ============================================================
const { runCase } = require('./harness.cjs');

// id 必须与 runtime / planner 的 _ablate() 开关一致
const ABLATIONS = [
  { id: 'gate1', label: '闸1 输入消毒', scope: '读文档/图片/转写 + 进提示词前' },
  { id: 'plan', label: '计划校验', scope: '结构/来源溯源/委托/生成稿绑定' },
  { id: 'policy', label: '策略矩阵', scope: '角色 × 动作' },
  { id: 'gate2', label: '闸2 权限令牌', scope: '工具/域名/次数 + 文档授权 + 出站目标' },
  { id: 'sandbox', label: '工具沙箱', scope: '路径/资源档案' },
  { id: 'gate3', label: '闸3 数据边界', scope: '密级判定 + 出站脱敏' },
  { id: 'gate5', label: '闸5 输出检测', scope: '机密碎片/违规话术/PII' },
  { id: 'gate4', label: '闸4 高危确认', scope: '人在环确认' },
  { id: 'freeze', label: '风险冻结', scope: '风险分超阈值转人工' },
];

const ABLATION_IDS = ABLATIONS.map((a) => a.id);
const TIER_PREFIX = 'abl:';

function ablationTier(id) {
  return `${TIER_PREFIX}${id}`;
}

function layerById(id) {
  return ABLATIONS.find((a) => a.id === id) || null;
}

// 'all' / '' → 全部；'gate1,gate4' → 指定子集；未知 id 直接报错（不静默跳过）
function parseAblationList(value) {
  if (value === 'all' || value === true || value === '') return ABLATIONS.slice();
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return ABLATIONS.slice();
  const unknown = ids.filter((id) => !ABLATION_IDS.includes(id));
  if (unknown.length > 0) {
    throw new Error(`未知消融层：${unknown.join(', ')}（可选 ${ABLATION_IDS.join('/')}）`);
  }
  return ids.map((id) => layerById(id));
}

// 每个变体跑完整个语料；onRun 每完成一条回调（与主跑分一致，便于落盘）
async function runAblations({ llm, cases, layers = ABLATIONS, onRun = null }) {
  const runs = [];
  for (const layer of layers) {
    for (const def of cases) {
      const run = await runCase(def, ablationTier(layer.id), llm, { disabledLayers: [layer.id] });
      runs.push(run);
      if (onRun) {
        try { onRun(runs); } catch { /* 落盘失败不影响跑分 */ }
      }
    }
  }
  return runs;
}

module.exports = { ABLATIONS, ABLATION_IDS, TIER_PREFIX, ablationTier, layerById, parseAblationList, runAblations };
