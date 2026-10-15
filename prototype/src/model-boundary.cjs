'use strict';
const { sanitizeInput, redact } = require('./guard.cjs');

// local 必须由受信任的适配器声明；调用参数只能收紧，不能放宽。
function prepareModelInput(llm, command, docs, { modelLocation, commandLevel = '内部' } = {}) {
  const location = llm.deployment === 'local' && modelLocation !== 'cloud' ? 'local' : 'cloud';
  if (location === 'cloud') {
    if (!['公开', '内部'].includes(commandLevel)) throw new Error('模型边界拒绝：机密或未知密级指令不能送云');
    const fragments = docs.filter(d => d.level === '机密').flatMap(d =>
      String(d.body).split(/[。！？；\n]/).map(s => s.trim()).filter(s => s.length >= 10));
    if (fragments.some(f => command.includes(f))) throw new Error('模型边界拒绝：用户指令包含已知机密片段');
    command = redact(command);
  }
  const blocks = docs.map(d => {
    const withheld = location === 'cloud' && !['公开', '内部'].includes(d.level);
    return { id: d.id, level: d.level, withheld, sanitized: sanitizeInput(d.body).safe,
      text: withheld ? '【正文已分流，不送云】' : (location === 'cloud' ? redact(sanitizeInput(d.body).cleaned) : sanitizeInput(d.body).cleaned) };
  });
  return { command, blocks, location };
}
module.exports = { prepareModelInput };
