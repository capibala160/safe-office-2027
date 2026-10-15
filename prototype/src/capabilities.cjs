'use strict';
// ============================================================
// 办公能力分级表 —— 权限治理机制的"表"（命题点名 8 类高风险能力）
//   能力 → 风险级 → 承载工具 → 调用约束
// 风险级（L1 最宽 → L4 最严）：
//   L1 只读低敏：自动放行
//   L2 常规办公：任务令牌内自动；写入/不可逆动作叠加策略与快照
//   L3 敏感：二次确认 + 数据边界（出站/敏感数据）
//   L4 强管控：二次确认 + 星闪近场（物理在场）+ 执行前快照
// 纪律：未在策略矩阵声明的「角色 × 动作」= 默认拒绝（fail-closed）
// ============================================================

const RISK_LEVELS = {
  L1: '只读低敏 · 自动放行',
  L2: '常规办公 · 令牌内自动（写入类叠加策略/快照）',
  L3: '敏感 · 二次确认 + 数据边界',
  L4: '强管控 · 二次确认 + 星闪近场 + 快照',
};

// 命题点名 8 类 + 2 类扩展（命题原文"等"字覆盖）
const CAPABILITIES = [
  {
    name: '邮件发送', level: 'L3', tools: ['sendInternalEmail', 'sendExternalEmail'],
    constraints: '内网=常规；外发=敏感：域名白名单 + 密级/脱敏（闸3）+ 近场确认（闸4）+ 输出检测（闸5）；不得代发他人身份（无委托令牌默认拒绝）',
  },
  {
    name: '文件访问', level: 'L2', tools: ['readDoc', 'deleteDoc'],
    constraints: '读取按密级；删除=不可逆动作：二次确认 + 执行前快照可回滚 + 令牌次数上限（批量封顶）',
  },
  {
    name: '会议预约', level: 'L2', tools: ['scheduleMeeting'],
    constraints: '令牌内自动；预约外部参会人升级确认（规划中）',
  },
  {
    name: '通讯录读取', level: 'L3', tools: ['readContact'],
    constraints: '仅支持单条按名查询；查询结果默认脱敏（最小暴露）；批量/导出能力不提供——工具目录外的动作一律移除',
  },
  {
    name: '打印控制', level: 'L2', tools: ['printDoc'],
    constraints: '公开=放行；内部=二次确认 + 输出水印与操作人标识；机密=禁止打印',
  },
  {
    name: '录音转写', level: 'L2', tools: ['transcribeAudio'],
    constraints: '转写结果=外部内容：强制过闸1（注入隔离）再入知识库',
  },
  {
    name: '屏幕共享', level: 'L3', tools: ['shareScreen'],
    constraints: '二次确认；知识库存在机密材料时禁止共享（防连带泄露）',
  },
  {
    name: '设备联动', level: 'L4', tools: ['deviceControl'],
    constraints: '物理世界动作：二次确认 + 星闪近场 + 执行前快照',
  },
  {
    name: '外部上传/云同步（扩展）', level: 'L3', tools: ['uploadToCloud'],
    constraints: '默认拒绝（员工无权限）；仅公开级材料允许上传，出站脱敏',
  },
  {
    name: '内容生成/摘要（扩展）', level: 'L1', tools: ['summarize'],
    constraints: '生成物过闸5（不合规话术拦截）；含机密原文片段的生成物在出站前比对拦截',
  },
  {
    name: '图片识别（扩展）', level: 'L1', tools: ['recognizeImage'],
    constraints: '识别结果=外部内容：OCR 文本强制过闸1（图内注入同权隔离）再入知识库；截图密级随源，涉密截图的出站/共享走闸3与专项约束',
  },
];

// 工具元数据：单一事实源——规划器工具目录 / 必需参数 / 分级全部由此派生
const TOOL_META = {
  readDoc:           { capability: '文件访问', level: 'L1', requiredArgs: ['id'] },
  summarize:         { capability: '内容生成/摘要（扩展）', level: 'L1', requiredArgs: ['of'] },
  sendInternalEmail: { capability: '邮件发送', level: 'L2', requiredArgs: ['to', 'docId'], outbound: true },
  sendExternalEmail: { capability: '邮件发送', level: 'L3', requiredArgs: ['to', 'docId'], outbound: true },
  deleteDoc:         { capability: '文件访问', level: 'L2', requiredArgs: ['id'], irreversible: true },
  scheduleMeeting:   { capability: '会议预约', level: 'L2', requiredArgs: ['title', 'at'] },
  readContact:       { capability: '通讯录读取', level: 'L3', requiredArgs: ['name'] },
  printDoc:          { capability: '打印控制', level: 'L2', requiredArgs: ['id'] },
  transcribeAudio:   { capability: '录音转写', level: 'L2', requiredArgs: ['id'] },
  recognizeImage:    { capability: '图片识别（扩展）', level: 'L1', requiredArgs: ['id'] },
  shareScreen:       { capability: '屏幕共享', level: 'L3', requiredArgs: ['id'] },
  deviceControl:     { capability: '设备联动', level: 'L4', requiredArgs: ['device', 'op'] },
  uploadToCloud:     { capability: '外部上传/云同步（扩展）', level: 'L3', requiredArgs: ['docId', 'url'], outbound: true },
};

function capabilityOf(tool) {
  return TOOL_META[tool] ? TOOL_META[tool].capability : '(未登记)';
}

module.exports = { RISK_LEVELS, CAPABILITIES, TOOL_META, capabilityOf };
